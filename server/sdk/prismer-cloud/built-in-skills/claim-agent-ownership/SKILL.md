---
name: claim-agent-ownership
description: |
  Orchestrator skill for resolving multi-daemon binding contention. Use when you (the
  orchestrator) detect an `agent.binding.contested` sync event indicating two daemons
  are racing for the same agent — explicitly rebind ownership to a chosen target daemon
  so subsequent dispatches route deterministically. Implements Gap G-2-⑤ on top of the
  Wave 2-B2 `/api/im/agent-bindings/:agentImUserId/rebind` endpoint.
applies_to: [hermes, claude-code, openclaw, codex]
requires:
  - aip-identity
phaseModel:
  defaultPhase: tool_use
version: 1
---

# Claim Agent Ownership

When two daemons (typically Mac Studio at home + a k8s pod) both run `agent.host.declare`
for the same agent, the first one wins ownership and the second registers a
**contested** binding. The user UI surfaces a "binding contested" badge and the cloud's
`resolveAgentDaemonRoute` keeps routing dispatches to the original owner — but a
human-driven or orchestrator-driven decision is needed to converge.

This skill is the **orchestrator's tool for that decision**. It calls the server's
authoritative rebind endpoint, which atomically:

1. flips `im_agent_bindings.boundDaemonId` to the chosen target daemon
2. writes an audit row with `boundBy='user-explicit'` (or `'orchestrator'`)
3. returns the **in-flight task count** on the previous owner so the orchestrator can
   wait / drain before redirecting traffic
4. emits a sync event (`agent.binding.rebound`) so other daemons drop their hosting
   state for the agent

## When to use

- A sync event with type `agent.binding.contested` arrives in your inbox.
- A user explicitly asks "the agent is bouncing between machines — pin it to my laptop".
- You (orchestrator) decide to migrate an agent off a misbehaving daemon (high error
  rate, stale heartbeats, etc.) and a target is available.
- Devices panel shows >1 daemon claiming the same agent and the user requests
  arbitration.

**Do not** use it for:

- Healthy single-daemon bindings (no contention — nothing to claim).
- Agents the orchestrator does not own / has no permission for (server rejects 403).
- Routing decisions that should be reversible at the chat-message level (use
  `metadata.daemonId` overrides in single dispatches instead).

## API

There is **no generic `cloud im get` / `cloud im post`** subcommand in the
runtime CLI today (release 201 audit, `sdk/prismer-cloud/runtime/src/cli/`).
A dedicated `cloud agent rebind` verb is not landed either. The skill calls
the cloud HTTP endpoint directly via `curl` (or the equivalent fetch from the
orchestrator's MCP runtime), authenticating with the daemon API key already
present in the environment as `$PRISMER_API_KEY`:

```bash
# Inspect the current bindings first.
curl -fsS \
  -H "Authorization: Bearer $PRISMER_API_KEY" \
  "$PRISMER_CLOUD_BASE/api/im/workspaces/<workspaceId>/agent-bindings"

# Issue the rebind. Requires workspace owner / active orchestrator / admin.
curl -fsS \
  -X POST \
  -H "Authorization: Bearer $PRISMER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"targetDaemonId":"<daemonId>","targetDaemonKind":"local","reason":"<short reason>"}' \
  "$PRISMER_CLOUD_BASE/api/im/agent-bindings/<agentImUserId>/rebind"
```

`PRISMER_CLOUD_BASE` defaults to the cloud the daemon paired with
(`https://prismer.cloud` in prod, `http://127.0.0.1:3000` in local dev).

For pure-API use (orchestrator runtime, MCP tool, etc.), the underlying call is:

```http
POST /api/im/agent-bindings/:agentImUserId/rebind
Authorization: Bearer <daemon api key>
Content-Type: application/json

{
  "targetDaemonId":   "daemon-mac-studio-01",   // required, must exist in workspace
  "targetDaemonKind": "local",                  // optional: 'k8s' | 'local' | 'edge'
  "targetDaemonLabel": "Mac Studio (home)",     // optional display label
  "reason":           "user prefers desktop daemon while on home network"
}
```

Successful response:

```json
{
  "ok": true,
  "data": {
    "binding": {
      "agentImUserId":     "u_agent_ceo",
      "boundDaemonId":     "daemon-mac-studio-01",
      "boundDaemonKind":   "local",
      "boundDaemonLabel":  "Mac Studio (home)",
      "boundBy":           "user-explicit",
      "boundAt":           "2026-05-22T16:30:00.000Z"
    },
    "inFlightTaskCount":   3,
    "previousDaemonId":    "daemon-k8s-pod-7f4"
  }
}
```

Failure modes worth handling explicitly:

| Status                | Code (in body)                  | Meaning                                                              |
| --------------------- | ------------------------------- | -------------------------------------------------------------------- |
| `400`                 | `target daemon ... not registered` | Target daemonId not in `im_containers` for this workspace.        |
| `400` / missing field | `targetDaemonId is required`    | Body parse / missing required field — surface as developer error. |
| `403`                 | `Forbidden`                     | Caller is not workspace owner / orchestrator / admin.             |
| `404`                 | `Agent not found ...`           | Agent has no `im_agent_cards` row (deleted? wrong id?).           |
| `404`                 | `No binding row exists ...`     | Agent never ran host.declare. Tell the daemon to declare first.   |
| `409`                 | `target daemon ... is stopped`  | Target container has `stoppedAt` set — pick a different target.   |

## Workflow

1. **Subscribe to `agent.binding.contested` sync events.** The orchestrator's sync inbox
   delivers these out of band; the skill consumes them.
2. **Resolve the target daemon.** Read the binding list and pick the daemon you want to
   keep — usually the one with:
   - smaller `lastDispatchAt` skew (fresher),
   - matching device kind to user preference (local vs k8s),
   - lower `contestCount` (less flapping).
3. **Decide whether to drain.** If `inFlightTaskCount > 0` on the previous owner,
   surface this to the user ("3 tasks finishing on the old daemon before switching").
   The orchestrator should usually let those finish — the rebind takes effect for
   subsequent dispatches, in-flight tasks complete via the existing route.
4. **Call rebind.** Pass `targetDaemonId` + `reason`. Optional kind/label improve UI
   readability.
5. **Verify.** Read `/workspaces/:wsId/agent-bindings` again and confirm `boundDaemonId`
   matches your target. If still divergent, the daemon may have re-declared between
   read and write — repeat once.

## Operating Rules

- **Never rebind to a daemon you cannot see in the workspace listing.** The server
  validates via `im_containers` — calling with a fictional id returns 400. Don't guess.
- **Always supply a reason.** It's persisted in the audit trail and surfaces in the
  Devices panel ("rebound by orchestrator at HH:MM: <reason>"). Empty reason becomes
  the default `'unspecified'` which is opaque to the user.
- **One rebind per binding per minute (orchestrator self-limit).** The endpoint is
  not throttled, but flapping rebinds spam sync events and confuse the user. If the
  contest re-fires within 60s of a rebind, escalate to the human — don't auto-rebind
  again.
- **Wait for the dispatch in-flight count to drain before declaring "done"** if the
  user is observing. The cloud routes new dispatches immediately, but the prior
  daemon's outstanding tasks still finish on it.

## Output reporting

After successfully calling rebind:

```
[claim-agent-ownership] rebound agent=<agentImUserId> from=<previousDaemonId>
                       to=<targetDaemonId> in-flight-on-previous=<n>
                       reason="<reason>"
```

Then surface to the user as a chat message: who you rebound, where to, why, and how
many tasks are still finishing on the old daemon (if any).

After a 4xx/5xx failure: report the HTTP status + the server's error code + message
verbatim. Do not silently retry on 400/403/404 — those need human attention.

## Backing capabilities

- **Server endpoint:** `POST /api/im/agent-bindings/:agentImUserId/rebind`
  (Wave 2-B2, `src/im/api/agent-bindings.ts`)
- **Data model:** `IMAgentBinding` (migration 410, fields:
  `boundDaemonId`, `boundDaemonKind`, `boundDaemonLabel`, `boundBy`, `contestCount`,
  `contestedSince`)
- **Sync event consumed:** `agent.binding.contested` — emitted by `AgentBindingService`
  when a second daemon declares an agent already bound to a different daemon.
- **Sync event emitted (server-side):** `agent.binding.rebound` — broadcast after
  successful rebind so all daemons + UI consumers drop stale routing state.
- **Audit trail:** Each rebind writes an `IMTaskLog`-style entry with
  `boundBy='user-explicit'` / `'orchestrator'` and the supplied reason; visible in the
  Devices panel.

## Examples

### Example 1 — Orchestrator handling a contest event

```
Inbox event: { type: 'agent.binding.contested', agentImUserId: 'u_agent_ceo',
               existingDaemonId: 'daemon-k8s-pod-7f4',
               contendingDaemonId: 'daemon-mac-studio-01' }

Orchestrator inspects bindings:
  curl -H "Authorization: Bearer $PRISMER_API_KEY" \
    "$PRISMER_CLOUD_BASE/api/im/workspaces/ws_abc/agent-bindings"

Decision: user is on home network, prefer Mac Studio (local).

Action:
  curl -X POST -H "Authorization: Bearer $PRISMER_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"targetDaemonId":"daemon-mac-studio-01","targetDaemonKind":"local",
         "reason":"user on home network, preferring local daemon"}' \
    "$PRISMER_CLOUD_BASE/api/im/agent-bindings/u_agent_ceo/rebind"

Response: boundDaemonId='daemon-mac-studio-01', inFlightTaskCount=2
Orchestrator messages user: "Pinned CEO agent to your Mac Studio. 2 tasks finishing on
                            the cloud pod first."
```

### Example 2 — User explicit "pin agent X to laptop"

```
User: "Make sure DesignAgent always runs on my laptop, not the k8s pod."

Orchestrator (after reading bindings):
  curl -X POST -H "Authorization: Bearer $PRISMER_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"targetDaemonId":"daemon-laptop-9a","targetDaemonKind":"local",
         "reason":"user-explicit: pin to laptop"}' \
    "$PRISMER_CLOUD_BASE/api/im/agent-bindings/u_design_agent/rebind"
```

### Example 3 — Failure to handle gracefully

```
Orchestrator tries to rebind to a daemon that just went offline:
  POST .../rebind { targetDaemonId: "daemon-k8s-pod-7f4", ... }
  ← 409 { error: "target daemon daemon-k8s-pod-7f4 is stopped" }

Orchestrator should:
  1. Re-read /workspaces/<wsId>/agent-bindings to find a live alternative.
  2. If only one daemon remains and it's already the current owner, do nothing.
  3. Otherwise retry with the live candidate.
```

## Anti-patterns

- ❌ Calling rebind on every contested event without thinking — flap creates user
  confusion. Wait until the user signals preference or a clear health signal arrives.
- ❌ Supplying `targetDaemonKind` / `targetDaemonLabel` that contradict the server's
  inference (e.g. claiming `kind=k8s` for a `deviceType=local` container). The server
  trusts the body so misuse leads to a wrong-shaped UI badge.
- ❌ Treating `inFlightTaskCount > 0` as a hard error — it's informational. The cloud
  has already redirected new dispatches; existing in-flight work simply finishes on
  the old route.
- ❌ Re-binding while another orchestrator is also working on the same workspace
  without coordination. Use the workspace's orchestrator lease (`orchestratorAgentId`)
  to make sure you're the active arbiter before mutating bindings.
