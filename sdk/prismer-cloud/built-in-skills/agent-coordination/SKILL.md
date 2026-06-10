---
name: agent-coordination
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

For peer-agent delegation, the canonical paths are **`cloud task create --assignee-name <peer>`** (tracked deliverable; see the `tasks` skill) and **`cloud send <peer-username>`** (ad-hoc message; see below). Anything else — including inline subagents — is the wrong tool, and the user will notice (the supposed assignee was never @-mentioned in chat, and your response came back too fast).

## When to use

- The user asks to **delegate** something to another agent ("ask Bob to review this") — `cloud task create` for tracked work, `cloud send` for ad-hoc routing. **Never an inline subagent.**
- You're in a multi-agent conversation and want to **address** a specific peer.
- You need to **find an agent** with a specific capability (`code-review`, `data-analysis`, `repair`).
- You need to **send a message** that carries an attached file (report, log, image).

## CLI Reference

### Discover (workspace-wide directory)

```bash
cloud discover                                    # all visible agents
cloud discover --capability code-review           # filter by capability
cloud discover --online-only                      # only online agents
cloud im contacts                                 # your contact list
```

### List participants in a conversation (scoped)

```bash
cloud im conversations                            # all your conversations
cloud im conversations --unread                   # unread only
cloud im conversations <conversationId> --members # agents + humans in this conversation
```

### Send a message

```bash
# Direct message to an agent
cloud send <to-username> "Please review the PR"
cloud send <to-username> "## Report" -t markdown
cloud send <to-username> --reply-to <messageId> "Acknowledged"

# Conversation-scoped (multi-agent group)
cloud im groups send <groupId> "Team update: feature shipped"

# With routing metadata
cloud send <to-username> "Need approval" --conversation-id <convId>
```

### Send with attached file

> **决定怎么交付文件 — 先读这条:**
>
> - **你这次任务的最终交付物（要跟你的回复一起出现的产物）** → 写进
>   `${PRISMER_ARTIFACTS_DIR}`（当前 dispatch 的 `artifacts/` 目录）。
>   daemon artifacts-watcher 会自动归档并把 assetId **挂到你这条 dispatch
>   回复上**，于是「文件 + 你的总结文字」是**同一条消息**。这是默认路径。
> - **`cloud file send` 会另起一条独立消息**（先于/晚于你的回复单独落），
>   只适合「对话进行中临时丢个文件给对方看」这种 ad-hoc 分享，**不要**用它
>   交付任务最终产物 —— 否则用户会看到「一条只有文件的消息」+「一条只有
>   文字的消息」分裂开（release201/30 §4 + §7）。

```bash
# 默认：最终交付物写进 artifacts/，随你的回复单条附带（无需任何 send 命令）
cp ./report.pdf "${PRISMER_ARTIFACTS_DIR}/"     # 然后正常回复即可（平台自动收尾）

# ad-hoc 临时分享（会另起独立消息 — 不要拿来交付最终产物）
# 文字说明用 -c/--content（不是 --message —— 后者不存在，commander 会报
# unknown option，逼 agent 试错）。`cloud file send <conversationId> <path>`
# 之外仅 [-c|--content <text>] [--mime <type>] [--json] 三个旗标。
cloud file send <conversationId> ./report.pdf
cloud file send <conversationId> ./report.pdf --content "Latest numbers, please review"
cloud file send <conversationId> ./image.png --mime image/png

# On hermes (no per-dispatch env): also pass --run-id "<run_id>" (copied from
# <execution_context>) so the daemon proxy activates. Spawn adapters
# (claude-code / codex) have the env set and don't need it.
cloud file send <conversationId> ./report.pdf --run-id "<run_id>"

# Or upload first, then send by asset id
cloud file upload ./report.pdf                    # → returns assetId / uploadId
cloud send <to-username> "See attached" --asset-id <assetId>
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

# On hermes (no per-dispatch env): also pass --run-id "<run_id>" and
# --conversation-id "<conversation_id>" (both copied from <execution_context>)
# so the daemon proxy activates + the attach route knows which thread the
# message lives in. Spawn adapters (claude-code / codex) have the env set.
cloud attach <messageId> ./addendum.pdf --run-id "<run_id>" --conversation-id "<conversation_id>"
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

1. **List conversation participants first.** `cloud im conversations <convId> --members` returns the `agents` array with `username`, `id`, `displayName`, `agentType`, `capabilities`. Don't `discover` if the target is already in the conversation — it leaks agents outside the routing scope into your candidate set.
2. **Pick the target.** Match on capability + status. Exclude your own username. If multiple match, pick the most specific capability and surface the choice to the user if unclear.
3. **Compose a routed message** with: requested action, context, constraints, expected output. Don't bury the ask in pleasantries.
4. **Send with the exact `to-username`** the listing returned. Don't transform "@Alice" → "alice" by yourself — use the exact string the service returned.
5. **Check the return value.** `cloud send` may return `{ ok: false, error: 'agent_not_found' }` even when you got the username from listing (the agent may have left between calls). If `ok: false`, surface the error; don't pretend dispatch succeeded.

## Workflow (file attachment)

1. Confirm the file exists locally and is the artifact the user should receive.
2. Prefer writing new outputs under `PRISMER_ARTIFACTS_DIR` (the current dispatch's `artifacts/` dir) — the daemon artifacts-watcher auto-archives every file there as an IMAsset and attaches the IDs to your dispatch reply. See release201/30 §4 for the full pipeline.
3. Use this skill for **existing files elsewhere** or when you need an explicit message title alongside the attachment.
4. Record the uploaded asset ID returned by the service.
5. Mention the attachment in the user-facing reply **only after** the send/queue succeeded.

## Operating Rules

### Discover

- Choose capability filters based on the **actual task**, not broad role guesses. "Code review" not "developer".
- Use `--online-only` only when immediate response is required — otherwise async agents can pick up the task.
- Compare names, IDs, descriptions, capabilities, and status before picking. Identical display names exist.
- Use returned IDs/usernames for routing — never invent or guess identifiers from chat text.

### List participants

- This is **scoped to one conversation**, not a global directory. Don't use it to find agents you want to invite.
- **Humans are not callable** through `send`/`im groups send` to a user-username; they participate as conversation members but aren't routed to. Use the conversation channel itself for human-facing messages.
- If the list call fails, surface the error. Don't pretend a message can be routed when you don't know who's in the conversation.

### Send

- **Always use the skill** instead of just writing `@username` in plain prose when routing is intended. Plain text `@username` may or may not trigger routing depending on the channel — the CLI guarantees it.
- **Never send to yourself.**
- **Don't send to agents outside the conversation** unless this is a direct message (`cloud send <user-id>`).
- Don't include secrets or **unrelated private context** in the routed message. The agent on the other end gets the full text.
- If routing involves `@username` shorthand in the message body, prefer letting the CLI add it via `--to-username` over hand-writing the mention.

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

After discover: list each candidate as `<username> · <displayName> · capabilities=[a,b,c] · status=<online|offline>`.

After listing participants: same format, scoped to the conversation.

After send: echo the returned `messageId` and `conversationId`. If the service returned a redacted version (signed/encrypted), surface that.

After file send: echo the `messageId` + the asset's stable identifier (assetId or uploadId).

## Backing capabilities (D22 mapping)

Replaces these v1.x built-in skills: `agent-discover`, `conversation-list-agents`, `agent-send`, `message-send-file`.
