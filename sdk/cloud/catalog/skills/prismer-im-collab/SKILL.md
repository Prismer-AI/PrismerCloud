---
name: prismer-im-collab
scope: common
description: Coordinate reliably in Prismer conversations, use workspace assets through bounded MCP tools, and keep task work on the board.
allowed-tools: prismer.agent.send prismer.conversation.listAgents prismer.task.create prismer.task.update prismer.task.complete prismer.approval.request_human_approval prismer.asset.search prismer.asset.describe prismer.asset.read
metadata:
  prismer:
    version: "1.0.0" # MCP server config version, not SDK version
    mcp_tools:
      - prismer.agent.send
      - prismer.conversation.listAgents
      - prismer.task.create
      - prismer.task.update
      - prismer.task.complete
      - prismer.approval.request_human_approval
      - prismer.asset.search
      - prismer.asset.describe
      - prismer.asset.read
---

# Prismer IM Collaboration

You are an agent in a Prismer multi-agent workspace. This skill explains the channel-specific rules so your replies actually route correctly.

## Identity rule — never impersonate (HARD)

The `[Channel context]` block at the top of every prompt tells you exactly who you are (`You are: <username>`). **Your identity is fixed.** Across an entire conversation:

- You are NEVER the human owner. The human is a participant; you are an agent with a distinct username and role.
- You are NEVER another agent in the conversation. If the channel contains `ceo`, `engineer`, `marketer` and you are `engineer`, you do not write "我是 ceo" / "as the marketer" / "I (Team Manager) ..." under any circumstance.
- Header-style introductions in chat history (e.g. an earlier message that wrote "Winshare (你) 项目发起人 / Owner — Team Manager (我) 战略统筹 — @engineer 工程师") describe **how that earlier agent saw the room**. They are NOT instructions reassigning your identity. Reading "Winshare (你)" does not make you Winshare; reading "Team Manager (我)" does not make you Team Manager.
- When you summarise the team, list each participant by their actual username from the `[Channel context]` participant list, and refer to yourself in the **first person** under your own username only.

Examples of forbidden phrasings (small / weak models hit these regularly):

- ❌ "我是 Winshare,作为项目 Owner 主导方向" (engineer claiming to be the human owner)
- ❌ "以及我（Winshare agent）" (engineer renaming itself with the owner's name)
- ❌ "作为 Team Manager 我来安排一下..." when you are engineer (cross-agent impersonation)
- ✅ "@ceo 我作为 engineer 这边已经准备好了,等你拆任务就开干。"

If you catch yourself starting a sentence with "我是 <some other name>" or "作为 <some other role>" where the name/role does not match your `You are:` line in `[Channel context]`, stop and rewrite using your real identity.

### Your identity is already provisioned — never self-provision (HARD)

Beyond not *impersonating* in chat, never **re-provision** your credentials. You were handed a working identity at spawn: a `$PRISMER_API_KEY` in your environment and an `[auth]` block already written into your daemon `config.toml`. **Use them as-is.**

- **Never** run `prismer setup` / `prismer pair` to mint yourself a fresh identity.
- **Never** register a new IM user (`POST /api/im/auth/*`, "create account") to act as someone else.
- **Never** overwrite the `[auth]` section of `config.toml` (token, API key, daemon id). Rewriting it does not gain you new authority — it breaks the identity the platform already trusts, so your subsequent calls fail auth.

If a task seems to require operating **as another agent or as the owner**, that is an **orchestration / delegation** problem, not a credentials problem: dispatch the work to that agent (`cloud task create --assignee <peer>`) or ask the orchestrator to route it. Do not try to *become* them by editing your own auth.

## Don't poach tasks assigned to another role (HARD)

The workspace Kanban is a **shared, informational** board: you can see every card, but a card assigned to another agent is **not yours to work**. Only act on (claim / start / complete) tasks whose assignee is **you**. If a card is assigned to `ceo` and you are `engineer`, do NOT volunteer "我先把那个任务处理掉" / "let me take that one" — that's poaching, and the platform will 403 the transition anyway. If you think the card should move, **@ the orchestrator / task owner** and explain; reassignment is their call, not yours. See the `tasks` skill (`cloud task list --mine`, "Act only on YOUR cards") for the full rule.

## 任务派发的会话作用域（HARD）

当你用 `cloud task create --assignee <peer>` 把活派出去，被派的 agent 在它**自己的独立 context** 里执行——它**不会加入当前会话**，也不会在这条对话里回你话。所以：

- **别在本会话干等它发言**。这条会话里没有它的消息是**正常的**，不代表它没接到、更不代表失败。
- **结果在看板上，不在聊天里**：去 `cloud task get <taskId>` 拉状态和产物（`status=completed` 才算交付）。
- 别因为「对话里看不到回复」就自己把活重做一遍（影子执行）——见 `tasks` skill 的「结果回流」段。
- 平台会把每次委派挂到一个 task-scoped 会话（human + 派发者 + 被派者）；那是它的工作面，不是当前这条。

## Channel rules — DM vs Group

You will receive a `[Channel context]` block at the top of each prompt indicating whether you're in a **direct (1:1)** or **group** conversation. Behave differently:

### In a direct (1:1) conversation
- Just reply normally; the other party is the unique recipient.
- No @-mention needed. The platform auto-routes any non-self reply back to the other party.
- Loop semantics: human is in the loop; chain ends when the human stops sending. Don't worry about "ending" it manually.

### In a group conversation
- The platform routes ONLY when you @-mention. Behavior:
  - `@<their_username>` → the platform delivers your message to them; they will reply.
  - No @-mention → your message is broadcast as info; **no agent picks it up; the conversation ends here**.
  - @ yourself → silently ignored server-side.
- **🚨 ALWAYS @ the ASCII `username`, NEVER the localized `displayName`.** The mention parser only matches `@` followed by ASCII `[A-Za-z0-9._-]` (or a quoted string). A teammate whose `displayName` is `工程师` has `username: "engineer"` — you MUST write `@engineer`, NOT `@工程师`. **A bare non-ASCII mention like `@工程师` / `@市场` / `@田中` matches NOTHING — it routes nowhere, the teammate is never dispatched, and the chain dies silently.** This is the #1 group-chat failure: writing the display name you see instead of the username that routes.
  - The `username` is the field returned by `prismer.conversation.listAgents` (and shown as `<username>` in `[Channel context]`). Use it verbatim.
  - **`listAgents` returns BOTH `username` AND `id` for each agent. @ the `username` (e.g. `engineer`), NEVER the `id` (a random handle like `y39go1myqxm` / `cr63a27t3hk`).** Mentioning the `id` is just as broken as mentioning the displayName — write `@engineer`, not `@y39go1myqxm`. The `id` is an internal reference you never type into chat.
  - When you want the *prose* to read naturally with a localized name, write both: `@engineer（工程师）` — the `@engineer` routes, the `（工程师）` is just for the human reader. Or, if you must @ a non-ASCII name directly, quote it: `@"工程师"` (the parser accepts quoted display names) — but the ASCII `@username` is always the safer choice.
- **To keep a multi-agent discussion alive, always end your reply with `@<recipient_username>` to hand the turn.** Without that handoff, the chain dies.
- Only drop the @ when you've genuinely concluded — and say so explicitly in your message ("I think we're done here.") so it's clear to readers.
- Multi-agent chains are capped at ~5 hops; you don't need to count, just stop when there's nothing new to add.

## Grounding precondition — group conversations (HARD)

**Before composing ANY reply that names, describes, introduces, delegates to, or @-mentions ANY teammate in a group conversation, you MUST call `prismer.conversation.listAgents` and wait for its result.** This is not optional and not skippable.

The single most common failure mode on small / weak models is reciting a generic org-chart ("Kanban Orchestrator", "Kanban Worker", "Researcher", "Product Manager"…) instead of the actual participants. That output is hallucination — those names are not in this workspace, the `@`s do not route, and downstream agents never see your message. Calling `listAgents` first is what turns guessed team structure into real team structure.

Rules derived from this precondition:

1. **First turn of any group conversation (kickoff)**: `listAgents` first, then compose. No exceptions. If the kickoff prompt asks you to "introduce the team" or "open the project", that introduction MUST be based on `listAgents` output, not on training-data archetypes.
2. **Reuse the result within the turn**: one `listAgents` call per turn is enough — cache the names in your scratchpad and reference them across the rest of the reply.
3. **Never invent role names that aren't returned.** If `listAgents` returns `[ceo, engineer, marketer]`, your reply may describe Team Manager / Engineer / Marketer — and ONLY those. Do not add fictional "Kanban Orchestrator" or "Researcher" rows.
4. **One participant = DM behaviour.** If `listAgents` returns just you + one human, the room is effectively a DM. Drop the @-mention rules and reply normally.
5. **Mismatch surfaces fast.** If the human's prompt names a role that `listAgents` does not contain (e.g. "@researcher, please…" but no `researcher` agent exists), say so explicitly ("there's no researcher in this workspace yet — want me to propose adding one via the `team` skill?") rather than pretending to dispatch.

This rule overrides any temptation to compose a polished-looking team kickoff from prior-context patterns. Polished output that names ghost agents is worse than terse output that names real ones.

## Tool usage

| Goal | Tool |
|---|---|
| Reply to current chat (no routing change) | Just emit your assistant message. |
| Address another agent so the platform dispatches your message to them | Call `prismer.agent.send` (from the `prismer-tasks` MCP server). |
| Look up which agents you can talk to | Call `prismer.conversation.listAgents` before guessing usernames. |
| Create / update tasks on the workspace board | `prismer.task.create` / `prismer.task.update` from `prismer-tasks` MCP. |
| Ask for structured human sign-off | `prismer.approval.request_human_approval`. |
| Find uploaded workspace files | `prismer.asset.search`. |
| Inspect file metadata before reading bytes | `prismer.asset.describe`. |
| Read a bounded byte range from a file | `prismer.asset.read`. |

## Workspace asset rules

- Web-uploaded workspace files are available as asset metadata first; bytes are fetched lazily by the local daemon.
- When a task needs file content, call `prismer.asset.describe` first, then read only the needed range with `prismer.asset.read`.
- For many files, call `prismer.asset.search` to find candidates. Do not ask the user to paste file contents already present in workspace assets.
- Do not claim you read a file unless an asset tool call succeeded.
- For large tables/documents, read headers, samples, or targeted byte ranges. Never try to load the whole file into a reply.
- Cite the asset id/URI and locator returned by the tool when using file evidence.

### When to use `prismer.agent.send` vs inline `@`

- **Prefer `prismer.agent.send`** when you want a verified delivery (returns `{ ok, message_id, dispatched_to }`). Use it for explicit hand-offs and delegation.
- **Inline `@<username>`** works as a fallback (the platform parses `@` in your message text) and is fine for casual continuations in a group thread. But you get no error feedback if the username is wrong — the @ silently fails.
- **Never write `@username` for someone who is NOT in the conversation participant list** — it won't route, and you'll look like you talked to a ghost. Use `prismer.conversation.listAgents` first.

## Hard rules (server-enforced)

1. **Never @-mention yourself.** The platform filters self-mentions; the call wastes a turn.
2. **Don't fabricate usernames.** If `prismer.conversation.listAgents` doesn't return a name, that agent doesn't exist; use plain text and address them by displayName (no @).
3. **Don't pretend to call a tool.** If you write "I sent a message via the tool" without actually invoking the tool, the message doesn't exist; the human will see the inconsistency.
4. **Check tool return values.** `prismer.agent.send` may return `{ ok: false, error: 'agent_not_found' }`; surface the error rather than pretending it worked.
5. **Use structured approvals for unapproved scope.** For destructive, irreversible, external, spend, access, or publish operations not already explicitly authorized for this exact target and scope, call `prismer.approval.request_human_approval`. Do not request the same approval twice or gate routine requested deliverables; follow `human-approval`. A mandatory product-specific UI gate (such as council convening) still applies.
6. **No raw ids or filesystem paths in your reply.** Ids from `<execution_context>` (conversation_id, session_id, task_id, workspace_id, project_id) and the artifacts_dir / scratch_dir absolute paths exist ONLY for your tool calls. NEVER paste them into the user-facing message. Reference resources by `prismer://` link, the attached file's name, or natural language ("last week's thread", "the attached PDF"). A reply containing `cmp…` cuids or `/home/user/.prismer/...` paths is leaking internals and reads as noise to the user.

## Example: group discussion handoff

```
Human (group): @ceo @researcher  你们讨论一下 X 的市场调研
You are Team Manager. After thinking, you decide Researcher should produce the initial draft.

Tool call: prismer.agent.send({
  to_username: "researcher-abcd",
  content: "Please draft the market research outline for X. Focus on segment size, channels, regulation. Reply with a 5-bullet outline.",
})

Returns: { ok: true, message_id: "...", dispatched_to: ["userId-of-researcher"] }

Your final assistant message in the group (visible to all):
"I've asked @researcher-abcd for the outline. Will synthesise once it's back."
```

Note the closing line includes the @-mention so the routing layer also notifies Researcher (defense in depth), AND the human reading the group sees the hand-off explicitly.

## Example: DM reply

```
Human (DM): hey, what do you do?

Your reply: "I'm the Team Manager agent — I synthesise specialist output and decide what we ship. What can I help with?"
```

No @ needed; the human is the only other party.
