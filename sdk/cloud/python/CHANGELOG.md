# prismer (Python SDK) -- Changelog

## Unreleased

### EaaS configured sizing and mapping projection

- Create specs accept registry profile IDs such as `4c8g`; availability remains
  server-authoritative. Status/pool models retain historical mapping revisions,
  resource limits and unavailability reasons instead of dropping/rejecting them.
- Missing availability on older responses stays `None`, not a fabricated ready
  state. These changes are local and do not claim a published wheel or cloud
  provider acceptance.

### EaaS multi-pool policy and inventory

- Add sync/async `pool_policy.get/patch` and `project_pools.list` plus typed
  policy/status/inventory models. These operator-only calls preserve full
  replacement policy JSON, config revision, If-Match, idempotency keys,
  explicit dry-run false/true and cursor pagination.
- Unknown provider inventory remains `None`; failures propagate without an
  offline success, implicit policy merge, conflict retry or cold fallback.
  Existing `warm_pool` methods remain unchanged. Cross-field constraints and
  platform ceilings remain authoritative on Cloud.

### Changed — EaaS parity note: live event stream remains TS-only

- **EN**: Python keeps `list_events(...)` as the supported EaaS event surface
  (JSON replay). The live SSE/WS helper is not mirrored in Python for 2.2.61;
  use the TypeScript `connectEaasEvents` helper when a live stream is required.
- **中文**：Python 的 EaaS 事件面保持为 `list_events(...)` JSON replay。2.2.61
  不镜像 TypeScript 的 SSE/WS 实时流 helper；需要实时流时使用 TS
  `connectEaasEvents`。

### Added — EaaS SDK gap-fill: upload_asset / artifacts / skills / events replay / send_message kwargs

- **EN**: New EaaS surfaces mirroring the TS SDK gap-fill (sync + async twins on
  `client.environments` / `client.eaas_skills`):
  - `upload_asset(environment_id, data, media_type='image/png')` — multimodal
    asset front door via the raw authenticated seam (`POST
    /api/v1/environments/:id/assets`, content-hash deduped, raster whitelist);
  - `list_artifacts(environment_id, *, limit=None)` + `get_artifact(environment_id,
    artifact_id)` — principal turn-artifact list (envelope) and content download
    (raw bytes + `X-Eaas-Artifact-Sha256` header, fail envelope on error);
  - `list_events(*, cursor=None, limit=None, environment_ids=None,
    project_ids=None)` — tenant-level JSON replay of `GET /api/v1/events`
    (`{events, nextCursor, truncated}`; a stale cursor surfaces the server's
    409 `state_conflict` resync envelope verbatim);
  - `client.eaas_skills.*` (`EaasSkillsClient` / `AsyncEaasSkillsClient`, tenant
    root path `/api/v1/skills`, operator-only): `list({status?})` / `create` /
    `get` / `update` / `delete` / `publish` — publish rides the marketplace
    human-authorization gate (operator member → 202 `pending_approval`, owner →
    200, already-published → idempotent 200); the face is NOT idempotency-keyed
    (server route declaration);
  - `send_message(..., content_blocks=None, answer=None)` — additive multimodal
    input blocks and HITL answer; the default body stays exactly
    `{"content": content}` when neither is supplied.
  Typed mirrors added to `prismer/types.py`: `EaasTextBlock` / `EaasImageBlock`
  (`EaasContentBlockInput` union), `EaasMessageQuestion` / `EaasQuestionOption` /
  `EaasMessageAnswer`, richer `EaasPrincipalMessageView`
  (`content_blocks` / `question` / `answer`), `EaasArtifactView` /
  `EaasArtifactList`, `EaasEventReplayPage`, `EaasPrivateSkillView` / `Detail` /
  `List` and the `EaasSkillPublishResult` union.
- **中文**：EaaS SDK gap-fill 的 Python 镜像（`client.environments` /
  `client.eaas_skills` 上 sync + async 双生）：`upload_asset`（多模态前门，
  raw seam POST + contentHash 去重）、`list_artifacts` / `get_artifact`
  （产物列表 envelope + raw bytes 内容下载，`X-Eaas-Artifact-Sha256`）、
  `list_events`（`GET /api/v1/events` JSON replay；cursor 过期 409
  `state_conflict` 原样透传）、`client.eaas_skills.*`（租户根路径
  `/api/v1/skills`，operator-only CRUD + publish——发布走 marketplace 人类
  授权门；本面不要求 Idempotency-Key）、`send_message` 增补
  `content_blocks` / `answer` kwargs（缺省 body 仍恰为 `{"content": ...}`）。
  `prismer/types.py` 同步新增 typed 镜像（content block 模型、question /
  answer、更丰富的 `EaasPrincipalMessageView`、artifacts / skills / events
  replay 模型）。

### Changed — `ensure_conversation` drops the `idempotency_key` kwarg

- **EN**: The server conversation-ensure route ignores the `Idempotency-Key`
  header entirely (empty-body contract; ownership is server-bound —
  `ensurePrincipalConversation` has no idempotency param). The TS client never
  sent one; Python now matches. Sending an ignored header was misleading —
  callers could believe replays are deduplicated when they are not.
- **中文**：服务端 conversation-ensure route 完全忽略 `Idempotency-Key`
  header（空 body 契约、归属服务端绑定）。TS 本就未发送，Python 现与之
  对齐——发送被忽略的 header 是误导（调用方会误以为重放被去重）。

### Added — EaaS error-code mirror: `invalid_asset` + `runtime_unavailable`（22 codes）

- **EN**: The `EAAS_ERROR_CODES` mirror (`prismer/types.py`) and its pinned contract test
  now carry the full 22-code server set. Two codes were missing from the earlier
  "20 codes" release note: `invalid_asset` (400, multimodal input face — an `image` block
  whose asset the carrier cannot read for this environment; visible failure, never a
  silently dropped image) and `runtime_unavailable` (503, Gate B+ Task 7 — the in-pod
  Runtime turn surface is unavailable: carrier daemon not ready / bundle predates the
  `turn` entry / exec control-plane failure / exec hard timeout; it surfaces on the
  run + in-thread status-event faces only, since turn dispatch is fire-and-forget).
- **中文**：`EAAS_ERROR_CODES` 镜像（`prismer/types.py`）与其 pinned 契约测试现在覆盖服务端
  全 22 码。早先「20 码」的发行说明漏了两码：`invalid_asset`（400，多模态输入面——carrier
  读不到该 image 块的 asset；可见失败，绝不静默丢图）与 `runtime_unavailable`（503，
  Gate B+ Task 7——环境内 Runtime turn 面不可用：载体 daemon 未就绪 / bundle 早于 `turn`
  入口 / exec 控制面失败 / exec 硬超时；只出现在 run 面与线程内 status 事件面，因为 turn
  是 fire-and-forget 派发）。


### Added — EaaS project usage face (`client.environments.usage`, eaas-gate-b Task 19)

- **EN**: `client.environments.usage(project_id, *, from_=None, to=None, cursor=None,
  limit=None)` (and the async mirror) reads the project metering ledger at
  `GET /api/v1/projects/:id/usage` — UTC window `[from_, to)` (default the current UTC day,
  capped at 31 days), `limit` default 100 clamped to 500, `cursor` resumes from the previous
  page's `nextCursor`. Returns the raw envelope dict (same convention as the rest of the
  `im.*` / EaaS surface). The trailing underscore in `from_` exists because `from` is a
  Python keyword; the wire parameter stays `from`. The `EAAS_ERROR_CODES` contract mirror
  also syncs with the server set (20 codes) — adds the Gate B sessions-face codes
  `invalid_session` / `publishable_key_invalid` / `session_expired` (401) and the
  conversation-face code `capability_denied` (403).
- **中文**：`client.environments.usage(project_id, *, from_=None, to=None, cursor=None,
  limit=None)`（含 async 镜像）读取项目计量账本 `GET /api/v1/projects/:id/usage`——UTC 窗口
  `[from_, to)`（缺省当日、≤31 天）、`limit` 缺省 100 钳 500、`cursor` 用上一页
  `nextCursor` 续扫；返回裸 envelope dict（与 `im.*`/EaaS 其余面同一约定）。`from_` 带下划线
  是因为 `from` 是 Python 关键字，wire 参数仍是 `from`。`EAAS_ERROR_CODES` 契约镜像同步服务
  端集合（20 码）——补 sessions 面的 `invalid_session`/`publishable_key_invalid`/
  `session_expired`（401）与对话面的 `capability_denied`（403）。

### Added — EaaS tenant surface parity (`client.environments` / `client.warm_pool`, eaas-gate-b Task 15)

- **EN**: New EaaS (environment-as-a-service) sub-clients mirroring the TS SDK
  face (`@prismer/sdk` `client.environments` / `client.projects.warmPool`,
  eaas-gate-a Task 12), available on both `PrismerClient` and
  `AsyncPrismerClient`. `client.environments` covers the lifecycle —
  `create/get/list/update/delete`, `pause/wake/suspend`, `exec/get_exec`,
  `put_file/get_file` (raw octet-stream bytes through the authenticated raw
  seam + `X-Eaas-File-Sha256`), `create_snapshot/list_snapshots/restore`,
  `list_services`, and readiness-driven
  `wait_until_ready(capability='services')` (`capability='agent'` raises
  `EaasClientError('capability_unavailable')` immediately — no polling).
  `update(environment_id, body, *, revision)` PATCHes with If-Match in the
  **bare non-negative integer** form (a revision-CAS write — not
  idempotency-keyed, mirroring TS). `client.warm_pool` covers `get/patch` with
  the same If-Match bare-integer contract. All keyed writes auto-generate an
  `Idempotency-Key` and accept `idempotency_key=` for safe retries (the SDK
  performs no automatic retries); a `503 warm_capacity_unavailable` fail
  envelope is surfaced **verbatim** — no retry loop, no automatic downgrade of
  `onMiss: fail → cold`. Non-2xx responses on the binary file face parse
  through an `is_eaas_error_envelope` guard and fall back to a synthesized
  `{code: 'http_error'}` envelope (FF-off bare 404 / gateway HTML pages).
  Naming deviation, recorded: the Python SDK has no projects client yet, so
  the warm pool hangs off the top-level client as `client.warm_pool` instead
  of TS's `client.projects.warmPool`. The event-stream face (`connectEaasEvents`
  / `onEnd`) is a Gate B+ deliverable and is **not** part of this release.
- **EN**: New typed contract mirror in `prismer.types` (pydantic v2, camelCase
  aliases, no new dependency): `EAAS_ERROR_CODES` (exact server code → HTTP
  status set), `EaasClientError`, `EnvironmentCreateSpec/EnvironmentStatus/
  EnvironmentListPage`, `EaasLifecycleResult`, `EaasExecView`
  (`EaasExecExited` | `EaasExecRunning`), `EaasExecReadView`,
  `EaasSnapshotCreated/EaasSnapshotList`, `EaasServicesProjection`,
  `EaasFilePutView`, `EaasEventEnvelope`, `WarmPoolPolicy/WarmPoolStatus`,
  envelope models + the `is_eaas_error_envelope` guard and
  `new_idempotency_key()`. Client methods return the raw envelope dict (same
  convention as the `im.*` surface); validate with e.g.
  `EnvironmentStatus.model_validate(res["data"])`.
- **中文**：新增与 TS SDK 面逐字对齐的 EaaS 子客户端（sync + async 双份）。
  `client.environments` 覆盖生命周期（create/get/list/update/delete、pause/wake/
  suspend、exec/get_exec、put_file/get_file 走带鉴权的 raw seam 的二进制文件面
  + `X-Eaas-File-Sha256`、create_snapshot/list_snapshots/restore、
  list_services、readiness 驱动的 `wait_until_ready`——`capability='agent'`
  立即抛 `capability_unavailable`，不轮询）；`update(environment_id, body, *,
  revision)` 以 If-Match **裸非负整数** 形态 PATCH（revision-CAS 写，非幂等键控，
  与 TS 同）；`client.warm_pool` 覆盖 get/patch
  （同一 If-Match 裸整数契约）。幂等写面自动生成
  `Idempotency-Key`，调用方传 `idempotency_key=` 即可安全重试（本 SDK 无自动
  重试）；`503 warm_capacity_unavailable` fail envelope **原样上抛**——不重试、
  不把 `onMiss: fail` 自动降级成 cold。二进制文件面非 2xx 响应经
  `is_eaas_error_envelope` 判别，兜底合成 `{code: 'http_error'}` envelope
  （FF off 裸 404 / 网关 HTML 错误页）。命名偏差（已记录）：Python 侧尚无
  projects 客户端，warm pool 直接挂在顶层 `client.warm_pool`（TS 为
  `client.projects.warmPool`）。事件流面（`connectEaasEvents` / `onEnd`）是
  Gate B+ 交付，不在本次范围。
- **中文**：`prismer.types` 新增 pydantic v2 契约镜像（camelCase alias、零新
  依赖）：错误码精确集合 `EAAS_ERROR_CODES`、`EaasClientError`、环境/warm
  pool/exec/快照/services/事件 envelope 等模型、`is_eaas_error_envelope`
  guard 与 `new_idempotency_key()`。客户端方法返回原始 envelope dict（与
  `im.*` 面同约定），需要类型时用 `EnvironmentStatus.model_validate(
  res["data"])`。


- Aligned package metadata and the AIP compatibility range with monorepo
  version `2.2.40` for the immutable sandbox/runtime release coordinate; no
  registry publication is implied.
- Aligned package metadata and the AIP compatibility range with monorepo
  version `2.2.39` for the immutable sandbox/runtime release coordinate; no
  PyPI publication is implied.

- Added the ninth `ContentBlock` variant, `ContentBlockPkf`, carrying canonical
  inline PKF source plus an optional title. Message text remains the readable
  Markdown projection for clients that do not render the structured block.

## 2.2.5 (2026-08-02)

- Moved the Python Cloud SDK into the `sdk/cloud` product root and added a
  product-specific canonical CLI while retaining `prismer` as a compatibility
  entry point with an explicit Runtime-conflict diagnostic.
- Aligned the AIP dependency to `prismer-aip>=2.2.5,<2.3.0` and declared the
  dependencies required by the published wheel.
- Added deterministic local release tests for offline, webhook, task-event,
  lifecycle installation, and CLI ownership behavior.

### Added — task events follow the unified single-WS realtime (release203/12)

- **`TasksClient.events` / `AsyncTasksClient.events` now default to the unified
  single WebSocket** (`WS /ws/realtime`, `tasks` channel) instead of the
  `/api/im/tasks/events` SSE endpoint. Both yield the SAME
  `{"id","event","data"}` envelopes as before (`id` is `None` on the WS — the
  sync channel owns cursor resume; the `sync` channel + control frames are
  ignored). Pass `unified_ws=False` to keep the SSE endpoint (the only path with
  `Last-Event-ID` replay). Uses `websockets.sync.client` (sync) /
  `websockets.connect` (async) — already a declared dependency.

### Added — Wave 5 F2 Dispatch reply two-phase transport (`prismer.dispatch_reply`)

Mirror of the TS daemon runtime's Wave 4 E7 implementation
(`sdk/prismer-cloud/runtime/src/daemon/dispatch-reply-transport.ts` +
`pending-reply-cache.ts`). Python-based daemons (or any Python migration
tool that needs to send dispatch replies) can now consume the Wave 3.5 W3
two-phase server contract (`evidence/14-w3-dispatch-two-phase.md`).

New file `prismer/dispatch_reply.py`:

- `send_dispatch_reply_two_phase(client, *, task_id, conversation_id,
  reply_token, reply_to_message_id, agent_im_user_id, status, ...)` —
  drives the `POST /api/im/dispatch/:taskId/prepare` → `POST
  /api/im/dispatch/:taskId/commit` protocol end-to-end. Idempotency key
  is auto-generated (RFC 4122 v4) unless caller supplies one. Optional
  `cache: PendingReplyCache` parameter persists the in-flight
  (idempotencyKey, replyId) tuple BEFORE the prepare network call so a
  process crash between prepare and commit is recoverable.
- `PendingReplyCache` — SQLite-backed (`sqlite3` stdlib, WAL mode) cache
  over a `pending_dispatch_replies` table at
  `~/.prismer/cache/dispatch_replies.db` (override via constructor).
  Lifecycle methods `save_pending` / `mark_prepared` / `mark_attempt` /
  `clear_pending` / `list_for_recovery` mirror the TS contract.
- `recover_pending_replies(client, cache)` — daemon cold-start hook.
  Re-runs prepare for `pending` rows (idempotent on (taskId,
  idempotencyKey) per server contract) and commit for `prepared` rows
  (idempotent on replyId). Detects server-reaper aborted rows via
  `DISPATCH_REPLY_INVALID_STATE` and surfaces "dispatch lost".
- `send_dispatch_reply_legacy(client, ...)` — backwards-compat wrapper
  around the deprecated `POST /api/im/dispatch/reply` endpoint. Emits a
  `DeprecationWarning` with migration guidance. The server stamps the
  legacy path with `Deprecation: true` + `Sunset: 2026-09-01` headers
  per RFC 8594 / RFC 9745.
- Errors: `DispatchReplyAbortedError` (server reaper killed the row),
  `DispatchReplyPrepareError` (4xx/5xx on prepare; e.g.
  `ASSETS_NOT_READY`), `DispatchReplyCommitError` (4xx/5xx on commit).

Public surface (`prismer.__init__`):

- New exports: `PendingReplyCache`, `PendingReplyRow`,
  `DispatchReplyAbortedError`, `DispatchReplyPrepareError`,
  `DispatchReplyCommitError`, `send_dispatch_reply_two_phase`,
  `recover_pending_replies`, `send_dispatch_reply_legacy`,
  `generate_dispatch_idempotency_key`, `DISPATCH_REPLY_CACHE_PATH`.

Tests (`tests/test_dispatch_reply_two_phase.py`, 8/8 pass against real
docker MySQL + real `localhost:3000` cloud):

1. `test_prepare_commit_happy_path` — text-only reply → DB row flips to
   `committed`.
2. `test_prepare_with_ready_asset_commits` — `attachments` + `assetIds`
   with a real `ingestStatus='ready'` asset → commit.
3. `test_prepare_with_missing_asset_raises` — non-existent asset id →
   `DispatchReplyPrepareError(code='ASSETS_NOT_READY')`; cache row stays
   `pending` with `last_error` recorded for retry.
4. `test_prepare_idempotent_resend` — re-send with same idempotencyKey →
   same `replyId`, `alreadyCommitted=True`.
5. `test_commit_idempotent_resend` — re-send commit with same `replyId`
   → `alreadyCommitted=True`.
6. `test_crash_recovery_commits_prepared_row` — manually prepare without
   commit, close the SQLite cache (simulated crash), reopen and run
   `recover_pending_replies` → DB row flips to `committed`,
   `attempted=1 committed=1 aborted=0 failed=0`.
7. `test_recovery_handles_server_aborted_row` — inject a stale `aborted`
   row directly into MySQL → recovery detects
   `DISPATCH_REPLY_INVALID_STATE` and clears the cache,
   `attempted=1 aborted=1`.
8. `test_legacy_endpoint_still_works` — `send_dispatch_reply_legacy`
   reaches the deprecated endpoint and emits `DeprecationWarning`.

Spec refs:

- Server: `evidence/14-w3-dispatch-two-phase.md` (Wave 3.5 W3 — prepare
  + commit endpoints + 1h orphan reaper).
- TS runtime reference: `evidence/14-e7-daemon-reply-skills.md` (Wave 4
  E7 — daemon TS migration).
- Spec: `docs/release200/14-messaging-state-machine-reliability.md`
  §4.3.

No version bump (wave-close coordinator handles batch bump).

### Added — v2.0 §4.6 `ContentBlock` protocol-layer types + §3.0.2 Gap A-④ `X-Idempotency-Key` (Wave 3 Agent D1)

`prismer/types.py`:

- New `ContentBlock` 8-variant Pydantic Union (`ContentBlockText` /
  `ContentBlockImage` / `ContentBlockAudio` / `ContentBlockVideo` /
  `ContentBlockFile` / `ContentBlockToolUse` / `ContentBlockToolResult` /
  `ContentBlockReasoning`). Anthropic-shape `kind` tag (NOT OpenAI's
  `type: 'image_url'` shape — adapters translate to vendor wire format at
  dispatch).
- New `ChatMessage` (role + `content: str | List[ContentBlock]`) and
  `TaskInput` (`prompt` + optional `messages`) with camelCase JSON aliases
  for cross-language wire compatibility.
- `IMMessage` gained optional `content_blocks` (alias `contentBlocks`) and
  `boundary_seq` (alias `boundarySeq`) fields.

`prismer/client.py`:

- New private helpers `_generate_idempotency_key()` + `_build_send_payload()`
  shared across all message-send paths. Auto-generates a UUID v4 idempotency
  key when caller omits one; stamps it into both the
  `X-Idempotency-Key` HTTP header AND the JSON body (`idempotencyKey` field)
  so offline / queued sends survive a request retry.
- Sync + async `MessagesClient.send` / `DirectClient.send` /
  `GroupsClient.send` now accept:
  - `content: str | List[ContentBlock | dict]` (multimodal-ready)
  - kwarg `idempotency_key: str | None`
  - kwarg `content_blocks: List[ContentBlock] | None` (orthogonal pairing
    with a `str` summary)
  - kwarg `quoted_message_id` (parity with sync sibling)
- Sync + async `PrismerClient._request` + `AsyncPrismerClient._request`
  gained `headers: dict | None` so the per-call `X-Idempotency-Key` reaches
  the wire (forwarded via `httpx.Client.request(..., headers=...)`).
- The existing `_signing_request` wrapper forwards `**kwargs` so the new
  headers kwarg flows through the AIP auto-sign path unchanged.

Spec refs:

- `docs/release200/14-messaging-state-machine-reliability.md` §3.0.2 Gap
  A-④ + §4.6
- `docs/release200/14b-multimodal-input-pipeline.md` "与 14 主文档的关系"
- `evidence/14-p1-server-wave2-b1.md` (server `(conversationId,
  idempotencyKey)` UNIQUE)

Tests: `tests/test_v200_content_block_idempotency.py` (pytest, 14/14 pass).

No version bump (wave-close coordinator handles batch bump).

## v2.0.0 (2026-05-19)

Coordinated v2.0.0 GA release. `/VERSION` (single source of truth) → 2.0.0.
Python package version bumped to align with the rest of the SDK suite.

### Changed — **Cross-cutting Built-in skill consolidation (21 → 6)**

- The v2.0 Built-in skill catalog ships 6 workflow skills (`tasks`, `memory`,
  `assets`, `ingest`, `agent-coordination`, `human-approval`) instead of the
  original 21 fine-grained slugs. Each Built-in skill delegates to the
  `cloud` SDK CLI (TypeScript) for execution. Python SDK exposes the same
  underlying API surface used by those CLI verbs.
- **Python SDK CLI bin name unchanged** — Python ships `prismer` as its
  `[project.scripts]` entry (PyPI namespace, no collision with the
  `@prismer/runtime` npm binary). Only the TypeScript SDK CLI bin was
  renamed `prismer` → `cloud`. If you script against Python's CLI, no
  migration needed.
- See `docs/release200/05-skill-system-design.md` §A.5.4 D21 for the
  decision record.

### Added — **Memory-curation skill loaded by Hermes** (promoted from "Unreleased")

- `_memory_curation_skill.py` — embedded copy of
  `sdk/prismer-cloud/skill/memory-curation.md` (regenerated by
  `runtime/scripts/regenerate-memory-curation-skill.cjs`; drift detected by
  the runtime's `skill-memory-curation-sync.test.ts`).
- `hermes_memory_provider.system_prompt_block()` now appends
  `## Memory curation skill\n\n<text>` to the cached `INDEX.md` block, so
  every Hermes session sees the asset-driven memory-page guidance from
  doc 27 rev 5 §3 — even on a brand-new workspace with zero existing INDEX
  content.

### Added — **v1.8.2 wire alignment** (promoted from pre-2.0 inner "Unreleased")

- Add `MessageType` / `ArtifactType` Literal aliases (`types.py`); tighten
  `send*` signatures in `IMClient` / `AsyncIMClient` / `GroupsClient` from
  `type: str` to `type: MessageType`. Covers v1.8.2 wire additions
  (`voice`, `location`, `artifact`, `system`). Re-exported from package root.
- Add `MessagesClient.react(conversation_id, message_id, emoji, remove=False)`
  and async counterpart for the v1.8.2 reactions endpoint. Idempotent;
  returns full `{emoji: [userId, ...]}` snapshot.
- Add `MessageReactionPayload` Pydantic model for the `message.reaction`
  realtime event (v1.8.2). Re-exported from package root.
- Add `cli_ui.py` — Rich-based CLI UI components: `display_banner()`,
  `success()` / `error()` / `warn()` / `info()` status messages,
  `print_table()`, `print_panel()`, `key_value()`, `render_qr()`,
  `Spinner` / `ProgressBar` context managers, `print_code()`, `print_json()`,
  interactive prompts.
- Add `rich>=13.0` as required dependency; add `qrcode>=7.0` as `[qr]`
  optional dependency for terminal QR code rendering.
- Update CLI entry point: display Prismer ASCII art banner on `--help`;
  replace plain `click.echo` with Rich UI functions in `init`, `register`,
  `status` commands.

---

## v1.9.3 (2026-05-07)

Coordinated release for the prismer-cloud-next refactor branch. Two-phase delta:
**(A)** close pre-refactor parity gap to the TS SDK, **(B)** add the v1.9.3
refactor surface (workspaces / workspace-files / assets / runtime
installations / tasks SSE / enriched task DTOs / account self-service).

### A. Pre-refactor parity catch-up (TS SDK feature gap)

#### Account (`client.im.account`)
- `update_profile(...)` — `PATCH /api/im/me` with display_name / avatar_url / bio / metadata + arbitrary extras.
- `list_my_agents()` — `GET /api/im/me/agents` (Wave-7 mobile profile card).
- `delete_me()` — `DELETE /api/im/me` self-service account deletion.

#### Conversations (`client.im.conversations`)
Full v1.8.0 lifecycle:
- `create_group(title, member_ids, ...)` — `POST /api/im/conversations/group` with optional workspace_id, description, metadata.
- `update(conversation_id, ...)` — `PATCH /api/im/conversations/:id`.
- `archive` / `unarchive` / `pin(pinned=True)` / `mute(muted=True)` / `delete`.
- `add_participant` / `remove_participant`.
- `create_direct` now accepts `workspace_id` and `metadata` (forward-compatible with v1.9.x WS scoping).

#### Messages (`client.im.messages`)
- `mark_delivered(message_ids: List[str])` — `POST /api/im/messages/delivered` (delivery receipts).

#### Contacts (`client.im.contacts`) — full v1.8.0 lifecycle
Was a 2-method stub; now 23 methods across discovery, profile lookup,
friend requests, friends list, block/unblock, presence:
- Discovery: `discover`, `search_agents` (alt parameter shape).
- Profile lookup: `get_profile(user_id)`, `get_by_username(username)`.
- Friend requests: `request(target_user_id, message=None)`, `list_pending_in` (alias `list_received`),
  `list_pending_out` (alias `list_sent`), `accept(id)`, `reject(id)`, `cancel(id)`.
- Friends list: `friends()`, `remove(user_id)` (alias `unfriend`), `set_remark(user_id, remark)`.
- Block / unblock: `block`, `unblock`, `list_blocked`.
- Presence: `get_presence(user_ids: List[str])` — `POST /api/im/presence/batch`.

#### Evolution / Skills (`client.im.evolution`)
- `create_skill(slug, name, content, **extras)` — `POST /api/im/skills`.
- `star_skill(skill_id, starred=True)` — `POST /api/im/skills/:id/star`.

#### Workspace (`client.im.workspace`)
- `get_view(scope, slots, include_content)` — `GET /api/im/workspace/view` (lifted from `evolution.get_workspace`, which now lives as a deprecated alias).

#### Top-level Prismer client
- `list_models()` — `GET /api/v1/models`.

### B. v1.9.3 refactor surface

#### IM Workspaces (`client.im.workspaces`)
New plural resource (distinct from legacy `workspace` singular):
- `list()`, `create(name, slug, ...)`, `get(id)`, `update(id, name=, metadata=)`, `archive(id)`, `sync(since=)`.

#### IM Workspace Files (`client.im.workspace_files`)
- `list(workspace_id, path=)`, `bind(workspace_id, path, asset_id)`,
  `delete(workspace_id, path)`, `sync(workspace_id, since=)`,
  `history(workspace_id, file_id)`.

#### IM Assets (`client.im.assets`)
- `list(workspace_id, task_id, kind, limit)`, `upload(file, workspace_id, kind?, source_agent_im_user_id?, source_task_id?, metadata?, file_name?, mime_type?)` (multipart),
  `by_hash(content_hash, workspace_id)`, `detail(id)`, `head(id)`, `download_url(id)`, `delete(id)`.

#### Workspace Runtime Installations (`client.im.runtime_installations`)
App Router resource (`/api/workspace/runtime-installations`):
- `list(workspace_id, limit=)`, `create(workspace_id, name?, image?, cpu/mem requests/limits)`, `install_agent(installation_id, agent_im_user_id, profile_id?, adapter_name?, profile_name?, config?)`.

#### Tasks (`client.im.tasks`) — v1.8.2 + v1.9.3
- `create(...)` now accepts `workspace_id`, `conversation_id`, `runtime_route` (`agent`|`sandbox`|`shell`), `kind` (semantic classifier).
- `list(...)` adds `workspace_id` filter.
- `marketplace(capability, limit)` — `GET /api/im/tasks/marketplace`.
- `reward(task_id, amount?, **extras)` — `POST /api/im/tasks/:id/reward`.
- `subtasks(task_id)` / `summary(task_id)`.
- `events(token=, last_event_id=, timeout=)` — SSE iterator over `GET /api/im/tasks/events`.
  Sync version is a blocking generator; async version is `AsyncIterator`. Yields `{id, event, data}`.

#### Memory (`client.im.memory`)
- `digest(scope=, max_lines=, max_bytes=)` — `GET /api/im/memory/digest`.

#### New types in `prismer.types` (and re-exported from package root)
`WorkspaceDTO`, `WorkspaceFileDTO`, `AssetDTO`, `AgentProfileDTO`,
`RuntimeInstallationDTO` (+ `RuntimeInstallationResources`),
`EnrichedTaskDTO`, `TaskEvent`, `TaskRuntimeRoute`, `TaskKind`.

### Sync + async parity

Every sync method has an async counterpart (`AsyncContactsClient`,
`AsyncConversationsClient`, `AsyncMessagesClient`, `AsyncAccountClient`,
`AsyncTasksClient`, `AsyncMemoryClient`, `AsyncEvolutionClient`,
`AsyncWorkspaceClient`, `AsyncWorkspacesClient`, `AsyncWorkspaceFilesClient`,
`AsyncAssetsClient`, `AsyncRuntimeInstallationsClient`, `AsyncPrismerClient.list_models`).

### Out of scope (owned by `@prismer/runtime` daemon, not the SDK)

The SDK intentionally does NOT wrap these endpoints — they live in
`sdk/prismer-cloud/runtime/`:
- `/api/im/pair/*` (QR-based daemon ↔ cloud pairing).
- `/api/im/agent_profiles/*` (adapter-local config — runtime daemon owns CRUD).
- Workspace runtime device tree + WS `agent.host.declare` event.
- Sandbox controller endpoints (`/api/sandboxes/*` — session-bound; not exposed via API key).

### Verified

- `python -m py_compile prismer/*.py` clean on Python 3.12.
- Smoke import test confirms all new sub-clients are wired on both
  `PrismerClient.im.*` and `AsyncPrismerClient.im.*`.
- mypy strict (existing config): pre-existing errors persist (the package
  has never passed strict mypy); the v1.9.3 additions do not regress beyond
  the same pattern of untyped-sub-client constructors that the rest of the
  module already uses.

## v1.8.2 (2026-04-13)

- Version bump for 1.8.2 coordinated release. Task API parity for Lumin iOS.
- Add `approve(task_id)`, `reject(task_id, reason)`, `cancel(task_id)` to TasksClient and AsyncTasksClient
- Add `conversation_id` parameter to `TasksClient.list()` and `AsyncTasksClient.list()`
- Add `quoted_message_id` field to `IMMessage` type

## v1.8.1 (2026-04-10)

- Version bump for 1.8.1 coordinated release. No API changes.
- Drop-in upgrade from 1.8.0.

## v1.8.0 (2026-04-07)

### Added

#### Auto-Signing (Ed25519 Identity)
- **`identity='auto'`** parameter on both `PrismerClient` and `AsyncPrismerClient` — derives an Ed25519 keypair from the API key (SHA-256 seed) and auto-signs all IM message sends
- **`identity={'private_key': '<base64>'}`** — use a custom Ed25519 private key instead of deriving from API key
- **`client.identity_did`** property — returns the `did:key:z...` identifier of the signing identity
- Built-in `_signing.py` module with `MessageSigner` class — no external dependency required when `PyNaCl` or `cryptography` is installed
- New optional dependency group: `pip install prismer[signing]` (installs PyNaCl)
- Signs outgoing POST requests to `/messages` endpoints with lite protocol: `secVersion|senderDid|type|timestamp|contentHash`
- Parity with TypeScript (`identity: 'auto'`), Rust (`new_with_identity()`), and Go SDK auto-signing

#### Community Forum (`client.im.community`)
- **CommunityClient** with 33 methods (sync + async):
  - Posts: `create_post`, `list_posts`, `get_post`, `update_post`, `delete_post`
  - Comments: `create_comment`, `list_comments`, `mark_best_answer`, `update_comment`, `delete_comment`
  - Voting & Bookmarks: `vote` (upvote/downvote/remove), `bookmark` (toggle), `list_bookmarks`
  - Search: `search`, `search_suggest`, `autocomplete_genes`, `autocomplete_skills`
  - Notifications: `get_notifications`, `mark_notifications_read`, `get_notification_count`
  - Following: `follow_toggle`, `list_following`, `list_followers`
  - Profiles: `get_profile`
  - Stats & Discovery: `get_stats`, `get_trending_tags`
  - Shortcuts: `ask` (helpdesk question), `report_battle` (showcase battle-report)
  - Showcase: `create_battle_report`, `create_milestone`, `create_gene_release`
  - Caching: `feed` (TTL-cached post feed), `invalidate_cache`

#### Contact System (`client.im.contacts`)
- Friend requests: `request`, `pending_received`, `pending_sent`, `accept`, `reject`
- Friends list: `friends`, `remove`, `set_remark`
- Block/unblock: `block`, `unblock`, `blocklist`

#### Knowledge Links (`client.im.knowledge`)
- `KnowledgeLinkClient.get_links(entity_type, entity_id)`: query bidirectional associations between Memory, Gene, Capsule, Signal entities (sync + async)
- `MemoryClient.get_knowledge_links()` / `AsyncMemoryClient.get_knowledge_links()`: get memory-gene knowledge links for the authenticated user

#### Leaderboard V2 (`client.im.evolution`)
- 11 new methods (sync + async):
  - `get_leaderboard_hero` — hero section global stats (token/$/ CO2/hours saved)
  - `get_leaderboard_rising` — rising stars board with period filter
  - `get_leaderboard_stats` — leaderboard summary statistics
  - `get_leaderboard_agents` — agent improvement board with domain filter
  - `get_leaderboard_genes` — gene impact board with sort options
  - `get_leaderboard_contributors` — contributor glory board
  - `get_leaderboard_comparison` — cross-environment comparison data
  - `get_public_profile` — public profile landing page data
  - `render_card` — export agent/creator card as PNG (satori)
  - `get_benchmark` — benchmark data for profile FOMO section
  - `get_highlights` — gene highlight capsules for profile page

#### Workspace Scope
- `get_workspace(scope, slots, include_content)`: fetch workspace superset view with slot filtering
- `install_skill(slug_or_id, scope)`: scope parameter for scoped skill installation
- Async variants for both methods

### Fixed
- `__version__` aligned to 1.8.0 (was 1.7.4 in `__init__.py`)

## v1.7.4 (2026-04-01)

### Added
- AIP identity: `identity.build_did`, `identity.resolve_did`, `identity.delegate`, `identity.revoke`
- Verifiable Credentials: `credentials.issue`, `credentials.verify`, `credentials.present`
- **Parity tests**: 34 cross-language integration tests (P1-P12)

### Changed
- Leaderboard Phase 2: reimplemented server-side with improvement-based ranking

### Fixed
- `__version__` aligned to 1.7.4 (was 1.7.3 in `__init__.py`)

## v1.7.3 (2026-03-27)

### Added
- Data Governance: qualityScore wired into gene lifecycle and skill operations
- Doc samples test suite (`tests/doc_samples_test.py`) -- 22 tested code samples
- LICENSE file (MIT)
- CHANGELOG.md

## v1.7.2 (2026-03-15)

### Added
- **Tasks API**: `tasks.create`, `tasks.get`, `tasks.list`, `tasks.claim`, `tasks.complete`, `tasks.fail`, `tasks.update`
- **Memory API**: `memory.create_file`, `memory.get_file`, `memory.update_file`, `memory.delete_file`, `memory.list_files`, `memory.load`, `memory.compact`
- **Identity API**: `identity.register_key`, `identity.get_key`, `identity.rotate_key`, `identity.revoke_key`, `identity.attest`
- **EvolutionRuntime**: High-level `suggest()` / `learned()` / `get_metrics()` with Thompson Sampling cache
- **Skills API**: `search_skills`, `install_skill`, `uninstall_skill`, `installed_skills`, `get_skill_content`

## v1.7.1 (2026-02-20)

### Added
- **Evolution API**: `analyze`, `record`, `evolve`, `create_gene`, `list_genes`, `delete_gene`, `publish_gene`, `browse_genes`
- **Sync API**: `sync`, `get_sync_stream` (SSE)
- **Files API**: `presign`, `confirm`, `quota`, `upload_file` (convenience method)

## v1.7.0 (2026-02-10)

### Added
- Initial release with Context, Parse, and IM APIs
- Async/sync client variants (`PrismerClient` / `AsyncPrismerClient`)
- CLI tool (`prismer` command)
- Webhook handler with HMAC-SHA256 verification
- Real-time WebSocket and SSE clients
