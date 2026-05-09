# Phase A Local Runbook

This runbook starts the current Go-only Phase A baseline with a real WebSocket handler and a real SQLite-backed orchestrator store.

## Prerequisites

- Go toolchain installed
- CGO available for `github.com/mattn/go-sqlite3`
- Cached modules already present locally, or network access enabled for `go run`

## Non-Sandbox Smoke Run

Run the end-to-end local smoke flow from normal local terminals, not from the Codex sandbox. The smoke flow opens a listening HTTP/WebSocket port and needs unrestricted localhost networking.

Terminal 1:

```bash
PRISMER_HTTP_ADDR=:8080 bash scripts/phase_a/run_orchestrator.sh
```

Terminal 2:

```bash
bash scripts/phase_a/run_daemon.sh
```

Terminal 3:

```bash
bash scripts/phase_a/demo_approval_flow.sh
bash scripts/phase_a/demo_approval_reject_flow.sh
```

Expected result:

- `/healthz` responds on `http://127.0.0.1:8080/healthz`
- the daemon connects over `/ws/runtime`
- the approved demo task reaches `completed`
- the rejected demo task reaches `failed`

## Start The Orchestrator

```bash
bash scripts/phase_a/run_orchestrator.sh
```

Default behavior:

- listens on `:8080`
- serves `/healthz`
- upgrades `/ws/runtime`
- uses `sqlite3` with `file:/tmp/prismer-orchestrator.db?_foreign_keys=on`
- auto-applies the embedded Phase A schema

Common overrides:

```bash
PRISMER_HTTP_ADDR=:9090 \
PRISMER_DB_DSN='file:/tmp/prismer-dev.db?_foreign_keys=on' \
bash scripts/phase_a/run_orchestrator.sh
```

Optional admission controls:

```bash
PRISMER_RUNTIME_JOIN_TOKEN=join-secret \
PRISMER_RUNTIME_ALLOWED_DIDS='did:key:local-dev-daemon,did:key:worker-2' \
bash scripts/phase_a/run_orchestrator.sh
```

Optional signed `runtime.hello` admission:

```bash
PRISMER_RUNTIME_SIGNATURE_REQUIRED=true \
PRISMER_RUNTIME_MAX_SKEW_MS=300000 \
bash scripts/phase_a/run_orchestrator.sh
```

## Signed Daemon Setup Path

The W2/W3 setup path now has a server/API/CLI handoff:

```bash
prismer setup --with-daemon
```

That flow:

- gets or verifies the user's API key
- derives a deterministic AIP DID from the API key
- registers the runtime public key through `POST /api/runtimes/signing-keys`
- writes daemon launch values under `[daemon]` in `~/.prismer/config.toml`

The Go daemon reads those `[daemon]` values when explicit env vars are absent:

```toml
[daemon]
runtime_did = "did:key:..."
key_id = "did:key:...#k1"
signing_private_key = "..."
orchestrator_ws_url = "wss://prismer.cloud/ws/runtime"
```

Environment variables still take priority for local smoke runs and CI overrides:

```bash
PRISMER_DAEMON_DID=did:key:local-dev-daemon \
PRISMER_DAEMON_KEY_ID=did:key:local-dev-daemon#k1 \
PRISMER_DAEMON_SIGNING_PRIVATE_KEY='<base64url-ed25519-private-key>' \
PRISMER_ORCH_WS_URL=ws://127.0.0.1:8080/ws/runtime \
bash scripts/phase_a/run_daemon.sh
```

Runtime signing keys can be rotated or revoked through the Phase A API:

```bash
curl -X POST https://prismer.cloud/api/runtimes/signing-keys/rotate \
  -H "Authorization: Bearer $PRISMER_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"did":"did:key:...","previous_key_id":"did:key:...#k1","public_key":"<base64url-ed25519-public-key>"}'

curl -X DELETE https://prismer.cloud/api/runtimes/signing-keys/<id-or-key-id> \
  -H "Authorization: Bearer $PRISMER_API_KEY"
```

Task mutation APIs accept `X-Idempotency-Key` for retry-safe client replays:

```bash
curl -X POST https://prismer.cloud/api/im/tasks \
  -H "Authorization: Bearer $PRISMER_API_KEY" \
  -H "X-Idempotency-Key: task-create-$(date +%s)" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Retry-safe task","capability":"noop"}'
```

Task responses include `stateVersion` and mutation responses also return
`ETag` / `X-State-Version`. Clients can send that value back to reject stale
writes instead of overwriting newer task state:

```bash
STATE_VERSION="$(curl -s https://prismer.cloud/api/im/tasks/<task-id> \
  -H "Authorization: Bearer $PRISMER_API_KEY" | jq -r '.data.task.stateVersion')"

curl -X POST https://prismer.cloud/api/im/tasks/<task-id>/complete \
  -H "Authorization: Bearer $PRISMER_API_KEY" \
  -H "If-Match: \"$STATE_VERSION\"" \
  -H "X-Idempotency-Key: task-complete-<task-id>-1" \
  -H 'Content-Type: application/json' \
  -d '{"result":{"ok":true}}'
```

## Start A Local Daemon

In a second terminal:

```bash
bash scripts/phase_a/run_daemon.sh
```

Default behavior:

- connects to `ws://127.0.0.1:8080/ws/runtime`
- identifies as `did:key:local-dev-daemon`
- reports one capability: `noop@local=/usr/bin/env`
- sends heartbeats every 5 seconds
- runs the built-in noop executor

Common overrides:

```bash
PRISMER_ORCH_WS_URL=ws://127.0.0.1:9090/ws/runtime \
PRISMER_DAEMON_DID=did:key:worker-2 \
PRISMER_DAEMON_AGENT_JOIN_TOKEN=join-secret \
PRISMER_DAEMON_CAPABILITIES='codex@0.1.0=/usr/local/bin/codex,claude-code@1.0.0=/usr/local/bin/claude' \
bash scripts/phase_a/run_daemon.sh
```

Optional daemon signing:

```bash
PRISMER_DAEMON_KEY_ID='did:key:local-dev-daemon#k1' \
PRISMER_DAEMON_SIGNING_PRIVATE_KEY='<base64url-ed25519-private-key>' \
bash scripts/phase_a/run_daemon.sh
```

Optional daemon approval policy:

```bash
PRISMER_DAEMON_APPROVAL_ENFORCE=true \
PRISMER_DAEMON_APPROVAL_DANGEROUS_ACTIONS='git_push_force,rm_rf,terraform_apply' \
PRISMER_DAEMON_APPROVAL_BUDGET_THRESHOLD=1000 \
bash scripts/phase_a/run_daemon.sh
```

Current built-in policy rules:

- `dangerous_action`: if task input contains `{"action":"git_push_force"}` or another configured dangerous action
- `task_create`: if task input contains `{"budget":1500}` and crosses the configured threshold

## Quick Checks

Health endpoint:

```bash
curl -fsS http://127.0.0.1:8080/healthz
```

Register a debug signing key:

```bash
curl -X POST http://127.0.0.1:8080/debug/signing-keys \
  -H 'Content-Type: application/json' \
  -d '{"did":"did:key:local-dev-daemon","public_key":"<base64url-ed25519-public-key>","key_id":"did:key:local-dev-daemon#k1"}'
```

Contract guard:

```bash
bash scripts/phase_a/schema_contract_guard.sh
```

Service tests:

```bash
cd services
GOCACHE=/tmp/gocache go test ./...
```

## Approval Demo

The built-in daemon `noop` executor now supports an execution-time approval pause. If task input contains an `approval` block, the daemon will:

- send `approval.request`
- wait for `approval.decision`
- continue on `approved`
- reject the task on `rejected`

Fast path:

```bash
bash scripts/phase_a/demo_approval_flow.sh
```

Reject path:

```bash
bash scripts/phase_a/demo_approval_reject_flow.sh
```

This script will:

- create a debug `noop` task with an approval request in `input`
- poll `GET /debug/tasks/<task_id>` until `pending_approval_id` appears
- call `POST /debug/approvals/decide`
- wait for the task to reach the expected terminal state

Manual path:

```bash
curl -X POST http://127.0.0.1:8080/debug/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "title":"Approval Demo",
    "capability":"noop",
    "input":{
      "approval":{
        "kind":"dangerous_action",
        "action":"git_push_force",
        "payload":{"branch":"main"}
      }
    },
    "auto_dispatch":true
  }'
```

Then poll the task until `pending_approval_id` is set:

```bash
curl -fsS http://127.0.0.1:8080/debug/tasks/<task_id>
```

Approve it:

```bash
curl -X POST http://127.0.0.1:8080/debug/approvals/decide \
  -H 'Content-Type: application/json' \
  -d '{
    "approval_id":"<pending_approval_id>",
    "status":"approved",
    "decision_reason":"local demo"
  }'
```

Reject it:

```bash
curl -X POST http://127.0.0.1:8080/debug/approvals/decide \
  -H 'Content-Type: application/json' \
  -d '{
    "approval_id":"<pending_approval_id>",
    "status":"rejected",
    "decision_reason":"local demo reject"
  }'
```

Policy-driven path:

When daemon approval policy is enabled, task input can omit the explicit `approval` block. For example, this will trigger a `dangerous_action` approval automatically:

```bash
curl -X POST http://127.0.0.1:8080/debug/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "title":"Policy Demo",
    "capability":"noop",
    "input":{
      "action":"git_push_force",
      "branch":"main"
    },
    "auto_dispatch":true
  }'
```

This will trigger a `task_create` approval automatically:

```bash
curl -X POST http://127.0.0.1:8080/debug/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "title":"Budget Demo",
    "capability":"noop",
    "input":{
      "budget":1500
    },
    "auto_dispatch":true
  }'
```

## Current Scope

This local runbook is enough to validate:

- real HTTP + WebSocket upgrade path
- daemon `runtime.hello` / capability report / heartbeat
- optional join-token + DID allowlist admission on `runtime.hello`
- optional `IMSigningKey`-backed `runtime.hello` signature verification
- daemon-side automatic reconnect and `stream.resume_request` re-sync for tracked executions
- daemon-side execution-time `approval.request` / `approval.decision`
- daemon-side optional approval policy for `dangerous_action` and high `budget` tasks
- SQLite-backed runtime and session persistence
- daemon-side noop task runner wiring

It does not yet cover:

- persisted `stream.resume_request` replay state
- a real external task source feeding `task.push`
- key registration / rotation workflow for `IMSigningKey`
