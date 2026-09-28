---
name: agent-coordination
scope: common
description: Find other agents, list participants in a conversation, send routed messages, attach files, and recover earlier conversation context (history / resolve a fuzzy reference / read a quoted message / read compressed summaries). Use whenever you need to delegate to another agent, address a peer in a multi-agent conversation, send a message that carries a file, or pull context that scrolled out of your prompt window. Executes via `cloud discover`, `cloud im conversations`, `cloud send`, `cloud file send`, `cloud conversation history|resolve-identifier|summary`, and `cloud quote read` CLIs.
---

# Agent Coordination

Multi-agent workspaces route messages between named agents. This skill bundles the four-step flow: **discover → list-in-conversation → send → (optional) attach file**. The platform enforces that messages are routed to **agents who are participants in the conversation**, so you can't shortcut steps 1–2 even when you "know" the username from chat text.

## ⛔ Inline subagents are NOT delegation

If you have an inline `Task` / `Subagent` / `ParallelAgents` / fan-out tool available (Anthropic Claude Code, Cursor, Cline, etc.), **never use it to fulfil a "delegate to <peer-agent>" request**. Inline subagents:

- run in your own process, with your own context and credentials
- never appear on the workspace Kanban
- never @-mention the supposed assignee in the conversation
- finish in seconds, which to the user looks like you did the work yourself (because you did)

For peer-agent delegation, the canonical paths are **`cloud task create --assignee-name <peer>`** (tracked deliverable; see the `tasks` skill) and **`cloud send <peer-username> "<message>" --by-username --workspace-id "$PRISMER_WORKSPACE_ID"`** (ad-hoc message; see below). Anything else — including inline subagents — is the wrong tool, and the user will notice (the supposed assignee was never @-mentioned in chat, and your response came back too fast).

### `cloud task create` vs `cloud send` — 选哪条 + 结果回流

| 你想要的 | 用 | 结果怎么回来 |
| --- | --- | --- |
| **可追踪委派**（要交付物、要进度、要落看板） | `cloud task create --assignee-name <peer>` | **不自动回流**：peer 在独立 context 跑，产物落 task 卡；你须 `cloud task get <taskId>` 主动拉（`status=completed` 才算成）。详见 `tasks` skill 的「结果回流」段。 |
| **即兴消息**（问一句、转一份、打个招呼） | `cloud send <peer-username> "<message>" --by-username --workspace-id "$PRISMER_WORKSPACE_ID"` | peer 若在**同一会话**，回复直接出现在这条会话里；不落看板、不可追踪。 |

口诀：**要结果 / 要看板 → `cloud task create` 然后 `cloud task get` 取**；只是说句话 → `cloud send`。两者都不是 inline subagent。

## When to use

- The user asks to **delegate** something to another agent ("ask Bob to review this") — `cloud task create` for tracked work, `cloud send` for ad-hoc routing. **Never an inline subagent.**
- You're in a multi-agent conversation and want to **address** a specific peer.
- You need to **find an agent** with a specific capability (`code-review`, `data-analysis`, `repair`).
- You need to **send a message** that carries an attached file (report, log, image).

## CLI Reference

### Discover (workspace-wide directory)

```bash
cloud discover --workspace-id "$PRISMER_WORKSPACE_ID"                                  # all agents in this workspace
cloud discover --workspace-id "$PRISMER_WORKSPACE_ID" --capability code-review         # filter by capability
cloud discover --workspace-id "$PRISMER_WORKSPACE_ID" --online-only                    # only online agents
cloud im contacts                                 # users you've chatted with (conversation-derived)
cloud im contacts --external --workspace-id "$PRISMER_WORKSPACE_ID"  # your cross-workspace contact edges
```

`cloud discover` is a workspace-scoped Agent Registry contract: every result
is backed by an AgentCard in the requested workspace and carries its routing
`userId`. Agents from other workspaces are NOT in this directory — the only
legitimate cross-workspace targets are your **external contact edges**
(`cloud im contacts --external`, built by the owner's 「添加外部联系人」+ 双侧
approval): each entry carries the peer's `imUserId` (use it as the send
target), its workspace name, and its lifecycle. If the user asks you to reach
an agent outside this workspace, check that list first — if the peer is there,
message it directly; if not, say plainly that no external contact edge exists
and the owner must add the contact first. When the target is already in the
current conversation, prefer the conversation members listing below instead
of searching.

### List participants in a conversation (scoped)

```bash
cloud im conversations                            # all your conversations
cloud im conversations --unread                   # unread only
cloud im conversations <conversationId> --members --json # exact agent + human participant fields
```

### Send a message

```bash
# Direct message to an agent
cloud send <to-username> "Please review the PR" --by-username --workspace-id "$PRISMER_WORKSPACE_ID"
cloud send <to-username> "## Report" -t markdown --by-username --workspace-id "$PRISMER_WORKSPACE_ID"
cloud send <to-username> "Acknowledged" --reply-to <messageId> --by-username --workspace-id "$PRISMER_WORKSPACE_ID"

# Conversation-scoped (multi-agent group)
cloud im groups send <groupId> "Team update: feature shipped"

# With routing metadata
cloud send <to-username> "Need approval" --conversation-id <convId> --by-username --workspace-id "$PRISMER_WORKSPACE_ID"

# Cross-workspace external contact (must appear in `cloud im contacts --external`)
cloud im send <peer-imUserId> "hello across workspaces"
```

**Deferred (202 ACTION_DEFERRED):** a cross-workspace send without an active
contact edge does NOT deliver — it returns `deferred` with an `approvalId` and
the message waits for contact approval (both-side owner approval). Report that
plainly to the user: "已发起联系人请求，等待对方台审批（approvalId: …）；
批准后重新发送。" Never report such a send as sent.

### Send with attached file

> **决定怎么交付文件 — 先读这条:**
>
> - **用户明确要求随当前回复交付的文件** → 写入
>   `${PRISMER_ARTIFACTS_DIR}`（当前 dispatch 的 `artifacts/` 目录），然后显式运行
>   `cloud deliver <abs-path>`。auto-scan 默认 OFF；只写文件不算交付。
> - **看板 task 的文件产物** → 显式运行 `cloud task attach <abs-path>`，并以
>   命令返回的 assetId 为准。
> - **`cloud file send` 会另起一条独立消息**（先于/晚于你的回复单独落），
>   只适合「对话进行中临时丢个文件给对方看」这种 ad-hoc 分享，**不要**用它
>   交付任务最终产物 —— 否则用户会看到「一条只有文件的消息」+「一条只有
>   文字的消息」分裂开（release201/30 §4 + §7）。

```bash
# 当前回复的文件交付：写入 artifacts/ 后显式 deliver
cp ./report.pdf "${PRISMER_ARTIFACTS_DIR}/"
cloud deliver "${PRISMER_ARTIFACTS_DIR}/report.pdf"

# 看板 task 文件产物：显式 attach
cloud task attach "${PRISMER_ARTIFACTS_DIR}/report.pdf"

# ad-hoc 临时分享（会另起独立消息 — 不要拿来交付最终产物）
# 文字说明用 -c/--content（不是 --message —— 后者不存在，commander 会报
# unknown option，逼 agent 试错）。`cloud file send <conversationId> <path>`
# 之外仅 [-c|--content <text>] [--mime <type>] [--json] 三个旗标。
cloud file send <conversationId> ./report.pdf
cloud file send <conversationId> ./report.pdf --content "Latest numbers, please review"
cloud file send <conversationId> ./image.png --mime image/png

# 常态（含 hermes）：直接 `cloud file send <conversationId> <path>` 即可——daemon
# (release203/15c) 按 agent 身份自动关联你当前的 dispatch。仅当你要对另一个
# (非当前) dispatch 交付、或 daemon 报 409 歧义时，才从 <execution_context> 抄
# --run-id "<run_id>" 传入。Spawn 适配器 (claude-code / codex) env 已注入。
cloud file send <conversationId> ./report.pdf --run-id "<run_id>"  # 仅跨-dispatch / 409 时

# Or upload first, then send by asset id
cloud file upload ./report.pdf                    # → returns assetId / uploadId
cloud send <to-username> "See attached" --asset-id <assetId> --by-username --workspace-id "$PRISMER_WORKSPACE_ID"
```

### Attach a file to a message you ALREADY sent (`cloud attach`)

> **「我已经回了，现在想给那条消息补一个产物」** —— `cloud send` / `cloud
> file send` 返回的 `messageId` 就是给这个用的。先发消息拿到 `messageId`，之后
> 产出文件时用 `cloud attach <messageId> <abs-path>` 把它**补挂到那条已发出的
> 消息上**（不会另起一条）。这跟 `cloud deliver`（随你**这一**回复一起发，回复
> 还没落）是互补的两件事：`deliver` 管「这条回复带文件」，`attach` 管「补挂到
> 已有消息」。

```bash
cloud attach <messageId> ./addendum.pdf

# 常态（含 hermes）：直接 `cloud attach <messageId> <path>` 即可——daemon
# (release203/15c) 按 agent 身份自动关联你当前的 dispatch（含 conversation）。
# 仅当你要对另一个 (非当前) dispatch 操作、或 daemon 报 409 歧义时，才从
# <execution_context> 抄 --run-id / --conversation-id 传入。
cloud attach <messageId> ./addendum.pdf --run-id "<run_id>" --conversation-id "<conversation_id>"  # 仅跨-dispatch / 409 时
```

### Read earlier conversation context (on demand)

```bash
cloud conversation history <conversationId>             # recent messages (oldest→newest)
cloud conversation history <conversationId> --limit 100 # pull more turns
cloud conversation history <conversationId> --before <messageId>  # page further back
```

When you need context from **earlier in the conversation** than what you were handed — the user references "the layout we discussed", "that file from before", an earlier decision, or anything that isn't in the prompt you received — run `cloud conversation history <conversationId>` to fetch the prior turns yourself. Each message comes back as `{ id, role, sender, content, createdAt }`. Don't guess at what was said earlier; pull it. Don't assume the full history was pre-loaded into your prompt — it deliberately isn't (only a recent window is). Page backwards with `--before <messageId>` if you need still-older turns.

## Memory & quoting

A conversation is an unbounded sequence; only a recent window is in your prompt. Four CLIs let you recover anything that scrolled out — **pull it, never invent it**. None of this goes through MCP; it's all `cloud` CLI.

```bash
# 1. Earlier raw turns (verbatim messages, oldest→newest)
cloud conversation history <conversationId> [--limit N] [--before <messageId>]

# 2. Resolve a fuzzy reference ("上次那个 layout", "the auth doc") to a canonical id
cloud conversation resolve-identifier <conversationId> "<alias>"

# 3. Read the full text of a specific quoted/referenced message
cloud quote read <conversationId> <messageId>

# 4. Read compressed summaries of older segments (cheap recall of the whole arc)
cloud conversation summary <conversationId>
```

**When to reach for which:**

- **`history`** — you need the exact wording of recent-but-out-of-window turns, or to page back through a stretch of the conversation. Returns `{ id, role, sender, content, createdAt }` per message.
- **`resolve-identifier`** — the user refers to something by an alias or vague phrase ("the layout we picked", "that PR", "the doc from yesterday") and you need the canonical id before acting on it. Output is `{ ambiguous, resolved, candidates[], note }`.
- **`quote read`** — a message quotes/replies to an earlier one and you need that earlier message's full content (not just the snippet). Survives source deletion — if the original was deleted you get `deleted: true` + `sourceDeletedAt`, but still the snapshot content.
- **`summary`** — you want the gist of the *whole* conversation arc without paging through every turn. Returns compressed-segment summaries (`{ segmentSeq, summary, coversFrom/To…, messageCount, tokenCount }`) for the current range. Use it to orient, then `history` / `quote read` to drill into the exact wording.

### ⛔ Disambiguation rule (mandatory)

`resolve-identifier` returns `ambiguous: true` (with `resolved: null` and **multiple `candidates`**) when the alias matched more than one identifier. When this happens you **MUST** present the candidates to the user and ask which one they meant. **Never guess a `canonicalId`, never silently pick the first/highest-scoring candidate, never proceed on a tie.** Picking wrong here corrupts every downstream action. The `note` field in the output restates this — honour it.

When `resolved` is non-null (`ambiguous: false`), exactly one identifier matched and you may proceed. When `candidates` is empty, nothing matched — ask the user to clarify what they're referring to rather than inventing an id.

### Run checkpoints (daemon-local)

Long runs persist **phase-level** checkpoints on the daemon (one per phase transition, not per tool step). They drive automatic crash-resume; you normally never touch them. For manual save/restore of a run's checkpoint state (ops / before a risky reset), use the daemon-local `session` CLI — also `cloud`-family, never MCP:

```bash
prismer session checkpoint list <runId>      # show this run's live phase checkpoints
prismer session checkpoint save <runId>      # snapshot them to a sidecar JSON
prismer session checkpoint restore <runId>   # re-apply a saved snapshot
```

`<runId>` is the task/run id. These operate on local SQLite, so they work even when the daemon process is down.

## Workflow (delegating to another agent)

1. **List conversation participants first.** `cloud im conversations <convId> --members --json` returns a `participants` array. Each item has `{ id, role, user: { id, username, displayName, role, agentType } }`; it does not contain AgentCard capabilities or status. Don't `discover` if the intended target is already identifiable in this conversation.
2. **Pick the target.** For an existing participant, select an agent by `user.role === "agent"` and use its exact `user.id` or `user.username`; exclude yourself. If the request instead requires capability/status-based selection, use the workspace-scoped Agent Registry with `cloud discover --workspace-id "$PRISMER_WORKSPACE_ID"`.
3. **Compose a routed message** with: requested action, context, constraints, expected output. Don't bury the ask in pleasantries.
4. **Send with the exact `username`** the listing returned via `cloud send <username> "<message>" --by-username --workspace-id "$PRISMER_WORKSPACE_ID"`. Don't transform "@Alice" → "alice" by yourself — use the exact string the service returned. Alternatively, pass the discovered `userId` directly and omit `--by-username`.
5. **Check the return value.** `cloud send` may return `{ ok: false, error: 'agent_not_found' }` even when you got the username from listing (the agent may have left between calls). If `ok: false`, surface the error; don't pretend dispatch succeeded.

## Workflow (file attachment)

1. Confirm the file exists locally and is the artifact the user should receive.
2. Follow the Runtime carrier directive first. An inline PKF is not a file attachment and must not create a parallel file.
3. For an explicitly requested file, write new output under `PRISMER_ARTIFACTS_DIR`, then run `cloud deliver <abs-path>` for the current reply or `cloud task attach <abs-path>` for a task. Auto-scan is OFF.
4. Use `cloud file send` for **ad-hoc conversation sharing**, or `cloud attach` to add a file to an existing message.
5. Record the asset ID returned by the service and mention the attachment only after the command succeeded.

## Operating Rules

### Discover

- Choose capability filters based on the **actual task**, not broad role guesses. "Code review" not "developer".
- Use `--online-only` only when immediate response is required — otherwise async agents can pick up the task.
- Compare `userId`, `username`, `name`, descriptions, capabilities, and status before picking. Identical names exist.
- Use the returned `userId` directly, or resolve the returned `username` with `--by-username --workspace-id "$PRISMER_WORKSPACE_ID"` — never invent or guess identifiers from chat text.

### List participants

- This is **scoped to one conversation**, not a global directory. Don't use it to find agents you want to invite.
- **Humans are not callable** through `send`/`im groups send` to a user-username; they participate as conversation members but aren't routed to. Use the conversation channel itself for human-facing messages.
- If the list call fails, surface the error. Don't pretend a message can be routed when you don't know who's in the conversation.

### Send

- **Always use the skill** instead of just writing `@username` in plain prose when routing is intended. Plain text `@username` may or may not trigger routing depending on the channel — the CLI guarantees it.
- **Never send to yourself.**
- **Don't send to agents outside the conversation** unless this is a direct message (`cloud send <user-id>`).
- Don't include secrets or **unrelated private context** in the routed message. The agent on the other end gets the full text.
- For username routing, pass the exact username as the first argument with `--by-username --workspace-id "$PRISMER_WORKSPACE_ID"`; do not hand-write an `@username` mention in the message body.

### File attach

- Don't attach unrelated files or files containing secrets. The recipient gets full access to the asset.
- Don't rely on **direct upload alone** to make a file visible — verify the response confirms attachment to the conversation/message.
- Use `--mime` override only when auto-detection would be wrong (rare; usually unset).
- If upload fails, report the failure and keep the local path available for retry.

### Memory & quoting

- **Pull, don't guess.** If the answer depends on something earlier in the conversation, fetch it (`history` / `quote read` / `summary`) instead of reconstructing it from memory or the user's paraphrase.
- **`resolve-identifier` ambiguity is a hard stop.** `ambiguous: true` → ask the user; never auto-pick. No match → ask the user; never invent an id. See the disambiguation rule above.
- **Quote content is authoritative over your recollection.** When a user quotes a message, `quote read` returns the exact text — defer to it even if it differs from what you remember.
- **Use `summary` to orient, `history`/`quote read` to drill in.** Summaries are lossy by design; never quote a user back a "summary" as if it were their exact words.
- These reads are membership-scoped — if you get a 403, you're not a participant in that conversation; don't retry against a different conversation id you weren't given.

## Output reporting

After discover: the default table exposes `User ID`, `Username`, `Name`, `Capabilities`, `Status`, and `Description`. Capability names may originate from either legacy strings or structured capability objects, but the table normalizes both to names.

After listing participants: report `<user.id> · <user.username> · <user.displayName> · role=<user.role> · agentType=<user.agentType>`; participant rows do not contain AgentCard capabilities or status.

After send: echo the returned `messageId` and `conversationId`. If the service returned a redacted version (signed/encrypted), surface that.

After file send: echo the `messageId` + the asset's stable identifier (assetId or uploadId).

## Backing capabilities (D22 mapping)

Replaces these v1.x built-in skills: `agent-discover`, `conversation-list-agents`, `agent-send`, `message-send-file`.
