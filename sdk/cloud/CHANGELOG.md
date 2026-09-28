## 2.2.62 — 2026-09-23

- **Skill catalog curation（bugfix223）**：catalog 批量更新 + 新增内置 skills
  （prismer-* 家族/webapp-qa/weekly-review 等）与 `references/` 资源引用；
  `hermes-curation.json` 策展清单；document-generation 退役。bundle 资源交付
  以 `skill-bundle-resources` / `test:skill-resources` 契约测试钉住。
- **IM contacts deferred 面**：`cloud im contacts --external` 枚举外部联系人边；
  `IMResult` 202 `ACTION_DEFERRED` 契约（deferred/approvalId 顶层提升）；
  offline outbox 对 deferred 不 ack（待审批重发）。
- **Memory grant operator recall**：`cloud memory-grant` 补 `search`/`load`
  子命令（external recall channel，授权来源标注）。
- **Environment stream / storage**：WS 失败改抛 `EaasClientError`（typed error
  path）；offline storage 契约与 browser-storage-native 契约测试；
  `effectiveBudget.periodEnd` 入 payload。
- **MCP**：`send-message` 工具扩展。

## [Unreleased]

### EaaS configured sizing and mapping projection

- TS create/context profiles are registry IDs, not a `2c4g` literal. Mirror
  mapping revisions, resource limits and availability in context/pool/status
  types; older responses with absent availability are not assumed ready.
- CLI preserves an explicit `--profile` and never injects `2c4g` when only a
  pool, template, TTL or metadata is supplied. Unknown valid registry IDs reach
  server validation; malformed IDs fail locally. This requires matching server
  mappings and does not establish registry publication or cloud acceptance.

### EaaS multi-pool policy and inventory

- Add operator-only `projects.poolPolicy.get/patch` and `projects.pools.list`
  with frozen v1 policy/status DTOs, full replacement, config revision,
  If-Match, idempotency keys, dry-run and cursor pagination. Unknown provider
  inventory remains null, never zero.
- Add `cloud pool-policy get/patch` and `cloud pools list`. Policy patch takes
  complete JSON plus explicit policy/config revisions; it does not silently
  read-merge, retry conflicts or fall back to another pool.
- New multi-pool requests bypass the IM offline outbox so CAS headers survive
  and unreachable writes fail visibly. Legacy `warm-pool` methods are unchanged;
  their updated server contract affects only the default preference and shared
  budget, not other pools, the project ceiling or fallback order.

## 2.2.63 — 2026-09-24

### EaaS single-key server integration

- Project machine keys can use existing environment conversation/message/image methods against the updated server, without JWT or principal-session exchange. Project service callers share conversation identity and daily budget across key rotation.
- TypeScript `eaasMemories` and Python sync/async `eaas_memories` expose tenant memory write/search and environment recall grant/revoke. These call the tenant v1 API, not IM memory endpoints.
- Memory writes optionally target a source environment (`environmentId` / `environment_id`). Added explicit new-conversation methods alongside idempotent default-conversation ensure.
- Updated server conversation and artifact routes accept existing operator identities as well as project service callers; artifact reads require `files:read` and retain caller ownership filtering.
- Expanded the SDK-only local journey to require concurrent environments/conversations, real memory recall/revocation, artifact bytes, strict SSE/replay, and physical cleanup. This is an acceptance harness, not a claim that all gates have passed or packages have been published.

### Added (Workspace conversation/task overhaul — spec 11 closure)

- **Task dispatch wire mirror**：`TaskDispatchRequestPayload` 补齐 spec 11 T-P0
  对外 wire 字段（从旧 14 字段面扩为 23 字段面），并同步相关 SDK interface
  mirror；client 侧不再落后于 IM dispatch payload。
- **Role catalog soul carrier**：`team-manager` 升级到 2.2.0、
  `personal-assistant` 升级到 1.1.0，catalog 侧与 runtime role template 的
  org-collaboration 身份段保持同文。
- **Memory grant operator recall**：`cloud memory-grant` 在管理命令之外补
  `search` / `load` 子命令，走 external recall channel，输出授权来源、lane、
  `via:'grant:<id>'` 与 source workspace 标注。
- **Tool attribution contract visibility**：SDK mirror 保留工具步骤输出缺失时的
  honest marker 消费面；workspace run view 可稳定区分“未转发 output”与真实空白。

### Changed (EaaS SDK parity and stream error shape)

- **EaaS principal sessions**: `effectiveBudget.periodEnd` is now part of the
  server payload and TS contract fixtures, matching the public
  `EaasPrincipalBudget` type instead of leaving clients to infer the UTC budget
  window.
- **EaaS live event stream**: websocket setup failures now reject with
  `EaasClientError` (`ws_unavailable`, `ws_connect_aborted`,
  `ws_connect_failed`, or `ws_authorization_failed`) rather than a bare
  `Error`, so callers can handle SSE/WS failures through the same typed error
  path as the rest of the SDK.
- **Parity note**: the live event stream remains TypeScript-only. Python uses
  `list_events` JSON replay; the CLI has no tenant events stream subcommand.

### Added (K 空腔闭合 — 外部联系人 agent 自读面 + 202 deferred 契约)

- **`ContactsClient.externalContacts(workspaceId)`** →
  `GET /api/im/me/external-contacts`（agent 主体回自身跨台边，human 主体等价
  roster.external；`IMExternalContact` / `IMExternalContactsView` 类型）。
- **`cloud im contacts --external --workspace-id <id>`**：外部联系人边枚举
  （lifecycle / 对端 / 台名 / principal / IM User ID）；缺 workspace-id
  且无 `PRISMER_WORKSPACE_ID` → exit 1 且零请求。
- **IMResult 202 deferred 契约**：`IMResult` 增 `deferred` / `approvalId`；
  `_request` 对 202 `ACTION_DEFERRED` 提升到 result 顶层；`cloud im send` /
  `cloud send` 遇 deferred 输出「等待联系人审批 + approvalId」，不再误报
  "sent"。

### Fixed

- **offline outbox 静默丢消息**：flush 对 `result.deferred`（202 联系人审批）
  不再 ack——op 留 pending 待审批后重发（此前 `result.ok` 直接 ack，
  重试义务永久丢失；h-contact-system-refactor §9-SDK prod promote 硬前置）。

### Fixed (browser bundleability — UIKit eaas-sdk 真栈挂载实测的三处阻塞)

- **主入口可进浏览器 bundle**：Node 内建（fs/os/path/crypto）改经
  `process.getBuiltinModule`（Node ≥20.16/22.3 官方运行时加载口）取用——
  模块内不再出现任何 require/import 形态的 Node 说明符，浏览器 bundler
  （turbopack/webpack/vite）不再编译期 `Can't resolve 'fs'`；浏览器与旧运行时
  优雅降级（config.toml fallback 照旧不可用，行为不变）。
- **fetch 解绑修复**：`config.fetch || fetch` 存字段与 `_fetchFn = fetch`
  默认参数在浏览器里是解绑引用——调用直接 `Illegal invocation`（真栈实测）。
  三处（PrismerClient 主管线 / AssetsClient 形态默认参 / connectEaasEvents
  SSE）统一 `fetch.bind(globalThis)`；Node 侧零行为变化。
- encryption.ts 的 `require('node:crypto')` webcrypto fallback 同步改为
  零说明符取用（globalThis.crypto 优先级不变）。

### Added (EaaS SDK gap-fill — artifacts / skills / events replay / CLI catch-up)

- **`EaasIssueSessionBody` 对齐服务端真相（修既有漂移）**：TS 原声明
  `kind?: 'anonymous'|'identity'` 判别字段——服务端
  （`src/tenant/sessions.ts` parseIssueBody）的允许字段恰为
  `{identityToken, anonymous, ttlSeconds, environmentId}`，其余未知字段一律
  400 `invalid_request`（`kind` 会被拒）。wire 判别即字段本身：
  `anonymous: true`（literal true）或 `identityToken`，二选一。CLI/Python
  本就发 wire 形，TS 类型现在与二者一致。
- **Artifacts face**：`environments.listArtifacts(id, {limit?})` →
  `GET /api/v1/environments/:id/artifacts`（principal 专用面：session 直绑
  env ∧ 本 principal，旧→新；limit 1..200 缺省 50，超出 `truncated:true`）；
  `environments.getArtifact(id, artifactId)` → raw bytes（无 success envelope，
  与 `getFile` 同款 raw seam）+ `X-Eaas-Artifact-Sha256` 响应头（与列表
  `contentHash` 同源）；新类型 `EaasArtifactView` / `EaasArtifactList` /
  `EaasArtifactGetResult`。
- **Skills face**：新 `client.eaasSkills.*`（`EaasSkillsClient`，租户根路径
  `/api/v1/skills`——不挂在 environments 下；与 IM 面 `SkillsClient` 同名
  不同物）。operator-only：`list({status?})` / `create` / `get` / `update` /
  `delete` / `publish`；publish 走 marketplace 人类授权门（operator 成员 →
  202 `pending_approval`，owner → 200 直翻，已发布幂等 200）。本面不要求
  Idempotency-Key（发布去重由审批 operationKey 承担——服务端 route 声明）。
- **Events JSON replay**：`environments.listEvents({cursor?, limit?,
  environmentIds?, projectIds?})` → `GET /api/v1/events`（缺省 JSON Accept）→
  `{events, nextCursor, truncated}`；cursor 过期 → 409 `state_conflict`
  envelope 原样透传（`details.resync='eaas.resync'` 引导快照 resync）。
  新类型 `EaasEventReplayPage`。
- **SSE 连接失败错误形态统一**：`connectEaasEvents` SSE 非法响应原抛裸
  `Error`——现与 face 其余部分一致抛 `EaasClientError`（body 为合法 error
  envelope → 服务端 code/message；空 body / FF off 裸 404 / 网关 HTML →
  客户端合成 `http_error`）。
- **CLI catch-up**（`cloud environment`，1:1 mirror 承诺补齐）：新增
  `update <id> --revision <n> [--expires-at] [--metadata k=v]`、
  `usage <projectId>`、`services <id>`、`snapshot-create|snapshot-list|
  snapshot-restore`、`file-get <id> <path> [--out <localFile>]`（raw bytes →
  stdout / 文件，sha256 走 `X-Eaas-File-Sha256`）、
  `file-put <id> <path> <localFile>`。
- Python 侧同步镜像见 `sdk/cloud/python/CHANGELOG.md`（`upload_asset` /
  `send_message` kwargs / `list_artifacts` / `get_artifact` / skills face /
  `list_events` / `ensure_conversation` 幂等键移除）。

### Changed (EaaS SDK gap-fill 收窄项)

- `environments.ensureConversation` 的幂等语义声明：服务端 conversation-ensure
  route 完全忽略 `Idempotency-Key` header（空 body 契约，归属服务端绑定）。
  TS 本就未发送；**Python `ensure_conversation` 移除 `idempotency_key` kwarg**
  （发送被忽略的 header 是误导——调用方会误以为重放被去重）。
- CLI `printRows` 参数类型从 `Record<string, unknown>[]` 放宽为 `unknown[]`
  （行为零变化，仅 `JSON.stringify`）：修复 `tsc --noEmit` 在
  `commands/environment.ts` 的 6 处 TS2345（5 处为存量、1 处由新增
  `usage` 子命令引入），包级 typecheck 现为干净通过。

### Added (错误码镜像补 `runtime_unavailable: 503` — Gate B+ Task 7)

- `EAAS_ERROR_CODES` 镜像补 `runtime_unavailable: 503`（与 `src/tenant/contract.ts`
  同步）：环境内 Runtime turn 面不可用——载体 daemon 未就绪 / bundle turn 入口缺失 /
  exec 控制面失败 / exec 硬超时。turn 是 fire-and-forget 派发，故该码只出现在 run 与
  线程内 status 事件面，**不改变任何 HTTP 状态语义**（additive，无调用方需改）。
  Python 镜像（`prismer/types.py`）与两侧 pinned 集合同步更新。

### Added (EaaS conversation multimodal + HITL question/answer — workspace 能力对齐)

- `environments.sendMessage` body 从 `{ content }` 扩展为
  `{ content, contentBlocks?, answer? }`（additive）：
  - `contentBlocks: EaasContentBlockInput[]` — 多模态输入块（`text | image`，
    image 以 IM `assetId` 引用，服务端解析字节进模型，单图 ≤5MB、≤4 图）；
  - `answer: EaasAnswerInput` — 对某条 pending `agent_question` 的回答
    （`{questionId, optionId?}`；questionId 形如 `run_…#q1`）。
- `EaasPrincipalMessageView` 新增 `contentBlocks`（白名单投影，不含 dataUrl）、
  `question`（agent_question 的结构化提问）、`answer`（principal_answer 钉住的
  回答）；`EaasRunView.status` 可见新公共态 `awaiting_input`（turn 以提问停泊，
  非终态）；错误码镜像补 `invalid_asset: 400`（多模态 asset 不可读的可见失败）；
  `EaasConversationListItem.updatedAt` 修正为服务端真实字段
  `lastMessageAt: string | null`（修既有漂移）。
- CLI `cloud environment message-send` 新增 `--image <assetId>`（可重复）、
  `--answer-question <questionId>`、`--answer-option <optionId>`。
- 新增 `environments.uploadAsset(id, bytes, mediaType?)` + CLI
  `cloud environment asset-upload <envId> <file>`（多模态前门：POST
  `/api/v1/environments/:id/assets`，contentHash 去重幂等，≤5MB raster 白名单，
  见下方 Changed）。

### Changed (EaaS 上传面口径 — 未发布面内收窄)

- `environments.uploadAsset` / `cloud environment asset-upload` 与本节同属本 Unreleased
  块（上一发布版 2.2.5）：以下是**未发布面在发布前收紧口径**，不是对已发布 API 的
  破坏性变更——没有已发布调用方会因此失效。
- `environments.uploadAsset` 的 `mediaType` 从宽口径 `image/*` 收窄为 **raster 白名单**
  （`image/png` / `image/jpeg` / `image/webp` / `image/gif`；`image/jpg` 作为 jpeg
  别名接受，但落库 mime 一律为 canonical `image/jpeg`），且要求首字节（magic bytes）
  与声明型一致。宽口径下可上传的 `image/svg+xml` 等 active content 与 `image/tiff`、
  `image/x-icon` 等非 raster 型现在一律 400 `invalid_request`；声明型与真实字节不符
  （声明 png 实际 gif/svg）同样 400。存储 mime 改为服务端字节派生，不再采信客户端
  声明。SVG/TIFF 有真实需求的调用方需先自行栅格化——本面不提供服务端转码。
- 上传面 body 限额改为**流式**判定（累计超限即断开连接返回 400）：缺 / 伪造
  `content-length` 的超大 body 不再被整包缓冲。对外契约（400 `invalid_request`）
  不变，仅超限时的中止时机前移。

### Changed (pkf-writing 全文评审门 — 调研报告视觉质量过滤)

- `pkf-writing` skill 把 Report quality floor 升级为「构成底线 + 全文评审门」:
  底线里 plain table 不再计入 two rich affordances;交付前对完整成稿按
  内容→视觉选择表做 5 项机械审查(shape→carrier / 图文不重复 / caption 即
  结论 / 章节覆盖 / 降级保真),失败按编辑修复、不许文字辩解;§Visual
  capabilities 的 "zero visuals is a smell" 逃生门从「一句话解释纯文本」
  收紧为逐节内容化理由(背景:test env 甘肃化工调研报告 v1 零图 v2 图文数字
  重复,见会话 gsi97ef78dd)。
- 同步修复生成器漂移:`gen-pkf-writing-skill.ts` 的 TEMPLATE_LINES 落后于
  线上 SKILL.md(缺 2026-09-04 一图胜千言选择表与四视觉源车道整波内容),
  已先把模板同步到线上文本再叠加本改动;generator 自审行预算 240→260,
  与 vitest prompt-size receipt(<260)对齐。
- 重新生成 catalog 与 `sdk/prismer/built-in-skills` 两份 SKILL.md(逐字节
  一致,258 行)。test env 生效需随下次部署重跑 built-ins reupsert。

### Added (ConfigDelivery context-length metadata — 首响应嗅探风暴根治)

- `HermesBundleConfig` 新增可选 `modelContextLengths?: Record<string, number>`
  （与 `sdk/prismer` / `sdk/aip/typescript` 三包同步的 protocol 字段，
  additive/backward-compatible）。cloud bootstrap 由 curated funnel 填充，
  daemon 落成 hermes `custom_providers[].models.<id>.context_length`
  （Hermes step-0 override，终结每轮 ~20 发 404 端点嗅探）。

### Added (memory211/05 W3 — cross-workspace memory grant SDK/CLI face)

- **EN**：`client.im.memory` grows the cross-workspace memory grant face (plan
  `2026-09-10-cross-workspace-memory-grant-v1` Task 5). New sub-client
  `client.im.memory.grants` — `create({targetWorkspaceId, expiresInDays?,
  workspaceId?})` (POST `/api/im/memory/grants`; an existing (source, target)
  row is revived with a new expiry; 1..365 days, server default 30), `list`
  (GET `/api/im/memory/grants`, source perspective), `incoming` (GET
  `/api/im/memory/grants/incoming`, target perspective, includes revoked
  ledger rows), `revoke(grantId)` (DELETE, soft/idempotent) — plus
  `externalSearch({sourceWorkspaceId, queries, limit?, workspaceId?})` and
  `externalLoad({sourceWorkspaceId, path, format?, workspaceId?})` on the
  external recall channel (POST `/api/im/memory/external/search|load`). New
  typed mirrors `IMMemoryGrant` / `IMMemoryGrantStatus` /
  `IMMemoryGrantCreateOptions` / `IMMemoryGrantListOptions` /
  `IMMemoryExternal*` (hit / navigation / page / result shapes, including the
  `tier:'grant'` + `via:'grant:<id>'` + `lane` annotations). Errors ride the
  standard IM fail envelope and are never rewritten: 404
  `MEMORY_EXTERNAL_UNAVAILABLE` is the single zero-leak code for every
  unreachable reason (no grant / revoked / expired / ownership change / source
  gone / out of band), 403 `MEMORY_GRANT_FORBIDDEN` (agent or non-owner),
  429 `MEMORY_EXTERNAL_RATE_LIMITED` (per-caller-per-source budget,
  `error.details.{limit,retryAfterMs}`), 409 `MEMORY_GRANT_PAIR_RACE` /
  `MEMORY_ACCESS_VERSION_CHANGED`, 422 `MEMORY_GRANT_INVALID_EXPIRY`.
  Operator face: `cloud memory-grant <create|list|incoming|revoke>` (human
  table/detail output + `--json`; errors print verbatim and exit 1) — named
  `memory-grant`, NOT `memory`, since the legacy `cloud memory` group was
  removed in memory211/01 §6.9 ruling 3 and the canonical memory CLI is the
  runtime one. Python parity is out of scope for v1 (spec §1.2 Out).
- **中文**：`client.im.memory` 新增跨 workspace 记忆授权面（计划
  `2026-09-10-cross-workspace-memory-grant-v1` Task 5）。新子客户端
  `client.im.memory.grants`——`create({targetWorkspaceId, expiresInDays?,
  workspaceId?})`（POST `/api/im/memory/grants`；已有 (source,target) 行按复活
  语义续期；1..365 天，服务端缺省 30）、`list`（GET `/api/im/memory/grants`，
  授出视角）、`incoming`（GET `/api/im/memory/grants/incoming`，收到视角，含
  revoked 留痕行）、`revoke(grantId)`（DELETE，软撤/幂等）；external 召回通道
  增 `externalSearch({sourceWorkspaceId, queries, limit?, workspaceId?})` 与
  `externalLoad({sourceWorkspaceId, path, format?, workspaceId?})`（POST
  `/api/im/memory/external/search|load`）。新增类型镜像 `IMMemoryGrant` /
  `IMMemoryGrantStatus` / `IMMemoryGrantCreateOptions` /
  `IMMemoryGrantListOptions` / `IMMemoryExternal*`（hit/navigation/page/result
  形态，含 `tier:'grant'` + `via:'grant:<id>'` + `lane` 标注）。错误走标准 IM
  fail envelope 且不改写：404 `MEMORY_EXTERNAL_UNAVAILABLE` 是所有不可达原因的
  唯一零泄漏码（无 grant/撤销/过期/易主/source 消失/出带），403
  `MEMORY_GRANT_FORBIDDEN`（agent 或非 owner），429
  `MEMORY_EXTERNAL_RATE_LIMITED`（每 caller 每 source 预算，
  `error.details.{limit,retryAfterMs}`），409 `MEMORY_GRANT_PAIR_RACE` /
  `MEMORY_ACCESS_VERSION_CHANGED`，422 `MEMORY_GRANT_INVALID_EXPIRY`。操作者
  面：`cloud memory-grant <create|list|incoming|revoke>`（人可读表格/详情 +
  `--json`；错误原样打印并退出 1）——命名 `memory-grant` 而非 `memory`：旧
  `cloud memory` 命令组已在 memory211/01 §6.9 裁决 3 删除，agent 侧权威记忆
  CLI 是 runtime 的 `prismer memory`。Python parity 不在 v1（spec §1.2 Out）。

### Added (eaas-gate-b Task 19 — `environments.usage()` + error-code mirror sync)

- **EN**：`client.environments.usage(projectId, {from?, to?, cursor?, limit?})` reads the
  project metering ledger at `GET /api/v1/projects/:id/usage` — UTC window `[from, to)`
  (default the current UTC day, capped at 31 days), `limit` default 100 clamped to 500,
  `cursor` resumes from the previous page's `nextCursor`. Returns the envelope with
  `EaasUsagePage` data (`items` / `nextCursor` / `rateVersion` / `periodSpent`) — new typed
  mirror `EaasUsageItem` / `EaasUsagePage` in `@prismer/sdk/environment-contract`. Operator
  face: a principal session is denied per project ownership (403/404 pass through verbatim).
  The `EAAS_ERROR_CODES` mirror also catches up with the server contract (20 codes): the
  Gate B sessions-face codes `invalid_session` / `publishable_key_invalid` /
  `session_expired` (401) and the conversation-face code `capability_denied` (403) were
  missing from the TS/Python mirrors. Python: `client.environments.usage(project_id, *,
  from_=None, to=None, cursor=None, limit=None)` on both sync and async clients (`from_`
  because `from` is a keyword — the wire parameter stays `from`).
- **中文**：`client.environments.usage(projectId, {from?, to?, cursor?, limit?})` 读取项目
  计量账本 `GET /api/v1/projects/:id/usage`——UTC 窗口 `[from, to)`（缺省当日、≤31 天）、
  `limit` 缺省 100 钳 500、`cursor` 用上一页 `nextCursor` 续扫；返回 envelope，data 为新增
  类型镜像 `EaasUsagePage`（`items`/`nextCursor`/`rateVersion`/`periodSpent`，见
  `@prismer/sdk/environment-contract`）。operator 面：principal session 按 project 归属
  403/404 原样透传。`EAAS_ERROR_CODES` 镜像同步服务端契约（20 码）：补齐 Gate B sessions
  面的 `invalid_session`/`publishable_key_invalid`/`session_expired`（401）与对话面的
  `capability_denied`（403）——TS/Python 两侧镜像此前缺这四码。Python 为
  `client.environments.usage(project_id, *, from_=None, to=None, cursor=None, limit=None)`
  （sync/async 双客户端；`from_` 因 `from` 是关键字——wire 参数仍是 `from`）。

### Added (eaas-gate-b Task 15 — CLI EaaS 面：`cloud environment` / `cloud warm-pool`)

- **EN**：New CLI command groups mirroring the SDK EaaS surface. `cloud
  environment` covers `create` (`--project/--template/--profile/--ttl/
  --metadata k=v/--env k=v/--on-warm-miss`), `get`, `list`
  (`--cursor/--limit`), the idempotent lifecycle verbs `pause/wake/suspend/
  delete`, and `exec` + `exec-get` (variadic command after `--`, paged reads
  via `--cursor`; a still-running handle prints the exact `exec-get`
  follow-up). `cloud warm-pool` covers `get` and `patch`, and the
  patch is **read-merge-write**: the warm-pool wire is REPLACE-semantics
  (omitted policy fields fall back to the server default 0/`'cold'`), so a
  naive partial write would silently reset the rest of the running policy.
  The CLI therefore reads the current desired policy, overlays the operator's
  flags, and writes the FULL merged policy with If-Match = the revision
  observed at read time; `--revision` stays available as an explicit CAS pin
  for scripts. `--dry-run` prints the replace-semantics note so operators
  know why the CLI merges (and what a direct partial SDK write would do).
  Every keyed write accepts `--idempotency-key` so an operator can retry the
  SAME operation safely (a fresh key is a new operation), and a `503
  warm_capacity_unavailable` is printed verbatim with its code — the CLI
  never rewrites `onMiss: fail` into a cold start. Errors print as
  `<code>: <message>` and exit 1. **Contract ruling (recorded for Gate B
  Task 19): the SDK `WarmPoolClient.patch` type stays the FULL
  `WarmPoolPolicy` — it is deliberately NOT widened to `Partial`, because
  under replace semantics a type-level partial would legalize the destructive
  path the CLI just closed.** Not wired (by scope): file / snapshot /
  services / `waitUntilReady` / event stream subcommands — use the SDK for
  those.
- **中文**：新增镜像 SDK EaaS 面的 CLI 命令组。`cloud environment` 覆盖
  create（`--project/--template/--profile/--ttl/--metadata k=v/--env k=v/
  --on-warm-miss`）、`get`、`list`（`--cursor/--limit`）、幂等 lifecycle 动词
  `pause/wake/suspend/delete`、`exec` + `exec-get`（变长命令在 `--` 之后，
  `--cursor` 分页读；still-running 句柄会打印确切的 `exec-get` 跟进命令）。
  `cloud warm-pool` 覆盖 `get` 与 `patch`，patch 为 **read-merge-write**：
  warm-pool wire 是 replace 语义（省略字段按服务端默认 0/`'cold'` 落地），
  裸部分写会静默重置在跑策略的其余字段。CLI 先读当前 desired，叠加操作者
  旗标，再以读时 revision 作 If-Match 写回**完整合并后的 policy**；
  `--revision` 保留为脚本用显式 CAS pin。`--dry-run` 打印 replace 语义提示，
  说明 CLI 为何合并、以及直接走 SDK 部分写会发生什么。所有幂等写面接受
  `--idempotency-key`（同一 key 重试 = 同一操作，新 key = 新操作）；`503
  warm_capacity_unavailable` 连码原样打印——CLI 绝不把 `onMiss: fail` 改写成
  cold 启动。错误以 `<code>: <message>` 形式输出并 exit 1。**契约裁决（记录，
  归 Gate B T19）：SDK `WarmPoolClient.patch` 类型维持全量 `WarmPoolPolicy`，
  有意不放宽为 `Partial`——replace 语义下类型层部分写等于把刚被 CLI 关掉的
  破坏路径合法化。**按范围未接线：文件 / 快照 / services / `waitUntilReady` /
  事件流子命令——请走 SDK。

### Changed (eaas-gate-b Task 10 — services 投影 gatewayUrl 授权 URL)

- **EN**：`environments.listServices()` data 面 `EaasServicesProjection.gatewayUrl`
  changes from `null` (Gate A placeholder) to a signed scoped gateway URL string.
  The URL carries only the logical environment id plus an HMAC-signed token
  (`{v:1, envId, principalId?, exp}`) — never a pod IP or carrier name. For
  principal sessions the token embeds the session-bound principalId (another
  principal's URL fails verification); operator channels get an owner-dimension
  URL with no principal binding. The Gateway forwarding service that consumes
  these URLs remains a Gate B+ deliverable.
- **中文**：`environments.listServices()` 返回的 `EaasServicesProjection.gatewayUrl`
  从恒 `null`（Gate A 占位）变为 HMAC 签名的 scoped gateway URL 字符串。URL 只含
  逻辑环境 id + 签名 token（内嵌 `{v:1, envId, principalId?, exp}`）——绝不含
  Pod IP / 载体名。principal session 通道的 token 内嵌 session 直绑的 principalId
  （他 principal 的 URL 验证即拒）；operator 通道为 owner 维度（无 principal
  绑定）。消费这些 URL 的 Gateway 转发服务仍是 Gate B+ 交付面。

### Fixed (eaas-gate-a Task 12 fix round 1 — 流死亡可见化 + 文件面错误路径硬化)

- **EN**：`connectEaasEvents` gains an `onEnd?: (info: {transport:'sse'|'ws';
  code?:number; reason?:string}) => void` option. Previously a stream could die
  silently: WS close/error listeners were removed after `authorized` (a 4401
  token revocation, 4404 FF off, 4403 slow-consumer or transport drop left the
  caller waiting forever), the SSE reader exited without a signal, and WS
  `error` frames (e.g. a rejected subscribe) were swallowed. Now all three
  surface through `onEnd`; caller-initiated `disconnect()`/`signal` abort does
  NOT fire `onEnd`. Recovery contract: on `onEnd`, reconnect via
  `connectEaasEvents` carrying the last received `envelope.cursor` (the server
  replays first; a pruned cursor is answered with `eaas.resync`).
- **EN**：`environments.putFile` no longer throws raw `SyntaxError` on non-JSON
  error bodies (FF-off bare 404 / gateway HTML): non-200 responses now parse
  through an `isEaasErrorEnvelope` guard and fall back to a synthesized
  `{success:false, error:{code:'http_error'}}` envelope. `getFile`'s fallback
  was unified onto the same helper (its synthesized code changes from
  `provider_unavailable` to `http_error`). Along the way: SSE framing now
  tolerates CRLF line endings and the external-signal listener is detached when
  the stream ends.
- **中文**：`connectEaasEvents` 新增 `onEnd` 回调——此前流会静默死亡：WS 在
  `authorized` 后移除了 close/error 监听（4401 吊销、4404 FF off、4403 慢消费
  者、传输断开调用方零感知）、SSE reader 无声退出、WS `error` 帧（订阅被拒）
  被吞掉。现在三者都经 `onEnd` 上抛；调用方主动 `disconnect()`/signal abort
  不触发。恢复契约：收到 onEnd 后携带最后 `envelope.cursor` 重连（服务端先
  replay；cursor 被 prune → 服务端发 `eaas.resync`）。
- **中文**：`environments.putFile` 遇非 JSON 错误 body（FF off 裸 404 / 网关
  HTML）不再抛原始 SyntaxError：非 200 响应经 `isEaasErrorEnvelope` 判别，
  兜底合成 `{success:false, error:{code:'http_error'}}` envelope；`getFile`
  兜底统一到同一 helper（合成码从 `provider_unavailable` 改为 `http_error`）。
  顺手：SSE 帧解析容忍 CRLF 行尾；流结束时摘除外部 signal 监听。

### Added (eaas-gate-a Task 12 — SDK EaaS 面：client.environments/warmPool + contract/stream 子路径)

- **EN**：New EaaS (environment-as-a-service) surface for the tenant API
  (`/api/v1/**`). `client.environments` (`EnvironmentsClient`) covers the full
  lifecycle — `create/get/list/update/delete`, `pause/wake/suspend`, `exec/
  getExec`, `putFile/getFile` (raw octet-stream bytes + `X-Eaas-File-Sha256`),
  `createSnapshot/listSnapshots/restore`, `listServices`, and readiness-driven
  `waitUntilReady({capability:'services'})` (`capability:'agent'` rejects
  immediately with `capability_unavailable` — Gate A does not probe agent
  readiness). `client.projects.warmPool` (`WarmPoolClient`) covers warm-pool
  `get/patch` with the If-Match bare-integer revision contract; a `503
  warm_capacity_unavailable` fail envelope is surfaced verbatim — no retry, no
  automatic cold downgrade. All idempotency-keyed writes auto-generate an
  `Idempotency-Key` and accept a caller-supplied key for safe retries (the SDK
  performs no automatic retries).
- **EN**：Two new subpath exports: `@prismer/sdk/environment-contract` (hand-
  mirrored wire types `EnvironmentCreateSpec/EnvironmentStatus/WarmPoolPolicy/
  WarmPoolStatus/EaasEventEnvelope` + `EAAS_ERROR_CODES` +
  `isEaasErrorEnvelope` guard; source of truth `src/tenant/contract.ts`, the
  SDK does not import cloud src/) and `@prismer/sdk/environment-stream`
  (`connectEaasEvents` — SSE `GET /api/v1/events` via fetch streaming with the
  Authorization header, or WS `/ws/eaas/v1` with first-frame auth; eventId LRU
  1024 dedup; `eaas.resync` → `onResync` + `handle.resynced`). Both subpaths
  are also re-exported from the root entry.
- **中文**：新增 EaaS（环境即服务）租户面。`client.environments` 覆盖环境全
  生命周期（create/get/list/update/delete、pause/wake/suspend、exec/getExec、
  putFile/getFile 二进制文件面、createSnapshot/listSnapshots/restore、
  listServices、readiness 驱动的 waitUntilReady——`capability:'agent'` 立即以
  `capability_unavailable` 拒绝，Gate A 不探 agent 就绪）。`client.projects.
  warmPool` 覆盖 warm-pool get/patch（If-Match 裸整数 revision 契约）；`503
  warm_capacity_unavailable` 原样上抛——不重试、不自动降级 cold。幂等写面
  自动生成 `Idempotency-Key`，调用方可传入同一 key 安全重试（本 SDK 无自动
  重试）。
- **中文**：新增两个子路径导出：`@prismer/sdk/environment-contract`（手写
  镜像 wire 类型 + 错误码集合 + `isEaasErrorEnvelope` guard；真相源
  `src/tenant/contract.ts`，SDK 不 import cloud src/）与
  `@prismer/sdk/environment-stream`（`connectEaasEvents`——SSE 走 fetch
  streaming + Authorization header、WS 走 `/ws/eaas/v1` 首帧 auth；eventId
  LRU 1024 去重；`eaas.resync` → `onResync` + `handle.resynced`）。两个子
  路径同时从主入口 re-export。
- **EN**：Surface boundary (recorded, T17 doc sync): the Gate A SDK covers
  environments + warm pool + event streams only. `GET
  /api/v1/projects/{id}/usage` has **no** SDK method yet (Task 12 deferred
  note (a); add it when the first consumer appears), `client.tenants` is
  absent (no binding endpoint in Gate A) and `./environment-react` is
  deliberately not shipped (ChatSurface is a Gate B surface).
- **中文**：面边界记录（T17 文档同步）：Gate A SDK 只覆盖 environments +
  warm pool + 事件流。`GET /api/v1/projects/{id}/usage` 尚无 SDK 方法
  （Task 12 挂账 (a)，出现首个消费者时补一行）；`client.tenants` 缺席
  （Gate A 无绑定端点）；`./environment-react` 有意不发布（ChatSurface 属
  Gate B 面）。

### Changed (agent-name-unification §7 follow-up — X-IM-Agent 客户端 im: 形态)

- `cloud send` / `im` / `task` 等经 `getIMClient` / `getAPIClient` 发出的请求：
  X-IM-Agent 值形态从 `PRISMER_AGENT_USERNAME` 升级为**优先
  `im:<PRISMER_AGENT_IM_USER_ID>`**（该 env 由 daemon 在 agent service spawn 时
  注入，`persistence/hermes/index.ts` + `prismer-env.ts`），缺失/旧 env 回落
  username；两者皆无 → 无 header（人类直跑 CLI 的 legacy 行为不变）。
- 云端 middleware 已接受 `im:<cuid>` 前缀形态（Wave1 B1/B5），本改在客户端
  固定自证路径：跨 workspace 同名 slug 时 username 腿（无 ws 收窄 +
  updatedAt desc 排序）的非确定性归属不再生效；长驻进程旧 env（仅 username）
  仍靠 respawn 换新 env。
- `PrismerClient` 传输面零改动（imAgent 值字节原样透传），`error-handling.test.ts`
  补 `im:` 前缀形态透传钉。

### Changed (memory211 — office-artifacts skill interpreter clarity)
- `catalog/skills/office-artifacts/SKILL.md` Runtime baseline now names the
  interpreter that actually holds the baked office libs:
  `/home/user/.venv/bin/python3` (image venv, `uv pip install --python
  /home/user/.venv/bin/python` over `requirements-release.lock.txt`). System
  `/usr/bin/python3` has none of them, so an agent probing system python was
  concluding "missing deps" from a wrong-interpreter failure. The doc now says:
  run generators with the venv interpreter and re-probe there before declaring a
  dependency missing; `pip install` on the fly stays forbidden. Byte-identical
  with the `sdk/prismer/built-in-skills/` build-time copy (gitignored, synced
  from this catalog); the `catalog-source-contract.test.ts` skills-manifest
  hash was re-pinned for this content-only change (inventory still 43 skills /
  32 roles). The pin had ALREADY gone stale on this branch — `memory/` +
  `memory-dream/` SKILL.md content changed after 306d702c4 without a refresh,
  so the test was red at HEAD with `a73eaa2b…`; this commit re-pins to the tree
  including the interpreter clarification.

### Added (memory211/01 §6.11 — W7 behavioural-closure wave, cloud-side half)
- Metric registry entries `turn.navigation_used` (1 when the turn browsed, or
  loaded a page after a miss-lane search; repeated searches read 0) and
  `turn.shortcuts_taken` (loads with no preceding browse), emitted by the daemon
  dispatch finally block from its new per-workspace tool-sequence ring (daemon
  CHANGELOG carries the ring + privacy boundary). Rows exist only when the turn
  made at least one memory call — an absent row means "no memory activity",
  never zero activity.
- GQ `mesh` category (spec §6.11 item 6a, claiming the §6.8.1 priority-1
  acceptance gap): `src/im/tests/gq-mesh-section-health.test.ts` seeds two
  fixtures identical except for section-anchored edges and asserts the dream
  section-mesh metrics MOVE (interSectionEdgeDensity 0→1,
  crossPageSectionEdgeRatio 0→1, orphanSectionRatio 1→0), plus a mesh-blind
  mutation negative control. Priority 1 is now a MEASURED claim, not an
  architectural one.
- GQ Layer-B `behavior` category + PKF-richness grader
  (`src/im/tests/fixtures/golden-behavior.ts`,
  `golden-behavior-questions.test.ts`): question sets + graders whose oracle is
  the daemon tool-sequence ring. The LIVE agent runs of these questions are
  Layer-B debt (see spec §6.11), not landed evidence.

### Changed (memory211/01 §6.9 裁决 4 — sharding threshold 1M → 64K characters)
- `SHARDING_THRESHOLD_BYTES` → `SHARDING_THRESHOLD_CHARS` (`64 * 1024`) in
  `memory-sharding.service.ts`; the plan is computed from the source's EXACT
  character count when T3 chunks are present (bytes as a conservative upper
  bound otherwise), and the per-shard target drops 100K → 48K chars so every
  shard page plus its own prose stays under the 64K page ceiling the daemon
  gate enforces. Ingest task briefs now quote characters, not bytes. Existing
  assets already over the threshold shard on their NEXT index/ingest trigger —
  no backfill sweep.

### Breaking (memory211/01 §6.9 裁决 3 — legacy `cloud memory` CLI removed)
- `cloud memory write|read|list|delete|compact|extract|consolidate|load` is GONE.
  It was the "双 CLI 同名异物" footgun: the same command name as the canonical
  agent-facing memory CLI with different behavior, off the agent path. The
  canonical memory CLI is the RUNTIME one — `prismer memory …`
  (`sdk/prismer/src/cli/commands/memory.ts` → local daemon, local-first). The
  underlying `/api/im/memory/files` HTTP route and the `client.im.memory.*` SDK
  methods are UNCHANGED (benchmark scripts, e2e fixtures and the SDK surface
  still consume them) — only the command surface is removed.
- `cloud recall` is unaffected (it always lived in `cli.ts`).
- `catalog/skills/memory/SKILL.md` regenerated for the new recall loop
  (three-stage protocol / navigation fallback / batch / tier / 64K sharding).

### Added (memory211/01 W5 轴G — section-level curation surface)
- Cloud memory API: `POST /api/im/memory/pages/:id/sections/merge`,
  `POST /api/im/memory/pages/:id/sections/supersede` and
  `POST /api/im/memory/links/rewire` (orchestrator-only, `api.write` rate
  class). `section_merge` folds a near-duplicate section into a winner section
  and lands BOTH `supersedes` and `derived-from` section-anchored provenance
  edges in the same transaction as the content splice.

### Changed
- `@prismer/runtime`'s memory tool schema is now generated from one source (the
  frozen TS spec); the Hermes plugin loads the generated artifact at runtime and
  the CLI gained the section-curation subcommands. See the runtime CHANGELOG.

### Added (metric read surface, B-P1d)
- `MetricsClient.events()` (GET `/api/im/metrics/events`) and
  `MetricsClient.turnSummary()` (GET `/api/im/metrics/turns`), plus the typed
  `TurnMetricsSummary` / `MetricEventsResponse` contracts. The summary field
  names mirror `src/im/services/metric-turns.service.ts` verbatim — additive
  only — with `null` meaning "no rows in the window".
- CLI: `cloud metric events <ns>.<name> --filter workspaceId:<id> [--range Nh|Nd]
  [--limit N] [--json]` for provenance drill-down into the rows behind an
  aggregate, and `cloud metric turns --scope conversation|task|agent --id <id>
  --filter workspaceId:<id> [--range Nh|Nd] [--json]` for the scoped turn
  summary. Human output is kv lines with `∅` for absent metrics; `--json`
  emits the raw response.

- Aligned package metadata with monorepo version `2.2.40` for the
  immutable sandbox/runtime release coordinate; no registry publication is
  implied.

- Aligned Cloud SDK package metadata with monorepo version `2.2.39` for the
  immutable sandbox/runtime release coordinate; no registry publication is
  implied.

- Promoted canonical `remotion` into the common Agent baseline and tightened
  its Prismer-native render/delivery contract, deterministic asset guidance,
  CLI version/composition checks, writable sandbox npm-cache handling, browser
  compatibility boundaries, and adjacent-frame media verification.

- Built-in skill catalog copy for `pkf-writing` now stays under the runtime
  prompt budget while preserving the carrier, validation, and Memory handoff
  contract exposed through Cloud.

### Fixed (image generation delivery)
- Replaced the `image-generate` skill's hand-written multipart upload and
  ContentBlock prose recipe with a bundled `generate-and-deliver.mjs` helper.
  Agents now execute one command and return a caption while Runtime owns the
  structured attachment. The Image Prompt Engineer role follows the same
  boundary and no longer asks the model to serialize attachment JSON.
- The helper now keeps discovered model size capabilities, rejects unsupported
  sizes before generation, defaults output into the dispatch artifacts
  directory, and distinguishes an offline HTTP 202 queue receipt from a
  completed attachment. The delivery proxy preserves queued/outbox metadata
  and `ridesReply:false`, so an archived-but-unattached asset is never reported
  as attached.

### Fixed (role execution safety and baseline policy)
- Role Builder's one-command harness now redacts `--secret=value` diagnostics,
  accepts remote-write authority only from trusted environment policy, and uses
  a fresh invocation identity unless `PRISMER_REQUEST_ID` explicitly resumes an
  interrupted run.
- Role/Skill authoring guidance now separates role-declared business skills
  from the Admin-managed mandatory Built-in Skill baseline.

### Fixed (authoring lifecycle closure)
- Added the documented Cloud CLI authoring surface: `cloud skill create`,
  owner-scoped `cloud skill mine`, private-aware `skill show --content`, role
  directory create, read-only `cloud role test`, and `cloud role edit`.
- SS-01 bundle parsing now accepts YAML literal/folded block scalars and applies
  a language-aware description quality floor, preserving concise CJK upstream
  skills without source rewrites or filler.
- `skill-creator` / `skill-builder` / `role-builder` now guide batch imports
  through canonical-slug ledgers and read-only verification instead of raw API
  probes or applying a role to the running agent.

### Added (runtime210/06)
- `cloud task create --kr <keyResultId> [--objective <id>]` — link a task to an OKR Key Result (same workspace enforced; acceptance progress feeds KR recompute).
- TaskStatus nine-state mirror: `blocked` / `awaiting_approval` added to types, transition unions, `parseTaskStatus` runtime set, tasks SKILL.md lifecycle, and im-tasks.yaml enum（claimed 删除、assigned/review 补齐）.
- Closed the PKF→Memory carrier handoff in the canonical `memory` and
  `memory-dream` skills: PKF is explicitly a format rather than a carrier;
  validated message-inline PKF automatically enters Runtime post-turn durable
  classification, while exact authoritative bytes still use the explicit
  `cloud pkf materialize` Memory target. New automatic topics and confirmed
  exact-copy reports are classified hubs, not orphan leaves. Dream is bounded
  to authoritative Memory Pages, documents the Cloud-scheduler → appointed-
  orchestrator trigger chain and graph-derived INDEX Contents, and refuses to
  report degraded/no-op curation as success.

- Hardened `pkf-writing` against execution-surface drift: native PKF names are
  explicitly function-call tools, not terminal commands; the command matrix
  contains only working Cloud CLI operations and removes unwired lifecycle
  claims. Chat article/report requests default to message-inline PKF unless the
  user explicitly asks for a downloadable Asset or Memory Page, and the skill
  forbids PATH probing or ad-hoc Python validators.

- Canonicalized the Visual Core authoring discipline as the common `pkf-svg`
  skill; `pkf-visual` is now a hidden compatibility alias instead of a second
  catalog directory. The single-file skill owns controlled SVG/widget safety,
  accessibility, semantic color and geometry, including the 680×480 three-level
  topology quality floor and bounded-context color exception. It explicitly
  preserves the production boundary: PKF v1.1 has no inline SVG authoring
  surface, so PKF diagrams remain Mermaid and charts remain d3. Added the
  `gen:pkf-svg-skill` generator/TAMPER gate, common/default install tier, coding
  allowlist, alias delivery, bundle parity and fallback coverage.

- Reworked `pkf-writing` around three explicit carriers: message-inline PKF
  extracted through the unique `prismer-pkf:inline` sentinel pair, Library
  `.pkf` Assets, and Memory Pages. Each carrier now names its authority,
  validation, persistence, readback and Markdown-projection contract; visual
  craft delegates to `pkf-svg` with an honest Mermaid/d3/static fallback.

- `pkf-writing` skill WP1 capability guidance revised v4 (product209/19,
  2026-08-17 architecture round): diagrams ARE mermaid-authored now —
  `<prismer-diagram>` is the single diagram element (themes follow the page
  presentation profile + light/dark), there is NO raw inline-SVG authoring
  surface, data charts are d3-driven, and 3D is static-frame only (WebGL
  temporarily off). Generator gates flipped: must-teach `<prismer-diagram>` +
  must-not-teach `<prismer-svg>` (authoring tag only — negation clauses
  stay valid); TAMPER control still red on all four faults.

- `pkf-writing` skill WP1 capability guidance revised v3 (product209/19,
  2026-08-16): AUTHORING mermaid stays removed (structure diagrams =
  hand-written `<prismer-svg>`), but the skill now documents the mermaid
  IMPORT round-trip — mermaid fences arriving inside imported markdown are
  preserved and rendered automatically (serialization lifts them, projection
  restores the fence); agents never author mermaid themselves. The no-mermaid
  gate is unchanged (positive authoring shapes only) and keeps passing on
  this negation-clause wording; TAMPER control still red on all four faults.

- `pkf-writing` skill WP1 capability guidance revised v2 (product209/19,
  2026-08-16 user ruling): mermaid guidance REMOVED entirely — ER/schema/
  flow/org structure diagrams are hand-written `<prismer-svg>` structure
  diagrams (defs/marker arrowheads, gradients, transforms, tspan, internal
  url(#id) refs); added `<prismer-model format="primitives">` 3D declarative
  scenes (three.js lazy chunk, static isometric degrade frame). The generator
  gains a no-mermaid gate (positive-teaching shapes only; negation clauses
  like "NEVER use mermaid" stay valid), mirrored in
  `sdk/prismer/test/pkf-writing-skill.test.ts` with its own negative control.

- `pkf-writing` skill single-filed (product209/19 WP2): the six references
  (core-format / semantic-html / media-data / math / interactive / validation)
  are merged into one SKILL.md under the < 180 line budget, with the WP1
  content-capability guidance (prismer-svg whitelist / chart-bar|line|pie
  views / AI-image channel) pointing at `src/lib/pkf/examples.ts`. Generated
  by `sdk/cloud/scripts/gen-pkf-writing-skill.ts` (audits line budget +
  command matrix + single-file contract before writing); the references/
  directory is gone and the runtime built-in-skills mirror follows the
  catalog.

- Canonical `pkf-writing` built-in skill (product209/15 PKF-C1): the single
  authoring-knowledge home for PKF (frontmatter/sections/typed links/media/
  data/math/harness + validation/projection/export). `memory`/`memory-dream`
  reference it; coding-agent allowlist installs it.

- `cloud pkf checkout/status/normalize` remain typed placeholders for the
  registry-backed daemon lifecycle and intentionally return non-zero; they are
  not taught as usable workflow commands. `commit` is a stateless shell command
  with explicit base flags from an independently obtained checkout receipt,
  posting final bytes through the carrier CAS (`POST /api/im/pkf/commit`).
- Memory authority snapshot types (product209/16 MA-1B, Task 10):
  `RuntimeConfigBundle` gains the optional `memoryAuthority` field
  (`MemoryAuthoritySnapshotBundleV1` — server-derived actor rows, 60m
  lease, snapshotHash covering the canonical body and therefore
  `configVersion`). Absent ⇒ legacy bundle: the daemon mints no cap v2
  and agent Memory RPC fails closed. Mirror kept in sync with
  @prismer/runtime and @prismer/aip-sdk.

- `cloud pkf render <file> --to html|pdf --theme <profile>` (product209/15
  PKF-E2): deterministic standalone HTML export (no bearer/presigned/API URLs,
  interactive → static fallback, math via pinned KaTeX) and an A4 PDF via the
  optional headless-Chromium adapter (playwright, resolved at run time — typed
  error when absent). No Cloud render endpoint/job exists.

- `cloud pkf validate <file|-> [--level structure|resolved] [--manifest] [--json]`,
  `cloud pkf inspect`, `cloud pkf project --to markdown` (product209/15 PKF-D3):
  exit-code contract 0/1/2 (structure pass / fail / resolved unverified),
  validation failure is a business result — never a transport error. Fully
  offline; the CLI never depends on the Cloud `/api/im/pkf/validate` route.

- `cloud pkf pack-harness <dir> --out <dir>` (product209/15 PKF-F1): packs a
  harness bundle into a deterministic manifest with REAL sha256 SRI, rejecting
  symlinks (entries and root), path traversal, remote imports, forbidden
  directories, oversize JS (1 MiB) and oversize bundles (4 MiB). Offline;
  packed manifests pass the core `validateHarnessManifest`.

- PKF public seam (product209/15 PKF-D2): new `@prismer/sdk/pkf` subpath
  re-exporting the frozen `@prismer/pkf-core` surface (parse / validate /
  two-phase `verifyPkfResources` / v1.1 constants / budgets). The core is
  BUNDLED into the subpath at build time via a hash-verified staged copy
  (`sdk/build/stage-pkf-core.cjs`) — the published tarball carries no
  `file:`/link dependency, no monorepo source path and no unresolved
  `@prismer/pkf-core` import. Ships `dist/pkf-schema.json` (v1.1 frontmatter
  JSON Schema) alongside `dist/pkf.{js,mjs,d.ts}`.

- `cloud approval request-human` gained `--target <kv...>`: parsed into
  `metadata.target` (`--target sha256=<v> storageKey=<k>`), the exact binding
  the server-side approval gate (`approval-gate.ts` `targetMatches`) consumes
  to scope an `ota_rollout`/gated approval to concrete artifact bytes. Absent
  the flag the metadata shape stays the legacy `{ risk, source }` for existing
  callers.
- Consolidated the Remotion catalog into one self-contained `remotion` skill;
  the former short topic references now live directly in `SKILL.md`. Historical
  slugs remain hidden compatibility aliases so persisted skill IDs and explicit
  old-slug calls continue resolving without reappearing as separate catalog
  capabilities.
- Runtime OTA packaging now installs the exact Cloud SDK tarball built from the
  checkout. A dedicated committed dependency lock supplies every external
  Cloud dependency, all of them are physically bundled, and the AIP dependency
  is built from its own committed lock in the same checkout instead of being
  resolved from the npm registry.
- ConfigDelivery P1: RuntimeConfigBundle protocol types synced from
  `@prismer/runtime` for cloud SDK consumers. Design:
  docs/product209/07-config-delivery-runtime-bootstrap.md §3.3.

### Changed (BREAKING) — workspace-scoped Agent Registry discovery

- Agent-specific discovery now uses `AgentsClient.discover()` and
  `GET /api/im/agents?workspaceId=...`; requested workspaces are membership
  checked and invalid or outsider scopes fail closed with HTTP 404.
- `cloud discover`, `cloud im discover`, top-level
  `cloud send --by-username`, and task `--assignee-name` resolution now require
  `--workspace-id` or `PRISMER_WORKSPACE_ID`. Matching uses the AgentCard
  `userId`, `username`, and `name` fields.
- `ContactsClient.discover()` and `/api/im/discover` remain the human/contact
  discovery contract, including nested `cloud im send --by-username`.

## [2.2.5] - 2026-08-02

- Moved the Cloud-owned SDK and CLI into the `sdk/cloud` product root while
  keeping the published package name `@prismer/sdk` unchanged.
- Made `cloud` the canonical Node CLI and removed Cloud imports of Runtime
  internals; Cloud now owns its API request builders and task/workspace flows.
- Aligned the AIP dependency to `^2.2.5` and the unified release matrix to
  npm/PyPI packages that are still actively supported.

### Fixed — `cloud skill test` 拿陈旧跨 run 回复冒充 `completed`（APC gap B）

`skill test` 的成功判据是"DM 会话里 senderId==agent 且 createdAt>afterIso 的回复"。
但 DM 幂等复用 + 跨 run + 回复延迟下，**底层零 run 被创建时它仍抓到跨 run 的陈旧回复**
（env-doctor prompt 返回上一次 bug-reproduce 的 "RED/GREEN"），返回 `taskId:None` 却
`taskStatus:completed`——验证工具自己假绿（apc/11 §0.28 gap ②）。

判绿现 gate 在**真副作用**，两道都过才 `completed`：

- **run 侧效**：本次 dispatch 必须真建 `im_task_runs` 行（`triggerMessageId ===` 本次发出的
  消息 id，`message.service.ts:2649`），经 `GET /api/im/tasks/runs?conversationId=&mine=created`
  轮询。查不到 ⇒ 新失败态 `dispatch_not_created`，永不 `completed`。
- **回复绑定**：回复必须绑定本次 dispatch（`metadata.replyToMessageId ===` 本次消息 id，
  `dispatch-reply.service.ts:335`）。跨 run 陈旧回复带的是别的 trigger id → 拒收，即使时间戳更新。

`no_reply`（建了 run 但无绑定回复）同为失败态。`extractAgentReply` 加第四参
`expectedTriggerMessageId`（强绑定；不传时退回 afterIso 锚，保旧 8 例回归）。新增
`test/skill-test-run-gate.test.ts`（10 例，真 client + scripted fetch）：命根子负控
（零 run + 陈旧回复 → 拒）+ 正控 + 跨 run 隔离 + CLI exit-code oracle；变异回旧逻辑 4 例转红。

### Added — `cloud task meta set --set-string`（sha 保真）

`--set` 会对值做 JSON 推断，于是**全数字的 git sha 被存成数字**：`--set sha=1234567`
存的是 number `1234567`，40 位全数字 sha 存成 `1.2345678901234568e+39`（精度直接毁掉，
不只是类型不对）。7 位短 sha 全数字的概率约 `(10/16)^7 ≈ 3.7%`，而 git-ops provenance
正是这个动词的承重消费者。

新增 `--set-string <key=value...>`：**永不推断**，值原样按字符串写入。`--set` 的既有
JSON 语义不变（`retries=2` 仍是数字）；`--help` 的示例已改用 `--set-string` 写
sha/branch，并显式写明两者的差别。两个选项可同时用，各守各的规则；同名 key 上
`--set-string` 后应用（覆盖 `--set`）。

### Fixed — `cloud git *` 把授权失败渲染成 git 失败

`ApiResponse.error` 是 `string | { code, message }` 两种形态，而 CLI 只读
`res.error?.code`。`workdirs` 路由的 forbidden / 500 分支返回的是**字符串**形态 ⇒
`.code`/`.message` 都是 `undefined`，"你不是这个 workspace 的成员" 被打印成
`Error [git_failed]: git failed`，`--json` 输出 `{"code":"git_failed","message":""}`——
唯一有用的诊断信息 100% 丢失，而且把运维指向 git。

- CLI 现在两种形态都认（`normalizeError`）：字符串形态的错误按 `code:'error'` +
  服务端原文呈现，绝不再冒充 `git_failed`；`git workdirs` 同样修（它的路由仍是字符串形态）。
- 服务端 `POST /workspaces/:wid/workdirs/:id/git` 的 forbidden 分支改回结构化
  `{ code:'forbidden', message }`（HTTP 404 与响应文案不变，workspace id 仍不可枚举）。

新增用例 `test/commands-apc-git-cli.test.ts`（7 例，真 HTTP + 真 commander，
§0.8 记的 "CLI 本体零用例" 欠账的第一笔）。

### Added — `cloud git *`（APC P0-5，S8 git-ops 的 agent 入口）

`git` 命名空间：`workdirs` / `commit` / `branch` / `merge` / `push`。包既有
workdir 面新增的 `POST /api/im/workspaces/:wid/workdirs/:id/git`，链路
`cloud git → cloud GitService → WS reverse-RPC 'agent.git.exec' → daemon
git-rpc.ts`。

- **cwd 不由调用方给** —— 命令只传 `<workdirId>`，cwd 从 `IMWorkdir` 行读，
  daemon 侧再 jail 一次（双层）。
- **`--workspace` / `--daemon` 缺省读 `PRISMER_WORKSPACE_ID` / `PRISMER_DAEMON_ID`**
  （dispatch 注入，`runtime/src/adapters/prismer-env.ts`）。
- **merge 冲突不自动解决**（apc/00 §3 不变量 6）：退出码 1 + 打印冲突文件清单 +
  "escalate to a human"，daemon 侧 worktree 保持现场（不 abort / 不 reset）。
- **prod tag 被拒**：`k8s-prod-*` / `desktop-prod-*` / `prod-*` / `ali-k8s-prod-*`
  在 daemon 侧硬拒（纵深防御；真闸仍是 GitLab protected tags）。
- **push remote 走白名单**（默认只 `origin`，daemon 端 `PRISMER_GIT_REMOTE_ALLOWLIST`
  可放宽）；URL 形态 / option 形态的 remote 一律拒。
- `commit` / `merge` 回 **sha**，供 task↔commit provenance。

### Added — `cloud skill ack` + `cloud task meta set`（APC P0-1 / P0-2）

两个**薄 CLI 动词**，服务端能力全部既有，本次不新增任何 endpoint / 权限面。

- **`cloud skill ack <slug> [--task <id>] [--note <text>]`** —— skill 调用回执
  （[[apc/04-mvp-stages]] §2 层1）。包 `POST /api/im/tasks/:id/event`
  （`im.tasks.postEvent()`），落一行 `im_task_logs`：`action='skill_ack'`，
  metadata `{code:'SKILL_ACK', skillSlug, taskId, agentId?, ts}`。`--task` 缺省读
  `PRISMER_TASK_ID`。
  **两条承重限制写进 `--help`，不粉饰**：(1) 服务端**只允许 task assignee** 发，
  其他人（含 creator/orchestrator）403；(2) **无 task 上下文的 skill 产不出回执**
  （env-doctor、人工 shell、只有 `PRISMER_RUN_ID` 的 chat run）——此时**退出码 3**
  而不是静默 0，缺回执永远不会被当成有回执。
  退出码：`0` 落库 · `1` 请求失败 · `3` 无 task 上下文 · `4` 非 assignee 被拒。
- **`cloud task meta set <task-id> [--set k=v...] [--json-value <json>]`** ——
  task metadata 写入。包既有 `PATCH /api/im/tasks/:id`（服务端已做**顶层**
  shallow-merge）。`--set` 支持点号嵌套路径（`assets.linkedAssetIds=[…]`）：嵌套写
  会**先 GET 当前 metadata 再 deep-set**，否则顶层 merge 会把
  `assets.aggregatedAssetIds` 这类兄弟键整体抹掉（读-改-写**非原子**，并发时后写覆盖）；
  `--json-value` 是原样透传的逃生口，其命名的每个顶层键**整体替换**。
  **承重限制写进 `--help`**：metadata 走 `edit-content` 门 =
  creator / orchestrator / admin / owner，**assignee 不在内** —— provenance 写入
  必须以主 agent 身份跑，coding agent 自写会 403（CLI 对该 403 退出码 `4`）。

### Removed (BREAKING) — `workspaces.revokeOrchestrator()`（用户裁决 2026-07-15）

编排 agent（orchestrator）现在是**平台网络节点**：它持有全网唯一的 AIP 身份（DID）
与平台官方 agent 之间不可解除的 `origin='system'` 好友边——A2A 通信的对端就是它。
**换任 = 换身份 = 断掉全部网络边**，因此「转任」与「撤销」两个动作被判定为不存在，
而非逃生口。

- **`revokeOrchestrator(workspaceId)` 删除**。对应的 `DELETE
  /api/im/workspaces/:id/orchestrator` 服务端返 **409 `ORCHESTRATOR_IMMUTABLE`**。
- **`appointOrchestrator(workspaceId, agentImUserId)` 保留**——**首次任命**合法且必须
  发生（也是「有 agent 但无首席」降级态的自救入口）。已有在任首席时改任**另一个**
  agent → **409 `ORCHESTRATOR_IMMUTABLE`**；重复任命**同一个** agent 仍幂等 no-op。

推翻 `docs/archive/release200/15` §4.3 的「appoint 先 revoke 老的 / DELETE 撤销现任」语义。

### Added — `cloud skill|role` 发布后治理七动词（product204/21 M-P W3）

发布之前有 `publish`，发布之后此前**什么都没有**。补齐镜像动作，`cloud skill` 与
`cloud role` 同构（与 `@prismer/runtime` 的 `prismer skill|role` 逐字一致）：

- **`delist <slug> [--reason]`** / **`relist <slug> [--changelog]`** — 退出/回到
  Marketplace 的**可见性单轴翻转**；存量使用者零影响。relist 复用该资产自己的
  publish 端点（publish 门只有一份实现，admin takedown 因此挡得住 relist）。
- **`deprecate <slug> --reason <r> [--successor <slug>]`** / **`undeprecate`** —
  软信号 + 替代品指针，**不拦截**新安装/新 apply。
- **`archive <slug> [--confirm]`** — 破坏性退役（skill 解绑全部已装 agent）。
  有活跃消费者时 409，CLI 打印消费者计数 + 提示 `--confirm`；public role 直接
  archive 会提示先 `delist`。
- **`transfer <slug> --to <imUserId>`** + **`transfer-accept`** / **`transfer-abort`** —
  两段式所有权转移（offer 阶段 owner 不变）。
- **`published`** — 我的发布清单：slug / 上架状态五态 / **消费者数** / installs /
  在途转让；`--json` 出 `PublishedAssetRow[]`。

**错误码人话化**表与 `@prismer/runtime` **共享同一模块**
（`runtime/src/cli/publish-lifecycle.ts`，build 时内联，零依赖）——两个 CLI 对同
一个 409 永远说同一句话。

> **承重语义**：skill 安装与 role→agent 是**活引用，不是快照**——改已发布件的内容
> 会自动传播到全部使用者（故内容改动强制 `--changelog`）；**下架不影响存量使用者，
> 归档才解绑**。

### Changed — `cloud role create` defaults to the PRIVATE domain（product204/16 §2.2 M5）

**Behavioral flip, no version bump.** 创作默认私域，进公域是显式动作：

- **`cloud role create`** 此前根本没有 `--mine` 选项、永远打 admin 公域路径
  （非 admin 一律失败）。现在默认打 `POST /api/im/role-templates/mine`
  （owner-scoped private，任何已认证 key 可用）；旧行为收敛为显式
  `--admin-catalog`；新增 `--publish`（create 后自动 publish 进 Marketplace）。
- 新增 **`cloud role mine`**（列自己的私有 role）、**`cloud role publish
  <slug>`**（私有 role → 公域 Marketplace）。

### Added — `cloud skill publish` + `cloud role export`（product204/16 §2.2(c) / §2.5）

- **`cloud skill publish <slugOrId> [--license --changelog]`** — 显式 owner 动作，
  把 skill 从私域（`publishScope='workspace'`，create 默认）翻到公域 Marketplace。
  marketplace 搜索面自本版起只见 `publishScope='marketplace'`。
- **`cloud role export <agentImUserId> [--out <dir>] [--ingest]`** — 把活 agent
  的人格晶化为 role bundle（SOUL 取 RAW operatingPrinciples，无运行时注入子句，
  round-trip 不堆叠）；`--ingest` 直接落私有 role（`/mine`）。

### Deprecated — legacy SDK-side `cloud memory` CLI quarantined (memory203/13 decision D, P6)

- **`commands/memory.ts`** is the OLD flat `cloud memory write --scope/--path/--content`
  shape that talks to cloud HTTP directly via `PrismerClient` — the "双 CLI 同名异物".
  It is NOT the agent path: the `memory` SKILL.md (`cloud memory write/recall/read/
  list/curate`) resolves to the **runtime** CLI (`sdk/prismer-cloud/runtime/src/cli/
  commands/memory.ts` → local daemon, local-first), since the `cloud` bin ships from
  the runtime package. To stop anyone editing the wrong one, this command is now
  **quarantined, not removed**: a top-of-file deprecation banner, a `@deprecated` tag
  on `register()` + the cli.ts registration site, a `[deprecated …]` command
  description, and a once-per-process `console.warn` notice (Commander `preAction`
  hook) pointing to the runtime CLI. **Behavior is unchanged** — the command still
  works and `test/commands-memory.test.ts` still passes; no consumer breaks.

### Changed — Hermes `cloud deliver` no longer requires `--run-id` (release203/15c WS-E3)

- **`detectDeliverProxy()` (`commands/deliver-proxy.ts`)** — when NO run/task id
  is resolvable from flag OR env but the agent identity IS present
  (`PRISMER_AGENT_IM_USER_ID` + `PRISMER_DAEMON_PORT` — the hermes case), the
  proxy now activates with `resolveActiveDispatch:true` (empty taskId) instead
  of returning null. `proxyDeliver()` body carries `agentImUserId` /
  `agentUsername` / `resolveActiveDispatch` so the daemon reverse-looks-up the
  agent's CURRENT in-flight dispatch. **An explicit `--run-id` still WINS** (it
  takes the concrete-taskId branch and skips the lookup). `DeliverProxyContext`
  gains `agentImUserId?` / `resolveActiveDispatch?`.
- **`cloud deliver` / `cloud attach` error text** updated: from "On hermes, pass
  --run-id …" to "常态下不传时 daemon 会自动解析你当前的 dispatch；仅跨 dispatch 或
  daemon 报 409 歧义时才传 --run-id". The `--run-id` / `--conversation-id` flags
  remain (explicit cross-dispatch override).

### Added — `cloud skill validate|package|test` + `cloud role validate` (close skill→cloud contract drift, release203/15 WS-E4 §7.3 "C")

- Built-in SKILL.md (`skill-creator`, `skill-authoring`, `role-builder`)
  instructs agents to run `cloud skill validate|package|test` and `cloud role
  validate`, but those verbs existed **only** in the `prismer` (runtime) CLI.
  Agents run `cloud` (the sandbox has no `prismer`), so following the skills
  failed. `regress-skill-cli-contract.ts` was FAILing with 6 NEW drift items;
  this adds the 4 missing verbs to the agent-facing `cloud` CLI so the gate is
  green AND agents can actually run them.
- **`cloud skill validate <bundleDir>`** / **`cloud skill package <bundleDir>
  [-o <out>]`** — pure-local (no network), mirroring `prismer skill
  validate|package`: SKILL.md frontmatter/slug/category validation, then a
  deterministic `.tar.gz` + merkle revision (byte-identical to cloud
  `src/im/skills/manifest.ts`). Exit 1 on invalid.
- **`cloud skill test <bundleDir> --agent <imUserId> [--timeout-ms]`** —
  dispatches each `skill.json` `sampleTasks[].prompt` over the **chat path**
  (create DM → send message → poll for the agent reply) and scores
  `acceptanceCriteria[]`, mirroring runtime/skill.ts. NOT the task-API path
  (Hermes rejects conversation-less tasks + can't write task results back, see
  release203/19 §A). Per-criterion PASS/FAIL table; exit 1 when a required
  criterion misses or the run times out.
- **`cloud role validate <pathOrDir>`** — pure-local, accepts a single
  `role.json` OR a role bundle dir (`role.json` + optional `SOUL.md` →
  `operatingPrinciples`, release203/16 P4). Exit 1 on invalid.
- The pure-local validate/package/role-validate logic reuses the shared SS-01
  bundle library (`runtime/src/bundle/index.ts`) imported via a build-time
  relative path — no npm dependency edge; `tsup` inlines it into `dist/cli.js`
  (verified: no runtime `require` of `@prismer/runtime`; the bundle fns are
  inlined). `regress-skill-cli-contract.ts`: **0 NEW drift** (the 6 items
  resolve, self-test still has teeth); `tsc --noEmit` clean in both `typescript`
  and `runtime`. No existing runtime command files were modified. Plan:
  `docs/release203/15b-shared-builder-plan.md`, contract `docs/release203/15-*`.

### Changed — `cloud workspace member` shares its list/add/update/remove logic with `prismer` (release203/15b WS-E4 §7.3 "B")

- The `cloud workspace member` verbs (list/add/update/remove), previously
  duplicated verbatim against `prismer workspace member`, now call the shared
  `buildWorkspaceMemberCommand(adapter)` from `@prismer/runtime`'s
  `src/cli/shared/workspace-member-builder.ts`. `cloud` injects a
  `PrismerClient.workspaces.members` + padded-text adapter. The role contract
  (`admin|member`; `owner` rejected, release201/16 §5.2) and the remove cascade
  now live in one place. No npm dependency edge — the builder is imported via a
  build-time relative path and `tsup` inlines it into `dist/cli.js` (verified: no
  runtime `require` of `@prismer/runtime`). Behaviour unchanged: success output +
  `--user`/`--role` flags preserved (the shared `add` also accepts a positional
  imUserId, additive). `regress-skill-cli-contract.ts`: no new drift (workspace
  subcommands resolve via the followed builder import); `regress-cloud-task-wait.ts`
  4/4. Plan: `docs/release203/15b-shared-builder-plan.md`.

### Changed — `cloud task wait` shares its poll/settle logic with `prismer` (release203/15 WS-E4 §7.3 "B")

- The `cloud task wait` settle loop, previously duplicated verbatim against
  `prismer task wait`, now calls the shared `buildTaskWaitCommand(adapter)` from
  `@prismer/runtime`'s `src/cli/shared/task-wait-builder.ts`. `cloud` injects a
  `PrismerClient.im` + text-output adapter; the settle contract (review/
  completed/failed/cancelled by default, `--terminal-only`, failed/cancelled →
  non-zero exit) now lives in one place, so a future change lands once. No npm
  dependency edge is added — the builder is imported via a build-time relative
  path and `tsup` inlines it into `dist/cli.js` (verified: no runtime `require`
  of `@prismer/runtime`). Behaviour unchanged; `regress-cloud-task-wait.ts` 4/4
  + `regress-skill-cli-contract.ts` green. Plan:
  `docs/release203/15b-shared-builder-plan.md`.

### Added — `cloud okr|role|conversation|quote|pay` (release203/15 §WS-E4)

- **Five namespaces ported from the `prismer` (daemon) CLI to `cloud`** so the
  agent-facing skills that reference them resolve (the skill→cloud contract gate
  flagged them as agent-breaking drift — agents run `cloud`, not `prismer`):
  `okr` (objective/kr/pack/link/insights), `role` (create/apply/list/show),
  `conversation` (history/search/resolve-identifier/summary), `quote` (read),
  `pay` (create/status). Each reuses the existing `/api/im/*` endpoints (no new
  endpoints) via `client.im.request`, with cloud-CLI output conventions. Gate:
  `regress-skill-cli-contract.ts` now green with these resolved.

### Added — `cloud task wait <id>` (release203/15 §WS-E2/E4)

- **`cloud task wait <taskId>`** — agent-facing parity with `prismer task wait`.
  Block until an ALREADY-delegated task settles, then print it: the
  orchestrator's "delegate → wait → act on the result" primitive that the
  `tasks`/`agent-coordination` skills point agents to. Settles on
  `review/completed/failed/cancelled` by default (`review` included — for a
  delegated task it means "assignee finished, awaiting YOUR approval", so
  blocking until `completed` would deadlock the orchestrator that must approve);
  `--terminal-only` for strict terminal; exits non-zero on failed/cancelled.
  Closes a `prismer` vs `cloud` CLI drift (WS-E4): the wait primitive existed
  only on `prismer task` but the skills reference `cloud task`. Gate:
  `regress-cloud-task-wait.ts` runs BOTH CLIs against the live API.

### Added — OfflineManager follows the unified single-WS realtime (release203/12)

- **`OfflineManager` continuous sync now prefers ONE WebSocket** (`WS /ws/realtime`)
  over the legacy `/api/im/sync/stream` SSE. The unified WS multiplexes the
  sync + tasks channels; the offline sync consumes the `{ch:'sync',name:'sync'}`
  frames exactly as it consumed SSE `sync` events (same `applySyncEvent`, same
  `global_sync` cursor, same `sync.start`/`progress`/`complete`/`error` events) —
  transport-only change, 2 sockets → 1. Backfill control (`sync.backfill.truncated`
  /`done`) advances the cursor to the high-water mark (no replay storm).
- New `OfflineConfig.unifiedWs` (default `true`) pins the transport — set `false`
  to keep SSE behind a proxy that doesn't pass WS upgrades. New
  `OfflineConfig.WebSocket` injects a WS ctor (Node <21 / tests); falls back to
  the global `WebSocket`, then SSE, then polling when none is available.
- **`IMRealtimeClient.subscribeTaskEvents` now defaults to the unified WS**
  (`ch:'tasks'`) instead of the `/api/im/tasks/events` SSE. Same
  `{ type, payload }` envelopes (no per-event `id` on the WS). New
  `options.unifiedWs` (default `true`) + `options.WebSocket` injection; pass
  `unifiedWs:false` for the SSE path (the only one with `Last-Event-ID` replay).

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
