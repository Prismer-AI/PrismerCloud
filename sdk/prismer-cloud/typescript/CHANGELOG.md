## [Unreleased]

### Changed — clearer file-command help to stop double-delivery

- **`cloud file upload`** description now states it only stages bytes (**NOT a
  delivery** — nothing reaches the user) and prints a post-success note
  pointing to `cloud deliver`. Stops agents from groping to `file upload` as a
  delivery path.
- **`cloud file send`** description now states it posts a *separate* standalone
  message (ad-hoc sharing) and warns against running it together with
  `cloud deliver` on the same file (double-delivery). Aligns the CLI help with
  the release202/09 §3.1 three-operation contract (`deliver` = attach to reply,
  `file send` = separate ad-hoc message, `task attach` = kanban card).
- Built-in skills `canvas-design` / `web-artifacts-builder` SKILL.md corrected:
  they previously listed `cloud deliver` **or** `cloud file send` as equivalent
  delivery options (the drift that caused agents to run both → duplicate send).
  Now `cloud deliver` is the single canonical delivery command.

### Added — release202/09 P5#3 — attach-to-existing-message (动作 A2)

- **`cloud attach <messageId> <path>`** — append a freshly-produced file to a
  message the agent ALREADY sent. `cloud send` / `cloud file send` return a
  `messageId`; this command attaches a file to THAT message (it does **not**
  start a new one). Complements `cloud deliver` (动作 A1, which rides the reply
  that does not exist yet). In-container it proxies to the daemon local-server
  `POST /local/deliver` with the new **`mode: 'message-attach'`** carrying
  `conversationId` + `messageId`; the daemon uploads with its own credential
  then calls the cloud attach route, which appends the asset to the message's
  first-class `attachments[]` column and re-emits `message.updated` for the UI.
- New flags **`--run-id <id>`** / **`--conversation-id <id>`** / **`--daemon-port <port>`**
  for hermes parity (no per-dispatch env — the agent copies the ids out of
  `<execution_context>`). Spawn adapters (claude-code / codex) have the env set
  and need no flags. `--conversation-id` is required (the attach route is
  conversation-scoped); falls back to `PRISMER_CONVERSATION_ID`.
- `proxyDeliver()` gains a `'message-attach'` mode + an optional `messageId`
  argument. Existing `'attach'` / `'send'` / `'task-attach'` modes unchanged.

### Added — release202/09 P5#2 — task-attach via daemon proxy (动作 ③)

- **`cloud task attach <path>`** now detects the in-container daemon-proxy
  context (same `detectDeliverProxy()` as `cloud deliver` / `cloud file send`)
  and, when in-container, proxies to the daemon local-server
  `POST /local/deliver` with the new **`mode: 'task-attach'`**. The daemon
  uploads the file as a **task-bound** asset (`sourceTaskId` = the kanban task
  id) using its own credential, which the cloud `POST /assets` handler
  auto-rolls onto the task card (`appendOutputAssetIdToTask` +
  `reemitTerminalDigestForAssetArrival`) and the asset library. Closes the
  in-container credential break (the agent has no usable IM credential).
- New flags **`--run-id <id>`** (alias for `--task`, sourced from
  `<execution_context>` for hermes parity) and **`--daemon-port <port>`** for
  the proxy path.
- **Back-compat unchanged**: outside a daemon dispatch (e.g. `prismer pair` on
  the user's own machine) `cloud task attach` keeps the existing direct-cloud
  upload path. The run-id guard (`assertNotRunId`) fires on both paths — a
  `run_`-shaped id is rejected before any dispatch because a chat run has no
  kanban card. `proxyDeliver`'s `mode` union extended to include
  `'task-attach'`; `'attach'` / `'send'` unchanged.

### Added — release202/09 P5#1 — Args-fallback for file-delivery proxy (hermes)

- **`cloud deliver`** and **`cloud file send`** now accept `--run-id <id>`,
  `--conversation-id <id>`, and `--daemon-port <port>` flags. These activate the
  in-container daemon-proxy when the per-dispatch env vars are absent — the case
  for the **hermes** adapter, whose gateway spawns once with a frozen env and
  receives per-dispatch ids only inside the prompt's `<execution_context>` XML.
  `detectDeliverProxy()` now takes an optional overrides arg; an explicit flag
  WINS over the env var per field, and the in-container gate fires when a
  task/run id is resolvable from EITHER flag OR env. Spawn adapters
  (claude-code / codex) set the env and need no flags — fully back-compatible;
  the existing positional `cloud file send <conv> <path>` is unchanged.

### Added — release202/09 §3.6 B — X-IM-Workspace defense-in-depth

- The IM client now sends an optional **`X-IM-Workspace`** header from
  `PRISMER_WORKSPACE_ID` (new `imWorkspace` config, mirrors `imAgent`). This
  lets the cloud agent-proxy reach its workspace-scoped fallback when the owner
  `userId`↔`numericId` bridge can't resolve the agent. Absent env → no header →
  unchanged behavior; caller-supplied headers still win on collision.

### Added — release202/09 P2 — Explicit file delivery

- **`cloud deliver <path>`** (动作 A) — attach a file you wrote to your current
  reply. In-container only: proxies to the daemon local-server
  `POST /local/deliver` (the agent has no usable IM credential; only the daemon
  does). Detects context via `PRISMER_TASK_ID` / `PRISMER_RUN_ID` +
  `PRISMER_DAEMON_PORT`.
- **`cloud file send <conv> <path>`** now detects the in-container daemon and
  proxies to `POST /local/deliver` (mode `send`, 动作 B) instead of calling the
  IM API directly; falls back to the direct-IM path for non-container callers
  (`prismer pair`). New shared helper `src/commands/deliver-proxy.ts`.

### Added — v2.0.8 release201/16 — Workspace multi-user onboarding

`src/index.ts`:

- `WorkspaceMembersClient` (`client.workspaces.members.*`) — CRUD on workspace
  ACL. Owner-only mutations; list is any-member (404 for non-members to prevent
  enumeration); `remove` cascades project memberships in the same transaction
  (16 §3.2.3). `IMWorkspaceMember` + `WorkspaceMemberAddOptions` +
  `WorkspaceMemberRemoveResult` exported.
- `WorkspaceInvitesClient` (`client.workspaces.invites.*`) — `create / list /
  revoke` over `/workspaces/:id/invites`. Token-bearing rows; status machine
  `pending → accepted | rejected | revoked | expired`. Tokens are bearer
  secrets — callers MUST treat them like API keys.
- `InvitesClient` (`client.invites.*`) — `preview / accept / reject` over
  `/invites/:token`. `preview` is public (no auth required); the SDK still
  routes through the configured `request` pipeline. Preview surface is
  intentionally minimal — never exposes member count, asset count, or
  workspace owner identity (16 §0.2.4).
- `IMWorkspaceInvite`, `WorkspaceInviteCreateOptions`, `WorkspaceInvitePreview`,
  `WorkspaceInviteStatus`, `WorkspaceInviteRole` exported as named types.
- Both `IMClient` and `PrismerClient` expose `.invites` at the top level for
  convenience; `client.workspaces.invites` and `client.invites` together cover
  the full 6-endpoint surface.

CLI (`prismer` binary, ships from `sdk/prismer-cloud/runtime/`):

- `prismer workspace member <list|add|update|remove>` and `prismer workspace
  invite <create|list|revoke>` subcommands. Tokens are emitted on `invite
  create` and should be passed via the email/share channel — never logged
  to shared transcripts. `invite list` redacts tokens by default; pass
  `--show-tokens` to expose them (use only in private terminals).

### Added — v2.0 §4.6 `ContentBlock` protocol-layer types + §3.0.2 Gap A-④ `X-Idempotency-Key` (Wave 3 Agent D1)

`src/types.ts`:

- New `ContentBlock` 8-variant Anthropic-shape discriminated union (`text` /
  `image` / `audio` / `video` / `file` / `tool_use` / `tool_result` /
  `reasoning`) — exported at the package root. NOT OpenAI's
  `{ type: 'image_url', image_url: {...} }` shape; adapters translate to
  vendor-specific wire format at dispatch time (see `docs/release200/14-…md`
  §4.6 + `14b` "与 14 主文档的关系").
- New `ChatMessage` ( `role` + `content: string | ContentBlock[]` + optional
  `name` / `toolCallId` ) for multi-turn dispatch payloads.
- New `TaskInput` interface with optional `prompt` (legacy) + `messages?:
  ChatMessage[]` (preferred multimodal path).
- `IMSendOptions` gained `idempotencyKey?: string` + `contentBlocks?:
  ContentBlock[]`.
- `IMMessage` (return shape) gained optional `contentBlocks?: ContentBlock[]`
  and `boundarySeq?: number` (the per-conversation strict-monotonic seq
  stamped by the §4.1 server outbox path).
- `RequestFn` signature extended with a 5th optional `opts?: RequestOpts`
  parameter carrying per-call extra HTTP headers. Backward compatible — all
  existing 4-arg call sites still type-check.

`src/index.ts`:

- `MessagesClient.send` / `DirectClient.send` / `GroupsClient.send` now
  accept `content: string | ContentBlock[]`. When `options.idempotencyKey`
  is omitted, the SDK auto-generates a `crypto.randomUUID()` per call and
  stamps it into the `X-Idempotency-Key` HTTP header (Wave 2-B1 server
  endpoint contract). Same key is also mirrored into the JSON body for the
  offline path.
- New private helpers `generateIdempotencyKey()` + `buildSendPayload()`
  share the auto-key + body-build logic across all three send methods.
- `PrismerClient._request` + `_signAndSend` thread the new opts param so
  identity-signed sends still carry the idempotency header.
- JWT refresh + retry path replays the original `opts` so any send retried
  after a token refresh hits server-side dedup via the same key.

Spec refs:

- `docs/release200/14-messaging-state-machine-reliability.md` §3.0.2 Gap
  A-④ + §4.6
- `docs/release200/14b-multimodal-input-pipeline.md` "与 14 主文档的关系"
- `evidence/14-p1-server-wave2-b1.md` (server-side scope is
  `(conversationId, idempotencyKey)`)

Tests: `test/v200-content-block-idempotency.test.ts` (vitest, 7/7 pass) —
covers auto-generated key uniqueness, explicit-key forwarding, retry-loop
key reuse, DirectClient + GroupsClient parity, ContentBlock[] body
serialisation, and `content + options.contentBlocks` mix.

No version bump (wave-close coordinator handles batch bump).

## v2.0.1 (2026-05-21) — Patch: skill list envelope unwrap (GAP 4)

Coordinated v2.0.1 patch release. `/VERSION` → 2.0.1 via `sdk/build/version.sh`.
Internal preview only; open-source npm publish deferred (still in 内测 phase).
Subsumes the earlier `v2.0.0.1` hotfix tag plan.

### Fixed — `cloud skill list` envelope unwrap

`src/commands/skill.ts` `skill list` subcommand previously only checked
`Array.isArray(res)` and `res.skills`, dropping the actual `envelope.data`
payload that `_r` returns. Result: `cloud skill list` always printed
"No skills installed." against a real cloud even when the agent had 20
built-ins. Now unwraps `envelope.data` first, falls back to raw-array
shape, then `Array.isArray(envelope.skills)` (defensive — fixtures only).

No API surface change; no consumer migration required.

## v2.0.0 (2026-05-19)

Coordinated v2.0.0 GA. Single source of truth: `/VERSION` → 2.0.0 via
`sdk/build/version.sh`.

### ⚠️ BREAKING — error code casing

Error envelope `error.code` switched from `UPPER_SNAKE` to `lower_snake` to align with `@prismer/runtime` and the cloud server. Consumers that switch on `error.code` must migrate:

| v1.x | v2.0 |
|---|---|
| `HTTP_ERROR` | `http_error` |
| `TIMEOUT` | `timeout` |
| `NETWORK_ERROR` | `cloud_unreachable` |
| `INVALID_RESPONSE` | `invalid_response` |

### Added — public typed accessors (replace v1.x `as any` workarounds)

- `PrismerClient.fetchAuthed(url, init?)` returns raw `Response` with auth + base URL applied. Use when consumers need `Range`, streaming, or custom header inspection without piercing private fields.
- `IMClient.request<T>(method, path, body?, query?)` exposes the shared `RequestFn` for endpoints not (yet) covered by a typed sub-client. Replaces the `(client.im.account as any)._r(...)` pattern.
- `CloudClient.baseUrl` + `CloudClient.apiKey` readonly getters on the daemon-side client.
- New typed shapes: `IMSkillInstallResult.skill.content/.slug`, `IMAgentSkillRecord.skill: IMSkillInfo`, `Platform` union (`'claude-code' | 'openclaw' | 'opencode' | 'plugin'`), `IMAnalyzeOptions / IMAnalyzeResult / IMRecordOutcomeOptions / EvolutionSyncSnapshot / EvolutionSyncDelta`.

### Added — `EvolutionRuntime` outbox observability

- `outboxMaxAttempts` config (default `5`).
- `OutboxEntry.attempts` counter.
- Public `deadLetter: DeadLetterEntry[]` array for entries that exhausted retries (was previously silently re-pushed forever).
- `console.warn` on drop. Fire-and-forget contract preserved.

### Changed — `EvolutionClient.sync()` signature widened (additive)

Now accepts the nested `{ push, pull }` shape the cloud actually consumes. Legacy flat `{ pushOutcomes, pullSince }` shape still works — additive, no breaking change for callers.

### Added — runtime re-export

- `@prismer/runtime` now exports `openclawAdapter` + `type OpenClawProfileConfig`. v1.9.x users were unable to typed-import this; v2.0 fills the gap.

### Added — **`cloud asset` subcommand group** (7 verbs)

- New `src/commands/asset.ts` registers `cloud asset (list | get | by-hash | upload | download | read | sync)`.
  Backs the v2.0 `assets` Built-in skill (`sdk/prismer-cloud/built-in-skills/assets/SKILL.md`).
- `asset list` — `--workspace-id`, `--task-id`, `--kind`, `--limit`, `--folder-path`, `--folder-path-prefix`, `--json`.
- `asset get <assetId>` — show metadata; `--json` for machine-readable output.
- `asset by-hash <sha256>` — lookup by content hash with optional `--workspace-id`.
- `asset upload <path>` — multipart upload with `--workspace-id`, `--conversation-id`,
  `--kind`, `--task-id`, `--mime`, `--filename`, `--folder-path`.
- `asset download <assetId>` / `asset read <assetId>` — HTTP Range supported
  for partial reads (offset / length flags).
- `asset sync` — list + diff a folder against cloud state for the `assets` Built-in skill.

### Added — **`cloud approval request-human` subcommand**

- New `src/commands/approval.ts` backs the v2.0 `human-approval` Built-in skill.
- `POST /api/im/approvals` wrapper; requires `--conversation-id` or `--task-id` as anchor.
- Stable error envelope on failure; clean JSON with `--json`.

### Added — **`cloud task create` flag expansion**

- 9 new flags on `task create`:
  - `--priority <low|medium|high|urgent>` (validated)
  - `--assignee-id <imUserId>` (direct assignment)
  - `--assignee-name <name>` (resolves @username / display name via discover)
  - `--conversation-id <id>` (pin task to a session)
  - `--kind <work_item|goal>` (board projection, default `work_item`)
  - `--schedule-at <iso>` (one-shot scheduled time → `scheduleType=once`)
  - `--schedule-cron <expr>` (cron expression → `scheduleType=cron`)
  - `--reward <credits>` (alias for `--budget`)
- `--priority` and `--kind` are validated against an allow-list before request.

### Added — **`cloud task update` progress fields**

- `--progress <0.0-1.0>` and `--status-message <text>` flags on `task update`,
  matching the v1.8.2 PATCH wire extension (cloud-side already shipped).

### Added — **Memory CLI extensions**

- `cloud memory write` gained `--type <user|feedback|project|reference>` and
  `--description <text>` flags (forwarded via `IMCreateMemoryFileOptions`).
- New `cloud memory extract --journal <text>` — `POST /api/im/memory/extract`.
- New `cloud memory consolidate` — `POST /api/im/memory/consolidate`.

### Added — **`cloud recall` shortcut**

- `--strategy <keyword|llm|hybrid>` — when provided, routes to `POST /api/im/recall`
  (which honours `strategy`); otherwise uses `GET /api/im/recall` (scope/limit only).
- `--layer <memory|cache|evolution|all>` — alias for `--scope` to match the
  v2.0 `memory` Built-in skill wording.

### Added — **Send / Discover / Conversations flag surface**

- `cloud send`:
  - `--by-username` (treat first arg as username and resolve via discover)
  - `--conversation-id` (pin message to a specific session)
  - `--asset-id` (attach a previously uploaded asset; auto-flips type to `file`)
- `cloud discover` / `cloud im discover`: `--online-only` flag (forwarded
  as both `status=online` and `onlineOnly=true` for router compatibility).
- `cloud im conversations`: `--members` (when a conversation id is given,
  list participants instead of summary).

### Added — **Types**

- `IMDiscoverOptions` now exports `status`, `onlineOnly`, `q`, `limit`, `offset`.
- `IMCreateMemoryFileOptions` now exports `memoryType`, `description`.
- `ContactsClient.discover()` forwards the new params.

### Changed — **Cross-cutting Built-in skill consolidation (21 → 6)**

- The v2.0 Built-in skill catalog now ships 6 workflow skills
  (`tasks`, `memory`, `assets`, `ingest`, `agent-coordination`, `human-approval`)
  instead of the original 21 fine-grained slugs. Each workflow skill delegates
  to `cloud <verb>` CLI calls, which is why this release expands the CLI
  surface above. See `docs/release200/05-skill-system-design.md` §A.5.4 D21.

### Changed — **`bin: { prismer }` → `bin: { cloud }`** (user-directed 2026-05-19)

- v2.0 renames the SDK CLI binary `prismer` → `cloud`. `@prismer/runtime`
  keeps `bin: { prismer }` (daemon priority is higher than SDK, so the daemon
  claims the canonical `prismer` name). Sandbox image install order no longer
  has any conflict — the two binaries are independent.

### Fixed — **Kanban hallucination regression (v1.9.x)**

- The 21-skill prompt-only Built-in cut had no executor in claude-code /
  openclaw / codex adapters; agents read skill markdown and fabricated task
  IDs (`t_43724b61` and similar). The new 6-skill cut + expanded CLI surface
  closes the loop by giving agents real `cloud task ...` commands to spawn.

### Added — **Carried forward from pre-2.0 Unreleased: v1.8.2 wire alignment**

- `MessagesClient.react(conversationId, messageId, emoji, { remove? })` for
  the v1.8.2 reactions endpoint. Idempotent; returns
  `{ reactions: Record<emoji, userId[]> }`.
- `MessageReactionPayload` type + `'message.reaction'` entry in
  `RealtimeEventMap`. Subscribe via `ws.on('message.reaction', (p) => ...)`.
  Distinct from `'message.edit'` — reactions no longer surface as spurious edits.
- Re-exported `MessageReactionPayload` from package root.

---

## v1.9.4 (2026-05-08)

### Added — **Wave-9 task result + asset folder**

- **`tasks.getResult(taskId)`** — fetches the canonical task result via `GET /api/im/tasks/:id/result`. Locked shape: `IMTaskResult { taskId, status, output, metrics?, assetIds: string[], resultUri?: string|null, completedAt: string }`. Replaces the legacy "list IMAssets where `kind=task-result` and `sourceTaskId` matches" pattern (those mirror assets are no longer written; existing rows soft-deleted via migration 310).
- **`tasks.getRunResult(runId)`** — same shape, but reads from `IMTaskRun.output` rather than `IMTask.result`. Use for chat-mention dispatches whose result lives on a run row.
- **`IMTaskResult` type** exported from the package root.

### Changed — **IMAsset folder concept**

- Asset uploads (`im.assets.upload(...)`) now accept an explicit `folderPath` form field (string, or empty for root). The cloud `POST /api/im/assets` endpoint validates and persists it. PATCH was already supported in 1.9.3; POST closes the loop so producers don't need a follow-up move.
- Daemon-produced assets are auto-foldered:
  - `kind=agent-output` (Wave-9 host outbox) → `/tasks/{taskId}`
  - `kind=sandbox-output` (container outbox) → `/sandbox/{taskId}`
- New asset list filters: `?folderPath=…` (exact, `__root__` matches NULL) and `?folderPathPrefix=…` (starts-with). Existing filters unchanged.
- New aggregate endpoint `GET /api/im/assets/folders?workspaceId=…` returning `[{ folderPath, assetCount }]` for a future library tree UI.

### Removed — **`task-result` IMAsset mirror**

- `createTaskResultAsset()` removed from cloud (4 call sites in `task.service.ts`). Every task completion previously wrote a duplicate of `im_messages.content` as a markdown IMAsset; nobody read it (zero cloud / SDK / UI consumers). Migration 310 soft-deletes existing rows; storage is reclaimed by the existing LRU sweep (content-hashed files are dedupable).
- `mvp/m1-local-daemon-hermes-markdown-artifact.ts` and `mvp/m3m4m5-mixed-group-asset-preview.ts` migrated to assert against `tasks.getResult()` / `tasks.getRunResult()` instead of polling the asset list.

### Notes

- The library UI will get folder navigation in a follow-up release (≤1 sprint). This release wires the data model and endpoints; existing UIs continue to render the flat asset list.

## v1.9.3 (2026-05-07)

### Added — **Refactor public surface coverage (workspaces, assets, runtime, account)**

- **Workspaces** (`im.workspaces`) — first-class workspace resource (`/api/im/workspaces`, distinct from the legacy 1.7-era `im.workspace.init` bridge). `list()`, `create()`, `sync(since?)`, `get(id)`, `update(id, opts)`, `archive(id)`. New types: `IMWorkspace`, `IMCreateWorkspaceOptions`, `IMUpdateWorkspaceOptions`, `IMWorkspaceSyncResult`. In 1.9.x most accounts are 1:1 (one default workspace named "Personal").
- **Workspace files** (`im.workspaceFiles`) — auto-versioning `path → assetId` bindings (`/api/im/workspaces/:id/files`). `list()`, `create()`, `delete()`, `sync()`, `history(fileId)`. New types: `IMWorkspaceFile`, `IMCreateWorkspaceFileOptions`, `IMWorkspaceFileSyncResult`.
- **Assets** (`im.assets`) — content-addressed blob store with sha256 dedupe (`/api/im/assets`). `list()`, `byHash()`, `detail()`, `delete()`, `url()`, `download()`, `upload()` (multipart, 100 MB cap). New types: `IMAsset`, `IMAssetListOptions`, `IMAssetUploadOptions`, `IMAssetDetail`. The `prismer://<owner>/asset/<sha256>` URI continues to be resolved via `client.load()` (Load API).
- **Runtime installations** (`im.runtimeInstallations`) — workspace-scoped long-running daemon hosts (`/api/workspace/runtime-installations`, distinct from short-lived per-task sandboxes). `list(workspaceId)`, `create(opts)`, `installAgent(runtimeId, opts)`. New types: `IMRuntimeInstallation`, `RuntimePhase`, `IMCreateRuntimeInstallationOptions`, `IMInstallAgentOnRuntimeOptions`, `IMInstallAgentOnRuntimeResult`.
- **Account: owned agents + self-deletion** — `im.account.listAgents()` (`GET /api/im/me/agents`, the Wave-7 mobile profile card endpoint) returning `IMOwnedAgent[]`; `im.account.deleteAccount()` (`DELETE /api/im/me`, soft-deletes the IMUser, cascades conversations + open tasks, revokes pc_api_keys, blacklists request token) returning `IMAccountDeleteResult`.
- **Memory digest** — `im.memory.digest(opts?)` (`GET /api/im/memory/digest`) returning a CC-style always-load Markdown digest. Server clamps `maxLines` to 10–1000 and `maxBytes` to 500–30000. New types: `IMMemoryDigest`, `IMMemoryDigestOptions`.
- **Tasks SSE** — `im.realtime.taskEventsUrl(token)` URL helper plus `im.realtime.subscribeTaskEvents(token, onEvent, opts?)` (`GET /api/im/tasks/events?token=...`) which parses event blocks and emits `TaskEventEnvelope { id?, type, payload }` for `task.created` / `task.assigned` / `task.progress` / `task.completed` / `task.failed` / `task.cancelled` / `task.updated`. `Last-Event-ID` replay supported via `opts.lastEventId`. New types: `TaskEventType`, `TaskEventEnvelope`.
- **Tasks v1.8.2 enrichment / v1.9.x scoping** — `IMCreateTaskOptions` now exposes `workspaceId`, `conversationId`, `runtimeRoute` (`'agent' | 'sandbox' | 'shell'`); `IMTaskListOptions` accepts `workspaceId` + `conversationId` filters. The SDK `IMTask` shape already exposed `progress`, `statusMessage`, `conversationId`, `completedAt`, `ownerId` alias, `ownerType/Name`, `assigneeType/Name`. New top-level types `TaskKind` (`'work_item' | 'goal'` for goal projection via `metadata.kind`) and `RuntimeRoute`.

### Notes

- LLM proxy endpoints (`POST /api/messages` Anthropic-protocol, `POST /api/chat/completions` OpenAI-compatible, `POST /api/embeddings`, `GET /api/v1/models`) intentionally NOT wrapped — use the official `anthropic` / `openai` SDKs with `baseURL` overridden to `https://prismer.cloud` and the same `sk-prismer-*` API key.
- Runtime / pair / hosted-agent endpoints (`/api/im/pair/*`, `/api/im/agent_profiles`, `/api/im/remote/bindings`, `/api/im/workspaces/:id/runtime`, `/api/sandboxes/*`, sandbox-controller routes) intentionally NOT wrapped — those are owned by `@prismer/runtime` (the daemon package), not the SDK.
- Session-bound App Router endpoints under `/api/auth/*` (NextAuth catch-all, OAuth callbacks, change-password, sms/send, sms/verify) are out of SDK scope — use `@prismer/sdk setup` flow instead.

## v1.8.2 (2026-04-13)

### Added — **Task API Parity for Lumin iOS**

- **Task type extensions**: `progress` (0.0-1.0), `statusMessage`, `conversationId`, `completedAt`, `ownerId` alias, `ownerType`, `ownerName`, `assigneeType`, `assigneeName`
- **`approve(taskId)`** — approve a task in review status
- **`reject(taskId, reason)`** — reject a task in review status
- **`cancel(taskId)`** — cancel (soft delete) a task
- **CLI commands**: `prismer task approve`, `prismer task reject`, `prismer task cancel`
- **PATCH extended**: update now supports `progress`, `statusMessage`, `status` fields

### Fixed

- **Removed `priority` ghost field** — CLI was sending `priority` which the backend ignores
- **Fixed `update` command** — was sending title/description/priority, now sends title/description/status/progress/statusMessage

---

## v1.8.1 (2026-04-10)

### Fixed — **Critical: `prismer setup` crash on fresh install**

- **`@prismer/aip-sdk` dependency resolved from registry** — previous 1.8.0 published with `"file:../../aip/typescript"` path, causing `npm install @prismer/sdk` to silently create a dangling symlink and crash with `Cannot find module '@prismer/aip-sdk'` on first use. Now pinned to `^1.8.1` and resolved from npm registry.
- Hero command `npx @prismer/sdk setup` now works on fresh machines — verified via `npm pack` + isolated consumer install.

### Notes

- No API changes. Drop-in upgrade from 1.8.0.
- AIP SDK is bumped to 1.8.1 in lockstep; both packages must be upgraded together.

---

## v1.8.0 (2026-04-07)

### Added

#### Community Hub (`im.community`)
- **CommunityHub class**: Full-featured forum with built-in TTL caching (feed, stats, notification count) and WebSocket event integration
- `createPost()`, `listPosts()`, `getPost()`, `updatePost()`, `deletePost()`: CRUD for forum posts with board, sort, period, and authorType filters
- `createComment()`, `listComments()`, `updateComment()`, `deleteComment()`: Nested comment threading with optional `parentId`
- `markBestAnswer()`: Mark a comment as the accepted answer (Q&A workflow)
- `vote()`: Upvote/downvote posts and comments (`1 | -1 | 0`)
- `bookmark()`, `listBookmarks()`: Bookmark posts with cursor pagination
- `getNotifications()`, `markNotificationsRead()`, `getNotificationCount()`: Notification inbox with read/unread filtering
- `followToggle()`, `listFollowing()`, `listFollowers()`: Follow users, agents, genes, or boards
- `getProfile()`: Community profile for any user
- `search()`, `searchSuggest()`: Full-text search with autocomplete suggestions
- `getTrendingTags()`, `getHotPosts()`: Discovery and trending content
- `autocompleteGenes()`, `autocompleteSkills()`: Gene/skill autocomplete for linking in posts
- `aggregatedContext()`: One-call feed + stats + unread count (cached)
- `feed()`: Cached hot-post feed with per-board TTL
- **Intent shortcuts**: `ask()` (helpdesk question), `reportBattle()` (showcase battle report), `createMilestone()`, `createGeneRelease()`
- `attachRealtime()` / `detachRealtime()`: Subscribe to `community.reply`, `community.vote`, `community.answer.accepted`, `community.mention` WebSocket events
- `invalidateCache()`: Manual cache invalidation per board or global
- `CommunityHubConfig`: Constructor option for `feedTTLMs` and `statsTTLMs` tuning

#### Contact & Friend System (`im.contacts`)
- `request()`: Send a friend request with optional reason and source
- `pendingReceived()`, `pendingSent()`: List pending friend requests (with pagination)
- `accept()`, `reject()`: Accept or reject a friend request
- `friends()`: List all friends (with pagination)
- `remove()`: Remove a friend
- `setRemark()`: Set an alias/remark for a contact
- `block()`, `unblock()`: Block/unblock a user
- `blocklist()`: List blocked users
- `getPresence()`: Batch presence query for multiple user IDs
- `search()`: Search users/agents by query with type filter
- `getProfile()`: Get a user's public profile
- New types: `IMFriendRequest`, `IMBlockedUser`, `IMUserProfile`
- WebSocket events: `contact.request`, `contact.accepted`, `contact.rejected`, `contact.removed`, `contact.blocked`

#### Knowledge Links (`im.knowledge`)
- **KnowledgeLinkClient**: New sub-client for bidirectional entity associations
- `getLinks(entityType, entityId)`: Query links between memory, gene, capsule, and signal entities
- `MemoryClient.getKnowledgeLinks()`: Get memory-gene knowledge links for the authenticated user's memory files
- New types: `IMKnowledgeLink`, `IMMemoryKnowledgeLinks`, `KnowledgeLinkSource`, `KnowledgeLinkType`

#### Leaderboard V2 (`im.evolution`)
- `getLeaderboardHero()`: Global hero section stats (total agents, genes, capsules, savings)
- `getLeaderboardRising()`: Rising stars with fastest growth rate (filterable by period/limit)
- `getLeaderboardStats()`: Summary stats (totalAgentsEvolving, totalGenesCreated, etc.)
- `getLeaderboardAgents()`: Agent improvement board (filterable by period/domain)
- `getLeaderboardGenes()`: Gene impact board (filterable by period/sort)
- `getLeaderboardContributors()`: Contributor glory board (filterable by period)
- `getLeaderboardComparison()`: Cross-environment comparison data
- `getPublicProfile()`: Public profile landing page for any agent or owner
- `renderCard()`: Render shareable agent/creator card as PNG (satori-based)
- `getBenchmark()`: Benchmark data for profile FOMO section
- `getHighlights()`: Best capsules for a gene (profile highlight reel)

#### Workspace Scope
- `IMClient.getWorkspace(scope, slots, includeContent)`: Fetch workspace superset view — combines memory files, evolution genes/edges, task queue, and skill inventory filtered by scope and slot names
- `installSkill(slugOrId, scope)`: Optional `scope` parameter for workspace-scoped skill installation

#### Auto-Signing (AIP Identity)
- `PrismerConfig.identity`: New constructor option for automatic Ed25519 message signing
  - `'auto'` mode: derive key deterministically from API key via SHA-256
  - `{ privateKey: string }` mode: use explicit Base64-encoded Ed25519 private key
- All IM send requests auto-include `senderDid` + `signature` when identity is configured

## v1.7.4 (2026-04-01)

### Added
- AIP identity: `identity.buildDID`, `identity.resolveDID`, `identity.delegate`, `identity.revoke`
- Verifiable Credentials: `credentials.issue`, `credentials.verify`, `credentials.present`
- Evolution public API: `evolution.metricsHistory`
- **Leaderboard API**: 7 server endpoints — agent improvement (ERR), gene impact, contributors, stats, comparison, snapshot, OG share card
- **Parity tests**: 41 cross-language integration tests (P1-P12)

### Changed
- Leaderboard Phase 2: reimplemented as improvement-based ranking (ERR delta), replacing reverted v1
# @prismer/sdk — Changelog

## v1.7.3 (2026-03-27)

### Added
- Data Governance: qualityScore wired into gene lifecycle (success/fail/fork/seed) and skill install/uninstall/star
- LICENSE file (MIT)
- CHANGELOG.md

## v1.7.2 (2026-03-15)

### Added
- **Tasks API**: 8 client methods (`tasks.create`, `tasks.get`, `tasks.list`, `tasks.claim`, `tasks.complete`, `tasks.fail`, `tasks.update`, `tasks.logs`)
- **Memory API**: 8 client methods (`memory.list`, `memory.get`, `memory.write`, `memory.delete`, `memory.compact`, `memory.loadMemoryMd`, `memory.search`)
- **Identity API**: 6 client methods (`identity.register`, `identity.get`, `identity.rotate`, `identity.revoke`, `identity.attest`, `identity.audit`)
- **Evolution API**: 17 client methods (`evolution.analyze`, `evolution.record`, `evolution.report`, `evolution.createGene`, `evolution.listGenes`, `evolution.publishGene`, `evolution.forkGene`, `evolution.importGene`, `evolution.exportSkill`, `evolution.sync`, `evolution.achievements`, `evolution.personality`, `evolution.edges`, `evolution.capsules`, `evolution.scopes`, `evolution.metrics`)
- **Skill API**: `skills.search`, `skills.get`, `skills.install`, `skills.uninstall`, `skills.installed`, `skills.content`, `skills.installLocal`
- **EvolutionRuntime**: Client-side cache with Thompson Sampling for <1ms gene selection
- Scope parameter support across all evolution methods

### Changed
- Webhook handler supports `evolution:capsule` event type
- CLI: `prismer evolve` subcommands updated for v1.7.2 API

## v1.7.1 (2026-03-07)

### Fixed
- SSE real-time events for `message.new` via Redis pub/sub

## v1.7.0 (2026-02-19)

### Added
- SQLiteStorage for offline-first operation
- SSE continuous sync (push mode)
- E2E encryption (AES-256-GCM + ECDH P-256)
- Multi-tab coordination (BroadcastChannel)
- Storage quota management
- Attachment offline queue
