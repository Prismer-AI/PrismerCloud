# Changelog — @prismer/runtime

## 2.2.62 — 2026-09-23

- **Session recall + grant-aware recall policy**：daemon 新增
  `recall-policy-provider` / `session-recall`（会话记忆召回并入
  `[Memory Context]` 的 `[Session Recall]` 段，保留 `via:'grant:<id>'` /
  `sourceWorkspaceId` 授权来源标注）+ fallback 集成测试。
- **Skill availability / loader / sync 收紧**：`skill-availability` 独立模块、
  skill loader/source-resolution/sync 扩展与 sync rejection、slash 平台
  toolsets 测试加固。
- **Hermes native skill projection**：`native-skill-projection`（Hermes 原生
  skill 装载投影）+ 投影测试。
- **Turn protocol/runner 扩展** 与 pi components manifest
  （`eaas-pi-components.manifest.json`）。
- 镜像/载荷对齐：Hermes v2026.9.21（S6 commentary 交付门），
  `infra/sandbox-image` 与 desktop engine payload 同步（本包不进 image
  fingerprint，随 OTA bundle 分发）。

## 2.2.13 — 2026-08-17

- ACS boot recovery fixes (merged via fix/acs-boot-recovery): manifest Pod
  reachability base, Dockerfile Hermes install retry on China egress,
  canonical millisecond ISO timestamps in the sandbox manager, runner empty
  adoption storm guard, and dev-local stream + reclaim.
- Runtime version bumped 2.2.12 → 2.2.13 because daemon sources changed
  since the 2.2.12 GA publish (immutable content-addressed releases).

## Unreleased

- Sandbox manager executes directly when already running as the target non-root
  user, retaining sudo for cross-user launches. Restricted EaaS carriers use
  image-prepared workspace, recipe and manager state directories without privilege escalation.

- Add a scoped `asset-ingest` maintenance envelope to the one-shot turn runner:
  exact task/run/source binding, no chat history or tool grants, and bounded,
  digest-checked semantic products. Advertise `maintenance.assetIngest: 1` in
  turn capabilities. Cloud admission/egress and final installed-bundle acceptance
  remain required; a synthetic engine test is not provider execution evidence.

- EaaS one-shot turns now seed validated conversation history into the real PI session, preserving principal images and assistant text without replaying historical tool calls. Previously the envelope history was ignored.
- Add `turn capabilities` for explicit Cloud compatibility checks, and enforce shared history/image count and decoded-byte limits. Old bundles must not silently accept history-aware turns.
- Local Runtime regression is recorded separately from signed-bundle deployment and real two-turn model acceptance; the latter remain required before release.

### EaaS PI core HITL guidance and tool policy

- Preserve the Cloud system prompt and add EaaS-only HITL `eaas-question`
  guidance and ACL boundary instructions; prompt guidance is not authorization.
- Add a PI core execution gate for bound tools: deny takes precedence, an empty
  allow list denies all tools, and an optional trusted-host `authorize` callback
  permits execution only on `true`, failing closed on errors.
- Wire EaaS turn tool declarations into the runner's allow/deny policy, including
  explicitly disabled tools. Absent declarations retain legacy default tools;
  an explicit empty declaration list allows none.
- These declarations are a per-turn snapshot, not a dynamic Cloud ACL/HITL
  bridge. Allowing bash does not enforce a cwd jail or make the environment
  read-only when write/edit tools are denied.

### Workspace conversation/task overhaul — spec 11 closure

- **Runs dispatch durability**：daemon 派发链完成 spec 11 T3/T4 收口——comment
  续跑、Phase A 判型闸、一次性 nonce、run 级 dispatch outbox 重投、10 次重试预算与
  `dispatch-undelivered` 终态可见性，避免 run 已生成但 chat 侧静默丢派发。
- **Hermes/tool attribution honesty**：缺失 `detail.output` 的工具步骤不再渲染为空白，
  统一显示 `[output not forwarded]`；有真实 output 的步骤保持原样。
- **Org collaboration soul carrier**：内置身份上下文新增 `org-collaboration` section，
  `team-manager` 升级到 2.2.0、`personal-assistant` 升级到 1.1.0，并保持 catalog /
  runtime role template / source role template 三处 byte-identical。
- **Task context for OKR execution**：dispatch context 新增 `[Active Key Results]`，
  与 `[Active Goals]` / `[Active Objectives]` 同源注入，用于长线任务的 KR
  baseline/target/current 验收依据。
- **Grant-aware memory recall**：runtime `memory_search` / `memory_load` 接受
  `sourceWorkspaceId`，session recall 可将授权来源并入 `[Memory Context]` 的
  `[Session Recall]` 段，并保留 `via:'grant:<id>'` / `sourceWorkspaceId` 标注。

### Hermes — S5 上下文连续性三件（docs/organization/specs/05 Task 1-3，daemon 侧）

- **轮换播种回读（§3.4-1a / Task 1）**：`sessions-dispatcher` 抽出
  `fetchSessionTranscript`（`GET /api/sessions/{id}/messages`，保留
  `X-Hermes-Session-Key` + 5s `AbortSignal.timeout`，任何失败 resolve `[]`），
  由抢救捞回与轮换播种共用。轮换铸新 session 且存在 previousSessionId 时回读老
  transcript 尾部（`RESEED_TAIL_ROWS=8`），并入 FULL seed：行序**原样透传**——
  `order=latest` 是「从最新往回取页、按插入序返回」（v2026.9.14
  `hermes_state_messages.py:779` + `:817-818`），读到的本就是时间序，不得再翻
  （评审 N-1：此前多翻一次，超帽时反而丢最新、留最老，恰是 A1/A2）。单行截断
  `RESEED_ROW_CHAR_CAP=1500`、总量 `RESEED_TOTAL_CHAR_CAP=6000`（超帽自最老行起丢）、
  与 envelope `recent` 去重（normalize 后各取前 120 字符做**相等**比较——评审 I-1：
  双向前缀匹配会让一条短行吞掉同头的长行，白丢真实交换）。
  `context-render` 新增可选 `HermesRenderOptions.transcriptTail`，以
  `sender='transcript_continuity'` / `senderRole='system'` 追加进 `priorMessages`
  （composer 按 createdAt 排序，天然落在压缩段之后、recent 之前，无需手工
  unshift）；envelope 路径与 legacy `composeConversationContextXml` 路径均已透传。
  首 turn（无映射）不回读，不额外发请求。
- **复用路径周期性对账（§3.4-1b / Task 2）**：新增 `cloud-io.ts` 窄 IO seam
  （`setHermesCloudIO`/`getHermesCloudIO`，照 `setHermesSessionMapper` 先例，
  runner.ts 启动接线、shutdown 摘除；未接线时全部降级为静默 no-op）。每个复用
  turn 终态后 fire-and-forget 对账：`%5` turn 且距上次 ≥30min 双护栏限频，取
  本会话最后一条**本 agent 发的** `metadata.kind='agent_reply'`（`senderId ===
  agentImUserId`，评审 I-3：多 agent 会话里锚他 agent 的 turn 会报出本 transcript
  从未有过的「错位」，白付轮换 + 误导通知）的 `taskId` 作 anchor，要求它出现
  在 transcript 的某条 user row 中且其后存在非空 assistant row。错位 → 发一条
  `context_continuity_reconciled` `system_event`（`session:anchor` 键 100 条 LRU
  保证恰好一次）+ invalidate 映射。**并对账的补种链闭合**：invalidate 会 DELETE
  映射行、使下一 turn 与「首 turn」不可区分，故错位时先把被弃 session 停靠进
  `pendingReseedSources`（按 conversation+agent 稳定键），下一 dispatch 一次性消费
  ——补种回读与可见性事件因此都不断链。
- **抢救 anchor 校验（§3.4-2 / Task 3）**：`recoverReplyFromSessionTail` 捞回的
  assistant 行须同时满足三条才采用：归属 anchor（anchorIdx 扫描已保证，显式化）、
  anchorIdx 与捞回行之间无**其他** per-turn anchor 的 user row（防跨 turn 交叉
  落盘）、捞回行 timestamp 不早于 anchor 行（唯一能抓「上一轮被杀 attempt 的答案
  晚落盘在本轮 anchor 行之后」的判别——晚到答案生成于上一轮，timestamp 必然更早）。
  任一不过 → 返回 null 并 `stderr` 记 `recovery rejected:`，交给既有 loud
  `empty_reply` 失败路径（宁空失败，不冒充本轮回复）；timestamp 缺失时降级为只查
  前两条并在 stderr 记 `recovery_anchor_ts_missing`（可观测降级，不因缺证据拒绝）。
- 三条路径全部 fire-and-forget：失败 log/stderr 留痕后吞掉，绝不向主流程抛错、
  不阻断派发（负控已固化）。零 DB 迁移、无 wire 协议变更、无
  daemon↔cloud 版本协商需求（seam 未接线 / 老 cloud + 新 daemon 均安全降级）。
- 测试：新增 `sessions-dispatcher-transcript-reseed`（轮换播种正例 + 首 turn 不回读
  + 去重 + caps + 读失败负控 + **envelope 路径正例**——补上生产路径此前无正例的
  覆盖缺口，删掉 :1270 的透传该用例即红、其余全绿）、`sessions-reconciliation`
  （错位恰好一次 + 对齐零调用 + N/间隔门 + seam 未接线 + 云调用失败吞错）。
  `sessions-dispatcher-empty-reply` 追加 recovery anchor 校验组（晚到答案拒绝 /
  本轮晚落盘照常采用 / 异锚插入拒绝 / 无 timestamp 降级留痕）。
- 既有 immutable-release 规则下版本号 bump 与否由发版时判定。

### Hermes — S5 压缩可观测 / 轮换可见性 / skill-sync 错峰（docs/organization/specs/05 Task 5-9，daemon 侧）

- **压缩静默失败可观测（§3.4-3b / Task 5）**：`runBackgroundCompaction` 的四处**真
  失败**——candidate GET 非 2xx / `compactSlice` 返回 `result.error` / projection 空
  / segment POST 非 2xx——除既有 `traceLog` 外，现在还会 bump
  `MemoryStageCounters.compactionFailed`（新增计数位，随 `/healthz`
  `memory.counters` 暴露）。三处**正常门**（`no_conversation_id` / 历史不足
  `COMPACTION_MIN_HISTORY` / `%N` 轮询门）保持 log-only，不计入失败位——门不是失败。
  有 run 归属时另经既有 run/task event 通道 fire-and-forget 上云
  （`type=COMPACTION_FAILED`、`payload.stage`），上报失败只 log 不再造失败。
  **落点（T1-2b R1 修正）**：首版打的是 `POST /api/im/tasks/:id/event`，而
  `ctx.taskId` 实际是**本轮派发的 run id**（registry `canonicalTurnId` = 线上
  run id）——该路由是 task 作用域、拿 id 查 `im_tasks`，对 run id 空间回
  `400 RUN_ID_ON_TASK_ROUTE`，又被 best-effort 的 catch 吞掉 ⇒ durable 上报在产
  是**静默 no-op**，只有本地计数位真的动。现改投 run 作用域
  `POST /api/im/runs/:runId/events`（assignee 经 `checkRunReadAccess`），
  **仅**在该请求回 404 时重试一次 task 作用域路由——id 空间本就是双义的
  （release202/09 §3.2：chat 派发带 run id、kanban task 派发带 task id、legacy run
  保留裸 cuid），404 是它唯一的信号；非 404（403 身份 / 5xx / 不可达）不重试。
- **轮换可见性 + FULL seed 诚实声明（§3.4-4a / §3.4-7 / Task 6+9）**：凡「铸新
  session 且存在前一个 session」的轮换面（404 `session_not_found` 重入 / S10 空回复
  轮换 / interrupt / 对账补种），fire-and-forget 发一条 `system_event`，文案统一为
  诚实状态声明「上下文窗口已重建：更早的对话内容已按摘要保留，最近的交流已重新
  载入。如有需要请提醒我补充关键背景。」，metadata 统一
  `{kind:'context_rebuilt', reason, previousSessionId, reseededRows}`（
  `reseededRows` 为 Task 1 实际回读注入行数，无回读诚实为 0）。此前轮换完全静默：
  agent 丢了 transcript、cloud 按摘要重建，用户只看到「回复不再引用上文」。
  seam 未接线（`setHermesCloudIO(null)`）→ 静默跳过，不向派发抛错。
- **skill-sync 杀 gateway 错峰（§3.4-4b / Task 6）**：上游 gateway route 表无
  skill reload/rescan（catalog 只在 spawn 时扫），真热重载属上游改动。新增
  `HermesService.busy`（`currentRunId !== undefined`，run 终态 `finally` 必清）与
  `respawnHermesGatewayAfterSkillSync`：空闲照旧 atomic invalidate + 杀 gateway；
  **有在飞 run 则推迟**——`markSkillDirty` 重新置脏位、交由下次 dispatch
  （`consumeSkillDirty`）消费，本轮继续用现 gateway（新 skill 本轮不可见，优于杀在飞
  run 并让该 profile 全部 session 集体失联）。无 `markSkillDirty` seam 时不静默丢
  改动：stderr 告警后照旧杀（退回 S5 前行为）。`DispatchDeps` 新增
  `markSkillDirty` / `peekServiceBusy`，runner 两处 dep bag 均已接线。

### Hermes — 空回复轮换阈值 1→2 + 首次空回复可见（spec 11 / T1-3，daemon 侧）

- `session-health`：`EMPTY_ROTATE_THRESHOLD` 默认 **1 → 2**——首次 `empty_reply`
  不再轮换，连续第二次才在下一 turn 铸新 hermes session。2.2.9 的「一次即轮换」
  建立在「hermes 只在可恢复但为空时才 EMPTY」这一假设上，生产事实相反：首次
  EMPTY 常是上游瞬断（provider 流中断、网关冷启动），照旧语义立即轮换会丢掉一个
  下一轮本可复用的健康 transcript——用户付一次完整 reseed（envelope FULL seed +
  transcript 回读），agent 也丢掉它已有的上下文。
- env 覆盖 `HERMES_SESSION_EMPTY_ROTATE_THRESHOLD` 保留为运维逃生口（`1` = 2.2.9
  语义，事故可回滚）；`Math.max(1, …)` 下界保留（轮换只发生在 turn 起点，0/负数
  无意义且会静默废掉守卫）；非数字覆盖回退默认值而非 NaN（NaN 会让
  `streak >= NaN` 恒 false，等于静默永久关掉轮换）。新增 `emptyRotateThreshold()`
  导出，供调度器读取实际生效值，避免与 `shouldRotate` 的判据漂移。
- `sessions-dispatcher`：首次（未达阈值）空回复发一条 `empty_reply_observed`
  `system_event`，其 `reason` 复用轮换事件（`context_rebuilt`）的
  `empty_reply_streak` 枚举值，并附带 streak / 生效阈值 / sessionId——两次失败因此
  读成一条故事：「仍在阈值下」→「达阈，窗口已重建」。文案与阈值解耦（不承诺
  「下一轮即重建」：运维把阈值调到 ≥3 时那是假话）。云侧 IO 未接线或不可达时静默
  跳过，不计为派发失败。
- 测试：新增 `sessions-dispatcher-empty-reply-threshold`（oracle 两次空回复 +
  两条负控 + 边界）；`session-health-persistence` 补阈值判据组（env=3 两次仍不轮换
  = 真阈值而非「延迟一拍」的假实现、env=1 恢复 2.2.9 语义、非数字覆盖回退 2、
  0 夹到 1）；`sessions-dispatcher-single-flight-rotation` 按新裁决更新。
- 既有 immutable-release 规则下版本号 bump 与否由发版时判定。

### infra — Hermes pin v2026.8.3 → v2026.9.14（S1，docs/organization/specs/01）

- **infra 锁**：`engine-lock.json` hermes 块 ref/installerSha256/uv.lock sha256、
  `build-inputs.lock.yaml` hermes ref/installerUrl/installerSha256 + verifiedAt。
- **镜像构建探针**：`Dockerfile.base` ARG 默认值随锁同步；探针串换为新 pin 的
  `if not route and model:` 并追加语义锚 `route_source = "raw_request"`（防探针
  弱化成空洞匹配）；安装调用加 `--skip-computer-use`（新 install.sh 会 best-effort
  从 unpinned `trycua/cua@main` 拉 cua-driver，不入 pinned-inputs 镜像）。
- **桌面 DMG payload**：hermes requirements 闭包按 v2026.9.14 `uv.lock` 重导出
  （arm64：71 pins，cryptography 48.0.1→50.0.0，+firecrawl-anydoc/pillow-heif/
  snowballstemmer，nemo-relay 0.6.0→0.8.3）；`engine-payload.manifest.json` 的
  `engineLockSha256` / `hermesRequirements.*.sha256` / `hermes-source` 重算。
  ⚠️ **x64 (Intel) 未能重导出**：tag 把 cryptography 钉在 50.0.0，上游自 49.0.0
  起删除全部 Intel-macOS wheel，wheel-only 链路下无法成闭包；文件头已记录阻塞，
  x64 当前不是 DMG 目标（`electron-builder.yml` arm64-only），需 owner 裁决。
- **测试**：新增 `test/sessions-sse-upgrade-compat.test.ts`（6 例）——keepalive 注释
  帧不干扰正文、注释帧不喂 stall watchdog（负控）、未知/前瞻事件不进 output
  （含 delta 兜底反例）、终态标志与 transcript 载荷无副作用、无 run.started 的
  error 事件仍保留 run_id。
- **daemon 源码变更为注释级**（`sessions-dispatcher.ts` 两处 stale 说明更正：
  sessions run 在 v2026.9.14 已注册 `_active_run_agents` + owner stamp，stall-abort
  的 `/v1/runs/{id}/stop` 自新 pin 起真实生效）。既有 immutable-release 规则下
  版本号 bump 与否由发版时判定。



### K 空腔闭合 — `prismer chat direct` 202 ACTION_DEFERRED 分支

- `chat direct` 收到 202 deferred（跨台联系人审批）时输出
  「等待联系人审批（approvalId: …）——审批通过后重新发送」，不再打印
  "sent"（此前消息 hold 在审批侧却被报成已发送；h-contact-system-refactor
  §9-SDK）。

### Hermes — session-health 默认路径生效（spec 11 / T1-3b，daemon 侧）

- `session-health`：`HERMES_SESSION_HEALTH_FILE` 未设时 health 文件**默认落盘**于
  `~/.prismer/hermes-session-health.json`。2.2.9 的
  `process.env.HERMES_SESSION_HEALTH_FILE ?? null` 让紧随其后的 `=== undefined`
  默认分支永不成立（`??` 已把 `undefined` 从类型里摘掉，且严格模式下也不报错）：
  env 未设时 `healthFile` 恒为 null，`persist()` / `load()` 双双 early return——
  「重启不丢轮换信号」只在运维显式给 env 时才成立。阈值 1→2 之后后果更实：
  streak 只活在进程内存，重启落在两次 EMPTY 之间即归零，污染会话可永久不轮换
  （每轮只留一条可见行，无自愈）。语义收敛为 `undefined`（未设）→ 默认文件、
  `''` → 关闭持久化、其余 → 显式路径。
- vitest `test/setup`：导入前把 env 钉到 per-file 临时路径。默认路径生效后，任何
  import hermes dispatcher 的测试文件（实测 10 个里 7 个会写）都会把 fixture 写进
  开发者真实的 `~/.prismer/hermes-session-health.json`——那正是 09 管理员消费的
  观察资产；显式导出的 env（含空串 = 关闭）原样尊重。
- 测试：新增「无 env → 两次 EMPTY → `$HOME/.prismer/…` 出现且 streak=2 → 重载
  （新 module 实例）后 `shouldRotate` 仍 true」（负控：显式 env 优先且默认位置不被
  创建）；既有显式路径用例逐字节不变。
- daemon 源码变更；版本号 bump 与否由发版时（immutable-release 规则）判定。

### Hermes — `prismer` 平台桥接客户端（daemon 侧传输，spec 11 / T4）

新增 `src/adapters/persistence/hermes/bridge-client.ts`：hermes gateway 的
`prismer` 自定义平台插件（`~/.hermes/profiles/<p>/plugins/prismer/adapter.py`）在
127.0.0.1 上以换行分隔 JSON 提供一个本地 TCP 桥；本模块是 daemon 侧的客户端传输层。

- 传输语义：`BridgeClient` 连 `127.0.0.1:<port>`，断线按 `reconnectDelayMs` 重连
  （`close()` 是唯一的停止方式），`waitForConnected()` 超时抛显式错误；
  `buildInboundFrame()` / `parseOutboundFrame()` 逐字段对齐插件读写契约；
  `probeBridge()` 做 TCP 可达性探测（协议无 ping 帧，可达性即健康信号）。
- 失败可见性：桥进程不存在时 `sendInbound()` 返 `{ok:false,error}`、
  `probeBridge()` 返 `{reachable:false,code:'ECONNREFUSED'|'ETIMEDOUT'}`、
  超出上限的悬挂行与畸形出站行走 `onMalformed`——无静默丢弃、无 unhandled rejection。
- 如实透传的 gateway 侧事实（不在本层修补）：突发连发时出站 `reply_to` 可能错锚；
  无连接时 gateway 的 `send()` 返 `SendResult(success=false, error="no daemon bridge
  connected")` 给 agent 而非上线（daemon 侧完全观测不到，连接态必须取自 `isConnected`）；
  首回合配对门回复按普通 `content` 透传；插件对 `t != "in"` 或空 `text` 的入站帧
  静默丢弃——因此客户端在本地就拒绝空文本，不留「写出去但被吞掉」的窗口。
- 落地方式：模块为**未接线**的传输原语（谁在 dispatch 里用它不在本波范围）；
  为使其进入发布产物，`src/index.ts` 追加了对应 re-export（与 `WsClient` 同惯例）。
  CHANGELOG 之外的版本文件零改动。

### EaaS — bash 解禁（会话级）+ turn 协议 v2 工具事件（events.jsonl / output.tools[]）

设计：`docs/superpowers/specs/2026-09-21-eaas-bash-tool-observability-design.md`（§3.1 修1、
§3.2、§5 修5/修6）。runtime 侧半边；cloud 侧轮询器与事件类型在 PrismerCloud 仓。

- **pi-core 会话级 shell 开关 `allowShell`（缺省 false）** —— `PiAgentCoreClientOptions` /
  session options 新增该字段（默认关闭）。true 时：① 工具面在 read/write/edit 之外追加
  `bash`（`createBashTool()`）；② `CwdJailedExecutionEnv.exec()` 由「恒返 `spawn_error`」
  改为委托内层 env（异常仍映射回 `ExecutionError` 语义）；③ `createTempDir` / `createTempFile`
  解除恒拒，但在 `<cwd>/.eaas/tmp/` 内创建（mkdir -p，保留上游 prefix/suffix，仍走 jail
  检查）——bash 长输出截断依赖 temp 文件，落点必须留在 jail 内。**缺省 false 是刻意的
  爆炸半径控制**：daemon（dispatch / runner / skill-sync）与 engine registry
  （`createPiCoreAdapter`）路径的工具面与拒绝面**逐字不变**（缺省时仍是「Tool bash not
  found」+ exec 原文拒绝），桌面/本地 hosted agent 零影响。
- **工具事件（只记录不拦截）** —— `Agent` 构造接 `beforeToolCall` / `afterToolCall`：前者发
  `tool_started`（name + argsSummary），后者发 `tool_finished`（resultSummary + isError +
  durationMs）。两个 hook 恒返回 `undefined`（策略位留空——deny/HITL 后续可叠加，协议零
  改动）；sink 抛错被吞掉（否则会被上游换成错误工具结果 = 事件面污染 turn）。摘要清洗在
  产生侧做一次（剥字面量出口 token + `Bearer …` / `sk-…` 形态），写侧再洗一次（防御纵深）。
- **turn 协议 v2**（`src/turn/protocol.ts`）—— `TURN_PROTOCOL_VERSION = 2`（唯一合法值，
  不做兼容推断）。新增 `events.jsonl` 行 schema（`ToolEventV1`：`seq/at/kind/name/argsSummary?/
  resultSummary?/isError?/durationMs?`）、常量 `TURN_EVENTS_FILENAME` /
  `TURN_EVENTS_MAX_COUNT = 200` / `TURN_EVENTS_MAX_BYTES = 512KiB` /
  `TOOL_SUMMARY_MAX_CHARS = 500`、`parseToolEventLine`、以及 `TurnResultV2.tools[]` 终态汇总
  （`TurnResultV1` → `TurnResultV2`）。v1 `output.json` 被解析器**明确拒绝**（带 skew 说明），
  v1 envelope / egress 同样拒绝——旧 bundle 收 v2 是可见失败（exit 70），不静默降级。
- **写侧（`src/turn/runner.ts`）** —— `createToolEventWriter`：**seq / at 由写侧赋值**
  （1-based 单调，行序 ≡ seq 序，轮询器据此去重），一行一条追加、首行落盘即 0600，达上限
  **停写**；终态 `tools[]` 在内存无条件折叠（修6：超限只影响流式粒度，不影响终态），孤儿
  `tool_started`（取消/超时，修5）如实呈现（有 `startedAt` 无 `finishedAt`，不补写）。文件
  懒创建（本轮无工具调用 ⇒ 不落 events.jsonl）。`runTurnFile` 把终态写进 `output.json.tools[]`；
  EaaS turn 恒以 `allowShell: true` 建会话（`turnSessionClientOptions`）。
- 测试：`test/turn-protocol.test.ts`（v2 accept/reject、events 行 schema、摘要截断/剥凭据）、
  `test/turn-events.test.ts`（seq 单调、上限、终态完整性、写失败不改 turn、turn 目录落点）、
  `test/pi-core-shell-gate.test.ts`（缺省工具面恰好 read/write/edit、exec/temp 拒绝原文、
  allowShell 下 bash 真跑与 jail 内 temp、hook 只记录不拦截）。三处均含故障注入负控（缺省
  翻 true / seq 冻结 → 用例变红）。
- **无版本号 bump**：本波是 runtime 面新能力（需随下一次 bundle 重签重发才能进 pod），
  版本对齐按发版轮统一做。
### S6/M1 Task 6 — 兼容矩阵固化 + 回滚开关（本包零代码改动）

- **本包无源码/测试改动**：Task 6 只做证明 + 开关固化 + 文档同步；唯一的测试补齿
  落在云侧 `src/im/tests/acp-serial-merge-trigger.test.ts`（M0 合并 vanish-in-tx
  用例补排队标记断言），不属本包。
- **四配对兼容矩阵逐条固化**（全部实跑绿；锚点表见 `docs/organization/specs/
  06-milestone-narration-m1.md` Task 6）：新 daemon × 旧 cloud（能力位缺席 → 单帧
  I3）、旧 daemon × 新 cloud（帧无 `final` 键 → 走终结分支）、新 daemon × 新 cloud
  且 relay 关（`HERMES_COMMENTARY_RELAY` off → 单帧）、上游门关（零 commentary →
  零回调 + output 逐字节不变）。部署顺序任意——承重机制是**请求能力位**（旧 cloud
  的请求永远不带 `interimReply`），不是帧字段的可选性；帧上 `seq/final` 对旧 cloud
  是惰性 JSON 多余字段。
- **回滚开关**：`HERMES_COMMENTARY_RELAY=false|0|off`（本包
  `src/adapters/persistence/hermes/flag.ts`，每 turn 动态读）→ 下一个 turn 回单帧；
  对端 cloud 的 `FF_INTERIM_REPLY`（`src/im/ws/v19x-helpers.ts`，每次装配读）→
  下一次派发回单帧。两者相互独立，任一关即回改动前字节行为；**无 DB 回滚需求**
  （零迁移）。
- **无版本号 bump**：本轮无源码变更，版本对齐仍随 S6 发版轮统一做。

### S6/M1 Task 2 — daemon wire：`task.dispatch.reply` 多帧发送

- `src/types/im-events.ts` + 云侧镜像 `src/im/types/im-events.ts`（两份同步）：
  `TaskDispatchRequestPayload` 新增可选 `interimReply`（capability bit——只有
  懂多帧的 cloud 才会带；legacy cloud 永远不带 = 它永远只收终结帧，这条不变式
  由该字段承载而非由帧承载）；`TaskDispatchReplyPayload` 新增可选
  `seq`（turn 内 1-based 帧位）/ `final`（false = interim 旁白帧；true/缺省 =
  终结帧）。
- `src/daemon/dispatch.ts`：双门制——`interimReply === true` **且**
  `isHermesCommentaryRelayEnabled()`（env `HERMES_COMMENTARY_RELAY` 二道闸）
  才把 Task 1 的 `TaskInput.onInterimReply` 接到发帧：每段旁白出 I1 帧
  `{ ok: true, output: <段文本>, seq, final: false }`；终结帧在**所有** reply
  出口（adapter_unhealthy / workdir_materialize_failed / 主出口）统一经
  `markTerminalReply` 补标 I2 `{ seq: N+1, final: true }`（失败终结帧同样补
  标——interim 帧永不失败是 I6，终结帧仍是唯一完成标记）。能力位缺省 / env
  关 / 零旁白 turn：单帧且 wire 上**无 seq/final 键**（I3，与现状字节一致）。
  runs-dispatcher / `tool.*` 降级路径 / shell 面一律未动。
- **deltas 回退残余窗口裁决**（Task 1 交接旗标）：「上游 commentary 不进
  delta 流」在 daemon 侧**不可保证**——已作为契约注释落在
  `interimRelayArmed` 声明处；退化 turn（终结 output 与已发 interim 段拼接
  完全一致 = 上游旁白漏进 output 路径）的 daemon 侧处置 = 主出口 grep 可见
  的 `interim relay degenerate turn` stderr 标记 + 契约注释，帧计划不偏离
  I1-I6（interim 帧逐段 fire-and-forget 已出站、不可撤回；cloud handler 只认
  `final === false` / `seq`，不发明新 wire 语义；渲染侧去重归 cloud 层）。
- 新增导出纯函数 `buildInterimFrame(taskId, segment)` / 
  `markTerminalFrame(reply, lastInterimSeq)`。
- 新测试 `test/dispatch-interim-reply-frames.test.ts`（7 用例，mock WsClient
  捕帧、不经真实 socket）：多帧序 + 终结补标 + requestId 逐帧回显、能力位缺省
  负控①（回调不挂载，legacy 恰 1 帧）、env 关负控②、零旁白负控③（I3 字节
  兼容：`'seq' in frame === false`）、失败终结帧补标、退化签名观测、纯函数
  shape。兄弟 dispatch 回归 8 文件 99 用例全绿，`tsc --noEmit` 干净。
- **fix round 1（评审 Important）**：I4 在瞬时重试下被打破——adapter 上报的
  `seq` 是每条 SSE 流局部（Task 1 `commentarySeq` 每次 `consumeSessionsSse`
  1-based 重置），而重试循环复用同一 `onInterimReply` 闭包，attempt 2 的旁白
  会把 wire 打成 `[1, …, 1, terminal N]`（seq 重复 + 终结帧非最大）。修法 =
  **daemon 侧单派 seq（`++interimSeq`），不信任 adapter 上报值**；新增重试
  负控测试④（attempt1 旁白后瞬时失败 → attempt2 新流旁白 seq 重置，断言
  daemon 帧序 `[1,2,3]` 严格递增、终结帧最大；红→绿，修前实测 wire
  `[1,1,2]`）。评审 Minor #2 一并收：退化标记改走 `traceLog`（带
  `[trace=…]` 前缀，与 dispatch 全程 trace 一致）。
- **无版本号 bump**：字段全部 optional-additive，单帧路径字节不变；版本对齐
  随 S6 发版轮统一做。

### S6/M1 Task 1 — Hermes `assistant.commentary` 多段旁白回流（adapter SSE 消费段）

- `src/adapters/contract.ts`：`TaskInput` 新增可选 `onInterimReply(segment: { text, seq })`
  —— turn 内每段非空旁白逐段回调（per-turn 1-based `seq`，流序保序）；回调是
  fire-and-forget，consumer 抛异常不断 SSE 循环；最终 `TaskResult.output` 语义不变
  （仍= 最后一条 `assistant.completed`）。Task 2 的 daemon 消费面按此契约接。
- `src/adapters/persistence/hermes/sessions-sse.ts`：新增 `assistant.commentary` case
  （hermes v2026.9.14）。实测上游契约（2026-09-21 本地 source 真跑）：字段名是 `text`
  （附 `message_id` / `already_streamed` / `session_id` / `run_id` / `seq` / `ts`），
  brief 期 fixture 与旧 build 的 `content` 兜底——两者都收，`text` 优先（同文件
  `reasoning.available` 多字段容忍先例）。旁白与 delta 累加、`finalContent` 保持
  **完全不相交**：`already_streamed: true`（该段已作为 assistant.delta 流出）的段
  只走回调，绝不并入最终 output——这就是去重语义。无「值得发否」二次过滤（owner
  裁决：非空全量上抛，收窄后置）。`SessionsSseResult` 新增必填
  `commentarySegments: string[]`（测试/诊断用；无旁白 turn 为空数组；approval
  拆流早退路径同样携带）。`tool.*` / `message.started` 降级路径、
  `!isAgentReply` 守卫、runs-dispatcher / message.interim 一律未动。
- `src/adapters/persistence/hermes/flag.ts`：新增 kill-switch
  `HERMES_COMMENTARY_RELAY`（默认开，显式 `false|0|off` 才关）——与
  `HERMES_TASK_RUNS_DISPATCH` 反极性是有意的：回流是新默认行为，env 仅作运维逃生门。
- 新测试 `test/sessions-sse-commentary.test.ts`（6 用例）：多段顺序 + 1-based seq、
  keepalive 注释帧/空白旁白零回调（负控①）、回调抛异常不断流（负控②）、实测上游
  shape（text + already_streamed 不并入 output）、kill-switch、无旁白流回归
  （负控③，commentarySegments 为空 + output 逐字节不变）。兄弟 SSE 回归
  （upstream-error 9 / stall-watchdog 10 / first-event 3）与 dispatch 面 7 文件
  109 用例全绿，`tsc --noEmit` 干净。
- **无版本号 bump**：`onInterimReply` 为可选新增、daemon 消费面属 Task 2，版本
  对齐随 S6 发版轮统一做。

### memory211/10 R4 — W-1 digest「Verified this turn」段（harness receipt 派生）

- `daemon/memory/digest.ts`：`buildMemoryDigest` 新增可选 `verified.lines` 入参——
  在 hub spine 之后渲染 `# Verified this turn` 段，内容**逐行 verbatim 来自
  harness 持有的 receipt**（task 状态机当前态 / 上一 turn terminal receipt 摘要 /
  已完成产物指针）；builder 是纯渲染器，自己不派生任何事实。稳定性契约原样适用：
  同 receipts ⇒ 字节一致、version（body 的 sha256 前 16）随之变化使缓存行失效；
  **无 receipts ⇒ 整段不存在**（与 W-1 之前字节一致，不留空段）。段在极端守卫
  （32K tokens）之内。新测试 `test/memory-digest-verified.test.ts`（5 用例）。
- **调用侧接线（digest provider 处传 receipts）与演化 origin 的 daemon 产线贯通**
  属 runtime 发版轮工作（pack+promote 需 owner 授权）；本波先把 builder 面与
  契约测试落库。
- `daemon/memory/envelope.ts` 的 `MemoryPageUpsertEvent` 云侧解析面新增可选
  `evolutionOrigin`（additive，不 bump schemaVersion，同 encrypted 先例）——
  携带该字段的 upsert 在云侧改道为 proposal 候选（见 PrismerCloud 仓
  memory-write.service.ts）。

### memory211/10 R1 — §2.1 演化产物 metadata 闸（daemon 侧镜像）

- `daemon/memory/write-gate.ts`：新增 `checkEvolutionMetadataGate(content)` +
  导出值域常量 `MEMORY_ROLES`（07 §2.1 的三分角色）。校验页体 frontmatter
  `extra.memory` 受控块（memoryRole / source 必填，trigger / sections 可选，
  `sections[]` 按 anchor 索引 —— D-1 (a)），未知键拒绝。
- **本波不接线**（有意的，非遗漏）：daemon 的演化面是 **proposal**（
  `memory.proposal` outbox 车道），不是页；daemon 真正写页的那条腿是自动抽取
  管线，而 write-gate.ts 的文件头已写明新增 422 绝不可落在那条腿（后台腿无法
  修复 ⇒ 静默丢记忆 = D4 失效模式）。接线 `memory.proposal` 车道属 R2
  「proposals 扩展」，待候选真的带上块之后。
- 与云侧 `src/im/services/memory-activation-probe.ts` 是**镜像**（两个包各有自己
  的 tsconfig 与 staged pkf 拷贝，无法共享代码，先例 `src/im/services/
  magic-bytes.ts`）。同源性由 `scripts/__tests__/
  memory211-evolution-metadata-parity.test.ts` 强制：值域相等 + 逐 fixture
  判定/字段级一致，单边改动即红。
- `daemon/dispatch.ts`：`MEMORY_CORE_DIRECTIVE` 增一行「演化产物过门 + verdict 回执」
  （07 §5 维5 的义务）。理由：§2.1 闸现在会**拒**缺块的演化产物，若 brief 不提这
  件事，被派发的腿会把 422 读成死路并把产物丢掉——正是本车道要杀的 no-fallback
  失效模式。该行 210 字符，指令此前已在 1292/1300 顶格，故预算 1300 → **1600**
  重钉（同 memory211/01 W5 轴H 的 1200→1300 先例：mandated content 才重钉，
  非编辑性膨胀；理由写在 pkf-skill-delivery.test.ts 用例注释里）。
- 教学：`sdk/cloud/catalog/skills/memory/SKILL.md` 增第 5 条 PKF body invariant
  （`extra.memory` 块、三分 memoryRole 的路由含义、source 的人类可陈述性、
  `sections[]` 按 anchor、手写页豁免、被拒后按 verdict 指名字段修复重提）。
  catalog 是单一来源，runtime 镜像由 `npm run prebuild` 生成（已重跑并核对
  byte-identical，484 行 ≤ 520 预算）。
- **无版本号 bump**：本波不加行为到已发布的 daemon 面（纯新增导出、零调用点，
  指令侧只是把既有闸的存在告知生产者），版本对齐随 memory211 发版轮统一做。

### memory211/08 A4-① — extract.done 观测上行（post-turn 抽取健康进云端活动面板）

- `daemon/memory/envelope.ts`：union 新增 `ExtractDoneEvent`（`eventType:
  'extract.done'`，TOP-LEVEL ObservabilityCommon 字段；`eventFamily` 归
  observability）。**Additive，不 bump schemaVersion**（同 traceId /
  recall_fork 先例：老 daemon 永不发该字面量，旧 envelope 解析不变，
  memory_outbox 无该形状旧行）。部署顺序：**cloud 先合、SDK 后发**——cloud
  未加 OBSERVABILITY_TYPES 前，新事件会被判 unknown_event_type 进死信。
- `adapters/coding/shared/lifecycle/post-turn-worker.ts`：`PostTurnWorker`
  新增第 4 个可选依赖闭包 `emitObservability`（缺省 no-op，永不断 Blocking
  post-turn 车道）与 options.deviceId（extract.done 溯源）；每个 outcome
  迁移（applied / skipped / failed_retryable / failed_terminal）发一条
  extract.done；idempotencyKey =
  `obs:extract.done:<jobKey>:<attemptCount>:<outcome>`（attempt 入 key：cloud
  幂等 hash 全 envelope，payload 可变则 key 必须变，否则 409）。
  `PostTurnExtractionResult` 增可选诊断字段（skipReason/gatedOut/truncated/
  latencyMs/promptTokens/completionTokens/errorStatus）。
- `daemon/memory/hook-server.ts`：`extractDurablePostTurn` 把 skip 原因与
  抽取诊断透传给 worker（原先只进内存计数器）。
- `daemon/memory/outbox-worker.ts`：flush tick 后采样
  `memoryOutboxHealthSnapshot()`（pending/deadLetter，最后样本）。
- `daemon/runner.ts`：worker 构造注入 emit 闭包（`runtime.resolve(ws).
  outbox.enqueue`，non-blocking）+ 真实 daemon_id；/healthz 增 `memoryOutbox`
  投影（零 I/O，首个 tick 前缺省）。
- 隐私：error 摘要取自 store lastError（`redactSensitiveText` 已跑、≤220
  截断）；`query`/对话正文永不入 envelope。
### MUST-1 — turn 的 LLM 出口改走 cloud turn-scoped 端点（`--key-file` → `--egress-file`，2026-09-18）

- **`prismer turn run` CLI 契约破坏性变更**：`--key-file <provider.key>` 移除，改为
  `--egress-file <egress.json>`（`{protocolVersion, url, token, model, provider}`，
  0600，**读完即删**）。pod 内从此**没有 provider key**：`token` 是 cloud 铸造的
  turn 作用域短 TTL 凭据（绑定 envId + turnId，run 终态或到点即死），模型调用打
  cloud 的 `/api/eaas-turn-egress/v1/chat/completions`（OpenAI chat-completions wire
  含 SSE 不变），由 cloud 用它自己的 provider 链与计费调上游。
- **token 原样进 `Authorization: Bearer`**：pi-ai 时代「补 `sk-` 前缀」的 C-1 归一
  逻辑不再适用于出口凭据——前缀会改变 cloud 出口面的 HMAC 验证输入。旧
  `provider.key`（owner token 表）不再被接受（收到即 exit 70，不静默）。
- 协议面：`TurnEnvelopeV1` 删除 `providers[]`（链与有序 fallback 上移到 cloud 出口
  侧——pod 内换源会重放已落盘工具副作用，cloud 侧换源不会）；收到带 `providers[]`
  的 envelope = cloud 早于本 bundle，明确拒绝（exit 70）而非静默忽略。新增
  `TurnEgressV1` + `parseTurnEgress`；移除 `TurnProviderV1` / `TurnApiMode` /
  `parseProviderKeys`。
- 结果 `providerSource` 恒为 `cloud-egress`（具体 provider 源在 cloud 侧解析后才
  确定，runtime 不再冒认源 id）；`PRISMER_PI_API` 固定 `openai-completions`（出口
  端点 wire），`openai-responses` / `anthropic-messages` 分支保留给 daemon 路径。
- 测试：`test/turn-cli.test.ts`（假 **egress** 端点全链真进程跑 + 「无 `sk-` 前缀」
  负控）、`test/turn-protocol.test.ts`（`TurnEgressV1` round-trip / 拒绝面 /
  legacy providers[] 拒绝）。cloud 侧镜像：`src/tenant/__tests__/agent-turn-runtime.test.ts`。

### `prismer turn run`：环境内一次性 turn 进程（Gate B+ Task 7 协议 v1）

> 2026-09-18 起，本节的 `--key-file` / `providers[]` 语义已被上面的 MUST-1 取代；
> 以下保留为当时快照。

- 新增 CLI 子命令 `prismer turn run --input <input.json> --output <output.json>
  --key-file <provider.key> --adapter pi-core [--deadline-ms N]`：cloud 的
  `EaasSandboxPort` exec 包装器在租户容器内调用它跑**一轮** agent 对话。
  - 协议 `TurnEnvelopeV1` / `TurnResultV1`（`src/turn/protocol.ts`）：input.json
    （0600，不含密钥）→ output.json；**stdout 不是数据通道**；exit code 契约
    0 = 结果已写、70 = 基建失败（cloud 侧映射 `runtime_unavailable`）。
  - 凭据只从 `--key-file`（0600，JSON map providerId → token）读，**读完即删**；
    turn 窗口 = 凭据窗口。
  - 有序 fallback：envelope 的 `providers[]` 按序试；某源在**未落工具副作用**前
    失败才换下一源（避免重放副作用）。t7/t8 由引擎真上报（首个非空 delta = t8）。
- pi-core 引擎新增 `openai-completions` wire（`PRISMER_PI_API=openai-completions`）：
  EaaS turn 的 provider 源走的就是 gateway 形态的 `/v1/chat/completions` 端点，
  换 wire 即静默行为漂移。原 `openai-responses` / `anthropic-messages` 选择逻辑
  不变（daemon 路径零影响）。
- 多模态：envelope 的 image 块（path + dataUrl 双载）原样进 pi-core 的 content-part
  （`{type:'image', data, mimeType}`），视觉能力门在 cloud 侧（curated 表是单一来源），
  runtime 侧不复制模型能力表。

### vision 清单：deepseek-v4-flash-vision-exp 进 hermes VISION_CAPABLE_MODELS

- `adapters/persistence/hermes` 的 per-model vision allowlist 新增
  `deepseek-v4-flash-vision-exp`（2026-09-10 owner 裁决，deepseek 默认模型统一切换）。
  依据：官方 vision guide + 活体 `image_url` 块往返 HTTP 200（图片 token 计费入账）。
  注意上游约束：图片仅 `user` 消息可携带；plain `deepseek-v4-flash` /
  `deepseek-v4-pro` 的 no-vision 判定不变。与 `src/lib` `BUILTIN_VISION_MODELS`
  的同步由 `model-defaults-chain.test.ts` parity 门保证。

### pkf-writing skill:全文评审门 + 生成器漂移同步

- `built-in-skills/pkf-writing/SKILL.md` 由生成器重新生成(与
  `sdk/cloud/catalog/skills/pkf-writing/SKILL.md` 逐字节一致,258 行):
  Report quality floor 升级为「构成底线 + 全文评审门」(plain table 不再计入
  rich affordance;交付前 5 项内容形状→载体机械审查)。生成器模板此前落后于
  线上文本,已一并同步。skill 行为变化,无 daemon 源码变化。

### ConfigDelivery env 直达 daemon process.env + 语义 config hash（test-504-storm 止血接线）

- **fix(config-bootstrap): `applyBundle` 把 bundle.env 全量应用进 daemon 自身
  `process.env`**——此前只有 `PRISMER_API_KEY`（显式）与 `PRISMER_BASE_URL`
  （providerBase）进 overlay，其余键只写 `~/.hermes/.env`（仅喂 hermes
  python），daemon 侧 `extract.ts` / `resolveBarrierTimeoutMs` 读到的永远是
  boot 时的 pod env——Nacos 调优键（`MEMORY_EXTRACT_MAX_TOKENS` /
  `PRISMER_MEMORY_BARRIER_TIMEOUT_MS`）经 ConfigDelivery 下发后不生效。
- **fix(config-bootstrap): config.yaml 幂等比较改用语义 hash（剥离 `#` 注释
  行）**——生成文件嵌有 `configVersion` 注释（曾有 `appliedAt` 时间戳），逐
  字节 hash 在任何 bundle 变化下都不同，env-only 变化会被误判为 config 变化
  而触发无谓的 gateway drain/kill（故障窗口里这是自伤）。语义相同 →
  `applied:false` → 只更新 env 面、不重启 gateway；`appliedAt` 时间戳已删
  （它同样击穿幂等检查）。备份仍只在真 config 变化时执行（env-only 不再
  覆写回滚副本里的旧 .env）。
- **fix(memory): `PreReplyDurabilityBarrier` 每次 `run()` 重新解析
  `PRISMER_MEMORY_BARRIER_TIMEOUT_MS`**——barrier 是 runner 里的长命单例，
  构造期快照会把 boot 时的 120s 默认值钉死到进程死亡；ConfigDelivery 是
  运行时热更新通道，预算必须绑到下一次 run 而不是下一次重启。
- cloud 侧配套：`src/im/api/runtime-bootstrap.ts` bundle.env 增设
  `DAEMON_TUNING_ENV_ALLOWLIST`（显式白名单 + 纯整数守卫，防 NaN 毒化
  extract max_tokens），负控测试
  `src/im/tests/acp-runtime-bootstrap-tuning-env.test.ts`；daemon 负控测试
  在 `test/config-bootstrap.test.ts`（env-only apply）与
  `test/pre-reply-durability.test.ts`（预算热解析，修复前代码上红）。

### ConfigDelivery context_length 存活契约 — configurePrismerProvider 保留/继承 `models`（评审修正）

- **fix(hermes adapter): `applyBootstrap` 整项替换 prismer entry 时保留既有
  `models` 键，profile doc 从 root doc 继承**——ConfigDelivery 写入 root
  `~/.hermes/config.yaml` 的 `custom_providers[].models.<id>.context_length`
  此前会在每次网关拉起时被不含 `models` 的新字面量整体替换剥掉（applyBundle
  在 configVersion 不变时跳过重写，永不恢复），且 profile 网关（`hermes -p
  <name>`，HERMES_HOME 被 profile 覆写、无 root 合并）读的 profile config 根本
  拿不到该块——step-0 override 失效、嗅探风暴复活。修复：root 先应用并捕获其
  `models`，profile 侧继承；本 doc 旧 entry 的 `models` 一律保留（operator
  手写值不丢）。双侧写入对齐 commit 673beb3a0（C4）确立的「ConfigDelivery
  YAML 与 configurePrismerProvider 逐键对齐」不变量。负控测试
  `test/hermes-provider-context-length.test.ts`（3 条，前两条在修复前代码上红）。

### ConfigDelivery — hermes config.yaml 写入 per-model `context_length`（首响应嗅探风暴根治）

- **feat(config-bootstrap): `generateHermesConfigYaml` 输出
  `custom_providers[].models.<id>.context_length`**——bundle 新增可选
  `hermes.modelContextLengths`（model id → 权威 context window，cloud 侧取自
  curated funnel），落到 Hermes 的 **step-0 config override**
  （`hermes_cli/config.py:get_custom_provider_context_length`）。此前 Hermes
  对自定义 base_url 每轮消息跑全量端点嗅探（`detect_local_server_type`×2 +
  `/models` `/v1/models` `/v1/models/<id>` `/api/show` …≈20 发，对我们只服务
  chat/completions 的 cloud proxy 全部 404）才能解析 context length，且无可
  缓存权威值 → 每轮重复，首 token 前白烧秒级。字段缺省时 YAML 与旧版逐字节
  一致（不产生空 `models:` 键）。
- `RuntimeConfigBundle.hermes.modelContextLengths?: Record<string, number>`
  类型同步落 `sdk/prismer` / `sdk/cloud` / `sdk/aip/typescript` 三包
  （additive optional，向后兼容；进 configVersion 内容 hash → daemon 下轮
  poll 自动拉新，无需 OTA 即可让 cloud 先行生效；yaml 渲染变更本身随下次
  runtime bundle 发布）。

### SDK 边界 Wave2 B2/B3 — daemon 离线改名落库 + CLI rename --handle

- **fix(daemon): `onAgentChanged` 补 local.db `agents` 表持久化**——改名
  （PATCH /agents/:id）不 bump profile version ⇒ host.acked / syncProfileFromCloud
  不会触发，旧实现改完只驻内存，重启后 declare/healthz/task-agentName 全回退旧名。
  现在 `agent.changed` 的 displayName 直达 `UPDATE agents SET name`（dirty=0），
  是离线窗口改名收敛的唯一落点；`AgentChangedPayload.fields` 同步补 `username`
  字段声明（daemon 不持久化——本地表无 username 列）。
- **feat(cli): `prismer agent rename` 增 `--handle <new-username>`**——PATCH 体
  `{ displayName, username? }`（handle 传时才带），与 PATCH /agents/:id 双字段
  契约对齐；handle 在 CLI 侧先按 `/^[a-z][a-z0-9-]{2,30}$/` 校验（坏轴根本不出网）。
- **fix(cli): register 校验收窄到 `/^[a-z][a-z0-9-]{2,30}$/`**——旧轴
  `[a-zA-Z0-9_-]`（大写/下划线，如 `Prod_Manager`）不再可新建（CLI 侧 400
  之前拒绝；云端 register 端点不动，存量 handle 保留）。`slugifyUsername`
  同步收窄：不再产出 `_`，数字开头派生名补 `agent-` 前缀保证字母开头。

### bugfix211 G2-R R-2 — runtime terminal-sessions 插件模块（workspace 终端）

- **feat(daemon): 新增 `daemon/terminal-sessions/` 插件模块**——daemon 协议
  PTY（spec §T-1 唯一轨），wire 四方法 `terminal.open/write/resize/close` +
  事件 `terminal.opened/data/exit/error`；会话卫生：per-daemon 并发上限 2、
  空闲回收（`PRISMER_TERMINAL_IDLE_TIMEOUT_MS`，默认 10min、floor 30s，按
  device-metrics interval 的 ConfigDelivery 模式）、ACL 逐字复用
  shell-executor 的 `enabled`/`allowedWorkspaces`/cwd 语义。能力位
  `runtime.terminal` 仅在 node-pty 真正加载到时宣告。
- **node-pty 分发形态（owner 裁决方案 A）**：只进 devDependencies，OTA
  bundle 持续 JS-only（staging `npm ci --omit=dev --ignore-scripts` 不装
  dev + `assertNoNativePayload` 对任何 `.node` die 兜底）；pod 侧经 image
  native ABI floor 供给（Dockerfile.base 源码编译 + install-builtin-runtime
  `--native-module-root` 借用，循 better-sqlite3 先例）。`loadPty()` 两路
  懒加载：常规 require（本机 dev/测试）→ floor 根
  `/opt/prismer/native/node_modules` → null ⇒ 模块降级（不宣告能力位，
  terminal.open 回类型化 `terminal_unavailable`，绝不伪造 PTY）。
- 测试：`test/terminal-sessions.test.ts` 30 例（真 PTY 生命周期 echo/exit
  码/resize、上限/ACL/cwd 拒、idle reaper fake timers、负控：loadPty 强制
  null ⇒ 降级、malformed 帧吞掉不进 dispatch、runner 未挂载 ⇒ 无能力位）；
  darwin spawn-helper 执行位兜底进 `test/setup/node-pty-exec-bit.ts`
  （上游 microsoft/node-pty#850）。
- **feat(daemon): daemon 侧窗口输出帽（spec §T-5 follow-up 落地）**——per-
  session 滚动窗字节预算（`PRISMER_TERMINAL_OUTPUT_BUDGET_BYTES` /
  `PRISMER_TERMINAL_OUTPUT_BUDGET_WINDOW_MS`，默认 32MiB/10s，与 idle
  timeout 同一条 ConfigDelivery 面）。洪流超预算 ⇒ kill 会话 +
  `terminal.exit` 带 typed `reason=terminal_output_budget`（relay 透传、
  前端独立横幅）；kill 触发 onExit 二次广播已抑制。cloud relay 512KB/1s
  保持浏览器侧收口，此帽是源端封顶——空闲回收在输出洪流下不再被续命。
  测试新增 5 例（resolver 契约 + fake pty 越限 kill + 窗内正常 + 未装配
  负控）。
- **fix(daemon): 输出帽系统评审三项修复**——① 窗口账本每次无条件排空（此前
  length>64 才 filter,稀疏流下旧账不滚、累计误杀）;② kill 后 onData 存活守卫
  （孙进程持 slave fd 续 drain 时不再 touch/timer 重挂/重复 exit 帧）;
  ③ env 显式 `0`/`off`/`disabled` 可关帽（此前任何 env 组合都落默认常开,
  ConfigDelivery 无 off 面）。评审回归钉 3 例 + 语义测试更新。

### bugfix211 G3 — host.acked adopt/reclaim × rejection 分离(declare↔ack 自噬环)

- **fix(daemon): adoption 不再清掉同一轮 ack 刚拉黑的所有权黑名单。** 半成型
  agent(有 profile 行、无 owner userId、无 binding)每轮 declare 同时命中
  rejectedAgents("不是你的")与 adoptAgents("没人绑,来收养"):ownership-lock
  删除+拉黑,syncHostAckAdoptions 又清黑名单重建,环实测 ~350ms/轮
  (skills/ack+declare+me/agents+runtime 连环刷屏)。daemon 侧
  syncHostAckAdoptions 增 rejectedThisRound 参数,本轮被拒 agent 跳过
  reclaim/adopt(保留黑名单);cloud 侧在 ack 组装口做统一剔除(见主仓
  handler.ts partitionAdoptableAgainstRejections)。

### bugfix211 G2 — ConfigDelivery 容器分类修正（workspace pod 被误判 ACS）

- **fix(daemon): 环境判据从镜像默认 `ALLOW_FAKE_API_KEY` 换成 env key 本身。**
  dev 镜像把 `PRISMER_ALLOW_FAKE_API_KEY=true` 烧为默认（v200 时代 ACS 占位
  key boot 的遗留），ACS checkpoint 与 workspace k8s pod 共享同一镜像，于是
  持有真 `sk-prismer-live-*` 凭证的 workspace pod 被判成 "no env-injected
  key" 的 ACS 世界：启动即打 "ACS sandbox detected"，env-inference 兜底被
  禁，B1 永久 401/403 时拒绝安全的最后手段而 Hermes 永不配置。新判据
  `containerEnvIsKeyless`（runner.ts，三处消费点统一）：container 且 env 无
  `sk-prismer-live-` 形态 key 才是 keyless 沙箱；持真 key 一律走 ACK 分支。
  配套 cloud 侧 pod-spec 显式注入 `PRISMER_ALLOW_FAKE_API_KEY=false`（覆盖
  镜像 ENV；ACS pod 不受影响）。测试 `test/container-env-keyless.test.ts` 5 例。

### memory211 — pkf_reply_inline cross-turn delivery + office-artifacts interpreter

- **fix(pkf): `pkf_reply_inline` read roots now include the session dir.** In a
  hermes LONG session the task dirs persist across turns under
  `sessions/<sid>/tasks/<tid>/`, and the agent re-delivers a `.pkf` it authored
  in a PREVIOUS turn's scratch; `bindPkfReplyInlineScope` computed `sessionDir`
  but never added it to `allowedReadRoots`, so the new dispatch rejected that
  path (`pkf_reply_inline_path_outside`) at tool time AND at terminal
  re-validation. Rooting the session dir makes directory-prefix containment
  cover every historical `tasks/*/scratch` under the session (referencing old
  scratch is the natural shape, not an escape). Unbind stays taskId-keyed, so
  the wider read set cannot outlive its own dispatch. Tests: red→green pair in
  `pkf-reply-inline-tool.test.ts` — cross-turn delivery through `handleDispatch`
  with the marker landing in THIS run's scratch, plus the same-session-bound
  negative control (another session's file is still rejected).
- **docs(office-artifacts skill): the baked office libs live in the image venv
  interpreter `/home/user/.venv/bin/python3`**, not the system
  `/usr/bin/python3` (which has none of them). The Runtime baseline section now
  says to run generator scripts with the venv interpreter and to re-probe there
  before concluding a dependency is missing (agents probing system python were
  reporting a false "missing deps"). Still no `pip install` on the fly. The
  authoritative copy is `sdk/cloud/catalog/skills/office-artifacts/SKILL.md`
  (`sdk/prismer/built-in-skills/` is the gitignored build-time copy, refreshed
  in this checkout to stay byte-identical); the catalog source-contract
  skills-manifest hash was re-pinned accordingly
  (`catalog-source-contract.test.ts`).

### memory211 external review — P1 (chunk lane cap boundary)

- **fix(P1, security, asset raw text): the daemon `memory_search` chunk lane
  was fail-OPEN for asset ACLs.** `runWorkspaceSearch` post-filtered hits with
  `store.loadById(r.pageId)`, but a T3 chunk hit's `pageId` mirrors an ASSET id
  and `memory_pages` never has that row — every chunk hit fell through the
  "no page row" pass and was KEPT, so a scoped sub-agent cap on a shared daemon
  could read any materialized asset's raw body (the hook recall path fails
  CLOSED on the same shape). Chunk hits are now judged by the new
  `canCapReadAsset(cap, asset)` boundary predicate (acl-predicate.ts) against
  the asset's `visibility` + `ownerImUserId`, mirrored onto the daemon's own
  asset projection: `asset_metadata_index` gains both columns (local schema
  v17) fed by the SAME `/assets/index` DTO it already mirrors — no endpoint or
  wire change — and the runner wires `resolveAssetAcl` (a synchronous local
  read, no I/O in the search hot path). Strictly narrower than the cloud asset
  ACL by design: `workspace` or own-asset grants, everything else DENIES
  (`user` / `task:*` / `quarantined` / `aclJson` grants stay cloud-side). An
  asset with no verdict (never synced, pre-v17 mirror row, older cloud) is
  DENIED — fail-closed — so the lane degrades to wiki-only instead of leaking.
  Tests: `memory-search-asset-cap.test.ts` (real RPC surface; the system cap
  sees the same chunk the scoped cap is denied, proving the fixture) +
  `canCapReadAsset` matrix in `memory-acl-predicate.test.ts` + the projection
  round-trip in `asset-metadata-index.test.ts`; mutation (removing the
  chunk-lane boundary) turns 2/4 red.

### memory211 review round 2 — P3 + P5

- **fix(P3, recall ranking): `mergeChunkHits` compared the COMPOSITE score
  instead of the LEXICAL evidence it documented.** Its comment promised that
  workspace priors never bury the upload, but `existing.score` already folds
  recency (+0.2) / supersede (−0.8) / stale (−0.5) — so a freshly-touched wiki
  page outranked a chunk that carried the query term far more strongly (the
  exact D9 shape). The merge now reads `components.matchScore` (the
  pre-adjustment BM25 relevance), the same basis the cloud `mergeRawTier`
  compares on. `MemorySearchResult` gains the additive optional
  `components: { matchScore }` decomposition (cloud parity), populated on both
  the wiki FTS leg and the chunk leg.
- **fix(P5, prompt doctrine): the dispatched agent prompt still taught the
  retired ">1M sharding" trigger.** `MEMORY_CORE_DIRECTIVE` (injected into
  every dispatch) plus five comment sites (extract.ts ×3, runner.ts,
  hook-server.ts) predate §6.9 裁决 4's 64K-character re-threshold, teaching an
  agent to shard a source the gate now admits whole up to 64K characters. All
  six now carry the 64K-character口径; `dispatch.test.ts` and
  `memory-skill-degrammar.test.ts` pin it (and pin that "1M" never returns).
- **fix(P6, deliverable gate): an image-only deliverable's page was gated out
  wholesale.** The pairing side declares a deliverable source on ANY
  `prismer://asset/<id>` occurrence — including the `<figure><img src>` form the
  extraction prompt itself teaches for IMAGE/CHART assets — while G9 recognized
  only `<a rel="derived-from">`. The gate now accepts the inline image pointer
  as the same materializable jump pointer (an image cannot be distilled into
  prose; its embed IS the jump), and the 422 message teaches both forms. An
  `<img>`/`<a>` pointing at a DIFFERENT asset, or an untyped `<a>`, still fails.

- **fix(recall): the T3 chunk lane collapsed an upload's chunks to ONE hit**
  (found as the W4 span-mint suite's order-dependent red). The lane deduped its
  FTS candidates by `path`, but every chunk of an asset shares the same
  `asset:<id>#<hash>` path — so an 11-chunk upload recalled exactly one chunk,
  whichever the (near-tied) bm25 ordering surfaced first, and mint-即升层 was
  invisible whenever the cited chunk lost that coin flip. Deduping is now by
  chunk identity (`assetId#ordinal`), and bm25-equal chunks tie-break by ordinal
  so the window cannot reshuffle between recalls on an unchanged store.


### memory211/01 §6.11 — W7 behavioural-closure wave (read-side telemetry)

- **Read-side `[memory-trace]` pipeline (D11-5)** — search / load / browse
  (place-context) / the search miss-lane's navigation now emit the same
  `[memory-trace] stage=…` lines the write lane has logged since memory203/18
  R8.2 (13 write sites, 0 read sites before W7). Lines carry the query COUNT,
  `navigation_used`, the tier histogram, result count, duration and a traceId
  (`?traceId=` honoured, else minted `rd_…`). The query TEXT never enters a
  read trace. Full-volume local stderr, no sampling.
- **CLI recall telemetry (D11-1)** — `prismer memory recall/search` enqueues one
  `recall_pull` (metadata `via: 'cli'`) into the daemon outbox via the existing
  `/local/memory/observability/emit` pass-through, attributed to the presented
  cap's `sub` claim (no subject ⇒ no event, never a fabricated actor). Best-effort:
  a telemetry failure never changes the command's exit code. NOTE: a scoped-cap
  CLI run now produces both a daemon tool-channel row and this `via:'cli'` row for
  the same intent — consumers filter on `via`.
- **CLI batch faces (D11-2)** — `prismer memory search --queries '["a","b"]'`
  (array passed through; the daemon owns the ≤8 bound and its `truncated` flag)
  and `prismer memory load-batch <paths…>` (≤10 point loads, per-path verdict,
  exit 1 only on a total miss). New `daemonGet` keeps a load 404 as a real
  per-path verdict instead of `tryDaemon`'s route-probing 404-continue. Contract:
  `maxItems` now survives into the regenerated plugin schema artifact; the
  memory SKILL CLI appendix teaches both faces.
- **Tool-sequence ring + turn metrics (D11-4)** — new
  `daemon/memory/tool-sequence.ts`: per-workspace ring (cap 200, in-process)
  recording one entry per search/load/browse/write the daemon serves. PRIVACY
  BOUNDARY: verb + page path + duration + timestamp + the `navigation` /
  query-COUNT flags only; `ALLOWED_ENTRY_KEYS` is a closed set enforced by test
  and the query text is unrecoverable. The dispatch finally block reads the
  turn's slice and emits `turn.navigation_used` (browse, or a load after a
  miss-lane search — repeated searches read 0) and `turn.shortcuts_taken`
  (loads with no preceding browse), only when the turn made a memory call.

### memory211/01 §6.9 — W6 (owner 终裁执行)

- memory211/01 §6.9 裁决 2 (W6) — **digest budget cap replaced by the 32K extreme
  guard** (`MEMORY_DIGEST_EXTREME_GUARD_TOKENS`, Nacos/env key
  `PRISMER_MEMORY_DIGEST_BUDGET_TOKENS` kept as the knob name). Full injection is
  the default; the guard is the only cut and it marks itself. The INDEX-TOC is no
  longer pre-budgeted to a share of the guard — that share silently
  skeletonized the map of a workspace whose digest was still far below the
  ceiling (covered by a red/green test in `memory-w3-upload-pipeline`).

- memory211/01 §6.9 裁决 1 (W6 fix round 1) — **the daemon miss navigation now
  respects the per-cap read boundary**. `runWorkspaceSearch` filtered hits
  through `canCapReadPage` but passed `navigation.startPoints` straight through,
  so a hub/INDEX the actor cannot read still surfaced as path + title +
  childrenCount. Start points are now filtered by the same predicate (an
  unreadable entry is dropped; if none survive the navigation is omitted) —
  matching the cloud side, which already applies `allowedPageIds` + the per-row
  read verdict.

- memory211/01 §6.9 裁决 5 ①② (W6) — the ingest bookkeeping gaps:
  ① **ingest terminal jump** (`reconcileWorkspaceIngestTasks` /
  `reconcileIngestTasks`): a completed ingest task flips its asset to
  `ingested`, a failed/cancelled one requeues it as `pending` with the attempt
  recorded on the asset row, and the third failure parks it `failed` (cap 3,
  mirroring the dream merge leg). The scheduler's ingest drain runs the
  reconciliation first. Fix round 1: a LIVE (non-terminal) task outranks a stale
  terminal one, so a gen1 failure no longer gets re-applied over a gen2 that is
  still running — that misjudgement burned the retry budget twice, surfaced
  gen1's error as if fresh, and could park `failed` an asset whose current
  generation was fine (a false stall, since the drain never sweeps `failed`).
  ② **`prismer memory ingest`** — the workspace upload-ingest operational switch
  (owner/admin, cloud `/api/im/memory/ingest-settings`, merge-safe: it patches
  one metadata key instead of replacing the object).

- memory211/01 §6.9 裁决 5 ③ (W6) — **daemon-first search scaffold removed** rather than wired: `setDaemonRpcSender`
  had no responder (nothing in `src/im/ws/` ever registered presence or answered a
  `memory.search` RPC), so `FF_MEMORY_SEARCH_DAEMON_FIRST` was a flag whose ON path
  was unreachable in production. Cloud is the single authoritative recall path;
  `SearchHit` collapses back to the cloud payload shape. Wiring daemon-first recall
  would be a new designed seam (WS route + trace + parity tests), not a resurrected
  stub.

- memory211/01 §6.9 裁决 4 (W6) — **sharding threshold 1M → 64K characters**.
  The daemon deliverable gate's constant is renamed
  `SHARDING_THRESHOLD_BYTES` → `SHARDING_THRESHOLD_CHARS` (`64 * 1024`) because
  the ruling's 口径 is characters, not bytes (a CJK source is ~3 bytes per
  char). The gate now applies the ceiling to the PAGE BODY in characters
  (每页 ≤64K, 422 `sharding_required`); the cloud pipeline plans the source half
  from the exact chunk character count.

- memory211/01 §6.9 裁决 3 (W6) — **memory/SKILL.md regenerated for the new loop**
  (three-stage recall protocol: structure route → semantic search → navigation
  miss-fallback; batch `queries[]` usage; the wiki/asset/raw tier trust bands;
  copy + reference writing rules; 64K-char sharding). The skill now teaches
  "startPoints are NOT answers — walk them". The prompt-size receipt budget is
  rebased 360 → 460 lines for the mandated content (owner ruling: rebuild without
  historical baggage, request budget rather than drop content). The plugin tool
  schema artifact was regenerated from the TS spec (memory_search description now
  teaches the navigation contract).

- memory211/01 §6.9 裁决 2 (W6) — **digest budget cap removed**: the W3-era
  ~2K-token routine cap on the turn-start digest is GONE. `buildMemoryDigest`
  now injects the FULL map (INDEX-TOC + every hub summary); the only remaining
  bound is the extreme guard `MEMORY_DIGEST_EXTREME_GUARD_TOKENS = 32_000`
  (env/Nacos key `PRISMER_MEMORY_DIGEST_BUDGET_TOKENS` keeps its name — it now
  tunes the guard, not a routine cap), above which the body is cut with the
  existing observable `digest truncated` marker. Determinism and content-hash
  versioning are unchanged.
- memory211/01 §6.9 裁决 1 (W6) — **miss-path navigation redesign**: on a text
  miss `memory_search` no longer returns the structural lane dressed up as a
  ranked hit list (a miss carries no rank evidence — the old band was a random
  order). The response now carries `navigation: {reason:'text-miss',
  startPoints:[{path,title,pageType,childrenCount,why:'structural-entry'}],
  guidance}` (INDEX + hubs, children first) on the daemon response, the TS
  adapter types (`MemoryNavigation`) and — via the plugin's JSON passthrough —
  the tool result. `hybrid()` keeps its shape for existing callers; use
  `hybridWithNavigation()` for the payload. The W1a dynamic miss band
  (`GRAPH_MISS_PROMOTED_BAND` / `applyMissBands`) is removed: graph hits now
  exist only as a supplement to real FTS evidence and always land in the sink
  band. Hits with lexical evidence (FTS pages, T3 chunks) are unchanged.
- memory211/01 v3.3 W5 (轴H 单源契约 + 轴G section curate 动词):
  - **Single schema source (D1 extinction)**: the five memory tool schemas in
    `plugins/memory/prismer/__init__.py` are no longer hand-written — they are
    generated from the frozen TS spec (`src/adapters/memory-tools.ts`) into
    `tool-schemas.generated.json` and LOADED at runtime. Regenerate with
    `npx tsx scripts/memory211/generate-memory-tool-contract.ts`; the
    three-surface contract test
    (`scripts/__tests__/memory211-tool-contract.test.ts` on the cloud repo)
    fails on any divergence between tool schema, plugin handler, CLI flags and
    the SKILL.md parameter table. The placement parameter is now camelCase
    `parentHubPath` on EVERY surface (was `parent_hub_path` on the Hermes
    plugin while the skill taught `parentHubPath`).
  - Plugin forwards the batch `queries` + `pageType` memory_search params
    (W1a leftover) and the `visibility` write param.
  - Daemon RPC: `/local/memory/curate` routes the new `section_merge` /
    `section_supersede` / `rewire` ops to cloud; new `/local/memory/delete`
    (cloud-adjudicated soft delete + local mirror invalidation) and
    `/local/memory/sync` (alias of flush).
  - CLI: `prismer memory delete|sync` now hit the real daemon routes (they
    previously probed only legacy paths no daemon exposes), `memory write
    --title`, `memory curate promote-to-hub --child-paths`, and three new
    subcommands `curate section-merge|section-supersede|rewire`.

- memory211/01 v3.3 W4 (轴F 溯源闭合), daemon runtime side — **lazy span mint +
  mint 即升层**:
  - Local store schema V5 → V6: `asset_chunks` gains `sid` (additive column,
    pragma-guarded ALTER). NULL = the chunk was never cited by a distilled page
    = still T3 `raw`; non-NULL = cited + minted = T2 `asset`.
  - New `daemon/memory/span-mint.ts`: after an agent-authored write
    (`memory_write`) or a post-turn extracted page commits, the content is
    scanned for asset provenance pointers (`prismer://workspace/<ws>/asset/<sha256>`
    scoped, `prismer://asset/<id>` bare, `asset:<id>#<hash>` token — each with an
    optional `#chunk-<ordinal>` span anchor). Every cited chunk of the asset's
    CURRENT revision gets a DETERMINISTIC span sid (`sp-<16hex>`, derived from
    assetId + contentHash + ordinal + text hash — byte-identical to the cloud
    twin `src/im/services/memory-span-sid.ts#mintChunkSid`, so both sides
    converge on one identity), the local mirror row is promoted, and the mint
    rides the SAME idempotent `asset.chunk.upsert` channel with the `sid`
    attached so the cloud authoritative row promotes too. The mint is a derived
    projection: it never throws into the write path and is a one-way latch
    (a sid-less replay never un-mints).
  - Local recall honours the promotion: a chunk hit whose row carries a sid
    surfaces as `tier:'asset'` with `spanSid`, and no longer pays the
    `RAW_TRUST_DISCOUNT` (spec 轴C: T2 sits above T3).

- memory211/01 v3.3 W3 (upload ingestion pipeline + turn-start warmup), daemon
  runtime side:
  - **T3 raw-chunk mirror (轴D, F2 裁决)** — local store schema V4 → V5 adds
    `asset_chunks` + `asset_chunks_fts` (additive migration, no rebuild). A
    materialized upload is chunked locally (deterministic ~2K-token chunks with
    10% overlap; byte-identical contract with the cloud chunker) and recalled as
    `tier:'raw'` hits, so offline recall now includes uploads, not only wiki
    pages. The same rows ride the existing memory outbox to the cloud
    authoritative `im_asset_chunks` via the new `asset.chunk.upsert` event
    (idempotent per `workspaceId:assetId:contentHash:ordinal`).
  - **pdf ingestion** — pdf uploads go through the bundled liteparse `lit`
    (digital fast path `--no-ocr`, OCR fallback, 60s kill). A missing/failed
    parser SKIPS loudly; it never throws into the `asset.materialize` ack.
  - **Stable memory digest (轴E)** — new `daemon/memory/digest.ts` builds the
    turn-start digest (INDEX-TOC + hub one-liners): deterministic (path-sorted,
    no timestamps/volatile fields), sha256 versioned, bounded to ~2K tokens
    (`PRISMER_MEMORY_DIGEST_BUDGET_TOKENS`), with an observable truncation
    marker. `FF_MEMORY_INDEX_INJECT_ENABLED` now defaults ON (explicit
    `false|0|off` to disable).
  - **Hermes assembly (轴E)** — the adapter injects the digest at the TAIL of
    the per-turn `instructions` (i.e. the tail of the composed system message)
    so the rarely-changing blocks above it keep their prompt-cache prefix; the
    block is byte-stable for a given digest version.
  - **Miss-lane anchors (轴D 追加项 D①)** — when the text leg misses entirely,
    the daemon miss lane now RETURNS the INDEX/hub anchors as `via:'graph'`
    hits (they were seeds only) and a routing term (childrenCount) keeps a hub
    above its own leaves in the elevated band.
  - **Review fixes** — the deliverable gate no longer strips
    `contentHash`/`sizeBytes` from a declared source (the G10 sharding trigger
    was unreachable from extraction), both extraction legs report
    `extractionGatedOut`/`shardingRequired`, and the dead `distillOverBudget`
    counter is gone.

- memory211/01 v3.3 W2 (内容模型 + 写入门 + CJK 分词) — the extraction-thinning
  reversal, on the daemon runtime side:
  - **CJK recall fixed (W2 #7, W0 baseline finding)** — the daemon FTS index
    gains a `cjk` bigram projection column (`memory_fts.cjk`, store schema
    V4 with a drop/recreate/re-index migration) and the query side offers the
    query's own CJK bigrams as FTS alternatives. Before: FTS5's unicode61
    tokenizer kept a whole CJK run as ONE token, so a 2-char Chinese term inside
    a longer run could never match — a pure-Chinese query was a guaranteed zero.
    ASCII queries are byte-for-byte unchanged.
  - **G10 redefined in place (轴A / §0.1)** — the anti-copy budget
    (`min(32KiB, 10% × source)` → 422 `distill_over_budget`) is GONE; copy +
    reference means a distilled page may carry the source's near-full content.
    The only budget left is the sharding trigger: a source over 1,000,000 bytes
    is refused with 422 `sharding_required` (the W5 sharding pipeline will own
    the actual splitting). G9 (derived-from pointer) is unchanged.
  - **one gate, two surfaces (轴H / D3)** — the deliverable gate moved to
    `daemon/memory/deliverable-gate.ts` and the MAIN extraction path now runs
    it: a page that declares a deliverable source but references none of them is
    dropped loudly (trace + `extractionGatedOut` counter) instead of written.
  - **write gates ②③ (轴H)** — `memory_write` now rejects a NEW PKF page with no
    frontmatter description (422 `description_required`) and a body that fails
    the bundled `validatePkf` structure audit (422 `pkf_invalid`, warnings never
    reject). Markdown (legacy input) is exempt from both, edits of existing
    pages are exempt from the description gate, and the PKF gate runs AFTER the
    bare-asset upgrade so the taught `prismer://asset/<id>` pointer form is not
    re-flagged. The placement gate additionally honours an existing child-of
    graph edge (轴H ①).
  - **extraction prompt re-cast (轴A)** — the "pointers not copies" doctrine is
    replaced by copy + reference, with two acceptance rules the model must
    self-check: LEXICON COVERAGE (proper nouns / codes / 中英对照 terms survive
    verbatim) and SECTION EDGES (typed `<a rel>` links anchored at `#section`,
    which the cloud materializer lands as `im_memory_links.sourceSection` /
    `targetSection`). `MAX_PAGES_PER_TURN` and the 32768 extract budget are
    unchanged, and the recorded `lexicon_coverage` metric
    (`extractLexicon` / `coverage`) is the W2 acceptance measure — recorded,
    never gating.
- memory search surface re-cast (memory211/01 §3 轴C W1a) — the recall payload
  now carries what an agent needs to decide 直读 vs 多跳 without a second call,
  and recall no longer dies when the text leg does:
  - **hop-decision payload**: every `memory_search` hit adds `pagePath`
    (mirror of the frozen `path`), `hubPath` (reverse `child-of` placement,
    null for a root/INDEX page or a dangling edge), `version`,
    `sectionAnchor`/`sectionPreview`, `tier: 'wiki'` (the T1-only enum is
    pinned now; T2/T3 land with the W3 ingestion pipeline),
    `inboundLinkCount`, `childrenCount` and `outboundPreview[]`. All of it is
    aggregated IN PLACE from the existing `memory_links` mirror
    (`MemoryStore.pageGraphContext`) — no new table, no new sync channel.
    Legacy fields (`path`/`title`/`snippet`/`score`/`tokenCount`) are
    untouched, so an un-upgraded consumer keeps working.
  - **dynamic graph band** (spec open ruling point 3, W1 experiment): the old
    constant "every graph hit one unit below the weakest FTS hit" is replaced.
    When the text leg has hits, graph hits stay the supplementary band (the
    old invariant still holds and is still tested). When text misses
    ENTIRELY — the memory211 §1 paraphrase failure, where the answering page
    shares zero tokens with the query — the graph leg becomes the recall lane:
    it seeds from INDEX + hubs and scores a structurally-anchored hit
    (≥1 inbound link or a resolvable hub) in the normal 0-1 band instead of
    the sub-zero decay band. `graph: false` keeps the legacy pure-FTS path.
  - **batch recall**: `GET /local/memory/search` accepts `queries` (JSON
    array, ≤8; over-limit is sliced with `truncated: true`) and returns
    `resultsByQuery: [{query, results}…]` plus the legacy `query`/`results`
    fields, which stay the FIRST query's so an old consumer sees today's
    shape. One `recall_pull` event is emitted per query (a batch carries N
    recall intents, not one). The single-`q` form is a batch of one.
  - **tree-shaped browse**: every hub in `GET /local/memory/place-context`
    (and in the `memory_browse` payload) now carries
    `children: [{path, title}]` from the local `child-of` edges; `nearest` is
    deliberately unchanged (graph-distance ordering is deferred to W1b).
  - **load 离线 links**: when the cloud does NOT answer `GET
    /memory/pages/:id/links` (unreachable, non-2xx, or never wired), the load
    response now falls back to the LOCAL link mirror instead of silently
    omitting `links`, assembled in the same `{outbound, backlinks}` envelope.
    An authoritative cloud answer is never overridden.
  - Covered by `test/memory-search-payload.test.ts` (payload fields + 升带,
    with the re-band and the offline-links fallback each carrying a mutation
    negative control), `test/memory-search-batch.test.ts`,
    `test/memory-browse-children.test.ts` and
    `test/memory-load-links-offline.test.ts`.
- metric outbox replay (B-P1a): the per-agent `metrics.jsonl` offline outbox
  (written by `daemonMetricEmit` whenever cloud is unreachable) finally has a
  reader. `MetricOutboxReplayWorker` (new `daemon/metric-outbox-replay.ts`,
  wired into the runner lifecycle) drains it into `POST /api/im/metrics/batch`
  — the same endpoint the online path uses, with the same per-event field
  shape (`eventType` splits at the first dot into `namespace.name`; value /
  dims / ts pass through as serialised; the entry's top-level workspace /
  project / task mirrors repair dims lost in the payload). Delivery is
  **at-least-once**: the file is frozen with `renameSync` BEFORE it is read and
  unlinked only after every ≤500-event batch chunk came back HTTP-ok, so a
  crash anywhere replays the file (additive metrics tolerate the duplicate).
  Freezing before reading (rather than truncating in place) is what makes a
  line appended by a concurrent emit during the cloud round-trip survive — it
  lands in a fresh live file and drains next tick. Bad-JSON lines and non
  `metric.event` kinds are counted, logged and dropped (they would retry
  forever otherwise); cloud-side per-event rejections are likewise logged and
  dropped, HTTP-level failures retain the whole file with 5s→10min backoff and
  a warn→error escalation after 5 failed ticks. Triggered on daemon startup and
  every 60s (timer unref'd); no notify hook on the write path — offline metrics
  are additive and a ≤60s lag is acceptable. Covered by
  `test/metric-outbox-replay.test.ts` (batch content, retention + retry,
  empty/missing no-op, chunking, backoff escalation, and a mutation negative
  control proving a mid-flight append is not lost under truncate).
- turn metrics (B-P0, agent performance pipeline): the daemon now emits eight
  turn-level metric events from the dispatch `finally` block alongside the
  existing `agent.dispatch` / `skill.invoked` batch — `turn.count`,
  `turn.tokens_input`, `turn.tokens_output`, `turn.tokens_cache_read`,
  `turn.tokens_cache_write`, `turn.duration_ms`, `turn.first_event_ms`,
  `turn.tool_calls`. Dims: required `workspaceId` + `agentId`; optional
  `conversationId`, `taskId`, `model`, `provider`, `status` (`ok`|`error`).
  Usage comes from the TERMINAL attempt's hermes usage only — retry inflation
  stays in `agent.dispatch`. Token rows are emitted per-field only when the
  terminal attempt reported them. `turn.first_event_ms` is new instrumentation
  on the hermes sessions lane: `consumeSessionsSse` captures the first
  stall-guard activation (gateway acks excluded) and derives it against the
  dispatcher's `startedAt`; `TaskResult.metrics` carries the new optional
  `firstEventMs`. Emit failures stay non-fatal (observability path). Covered
  by `test/daemon-metric-emit.test.ts` + `test/sessions-sse-first-event.test.ts`.
- config bootstrap (B1): 403 `SETUP_PIN_PENDING` (cloud: the workspace setup
  runner has provisioned the pod but has not persisted the canonical API-key
  pin yet) now backs off with the existing curve instead of terminal-stopping,
  bounded by `SETUP_PIN_RETRY_WINDOW_MS` (5 min) after which it degrades to the
  ordinary terminal 403. `BootstrapFetchResult` carries the cloud `error.code`
  and `BootstrapState.pinPendingSince` holds the window anchor — cleared by
  `resetBootstrapStopped` AND on every successful fetch (per-episode, so a
  later absent-pin episode gets a fresh window). Fixes fresh workspaces coming
  up memoryless when the
  pod daemon's first B1 fetch raced the pin persist (2026-09-02 ws-72d282f9).
  Covered by `test/config-bootstrap.test.ts`.
- memory write: write-time bare-asset-URI upgrade (pkf v1.1 §4.7). The
  memory skill / dispatch guidance / extraction prompt teach the bare
  `prismer://asset/<id>` pointer form (G9), but v1.1 strict validation
  rejects it on read-back (`bare-asset-uri`, compat-read only) — the
  canonical authoring form is `prismer://workspace/<wsId>/asset/<contentHash>`.
  `POST /local/memory/write` now deterministically rewrites every bare
  href/src pointer AFTER the G9 gate and BEFORE the page lands (store + outbox
  up-sync both carry the upgraded form; rel / link text / quote style /
  attribute order survive). assetId → contentHash resolves from the workspace
  AssetMetadataIndex (one throttled delta pull forced on a miss); unresolvable
  assets degrade to the workspace-scoped assetId form
  `prismer://workspace/<ws>/asset/<assetId>` (still v1.1-valid) — the write is
  NEVER blocked. Counters: `memory.counters.bareUriUpgraded` /
  `bareUriScopedDegrade` + `[memory-trace] stage=bare_uri_upgrade`. Covered by
  `test/memory-write-bare-uri-upgrade.test.ts`.

- daemon local gateway (desktop205 alignment round, 2026-08-31):
  - `PRISMER_LOCAL_GATEWAY` is now injected by the desktop embedded fork —
    the local data plane (SWR reads, SSE mirror, outbox writes) activates on
    desktop instead of being structurally unreachable.
  - user-Bearer acceptance: the gateway now serves the renderer's USER session
    JWT / sk-prismer key in addition to the daemon key. Introspected against
    the cloud (`/api/im/me`) and BOUND TO THE DAEMON OWNER — any other valid
    account token is refused (review hardening: previously any valid token
    could read the owner's SWR cache from any same-machine page via the
    permissive CORS origin). Cache is keyed by token SHA-256 digest with
    positive/negative TTLs; the raw bearer is never retained.
  - CORS: Allow-Headers now includes X-IM-Workspace/X-Request-Id/
    X-Idempotency-Key and Expose-Headers includes X-Data-Stale (the desktop
    offline indicator can now light on gateway-served responses).
  - SWR revalidation for /api/im/conversations is scoped to the daemon's
    declared workspace (`workspaceId()` dep); passthrough forwards the
    caller's X-IM-Workspace/X-Request-Id so multi-workspace identity survives
    the loopback hop.

- hermes adapter: `stopHermesGatewayForProfile` is now a logged no-op when the
  profile config fails `HermesProfileConfigSchema` (e.g. ACS sandbox fixtures
  carry no `apiKey`). Previously the uncaught ZodError escaped the
  `ServicePool.invalidate` disposer in `Runner.rebindHermesMemoryCapabilities`,
  crashed the daemon (exit 1), and after two retries the bootstrapper
  blacklisted the whole runtime bundle — sandbox healthz stuck at 503
  (reproduced 2026-08-30 by the dev-local fxr acceptance fixture). Covered by
  `test/hermes-stop-gateway-noop.test.ts`.
- sandbox-manager: removed the orphaned `resolve_daemon_id` wrapper (its only
  caller switched to `resolve_daemon_id_for_boot` in d74e00074); the dead
  symbol failed the dev-local rust-manager clippy gate (`-D warnings`).
- Memory post-turn extraction no longer mints pages from agent
  self-introductions (kickoff / "你们都能干什么" turns): a deterministic
  `agent_self_intro` skip in `shouldSkipExtraction` (narrow shape match on the
  reply head; an explicit user retention contract still passes) plus an
  `AGENT SELF-DESCRIPTIONS ARE NOT DURABLE` rule in the extraction prompt.
  2026-08-29 test incident: one role page per self-intro reply in a 3-agent
  kickoff (see docs/product210/03 附录 A-4). Tests:
  `sdk/prismer/test/memory-extract-self-intro.test.ts`.
- Filesystem-checkpoint restores now rebind every cached Hermes gateway after
  the per-boot Cloud Memory authority snapshot first becomes available. The
  gateway is atomically invalidated and prewarmed with a freshly minted
  `PRISMER_MEMORY_CAP`, including when the Runtime config bytes are unchanged.
  Explicit Memory GET tools also preserve structured daemon 401/403 responses
  instead of misreporting them as empty data or `daemon_unreachable`. Managed
  Hermes plugins now stage and directory-swap upgrades, so 0444 files restored
  from a Checkpoint no longer turn a valid Runtime update into EACCES.

- Replayed Hermes profile preparation now treats an already byte-identical
  `prismer-recall` plugin as a no-write success. Restored/hardened profile
  trees no longer emit false `EACCES` install warnings on repeated
  `host.acked`, while changed plugin bytes still fail visibly if unwritable.

- ACS workspace adoption now overlaps independent agents with a sliding,
  bounded three-agent worker pool after the initial 0/0 `host.declare`;
  profiles belonging to one agent remain ordered, failures remain isolated,
  and the daemon emits one aggregate adoption timing before the final roster
  declaration.

- Aligned Runtime package metadata with monorepo version `2.2.39` for a new
  immutable sandbox image containing the workspace-neutral template marker and
  clone identity behavior; Runtime OTA publication remains a separate chain.

- Promoted the canonical `remotion` skill into the common Agent baseline and
  calibrated its sandbox workflow against current Remotion guidance. Rendered
  media now has an explicit artifacts-dir → `cloud deliver` receipt contract,
  plus version/composition, async-asset, deterministic-media, writable-cache,
  browser-compatibility, adjacent-frame, and probe gates.

- ACS environment-template sources now initialize the full adapter floor without
  opening Cloud transport or binding a workspace. Template clones discard the
  source daemon identity and resume normal bootstrap before Cloud dispatch.
- Objective dispatch prompts now preserve the task/objective mirror fields used
  by Cloud OKR flows, so hosted runtime turns keep objective context attached
  through dispatch and post-turn durability.
- Sandbox runtime readiness now requires the daemon health identity to match the
  claimed workspace and daemon id before Cloud accepts an ACS dialback as ready.

- Image generation delivery is now single-path and run-aware. The bundled
  `image-generate` helper performs model discovery/generation and invokes
  `cloud deliver` once. Runtime marks that file snapshot handled so the
  dispatch-final scan makes no second upload; scan-only and offline-replay
  fallbacks use the same unbound `/runs/<id>` scope for chat runs. The result
  is one upload path, one user-visible root IMAsset (plus normal internal
  preview derivatives), and one reply attachment.
- Explicit-delivery snapshot de-dup is scoped to the cloud dispatch and cleared
  at teardown instead of living for the daemon process lifetime. This also
  bridges Hermes-local run ids to cloud dispatch ids, preventing both
  same-turn double uploads and later-dispatch false skips. A local :3000 live
  acceptance now verifies one user-visible Asset, one attachment, and no JSON
  in the message body through the real helper/CLI/daemon path.

- SS-01 bundle parser parity with Cloud: YAML `|` / `>` block-scalar
  descriptions are supported, and the 50-unit description floor is
  language-aware so concise CJK metadata does not require filler.

- Closed the Runtime PKF/Memory/Dream contract: bundled `memory` and
  `memory-dream` now mirror the carrier transition and authoritative-candidate
  rules; `parentHubPath` is consistent across schemas/prompts/errors; curate
  schema exposes `conflicts` and `oversized`; and `rebuild_index` is described
  truthfully as hub-TOC maintenance with graph-derived INDEX Contents. Daemon
  section addressing now reads complete PKF `<section>` wrappers so section
  edits cannot consume neighbouring tags.
- Long/structured replies now default to validated inline PKF across hosted
  adapters without asking the user to choose a format. Runtime passes the
  canonical inline source—not only its short Markdown projection—into post-turn
  durability, so lasting conclusions can be distilled into searchable Memory.
- Automatic Memory extraction now rejects unclassified leaves, verifies model
  placement against the browse snapshot, promotes unmatched new topics to hubs,
  and emits knowledge-profile PKF with semantic sections and real descriptions.
  The direct write RPC enforces placement by default.
- Removed the obsolete daemon Dream trigger path. `FF_MEMORY_DREAM_ENABLED`
  cannot revive the retired page-dream scheduler; Cloud scheduling followed by
  the appointed orchestrator is the sole automatic authority.

- Headless SERP + cache regression (runtime210/01, 2026-08-23): agent-first
  local web search/read for in-pod agents using the sandbox image's existing
  Playwright+Chromium, with results flowing back into the cloud
  `im_context_cache` (decentralized data regression).
  - Engine chain (`daemon/web/headless-serp.ts`): Bing (chromium, with
    `bing.com/ck/a` base64url redirect decoding), Google (chromium,
    `FF_WEB_HEADLESS_SERP_GOOGLE` opt-in; consent/challenge detection), DDG
    (plain HTTP with `uddg=` decoding + anomaly detection). Coalescing
    single-flight + 2s interval rail; engine-chain fallthrough; SSRF gate
    (http(s)-only, public-address-only resolution, subresource/redirect
    interception, final-URL recheck; TUN fake-IP range blocked by default,
    explicit `PRISMER_HEADLESS_ALLOW_FAKE_IP=1` opt-in for dev machines).
  - Deposit-dedup journal (`daemon/web/seen-journal.ts`) so agents never
    overwrite each other's cache entries (ContextCacheService.deposit is a
    blind upsert).
  - `daemon/web/rpc.ts`: `FF_WEB_HEADLESS_SERP` routing — **default
    `fallback`** (cloud Exa+Serper keeps relevance; headless rescues only when
    cloud fails, relevance not promised). Explicit `off` / `local-first` still
    available. Local responses are
    load-API-shaped (`success/requestId/mode/results/summary/cost/
    processingTime`) plus `degraded`/`providerAttempts`, so provider-shell
    tools and payload bounding are untouched. Reads/search hits deposit back
    via the existing free-tier `POST /api/context/save`. New
    `GET /local/web/doctor` health probe.
  - Real-scenario validation (2026-08-23): C6 corpus 20/20 on Bing, fetch of
    real pages (~2s for a 57KB Wikipedia article), Google consent + DDG
    anomaly challenge detection verified live. Expression-matrix finding:
    search operators (site:/quotes/boolean) are ignored on cookieless
    automated traffic — engine-side behavior, not a parser defect.
- Added the embedded `pi-core` runtime adapter floor: the SDK now pins
  `@earendil-works/pi-agent-core@0.84.2` and `@earendil-works/pi-ai@0.84.2`,
  registers `pi-core` as the canonical adapter/provider identity, injects
  Prismer gateway routes through `PRISMER_PI_*`, and validates jailed cwd
  read/write/edit tool execution. Daemon/desktop/K8s runtime bundle gates now
  share the `runtime-required-entries.json` manifest so Pi Core dependencies
  cannot drift across packers and loaders.

- Hosted Hermes turns now bind each native `run_*` row to its exact provider
  `api_*` session and capture bounded post-response model/provider evidence via
  the signed `prismer-recall` lifecycle bridge. Post-turn Memory resolution
  excludes synthetic session-cache rows, rejects unknown or identity-mismatched
  evidence, and no longer falls into ambiguous-agent / configured-model
  fallbacks for a real sessions-API turn.

- Closed the hosted PKF execution gap found by a real Hermes task: the shipped
  Python provider now registers `pkf_validate` / `pkf_outline` / `pkf_search` /
  `pkf_read` and forwards them to bounded `/local/pkf/*` Runtime routes backed
  by the staged `@prismer/pkf-core`. Native tool names are no longer presented
  as shell binaries. Hermes startup also installs a direct managed `cloud`
  symlink to the signed bundle's `@prismer/sdk/dist/cli.js`, including a safe
  `~/.local/bin` alias for login-shell PATH resets.

- Agent-output policy now accepts `.pkf` as
  `application/vnd.prismer.pkf+html` with the 5 MiB source budget, so a
  dispatch-final forced artifact scan can upload PKF deliverables. Expensive
  `host.acked` catch-up is connection-epoch/workspace idempotent: every ack
  still handles governance/profile deltas, while transport (retry-on-failure),
  Memory and Asset catch-up no longer repeat on each 30-second heartbeat.

- Runtime built-in delivery now ships canonical `pkf-svg` (with historical
  `pkf-visual` resolved through its metadata alias), installs both `pkf-svg`
  and `pkf-writing` as common coding skills, and verifies byte-identical
  catalog → bundled-fallback mirroring. The skill preserves the current PKF
  v1.1 production boundary: Mermaid/d3, not inline SVG authoring.

- `pkf-writing` now defines message-inline, Library `.pkf` Asset, and Memory
  Page carriers with a unique Runtime extraction sentinel contract plus
  canonical validation/persist/readback/Markdown-projection receipts.

- `pkf-writing` skill acceptance moved to the single-file contract
  (product209/19 WP2): SKILL.md < 180 lines with the references/ directory
  gone; the acceptance gates now carry explicit negative controls (over-budget
  content, invented commands, references/ import, bare asset URI all go red);
  the trigger matrix covers the Chinese recall intent ("recall 我的记忆" →
  memory). The prebuild built-in-skills mirror follows the catalog.

- Hermes gateway health check accepts `degraded` (product209/18): hermes
  0.20.0 reports top-level status `degraded` under disk pressure (>= 90%)
  while gateway + api_server are fully working; the old `status === 'ok'`
  gate bricked dispatch (30s x 3 retries + kill-respawn storm). The
  evaluator now requires gateway_state=running + api_server connected and
  accepts ok|degraded; the spawn stamp is written before the health wait so
  a slow/degraded gateway can't be misread as an un-witnessed orphan.

- Attachment blocks carry executable addresses (product209/18 Part A):
  non-text non-vision attachments now emit `prismer://workspace/<ws>/asset/
  <hash>` (stable reference) plus `path=file://<localPath>` for adapters
  with real filesystem tools (hermes gated by toolsetScope terminal/file;
  claude-code/codex/opencode). Tool-less adapters keep the legacy reminder
  and never see a path.

- Asset materialization push (product209/18 Part B): new WS frames
  `asset.materialize.request` (cloud → daemon, requestId=assetId) and
  `asset.materialize.reply` (daemon → cloud). The daemon materializes
  uploaded asset bytes into the local asset-cache on demand so the upload
  progress bar completes only when bytes are in the pod; failures reply
  with ok:false and cloud records no state (frontend polls and degrades).

- Canonical `pkf-writing` skill (product209/15 PKF-C1): slim SKILL.md + 6
  progressive-disclosure references (core format / semantic HTML / media-data-
  files / math / harness / validation-projection-export). Capability-based lane
  choice (structured tools vs native filesystem lane); resolved readback
  required before completion. Installed on coding agents via the common
  allowlist; description routes recall/curation to `memory`.

- PKF filesystem service (product209/15 PKF-H5): durable `pkf_checkouts`
  registry (daemon SQLite, idempotent boot migration) + four PATH-ONLY
  lifecycle specs. These names are not advertised to Hermes until a shipped
  provider handler can supply the task-root context. Ordinary UTF-8 files in
  the task root; symlink/path
  escape/device rejection; CRLF/BOM churn detected (explicit flag required);
  final file bytes commit through the Cloud carrier CAS
  (`POST /api/im/pkf/commit`); unlink never triggers a remote delete.

- SQLite V3 + snapshot-fenced full reconcile (product209/16 MA-2, Task 12):
  `memory.db` migrates 2 → 3 in ONE transaction — `memory_replica_state`
  (per-workspace cursor / accessVersion / replicaSubjectHash /
  contentHighWatermark / reconciling|ready|suspended|stale / lease) plus
  `memory_pages.sourceKind` and `replicaActorIdsJson`; the old
  `memory_inbox_cursor` is migrated read-only (accessVersion=0, suspended —
  never an authorization input), an in-flight `reconciling` flips to
  `suspended` on restart, and a newer-schema db fails closed with a typed
  `MemorySchemaIncompatibleError` (never a downgrade write). The runtime
  consumes the Task 11 manifest/content ports: first manifest page pins
  epoch/subject/high-watermark, content comes ONLY via
  `POST /memory/sync/content` (snapshotToken + sourceRevisionId +
  transport/content hashes), encrypted-pkf verifies transportHash → decrypts
  → verifies plaintext contentHash, legacy-html lands via the compat text
  path (never the local PKF write/outbox path), replicated rows carry the
  sorted exact actor set, and the ACL-shrink diff (complete set vs local
  controlled rows) deletes page/version/content/link/FTS — heads, deletes,
  tombstones and cursor/epoch/hash/lease/ready commit atomically, followed
  by a catch-up pass for content created mid-reconcile. Agent recall fails
  closed (typed `MemoryReplicaNotReadyError`) unless the replica is ready
  AND the live registered authority snapshot still matches the pinned
  epoch/subject hash AND neither the snapshot nor the local lease expired;
  `memory.invalidate` suspends the replica first. The boundary ACL predicate
  now checks `replicaActorIdsJson` membership (cap `sub` ∈ exact set,
  empty set denies all, tampered JSON fails closed) BEFORE coarse
  visibility/principal rules. Legacy daemon sync receiving 426
  `MEMORY_RUNTIME_UPGRADE_REQUIRED` stops typed (no fallback) and surfaces
  `SyncResult.upgradeRequired { minRuntimeVersion,
  requiredRuntimeCapabilities }`; strict workspaces are routed to the V3
  port automatically. `MIN_STRICT_RUNTIME_VERSION = '2.2.12'` (first build
  with SQLite V3, same source as the Cloud rollout constant).

- Memory authority snapshot + cap v2 (product209/16 MA-1B, Task 10): the
  daemon registers the Cloud-delivered `memoryAuthority` snapshot bundle
  (optional field on the RuntimeConfigBundle, 60m lease) and mints cap v2
  ONLY from a valid snapshot — server-derived actor claims (principal /
  taskIds / councilIds / verbs), 15m TTL clamped to
  `snapshot.validUntil`. No valid snapshot (never fetched / expired /
  tampered / epoch regression) → NO cap is injected and agent Memory RPC
  fails closed. v1 tokens still verify for one compat release cycle (the v1
  minter is retained only as the compat encoder; production mint sites
  migrated to `mintCapV2`). The boundary ACL predicate now adjudicates
  actor/principal/task claims: a deputy cap reads its bound member's
  `human:*` pages (strict principal-id equality, never as `sub`, never
  widened to other agents/members). `agent.host.declare` now carries
  `runtimeCapabilities` (the three §8.2 v1 capabilities) and the daemon
  handles the `memory.authority.invalidate` owned-channel frame (drop
  snapshot + forced bootstrap refresh).

- Memory RPC write/outbox atomicity (product209/16 MA-0S, M-OUTBOX-001):
  `POST /local/memory/write` now commits the page aggregate
  (page/version/content/FTS) and its outbox events (page upsert + placement
  link) in ONE SQLite transaction, reusing the post-turn
  extracted-page-applicator pattern. An outbox enqueue failure rolls the whole
  aggregate back and the RPC returns 500 instead of the old success that
  stranded the page local-only. Success responses now also carry
  `localVersion` and `outboxEventId`; the idempotency key stays derived from
  the logical write identity (page id + parentVersion + contentHash), so
  retries with a stable caller-supplied page id keep the same key.

- Native bounded query tools `pkf_outline` / `pkf_search` / `pkf_read`
  (product209/15 PKF-H2): in-process over the bundled core — 32 KiB output
  budget, signed paged cursors, 16/64 KiB read bounds, no includeSource
  escape, no regex query surface. Offline; same receipts as Cloud.

- Native `pkf_validate` tool (product209/15 PKF-D3): in-process PKF validation
  over the bundled pkf-core — no shell-out, no daemon RPC, offline by
  construction. Registered across the Hermes / Claude Code / Codex tool
  surfaces; same golden-fixture results as Cloud.

- PKF core staging (product209/15 PKF-D2): the runtime now stages a
  hash-verified `@prismer/pkf-core` build into its local node_modules during
  `prebuild` (`sdk/build/stage-pkf-core.cjs`), so offline parsing/validation
  runs from the bundled core with no cloud network and no monorepo root source
  (`test/pkf-core-staged.test.ts`). The staged copy never lands in the
  published tarball; the standalone pack gate verifies both tarballs unpack
  and run without the repo root.

- The bundled Remotion catalog now ships one self-contained canonical
  `remotion` skill instead of twelve duplicate top-level skills plus a set of
  short topic references. Runtime fallback resolves historical slugs through
  canonical metadata aliases, and installed-skill delivery collapses multiple
  legacy edges to one prompt section while preserving the selected historical
  skill ID for sync acknowledgements.
- Hermes session creation and every chat turn now lock the configured `model`
  (`require_model_lock: true`) while deliberately omitting `provider`. The
  dedicated per-profile gateway resolves its authoritative named provider
  before session creation; model-only locks let pre-lock sessions self-heal
  after an OTA without Hermes v2026.8.3's named-provider identity mismatch.
- Runtime OTA bundles now carry the in-tree Cloud CLI/SDK and its bundled AIP
  package. The frozen sandbox image no longer supplies these JavaScript product
  packages; the signed boot bundle is their single delivery path. The resident
  Rust manager now starts health before bundle resolution, retries when a fresh
  Pod has no bundle, prepends the bundle CLI path, and is the sole owner of
  Runtime child respawn.
- Signed Runtime manifests now record exact Runtime, Cloud SDK, and AIP package
  provenance and reject native `.node` payloads. Packing also requires the
  signing private key to match either the explicit rotated daemon public key or
  the bootstrapper's built-in public key, preventing bundles that self-verify
  during packing but cannot verify inside a Pod.
- Sandbox Pod probes now separate manager liveness (`:7890/healthz`) from
  Runtime readiness (`:7890/readyz`). A fresh Pod waiting for a signed bundle
  remains manager-alive but NotReady; Runtime child failure no longer makes
  kubelet kill the manager that owns recovery.
- Bundle pointers and boot markers are atomically written as `0640 user:user`,
  so both the Runtime owner and the group-member resident manager can read
  rollback state even under a strict `0077` launcher umask.
- Sandbox Manager S2 (WP-E r4): Parameterize `execute_disk_cleanup` slow-ms switch
  as a function parameter (previously read from process-global env). Eliminates
  non-deterministic test races under parallel `cargo test` — unit tests now pass
  slow_ms directly. Production path reads env once in `execute_action`. No
  protocol/behavior change.
- Sandbox Manager S2 (WP-E, product209/09 S2): OTA settle logic (strike/rollback/
  blacklist) migrated from TS (`ota-check.ts settlePreviousBoot`) into the Rust
  manager (`ota.rs`). File formats unchanged — boot-attempt.json, pointer files,
  blacklist.json match TS `bundle-store.ts` byte-for-byte. Manager settles
  unconfirmed boot markers BEFORE OTA resolve; `SANDBOX_MANAGER_PRESENT` env
  disables TS-side settle to prevent double-settle. Config backup point:
  `config-bootstrap.ts applyBundle` now writes backup to
  `~/.prismer/config-backup/` (atomic temporary+rename) before applying new
  Hermes config. Rescue actions (cmd channel + inotify polling): `rollback_config`
  (restore from backup → validate → restart), `ota_rollback` (current ← previous),
  `restart_daemon`, `diag_bundle` (tar.gz of config+logs+resources),
  `disk_cleanup`. Command idempotency via command-id result cache. Failure
  classification: FATAL (config syntax, OTA failure, DB corruption) → Fail-slow
  (diag pack + stay alive); TRANSIENT → Fail-fast (immediate restart, max 3
  consecutive → Fail-slow). Design: docs/product209/09-resident-sandbox-manager.md
  §3.3, §3.5, §3.6, §4, §6.
- Observability (WP-D, product209/07 §3.7.4): daemon /healthz `config` segment
  (`configVersion` / `lastApplyAt` / `lastApplyError` / `pending`) derived from
  bootstrapStates via spread discipline — absent when no ConfigDelivery state,
  keeping CLI/K8s healthz shape unchanged. `runtime.incident` WS emission on
  bootstrap errors (401/403 stop, 404/500/network backoff) for cloud-side
  audit-row consumption. `LocalServerState.config` interface added.
- Sandbox Manager S1 (09): Resident sandbox-manager — Rust static binary
  (`sdk/prismer/src/daemon/sandbox-manager/`) that supervises the daemon as a
  child process under tini. Entrypoint init logic (config.toml first-write,
  fake key fallback, static binding validation, OTA resolve) migrated from
  `daemon-entrypoint.sh` into the Rust binary. Healthz HTTP endpoint on port
  7890 (K8s probes target the manager, not daemon). Daemon heartbeat file
  (`~/.prismer/daemon-heartbeat`) written every 15s by the new
  `DaemonHeartbeat` class (`daemon/daemon-heartbeat.ts`) for manager-side
  liveness monitoring. Design: docs/product209/09-resident-sandbox-manager.md.
- ConfigDelivery P1: RuntimeConfigBundle types (`RuntimeConfigBundle`,
  `HermesProviderConfig`, `HermesBundleConfig`, `BootstrapRequest`,
  `BootstrapResponse`, `ConfigApplyState`) and daemon-side bootstrap module
  (`fetchBootstrapBundle`, `applyBundle`, `isValidBundle`,
  `createBootstrapState`, `resetBootstrapStopped`, `computeBootstrapErrorAction`,
  `toApplyState`) for fetching workspace-level runtime config from
  `GET /api/im/runtime/bootstrap` (B1 endpoint). Design:
  docs/product209/07-config-delivery-runtime-bootstrap.md §3.3–3.4.
- Adoption path in runner.ts now calls `triggerBootstrap()` (cloud B1 fetch)
  instead of direct `reprovisionHermesProfiles()` when `FF_CONFIG_DELIVERY` is
  ON (default). The cloud is the single source of truth for provider + model
  + key assembly. §3.6: explicit OFF falls back to 2.2.8 env-inference path.
- Coding Agent Line (08 P2/P3): CodingSessionControls UI component for
  workspace coding agent session lifecycle — adapter selection (claude-code /
  codex / opencode), forced-mode display, new-session / continue-session
  actions. Reuses `POST /api/conversations/direct` (zero new API). Session
  lifecycle tests for code-agent-driver resume semantics (same-key cache hit,
  restore-after-restart resumeSession, different-conversation creates new
  session), TRAP 1 single-flight guard (duplicate taskId replay), and
  autonomous launch on resume. Design:
  docs/product209/08-coding-agent-line.md §4–5.
- Backoff schedule for bootstrap fetch: 5s → 10s → 30s → 60s cap
  (`BOOTSTRAP_BACKOFF_MS`). Error semantics: 404/500 → backoff, 401/403 → stop
  retries; 401 stopped state reset by key adoption event (§3.4).
- Memory cap v1 fail-closed (spec16 §8.1 MA-0S, M-CAP-001): the daemon memory
  RPC no longer has an enforce-off branch — `PRISMER_MEMORY_CAP_ENFORCE` is
  deleted and every `/local/memory/*` call must carry a valid
  `x-prismer-memory-cap` (missing → 401 `memory_cap_required`; expired /
  tampered / forged → 401 `memory_cap_invalid`; a cross-workspace request is
  a cap-layer ws mismatch → 401 `memory_cap_invalid` per §13.4 — the old 403
  `memory_ws_scope_violation` is retired). The `prismer memory` CLI and the
  shared adapter tool client auto-carry the cap from `$PRISMER_MEMORY_CAP`.
  The acting identity is always the verified cap subject — body/query actor
  fields are never trusted — and a signed wildcard-scope cap under a
  non-system subject (or a cap whose own ws claim disagrees with its scope)
  is rejected at verify. Deny logs carry only a sha256 prefix of the
  presented token plus a reasonCode. Daemon-internal maintenance (outbox
  flush, WS invalidate, extraction) keeps writing the store in-process
  (system channel), never through the agent RPC gate.

### memory211/03 §7 B1 — memory_browse recency signal（`updatedAt` + `hubsByRecent[]`）

- **feat(daemon):** `memory_browse` 结果 hub 行新增 `updatedAt`（epoch ms——hub 行自身
  与其 child-of 后代的最新更新时间 spread；hub 行在叶节点写入时不会被 re-touch，故按
  spread 算）与 `hubsByRecent[]`（同集 hub 按 `updatedAt` DESC 排序的 recency 信号）。
  Additive：`hubs[]` 保持既有结构序，`index`/`nearest` 不变；无新工具、无 schema 变更
  （`/local/memory/place-context` 同 helper，两处不可漂移）。

### memory211/03 §7.2 B4 — R5 recall-methodology turn metrics

- **feat(daemon):** dispatch 度量随既有 `turn.navigation_used` / `turn.shortcuts_taken`
  追加三枚 `turn.*`：`first_round_hybrid`（第一轮即 batch search ≥2 且同轮 browse）、
  `first_round_direct_read`（第一轮即 load 且无前导 browse——direct-recall shortcut）、
  `tool_rounds`（批内按 `R5_ROUND_GAP_MS` 计工具轮数）。分析式归并 daemon-side 的
  `tool-sequence.ts` ring；与既有两枚同纪律：turn 无 memory 调用 ⇒ 无行（不伪造 0）。

## 2.2.10 (2026-08-07)

- Fix Hermes "No LLM provider configured" on sandbox agents: the provider
  bootstrap wrote `model.provider: custom:prismer`, but hermes' custom-provider
  resolution matches `custom_providers[].name` verbatim — `custom:prismer`
  never matched the `prismer` entry, the gateway fell through with
  provider='custom' and no key, and every turn failed at AIAgent init.
  Exposed on 2.2.9: the dual-write made the gateway read the profile config
  (HERMES_HOME override) for the first time, surfacing the format mismatch.
  Write the bare provider name (`prismer`); verified in-pod that
  `_resolve_runtime_agent_kwargs` then resolves api_key + base_url correctly.

## 2.2.9 (2026-08-07)

- Fix Hermes sessions EMPTY reply after a process-level interrupt (sandbox
  agent observed live on 2026-08-07): the S10 pollution-rotation state was
  process-memory only, so a daemon restart (OTA kill1 / re-adoption) wiped
  "this session is polluted" and the next turn reused the polluted hermes
  transcript → `empty_reply`. Three changes:
  - `session-health` interrupted/empty-streak state now persists to
    `~/.prismer/hermes-session-health.json` (env `HERMES_SESSION_HEALTH_FILE`
    to override, `setSessionHealthFile(null)` to disable) and reloads on boot —
    a daemon restart keeps the rotation signal.
  - The dispatcher catch marks the session interrupted on CONNECTION-level
    breaks too (gateway killed by adoption re-provision, network drop), not
    only `task_cancelled` / `upstream stall` — sessions-sse never throws on
    application errors, so a thrown error is always an interrupted turn.
  - EMPTY rotation threshold defaults to 1 (`HERMES_SESSION_EMPTY_ROTATE_THRESHOLD`
    to raise) — one empty reply rotates the session instead of burning a
    second user-visible failed turn.
  Design: docs/product209/07 §2 (plan 2 closure).

## 2.2.8 (2026-08-06)

- Hermes provider bootstrap written to the ROOT `~/.hermes/config.yaml` +
  `~/.hermes/.env`, not the per-profile dir — Hermes' provider resolution
  (runtime_provider / AIAgent) only reads the root config, so every sandbox
  agent failed with "No LLM provider configured" (2026-08-06). Profile dir kept
  for the gateway `-p` flag.
- Re-provision Hermes profiles after the WS handshake adopts the real
  per-workspace API key: ACS sandboxes boot with the entrypoint placeholder key
  and any gateway spawned before adoption holds it; on adoption re-run
  `prepareProfile` (rewrites the root config with the adopted key) and kill the
  gateways so the next dispatch respawns with the real env/config. No-op for
  k8s/local (real key from boot, byte-identical rewrite).

## 2.2.7 (2026-08-05)

- Fix ACS handshake key adoption reaching the HTTP layer: `CloudClient` froze
  the boot-time placeholder key in its opts at construction, so after the
  handshake adopted the real per-workspace key every HTTP call still sent the
  placeholder and 401'd ("API key not found or revoked"). Profile sync then
  failed, declare stayed 0/0 and the setup parked at `agents_bound`. New
  `CloudClient.setApiKey()` + the adoption block now re-points the live client
  and `PRISMER_API_KEY` env. No-op for desktop/local daemons (real key from
  boot).

## 2.2.6 (2026-08-05)

- Adopt the cloud-delivered daemonId on the ACS binding handshake
  (`authenticated` ack extra.daemonId), exactly like the existing apiKey
  adoption: the sandbox boots with a derived `container:<hostname>` id that
  never matches the `im_containers` row's canonical UUID, so `declare` would
  otherwise fail the setup's daemonHasSignal lookup and `daemon_connected`
  would park forever. Only the ACS binding path sends daemonId, so
  desktop/local daemons are unaffected.

## 2.2.5 (2026-08-02)

- Established `@prismer/runtime` as the Runtime host under `sdk/prismer`, with
  Cloud SDK dependencies removed from its control-plane boundary.
- Replaced external coding-agent Marketplace plugin lifecycle control with
  Runtime-owned Claude adapter hooks and a durable provider-independent
  post-turn job ledger.
- Added remote-first skill catalog resolution with verified cache and bundled
  fallback, including resolver state and post-turn counters in `/healthz`.
- Retired Go/Rust SDK builds and four-segment hotfix releases; active packages
  now use the shared `X.Y.Z` release version and npm/PyPI release matrix.

### Added — D1/D2 裁决落地：两个新终态 code + `daemon.declare.retry` 解 park

cloud 侧本轮实施了 product206/13 的两条用户裁决（D1「显式归属，一次性选择」/ D2「凭证指纹
现在收窄」），daemon 侧要认它们的拒绝，并且要能被**解 park**。

- **`declare-guard.ts` 分类表新增两个终态 code**（判定逻辑与阶梯一行未动，只是表多了两行）：
  - `WORKSPACE_DAEMON_MISMATCH`（D1）—— 这个 workspace 的**本机槽位**显式归另一台设备，
    而归属**刻意不自动漂移**。归为终态正是裁决的要点：把它当可重试等于把「等对方掉线就
    抢过来」这条隐式规则从后门放回来。
  - `DAEMON_CREDENTIAL_MISMATCH`（D2）—— daemonId 属于本账号，但这把 API key 不是认领时那把。
    daemon 只有一把 key，重试永远拿同一个答案。
  - 两条都带用户能照做的 hint（`prismer status` / `/healthz.declareBlocked` 逐字透出）。
    cloud 同时发 `retryable: false`，所以**即使是不认识这两个 code 的老 daemon** 也会按终态
    处理（wire hint 压过本地表，R5 既有契约）。
- **新增入站帧 `daemon.declare.retry`（cloud → daemon）** —— 用户在云端做完补救动作
  （批量重认领 / 改派 workspace 槽位）后，cloud 主动叫 daemon 再试一次。**它是这两条出路
  端到端能用的那一半**：R5 的终态 park 是有界探测（+5min/+10min 之后彻底停发），没有这个
  推送，一个 20 分钟后才被修好的 daemon 只能靠重启进程恢复 —— 而「重启 daemon」正是 R5
  出入1 拒绝交付的答案。实现上复用 `onExplicitDeclare()` 这个既有的解 park 缝
  （`POST /v1/workspace` 走的同一条），**不新增状态机**。帧按 `daemonIds` 过滤（rooms 按
  人的 IMUser id 寻址，同账号所有 daemon 都会收到），不点名自己就忽略。纯加法：不认识这个
  type 的旧 daemon 落进 `handleIncoming` 的静默 default。

### Added — R5：declare 被 cloud 拒绝时有出路（分类 + 退避 + 用户可见），local-first 不变

`agent.host.declare` 被拒时，daemon 过去**把拒绝丢在地上**：`runner.ts` 的 `ws.on('message')`
只对三个 `AUTH_*` code 有动作，其余 error 帧写完 stderr 就落进 `handleIncoming()` 的
switch 被 default 吞掉；同时 30s 心跳**无条件**重发同一份注定失败的 declare。用户看到的是
「设备连上了、但一个 agent 都不托管」，没有任何面能说出原因。cloud 侧的 R4（daemonId 认领
鉴权）落地后这条从体验缺陷变成**必现路径**：认领冲突就会走到这里。

- **新增 `daemon/declare-guard.ts`** —— 分类表 + 退避阶梯 + 阻塞态，一个模块决定这三件事：
  - **终态**（`DAEMON_ID_CLAIMED` / `DAEMON_FORGOTTEN` / `NO_USER`）：重试永远不会成功，
    只有人能解。**不再无限重发** —— 拒后只留 2 次有界探测（10×/20× tick，默认 5min/10min）
    然后彻底停发。留探测而不是归零，是因为 forgotten / 认领释放这类终态常常几分钟内被人修好，
    daemon 应该自己发现，不该要求用户重启。
  - **可重试**（`WORKSPACE_ACTIVE_DEVICE_BUSY` / `DAEMON_IDENTITY_UNAVAILABLE` /
    `NO_IMUSER_LINKED` / `SHADOW_JOIN_FAILED` / `INTERNAL`）：继续重试但**退避**
    2×/4×/8×/10× tick（默认 60s→120s→240s→300s 封顶），不再恒 30s 打。
  - **认证类**（`AUTH_FAILED` / `AUTH_REQUIRED` / `auth_invalid`）：**行为不变**，仍是整机停机。
    凭证坏了退避没有意义 —— 这条显式确认，不再隐含在「反正都被 default 吞掉」里。
  - **非 declare 通道的 error**（`WITHDRAW_DAEMON_MISMATCH` / `UNKNOWN_EVENT`）：完全不碰
    declare 状态机（wire 没有可信的 per-frame 关联 id，这张排除表就是关联）。
  - **未知 code 一律降级为可重试**：新 cloud 发一个老 daemon 没见过的 code，绝不能把设备
    变成永久沉默。
  - **wire hint 压过本地表**：cloud 可在 error 帧带可选的 `retryable: false | {afterMs}`
    （`ServerEvents.error` 第 4 参，本包外配套）。双向可选、各自兜底，**不引入
    protocolVersion 协商**。
- **`/healthz` 新增 `declareBlocked`**（`LocalServerState`）—— `{code, message, retryable,
  since, attempts, nextRetryAt, hint}`。这是「**连不上**」（`wsConnected:false`）与
  「**连上了但被拒**」（`wsConnected:true` + `declareBlocked`）唯一可区分的地方。字段用
  spread 发出：没被拒的 daemon 的 healthz 形状与 R5 之前逐字节一致。
- **`prismer status` 打印拒绝原因**（新增导出的纯函数 `formatDeclareBlocked`）——「设备未被
  cloud 接受: <code>」+ cloud 原话 + 怎么办 + 下次尝试时间（park 时明说「不再自动尝试」）。
  同一改动里 `readDaemonStatus()` 改为认 `PRISMER_DAEMON_PORT`（原来硬编码 3210，导致
  desktop / agent-rt pod / 集成 rig 上 `prismer status` 一律误报「daemon 没在跑」）。
- **不变量（每条都是 j48 的一道门）**：① local-first —— 被拒**不停机**，本地 run 照跑照写产物；
  ② 离线 ≠ 被拒 —— socket 断只走 `ws-client` 自己的重连退避，**绝不**置 `declareBlocked`；
  ③ 正常重连不吃退避 —— 新 `authenticated` 重置阶梯（重连是高频路径）；④ 显式用户意图
  （装 agent / 切 workspace）解 park，这也是「我修好了，再试一次」的入口。
- **可调**：`PRISMER_DECLARE_INTERVAL_MS`（默认 30_000，钳 1s–300s）—— 心跳 declare 周期，
  整条阶梯以它为单位。生产默认不变，只给运维 / 集成测试压缩墙钟用。
- 测试：`test/declare-guard.test.ts` 16 条（分类表 + 阶梯算术 + 四条不变量，注入时钟）。
  贯通门 `scripts/test203/journeys/j48-declare-rejection-backoff.ts`：**真 daemon 进程**
  （从源码起）+ 逐帧记录的 stub cloud，6 条断言全取副作用（wire 上的 declare 帧数与间隔 /
  `/healthz` / `prismer status` 输出 / 磁盘产物）。负控 `--tamper` 用**源码级自动注入**
  （把 R5 从一份 src 拷贝里拆掉再起 daemon）：实测终态 3 帧 → 30 帧、退避间隔 6/8/16s → 恒 2s、
  `declareBlocked` 消失、CLI 无输出，四处如期翻红；local-first 与离线两条在 tamper 下仍绿
  （证明它们不是靠 R5 假绿）。

### Fixed — 桌面本地 provider 选择落不了库：`proxyProvider` 新增 `local:<profileId>` 命名空间

`AgentProfile.config.proxyProvider` 一个命名空间装两类值：云端 provider chain（云端全知）
与**桌面本地 provider profile**（只存在于用户机器的 `~/.prismer/config.toml`
`[[providers]]` + keychain，**云端结构性不可知**）。cloud 侧的写入校验只放行它认得的 id，
于是桌面用户从三个入口（`ProxyProviderSelect` / `ModelPicker` / composer 模型切换器）选中
本地 provider 时，每一次写入都 400 `invalid_proxy_provider` —— 这条漂移全仓无任何 doc 或
代码记录过，实测复现（`PATCH /api/im/agent_profiles/<id>` config.proxyProvider='qwen' → 400）。

修法是**加命名空间**而不是放松校验：`local:<profileId>` 自描述，cloud 零知识放行；裸的未知
链 id 照旧被拒（release202/12 C2 的防拼错能力一点没丢）。

- **`resolveLocalProvider()` 认两种形态**（`adapters/shared/local-provider.ts`）——
  `local:<id>` strip 前缀后按 `profile.id` 匹配；**裸 id 照旧匹配**（前缀出现之前写下的
  profile、手写 config.toml、既有测试全部不受影响）。新增导出 `LOCAL_PROVIDER_PREFIX` /
  `isLocalProviderSelector()` / `localProviderProfileId()`（cloud 侧的镜像副本在
  `src/lib/llm/local-provider-ref.ts`，**前缀字符串必须同步**）。
  `newapi` / `default` 的保留短路只对**裸** selector 生效 —— 显式 `local:newapi` 指的是用户
  正好这么命名的本地 profile，前缀说得毫不含糊。
- **未解析的 `local:` 不再被当成云端链走**（hermes `resolvePrismerProviderBaseUrl` +
  codex `resolveCodexPrismerProvider`）。profile 不在这台机器上 / key 未配 / 类型与该
  adapter 的 wire 不兼容时，旧逻辑会拼出 `/api/v1/proxy/local%3Aqwen` —— 每一发都 404。
  现在落回聚合器 `/api/v1`，与「没选」同一个降级面。**真的云端链 id 仍走
  `/api/v1/proxy/<chain>`**（这条闸严格限定在 `local:` 命名空间内）。
- 测试：`test/local-provider.test.ts` 新增 `local:` 命名空间 6 条 + codex 路由 2 条；
  新增 `test/hermes-local-provider-selector.test.ts` 5 条 —— oracle 取 hermes 真正跑的字节
  （`<HERMES_HOME>/profiles/<p>/config.yaml` 的 `custom_providers[].base_url` + `api_mode`），
  不是返回值。负控：拿掉 strip → 7 条红（实测）。
  贯通门 `scripts/test203/journeys/j44-local-provider-selector.ts`（真 endpoint + DB oracle）
  正向 PASS；`--tamper`（发裸 id = 修复前的前端）如期红，复现的正是那条 400。

⚠️ 本条需要 cloud 端配套（不在本包）：`src/im/api/agent-profiles.ts::validateProxyProvider`
放行 `local:` 前缀，三个前端选择器发带前缀的值。缺任一层用户仍撞 400。

### Added — F1-b：运行中的 daemon 可以改 workspace（`POST /v1/workspace` + `Runner.setDeclaredWorkspace()`）

用户在 daemon **已经在跑**的时候新建 / 切换 / 删除 workspace，daemon 与桌面此前**零感知**：
`config.toml` 没有 workspace 字段，`PRISMER_WORKSPACE_ID` 在 spawn 时就冻死，
`GET /workspaces/sync` 有 client 方法但**零调用方**（死代码）。daemon 会一直服务它启动时
的那个 workspace，直到整个 app 重启。

- **`Runner.setDeclaredWorkspace(workspaceId)`**（`daemon/runner.ts`）—— 新增
  `workspaceOverride` 字段，优先级**高于** spawn 冻结的 `PRISMER_WORKSPACE_ID`（原
  `sendDeclare()` 的取值链 `env || this.workspaceId` 里，env 永远赢，所以只改
  `this.workspaceId` 是够不到的）。改完立即 `sendDeclare()` 重新声明；socket 断开时
  只记录意图，下一次 `authenticated` 时带上。**幂等**：同 id ⇒ `changed:false` 且不发帧。
- **`POST /v1/workspace { workspaceId }`**（`daemon/local-server.ts`）—— 桌面主进程
  用它把用户当前的 workspace 推给在跑的 daemon。未接 `onSetWorkspace` 的 embedder 答
  **501**（而不是假装成功）。空串 / 非字符串 / 坏 JSON 一律 400 且不触达 runner。

**选 redeclare 而不是「切换即重启 daemon」**：重启会杀掉在飞 run；而 `agent.host.declare`
在 cloud 侧本来就是 refresh-on-redeclare（"the latest declare wins"，shadow 全拆重建、
binding 走 `handleHostDeclare` 对同一 daemon 返回 `refreshed`）。**实测**二次 declare 既
不报 409 也不报 `DAEMON_FORGOTTEN`，cloud 正常回 `host.acked`。

⚠️ **本条需要配套的 cloud 端修复才生效**（`src/im/ws/handler.ts`，不在本包）：cloud 的
workspace 解析链把 `im_containers` 行排在 `payload.workspaceId` 之前，而 local daemon 的
那行正是 handler 自己上次 declare 时写的 —— 于是 daemon 被**永久钉死**在第一次 declare 的
workspace 上。实测二次 declare 带新 workspaceId，**同一条 socket 上**和**整条连接重连之后**
cloud 都照样 ack 回旧的，静默无错。（这也是为什么「重启 daemon」那条退路同样修不好。）

- 测试：`test/local-server-set-workspace.test.ts`（5 条，真 HTTP，非 mock 路由）绿。
  真栈门：`scripts/test203/journeys/j43-daemon-workspace-redeclare.ts` —— 真 WS declare +
  `im_containers` DB oracle。正向 PASS；负控 `--tamper`（撤掉 redeclare）必红，实测红。

### Fixed — desktop205 R1-e：资产投递链的三条残留（`pendingByTask` 泄漏 / auto-scan 去重 / `bindSourceTask` 判别）

- **`bindSourceTask` 不再靠 id 形状猜**（`daemon/asset/deliver.ts`）。旧判据
  `taskId.length <= 30 && !/^(session:|run[:_])/` 是**已经在错**而不只是脆弱：
  `IMTask.id` 与 `IMTaskRun.id` 都是 `@default(cuid()) @db.VarChar(30)`，形状不可分；
  cloud 对聊天 dispatch 下发的 `payload.taskId` 就是 `IMTaskRun.id`，经
  `PRISMER_RUN_ID`（spawn 适配器）或从 `<execution_context><run_id>` 抄出的 `--run-id`
  （hermes）原样走到这里时，形状闸答"看板卡"并 stamp `sourceTaskId` = 一个 `im_tasks` 里
  不存在的 id（装得下 VarChar(30)，所以不 500，只是静默错绑 + 落进 `/tasks/<runId>`）。
  改为按判别式取真值：auto-resolve ⇒ run · 本机在飞 dispatch 的 `payload.kind`（新增
  `ArtifactsWatcher.activeTaskKind()`，由 dispatch.ts 用 `dispatchKind` 立键）⇒ 权威 ·
  `mode:'task-attach'` ⇒ 调用方显式声明 · 都问不到才回退形状闸**并打警告行**。
- **合成会话行不再往 `pendingByTask` 立无人抽干的桶**（`daemon/asset/deliver.ts`）。
  auto-resolve 落在 `task_id` 为 NULL 的行（`HermesSessionMapper` 的 `session:<id>` 合成行）
  时没有可搭载的 dispatch，`flushPending` 的两处生产调用都按 cloud dispatch id 取键，
  写进去的桶永远没人读、随 daemon 生命周期单调增长。现在不 record，`mode:'attach'` 的响应
  改带 `ridesReply: false` + 说明（资产仍上传并锚在 `/runs/<runId>`）。
- **auto-scan 上传方补上与 `recordDeliveredAsset` 同口径的 assetId 去重**
  （`daemon/artifacts-watcher.ts`）。cloud `POST /assets` 按
  `(workspaceId, contentHash[, sourceTaskId])` 去重并返回既有行，于是同一份文件走
  「写进 artifactsDir + 显式 `cloud deliver --mode attach`」两条路时同一个 assetId 会被裸
  `push` 两次，在 `reply.assetIds` 里出现两次。
- 测试：`test/desktop205-run-artifact-folder.test.ts` 新增 R1-e 7 条（每条正控配反向负控；
  fake cloud 复刻真 dedup 规则）。逐条注入故障验红：A `expected 1 to be +0`、
  B `expected [ 'ast_1', 'ast_1' ] to deeply equal [ 'ast_1' ]`、
  C `expected 'cmq5r8t1v0002wxyz' to be null`。

### Tests — `prismer banner` 的欢迎词行现在被 T0 钉住（apc/04 §5 样例 2）

`prismer banner`（非 `--compact`）在 banner 之前输出一行固定欢迎词
`Welcome to Prismer Cloud`（`src/cli/commands/banner.ts:13`，2026-07-26 由并行线落盘）。
这一行是**桌面本地 feed OTA 环的可观测 oracle**，但此前全仓没有任何测试断言它——
「测试选层绿」对这条改动是空的，apc/04 §5 强制的负控（欢迎词打错字 ⇒ T0 断言红）
**根本红不起来**。

新增 `test/banner-welcome.test.ts`（真 `buildBannerCommand()` + `parseAsync`，
不 mock 命令本体）：非 compact 必须写出该行，`--compact` 必须不写。

- commit `b3821c22`（首轮 2 条断言）+ `a3478605`（同一 task 的第二轮，锚定「欢迎词必须是 stdout
  第一行」并补 `--compact` 非空断言，共 6 条）
  （task `cms3dwas3034qxze2p6t857ch`，进开发审批 `cms3dwva3034xxze2md8n54yj`，
  发版审批 `cms3e9y7b03dlxze2c9fg2fva`）
- 绿：`apc test --tier=T0 --json` exit 0 —— T0(root) 56/56 · T0(runtime) 191/191 · T0(desktop) 13/13
- 负控红：同一命令在欢迎词打错字后 exit 1 —— T0(runtime) 190/191，
  `failedNames = ["test/banner-welcome.test.ts (vitest)"]`；红触发 H2 acceptance hook
  自动 redispatch（`im_tasks.metadata.acceptanceRedispatchCount = 1`）
- OTA 触达（本机 daemon channel local feed）：bundle `2.2.4-ota.1785166882`

### BREAKING — built-in role template `--from-template ceo` renamed to `--from-template team-manager`

`sdk/prismer-cloud/runtime/src/templates/roles/ceo.json`'s top-level `templateName` field changed
from `"ceo"` to `"team-manager"` (CEO→Team Manager internal naming pass, no compat alias kept —
scripts hardcoding `prismer profile create --from-template ceo` will now fail with "Unknown
template"; re-run with `--from-template team-manager`). This only renames the CLI-facing template
lookup key surfaced by `prismer profile templates` / `getRoleTemplate()` / `listRoleTemplates()`.
The role's internal routing identifier `roleTemplate.slug` stays `"ceo"` — unrelated code paths
(`profile-defaults.ts`, `orchestrator-lock.ts`, `workspace-orchestrator.service.ts`, …) that branch
on `slug === 'ceo'` are unaffected.

### Added — `gh-claim-readback`：第一个"他证"型判据（apc/17 §3 相 1 · W1.1 / W1.2）

`structured-criteria.ts` 既有 6 个 checker 的 ground truth **全部是被判进程自己能写的东西**
（它跑的那个文件系统、它能改写的 git 对象库、它自己建的 task 行）。apc/12 §0.10 记的实证：
一棵从没参与本仓库任何发版的独立代码树跑出的 `ota-promote` 产物，与本仓库产物**逐字节相同** ——
本地产物不携带运行身份。

新 checker 读的是 **GitHub 服务端签发、且绑死在一个仓库上的 id**：PR number / Actions `run_id` /
check-run `conclusion` / branch protection。声明词表 `GH-REPO:` / `PR:` / `RUN:` / `SHA:` /
`CHECK: <name> = <conclusion>` / `PROTECTION:`。

- **跨绑定比对**：回读对象的 `base.repo.full_name` / `repository.full_name` 必须等于声明的
  `GH-REPO` —— 一个真实但属于**另一个仓库**的 id 是 §0.10 的 free-ride 形态，即使传输层肯服务
  它也死在这一比。`repo` arg（skill.json 钉死）另挡"换成自己的 fork"
- **fail-closed 三态**（§7 边界 3）：无 `APC_GH_TOKEN` / 不可达 / 非 2xx **一律红**，不降级为
  `env_blocked`。branch protection 的 403 是只读边界在如实作答，仍然是红
- **`headShaMustEqualLocal`（W1.2）**：服务端 head sha 必须同时等于声明的 `SHA:` 与本地
  `git rev-parse HEAD` —— §0.10 列为"待建"的 run-scoped 运行标识的第一个真实现（三方必须同名，
  agent 只控其二）
- **判据侧不 spawn `gh` 二进制**（§3 相 1 ⚠️）：`gh` 对"没有 run"答 exit 0，而 doc12 §0.9 的
  同一形状已复发 5 次。走 REST + 强制字段比对，从源头不引入那个退出码语义家族。`apiBase` 只是
  skill.json arg、**故意不给 env 覆盖**：判据回读的端点不该由被判 agent 所处的环境来指定
- 测试：**传输不 mock** —— GitHub 响应形态的 fixture server 跑在**独立进程**里
  （`syncHttpGetJson` 是同步阻塞的，同进程 server 必死锁），checker 走真 HTTP。四条负控
  （编造 id / 跨仓库真 id / 无 token / 非 2xx）+ 变异证明：摘掉判定后这 11 条负控全部转绿

### Security — coding agent spawn env: 凭据 denylist 反转为 allowlist（apc/17 §8.1 W2.1′）

`filterCredentialBaseEnv` 之前问的是「这个名字是不是**已知的坏**」。拿本仓库 `.env.local` 的
57 个真实变量名实测：**拦 21 / 透传 36**，透传里包括一把**活的** SMTP 口令（`SMTP_PASS` —
`_PASS` 匹配不上 `_PASSWORD`）、`REDIS_URL`（URL 形态携带 `user:pass@`）、`SMS_ACCOUNT`、
`SMTP_USER`、`K8S_CLUSTER_URL`、`AUTH_URL`。补前缀只是同一形态的又一次枚举。

- **反转**：新 `isAllowlistedSpawnEnvKey()` 是唯一的门 —— 只有**显式列出**的键能从 daemon 自身
  `process.env` 继承进 coding agent。原来的名字形态规则降级为**第二道门**，防前缀族
  （`NODE_AUTH_TOKEN` 这类）夹带。判别式：一个谁都没枚举过的
  `FUTURE_VENDOR_CREDENTIAL` 现在**默认被拦**（denylist 下必漏）
- 大小写归一化到 UPPER：一次同时吃下 Windows 的 `Path`/`ProgramFiles`/`SystemRoot` 与小写
  `http_proxy`/`no_proxy`，不需要重复条目
- **`claude-code-cli` / `codex-cli`（runner.ts 的 D21 fallback adapter）接进同一个漏斗** ——
  这两条之前用裸 `{...process.env}` spawn，driver 那条修好了它们还开着，等于没修
- overlay 语义不变：`launchEnv` / `taskEnv` / `runtimeSettings.env` / `config.envVars` 在过滤
  **之后**合入，永远不被剥 —— 那是 code agent 唯一的鉴权通路（网关注入）
- 逃生门不变：`PRISMER_CC_NO_CRED_FILTER=1`，且只从 `baseEnv` 读（overlay 关不掉）
- ⚠️ **未纳入**：hermes gateway（`{...process.env}` 逐字继承，**零过滤**）、
  `daemon/shell-executor.ts`、`runner.ts::runShellCommand` —— 三条都不走本漏斗，见报告

### Fixed — task 产物根本不过 outbox（desktop205 O14）

W8 把断云契约修好了，但 `docs/desktop205/03-acceptance.md` §3.3 的「产物 = 落本地 + 进 outbox /
复联 = 补传成功」**只对 drop-folder 成立**。task 产物走的是完全另一条路：
`ArtifactsWatcher.deliverFile` / `upload()` 里的裸 `uploader.uploadAsset(...)` —— 不入队，失败
直接抛给调用方，文件留在 task workdir，**复联永不补传**（auto-scan 那条的重试还是纯内存的，
进程一死就没了）。`asset/origin/agent-gen.ts` 这个适配器早就在，但从没接线。

- **接线**：task 产物在**瞬时**上传失败（`isTransientUploadError`，W8 已有的分类器）时进
  `OriginOutbox`，由**同一个** `UploadRunner` tick 补传 —— 与 drop-folder 同一个队列、同一份
  持久化重试保证、同一个 tray/healthz 积压计数（W13）
- **语义选择：在线路径不变，只在「云不可达」时转异步**。不是"一律入队立即返回"——
  `send` / `message-attach` 两个 mode 结构上需要用 assetId 再打一次 cloud，一律入队会让这两个
  功能彻底不可用；而永久拒绝（4xx / policy / MIME）继续抛回调用方，agent 必须知道自己的文件被
  拒收，把它排进一个注定 dead-letter 的队列只会把可行动的错误藏起来
- **返回**：`attach` / `task-attach`（交付方式就是上传本身）⇒ **202** `{ok:true, queued:true,
  outboxId}`；`send` / `message-attach` ⇒ 字节照样入队（产物不丢）但**报 502**，因为消息动作
  确实没发生，说成功是 agent 会照着行动的谎。`ArtifactsWatcher.deliverFile` 返回类型改为
  `{status:'uploaded'|'queued'}` 判别联合（唯一调用方是 `asset/deliver.ts`）
- ⚠️ **`AgentGenAdapter.fetch` 原来读 `detail.bytes`（内存 Buffer），结构上无法过 outbox**
  —— outbox 存的是 `payloadJson = JSON.stringify(detail)`，Buffer round-trip 回来是
  `{type:'Buffer',data:[…]}` 而不是 Buffer（outbox 文件头也明写"不存字节"）。task 产物因此
  按 **path** 入队、drain 时从磁盘重读（与 drop-folder 同构）；`observedAt` 取 **mtime**，
  同一份未修改文件重复交付收敛成一行
- `SourceHints` 补 `assetKind` / `sourceTaskId` / `adapter` 三个透传位，否则补传出来的资产会
  是 `kind=file` 且**不绑看板卡** —— 那是"补传成功"的假象
- `test/desktop205-task-artifact-outbox.test.ts`（真 http server + 真 socket + 真 SQLite +
  真文件系统，零 mock；断云 = 真关端口）。负控四条，全部实测转红：不复联就断言补传 ⇒ 红 ·
  永久 4xx 仍必须 dead-letter（把分类器改成永不判死 ⇒ 红）· 摘掉入队那一步 ⇒ 正控 6/8 转红 ·
  同步路径遇 4xx 不得入队。另加 daemon 重启后仍补传（证明持久化不是内存重试）

### Fixed — 「归属换人」被当成「服务器确认它没了」（desktop205 O15 残留）

收紧到「404 且是我方信封」之后仍有一条通道能通过确认：cloud 的
`GET /agent_profiles/:id` 的 where 带 `workspace: { ownerImUserId }`，所以 **profile 还在、
只是 workspace 换了主人**（转移 / 换账号）时也回我方信封的 404 ⇒ 本地 profile + agent 行照删。
「不是你的」是权限变化，不是资源消失。

- **cloud 侧**（`src/im/api/agent-profiles.ts` GET `/:id`）：miss 分支再查一次「不带 owner 约束」
  的同 id，回 `{ok:false, error:{code:'forbidden'|'not_found', message:'Profile not found'}}`。
  判别位放 `error.code`，**HTTP 状态与 message 文本两个分支完全一致**（沿用 `workdirs.ts` 的既有
  范式；403 会把「这个 id 存在」抬到最易探测的那层）。额外查询只在 miss 分支
- **daemon 侧**：`confirmProfileGoneOnCloud` 的判据由「信封对」升级为
  **`error.code === 'not_found'`** —— 正向凭据。`forbidden` / 无 code 的老信封 / HTML / `{}` /
  其它状态码 / 网络失败一律不删
- **版本漂移是刻意的保守方向**：老 cloud 回裸字符串（无 code）⇒ 不确认 ⇒ 保留行。代价有界
  （脏 profile 留到 cloud 升级；`host.acked` 的 tombstone 路径 `computeProfilesToDelete`
  **本来就没有 owner 过滤**，仍会清真正删掉的 profile），反方向（误删活 agent 的行）不可恢复
- 负控实测：把判据改回「只要信封对」⇒ 归属换人那条**当场删光两张表的行**
  （`profiles:0, agents:0`），2 条转红；cloud 侧 `src/im/tests/acp-agent-profile-ownership-404.test.ts`
  在改路由前 4/7 红（两种 404 字节完全同形）

### Fixed — 删本地 profile 行用弱判据（desktop205 O15）

`syncProfileFromCloud` 只要 `CloudError.status === 404` 就删掉本地 profile + agent 行。真断云
给的是 `status:0`，所以当时是安全的 —— 但「404」≠「服务器确认这个 profile 没了」：captive
portal、反代误路由、滚动发布期的 404 都会命中，而这是**破坏性操作**。

- `CloudError.code` 帮不上忙：`CloudClient.request` 在 body 不是我们 `{error:{code}}` 对象时会
  **合成** `code:'not_found'`，nginx 的 HTML 404 与真 404 在 CloudError 上完全同形
- 改为要求一次**正向确认** `confirmProfileGoneOnCloud()`：用 `fetchRaw` 重读同一路由（保留了
  `request` 丢掉的原始 body），必须是 404 **且** body 是我们自己的 JSON 错误信封
  （`{ok:false,…}`，cloud 实回 `{ok:false, error:'Profile not found'}`）。HTML / 非 JSON /
  `{}` / 其它状态码 / 网络失败一律**不删**。只在 404 分支多打一次请求，正常路径不加
- `test/desktop205-profile-delete-warrant.test.ts`（真 http server 分别回我方信封 / nginx HTML /
  关端口，真 CloudClient，真 local.db；oracle 是两张表的行数）。把判据改回裸 404 ⇒ HTML 404 与
  `{}` 404 **当场删光本地行**，实测转红

### Fixed — 断云会永久毁掉产物投递（desktop205 W8，两个真 bug）

`docs/desktop205/03-acceptance.md` §3.3 的断云契约要求「产物 = 落本地 + 进 outbox」且
「复联 = outbox 补传成功」。实测（`test/desktop205-offline-outbox.test.ts`，真 http server +
真 socket + 真 SQLite + 真文件系统，零 mock）两条都不成立，成因是 `UploadRunner` 里两个叠加的
缺陷：

- **一次 `drainOnce` 烧光全部 attempts**。`recordFailure` 把非终态行直接放回 `'pending'`，
  而 `drainOnce` 的 `while(true)` 会在同一轮里**立刻重新 claim 这同一行** ⇒ `maxAttempts=3`
  的三次重试全部发生在同一次 drain、彼此之间没有任何时间间隔。配合 runner.ts 每 1 秒一次的
  drop-folder tick，**一次 1 秒的网络抖动就足以把一个产物判死**。
  修：一次 drain 对同一行最多消耗一次尝试（重复 claim 即释放并跳出）。
- **ECONNREFUSED 被算进 dead-letter 预算**。cloud 不可达属于"稍后重试"，不是"这些字节
  永远不会被接受"；旧行为把断云变成**永久数据丢失**（文件被移进 `upload-failed/`，复联后
  再也不会补传）。修：新增 `isTransientUploadError()`（socket 级错误码 / `fetch failed` /
  超时 / 408·429·5xx），瞬时失败**永不** dead-letter；4xx 等永久拒绝仍照旧判死。

负控（防"把 dead-letter 整个拆了"骗绿）：永久性 HTTP 400 仍必须在 maxAttempts 次后
dead-letter 并把文件移进 `upload-failed/`；以及"不复联就断言复联结果必须红"。

### Added — daemon 侧上报 tray 可观测性数据（desktop205 W13）

2026-07-26 裁决把桌面 tray 定位成**普通用户唯一的可观测面**（daemon runtime 是服务器形态，
`prismer` CLI 对桌面 daemon 结构性失明）。daemon 补上它此前从不上报的两项：

- **`/healthz.assetOutbox`** `{pending, uploaded, deadLetter, sampledAt}` —— 产物待传/失败积压。
  那次清理撞见 2 在飞 + 4 dead-letter，用户完全无从知晓。
  ⚠️ **计数由 producer 侧采样**：healthz 是纯内存零 I/O 快照而 tray 定时轮询它，
  handler 里做 `COUNT(*)` 会把每次轮询变贵。采样点是 drop-folder tick（本就每秒开这个 db），
  复用既有的 `pendingCount/uploadedCount/deadLetterCount`，新增的只是组合器
  `snapshotOriginOutboxCounts`
- **`/tasks/running.tasks`** `[{taskId, agentName?, kind?, scopeLabel?, startedAt}]` —— 在跑的是谁、
  归属哪个 workspace、跑了多久。`scopeLabel` 是 cloud 预渲染的 `identityContext.scope`
  **原样透传**（不解析）。**不含任务名**：wire 上根本没有 title，只有 `prompt`，而 prompt 是
  用户内容，不该画进菜单栏
- 两者都走既有 **spread 范式**：runner 没接对应子系统 ⇒ 字段整个缺席，
  **CLI / K8s 的 healthz 与 `/tasks/running` 形状逐字节不变**；且「没数据」与「数据是 0」
  在 wire 上就是可区分的（消费端不得 `?? 0`）
- `test/tray-outbox-healthz.test.ts`：真 SQLite outbox → 真 HTTP /healthz 断言积压数；
  负控三条（数据源置反 / 停止采样 / state 不带字段），并断言**反复轮询 healthz 不会改变读数**
  （证明零 I/O 没被破坏）

### Fixed — held-out deny 规则不再落共享 settings.json（desktop205 W4）

`ensureApcHeldOutDeny` 把 deny 规则 read-merge-write 进 **per-daemon** 的
`~/.prismer/claude-config/.claude/settings.json`，合并是 `new Set([...existing, ...rules])`
**只增不删** ⇒ 一次 APC run 置位后，同机此后所有 coding agent（含无关的用户 agent）
永久继承 held-out deny，且规则藏在 hermetic 目录里用户无从得知。

- `ensureApcHeldOutDeny`（有文件副作用）**删除**，换成纯函数
  `apcHeldOutDenySettings()` / `apcHeldOutSettingsArg()`，零文件系统副作用
- 规则改由 **per-run** 的 Agent SDK `Options.settings` 承载（= CC 的 `--settings` flag，
  CC 自己落到临时文件再读）。共享 settings.json 全程不被写
- 置位点从 `buildClaudeSpawnEnv`（env builder 不该有文件副作用）挪到 `buildOptions`
- ⚠️ 选 `Options.settings` 而非 `extraArgs.settings`：两者编译成**同一个** `--settings`
  flag，而 SDK 让 `Options.settings` 覆盖 extraArgs 项（`sdk.mjs`:
  `if (this.options.settings) k9.settings = this.options.settings`）。`buildFastModeOptions`
  已经在 fast-mode 机型上设 `Options.settings`，走 extraArgs 会在那些 run 上**静默丢掉**边界
- ~~已知残留：老机器上**已被污染**的 `settings.json` 不会自己消失，需一次性清理~~
  → 已由下面的 W4 迁移收掉

### Fixed — held-out deny 的**开关**也变成 per-dispatch（desktop205 W5 / F7）

W4 只消除了「污染永久化」，开关本身仍是 daemon 全局：`buildOptions` 调
`apcHeldOutDenySettings()` **不传参**，读的是 daemon 的 `process.env`。⇒ 想开这个边界，
只能给整台机器上所有 coding agent 一起开 —— 正是 W4 刚刚拆掉的爆炸半径又从正门走了回来。

- `buildOptions` 改为 `apcHeldOutDenySettings(sdkEnv)`：判据取**这次 spawn 真正拿到的
  env**。`buildClaudeSpawnEnv` 已经把 dispatch 的 per-task env（`extra.claude.env` →
  `taskEnv`，以及承载 cloud `metadata.skillConfigEnv` / `roleParamsEnv` 的
  `launchContext.env`）叠在 daemon env 之上，所以 per-task `APC_HELDOUT_DENY=1`
  只窄化这一次 run，同 daemon 并发的其他 coding agent 不受影响
- `test/apc-heldout-per-task.test.ts`：oracle 是**注入 queryFactory 捕获的真 SDK
  `Options`**（真 `ClaudeAgentSession` 跑真 `buildOptions`，探针不复刻合并逻辑）。
  负控 = 同一 client（同 daemon、`process.env` 全程不置位）两个 session，只有带标记的那个
  拿到规则；另一条负控 = per-task `'0'` 压过 daemon 全局 `'1'`
- ⚠️ **仍未接线**：cloud / daemon 两侧都**不存在**「这次 run 是 APC coding-scope」这个判据
  （`workdir.sourceRef` 从不与 repo 身份或 held-out 列表比对），所以通道就绪、置位方待定。
  ⚠️ 定位是 **hint 不是安全边界**——`Bash` 结构上就在 CC 的 file-permission check 之外

### Fixed — 一次性清理被 pre-W4 代码污染的 settings.json（desktop205 W4 迁移）

- 新增 `pruneApcHeldOutDenyFromSettings(configDir)`：从 `permissions.deny` 里移除**恰好等于**
  旧写入方生成过的规则（含已废弃的 `Write(...)` / `MultiEdit(...)` / `NotebookEdit(...)`
  三种拼法——那正是老机器上的大头），用**精确字符串相等**而非前缀/模式匹配，用户自建规则
  逐字保留；deny 变空则删该键，文件里其他内容一律不动。非抛出：文件缺失 / 不可解析 /
  不可写都是返回值，不是异常
- 落点是 `ensureClaudeConfigIsolation`：它本就拥有 hermetic 目录、在任何 CC spawn 前必跑、
  已是 per-daemon-process 缓存（= 一次性迁移想要的节奏），且只在隔离开启时触发——污染只可能
  在那个前提下产生。失败被吞，清理不阻断 dispatch
- `test/apc-heldout-deny-migration.test.ts`：oracle 是 settings.json 的**字节**。
  最吃重的负控是「用户自建规则必须存活」，含形似但不在列表里的 `Edit(scripts/test203)`
  （held-out 路径的前缀）、`Edit(scripts/test203/journeys/j11-…)`（held-out 目录**内部**）等；
  把实现换成子串匹配即变红
- 已知边界：若将来从 `APC_HELD_OUT_PATHS` **删除**某路径，磁盘上它的旧规则将不再可清理，
  需要单独补一条

### Fixed — deny 规则表按 CC 2.1.220 实际语法换代（desktop205 W3）

`APC_DENY_TOOLS` 从 `["Write","Edit","MultiEdit","NotebookEdit"]` 收敛为 `["Edit"]`。
CC 2.1.220 实跑证实：`Edit(path)` 是**唯一**参与 file permission check 的路径匹配器，
且它覆盖全部 file-editing 工具；`Write(p)` / `NotebookEdit(p)` 不参与，`MultiEdit`
已不是已知工具。**语义不减弱**，去掉的是每个 held-out 路径 6 条死规则（每次 spawn 54 行
stderr 告警）。

- 新增 `test/apc-heldout-cc-syntax.test.ts`（desktop205 G1）：拿**实际发出的** `--settings`
  payload 起一次真 `claude`（临时 HOME、无凭证、无网络——CC 在鉴权前就校验规则），
  断言 permission-rule 告警 **0 条**；负控塞一条 `MultiEdit(path)` 必须出告警。
  CC 二进制不可得时写 evidence 文件并 **loud skip**，不静默通过
- 旧 drift-guard 只比对**路径列表**、不校验规则语法，所以这次 CC 改语法我们完全不知道；
  G1 把「CC 升级悄悄废掉我们的规则」变成可检出

### Fixed — APC skill 源随包分发（desktop205 D8）

`sdk/apc/skills/` 此前**只存在于 repo working tree**。`resolveApcSkillsRoot()` 从运行
模块向上walk，因此在任何非 repo 宿主（OTA bundle / npm 装的 daemon / 桌面
`resources/runtime`）都返回 null ⇒ `installPlatformApcSkills()` 返回 null ⇒ **什么都不装**。
这是藏在平台门背后的第二道静默门，与 2026-07-19「bundle 漏 plugins/ ⇒ 记忆层全黑」
**同一失败模式**（打包清单与真实依赖各自演化），修法沿用那次的范式。

- prebuild hook 现镜像 **两个**源进包根：`built-in-skills/` + 新增 `apc/skills/`
- `package.json` `files` 增加 `apc`（npm tarball 已实测含全部 35 个文件）
- 两个 OTA 打包器（K8s `build-daemon-runtime-bundle.ts` / 桌面 `build-daemon-bundle.cjs`）
  stage `apc/` 并在各自 REQUIRED_ENTRIES 里校验
- `BUNDLE_REQUIRED_ENTRIES` 与桌面 `REQUIRED_ENTRIES_BY_KIND.daemon` **同步**加
  `apc/skills`——缺 skill 的 bundle 判为不可用，而不是静默降级
- 桌面 `assemble-runtime.sh`（built-in 兜底层，被 `resolveDaemonBundlePath()`
  **不经校验**直接返回）补 stage `apc/` **与 `plugins/`**。后者是本次挖出的既有缺口：
  2026-07-19 那次断言「floor 总是 memory-capable」只对 K8s 镜像成立，桌面这层手工
  组装的 floor 从来没有 `plugins/`
- 新增 `test/apc-skill-distribution.test.ts`：仓外临时目录里 esbuild 打真模块 → 断言
  `resolveApcSkillsRoot()` 真返回存在路径（正控）；删掉 `apc/skills` 后断言解析为 null
  **且** `isValidBundleDir()` 判红（负控）；四处清单再分叉即红（drift 门）

### Fixed — launchd boot shim 是第三份 REQUIRED_ENTRIES 且早就漂了（desktop205 O11）

`apps/desktop/electron/daemon-boot.cjs` 的注释自称与 `bundle-manager.ts`
"same contract … keep them in sync"，实际只要 `dist/cli.js` + `package.json`——
2026-07-19 加的 `plugins/` 和 2026-07-26 加的 `apc/skills` 都没跟上。
⇒ **launchd 会启动一个 host 进程判为无效的 bundle**，而「缺 plugins 的 bundle 被启动」
正是那次记忆层全黑事故的形状。

- shim 的 **bundle** 判据收紧到与另两份逐字节一致（4 项）
- **兜底层判据刻意更弱**（只要 `dist/cli.js` + `package.json`）：floor 是用户与
  「这台机器没有 daemon」之间的最后一道，因为缺 `plugins/` 就拒绝启动它 = 把「降级的
  daemon」变成「没有 daemon」，还会被 KeepAlive 无限重放。这与 host 侧完全一致——
  `resolveDaemonBundlePath()` 校验 staged/current **bundle**，然后**不校验**地返回
  builtin。保持 floor 有能力是打包步骤的职责（`assemble-runtime.sh`，已有断言）
- 不从共享模块 require 清单：该文件**只 import node builtin** 是它的立身之本
  （生成物 = 又一个能在「绝不许起不来」的路径上丢失的东西）。改用 drift 断言机械化
- `apc-skill-distribution.test.ts` 的 drift 门从四处扩到**五处**，并把「floor 判据必须是
  bundle 判据的真子集」也钉住，让这条不对称保持是**决定**而不是退化成漂移
- `apps/desktop/electron/__tests__/boot-shim.test.ts`：oracle 仍是 marker 文件
  （**哪个 cli.js 真的跑了**）。新增负控——缺 `plugins/` 的 bundle 与缺 `apc/skills` 的
  bundle 都必须被拒且回落到 floor；配套反向负控：完整 bundle 仍能启动（证明门不是无条件拒绝）、
  缺 `plugins/` 的 **floor** 仍能启动、缺 `dist/cli.js` 的 floor 仍 exit 1

### Added — skill 验收判据引擎：新增 `type:"structured"` 与 6 个 checker（补记）

> **补记说明**：这批改动分 4 个 commit 落地（`4f17c311` / `689ea719` / `e82db478` /
> `c3d91481`）**均未更新本文件**，违反 CLAUDE.md「改 `sdk/*` 任何包必须更对应
> CHANGELOG」。由 apc/12 的 code-review 验收跑在审 `c3d91481` 时作为 **convention
> 段 major finding** 抓出——这正是该 skill 该抓的东西，故在此补齐而非静默略过。

`bundle` 的 `matchAcceptanceCriteria` 新增 `type:"structured"` 判据类型（`substring`
/ `regex` 两条既有路径**逐字节不变**；未知 checker fail-closed）。动机：原判据全部
读 agent 的**报告文本**，因此原则上无法区分「真跑」与「编造」——实证一份零检索、
路径行号瞎写的纯编造报告可拿满分。

**层 2（复核报告关于「文件」的声称）**

- `cited-evidence` — 每个 `path:line` 读回磁盘（存在/行范围/非空行/锚定命中/行数下限）
- `dimension-coverage` — 每维独占 keyed 行，答案须是可复核引用或 `N/A — 理由`；
  可选 `requiredVerdicts` 钉某维 verdict；可选 `anchorToKey` 要求引用落在**声明该维的那一行**
- `doc-sync-obligations` — 从 delta 自行重算义务集与 gap 集再比对

**层 3（复核关于「运行时副作用」的声称）**

- `json-claim` — 重解析报告内 fenced JSON：钉 schema/形态、散文数值 ⇄ 产物字段、
  派生判定须由退出码推出、每层算术、`baselineRecompute`、`freshArtifacts`（产物 mtime
  与自带 timestamp 同期）、`filesExist`、`fileEquals`
- `declared-id-readback` — `TASK:/ASSET:/CRITERION:/META:` 声明的 id **回读真 API**
  （含存储 JS 类型，`--set` 的数字化在此被逮）
- `git-claim-readback` — 只读 git plumbing：commit 文件集恰好等于声明、branch tip、
  push 落点须为本地 bare 替身、被拒 prod tag 不在其上、冲突仓 `MERGE_HEAD` 仍在

I/O 走同步子进程（HTTP 经 `execFileSync(node -e fetch)`，token 由 env 传不进 argv；
git 全只读），**`matchAcceptanceCriteria` 签名未变**，两个 CLI 的 `normalizeCriterion`
同步保留 `checker`/`args`（否则结构化条目会降级成 substring 而恒红）。

### Fixed — `dimension-coverage` 的 `anchorToKey` 配错不再静默 fail-open

`anchorToKey` 此前经 `argRecord` 取值，对任何非 plain-object 返回 `undefined` ⇒
`true` / `[{…}]` / `"minAnchored:1"` / 键名手滑，**都会静默退回加严前的行为并报满绿**。
而该 arg 存在的唯一理由就是堵「label 承诺大于实现」那个洞 ⇒ 静默跳过使这道守卫沦为
装饰。现改为显式 `checker misconfigured` 判红，与本文件既有惯例一致（`dimensions` /
`requiredVerdicts` / `deltaFiles` / `json-claim` args / `allowed.*` 早已 fail-closed）。
**缺省不置位时行为仍逐字节不变**，不追溯打红已按旧语义验收的判据。

### Fixed — `CITATION_RE` 缺 `%` 导致引用真实文件被判编造

路径字符类与 lookbehind 排除集均不含 `%`，而仓库有 19 个真实的 `%5F` 路径文件
（admin debug endpoint）⇒ 被解析成 `5Fadmin/...` 判 FAKE。对 `cited-evidence`
（`bad.length > 0 ⇒ fail`）是**无条件红**——**这类「如实判红」比「编造判绿」更隐蔽**，
因为它看起来像判据很严。已补 `%` 并加回归；存在性检查未放宽。

### Fixed — APC skill 只投平台 workspace，源改工作树（判据修正）

上一版把「谁能拿 APC skill」判据挂在 **cloud 的逐 agent 安装记录**上。用户随后给出平台
workspace 的正式定义，两条都推翻了它：

1. **APC 范围的 skill 只在唯一的平台 workspace 安装**，只用来做 prismercloud 工程本身，
   **不需要任何发布动作**。⇒ cloud catalog 不该出现在内容路径上（它当时只有 17 个里的 7 个，
   且比工作树旧几天）。
2. **平台 workspace = 平台管理员账号绑定的 workspace**。⇒ 判据是 workspace 的 owner，不是
   agent 的安装行。旧判据选错了对象：真机上被投中的 agent 属于一个**非平台** workspace。

**新判据**（`isPlatformWorkspace`，daemon 侧）：

- `GET /api/im/workspaces/:id` → `ownerImUserId`；`GET /api/im/users/lookup?identifier=<email>`
  → 平台管理员的 imUserId；相等即平台 workspace。两个都是既有 endpoint，**cloud 侧零改动**。
- 管理员白名单读 `ADMIN_EMAILS`（与 cloud `admin-rbac.ts` 同一个 env、同一套 lowercase 归一）。
- **不问 cloud「我是不是 admin」**：`isSandboxAdmin()` 在 `NODE_ENV !== 'production'` 对任何人
  短路返回 true，拿它当高危投递的门在 dev 等于没门（apc/14 A3 的教训）。这里是
  `isAdminEmailStrict` 的 daemon 侧镜像。
- **fail-closed 覆盖每一种 unknown**：白名单未配置/为空、profile 没有 workspaceId、workspace
  读不到（非成员 404 / 网络错 / 报文异常）—— 一律判 false，且 false 不只是「不装」，而是把
  entitled class **reconcile 成空**（非平台机器上残留的 APC 目录与新装同样是泄漏）。
- verdict 有缓存：正判 30min、负判 60s（`/users/lookup` 是 30/min 限流；正判长 TTL 让已证实的
  平台机器在云端短暂不可达时不掉工具链）。

**源改工作树**：`resolveApcSkillsRoot()` 从模块位置向上找 `sdk/apc/skills/`（dist 3 跳、src 7
跳），`installPlatformApcSkills()` 直接 cpSync。永远是最新版、无需发布、cloud 退出内容路径只
留授权路径。npm 安装态找不到该目录 → null → 不投（只有平台 checkout 才有源）。

**保留未动**：`persistence → hermes only` 的门逐字节未动；`.prismer-managed` /
`.prismer-entitled` 两个互不相交 managed class 与各自 reconciler 的归属护栏；
`resolveCodingCwdSkillsDir()` 的 claude-code-only 目标解析。

测试 `test/coding-skill-entitlement.test.ts` 18 → **33 例**，四处判据变异全部真红（平台门恒真
→ 6 红；白名单空时静默兜底 → 2 红；去掉 persistence 拒绝 → 2 红；去掉外来目录护栏 → 2 红）。
真机（活 daemon 未停未重启，走真 endpoint）：平台 workspace 的 coding agent 拿到 **17/17**
且含工作树独有的「输出契约」节；非平台 workspace 的 agent **0 个**且旧的 7 个被 evict，12 个
`.prismer-managed` 与用户的 `sdk-release` 完好；`ADMIN_EMAILS` 未配置时对**真平台 workspace**
也是 0 且目录不创建。

### Fixed — structured acceptance checkers: three contract↔checker misalignments that reddened truthful reports (apc/12)

端到端真跑（真 daemon → claude-code → 真回帖）证实结构化 checker 的机制是对的（编造报告
`18 citations / 0 verified on disk` 判红，同一份报告下三条旧 regex 判据仍全 PASS），但同时暴露
**三条会把 100% 如实的报告判红**的缺陷。「无论对错都会红」与「无论对错都会绿」是同一类 bug。

- **`CHANGE-POINT` 正则拒绝整行反引号包裹**：前导字符类 `^[\s>*\-|]*` 不含反引号，而
  `impact-trace` sample prompt 自己给的范例就是整行包裹的 —— 照抄范例 → `no CHANGE-POINT
  declaration found`。前导类补反引号。
- **`rg -c` 的 `path:COUNT` 被当行号复核**：契约明令跑 `rg -c` 对账，其输出正是 `path:数字`。
  新增 `parseClaimCitations()`：整行只有一个裸 `path:数字` 的行（即 `rg -c` 输出）不采为
  citation；`parseCitations()` 保持字面语义不变（调用方会传单行片段给它，容差不能落在那里）。
  契约侧同步要求计数写成 `count=N`、不得内联进句子——内联即恢复为声明并照常复核。
- **缩写路径判 FAKE 且文案误导**：`verifyCitation` 的失败文案改为点名契约规则
  （REPO-ROOT-RELATIVE / `rg -c` 计数不是行号），契约侧显式写明必须 repo-root-relative。

### Added — `dimension-coverage` 支持钉死 verdict（`args.requiredVerdicts`）

`{ "<dimension>": "covered"|"gap"|"n/a" }` 要求该维度**自己那一行**以指定 verdict 开头
（中文 `已覆盖`/`缺口`/`不适用` 同义）。没有该 arg 时行为逐字节不变；有该 arg 但行上无
verdict token、或 verdict 不符、或 `requiredVerdicts` 指向 `dimensions` 之外的键 → fail-closed。
这是 `design-review` 五维审计的承重 oracle：没有它，「五维全标 covered + 正文某处出现 gap 一词」
是一次照样打绿的橡皮图章。

测试 `test/bundle-structured-criteria.test.ts` 25 → 36 例（新增 11，每条正控配负控，含
「照契约范例逐字产出的报告必须绿」一组）。

### Added — APC held-out write DENY at dispatch (apc/14 D6，双重约束的 dispatch 侧)

docs/apc/02 §2 R4 的"双重约束"要求 held-out（`baseline.json` / journeys / contract gates /
视觉基线）**物理上打不开写**。review 侧的 diff 门（`scripts/test203/run.ts --review-diff`，
不依赖 agent 诚实）已成；本条补上 dispatch 侧的 deny。

隔离 CC 的 hermetic `settings.json`（`~/.prismer/claude-config/.claude/settings.json`，
即 CC 的 `user` settings source）种入 `permissions.deny` 规则——`Write/Edit/MultiEdit/NotebookEdit`
命中 held-out 路径即被 CC 二进制**硬拒**（deny 是硬边界，即使 `bypassPermissions` 模式
`canUseTool` 谓词根本不被调用也生效，故落点选 settings.json 而非谓词）。

- **门**：`APC_HELDOUT_DENY=1`（dispatch 侧显式开，默认 OFF——普通 coding agent 写权限不受影响）。
  且只在 config 隔离开启（默认 ON）时生效，绝不写用户真实 `~/.claude`。
- **单一真相源**：`config-isolation.ts::APC_HELD_OUT_PATHS` **镜像**
  `scripts/test203/heldout-guard.ts::HELD_OUT_PATHS`（runtime 包 `rootDir=./src` 无法跨包
  import，故镜像 + drift-guard 测试读源文件断言两份集合相等——漂移即红）。
- **不误伤**：只拒 held-out 写；普通源文件（含 `scripts/test203/run.ts` 本身）、读操作不受限。
- 落点 `config-isolation.ts`（`isApcHeldOutDenyEnabled` / `apcHeldOutDenyRules` /
  `ensureApcHeldOutDeny`，read-merge-write 幂等，不丢无关 settings），种入点在
  `agent.ts::buildClaudeSpawnEnv`。契约测试 `test/apc-heldout-deny.test.ts`（8 例，每正控配负控，
  三处变异各自转红）。端到端（真 CC 进程试写 baseline 被拒）本轮未跑（无活 daemon）。

### Fixed — daemon churn 放大成请求风暴（APC Root B：sync/ack 无 backoff + host.acked 全量再同步）

gap A（下条）用有界 undici dispatcher 封住了请求风暴的**爆炸半径**，但**没治源头**。源头
是一个 churn 循环（`ownership rejected → adopt → re-declare`）让 `host.acked` 在短窗内**连发多次**，
而每次 `host.acked` 都会 (a) 触发一遍**全 workspace** 的 cloud→local memory 再同步，(b) skill-sync
路径**重发每个 skill 的 ack**——**攻击之间无 backoff、快速触发不合并**。打到慢 cloud 上就是自我放大
（实测 `skill sync ack failed` ×85 / `Request aborted/timeout` ×107）。

**修**（新模块 `src/daemon/churn-guard.ts`，两个纯 + 可注入时钟/RNG 的原语）：

- **`ExponentialBackoff`** — 连续失败 → 下次尝试延迟 `base·factor^n`（封顶 + ±抖动），成功即重置。
  用于 skill-sync **ack 门**（`skill-sync.ts::ackSkillSync`）：按 `(agent,slug)` 记账，一个刚失败的
  ack 在其指数退避窗口内**跳过重发**（下个自然触发在窗口过后重试，不丢 ack、只是不再猛砸）。base 2s /
  cap 60s。env kill-switch `PRISMER_DAEMON_ACK_BACKOFF=off`。
- **`CoalescingRunner`** — 把短窗内的 N 次 `trigger()` **合并成一次** trailing run，失败后按 backoff
  拉开重试间距。`memory/runner-wiring.ts::syncMemoryFromCloud` **改为 debounce**：churn 期一串
  `host.acked` 只落**一次**全 workspace fan-out（workspace 并集）；整体不可达时按指数退避重试而非
  每 tick 再发火。默认 1s 窗口（非延迟敏感，见 cloud-dispatcher.ts 注释），env
  `PRISMER_DAEMON_MEMORY_SYNC_DEBOUNCE_MS=0` 可关。

只改 retry/trigger 的**节奏**，不掩盖竞态、不放松任何断言。单测断真行为（间隔指数增长、N 次触发只跑 1 次、
失败按 backoff 拉开），每条修复配一条"原本会抓到它"的变异用例（拆 backoff 成恒定间隔 / 拆 debounce /
拆 ack 门 → 分别红 4/4/1 条，已实测）。**诚实边界**：本轮只证 backoff/debounce 的**逻辑**有牙；真活
daemon 下"连接不再涨"的前后对照未跑（有界 dispatcher 已封半径，主会话可随后验）。孤儿 council daemon 的
**根治 = 孤儿 conversation soft-delete cascade**，属 `project_orphan_conversations_survive_workspace_soft_delete`
深域，不在本次。

### Fixed — daemon cloud fetch 连接池无上限，churn 会撑爆慢 cloud（APC gap C）

daemon 的 cloud HTTP 客户端（`auth.ts CloudClient`）用 Node 内置 `fetch`，即 undici
**默认** global Agent——对单一 origin 的连接数**无上限**。任何请求风暴（如 adopt/ownership
churn 在每次 `host.acked` 重放 memory-sync + transport-probe + skill-sync-ack、且无 backoff）
打到一个**慢** cloud（本机 `npm run dev`，HTTP/1.1）时，undici 每个并发请求开一条**新** socket
而非复用 ⇒ 连接爆涨（实测单个 daemon 攥住 **345 条**空闲 ESTABLISHED socket 到 :3000），
把单线程 dev server 的 event loop 饿死（连静态路由都从 0.005s 涨到 24s），并形成恶性循环
（慢 → 30s 超时 → 重试 → 更多 socket → 更慢）。删掉该 daemon，server 连接 711→5、延迟 24s→5ms，
把病因隔离到 daemon 的无界连接池。

**修**：daemon 前台启动时（`daemon.ts::runForeground`，任何 cloud 请求/SSE 之前）安装一个
**有界** undici global dispatcher（新模块 `src/daemon/cloud-dispatcher.ts`）：`connections` 上限
（默认 24，`PRISMER_DAEMON_MAX_CLOUD_CONNECTIONS` 可调）+ keep-alive 复用。再大的风暴也只能开
≤N 条 socket，超额请求在 undici 内排队而不是拿新 socket 砸服务器——结构性封住爆炸半径。
实测 200 并发请求打慢服务器：修前 200 socket，修后 24 socket。WS（走 `ws` 包）与 asset 下载
（自带 per-request dispatcher）不受影响。**注**：这只封上限，不治真正的驱动（churn 循环 +
skill-sync-ack 无 backoff），后者是另一个更深的 bug。

### Fixed — daemon git RPC / workdir jail：三个对抗评审坐实的真缺陷

评审用真 git 复现，全部已修 + 补回归用例（`test/git-rpc.test.ts` 26 例，
`test/workdir-materialize.test.ts` 25 例，全部带负控）。

1. **非冲突的 git 失败被误判成 `conflict`**（`git-rpc.ts`）。旧实现对 git 的**错误文本**
   做子串匹配（`/conflict|automatic merge failed|unmerged files/i`），而 git 会把调用方
   给的 ref 名回显进错误里 ⇒ `branch fix/conflict-handling`（分支已存在）和
   `merge feat/conflict-x`（ref 不存在）都被判成 `conflict` 且 `files=[]`，一路透到 CLI 打印
   "Merge conflict — NOT auto-resolved. Escalate to a human. Conflicted files (0)"——
   把拼写错误渲染成需要人类介入的冲突。**现在判据取副作用**：git 自己的未合并索引
   （`git diff --diff-filter=U`）或在场的 `MERGE_HEAD`，与错误文本无关。真冲突的
   `files` 因此恒非空。
2. **jail root 可由 payload 抬高**（`git-rpc.ts::runGitExecRequest`）。`workspaceId` 是
   拼进 `workspacesDir` 的**路径段**，而它只校验了 `typeof === 'string'`；`path.join`
   会归一化 `..` ⇒ `workspaceId:'ws_A/..'` 把 jail root 抬到 workspaces 目录，
   实测在**另一个 workspace 的 repo 里建出了分支**。现在用 `isSafeSegment` 校验段。
   （cloud 侧 member 门此前挡住了 HTTP 可达性，所以这是纵深防御层的洞——而
   daemon jail 存在的全部意义正是"cloud 错了也不塌"。）
3. **jail 是词法的，symlink 可越狱**（`git-rpc.ts` + `workdir-materialize.ts`）。包含判定
   走 `path.resolve`，不解 symlink；而能在 workdir 里种 symlink 的正是这道 jail 针对的
   coding agent 本人。实测 jail 内 `ln -s <外部 repo> link` + `cwd:'link'` ⇒ 外部 repo
   真被写了分支。现在包含判定走 **realpath**（新模块 `src/daemon/path-jail.ts`），
   且返回解析后的真实路径（不再从 symlink 穿过去执行）。

**新增内部模块** `src/daemon/path-jail.ts`：`isSafeSegment` / `realpathBestEffort` /
`resolveWithinJail`。安全谓词只此一份——重复实现必然漂移。

**顺带修的既有债（与上面 3 条分开记账）**：`runner.ts` 的
`agent.fs.list` / `agent.fs.read` / `agent.fs.write` / `agent.workdir.materialize`
用同样的方式拼 jail root，同样没校验段，现在四处都加了同一个守卫；
`resolveWorkdirCwd` 的词法 jail 同步改成 realpath 判定。

**行为变化**：`resolveGitCwd` / `resolveWorkdirCwd` 返回的 cwd 现在是 realpath。生产
路径（`~/.prismer/workspaces/...`）无 symlink，解析前后一致；仅测试夹具里的
`os.tmpdir()`（macOS `/var` → `/private/var`）会看出差别。

### Added — daemon git RPC 接线 + 硬化（APC P0-5 / apc/05 §1 A2）

`src/daemon/git-rpc.ts` 此前**已存在但零调用方**（只在 `index.ts` export）。本次接线成
`agent.git.exec` reverse-RPC（`runner.ts` 新增 case，回 `agent.git.reply`，镜像
`agent.workdir.materialize` 的形态），并补四项硬化：

1. **cwd jail** —— 新增 `resolveGitCwd(root, cwd)`（镜像 `resolveWorkdirCwd`）。
   `GitRpcRequest.root` 现为**必填**（fail-closed）；root 由 daemon 自己从
   `workspaces/<workspaceId>` 算，不接受 payload 指定。
2. **remote allowlist** —— push 的 remote 必须是白名单里的**纯名字**（默认 `['origin']`，
   `PRISMER_GIT_REMOTE_ALLOWLIST` 可覆盖）。URL 形态与 option 形态
   （`--receive-pack=…`，可在对端执行命令）在进 argv 前就被拒。
3. **commit / merge 回 sha** —— `GitRpcResult.sha`，供 task↔commit provenance。
4. **冲突返回文件清单** —— `GitRpcError.files`（`git diff --name-only --diff-filter=U`），
   worktree 保持现场（不 `merge --abort`、不 reset）。

其它：错误 detail 现同时读 stderr+stdout（git 把 CONFLICT 写 stdout，旧的 `||` 链在
stderr 非空时会丢掉冲突文本）；git 子进程加 120s 超时（旧实现对不可达 remote 会永久挂）。

**破坏性（内部 API）**：`gitRpc()` 的 `root` 必填。此前零调用方，无外部影响。

### Fixed — drain_respawn no longer hangs on stop()（product205 OTA）

`armDrainRespawnWatcher` 不再 `await this.stop()`——`stop()` 里的
`await servicePool.shutdown()` / `await localServer.stop()` 可能无限卡住
（adapter 子进程不退出 / HTTP 连接不关闭），导致 `process.exit(0)` 永远
到不了，daemon 不退出，kubelet 不重启，OTA 中断，用户必须手动重建 pod。

修法：drain_respawn 只做同步清理（关 WS + abort in-flight + stop SSE）
然后直接 `process.exit(0)`。K8s/desktop supervisor 重启进程，OS 回收
所有资源。

### Fixed — OTA bundle 纯净化（product205 OTA 空腔修复）

OTA bundle 构建 6 个空腔全部修复：
1. `127.0.0.1` artifactUrl 不可达 → `host.docker.internal`
2. `redis-cli` 不存在 → 用 `ioredis` 清 apply blob
3. 版本黑名单 → 发新版本绕过
4. macOS native 二进制（`fsevents.node` / `rollup.darwin-arm64.node`）→ 删除
5. `built-in-skills/` 缺失（`readSkillText` throw）→ 补进 bundle
6. `better-sqlite3` 目录残留导致 `linkBuiltinNativeDeps` 跳过 → 整个目录删除

### Added — action governance runtime P1（product205 M6）

daemon-side runtime enforcement seam reopens（docs/product205/03 §3.4）：

- `HERMES_YOLO_MODE` 从硬编码 `'true'` 改为 `runtimeApprovalMode` 驱动（team=gated
  → YOLO off → dangerous-command 桥激活；personal=auto）
- `--dangerously-skip-permissions`（claude-code）改为 `runtimeApprovalMode` 条件化
- Hermes `approval.request` SSE 事件捕获 §3.5 bundle（`buildApprovalBundleFromHermesPayload`
  + `classifyActionClass`），透传到 `SessionsSseResult.approvalBundle`
- bundle 传播：sessions-sse → sessions-dispatcher → runs-dispatcher → AdapterResult.metadata
- `dispatch.ts` `finalError` 附带 `approvalBundle`（runtime-hook 源）随 `task.dispatch.reply`
  上报 cloud（code=awaiting_human_approval）
- `turn.ask_human`：`task.dispatch.reply` error code=awaiting_clarification + clarifyBundle

### Added — persona seatScope（product205）

`CreateAgentForWorkspaceInput` gains `seatScope`（'workspace' | 'council'）。
Council convene 创建 persona agent 时标 `seatScope='council'`——不占 workspace
席位、不出现在 agent roster。需配合 cloud 侧迁移 523。

### Added — general-assistant role template（product205 M4）

平台默认 deputy role 模板（通用助理），member first mile accept-provision 用。


### Fixed — persona role: cloud MCP allowlist（product205 M0 · AC-C6）

persona role 模板此前 `mcpServers: []`——persona-agent 在 cloud MCP 面无限制
（可调 `prismer.task.create`/spend），与动作治理能力黑名单冲突（strip 后暴露为
load-bearing）。补 discussion-only `toolsAllowlist`（memory read/recall ·
agent/message send · asset 只读；task/skill/publish/spend 面按 allowlist 语义省略即拒）。
oracle：`council-m2` 正测 `config.mcpAllowlist` 转绿 + 参数化负控（persona 拒
`task.create`、orchestrator 同工具放行对照）。


### Added — role/council-scoped memory writes（product204 E4）

打通 role/council 可见性从 tool → daemon store → outbox envelope → cloud 的全链
路（cloud 侧 `POST /api/im/memory/pages` 早已 honor `body.visibility`，缺口全在
daemon/tool 侧）：

- `MemoryVisibility` 联合新增 `{ kind:'role'; slug }` / `{ kind:'council'; id }`；
  所有 switch/consumer（store 写入+hydrate、cloud-sync `parseCloudVisibility`、
  boundary `acl-predicate`、rpc `visibilityToString`）穷尽处理新 kind。
- `rpc.ts`：`visibilityToString` emit `role:<slug>` / `council:<id>`（cloud
  memory-acl 期望的确切串形态）；新增 `parseVisibilityString` 把 memory_write
  工具传来的 `role:<slug>`/`council:<id>`/`agent:<id>`/`workspace` 串解析回联合，
  缺失/未知安全降级为 `workspace`（D3 保守默认）。
- `memory-tools.ts`：`MemoryWriteToolInput` + `MEMORY_WRITE_INPUT_SCHEMA` 增可选
  `visibility?: string`（`required` 仍为 `['path','content']`）。
- boundary ACL：role/council 作为粗粒度共享 scope 在 daemon 边界按 workspace-可见
  处理，真正的成员治理留 cloud 超集。
- 新增回归 `test/memory-visibility-scope.test.ts`：断言 outbox envelope 串
  `council:<id>`/`role:<slug>` 精确落地 + 负控（缺失→workspace、未知→workspace）。

### Fixed — 代码评审整改（feature/release203 批次）

- **hermes gateway 每轮杀重启风暴**：`writeHermesGatewayStamp` 写盘失败（profile
  dir 不可写）时，`hermesGatewayConfigDrifted` 把本进程刚 spawn、只是没记下的
  gateway 当成无见证孤儿 → 每条消息 kill+respawn、清空会话上下文。spawn 时同时在
  内存里见证（键用 stamp 绝对路径，生产复用/测试隔离两不误），写盘失败也不再 churn。
  补回归负控 `test/hermes-gateway-stamp.test.ts`（抽掉内存兜底即翻红）。
- **`cloud role test` 把瞬时网络错误当「skill 不存在」**：只有 404 才是真缺失；
  status 0 / 5xx / timeout 归为 `unreachable`（exit 2 + 「transient, retry; do NOT
  rebuild」），不再误导 agent 去重建已存在的 skill。

### Added — `prismer skill|role` 发布后治理七动词（product204/21 M-P W3）

发布之前有 `publish`，发布之后此前**什么都没有**。补齐镜像动作，skill 与 role
两个命名空间同构（blueprint 无 CLI 命名空间，仅 HTTP + Studio）：

- **`delist <slug> [--reason]`** / **`relist <slug> [--changelog]`** — 退出/回到
  Marketplace 的**可见性单轴翻转**。存量使用者零影响（skill 已装 agent 继续
  同步内容、role 继续投影）。relist 不是新端点，是重跑该资产自己的 publish
  端点——publish 的门（license / SS-02 / takedown 锁）因此只有一份实现。
- **`deprecate <slug> --reason <r> [--successor <slug>]`** / **`undeprecate`** —
  软信号 + 替代品指针；**不拦截**新安装/新 apply，只让消费者看见理由与后继。
- **`archive <slug> [--confirm]`** — 破坏性退役。**有活跃消费者时服务端 409**，
  CLI 把消费者计数打成人话并提示 `--confirm`（"3 agents are still using this
  skill — archiving unbinds them"）。public role 直接 archive → 提示先 delist。
- **`transfer <slug> --to <imUserId>`** + **`transfer-accept`** / **`transfer-abort`** —
  两段式所有权转移；offer 阶段 owner 不变，受让人 accept 才落。
- **`published`** — 我的发布清单表格：slug / 上架状态（listed·delisted·deprecated·
  taken_down·archived）/ **消费者数**（= archive 的爆炸半径）/ installs / 在途转让。

**错误码人话化**（新 `cli/publish-lifecycle.ts`，与 `@prismer/sdk` 的 `cloud`
CLI **共享同一张表**，两包不允许漂移）：`not_owner` / `has_active_consumers` /
`taken_down` / `changelog_required` / `successor_not_listed` / `transfer_pending` /
`not_transfer_target` / `must_delist_first` … 一律译成"原因 + 出路"的整句，
不再抛裸 HTTP 码。

> **承重语义**（SKILL.md 与文案都必须传达）：skill 安装与 role→agent 是**活引用，
> 不是快照**——改已发布件的内容会自动传播到全部使用者，故内容改动强制带
> `--changelog`；**下架不影响存量使用者，归档才解绑**。

同步更新 built-in skill `skill-builder` / `role-builder` 的 SKILL.md
（新增「发布后管理」节）与 `docs/api/publish-lifecycle.md`。

### Added — `agent.host.declare` 上报 `bundleVersion`（product204/08 §2.3 step 4，M9 收口）

- declare payload 新增 additive 字段 `bundleVersion`：**实际在跑的 runtime 版本**
  （boot-time OTA 换入的 bundle 即 bundle 版本；builtin boot 即镜像/npm 版本——
  进程 exec 的是 bundle 的 cli.js，自身 package.json 就是真相）。cloud 侧落
  agent card `metadata.bundleVersion`，runtime-skew 探针 fleet 分布随之从
  `im_agent_bindings.daemonVersion` 升级为真实运行版本（daemonVersion 保留为
  legacy fallback）。老 daemon 不带该字段 → cloud 行为不变。

### Fixed — role-builder `ingest-role.mjs` 默认公域回归（M9 收口，随 bundle 分发）

- `built-in-skills/role-builder/scripts/ingest-role.mjs` 默认路径回归为 admin
  公域 catalog（违反 product204/16 §2.3「CLI 默认私域」；根因=M5 的改动落在
  **gitignored 的 runtime 拷贝**、被 runtime 重建用 canonical 旧版覆盖——
  lost-uncommitted-change，j25 A4 回归抓到）。修复落 **canonical**
  `sdk/prismer-cloud/built-in-skills/`：默认 `/mine`（private），公域须显式
  `--publish`（alias `--admin-catalog`），`--mine` 保留为 no-op 兼容。

### Fixed — 无 config 环境任何 `prismer` 子命令崩溃（M9 收口）

- `cli/commands/task.ts` 的 `mkTaskWaitAdapter` 与 `cli/commands/workspace.ts`
  的 `mkMemberAdapter` 在 **program 构建期** 急切 `mkCloud()`（→ `loadConfig`），
  导致没有 `~/.prismer/config.toml` 的主机上 `prismer --help` / `prismer ota
  status` / 一切子命令直接崩 "Config not found"。CloudClient 改为**首次调用时
  惰性创建**，与 daemon 轮询等 config 的设计对齐——OTA resolver（`prismer ota
  resolve`）必须在 pre-setup 环境可用（08 §2.3 entrypoint 钩子）。

### Added — boot-time runtime-bundle OTA 消费链（product204/08 §2.3，M9-β）

- **`daemon/ota/`（新模块）**：K8s/CLI 侧 bundle OTA 状态机——
  检查（manifest 3s+重试，候选序 `PRISMER_BUNDLE_MANIFEST_URL` env →
  `/api/runtime/update/manifest` → `/api/desktop/update/manifest`，两种
  payload 形态均容忍）→ 下载 → **sha256/sha512 + Ed25519 双验**（签 zip 原始
  字节；公钥 `DAEMON_BUNDLE_PUBKEY` env 可覆盖、内置常量与桌面同 keypair；
  验签失败=显式拒绝+incident 回传，**绝不落盘执行**）→ 系统 `unzip` 解包到
  `~/.prismer/bundle/<version>/` → 解包后 `package.json` 版本≠manifest 版本
  即拒（双版本源 drift 门禁）→ 原生依赖（better-sqlite3）解包时从镜像内置
  runtime **symlink 借入**（ESM 不查 NODE_PATH——桌面 bundle-manager 已
  code-verified 的教训，08 §2.3 "NODE_PATH 借用"的语义落点）→ 原子指针切换
  （`previous` = 回滚位）。
- **回滚 + 熔断**：boot-attempt marker 跨容器原地重启存活（emptyDir 语义，
  **无 PVC**）；上次 boot 未确认 → 计 strike + `boot_failed`/`rolled_back`
  回传 + 回退 previous；**连续 2 strikes → 本地拉黑 + 删目录（防复活）**，
  停留 previous/镜像 builtin（镜像永固兜底，任何失败路径都不 brick）。
- **incident 回传**：走既有 `POST /api/desktop/update/report`（migration 499
  词表，`component='daemon'`）——`applied`/`boot_ok`（熔断统计分母）+
  `verify_failed`/`boot_failed`/`rolled_back`/`blacklisted`。⚠️ 该路由现有
  `DAEMON_ID_RE` 只认桌面形态 id，K8s `container:<pod>` 形态会被
  logged-then-dropped——server 侧放宽挂 α/收口波。
- **`prismer ota (resolve|status)`（新 CLI verb）**：`resolve --exec-path`
  是 K8s entrypoint 钩子（stdout 只打 bundle cli.js 路径，builtin=空输出，
  日志全走 stderr）；`PRISMER_BUNDLE_OTA=0` 本地跳过（server 侧 kill switch
  = manifest decision=none）。
- **boot 确认**：`daemon start` 成功后 10s 稳定窗（`scheduleBundleBootConfirm`）
  清 marker + 清 strike 记录 + 回传 `boot_ok`；窗口内崩溃 ⇒ marker 存活 ⇒
  下次 boot 自动计 strike 回滚。
- 测试：`test/ota-bundle.test.ts`（13 用例：真 keypair/真 zip/真本地 HTTP
  server 全链 + 篡改负控 + 回滚/拉黑注入 + 回传 payload 断言）。

### Removed — `PRISMER_UNIFIED_WS` 逃生口（product204/18 Wave 3，挂 M9 收割）

- `daemon/runner.ts` 不再读 `PRISMER_UNIFIED_WS`：unified `WS /ws/realtime`
  是唯一 realtime 路径，legacy `SseSubscriber`（`/api/im/sync/stream`）不再
  被 runner 实例化（模块保留，仅测试引用）。设 `PRISMER_UNIFIED_WS=0` 的部署
  自本版起为 no-op。

### Added — per-agent skill config env injection（product204/09 §2.3 Phase C）

- **`adapters/prismer-env.ts::skillConfigEnvFromMetadata`**：读取 cloud 派发时
  解析好的 `task.metadata.skillConfigEnv`（KEY→value，UPPER_SNAKE、禁
  `PRISMER_` 前缀——cloud 入库门禁保证），`applyPrismerScopeEnv` 尾部以
  **覆盖语义**并入子进程 env（三级解析 agent 覆盖/role 默认 高于 daemon 全局
  env；缺省 = 不注入 = global env 兜底）。coding 路径（claude-code / codex /
  provider-proxy-env）零改动即消费。
- **hermes adapter（seam b）**：`dispatch()` 把 `skillConfigEnv` 循环
  `writeEnvValue` 进 per-profile `.env`（gateway 长驻进程不走 spawn env；
  per-profile 文件 ⇒ 同 daemon 多 agent 隔离是结构性的）。
- **`daemon/skill-loader.ts::parseSkillConfig`**：SKILL.md frontmatter `config:`
  声明的 daemon 侧宽松镜像解析（诊断用；值永远来自 dispatch metadata，不做本地
  解析注入）。`LoadedSkill` 增 `config` 字段。

### Added — identityContext named sections（product204/07 Phase C · 分段注册制 D6）

- **Wire type** `TaskDispatchRequestPayload.identityContext.sections?: IdentitySection[]`
  （`{ id, owner, order, content }`，additive；旧 daemon 忽略该字段，旧 cloud 不发
  ——双向 version-skew 安全）。
- **`daemon/dispatch.ts::renderIdentityLines`** 扩展：校验（content string +
  order finite number）→ 按 `order` 升序稳定排序 → trim → 滤空，作为
  `sections: string[]` 与 identity/user/scope 一起进 `metadata.identityContext`；
  `hasIdentity` 判定包含 sections。
- **三个 adapter 消费面**（coding `code-agent-driver` / `claude-code` legacy CLI /
  hermes instructions slot）：sections 以 `\n\n` 连接在既有 identity 三行**之后**、
  同一 native identity slot。hermes 侧只进 per-turn `instructions`，**不写 SOUL.md**
  （D6 红线：动态 envelope 注入，不落任何持久文件）。
- 首个注入段：cloud 侧 `platform-directives`（order 20，仅 active orchestrator
  dispatch 携带）；order 30/40（config-directives / per-turn-voice）为 09/03 预留槽。

### Changed — `role create` defaults to the PRIVATE domain（product204/16 §2.2 M5）

**Behavioral flip, no version bump.** 创作默认私域，进公域是显式动作：

- **`prismer/cloud role create`** 默认改打 `POST /api/im/role-templates/mine`
  （owner-scoped private，任何已认证 key 可用，落 Studio `/mine`）。旧默认
  （admin 公域 catalog 直写）收敛为显式 `--admin-catalog`（非 admin 403）。
  `--mine` 保留为向后兼容 no-op。
- 新 `--publish`：create 后自动 `POST /:slug/publish`（走 RO-11/RO-6 publish
  gate），一步进公域 Marketplace。
- **`role-builder/scripts/ingest-role.mjs`** 同步反转默认（头注释与代码此前
  自相矛盾——注释声称默认 `--mine`、代码默认公域；现在代码与文档一致），同样
  新增 `--publish` / `--admin-catalog`。role-builder `SKILL.md` 口径同步。

### Added — `skill publish` + `role export`（product204/16 §2.2(c) / §2.5）

- **`skill publish <slugOrId> [--license --changelog]`** — 显式 owner 动作，把
  skill 从私域（`publishScope='workspace'`，create 默认）翻到公域 Marketplace
  （`POST /api/im/skills/:id/publish-template { scope:'marketplace' }`）。注意：
  marketplace 搜索面自本版起只见 `publishScope='marketplace'`——不 publish 的
  skill 他人搜不到。
- **`role export <agentImUserId> [--out <dir>] [--ingest]`** — 把活 agent 的人格
  晶化为 role bundle（`GET /api/im/agents/:id/role-bundle`，SOUL 取 RAW
  operatingPrinciples，不含运行时注入子句，round-trip 不堆叠）；`--ingest` 直接
  `POST /role-templates/mine` 落私有 role。

### Added — daemon declares its device identity（desktop204 D204-3）

`agent.host.declare` 现在恒带 `daemonLabel` + `daemonKind`。此前 daemon 只发
`daemonId / daemonVersion / platform`，cloud 只能靠 `daemonId.startsWith('daemon-')`
猜 kind、拿 daemonId 后缀当 label——对任何不遵守该前缀约定的 id 都是错的，且永远
surface 不出用户自己起的设备名。

- 新 `src/daemon/device-identity.ts`：
  - `resolveDaemonKind()` — `PRISMER_DEVICE_KIND` > `KUBERNETES_SERVICE_HOST`（⇒ `k8s`）> `local`
  - `resolveDaemonLabel()` — `PRISMER_DAEMON_LABEL` > config.toml `daemon_label` > OS hostname > daemonId（永不为空）
- config.toml 新增可选 `daemon_label`（用户自定义设备名）。
- `device-dir.ts` 的 `inferDeviceKind()` 收敛到同一个 resolver —— `device.json` 与
  declare 线上的 kind 不可能再互相打架。
- cloud 侧字段 / DB 列早已存在（`im_agent_bindings.boundDaemonKind/Label`），**无需迁移**；
  cloud 的猜测逻辑保留为旧 daemon 的 fallback。

### Added — `agent.host.withdraw` on intentional shutdown（desktop204 D204-4）

daemon 现在会在**主动关闭**时（SIGTERM/SIGINT ⇐ ⌘Q / `prismer daemon stop` / pod
terminate）**drain 完成后、WS 关闭前**发 `agent.host.withdraw`。cloud 侧 handler /
service / 错误码此前是**写好的死代码——没人发过这个事件**，于是 ⌘Q 后 cloud 要等满
**3 分钟**心跳陈旧才把 agent 标离线，这 3 分钟内派给它的任务全是黑洞。

- `Runner.stop(opts?: { withdraw?: { reason, timeoutMs? } })` —— 只有**显式传 intent**
  才发（崩溃 / auth-failed / version-skew respawn 不发：同一个 daemonId 马上会回来，
  binding 不该被标成可回收）。
- `inflightDrained` 取 stop 时是否还有在跑的 run（有 ⇒ `false`，cloud 知道该 requeue）。
- 新 `WsClient.sendAndFlush(msg, timeoutMs)` —— 等帧真正写进 socket 再返回，
  避免 `close()` + `process.exit()` 把 withdraw 一起蒸发掉。
  **best-effort 是硬约束**：socket 不 OPEN / flush 超时 → 立刻 resolve `false`，
  绝不抛、绝不阻塞退出（离线 ⌘Q 最多多花 1.5s）。

## 2.0.9

### Fixed — sandbox daemon 镜像 stale-tag 陷阱（线上 daemon 落后 cloud）

镜像 tag 从 `/VERSION` 派生（`daemon-v$(cat VERSION)`），pod 按 **tag** 引用镜像
（`getDaemonImage()` 返回 `canonical`，`digest` 仅供诊断），且 test/prod 是
`imagePullPolicy: IfNotPresent`。

于是当一次发版没有 bump `/VERSION` 时：CI 的 `build_sandbox_image` 确实重新构建
并 push 了新镜像，但**tag 名字不变** → kubelet 看到节点已缓存该 tag，永远复用旧
层。cloud 前进、daemon 原地不动 —— test 环境因此用 07-07 的 daemon 跑
release203/28 的 cloud（会话压缩 + systemHidden + memory 抽取/召回均不匹配）。

本次 bump `/VERSION` → `2.0.9` 使 tag 变为 `daemon-v2.0.9`，强制 kubelet 拉取新
镜像。约束已写入 `infra/sandbox-image/image-pin.yaml` 顶部注释：**任何触及
`sdk/prismer-cloud/runtime/` 的发版必须 bump `/VERSION`。**

## Unreleased

### Fixed — release203/10: skill 下发闭环三环修复（workspace203 体系化 e2e 全绿）

skill 从"安装"到"运行中 agent 真能用"的完整链路修复。根因：hermes gateway 的
`HermesSkillLoader` 在 spawn 时从 `profile.config.skillsDir` 固定 skillsRoot；
若启动时未注入 device dir，则读 profile dir，而 skill-sync 写 device dir → 错位。

- **目录错位** (`daemon/skill-sync.ts` + `daemon/runner.ts`): 新增纯函数
  `withPerAgentSkillsDir(profile, paths, daemonId)`；`syncProfileFromCloud` 的
  prewarm 用它注入 device skillsDir，使 gateway 从启动即读 skill-sync 写入的
  `devices/<did>/agents/<aid>/skills/`。此前 prewarm 用未注入的 profile 启动 →
  读 profile dir → 已安装 skill 对 agent 不可见。
- **活进程缓存不刷新** (`daemon/dispatch.ts` + `daemon/runner.ts`): dispatch 的
  skill-sync `synced>0` 时经新增的 `DispatchDeps.dropService` drop 缓存的
  hermes 服务，`ensureService` 以含新 skill 的 device dir 重启。运行中 agent
  安装 skill 后**当次 dispatch** 即可用（此前需服务重启才可见）。revision-diff
  保证稳态 `synced==0` 不再重启，无 churn。
- **首次冷启动根治** (`daemon/runner.ts`): `syncProfileFromCloud` 在 prewarm
  前，当确实注入了 device skillsDir，先 `syncInstalledSkillsForDispatch` 铺
  skill 到 device dir，再 `servicePool.drop` 旧服务，使 gateway 以 warmProfile
  （device-dir loader）重建、其 skill loader 首次扫描即读完整 skill 集。
  blueprint 实例化 / bind 的 agent **首次 invoke** 即命中，免冷启动窗口。

端到端验证：`docs/workspace203/20-systematic-test-execution.md` —— workspace203
体系化 flow（前置1-4 + workspace1-2）S0-S7 真机全绿，全程 DeepSeek flash。

### Changed — memory203/20 W-B: extraction prompt v2 (richness-balanced) + `web_load` prismer:// + oversized advisory passthrough

- **Extraction prompt v2** (`daemon/memory/extract.ts`, ruling 0705-3/4
  "record, never limit"): removed the "emit minimal valid PKF" self-framing
  and the `BUDGET: … prefer 1-3 DENSE pages / concise` compression language
  (doc 19 §3.4 ①② — the structural scarcity that flattened pages to prose).
  New posture: richness-balanced PKF — frontmatter script with a **REQUIRED
  one-sentence `description`** (feeds the cloud description column, doc 20
  §1.1), `<h2 id>` sections, full typed-link vocabulary incl.
  `supports`/`contradicts`, the FULL `<prismer-data>` view set
  (`table|bar|line|scatter|area|heatmap` — "never flatten a source table into
  prose"), and asset POINTERS (short description +
  `<a rel="derived-from" href="prismer://asset/<id>">`, never a body copy —
  doc 20 §1.4 asset 零镜像). The ONLY token rules are anti-waste: ANTI-REPEAT
  (same-topic page in the recall context ⇒ placement MUST be extend/attach,
  never a near-duplicate new page) + circular-recall discipline (pages already
  in the provided context are not new sources to re-query). Prompt exported
  (`EXTRACTION_SYSTEM_PROMPT`) so the guidance lane (W-C skills) teaches
  consistently.
- **`MEMORY_EXTRACT_MAX_TOKENS` default 2048 → 8192** (record-not-limit):
  usage is recorded, not constrained — gateway `usage.input_tokens`/
  `output_tokens` now flow onto `ExtractTurnResult.promptTokens`/
  `completionTokens` and into the `llm_response` stage line
  (`pages=N, chars=M[, tokens=in:X/out:Y][, truncated]`, exported
  `formatLlmResponseDetail` in `hook-server.ts`). Truncation salvage stays as
  the pure fallback. Paired: `MEMORY_EXTRACT_TIMEOUT_MS` default 60s → 120s
  (measured: 4096 tokens took 29–44s; the timeout must outlast the 8192
  ceiling or the abort-drops-memory bug returns).
- **Attached-asset ids reach extraction** (additive contract): the provider
  shell's `sync_turn` now parses `<attached_assets><asset id="…"/></…>` out of
  the turn text and stamps `extra.attached_asset_ids` on the `post_llm_call`
  body; hook-server threads it into `ExtractInput.attachedAssetIds`, and
  `extract.ts` falls back to parsing the XML itself
  (`parseAttachedAssetIdsFromTurn`) for older shells. The user prompt lists
  the real `prismer://asset/<id>` pointer URIs so pages reference assets
  instead of mirroring them.
- **`web_load` accepts `prismer://` URIs** (doc 20 §2.2 / 19 B9): scheme
  allowlist widened from http(s)-only to http(s) | `prismer://` in BOTH the
  provider shell (`plugins/memory/prismer/__init__.py`) and the daemon route
  (`daemon/web/rpc.ts`); the daemon still forwards to the cloud Load API
  unchanged (it natively resolves `prismer://<owner>/asset/<sha>` and
  `.../file/...`). Tool description retargeted: load web pages OR workspace
  assets/files — use it instead of re-reading raw sources memory already
  points at. Garbage schemes (file://, ftp://, …) still 400 `invalid_url`.
  Spec sync in `adapters/web-tools.ts`.
- **`oversized` candidates kind** (doc 20 §1.2 hub-size ADVISORY,
  record-not-limit): added to the daemon `HEALTH_KINDS` whitelist
  (`daemon/memory/rpc.ts` → forwards `GET /api/im/memory/health/oversized`),
  the Python `memory_curate` `kind` enum, and the shared
  `MemoryCurateInput.kind` spec (`adapters/memory-tools.ts`, which also picks
  up the previously-drifted `conflicts` value). Advisory only — the cloud
  lane measures and suggests splits; nothing is machine-enforced.

### Changed — memory203/20 W-C: guidance rewrite (four-truths) — memory + memory-dream skills, MEMORY_CORE_DIRECTIVE

- **Teach only what W-A/W-B landed** (the initiative's lesson: never teach what
  the platform can't do). All guidance now consistent with
  `EXTRACTION_SYSTEM_PROMPT` v2 (`daemon/memory/extract.ts`): same rel
  vocabulary (`supports`/`contradicts`/`related`/`derived-from`/`references`/
  `cites` + structural `child-of`), same `<prismer-data>` view set
  (`csv|json` × `table|bar|line|scatter|area|heatmap`), same asset-POINTER
  form (short description + `<a rel="derived-from" href="prismer://asset/<id>">`,
  never a body copy), same anti-waste rules (no duplicate extraction, no
  circular recall — the ONLY token rules, 0705 record-not-limit rulings).
- **`built-in-skills/memory/SKILL.md`** (canonical + runtime mirror): dual-
  section ownership section replaces the self-contradictory "hub needs a body"
  vs "never hand-edit INDEX/hub" doctrine (doc 19 D11) — `#overview` prose is
  agent-owned and rebuild-proof (W-A `rewriteTocSection`, test-verified),
  `#toc` is machine-owned; frontmatter `description` REQUIRED (one-sentence
  self-summary feeding TOC entries/chips) with the dual-track note (body prose
  carries inter-entity logic); de-hedged append flow — recall/browse shows an
  existing page on the topic ⇒ `memory_write op="append-section"` /
  `"rewrite-section"` is a MUST (the "may not be available / fallback" hedging
  is gone — the ops are live in daemon rpc + Python tool schema); richness
  palette with three worked PKF examples (prismer-data page, asset-pointer
  page incl. `<img src="prismer://asset/…">` media, supports/contradicts pair
  with `#section` anchors) — media/section-granularity teachings lifted from
  the deprecated memory-curation skill (doc 19 D12 迁移, that skill stays
  deprecated); size discipline (INDEX/hub lean as taught discipline, enforced
  by nothing; `kind="oversized"` split suggestions; ordinary pages unlimited,
  richness encouraged); consolidated anti-patterns (re-reading raw files
  memory already distills, circular recall, duplicate extraction, copying
  asset bodies, hand-editing `#toc`).
- **`built-in-skills/memory-dream/SKILL.md`** (v2 → v3, canonical + runtime
  mirror): convergence loop gains STEP 1c (review `kind="oversized"` hub-split
  advisories — suggestions, never enforcement) and STEP 6 (MAINTAIN the
  `#overview` prose on INDEX/hubs via `op="rewrite-section"` — the
  orchestrator's editorial duty; the rebuild only regenerates `#toc` with
  per-entry descriptions); candidates envelope documents the `oversized`
  surface; "rebuild_index is the ONLY INDEX write" reworded to the dual-
  section truth; section-op hedging removed from the enact/fold steps.
- **`MEMORY_CORE_DIRECTIVE`** (`daemon/dispatch.ts`): "NEVER write or
  hand-edit INDEX.pkf (machine-generated)" replaced with the dual-section
  truth ("`#toc` machine-owned — never hand-edit; `#overview` prose IS yours
  to write and maintain"); adds the richness line (description-required +
  rich blocks + asset pointers + work-from-memory-not-raw-files + anti-waste);
  extend decisions name the live section ops; orchestrator loop gains
  overview maintenance + the conflicts/oversized candidates kinds.

### Added — release203 web-capability fix: `workspace_web_search`/`web_load` tools + terminal toolset restore

- **`workspace_web_search` / `web_load` provider tools** (`plugins/memory/prismer/__init__.py`):
  workspace-CONTEXT tools (not memory ops) registered through the provider
  shell's `get_tool_schemas()` seam (7 tools total now). Handlers POST the
  new daemon routes; descriptions steer agents away from scripting HTTP via
  `execute_code`+subprocess (the observed fallback: 197 execute_code vs 0
  web calls in 14 days — Hermes' native web toolset is schema-dropped in pods
  because no upstream search backend is configured, and per the user ruling
  we ARE the search backend: no third-party keys/packages enter the pod).
  `web_load` validates http(s)-only shell-side before any daemon call.
  Name note: the search tool CANNOT be `web_search` — Hermes v0.17 rejects
  provider tools shadowing reserved CORE tool names even when the core tool
  is check_fn-dropped ("Core tools always win", live-hit 2026-07-03); the
  event-stream mapper (`tool-call-mapper.ts`) maps `workspace_web_search`
  onto the first-class `web_search` search row (and `web_load` onto the
  `fetch` row) so the timeline surface is unchanged.
- **Daemon `/local/web/search` + `/local/web/load` routes** (`daemon/web/rpc.ts`,
  new `attachWeb` hook in `local-server.ts`, wired in `runner.ts`): FORWARD to
  the cloud Load API `POST /api/context/load` (`{input: query|url|urls}` —
  search + cache + compress + deposit, Exa server-side) with the daemon's own
  `Authorization: Bearer <sk-prismer>` (same credential lane as extract.ts;
  the Load API's `apiGuard` accepts sk-prismer Bearer directly, no JWT
  exchange). Forward timeout 120s default (live-measured: cold 3-result query
  = 59s), env-tunable `PRISMER_WEB_LOAD_TIMEOUT_MS`; the daemon also sends
  `x-forwarded-proto` matching its cloud baseUrl scheme (the Load API
  self-fetches `/api/search` at `x-forwarded-proto || https`, which 500s
  against a plain-HTTP dev/pod cloud). Search passes `search.topK = limit`
  alongside `return.topK` — the route's default searched set is 15 and it
  compresses EVERY uncached hit before ranking (59–118s cold for a 3-result
  ask). Every text field in the passthrough bounded to ~8k chars with an
  explicit truncation marker; `[web-tool]`-prefixed structured logs (trace
  id, query/url count, status, ms).
- **Explicit `platform_toolsets.api_server` pin** (`adapters/persistence/hermes/index.ts`
  `configurePrismerProvider`, exported `HERMES_API_SERVER_PLATFORM_TOOLSETS`):
  bypasses the hermes v0.17.0 subset-inference bug that silently dropped the
  `terminal` toolset. The pinned list is the `hermes-api-server` composite
  reverse-mapped to configurable toolset keys minus default-off (verified
  against the hermes-agent reference `hermes_cli/tools_config.py`); explicit
  membership flips hermes to deterministic direct resolution. Union-merged
  with operator entries, idempotent; per-role `agent.disabled_toolsets`
  (toolsetScope deny) still applies LAST hermes-side, so governance wins.
- **`WEB_TOOL_DIRECTIVE`** (`daemon/dispatch.ts`): hermes-only teaching line on
  the same `composedSystemPrompt` seam as `MEMORY_CORE_DIRECTIVE` ("Web
  research → `web_search`/`web_load` (workspace-billed, cached). CLI →
  `terminal`. Do NOT script HTTP or subprocess for these.").
- **Frozen spec** `adapters/web-tools.ts` (sibling of `memory-tools.ts`):
  `WebSearchInput/Output`, `WebLoadInput/Output` + naming rationale
  (`web_search` matches the event-stream mapper's `SEARCH_TOOLS` so calls
  render as first-class search rows).
- Tests: `test/web-rpc.test.ts` (forward+auth header+bounding+non-http
  reject+degrade), `test/web-provider-shell.test.ts` (real python3 exec of the
  shell: 7-tool registration + shell-side invalid_url negatives),
  `test/hermes-platform-toolsets.test.ts` (pin content, operator merge,
  idempotency, deny coexistence).

### Added — memory203/18 §11.4 residual #3: conflict-lifecycle review surface (`kind=conflicts`)

- **`GET /local/memory/health?kind=conflicts`** (`daemon/memory/rpc.ts`
  `HEALTH_KINDS`): passthrough to the new cloud
  `GET /api/im/memory/health/conflicts` — live remote-conflict pages, each
  carrying `metadata.latestTwoVersionSummaries` (`{version, changeSummary,
  authoredBy, createdAt}` from the version DAG) + `metadata.currentVersion`,
  so the orchestrator can judge which LWW side owns the head without loading
  full contents. `kind=all` now returns four surfaces
  (`{orphans, duplicates, stale, conflicts}`).
- **`memory_curate` python tool** (`plugins/memory/prismer/__init__.py`):
  `candidates` `kind` enum gains `"conflicts"`. Cloud-side, conflict is now a
  STATE, not a brand — a curation touch or clean (non-conflicting) rewrite of
  a conflict-flagged page restores its `sourceKind` to `daemon-sync`, so
  reviewed pages drop off this surface; the `memory-dream` skill's convergence
  loop gained a STEP 1b teaching the review flow.

### Fixed — memory203/18 W5 (final-round5 P0): two-phase stall watchdog + silent-empty-reply guard

- **Two-phase upstream-stall watchdog** (`adapters/persistence/hermes/sessions-sse.ts`):
  the W4 single 120s threshold killed HEALTHY long-context turns — after
  round-3 bulk ingestion the recall probes carried ~120k promptTokens and the
  upstream legitimately took >120s to the FIRST token (3/3 probes
  watchdog-aborted; the 15s dispatch heartbeats already protected those turns
  from the 300s reaper). Now the guard runs two phases: before the first
  MODEL-activity event it uses `PRISMER_UPSTREAM_FIRST_EVENT_MS` (default
  270 000 ms — under the 300s reaper, generous for long-context first tokens);
  after it, the original inter-event `PRISMER_UPSTREAM_STALL_MS` (default
  120 000 ms). Both env-tunable, resolved per call. ⚠️ hermes enqueues
  `run.started`/`message.started` BEFORE the LLM call (api_server.py
  `_run_and_signal`), so those acks re-arm but do NOT end the first-event
  phase — gating on the literally-first frame would have made the fix inert.
  Abort messages name the phase (`no first event for Ns` vs `no events for
  Ns`); `dispatch.ts` `isLimiterClassError`/`retryReasonToken` match both
  wordings (requeue lane + `reason=stall` unchanged). Clarify-disarm and
  keepalive-comment semantics unchanged. Covers both hermes lanes (shared
  `consumeSessionsSse`).
- **Silent-empty-reply guard + transcript-tail recovery**
  (`adapters/persistence/hermes/sessions-dispatcher.ts`): after a stall-abort,
  hermes keeps generating server-side (`_run_agent` runs `run_conversation` in
  a thread executor the disconnect-cancel cannot preempt) and flushes the turn
  into the session store on completion; the daemon retry re-sent the same
  prompt into the SAME session and the retried stream could complete with
  EMPTY content — the adapter forwarded ok=true output:'' → cloud marked the
  run completed and the DM message-post gate (`output || attachments`)
  silently skipped the post (run=completed, error=NULL, DM empty, credits
  burned; the killed attempt's answer later leaked into the next turn's
  reply). Now an empty-output completion (approval/clarify suspensions
  excluded) is never a silent success: the dispatcher first tries to RECOVER
  the reply from `GET /api/sessions/{id}/messages` (last non-empty assistant
  row after the first user row carrying this dispatch's id — the id is
  stamped in the `<execution_context>` XML; 2 bounded polls), surfacing it
  with `metadata.hermes.replyRecovered='session_transcript_tail'`; otherwise
  it fails LOUDLY with `empty_reply`, which `daemon/dispatch.ts` treats as
  terminal (no 3× re-burn of a ~120k-token prompt into the polluted session)
  so the cloud posts a visible "Agent failed" system event.
- **Best-effort upstream cancel on stall-abort** (same file): fires
  `POST /v1/runs/{runId}/stop` fire-and-forget before the retry. Known
  ineffective on current hermes — the sessions chat/stream handler never
  registers its run in `_active_run_agents` (only the /v1/runs path does), so
  this 404s today; kept as the correct semantic signal for the day hermes
  registers sessions runs. A clean per-turn abort therefore CANNOT be done
  from the adapter yet — the guard above is the real mitigation.

### Changed — memory203/18 W4 runtime tail: upstream-stall watchdog + CLI gateway-detection fix

- **In-flight upstream-stall watchdog** (`adapters/persistence/hermes/sessions-sse.ts`
  `createStallGuard` + `resolveUpstreamStallMs`): the W2-gate's dominant residual
  failure mode was a SILENT upstream LLM hang — no error, no SSE events — so the
  adapter emitted no progress, the 300s daemon reaper killed the run
  (`daemon_task_timeout`), the cloud requeued, the same stall repeated until the
  requeue cap (4) exhausted → 3/18 permanent burst failures + starved recall
  probes. The W3 retry-loop progress frames couldn't cover this: the call never
  RETURNED to enter the retry loop. Now, when an in-flight sessions SSE stream
  produces NO event frames for `PRISMER_UPSTREAM_STALL_MS` (default 120 000 ms,
  env-tunable, read per-call), the guard cancels the stream and throws
  `upstream stall: no events for Ns (…)` — a plain (non-AbortError) error that
  `categorizeDispatchError` maps to a retryable `adapter_dispatch_failed`.
  Covers BOTH hermes lanes (sessions-dispatcher + runs-dispatcher share
  `consumeSessionsSse`). The reaper window is untouched (last-resort backstop);
  `clarify.request` disarms the guard while a human answers (re-armed by the
  next event frame).
- **Stall-class rides the limiter/requeue lane** (`daemon/dispatch.ts`):
  `isLimiterClassError` now matches `upstream stall: no events for` — the retry
  loop uses the jittered limiter backoff with `retrying(attempt=N, reason=stall)`
  progress frames (new `retryReasonToken` token), and on exhaustion the failure
  lands `dispatch_precondition_unavailable` so the cloud's transient-requeue
  channel re-delivers instead of a permanent red failure. Generic `HTTP 504`
  wording remains terminal (unchanged).
- **`prismer memory list` gateway-detection fix** (`cli/commands/memory.ts`):
  `list` never fell back to `$PRISMER_WORKSPACE_ID` (unlike search/read/recall/
  write), so a bare `prismer memory list` in an agent pod skipped the modern
  `/local/memory/list` route entirely, probed only the legacy 404 paths, and
  reported `memory_gateway_unavailable` against a live daemon RPC (W2-gate
  item 3 FAIL, R7 CLI projection). Now `list` honours the env workspace;
  explicit `--workspace-id` still wins. Verified inside the live agent-rt pod
  (patched CLI bundle, direct node invocation): `memory list --page-type hub`
  returns the workspace hubs with exit 0.
  Known residual: `memory delete` / `memory sync` still only probe legacy
  routes (no modern `/local/memory/*` equivalents wired) — unchanged.

### Changed — memory203/18 W3 lane: failure self-heal (R3.1–R3.3) + event-stream fidelity (R5.2)

- **R3.1 — limiter-exhaustion now self-heals instead of terminal-failing**
  (`daemon/dispatch.ts`): when the local retry loop (3 attempts) exhausts and the
  LAST error is limiter-class (HTTP 429 queue-full / RPM "Rate limit exceeded",
  504 "slot not available before deadline"), the synthesised failure carries
  `dispatch_precondition_unavailable` (original message preserved) instead of
  `daemon_local_retry_exhausted` — the cloud's EXISTING transient-requeue channel
  (`requeueTransientRun`, cap 4) re-delivers the run once the queue drains.
  Non-limiter exhaustion (e.g. HTTP 500 ×3) still lands
  `daemon_local_retry_exhausted` terminal. Cloud side (same change set,
  `src/im/ws/handler.ts` + `task.service.ts::isTransientRequeueErrorCode`): the
  requeue branch also accepts reaper `daemon_task_timeout` for CHAT runs
  (`run.source !== 'task'`), mirroring the kanban-task retry policy that chat
  runs never had — same bounded counter.
- **R3.2 — limiter-aware backoff** (`daemon/dispatch.ts`): limiter-class retry
  waits honor an explicit Retry-After hint in the message (`Retry-After: n` /
  `Retry in ns`, clamped 60s) and otherwise use jittered windows [3–6s, 8–15s]
  instead of the fixed [1s, 3s] that burnt all 3 attempts in ~4s. Attempts stay
  at 3 (the requeue channel owns the long tail). `PRISMER_DISPATCH_RETRY_BACKOFF_MS`
  (comma list) overrides all classes for ops/testing.
- **R3.3 — progress during retry** (`daemon/dispatch.ts`): before each backoff
  the dispatcher emits `task.dispatch.progress` with
  `retrying(attempt=N, reason=<status>)` (+ structured `detail.kind='retry'`),
  resetting the runner reaper's inactivity window so the 300s reaper no longer
  kills runs that are mid-retry, and giving the UI something to show.
- **R5.2 — event-stream CLI extraction** (`adapters/persistence/hermes/tool-call-mapper.ts`):
  `execute_code` wrapping a CLI in python (`subprocess.run(['prismer',…])`,
  `subprocess.*` string form, `os.system(…)`, `!cmd` lines) now maps
  `detail.command` to the reconstructed CLI (multiple calls join with ` && `,
  capped 400 chars) with `detail.commandSource='argv'`; the FULL python source
  rides additively on `detail.script` (capped/spilled by the step recorder like
  `output`). Dynamic argv (variables/f-string elements) is never guessed — no
  match keeps the previous whole-source behaviour. The workspace timeline's
  collapsed row now renders `` $ prismer memory search … `` instead of
  `import subprocess (+9 行)` (`src/app/workspace/components/agent-message/adapter.ts`).
- Additive type fields: `ToolCallDetail.shell.{script,commandSource}`
  (`adapters/coding/shared/agent-sdk-types.ts` + UI mirror in
  `agent-message/types.ts`); step recorder caps `shell.script` like `shell.output`.

### Changed — memory203/18 W2 guidance lane: teach the primitives that now exist (§2.3/R6.5/R4.1/R4.2)

- **`built-in-skills/memory/SKILL.md` rewritten tool-centric** (native `memory_*` tools primary;
  short `prismer memory` CLI appendix for code agents): browse-first write flow
  (`memory_browse` → extend / attach via `parent_hub_path` / new-hub-then-leaf → verify via
  `memory_search`), prefix-free path convention ("use paths exactly as returned by
  browse/search"), structural edges over prose (`child-of` direction taught explicitly: edge
  points FROM child TO hub — the W1-gate found 8 hand-written inverted links), INDEX.pkf is
  machine-generated and never hand-written, never whole-page-rewrite another agent's page.
  Section ops (`op="append-section"` / `"rewrite-section"`) are taught with an explicit
  landing note — they ship in the same daemon image (R6.4, parallel lane).
- **`built-in-skills/memory-dream/SKILL.md` rewritten around the tight convergence loop**:
  `candidates` → `memory_browse` → cluster (your LLM) → `promote_to_hub` **WITH `childPaths[]`**
  (no hollow promotes, no hand-written re-anchor links — the old "no move-anchor op" §Re-anchor
  workaround is deleted) → `rebuild_index` once per batch → `candidates` again to verify →
  REPORT the structural delta in the reply. (W1-gate: CEO ran promote without childPaths because
  the param was undocumented, and hand-wrote 8 inverted child-of hrefs.)
- **`built-in-skills/memory-curation/SKILL.md`** (deprecated/reference): placement guidance
  aligned to browse-first + `parent_hub_path`; removed "anti-orphan is discipline only, the
  platform won't enforce it" apologetics and the `memory/`-prefixed path convention.
- **`MEMORY_CORE_DIRECTIVE` updated** (`daemon/dispatch.ts`): names all five tools (adds
  `memory_browse`), hardened RECALL rule ("when answering anything about workspace knowledge you
  did not just read, run `memory_search` FIRST; attached files are raw sources — check memory for
  distilled knowledge before re-reading them"), browse-first write flow, and the orchestrator
  convergence loop with `childPaths` + verify + report duty.
- **R4.2 — builtin `memory` skill now installs into every hermes profile**
  (`adapters/persistence/hermes/index.ts`): `installPrismerImSkill` generalized to
  `installBuiltInHermesSkill(profileName, slug)` (per-slug content cache); both install sites
  (ensureService + per-dispatch) land `prismer-im-collab` + `memory`, and `memory-dream` for
  profiles with `taskAuthority: 'orchestrator'` (first consumer of that config bit).
- **R4.1 — orchestrator prompt no longer routes file questions straight to raw sources**
  (`src/lib/role-runtime-policy/prompt-contract.ts`, cloud side): "For uploaded files, first
  `memory_search` for existing distilled knowledge; use `assets`/`ingest` when memory misses."
- **R4.3 — `<execution_context>` dirs annotated** (`daemon/conversation-context.ts`): a
  `<dirs_note>` leaf marks artifacts/scratch dirs as per-run working space, pointing prior-fact
  questions at `memory_search` (the W1-gate read-file-over-recall bypass).

### Added — memory203/18 W2 daemon lane: path/URI normalization + section write + placement guard + 0-yield root fix

- **P0 path/URI namespace normalization** (`daemon/memory/store.ts` → `rpc.ts handleWrite`,
  `hook-server.ts writeExtractedPage`, `cloud-sync.ts fetchPageFromCloudByPath`): ONE shared
  normalizer — `normalizeMemoryPath` (strips leading `/` + `memory/` segments) +
  `memoryPathToUri(workspaceId, path)` — used by every link/URI composition site, so a page path
  (or `parentHubPath`) that already starts with `memory/` no longer produces
  `prismer://…/memory/memory/…` (the W1-gate: 3/3 agent child-of `link.upsert` events silently
  dropped cloud-side, 0 rows). `memory.link.upsert` envelopes additionally carry plain
  `sourcePath` / `targetPath` (normalized; OPTIONAL + additive on `envelope.ts`, no schemaVersion
  bump) — the cloud lane prefers these over URI parsing, and trace path-mode matches on them.
  Local store lookups are variant-tolerant via `store.loadByAnyPath`
  (`memoryPathLookupVariants`: as-given, ±`memory/`, ±`.pkf`); a repeat write under the OTHER
  path convention extends the EXISTING page (existing row's path wins) instead of forking a
  near-duplicate.
- **R1.4 write-time 回源 (write hygiene)** (`rpc.ts handleWrite` op=replace, `cloud-sync.ts`,
  `store.ts`, `types.ts`): when the target page is absent locally or still `local-only`, the
  daemon first pulls the cloud head via the SAME single-page回源 `handleLoad` uses
  (`fetchPageFromCloudByPath`); `materialisePage` now passes the cloud `version` and
  `store.write` adopts `max(localExisting+1, version)` — so the write's outbox `parentVersion`
  continues the cloud head (cloud v4 + empty subset → parentVersion=4, not 0; dissolves the
  W1-gate's cross-agent full-page-rewrite `remote-conflict base v4 vs head v1` class). Fail-open:
  offline → proceed exactly as before (a local-first write never blocks on the cloud).
- **R6.4 section-level write** (`rpc.ts handleWrite`/`handleSectionWrite`, `__init__.py`,
  `adapters/memory-tools.ts`, `cli/commands/memory.ts --op/--section`): `memory_write` gains
  `op` (`replace`|`append-section`|`rewrite-section`, default replace) + `section` (heading id,
  required for section ops). Section ops FORWARD to the cloud section verbs
  (`POST /api/im/memory/pages/:id/sections/append|rewrite`, actor-override header like curate),
  then refresh the local subset from the cloud response (adopting the cloud version,
  syncStatus→`acked`) — and deliberately emit **NO** `memory.page.upsert` outbox event (the
  cloud write is authoritative; an upsert on top would double-apply the edit). No cloud wired →
  explicit 503 `section_write_requires_cloud` (never a silent no-op); unreachable cloud → 5xx
  passthrough with the local page untouched.
- **R6.3 placement guard (ramp, gated LAST per §9.3)** (`rpc.ts handleWrite`): a NEW un-anchored
  leaf (no existing page at path, not `pageType=hub`, no `parentHubPath`, no `rel="child-of"`
  content link) is gated by `PRISMER_MEMORY_PLACEMENT_ENFORCE` = `off` | `warn` (DEFAULT) |
  `enforce`. warn → `[memory-trace] stage=placement_warn` + `placementWarn` counter, write
  proceeds; enforce → 422 `{code:'placement_required', hubs:[{path,title,snippet}], message}`
  (hub candidates from the SAME `assemblePlaceContext` browse assembly). The Python tool's
  memory_write POST is now status-preserving so the structured rejection reaches the model
  verbatim (was: swallowed into `daemon_unreachable`).
- **Extraction 0-yield root fix + terminal states** (`extract.ts`, `hook-server.ts`): live-
  diagnosed 2026-07-03 on the W1-gate pod (manual post_llm_call + direct gateway replay of the
  real gate turn): kimi's multi-page JSON stochastically exceeds `max_tokens=2048`
  (`stop_reason=max_tokens`, observed 996/1924/2048-cut across 3 identical trials), and the
  truncated payload JSON.parse-failed into a SILENT `[]` — the gate's
  `llm_called 3/3 → extracted 0/3`. Fix: (a) string-aware salvage parser recovers every
  COMPLETE page object from a truncated `{"pages":[…` array (the REAL truncated gate-shape
  payload now yields 3 pages instead of 0); (b) `stop_reason` surfaced —
  `stage=llm_truncated(max_tokens)` + `truncated` flag on the result; (c) terminal stages
  `stage=llm_response(pages=N, chars=M[, truncated])` and `stage=skipped(reason=no_pages)` +
  `extractedEmpty` counter close the llm_called-then-silence gap; (d) a BUDGET line in the
  extraction prompt biases toward fewer, denser pages. `/healthz` `memory.counters` is now
  `{received, skipped, extracted, writeFailed, extractedEmpty, placementWarn}`.
- **R9.2 extraction deferred retry (doc 18 §9.4)** (`hook-server.ts`, `extract.ts errorStatus`):
  under burst the in-pod extraction call is starved by the workspace concurrency limiter
  (429 / 504 slot-deadline / status=0 cloud_unreachable) and the turn's knowledge — from exactly
  the busiest ingestion window — was dropped forever. Limiter-class failures now land on a
  bounded in-memory deferred queue (max 32, drop-oldest + `stage=deferred_dropped`); a lazy,
  jittered ~60s pump (`MEMORY_EXTRACT_RETRY_INTERVAL_MS`, unref'd, self-stopping) drains ONE
  entry per tick (serial — deliberately gentle on the limiter), max 3 total attempts, then
  `stage=extraction_abandoned` + counter. A successful retry runs the normal written/synced path
  with the ORIGINAL traceId (the trace shows the gap AND the recovery); each retry rebuilds a
  FRESH place-context. Non-limiter failures keep the writeFailed path (never queued). Counters:
  `memory.counters` gains `{deferred, deferredRetried, deferredAbandoned}` (deferred counts
  entries, not tries). Stage logs: `stage=deferred(reason=limiter, attempt=N)` /
  `deferred_retry(attempt=N)`. KNOWN BOUND (deliberate): the queue is in-memory only — a pod
  restart loses pending entries (no persistence by design; this module has no daemon shutdown
  hook to log the residual size).
- Tests: `test/memory-write-w2.test.ts` (20, negative controls for every mode),
  `test/memory-extract-salvage.test.ts` (4, incl. the real-payload shape),
  `test/memory-extract-deferred.test.ts` (9: defer on 429/504/0, non-limiter + 0-page negative
  controls, traceId-preserving recovery, 3-attempt abandonment, hard-failure-on-retry, 32-cap
  drop-oldest), `test/memory-stage-counters.test.ts` (+1 extractedEmpty terminal state,
  counters shape ×9).

### Added — memory203/18 W0+W1 daemon lane: write-time placement + browse + trace observability

- **R1.1 `memory_write` structural placement** (`plugins/memory/prismer/__init__.py`,
  `daemon/memory/rpc.ts handleWrite`): optional `parent_hub_path` + `relation`
  (`child-of`|`related`, default child-of) on the tool schema, forwarded as
  `parentHubPath`/`relation` to `POST /local/memory/write`. When present the daemon enqueues a
  `memory.link.upsert` GRAPH event (page→hub) mirroring the auto-extract leg — the edge that
  actually nests the page cloud-side. A locally-missing hub still emits (warn-not-reject; the
  fail-closed guardrail is R6.3/W2, gated on browse being live). Response additively echoes
  `link: { targetPath, relation }`.
- **R1.3 `memory_curate` promote_to_hub `childPaths[]`** (`__init__.py`, `rpc.ts handleCurate`,
  `adapters/memory-tools.ts`): pass-through to the cloud POST body so the promoted hub can attach
  children in the same transaction (cloud lane consumes; older clouds ignore the extra field).
- **R6.1 hub snippet wiring** (`daemon/memory/hook-server.ts`): the extraction recall context now
  carries WHAT each hub is about — `description`, else first ~200 chars of content, else `''`.
  (The old call site mapped hubs without a snippet, so the extract model was blind to hub topics
  and rationally fell back to `placement=new` → orphan leaves.)
- **R6.2 `memory_browse` / `GET /local/memory/place-context`** (`rpc.ts`, `__init__.py`,
  `adapters/memory-tools.ts`): write-time structure view `{ index, hubs[], nearest[] }` (each
  `{path,title,pageType,snippet}`), assembled by the SHARED `assemblePlaceContext` helper the
  extraction leg uses — browse and extraction cannot drift. `q=` adds nearest pages via the same
  local hybrid search; F5 cap predicate applies (private pages hidden). `memory_load` additively
  returns the page's outbound `links` (best-effort cloud `GET /pages/:id/links`; omitted offline).
  FROZEN spec (`adapters/memory-tools.ts`) now lists `memory_write` + `memory_browse` (R6.5 partial).
- **R8.1 traceId 贯穿** (`__init__.py` → `hook-server.ts` → `extract.ts` → `envelope.ts` → `rpc.ts`):
  `sync_turn` stamps `extra.trace_id` (session id + random suffix); the daemon threads it through
  extraction into the `memory.page.upsert` / `memory.link.upsert` outbox envelopes (optional
  `traceId` added to `MemoryEventCommon` — additive, no schemaVersion bump). `handleWrite` accepts
  an optional `traceId` (else mints `wr_<10hex>`).
- **R8.2 stage counters + standardized stage logs** (`hook-server.ts`, `extract.ts`,
  `daemon/local-server.ts`): module-level `{received, skipped, extracted, writeFailed}` counters
  surfaced on `/healthz` as `memory.counters`; every pipeline stage logs one grep-able line —
  `[memory-trace] stage=received|skipped(reason=…)|llm_called|llm_failed(status=…)|written(paths=…)|synced traceId=…`.
- **R9.1 sync_turn delivery hardening** (`__init__.py`): the bare `except: pass` around the
  post_llm_call POST is replaced with at-least-once delivery — one retry after ~1s; terminal
  outcome always lands as ONE structured stderr line (`[memory-trace] sync_turn delivered …` /
  `… delivery FAILED err=<class>: <msg>`). Still fire-and-forget: never raises into the turn.
- Tests: `test/memory-place-context.test.ts` (7), `test/memory-write-placement.test.ts` (8),
  `test/memory-stage-counters.test.ts` (5) — each new behavior with a negative control.

### Fixed — memory extraction dropped under real docs (generation outran the 30s client timeout)

- **Why:** test-verified (2026-07-02, memory203 systematic doc-ingest) — a full-doc extraction
  prompt with `max_tokens: 4096` on `us-kimi-k2.6` takes **29–44s** to generate. The daemon's
  extraction gateway call was bounded at **30s**, so under real documents the call aborted
  mid-flight (`status=0 cloud_unreachable "Request aborted/timeout"`), the 2-retry budget was
  exhausted, and the memory was silently dropped — 6 docs yielded ~1 page, 0 hubs. (The cloud
  proxy completed the work at ~29s, but the daemon had already given up.) A control run with the
  workspace concurrency limiter OFF reproduced identically → the limiter was **exonerated**; the
  cause was purely extraction generation-time vs client-timeout.
- **What changed** (`daemon/memory/extract.ts`): `max_tokens` 4096 → **2048** (fits 6 concise
  pages at ~300 tok each while keeping generation well under the bound) and
  `GATEWAY_TIMEOUT_MS` 30s → **60s** (margin over the measured worst case). Both are now
  env-overridable — `MEMORY_EXTRACT_MAX_TOKENS`, `MEMORY_EXTRACT_TIMEOUT_MS` — so ops can tune
  without a daemon rebuild.

### Changed — memory skills/seeds repointed from `cloud memory` → `prismer memory` (post-2822f36f CLI separation)

- **Why:** commit `2822f36f` dropped the erroneous `cloud` bin from @prismer/runtime (it
  collided with @prismer/sdk's `cloud` bin → EEXIST on global install). The two CLIs are now
  cleanly separated: `cloud` = @prismer/sdk (cloud-side HTTP, incl. the memory203/13 decision-D
  **retired** memory HTTP impl), `prismer` = @prismer/runtime (this canonical daemon CLI). In
  the agent-rt image both tarballs install, so in-pod `cloud memory` would now resolve to the
  RETIRED sdk HTTP path — the daemon-backed memory CLI is `prismer memory`.
- **What changed:** repointed every agent-facing `cloud memory …` reference to `prismer memory …`
  across the memory built-in skills, seeds, and adapter/CLI docs:
  `built-in-skills/memory/SKILL.md`, `built-in-skills/memory-dream/SKILL.md`,
  `src/im/data/memory-seed/{index.ts,sdk-intro.md}` (memory/recall moved to the `prismer` family;
  task/send/asset/load/parse/deliver/okr/pay stay `cloud`), the claude-code/codex
  `adapters/coding/*/memory-tools.ts` doc comments, this package's `cli/commands/memory.ts`
  header, and the desktop copy `apps/desktop/resources/runtime/built-in-skills/memory/SKILL.md`
  (whose stale `cloud memory extract/consolidate/compact` were aligned to the canonical set —
  `extract` → direct `prismer memory write` + automatic background review; `consolidate` →
  `prismer memory curate`; `compact` dropped, no canonical equivalent). `prismer memory` covers
  recall/search/read/list/write/delete/curate. No behavior change to the daemon `/local/memory/*`
  RPC; this is a CLI-name correction so in-pod agents hit the daemon, not the retired sdk HTTP.

### Clarified — code-agent memory path is the `prismer memory` CLI, NOT a native tool surface (memory203/09 §① gap G, resolved to §10 decision)

- **Context:** doc memory203/09 §① flagged 🔴 "CC/codex adapter 工具未接 dispatch
  (`memory-tools.ts:10`)" — i.e. the per-adapter memory tool schemas were never wired into
  the running code agent. Investigation shows the gap is **narrower than the 🔴 implies and
  already resolved by design**: doc memory203/10 §56 decides code agents
  (claude-code/codex/opencode) have no Hermes-style programmatic provider seam (they run as
  filesystem CLI subprocesses), so their memory path is the **`prismer memory` CLI + the
  `memory` built-in skill**, which hits the SAME daemon `/local/memory/*` RPC as the Hermes
  tool impls. That CLI is fully implemented (`src/cli/commands/memory.ts`:
  recall/read/write/list/curate, registered in `cli/index.ts`) and the `memory` skill
  (`scope: common`) is seeded into every coding workdir's `.claude/skills/` via
  `CODING_COMMON_ALLOWLIST` (`adapters/coding/shared/coding-skill-set.ts`), with the
  AGENTS.md/CLAUDE.md preamble pointing the agent at `prismer memory`. So recall/read/write/
  curate are available to code agents out of the box — through the CLI, not a tool schema.
- **What changed:** corrected the now-misleading "adapter integration owner work / NOT shipped
  in phase-0" header comments in `adapters/coding/claude-code/memory-tools.ts` and
  `adapters/coding/codex/memory-tools.ts` to record the §56 decision (CLI is the path; the
  native tool surface is intentionally Hermes-only; these schemas are a consumer-less FORMAT
  FREEZER kept for parity / a possible future programmatic seam — do NOT force-wire them).
- **No behavior change** — comment-only; the runtime memory path for code agents already works
  via the CLI + skill.

### Added — Dream CONVERGENCE: orchestrator can now READ candidates + a concrete convergence oneshot (memory203/13 §P4 + §0.5)

- **Why:** the write path produces well-placed anchored leaves, but at SCALE the wiki
  degrades into a **FLAT STAR** (`INDEX → many leaves directly`), not a navigable
  hierarchy. The curation WRITE verbs (promote-to-hub / supersede / rebuild-index)
  existed, but the orchestrator had **no way to READ what to converge** — orphan leaves,
  near-duplicate clusters, stale pages all lived cloud-side with no daemon passthrough.
  The "brain" (orchestrator's own LLM) had hands but no eyes; it could not DECIDE clusters.
- **Daemon READ passthrough (`daemon/memory/rpc.ts`):** new `GET /local/memory/health?workspaceId=&kind=&limit=`
  forwards to the cloud candidate surfaces `GET /api/im/memory/health/{orphans|duplicates|stale}`
  and returns `{ ok, candidates: { orphans, duplicates, stale } }` (each `{ items, total }`).
  `kind=all` (default) fetches all three. Same passthrough shape as `handleCurate` — ws cap
  gated daemon-side, ACL gated cloud-side, **ZERO cloud LLM** (it only scans the page graph).
  Offline (`cloud` unwired) → 200 degraded empty, honouring the same "降级不中断" contract.
  Forwards the verified acting agent in `X-Prismer-Memory-Actor` so the workspace ACL
  projection is correct.
- **CLI (`cli/commands/memory.ts`):** new `cloud memory curate candidates [--kind orphans|duplicates|stale|all] [--limit N]`
  — the READ half. GET to the daemon health route. Read-only (any agent), unlike the three
  orchestrator-gated write verbs.
- **Tool (`adapters/memory-tools.ts`):** `memory_curate` gains a `candidates` op (additive to
  the existing `promote_to_hub` / `supersede` / `rebuild_index`) with `kind` + `limit` inputs;
  it branches to the daemon's GET health route and returns the `candidates` payload. Read-only,
  so it is offered to every agent (the LLM clusters; the cloud does not).
- **`built-in-skills/memory-dream/SKILL.md`:** new **"## Convergence flow (oneshot)"** — STEP 1
  READ candidates → STEP 2 DECIDE clusters (the agent's LLM) → STEP 3 per-cluster `promote-to-hub`
  a representative + re-anchor members under it (typed `<a rel="parent" prismer://…>` write) →
  STEP 4 `rebuild-index` so INDEX becomes a TOC of hubs. One worked example (8 scattered
  `project/helios-*` orphan leaves → `project/helios` hub → re-anchor → rebuild). Fixed the
  stale `cloud memory curate run-dream` reference (that retired cloud-LLM command no longer
  exists — replaced by `candidates` + the write verbs).
- **Re-anchor note (flagged, not built here):** there is no single "move-anchor" verb. Re-anchor
  is `promote-to-hub` (mints the hub) + a `cloud memory write` adding the member→hub `rel="parent"`
  link; `rebuild-index` then drops hub-parented leaves out of the top-level INDEX automatically.
  This reuses existing cloud endpoints; no new cloud verb requested.

### Changed — `memory` skill: add a concrete oneshot WRITE flow so agents actually persist PKF

- **Why:** a live agent ran a turn but wrote NO memory page — the skill's write guidance was
  too abstract. The corrected, baked-in flow is **construct-PKF-first, then find where to
  store it**: (1) CONSTRUCT the full PKF page from the conversation, (2) PLACE by consulting
  the index (`cloud memory read INDEX.pkf` + `cloud memory recall`) and deciding extend /
  attach-under-hub / new-semantic-path (never an orphan leaf), (3) WRITE to the decided path.
- `built-in-skills/memory/SKILL.md`: new **"## Write flow (oneshot)"** section with a single
  copy-pasteable end-to-end example (conversation excerpt → constructed `decision` PKF →
  index-consultation commands + placement reasoning → `cloud memory write`). Reconciled the
  Operating Rules → Write list so reading `INDEX.pkf` is a WRITE step, not only a Read step.
  PKF format rules are referenced, not duplicated. The example PKF validates clean against
  `src/lib/pkf` (frontmatter + `<h2 id>` sections + typed `prismer://workspace` link).
- New standalone reference `scripts/cookbook/memory-write-oneshot.md` (the canonical example
  the skill points to).

### Added — DAEMON-SIDE automatic memory extraction (the "自动" leg) + remove cloud-Dream from curate (memory203/13 §0.5 + line 101, Fix Batch B)

- **Why:** automatic extraction was DEAD. Hermes's native `background_review`
  spawns with `skip_memory=True`, so our `memory_write` provider tool is never
  injected into the review fork — whatever it "remembers" lands in Hermes's
  built-in MEMORY.md, never our cloud PKF wiki. So the "自动" leg is now
  implemented OURSELVES, in the agent runtime (the daemon in the agent's pod).
- **In-pod gateway extraction (`extract.ts` rewritten):** instead of forwarding
  to the retired cloud `/api/im/memory/extract` (410), `extractFromTurn` now calls
  the LLM gateway DIRECTLY from the daemon — `${cloud.baseUrl}/api/v1/messages`
  (Anthropic wire) authed with `Bearer ${cloud.apiKey}`, the SAME agent-credentialed
  gateway path the code-agent providers use (`PRISMER_BASE_URL` + sk-prismer token,
  injected for the hosted agent at runner.ts:325-329). The INITIATOR is the agent
  runtime; the cloud only proxies. **NO cloud LLM call remains.** The prompt carries
  a recall context built from the LOCAL store (INDEX + hubs + nearest pages) so the
  model decides placement (extend / attach-under-hub / new leaf) against the real
  wiki, and returns minimal valid PKF (`<h1>`/`<h2 id>`/`<p>`; cloud materialize
  validates). Bounded retry (2 attempts) on transient gateway failure; never blocks.
- **Post-turn hook re-purposed (`hook-server.ts`):** `handlePostLlmCall` (a no-op
  after P3') now responds 204 immediately, then fire-and-forget builds the recall
  context, runs the in-pod extraction, and writes each PKF page via the SAME direct
  path `handleWrite` uses — `slot.store.write` + outbox `memory.page.upsert` — so
  pages up-sync and get anti-orphan-anchored on cloud. Scratch/eval sessions skipped.
  `extract.ts` is re-wired (dead cloud-extract imports removed).
- **`run_dream` removed from curate:** the Python provider `memory_curate` no longer
  advertises `op=run_dream` to every agent, and the daemon `handleCurate` (rpc.ts)
  no longer forwards `run_dream` to the cloud `/page-dream` LLM. Dream is the
  orchestrator's memory-dream skill calling the write VERBS, not a cloud-LLM trigger.
  The three write-verb ops (promote_to_hub / supersede / rebuild_index) are kept.

### Changed — retire cloud-side memory extraction; extraction moves to the agent runtime (memory203/13 §0.5, P3')

- **Governance (用户裁决 2026-06-30):** all memory LLM work runs in the agent's
  OWN runtime; the cloud does ZERO LLM for memory. The cloud is storage only
  (materialize page upsert + anti-orphan-anchor to INDEX + recall queries).
- `memory_write` is a DIRECT write again. The daemon `POST /local/memory/write`
  handler reverts to `slot.store.write(...)` + outbox `memory.page.upsert`
  enqueue (the page then syncs to cloud, materializes, and is anchored to INDEX
  by the existing cloud path). It no longer wraps the content into a synthetic
  turn and routes it through any cloud-extract lane — that prior design is废'd.
  `memory_write` = the agent persisting a PKF page it ALREADY authored in its own
  runtime (主动 explicit, or Hermes `background_review` 自动).
- The daemon `extract-turn` / `extract-compress` routes (which forwarded turns to
  cloud `/api/im/memory/extract`) are RETIRED — they now short-circuit to an
  inert no-op and forward NOTHING to any cloud LLM. The `runExtract` /
  `runExtractInBackground` / `handleExtractTurn` / `handleExtractCompress`
  helpers (and the `extractFromTurn` import) were removed from `rpc.ts`.
- The Python Hermes provider: `memory_write` reverts to "write the PKF page you
  authored" (direct write; `path`/`content` are the literal page, not extraction
  hints). `sync_turn` / `on_pre_compress` are now NO-OPs (they no longer forward
  to the retired cloud-extract routes); automatic auto-extraction is Hermes's
  native `background_review` in-runtime. The unused `_http_post_async` helper was
  removed.
- (cloud, src/im) `extractMemories` (the cloud LLM extractor) + its
  `buildWikiRecallContext` structured-recall helper are retired: `memory-extract.ts`
  is now an inert tombstone that throws, and `POST /api/im/memory/extract` returns
  410 Gone. No cloud LLM call remains for memory.

### Changed — auto-extraction is now non-blocking + index-TOC injection is structure-preserving (memory203 scale prep)

- **Non-blocking extract** — `sync_turn` (provider shell) now dispatches the
  `extract-turn` POST on a daemon thread (`_http_post_async`) and returns
  instantly, so an agent reading many docs never stalls the turn loop on the
  cloud LLM round-trip. The daemon `extract-turn` handler ACKs `202 {queued}`
  immediately and runs `extractFromTurn` in a detached promise (errors logged,
  never lost). In-process callers (`hook-server`) keep the awaitable
  `{pages,extracted,error}` contract — fire-and-forget is the HTTP-path default
  only. New `test/extract-nonblocking.test.ts`.
- **Index-TOC scaling** — `index-toc.ts` no longer drops the tail when the
  injected workspace index exceeds the (hard, Hermes-2200-capped) ≤1,800-char
  managed-section budget. It now truncates DEPTH-FIRST — every top-level hub
  heading (the navigational spine) survives; only the deepest leaf detail is
  trimmed — and appends an observable marker (`… N more sections — load the
  index page`) so the agent knows to drill in rather than assume it saw
  everything. Stays a pure function.

### Added — multi-device remote-conflict status surfaced to the daemon (memory203 doc 07)

- The distributed reconcile core (invalidate fan-out + LWW/DAG conflict
  resolution + idempotency) already worked (7/7 e2e), but a daemon never learned
  its write LOST a conflict — the `remote-conflict` status lived only in cloud
  metadata. Now it travels cloud→daemon two ways: (A) inlined in the sync-inbox
  ACK (`SyncInboxResult.conflicts[]`) so an online loser learns immediately, and
  (B) on down-sync re-pull, the cloud page summary/detail carries
  `syncStatus:'remote-conflict'` (computed in `enrichSummaries` from the live
  curation-conflict version pointer) and `cloud-sync.materialisePage` stamps the
  local row via the new `MemoryStore.setSyncStatus`.
- New `GET /local/memory/conflicts` (peek, not resolve) lists local
  remote-conflict pages to the host, behind the same F5 boundary predicate.
- Tests: cloud `conflict-status.test.ts` 4/4 + daemon `memory-conflict-status.test.ts`
  3/3, both with negative controls; existing `memory-e2e-sync.test.ts` stays 7/7.
  Offline catch-up cursor (C7) remains the pre-existing deferred limitation.

### Added — at-rest memory encryption ACTIVATION behind flag (memory203 M-ENC, default OFF)

- The AES-256-GCM primitives (`crypto-cipher.ts`, `key-manager.ts`), the outbox
  encrypt path, and the cloud decrypt/FTS-exclude were already present but never
  fired — no caller marked a page `encrypted=true`. Activated the daemon write
  side: `MemoryStore` gains an `encryptionPolicy?` seam; `runner-wiring` installs
  a policy that returns true only when `isEncryptionEnabled()`
  (`FF_MEMORY_ENCRYPTION_ENABLED==='true'`, dynamic, default OFF) AND storage is
  not ephemeral AND a durable workspace key exists. `store.write` consults it
  only when the caller didn't set `encrypted` explicitly (down-sync's explicit
  per-page flag is never overridden). Fail-closed: flag off / ephemeral / no key
  → plaintext, never keyless ciphertext.
- New `test/memory-encryption-roundtrip.test.ts` (6 tests): encrypt→outbound
  ciphertext→down-sync decrypt round-trip + 2 negative controls. Cross-device key
  sharing stays out of scope (doc 06 deferral).

### Fixed — auto-extract error surfacing + read-after-write + PKF round-trip (memory203 Wave 1)

- **`daemon/memory/extract.ts#extractFromTurn`** — no longer returns a bare
  `ExtractedPage[]` (which collapsed LLM timeout / bad-response into a silent
  `extracted:0`). Now returns `{ pages, extracted, error }`: `error` is set on a
  cloud/LLM transport failure OR when the cloud produced candidates that were all
  rejected by the PKF round-trip gate (`saved=0 && skipped>0`), so a degraded
  extract is observable instead of masquerading as "nothing to save". Adds a
  bounded 1-retry on transient (status 0 / 5xx / network) failures with warn logs.
- **read-after-write** — after mirroring an extracted page into the local
  `ScopedMemoryStore`, `confirmMirror()` re-reads it via the same bucket so the
  next turn's recall is guaranteed to see it; a miss logs loudly (best-effort, the
  cloud holds the canonical row).
- **`rpc.ts` / `hook-server.ts`** — both extract consumers propagate the new
  `error` field instead of dropping it.
- New `test/memory-extract-turn.test.ts` (9 tests incl. negative controls: all-
  rejected candidates → error surfaced, 5xx → retried, malformed PKF → not
  persisted) + cloud-side `assertPkfRoundTrips` gate in `memory-extract.ts`.

### Changed — memory203 agent-integration convergence onto the native MemoryProvider (doc 10 §3)

- **`adapters/persistence/hermes/index.ts#configurePrismerProvider`** — when the
  Prismer MemoryProvider is active (`installMemoryProvider` / `PRISMER_MEMORY_PROVIDER=1`)
  it now SUPERSEDES the two fragmented paths: the curl `installMemoryHooks` block is
  skipped (the provider's in-process `sync_turn`/`prefetch` are the native equivalent —
  running both double-extracts the same turn) and the standalone recall-tools plugin is
  NOT installed (the provider's `get_tool_schemas` already exposes `memory_search`/
  `memory_load`/`memory_curate`). Both paths remain intact as the **no-provider
  fallback** (eval opt-out via `installMemoryHooks: false` preserved). `configurePrismerProvider`
  + `HermesProfileConfigSchema` are now exported for the config-gen unit test.
- **Port fix** — the daemon-port default across the hermes config-gen + the Python
  provider shell (`plugins/memory/prismer/__init__.py`) moved from the stale `3210`
  to `7878` (the daemon's real loopback port in agent-rt; `PRISMER_DAEMON_PORT` env
  still wins). The provider's `_http_get` + the `prismer memory` CLI both read
  `PRISMER_DAEMON_PORT`, which the config-gen writes into the profile `.env`.
- **`test/memory-provider-configgen.test.ts`** — new: asserts provider-on pins
  `memory.provider: prismer`, writes `PRISMER_DAEMON_PORT` to `.env`, installs neither
  hooks nor double recall-tools; provider-off fallback still wires the curl hooks (7878).
- **Provider-install path fix (`installMemoryProviderShell`)** — the shell was copied
  to `<profile>/plugins/memory/prismer/`, but Hermes's MEMORY-provider scanner
  (`plugins/memory/__init__.py` `_iter_provider_dirs`) discovers USER-installed
  providers ONE level deep at `<HERMES_HOME>/plugins/<name>/` — the extra `memory/`
  segment exists only for BUNDLED providers. So `find_provider_dir("prismer")` returned
  `None` and the provider was NEVER loaded: the agent saw no `memory_search` tool and
  reported "memory not available" despite correct config + a working daemon RPC. Fixed
  to install at `<profile>/plugins/prismer/`. Verified live in agent-rt: relocation →
  provider loads (`3 tools`) → agent recalls the seeded Helios corpus (18,400 ev/s)
  end-to-end. The two install/config-gen tests asserted the broken nested path (green
  while encoding the bug); both updated to the discoverable layout + a guard that the
  nested path is absent.

### Fixed — daemon FTS recall is AND-first with OR-fallback (not AND-only)

- **`search.ts#hybrid`** — the local FTS MATCH joined every term with implicit
  AND, so a natural multi-word recall ("helios throughput target") only hit pages
  containing ALL terms; a padded query silently returned zero. Now runs AND first
  (precision), then relaxes to OR when AND yields nothing and the query has ≥2
  terms (recall gate). BM25 still ranks pages matching more terms higher.

### Fixed — cloud→daemon subset projection preserved visibility + canonical id (live MVP3/MVP4)

- **ACL leak (`cloud-sync.ts#materialisePage`)** — the visibility projection was
  `page.visibility === 'agent'`, but the cloud stores an owner-PREFIXED string
  (`agent:<imUserId>`). The exact match never hit, so EVERY agent-private page
  was stored `{kind:'workspace'}` and recallable by every in-workspace agent (a
  second agent surfaced another agent's private cost page in the live MVP3 run).
  New `parseCloudVisibility()` maps `workspace` / `agent:<id>` / fail-closed
  `private:<id>` (human:/task:/unknown owner kinds), preserving the owner id the
  boundary predicate (`canCapReadPage`) gates on.
- **Curate 404 (`store.ts#write` + `MemoryWriteInput.id`)** — the subset minted a
  local `page_<uuid>` id instead of the cloud's canonical id, so `memory_curate`
  promote-to-hub/supersede forwarded an id the cloud didn't know → 404 (the agent
  then faked success). `materialisePage` now passes `page.id`; the subset mirrors
  the superset's id. Daemon-authored writes still mint a local id; path conflicts
  retain the existing id (content/fts/links FK-safe).
- **`test/memory-cloud-sync.test.ts`** — extended with agent:/human: pages
  asserting visibility kind+owner AND the preserved cloud id (the corpus only
  exercised `visibility:'workspace'`, which is why both bugs hid).

### Added — memory203 local-first load fallback + invalidate re-pull + F5 search收口 (doc 07 §3/§4, doc 08 §4a)

- **`daemon/memory/cloud-sync.ts#fetchPageFromCloudByPath`** — targeted single-page
  回源 for the local-first `load` fallback: a subset MISS pulls just that page from
  the cloud superset (`GET /api/im/memory/resolve?uri=`), materialises it via the
  existing `materialisePage` (identical decrypt + visibility + write), and the handler
  re-loads it locally (<5ms FTS). Strictly best-effort + local-first: offline → the
  fetch returns false → genuine 404, never a 5xx ("断云仍 load 本地").
- **`daemon/memory/rpc.ts`** — `handleLoad` is now async; `attachMemoryRpc` gained a
  `keyManager` option (runner wires `memoryWiring.keyManager`) so回源'd encrypted pages
  decrypt to local plaintext (fail-closed to sentinel when keyless).
- **`daemon/memory/ws-invalidate.ts`** — a non-`soft_delete` cloud invalidate
  (visibility_changed / promoted / archive) now fires a best-effort
  `initialSyncFromCloud` to re-pull the fresh SUBSET projection (watermark-bounded,
  subset fields only — never the full aclJson). `soft_delete` stays mark-only.
- **`daemon/memory/rpc.ts#handleSearch`** — F5 search收口 (option a): when a cap is
  present, search hits are filtered through `canCapReadPage` (bounded `loadById` point
  lookup per hit, topK ≤ 20) so another agent's private-page snippet never leaks via
  search — F5 is now uniform across load / list / search.
- **Tests** — `memory-load-fallback` (4), `memory-ws-invalidate` (+1 re-pull),
  `memory-acl-predicate` (+1 search filter). True daemon↔cloud contract проven by
  `scripts/cookbook/e2e-memory-sync.ts` (real outbox envelope → real `ingestSyncInbox`
  → materialises `IMMemoryPageSection` + `IMMemorySyncEvent`; flushed:1 deadLettered:0).

### Added — P0 memory security spine: per-agent scoped capability tokens (memory203 doc 08, F1–F5)

Closes the 🔴 daemon memory空腔 (doc 06 §2): `/local/memory/*` RPC + key access had
no credential / workspace scope — any same-pod agent could pass another `workspaceId`
to read/write/decrypt across workspaces. The fix is mechanism **C3**: the daemon
self-signs + self-verifies a per-agent **capability** with a per-boot key.

- **`daemon/memory/cap.ts`** (new) — `mintCap(sub, ws)` / `mintSystemCap()` /
  `systemCap()` / `verifyCap()` / `capAllowsWorkspace()` / `isSystemCap()`. Token =
  `v1.<b64url(payload)>.<HMAC>`; payload = `{aud:'memory', sub, ws, scope:['ws:'+ws],
  iat, exp}`. The per-boot key is `randomBytes(32)` held ONLY in module memory — never
  written, serialized, returned, or injected (daemon restart → new key → all prior
  caps reject). Agent caps are single-workspace; `ws:*` is hard-rejected for agents and
  reserved for the daemon-internal system cap.
- **`daemon/memory/rpc.ts`** — every handler now passes a verified cap and gates the
  effective workspaceId (query / body / `?uri=`) via `scopeOk`/`effectiveWs`: cross-ws
  → 403 `memory_ws_scope_violation`. `PRISMER_MEMORY_CAP_ENFORCE` (default OFF one
  release cycle): no/invalid cap → 401 `memory_cap_invalid` when on, warn+proceed when
  off — but a present cap is ALWAYS scope-checked. Out-of-process provider routes now
  stamp `actorImUserId` from `cap.sub` instead of `''`.
- **`daemon/memory/key-manager.ts`** — `getKey(workspaceId, cap)` gates key access via
  `capAllowsWorkspace` and returns null WITHOUT touching the filesystem when the cap is
  not authorized (fail-closed; the AES key is never the cap). `getKeyOrNull` is now the
  internal raw loader. Daemon-internal flush/write-down callers
  (`outbox-worker.ts`, `cloud-sync.ts`) pass `systemCap()`.
- **`daemon/memory/acl-predicate.ts`** (new) — `canCapReadPage(cap, page)`: the daemon's
  BOUNDARY projection of the shared ACL predicate (ws scope + page visibility kind),
  wired into `load` (cross-agent private → 404, no existence leak) and `list` (filter).
  The cloud keeps the FULL projection (`memory-acl.ts` aclJson) — two layers, no drift.
- **Injection chain (F4)** — `adapters/prismer-env.ts` mints `PRISMER_MEMORY_CAP` from
  the dispatch metadata (covers claude-code/codex/provider-proxy via
  `applyPrismerScopeEnv`); the hermes gateway spawn injects it per-boot;
  `adapters/memory-tools.ts` and the two python shells
  (`plugins/{memory/prismer,tools/prismer-recall}/__init__.py`) forward it as the
  `x-prismer-memory-cap` header (env-default, zero extra wiring for in-process tools).
- **Tests** — `memory-cap` (15), `memory-cap-rpc` (10), `memory-cap-injection` (5),
  `memory-acl-predicate` (6), `memory-encryption` (+2 key-gate). 274 memory tests green.

### Changed — `cloud task create` delegation is now a tracked board card (release203/21 §4 T1)

- **`cli/commands/task.ts`** — `cloud task create --agent <id>` now defaults to a
  **delegated work_item** (`metadata.kind='work_item'` + `dispatchPolicy='on-assign'`)
  instead of `kind='agent_run'`. The task therefore lands on the Kanban board (留痕/
  可观测) **and** auto-dispatches the moment the assignee is set — decoupling "shows
  on the board" (kind) from "auto-dispatches" (dispatchPolicy). Result write-back +
  session-anchor binding are unchanged (the cloud settles the board card itself via
  the IMTask fallback path).
- **New `--no-card` flag** preserves the prior pure no-card run channel
  (`kind='agent_run'`) for internal/orchestrator sub-steps that should NOT surface
  as a board card.

### Added — `agent.fs.read` / `agent.fs.write` repo data-plane RPCs (release203/21 §6 R, C3)

- **`daemon/fs-read.ts`** (`readReposFile`) + **`daemon/fs-write.ts`** (`writeReposFile`)
  — new reverse-channel RPCs mirroring the existing `agent.fs.list`: same
  `resolveProjectReposDir` base + path-jail (no `../` escape out of the workspace
  root). `agent.fs.read` returns `{ content, encoding:'utf8'|'base64', sizeBytes,
  mtimeMs, sha256, mime? }`, rejects >1 MiB (`too_large`), base64s binary.
  `agent.fs.write` is atomic (temp+rename, `mkdir -p` parents), honours optional
  `ifMatchSha256` (mismatch → `conflict`, no overwrite).
- **`daemon/runner.ts`** — wired `agent.fs.read` / `agent.fs.write` cases
  (`onAgentFsRead` / `onAgentFsWrite`, mirroring `onAgentFsList`); replies on
  `agent.fs.read.reply` / `agent.fs.write.reply`. Old daemons lacking these cases
  fall through to `unknown-message` → cloud invoke times out → frontend degrades to
  read-only (no version negotiation needed).
- Cloud side: `POST /api/im/workspaces/:wid/fs/{read,write}` + `RepoCodePanel` /
  `/repo-code-lab` Monaco harness (see cloud repo). Live-verified: write→read exact
  roundtrip + `ifMatchSha256` conflict guard.

### Added — INDEX dynamic core-inject (memory202 doc 05 §4.2a, flag-gated OFF)

- **`daemon/memory/index-toc.ts`** — `buildIndexToc(indexMarkdown, budget)`: a
  PURE, section-aware, bounded TOC builder over the workspace INDEX page (the
  curated memory MAP). Within budget → the whole map prefixed with a short
  `# Memory Map` header; over budget → drops to the SKELETON of headings (the map
  shape) cut at heading boundaries, NEVER mid-section. Reuses the recall path's
  fence-aware ATX scanner (`section.ts#scanHeadingsForToc`) so "what is a section"
  is identical across slice + TOC. Empty / whitespace / budget≤0 → `''` (no throw).
- **`daemon/memory/index-toc-inject.ts`** — flag-gated wiring that reads the local
  INDEX page → `buildIndexToc` → the EXISTING `coreInject` carrier
  (`createHermesMemoryIntegration(...).coreInject` → MEMORY.md managed section,
  already tracked by `recall-stats.recordCoreInject`). So an agent always has the
  current memory map in context. Gated on **`FF_MEMORY_INDEX_INJECT_ENABLED`**
  (default OFF → zero behaviour change, no `coreInject` call).
- **`MemoryStore.loadIndexPageContent()`** — reads the workspace's
  `pageType='index'` page content (queried by the raw `'index'` string the cloud
  emits and `materialisePage` stores verbatim).
- **Daemon trigger:** wired into `syncMemoryFromCloud` (runs on initial sync +
  post `host.acked`) — "dynamic" = re-injects whenever the synced map changes. The
  runner supplies the per-hermes-profile MEMORY.md carrier path(s); the wiring
  stops at "build TOC → call existing coreInject" and does NOT touch adapter-turn /
  envelope orchestration (that live-activation path stays held back).
- **Deferred (follow-up):** a "memory map injected" UI indicator (dim 1) and the
  default-on activation (a separate convergence gate, like envelope).

### Added — Memory at-rest encryption (memory202 doc 06, MVP, flag-gated OFF)

- **Local-first AES-256-GCM encryption for memory pages.** The daemon holds a
  per-workspace symmetric key; the cloud stores only ciphertext and NEVER holds
  the key. Encrypted pages are excluded from cloud full-text search (cloud can't
  read them) — searchable only on the daemon (local plaintext). Non-encrypted
  pages are completely unaffected. Gated on `FF_MEMORY_ENCRYPTION_ENABLED`
  (default OFF → zero behavior change).
- **`daemon/memory/crypto-cipher.ts`** — `encrypt`/`decrypt` over
  `crypto.createCipheriv('aes-256-gcm', …)` with a random 12-byte IV per call;
  self-describing packed format `v1:<iv>:<tag>:<ct>` (base64url). Authenticated:
  a GCM-tag/ciphertext tamper or wrong key throws on decrypt (never leaks
  plaintext).
- **`daemon/memory/key-manager.ts`** — per-workspace 32-byte key generated on
  first need, persisted `<baseDir>/<workspaceId>/.memkey` (0600), reloaded on
  demand. The key never leaves the daemon. **Fail-closed:**
  `PRISMER_EPHEMERAL_STORAGE=true` (agent-rt emptyDir) → refuses to encrypt
  (returns null; caller writes plaintext with a loud warn) so a key written to
  ephemeral storage can never be lost-then-orphan-the-ciphertext. A persist /
  round-trip-verify failure likewise fails closed.
- **`MemoryStore.write({ encrypted })`** threads the flag to the local
  `memory_pages.encrypted` column (was hardcoded 0); local SQLite + FTS keep
  PLAINTEXT (recall needs it) — encryption happens only on the cloud-bound
  outbox payload.
- **Outbox flush encryption** (`outbox-worker.ts`): a `memory.page.upsert` whose
  page row is `encrypted=true` has its `payload.content` encrypted in the POST
  body only. A page that should be encrypted but cannot be (no key) is held back
  (left pending), NEVER POSTed in the clear.
- **Sync-down decrypt** (`cloud-sync.ts`): ciphertext pulled from the cloud is
  decrypted with the local key before landing as plaintext in local FTS. **Cross-
  device deferral:** key absent / decrypt fails → stores an unreadable sentinel
  (never ciphertext-as-content), sync never crashes.
- **Deferred (per doc 06):** agent-rt ephemeral-pod encrypted memory (fail-closed
  for now), cross-device key exchange, key rotation / re-encryption.

### Added — Hermes per-dispatch identifier auto-resolution (release203/15c WS-E3)

- **`cloud deliver` / `cloud task attach` / `cloud file send` / `cloud attach`
  now work on Hermes agents WITHOUT manually copying `--run-id` /
  `--conversation-id`.** Hermes (persistence) agents have no per-dispatch env
  (the gateway spawns once with a frozen env; per-dispatch ids only reach the
  model via `<execution_context>` XML, never the tool-shell). Previously the
  agent had to abstract the ids out of `<execution_context>` and pass them as
  flags or the daemon proxy returned "taskId required".
- **`RunSessionRegistry.lookupActiveByAgent(agentImUserId, { adapterName?,
  conversationId?, ttlMs? })`** (`daemon/memory/run-session-map.ts`) — reverse-
  lookup the agent's CURRENT in-flight dispatch from `local_run_sessions`
  (reusing the existing `(conversation_id, agent_im_user_id, adapter_name)`
  index; NO new table/migration). Returns `null` (0 active), the ctx (exactly
  1), or `{ ambiguous, candidates }` (>1 with no narrowing key). 15min in-flight
  TTL window.
- **`daemon/asset/deliver.ts`** `validate()` relaxed: `taskId` may be empty when
  `resolveActiveDispatch:true` + `agentImUserId` present; the handler then
  reverse-looks-up to fill taskId(=runId)/conversationId. Race-safety (doc §5):
  conversation-narrowed lookups are unambiguous; **>1 in-flight run with no
  narrowing → HTTP 409, NEVER a silent mis-attach**; miss → 400 "未找到活跃
  dispatch，请传 --run-id". `DeliverRequest` gains `agentImUserId?` /
  `resolveActiveDispatch?`; `DeliverHandlerResult` status union gains `409`.
- **Hermes `terminal.env_passthrough` config (`adapters/persistence/hermes/
  index.ts`)** — registers `PRISMER_AGENT_USERNAME` / `PRISMER_AGENT_IM_USER_ID`
  / `PRISMER_DAEMON_PORT` / `PRISMER_WORKSPACE_ID` as passthrough so they survive
  Hermes' `_scrub_child_env` (allowlist scrub: only `_SAFE_ENV_PREFIXES` +
  registered passthrough reach the tool subprocess). **This corrects the design
  doc's premise** that the identity vars were already present in the tool-shell
  env: they are present in the GATEWAY env but were silently scrubbed from the
  CHILD env, which would otherwise leave `cloud deliver` with neither a dispatch
  id NOR an agent identity to auto-resolve from. These vars are identity/
  transport (not credentials, no KEY/TOKEN substring → not GHSA-blocklisted).
- Live cookbook `scripts/cookbook/regress-hermes-deliver-autoresolve.ts`: a real
  hermes agent runs `cloud deliver` with no flags → daemon log shows
  `[deliver] active-dispatch auto-resolve … runId=<this dispatch>` + the file
  lands as an asset; the >1-run ambiguity → 409 path is verified against the real
  migrated local SQLite schema.

### Added

- **Daemon-side Dream scheduler wired into boot** (memory202 doc 05). The
  `DreamScheduler` existed but was never instantiated (`new DreamScheduler`
  appeared only in tests) — the memory lifecycle was dead code. `attachMemoryRunner`
  now instantiates + `start()`s it behind `FF_MEMORY_DREAM_ENABLED` (default OFF,
  mirrors `FF_MEMORY_HTML_SIDECAR_ENABLED`), injecting a `CloudDreamRunner` that
  POSTs `/api/im/memory/page-dream` (fixed from a stale `/memory/page-dream` that
  would 404). Workspace tracking is fed via a new `MemoryOutboxWorker.onWorkspaceFlushed`
  hook → `scheduler.recordSessionEnd`. `recordActivity` is intentionally NOT fed
  from outbox flush (it drives the idle gate; feeding background flushes would
  perma-block dream) — the live-activity idle gate stays inert until adapter glue
  feeds `recordActivity` at LLM-call / tool-dispatch points (follow-up).
  `MemoryRunnerWiring.stop()` stops the scheduler. Flag OFF = zero behaviour change.

### Changed

- **`workspace member` list/add/update/remove logic extracted to a shared
  command-builder** (release203/15b WS-E4 §7.3 "B" rollout). The member-management
  verbs — identical endpoints (`/api/im/workspaces/:id/members`), identical role
  contract (`admin|member`; `owner` rejected as a v2.1+ RFC), identical
  remove-cascade — were duplicated verbatim against `cloud workspace member`. They
  now live once in `src/cli/shared/workspace-member-builder.ts`
  (`buildWorkspaceMemberCommand(adapter)`, parameterized by a
  `WorkspaceMemberAdapter` seam: `list/add/update/remove` + `emitList/emitMember/
  emitRemove` + `fail`). `prismer` injects a `CloudClient` + `ui.table`/`ui.line`
  adapter; `cloud` injects a `PrismerClient.workspaces.members` + padded-text
  adapter. Same no-dependency-edge / tsup-inline property as the `task wait` PoC
  (verified empirically: builder body inlined into `dist/cli.js`, no runtime
  `runtime/src` require). Behaviour preserved: success-path output and per-verb
  error codes byte-identical; the `--role` validation message is now the single
  canonical one (was already cloud's; prismer's variant retired). The `add` verb
  accepts BOTH the prismer positional (`<imUserId>`) and the cloud `--user` flag,
  so neither binary's existing invocation breaks. Gates:
  `regress-cloud-task-wait.ts` 4/4 + `regress-skill-cli-contract.ts` no new drift
  (workspace subcommands resolve via the followed builder import). The other
  candidate namespaces (`agent`/`memory`/`asset`) were audited and NOT extracted —
  their cross-CLI "overlap" is name-only over divergent transports/outputs, so a
  shared builder would change one side's UX (see `docs/release203/15b-*` §5).

- **`task wait` poll/settle logic extracted to a shared command-builder**
  (release203/15 WS-E4 §7.3 "B", PoC). The settle loop that both `prismer task
  wait` and `cloud task wait` (in `@prismer/sdk`) carried verbatim now lives once
  in `src/cli/shared/task-wait-builder.ts` — a transport/output-agnostic
  `buildTaskWaitCommand(adapter)` parameterized by an injected `TaskWaitAdapter`
  (`getTask`/`emit`/`fail`). `prismer task wait` supplies a `CloudClient` + JSON
  adapter; `cloud task wait` supplies a `PrismerClient.im` + text adapter. The
  two packages have no dependency edge — `@prismer/sdk` imports this module via a
  build-time relative path and `tsup` inlines it, so both tarballs stay
  standalone. Behaviour is byte-for-byte unchanged (settle on
  review/completed/failed/cancelled by default, `--terminal-only`,
  failed/cancelled → non-zero exit). Rollout for the remaining overlapping
  namespaces: `docs/release203/15b-shared-builder-plan.md`. Gates:
  `regress-cloud-task-wait.ts` 4/4 + `regress-skill-cli-contract.ts` green.

### Added

- **`cloud role create` / `validate` accept a role bundle DIRECTORY**
  (release203/16 §5.4 / §9 decision 2, P4). A role authoring unit is now either a
  single `role.json` (legacy, still accepted) OR a directory containing
  `role.json` + optional `SOUL.md`. When a directory carries a non-empty
  `SOUL.md`, its raw markdown becomes the role's `operatingPrinciples`
  (Hermes-compatible persona, slot#1), overriding/filling role.json's field;
  `AGENTS.md` is NOT part of the bundle (it's a per-role skill concept). Detection
  is by `statSync().isDirectory()`. New shared pure helpers `readRoleBundle` /
  `validateRoleBundle` (`src/bundle/index.ts`) back both the CLI and the zero-dep
  `role-builder/scripts/ingest-role.mjs` offline path. No cloud schema or
  service-signature change — only the source of `operatingPrinciples` (SOUL.md
  file vs json field). Tests: `bundle.test.ts` +7 dir-bundle cases,
  `skill-role-lifecycle-cli.test.ts` +2 CLI cases (49/49 green); runtime tsc clean.
- **Daemon honors cloud version-skew directive on `host.acked`** (release203/19
  §1.2/§2.2/§3, P2). The daemon already reports `daemonVersion` on every
  `agent.host.declare`; the cloud now compares it against its configured
  `EXPECTED_DAEMON_VERSION` and, per the `DAEMON_VERSION_SKEW_POLICY` Nacos flag
  (default `warn` ⇒ observability only), may attach an `upgradeDirective` to
  `host.acked`. The daemon reacts via `applyUpgradeDirective`:
  - `warn` / absent — no-op (normal operation; the common case).
  - `refuse_dispatch` — reject NEW dispatches in `onTaskDispatch` while in-flight
    runs drain and the daemon stays up.
  - `drain_respawn` — reject NEW dispatches AND arm a one-shot drain watcher that,
    once `runningTasks` empties (or a 30-min cap elapses), runs `stop()` and
    `process.exit(0)` so the device/k8s controller re-pulls a new-image pod.

  Backward compatible: a legacy cloud never sends a directive (field absent ⇒
  ignored). `HostAckedPayload.upgradeDirective` + `DaemonUpgradeDirective` added
  to `types/im-events.ts`. Covered by
  `test/daemon-version-skew-directive.test.ts`.

### Fixed

- **Daemon start-lock no longer self-locks on container restart** (release203/19
  §1.1/§2.1, P0). In a container the daemon runs as **pid 1** and writes
  `daemon.pid=1`. On a same-pod-sandbox container restart the emptyDir keeps the
  pidfile, so the new daemon — also pid 1 — saw `pidAlive(1)===true` and
  crash-looped with `Daemon already running (pid 1)` (Exited(1) loop hit by the
  doc17 e2e). The start guard now treats a **self-referential pidfile**
  (`existingPid === process.pid`) as our own stale leftover and proceeds,
  clearing the stale file before claiming it. New `daemonAlreadyRunning()` helper
  in `cli/util.ts` centralises the decision (`existingPid && existingPid !== ourPid
  && pidAlive(existingPid)`); both `runForeground` and `startBackground` use it.
  The pidfile is retained for `status`/`logs`/`stop`, but is no longer the sole
  liveness authority. The crash-safe positive fix for the residual pid-reuse class
  on non-pid-1 hosts (OS advisory flock) is intentionally deferred — Node has no
  built-in flock and the runtime carries no `fs-ext`/`proper-lockfile` dep; the
  self-pid guard fully resolves the container scenario without a native addon.
  Covered by `test/daemon-start-lock.test.ts`.

### Added

- **`prismer task wait <id>` / `cloud task wait <id>`** (release203/15 §WS-E2).
  Block until an ALREADY-delegated task settles, then print it — the
  orchestrator's "delegate → wait → act on the result" primitive (the
  `tasks`/`agent-coordination` skills point here) so it doesn't hand-roll a
  `cloud task get` poll loop. Reuses `pollUntilTerminal` (now parameterised by
  stop-statuses). Settles on `review/completed/failed/cancelled` by default —
  `review` included because for a delegated task it means "assignee finished,
  awaiting YOUR approval"; blocking until `completed` would deadlock the very
  orchestrator that must approve. `--terminal-only` for strict terminal; exits
  non-zero on `failed`/`cancelled`. Gate: `regress-cloud-task-wait.ts` (real CLI
  against the live API on completed + review tasks).

- **Hermes (persistence) tool-call-mapper → structured `ToolCallDetail`**
  (release203/15 §WS-G). Hermes tool steps now carry a structured `detail` so
  `execute_code`/terminal/file/search/fetch calls render rich + expandable in the
  unified timeline, exactly like coding agents — instead of the bare row
  ("import subprocess (+3 行)" = inputSummary) with no expand. New
  `adapters/persistence/hermes/tool-call-mapper.ts` reuses the
  `ToolCallDetail` union from `coding/shared/agent-sdk-types.ts` (imported, not
  redefined) and maps the Hermes tool `args` shape: `execute_code`/`terminal`/
  `bash`/`shell`/`run_command` → `shell{command}` (command pulled from
  `args.code`/`args.command`), read/write/edit file tools → `read`/`write`/`edit`,
  `search`/`grep`/`web_search` → `search`, `fetch`/`browser`/`open_url` → `fetch`;
  unknown tools → `undefined` (falls back to inputSummary, no regression).
  Wired at `sessions-sse.ts` `tool.started` (pass `{detail, status:'running'}`,
  which also fixes altitude — shell → `'action'` so consecutive `execute_code`
  collapse into a group like coding) and `tool.completed` (rebuilds the
  same-shape detail from started args + output/exitCode, stashed by `toolCallId`
  since the completion payload drops the original args). The entire downstream
  (recorder `capDetail` → cloud task-step-recorder → unified WS → agent-message
  decode → ActivityDetail rendering + `canExpand=detailHasBody`) already supported
  rich details — this is purely the missing producer half; no cloud/schema/render
  change. ⚠️ The Hermes gateway's `_tool_progress` callback frequently drops the
  real tool output (`sessions-sse.ts:375-401`); where output is absent,
  `detail.output`/`result` is left undefined (never a fake) — command + expand +
  exitCode-when-present still render. Real-output forwarding is a separate
  Hermes-gateway gap. 13 unit tests.

- **`cloud skill create` + `cloud role` commands** (Standardization SS-01/SS-02
  ingestion). New CLI verbs that push material-derived bundles into the live
  platform with the configured API key: `cloud skill create <bundleDir>
  [--install --agent <id>]` reads a SS-01 skill bundle (frontmatter + files),
  builds a server-matching merkle `contentManifest`, and `POST`s
  `/api/im/skills` (+ install). New `cloud role` group — `create <role.json>
  [--apply --agent <id> --workspace-id <id>]`, `apply <slug>`, `list`, `show` —
  ingests/applies SS-02 role templates (`/api/im/role-templates` + `/apply`).
  Backs the new `skill-builder` / `role-builder` built-in skills (each also ships
  a zero-dependency `scripts/ingest*.mjs` for SDK-only/CI environments). Note:
  community skill creates are slug-prefixed server-side (`name` →
  `community-<name>`); use the returned slug for install + role `requiredSkills`.
  Verified 8/8 against the local stack (skill create+install+GET, role
  create+apply+GET, profile roleTemplate projection).

- **Per-role Hermes-native skill scope** (release203/13 P1). Roles can now govern
  which of Hermes' ~90 bundled native skills an agent sees via `skills_list`, not
  just our injected built-ins. The hermes adapter reads `nativeSkillScope`
  (`{ mode: 'allow'|'deny', categories?, skills? }`) — projected from
  `IMRoleTemplate.nativeSkillScope` into `profile.config` (top-level, with a
  `roleTemplate` snapshot fallback; `resolveNativeSkillScope` mirrors
  `resolveMcpAllowlist`'s Priority-1/2). `deny` subtracts more on top of the
  global `HERMES_NATIVE_SKILL_DENYLIST` floor; `allow` keeps ONLY the listed
  categories/skills (net-body) — the bundled set (enumerated from the home-root
  `skills/` dir, cached by mtime) minus the allow-set. allow-mode fail-safes to
  the deny floor when the bundle can't be enumerated (fresh boot). Our injected
  skills are never disabled (enumeration reads the pure-bundle root, not
  `profileDir/skills/`). Verified: 9 unit tests + 11 e2e assertions on the real
  bundle.

### Changed

- **Daemon-side FORCE: all coding agents launch autonomous (no permission
  confirmation)** (release203). Coding agents run in agent-rt pods via the daemon
  and are ALWAYS non-interactive — a tool permission prompt can never be answered,
  so the provider blocked until the 300s watchdog (confirmed live: run f27vyi hung
  328s). The pod itself is the isolation boundary, so coding sessions now launch
  fully autonomous regardless of the stored profile config. Force-seam = the
  canonical `CodeAgentDriver` (`adapters/coding/shared/code-agent-driver.ts`):
  `withAutonomousLaunch(provider, config)` is applied on BOTH `createSession`
  (`buildSessionConfig`) and `resumeSession` (the resume overrides), so it covers
  EXISTING agents whose stored handle metadata carries a stale/absent `modeId`,
  not just new ones. Policy: keep an already-autonomous `modeId`, otherwise force
  the per-provider autonomous mode:
  - **claude-code** → `modeId: 'bypassPermissions'` (the claude-agent-sdk
    `permissionMode` equivalent of `--dangerously-skip-permissions`; the SDK skips
    `canUseTool` entirely in this mode).
  - **codex** → `modeId: 'full-access'` + `sandboxMode: 'danger-full-access'` +
    `approvalPolicy: 'never'` (≙ `--dangerously-bypass-approvals-and-sandbox`).
  - **opencode** → `modeId: 'build'` + `featureValues.auto_accept = true` (opencode
    has no CLI bypass flag — `auto_accept` drives its `tryAutoApproveToolPermission`
    path, auto-replying `"once"` to every tool permission request).

  CLI fallback adapters (registered as `claude-code-cli` / `codex-cli` D21
  fallbacks in `daemon/runner.ts`) also launch with the real bypass flags:
  `claude --dangerously-skip-permissions` (`adapters/coding/claude-code/index.ts`)
  and `codex … --dangerously-bypass-approvals-and-sandbox` (supersedes `--sandbox`,
  `adapters/coding/codex/index.ts` `buildCodexArgs`; the codex `resume` subcommand
  rejects sandbox/approval flags and inherits the persisted session's policy from
  turn-1, so no re-pass). Cloud `buildProfileConfig` is unchanged — this daemon
  force is defense-in-depth. New assertions:
  `test/code-agent-driver-autonomous.test.ts` (+ colocated driver test) and a
  codex CLI-args case in `test/codex-adapter-session-streaming.test.ts`.

- **Persistence agents (Hermes) launch autonomous too — no approval gating**
  (release203, "Hermes 也全自治"). The persistence analog of the coding-agent
  force above. The hermes gateway spawn (`adapters/persistence/hermes/index.ts`)
  now sets `HERMES_YOLO_MODE: 'true'` in the child env, disabling hermes' native
  dangerous-command approval gate. Rationale: the non-interactive agent-rt pod has
  no human at a prompt to answer an `approval.request`, and that event tears down
  our SSE stream rather than routing to an approval UI — so a flagged command
  would just block ~5min then fail. The pod IS the sandbox; hermes' hardline
  catastrophic patterns still block even with YOLO on (desired floor). Companion
  change in `daemon/dispatch.ts`: `DEFAULT_OPERATING_PRINCIPLES` no longer carries
  an approval-seeking line — `resolveOperatingPrinciples()` appends the policy line
  per `approvalPolicy`, and the `autonomous` branch injects zero approval-seeking
  text. Role-template refs (`templates/roles/ceo.json`, `skill-author.json`) set
  `approvalPolicy: 'autonomous'`, drop `human-approval` from required skills, and
  rewrote the `[Authority and approval]` clauses to autonomous + an
  anti-confabulation rule. NOTE: the 205 DB-seeded role templates are NOT migrated
  — existing agents keep their snapshot and pick up the fix on recreation (same
  model as the coding `modeId` fix).

### Added

- **Daemon follows the unified single-WS realtime** (release203/12 P3.1). New
  `WsRealtimeSubscriber` (`daemon/gateway/ws-realtime-subscriber.ts`) consumes the
  cloud's unified `WS /ws/realtime?token=&since=` (the SAME endpoint the browser
  uses) instead of the legacy `GET /api/im/sync/stream` SSE. It demuxes the
  `{ch:'sync',name:'sync',data}` frames, ignores the `ch:'tasks'` projection (the
  daemon only ever materialized the sync fan-out), and feeds the SAME
  `Materializer` (rm_* upsert + per-conversation watermark + local relay) as the
  SSE path. Cursor parity: it persists the per-user seq under the SAME
  `chats`/`__sse__` watermark, so a daemon upgrading SSE→WS resumes from exactly
  where it left off; `sync.backfill.truncated{newestSeq}` still jumps the cursor
  (no replay storm). The runner constructs the WS subscriber by DEFAULT;
  `PRISMER_UNIFIED_WS=0` opts back to `SseSubscriber` (per-deploy kill switch,
  mirrors the client flag). Removes the daemon's second long-lived SSE connection
  to cloud — one user = one realtime connection.

- **Canonical agent identity injection** (release203/11 §2, Slice A — fixes净身
  coding agents answering "who are you?" as generic Claude). `TaskDispatchRequestPayload`
  gains an additive `identityContext?: { identity, user, scope }` (composed
  CLOUD-side — only cloud has the names). `dispatch.ts` now: (a) substitutes a
  new `CODING_SOUL_DEFAULT` engineering persona into the SOUL/persona slot when a
  coding agent (`claude-code`/`codex`/`opencode`) has an empty `config.systemPrompt`,
  and (b) forwards `identityContext` on a SEPARATE `metadata.identityContext` key
  (NOT folded into `metadata.systemPrompt`) so hermes' `SOUL.md` stays persona-only
  per Hermes docs. The hermes adapter places identity/user/scope in its per-turn
  `instructions` slot; the code-agent driver + legacy claude-code CLI prepend them
  to `--system-prompt`. New exported helpers `isCodingAdapter` / `renderIdentityLines`
  / `CODING_SOUL_DEFAULT`. Purely additive — legacy dispatches with no
  `identityContext` are byte-identical on the wire.

- **Seed-on-dispatch for coding agents with no workdir** (release203/11 §2.4 —
  AGENTS-layer reliability fix). `seedDevPreset` previously only ran via
  `ensureWorkdir`, which is gated on a `payload.workdir` override; default
  RepoDirPicker coding agents carry no workdir, so their cwd never got
  `CLAUDE.md`/`AGENTS.md`. `dispatch.ts` now idempotently seeds the effective cwd
  (`profile.config.cwd`, `seedDevPreset(cwd, 'verified')` — append-only, never
  stomps user files, non-fatal) for any coding dispatch that didn't already
  materialize a workdir.

- **Dev preset bundle seeding** (release203/09 §7.5). New `src/daemon/seed-dev-preset.ts` `seedDevPreset(cwd, action)` seeds coding workdirs on `ensureWorkdir` (init → full: `scope ∈ {common,coding}` skills into `.claude/skills/` + AGENTS.md/CLAUDE.md managed block + `docs/agents/`; cloned/verified → append-only managed block, skills only if `.claude/skills` absent; reused → no-op). Gated by `PRISMER_SEED_DEV_PRESET` (default ON); non-fatal + idempotent (managed markers, skip-existing skill dirs).

- **Category-aware built-in skill filtering** (release203/09 §7.6.3). New runtime
  SSOT `src/adapters/agent-category.ts` (`ADAPTER_CATEGORY` / `categoryForAdapter`
  / `skillScopeMatchesCategory`) mirrors the cloud-side adapter→category map.
  `SKILL.md` frontmatter `scope: common|persistence|coding` is now parsed into
  `LoadedSkill.scope` (defaults to `common`), and `FileSystemSkillLoader.loadForDispatch(profile)`
  filters to `scope ∈ {common, <adapter category>}`; unknown adapter or no profile
  loads everything (default-safe — an unrecognized scope never drops a skill). The
  hermes/openclaw persistence loaders now thread `profile` through instead of
  ignoring it.

- **`agent.workdir.materialize` control frame** (release203/09 §7.3 — on-demand
  persistent workdir provisioning for the Pro coding-agent picker). The daemon
  answers a new reverse-channel RPC (`{ workspaceId, projectId?, source:
  'clone'|'init'|'container-pick', sourceRef?, name?, cwd?, _rpcId }`): it
  resolves the per-project `repos/` base (`resolveProjectReposDir`), jails the
  target cwd inside `workspaces/<wid>`, then reuses `ensureWorkdir` to git-clone
  / git-init / verify a container-picked path, and echoes `agent.workdir.reply`
  `{ _rpcId, ok, data:{ cwd, action: 'cloned'|'init'|'reused'|'verified' } |
  error:{ code: 'path_escape'|'materialize_failed'|'bad_request' } }`. clone/init
  require a single-segment `name` (`/`, `\`, `..`, empty → `bad_request`);
  container-pick verifies the supplied absolute `cwd` against the jail
  (`path_escape` on escape). The pure resolve+jail decision is extracted as
  `resolveWorkdirCwd` for unit testing (mirrors `fs-list.ts`).

- **`agent.fs.list` control frame + per-project `repos/` standard directory**
  (release203/09 — container directory picker for Pro coding-agent creation).
  New `resolveProjectReposDir(paths, workspaceId, projectId)`
  (`workspaces/<wid>/projects/<pid|_unscoped>/repos/`); the dispatcher now does a
  non-fatal `mkdir -p` of it alongside the session `artifacts/`/`scratch/` so a
  coding agent's default `cwd` always exists. The daemon answers a new
  `agent.fs.list` reverse-channel RPC (`{ workspaceId, projectId?, subpath?,
  _rpcId }`) by `readdir`-ing that `repos/` scope — jailed inside
  `workspaces/<wid>` (escape → `path_escape`), flagging each dir's `.git` as
  `isRepo`, dirs-first/alphabetical sort — and echoes `agent.fs.reply`
  `{ _rpcId, ok, data:{ absPath, parentRel, entries } | error:{ code } }`. A
  not-yet-created `repos/` returns `ok` with empty `entries` (never an error).

- **`cloud okr pack` subgroup** (release203 Task 2 — R4 Scenario Packs). Global,
  data-driven OKR templates resolved by `domain` KEY (no runtime branch).
  `okr pack list` (GET `/api/im/okr/packs`), `okr pack get <domain>` (GET
  `/api/im/okr/packs/:domain`), and `okr pack adopt <domain> <archetypeId>
  --workspace <id>` (POST `…/archetypes/:archetypeId/adopt`) which seeds a draft
  Objective + its KRs and stamps a commit-time pack snapshot
  (`metadataJson.scenarioPack {domain,version,archetypeId}`). The `software` pack
  is deliverable; `sales`/`marketing` are DATA-ONLY spec (`deliverable:false`) and
  adopting one returns `PACK_NOT_DELIVERABLE` (422). Dev KRs declare an internal
  source: task/acceptance-backed KRs emit today; latency/CI/defect/DORA KRs
  declare a `metricBinding` but `backedNow:false` → recompute returns null
  (—/pending, no fabricated numbers). approvalPolicy / resourcePolicy /
  proactivityTriggers / compensation are FROZEN and absent.

- **`cloud okr` command + `okr` built-in skill** (release203 Task 3 — OKR control
  loop). The canonical "agent drafts an OKR charter" path: from a human's plain-
  language goal an agent drafts ONE Objective + 2-5 Key Results, links existing
  tasks to the KR they serve, and routes the COMMIT to a human sponsor. Subcommands
  (all over the committed `/api/im/okr/*` + `/api/im/insights/okr` endpoints):
  `okr objective create|list|get|commit|close`, `okr kr add|recompute`,
  `okr link <objectiveId> <keyResultId> <taskId>`, `okr insights --workspace`.
  `kr add` assembles a `metricBinding` from `--metric-namespace/--metric-name/
  --metric-agg` and defaults `--source` to `agent-proposed`. Hard rules (enforced
  server-side, mirrored in the skill): an agent may PROPOSE but never COMMIT
  (`commit` → `AGENT_CANNOT_COMMIT` 403); a committed-type objective REQUIRES a
  human/admin sponsor (`SPONSOR_MUST_BE_HUMAN`); a qualitative KR may only be
  scored with a human-confirmed `--value` + `--evidence`. Guardrails / resource
  allocation / scenario packs / check-ins / evaluations / compensation are FROZEN
  and absent from both the CLI and the skill.

- **`cloud okr objective checkin|grade|archive`** (release203 Task 1 — OKR
  lifecycle back-half, `committed → graded → archived`). `checkin <id>
  [--note] [--confidence] [--decision continue|rescope|add-resource|pause|cancel]`
  records a check-in (snapshots the objective score + each KR's current/status);
  an AGENT may draft check-ins. `grade <id> [--score] [--narrative]` runs the
  formal evaluation (committed|at_risk|paused → graded) and `archive <id>`
  (graded|closed → archived, read-only) are **HUMAN decisions** — an agent caller
  gets `AGENT_CANNOT_GRADE` (403). Grade freezes the objective score. Reward /
  resource fields carry no token/credit meaning (compensation stays FROZEN).

- **Vision-gated image context for non-vision recipients** (release202/17). The
  daemon now consumes the envelope's new `assets.imageReferences` bucket and
  renders each as a one-line `[image: <filename> · asset <assetId> · <w>×<h>]`
  text token instead of vision pixels. A DEFENSIVE double-gate
  (`gateImageRefsByVision`, `adapters/shared/image-reference.ts`) re-checks the
  resolved model in the Hermes sessions-dispatcher, runs-dispatcher, and the
  envelope renderer (`hermes/context-render.ts`): when the model is NOT
  vision-capable, image inputs are degraded to the same reference lines and are
  never lifted into `image_url` — protecting against a cloud-side gating miss.
  Vision-capable / unknown models keep the current `image_url` behavior.

### Changed

- **zod 3 → 4.** `@anthropic-ai/claude-agent-sdk@^0.2.141` (newly added with the
  code-agent engine port) peer-requires `zod@^4.0.0` across its entire 0.2.x line,
  which conflicted with the previous `zod@^3.23.8` pin and broke `npm install`.
  Bumped to `zod@^4.0.0` and migrated the runtime's zod usage to the v4 API:
  `z.record(v)` → `z.record(z.string(), v)` (key type now mandatory),
  `ZodError.errors` → `.issues`, `z.ZodType<O, ZodTypeDef, I>` → `z.ZodType<O, I>`
  (`ZodTypeDef` removed in v4), and explicit transform-value typing where v4's
  stricter inference over generic `z.ZodTypeAny` schema params collapsed. No
  runtime behavior change. `zod-to-json-schema@^3.25.2` already supports zod 4.

### Removed

- **OpenClaw adapter retired** (release203/11 §2.5, Slice B). OpenClaw was a
  decay/version-rotting candidate and its identity model was already absorbed into
  the canonical four-piece model (§2.1). Deleted the whole
  `src/adapters/persistence/openclaw/` adapter (index / context-render /
  skill-loader / memory-tools), its registration in `daemon/runner.ts`, its
  `openclawAdapter` / `OpenClawProfileConfig` exports from `src/index.ts`, the
  `openclaw` pin in `known-versions.ts`, the openclaw branch in `agent-category.ts`
  `ADAPTER_CATEGORY`, the `FallbackAdapter` openclaw member, the openclaw
  `INSTALL_SPECS` / `BUILTIN_ADAPTERS` / auth + hook branches in the
  `prismer adapter` CLI, the openclaw `ADAPTER_BINARY` entry in the `prismer agent`
  CLI, and the openclaw branches in `dispatch.ts` (skill-dir gate),
  `skill-sync.ts` (skill-root resolution), and `local-server.ts` (state-root
  snapshot). Removed `openclawConfig` keys + `"openclaw"` from `applicableAdapters`
  in the role-template JSONs. Persistence is now hermes-only. Existing openclaw
  profile/agent rows are left untouched in the DB (they simply no longer dispatch —
  adapter gone); the `IMRoleTemplate.openclawConfig` column is kept as a dead column
  (no migration). Deleted the openclaw-specific tests
  (`openclaw-adapter-*`, `openclaw-skill-loader`, `context-render-openclaw`) and the
  `sa7-openclaw-gateway-verify` cookbook; trimmed the openclaw rows from the
  cross-adapter tests (multimodal / memory-tools / version-check / templates /
  skill-sync / workdir-materialize). Also dropped the `@prismer/openclaw-channel`
  plugin package and its references in the SDK build scripts.

### Fixed

- **Transient dispatch-precondition failures no longer hard-fail the run**
  (release202, HTTP 404 postmortem). A freshly-(re)connected daemon's FIRST
  cloud precondition fetch (`resolveProfile` → `GET /api/im/agent_profiles/:id`)
  can 404 during the warm-up window before its api-key-proxy identity is hot —
  the cloud stamps a valid `profileId`, but the owner-scoped lookup transiently
  misses. Previously that 404 was thrown straight past the 3× adapter-retry loop
  (which only wraps `adapter.dispatch()`, *after* `resolveProfile`) into the
  top-level catch, replying `{code:'adapter_dispatch_failed', message:'HTTP 404'}`
  → terminal "Agent 失败 … HTTP 404" pill, recoverable only by the user
  resending. Now: (1) `resolveProfileResilient` retries TRANSIENT cloud failures
  (404 / 408 / 429 / 5xx / network) with backoff (~5s) before giving up;
  (2) the top-level catch classifies the final error via
  `isTransientPreconditionError` and replies with a distinct retryable code
  `dispatch_precondition_unavailable` (vs `adapter_dispatch_failed`) so the
  cloud re-queues instead of terminal-failing. 400/401/403 stay PERMANENT.

- **Upstream LLM failures no longer surface as fake-successful tasks**
  (release202/12, D1+D2). Hermes serializes an exhausted LLM call
  (`API call failed after N retries: …`) into `assistant.completed` content;
  the sessions SSE consumer now detects that signature (anchored, requires zero
  streamed deltas to avoid false-positives) and sets `SessionsSseResult.upstreamError`.
  `sessions-dispatcher` turns it into a FAILED `AdapterResult`
  (`code:'upstream_llm_error'`, carrying the HTTP status) instead of `ok:true`
  with the error string as output. The daemon retry loop (`dispatch.ts`) adds
  `isPermanentUpstreamError` so permanent causes skip the 3× retry and surface
  the real reason instead of `daemon_local_retry_exhausted`. Detection +
  classification key on the hermes message WORDING — `has no usable upstream
  source` (provider chain unconfigured), `Billing or credits exhausted:` (HTTP
  402 from the cloud balance gate), `HTTP <4xx>` — because hermes'
  `_summarize_provider_error` DROPS the JSON `error.type`, so a machine token
  can't be matched. Mirrored to the `/v1/runs` dispatcher so the flag-gated path
  can't reintroduce the bug. Pairs with the cloud-side
  `503 provider_chain_unconfigured` (release202/07 §5b) so a provider-chain
  misconfig reads as a clear failed task end-to-end.

### Added

- **`mode:'message-attach'` for `POST /local/deliver`** (release202/09 P5#3, 动作
  A2). Appends a freshly-uploaded asset to an ALREADY-SENT message. Body adds
  `messageId` (and requires `conversationId`); the daemon uploads with its own
  credential (same `deliverFile` upload path + agent-output-policy +
  magic-bytes as the other modes) then POSTs the resulting `assetId` to the
  cloud conversation-scoped attach route
  `POST /api/im/messages/:conversationId/:messageId/attach` (X-IM-Agent stamped
  so the cloud sender-check resolves the same agent that authored the message).
  Unlike `mode:'send'` it does not start a new message; unlike `mode:'attach'`
  it does not ride the reply. Wired from the in-container `cloud attach` SDK
  command. Complements `mode:'attach'` (reply does not exist yet) — A2 is for a
  reply that already exists.
- **`mode:'task-attach'` for `POST /local/deliver`** (release202/09 P5#2, 动作
  ③). The daemon uploads the file as a **task-bound** asset (`deliverFile`
  already stamps `sourceTaskId = taskId`), which the cloud `POST /assets`
  handler auto-rolls onto the kanban task card
  (`appendOutputAssetIdToTask` + `reemitTerminalDigestForAssetArrival`) plus the
  asset library. Unlike `mode:'attach'` it does **not** call
  `recordDeliveredAsset` (a kanban task may run without a chat reply — its
  products belong on the card, not a turn reply) and unlike `mode:'send'` it
  posts no message. No new cloud HTTP call is needed: the existing
  `sourceTaskId`-driven rollup is the kanban + library landing. Wired from the
  in-container `cloud task attach` SDK command.
- **Explicit agent-driven file delivery** (release202/09 P2). New daemon
  local-server route `POST /local/deliver` (`local-server.ts` `onDeliver` +
  `daemon/asset/deliver.ts` `attachDeliver`): the in-container agent's
  `cloud deliver` / `cloud file send` proxy here so the daemon (which holds a
  usable IM credential the agent lacks) performs the upload + delivery. Body
  `{ taskId, path, mode:'attach'|'send', conversationId?, agentUsername? }`.
  `mode:'attach'` (动作 A) records the assetId onto `ArtifactsWatcher`'s
  existing `pendingByTask` so dispatch-end `flushPending` rides it on
  `reply.assetIds`; `mode:'send'` (动作 B) posts a standalone message with the
  asset attachment, stamped as the agent (`X-IM-Agent`). New public
  `ArtifactsWatcher.recordDeliveredAsset(taskId, assetId)` +
  `ArtifactsWatcher.deliverFile(...)`. `PRISMER_CONVERSATION_ID` is now
  injected into the agent env for 动作 B targeting.

### Changed

- **ArtifactsWatcher directory auto-scan is now flag-gated OFF by default**
  (release202/09 P2). New `ArtifactsWatcherOptions.autoScan` (default
  **false**): when off, the polling scan / `scanNow()` are no-ops (no implicit
  directory-magic), but `pendingByTask` / `flushPending` /
  `recordDeliveredAsset` / `upload` all still work. The legacy scan code is
  retained behind the flag and re-enablable via `PRISMER_ARTIFACTS_AUTOSCAN=1`.
  File delivery is now EXPLICIT (`cloud deliver` / `cloud file send`).

- **Hermes one-shot task-run dispatch via `/v1/runs`** (release202/08 Phase 1,
  flag-gated **default OFF**). New `HERMES_TASK_RUNS_DISPATCH` env flag. When ON
  and a dispatch is classified as a one-shot **run** (execution context
  `task-run` AND no triggering chat sender — pure kanban / scheduled fire /
  programmatic orchestration), the hermes adapter routes through the new
  `runs-dispatcher.ts` (`POST /v1/runs` → 202 + run_id, then `GET
  /v1/runs/{id}/events` SSE) instead of the stateful Sessions API. The run is
  **stateless** — no hermes session, no `local_run_sessions` mapping; its input
  is the bare task prompt (+ inline asset blocks) and `system_prompt` embeds a
  standalone `<execution_context type="task-run">` block (no SEED/THIN
  envelope, no participants/current_turn_sender). Multimodal image_url parts and
  the `/events` SSE parser (`consumeSessionsSse`) are reused verbatim. Chat
  turns (group/dm with a triggering sender) keep going through
  `dispatchViaSessions` unchanged. With the flag OFF the router is inert —
  `deriveDispatchKind` returns `'turn'` unconditionally, so 100% of traffic
  stays on Sessions (release201/25 §16.4 A3 behaviour, byte-for-byte).
  `adapters/hermes/{flag.ts,runs-dispatcher.ts,index.ts}`,
  `daemon/conversation-context.ts` (`renderExecutionContextXml`).

- **Role templates declare `taskDispatchScope`** (release202/08 §3.2 P3 —
  config-driven, role-agnostic task-dispatch permission). A role's template /
  agent-profile `config.taskDispatchScope` (`'any' | 'agents' | 'self' |
  'none'`) is the middle layer of cloud's three-layer dispatch resolver
  (`workspace.metadata.dispatchPolicy` > role/profile config >
  `DEFAULT_DISPATCH_POLICY`), so a NEW role gets its dispatch capability by
  declaring this field — the cloud resolver needs zero code changes. Declared:
  `ceo` → `any` (orchestrator, sibling of `taskAuthority`), `product-manager`
  → `agents` (delegates to engineer/verifier, never a human peer), `engineer`
  / `researcher` / `verifier` → `none` (executors, no peer delegation).
  `templates/roles/*.json`.

### Fixed

- **Model reasoning trace restored in agent messages on the hermes sessions
  stream** (regression from `2cdd2cad`, 2026-05-29). When dispatch migrated from
  `/v1/runs` (legacy `consumeSse`) to the sessions stream (`consumeSessionsSse`),
  the deleted `reasoning.available` handler was the only path feeding the model's
  thinking trace into `recorder.recordReasoningChunk(...)`, so reasoning stopped
  becoming `reasoning_chunk` steps and the expandable reasoning block vanished
  (tool-call steps still showed — separate handlers). Root cause of the shape
  mismatch: the sessions endpoint (`api_server.py:1585-1590 _tool_progress`)
  does **not** emit `reasoning.available`; it **remaps** reasoning into a
  `tool.progress` event with `tool_name: '_thinking'` and the text in `delta`
  (not `preview`), which the old `tool.progress` handler — reading only
  `preview` — silently dropped. Fix: `tool.progress` now reads `delta` first and
  routes reasoning through `recordReasoningChunk` + a `kind:'reasoning'`
  onProgress hint (no `lastProgress` bump — reasoning is not a progress unit for
  the reaper, mirroring the deleted handler). Also added a defensive top-level
  `reasoning.available` case (accepts `text`/`reasoning_content`/`delta`/
  `content`) for the `/v1/runs`-style direct event in case a hermes build
  surfaces it on the sessions stream. Guarded against empty strings. Covered by
  `test/reasoning-sse.test.ts`.
- **Hermes adapter no longer reuses a stale/foreign gateway squatting on the
  port** (release202/07 robustness). `ensureService` decided reuse-vs-respawn
  with the UNAUTHENTICATED `/health` check, which an old-version (pre-sessions,
  404 on `/v1/capabilities`) or wrong-`API_SERVER_KEY` (401) gateway — e.g. an
  orphan we spawned in a PRIOR daemon session — answers `200` to. Reusing such a
  squatter made the capability gate later trip with the misleading "Hermes does
  not advertise session_chat_streaming", failing every dispatch after a daemon
  restart until the orphans were manually `pkill`ed. Now the reuse decision is
  AUTHENTICATED: a hermes counts as reusable only if it answers
  `GET /v1/capabilities` as ours; otherwise the adapter frees the port
  (`stopStaleHermesGateways`, matches `-p <profile>` / `API_SERVER_PORT`) and
  spawns a fresh gateway with our key — self-healing on restart. The capability
  probe result is reused as the pinned `HermesService.capabilities` (no extra
  fetch on the happy path). `adapters/hermes/index.ts` `ensureService`.

### Changed

- **Provider chain routing — `proxyProvider` widened from `'newapi'|'deepseek'`
  enum to any chain id** (release202/07). The codex adapter previously hardcoded
  the gateway base_url to `<PRISMER_BASE_URL>/api/v1` "regardless of
  proxyProvider" — silently dropping a `deepseek` selection so every Codex
  request landed on newapi (and 500'd for deepseek-only models). Now both the
  codex and hermes adapters resolve `base_url` by the configured chain:
  `newapi`/`default` → `/api/v1`; any other chain → `/api/v1/proxy/<chain>`
  (codex appends `/responses`, hermes `/chat/completions`). The cloud walks the
  chain (source1 → source2 → …) with per-source fallback.
  - `adapters/codex/index.ts` — `proxyProvider` schema `z.enum` → `z.string`;
    `resolveCodexPrismerProvider` honors the chain in base_url.
  - `adapters/hermes/index.ts` — same schema widening; `resolvePrismerProviderBaseUrl`
    generalized from the `deepseek`-only branch to any chain id.

- **Document-deliverable SOP — markdown files, not chat prose** (B-line,
  release201/3x). Codified the rule that document-type deliverables
  (research memos, PRDs, reports, reviews, summaries) MUST be written as
  markdown files into `${PRISMER_OUTBOX_DIR}/` (physically
  `${TASK_WORKDIR}/result/`) so the daemon outbox-watcher auto-registers
  them as task-bound IMAssets; the chat reply is a summary/teaser, not the
  deliverable itself.
  - `built-in-skills/tasks/SKILL.md` §产物输出 — added §文档型交付物 (= markdown
    文件) sub-section referencing the real `${PRISMER_OUTBOX_DIR}` /
    `result/` auto-archival wiring (`dispatch.ts` `appendArtifactsInstruction`,
    `PRISMER_ARTIFACTS_DIR` env). Filenames/structure are skill-defined
    (no hardcoded schema).
  - `templates/roles/{researcher,product-manager,engineer}.json`
    `systemPrompt` — replaced the old "upload as workspace file +
    prismer://file URI" convention with the markdown-to-`result/` SOP and a
    summary-vs-deliverable distinction; each points at the tasks skill SOP.
  - `templates/roles/verifier.json` `systemPrompt` + `operatingPrinciples` —
    extended the same SOP to the verifier: the full acceptance record
    (per-criterion method / params / observed result / repro steps) is now a
    markdown file in `${PRISMER_OUTBOX_DIR}/` (e.g. `verification-report.md`),
    auto-archived as a task-bound IMAsset. Binary evidence (screenshots /
    benchmark output / logs) still goes via `cloud task attach` +
    `evidenceRefs`; the `verify-criterion --note` stays a summary. The two
    paths are complementary.
  - Audit (cross-referenced docs): `templates/roles/ceo.json` left unchanged —
    it already routes all file deliverables through `office-artifacts` /
    `image-generate` / `canvas-design` / `web-artifacts-builder` skills (no
    legacy "upload as workspace file" anti-pattern), so it needs no SOP
    backfill. `templates/roles/skill-author.json` left unchanged — its
    deliverable is a structured `status=draft` IMSkill submitted via
    `cloud skill draft create`, not a chat-bound markdown document, so the
    `result/` SOP does not apply.

### Added

- **Adapter version probe with KNOWN_GOOD pinning** (Release 201 v2.0.7
  post-release P1). All four adapters (hermes / codex / claude-code /
  openclaw) now run `<binary> --version` on startup, parse the result,
  warn when the detected version drifts below the per-adapter
  `MIN_VERSION`, and warn when it diverges from `KNOWN_GOOD`. Pins are
  declared in the new `sdk/prismer-cloud/runtime/src/adapters/known-versions.ts`
  manifest:

  - hermes: MIN=`0.0.0` (soft-pass), KNOWN_GOOD=`unknown` — TODO(v2.0.8):
    pin after cookbook run exercises a real hermes binary
  - codex: MIN=`0.0.0` (soft-pass), KNOWN_GOOD=`unknown` — TODO(v2.0.8):
    pin after cookbook run against `@openai/codex`
  - claude-code: MIN=`2.0.0` (Wave-4 flag set requires 2.x), KNOWN_GOOD=
    `unknown` — TODO(v2.0.8): pin knownGood after cookbook run
  - openclaw: MIN=`2026.4.0`, KNOWN_GOOD=`2026.4.0` — wrapper carries a
    2026.4.x stderr-bleed workaround, revisit once upstream fixes

  Honesty note: three of the four pins are intentionally unpinned at
  the floor — this is the governance scaffold, not a claim that we've
  validated specific upstream revs. Bumping the pins is a v2.0.8 task
  blocked on real cookbook runs.

- New `sdk/prismer-cloud/runtime/src/adapters/version-check.ts` —
  `compareSemver`, `isVersionInRange`, `parseVersionFromStdout` shared
  helpers so the four adapters do not redefine their own semver math.

- `/healthz` `adapters[]` entries now carry `minVersion` + `knownGood`
  alongside the existing `name` / `ready` / `version` fields so cloud
  debug-pipeline can flag drift between detected and tested versions.

- `test/adapters-version-check.test.ts` — vitest regression covering
  compareSemver, range checks, pre-release stripping, parseVersionFromStdout,
  and the `ADAPTER_KNOWN_VERSIONS` manifest shape.

## v2.0.1 — 2026-05-21 — Skill multi-file manifest protocol (§A.7 Phase 1) + URL asset fetch

Coordinated v2.0.1 patch release. `/VERSION` → 2.0.1. Internal preview only;
open-source npm publish deferred.

### Added — Multi-file Skill Manifest protocol (agentskills.io 合规)

`src/daemon/skill-sync.ts` extended for the §A.7 multi-file manifest
protocol. Existing single-file callers stay functional via dual-write on
cloud side.

- **New wire shape**: cloud `/api/im/skills/installed` now returns
  `skill.contentManifest` (JSON `files[]`) + `skill.contentManifestRevision`
  (merkle). Daemon parses files[], per-file writes to
  `<skillsRoot>/<slug>/<path>`, per-file sha256 verifies, computes merkle,
  acks back to cloud.
- **`computeMerkle(files)`** export — sha256 of sorted `"path:sha256\n"`
  lines. Same formula the cloud uses, so
  `IMAgentSkill.installedRevision == manifestRevision` after ack.
- **Hybrid inline/url storage** — files ≤ 100 KB inline as base64;
  > threshold goes to S3 presigned URL (env-overridable via
  `PRISMER_SKILL_INLINE_THRESHOLD_BYTES`).
- **Path traversal guard** — `isSafeRelativePath` rejects `..`, absolute
  paths, symlink-escaping joins. Double-checked at the writeFile call site.
- **Legacy single-file fallback** — when cloud row has `contentManifest=null`
  (pre-migration 400), daemon synthesises a single-file manifest
  `[{path:"SKILL.md", sha256: sha256(content)}]` and acks the same merkle
  the cloud computes (cloud side aligned in this release too).

### Added — `AssetCache.getOrFetchUrl()` — public URL fetch with SSRF + size + redirect guards

`src/asset-cache.ts` new helper mirrors `getOrFetch` shape but takes a URL.
Hash computed after download; cache-key = sha256 of body bytes.

- **SSRF guard**: DNS-resolves host before each hop, rejects loopback /
  RFC1918 / link-local / cloud-metadata IPv4 + IPv6 ULA/link-local.
  Cross-host redirects re-validate before following.
- **Manual redirect chain** — max 3 hops; refuses loops.
- **Hard timeout** — default 15 s, override via env
  `PRISMER_URL_FETCH_TIMEOUT_MS`.
- **Streaming read with abort-at-limit** — default 5 MiB, override via env
  `PRISMER_URL_FETCH_MAX_BYTES`. Truncated bodies are NOT cached.
- Non-2xx throws; caller surfaces an `error` observation.

### Tests

- 11 new `test/skill-sync-multifile.test.ts` (mocked cloud, real file
  writes to tmpdir, sha256 + merkle verification).
- Runtime vitest 362/362 PASS.

## v2.0.0 — 2026-05-19 — `prismer` daemon bin retained + Skill Gate GA

Coordinated v2.0.0 GA. `/VERSION` (single source of truth) → 2.0.0 via
`sdk/build/version.sh`. The headline bin-split was resolved by keeping
`@prismer/runtime` on `bin: { prismer }` (daemon priority is higher than
SDK, so the daemon claims the canonical name) and renaming `@prismer/sdk`
to `bin: { cloud }` instead.

### Changed — **Binary retained: `bin: prismer`** (daemon priority decision, 2026-05-19)

- `package.json` `bin` keeps mapping `prismer` → `./dist/cli.js`. `@prismer/sdk`
  renamed its binary to `cloud` (see `@prismer/sdk` CHANGELOG). The two bins
  now coexist — sandbox image install order no longer creates conflicts.
- Executable shim at `src/bin/prismer.ts`. Tsup emits to `dist/cli.js`;
  package.json bin maps it to `prismer`.
- `cli/index.ts`: `new Command('prismer')` (unchanged from v1.x); `--help`
  and parse errors report `Usage: prismer [options]`.
- Help text + error prefixes + cookbook references stay on `prismer` across
  `src/cli/*`, `src/cli/commands/*`, `src/config.ts`, `src/daemon-id.ts`,
  `src/pair.ts`, `src/index.ts`. (An intermediate Session-3 commit had
  temporarily renamed these to a daemon-suffixed form; reverted before GA
  per user direction.)
- See `docs/release200/02-v20-daemon-runtime-plan.md` §CLI 边界更新 for the
  rationale (fixes v1.x sandbox-image bin clobber bug that caused the v2.0
  Built-in skill Kanban scheduling regression).

### Changed — **VERSION sync**

- `cli/index.ts` `VERSION` literal synced from 1.9.7 → 2.0.0. Now sourced
  from `/VERSION` via `sdk/build/version.sh`.

### Added — **Skill Gate foundation (v2.0 GA gate)**

The Skill Gate (cloud `/skills/ack` round-trip + dispatch-time skill sync
+ `SkillLoader` per-adapter) was incrementally landed across 1.9.x cuts.
v2.0 promotes it to GA. Recap of the components carried by this release:

- **SkillSyncManager** (`daemon/skill-sync.ts`): reconciles
  `agent.skills.list` ↔ local `~/.prismer/agents/<id>/skills/`,
  writes `SKILL.md` to disk, replies `skills.ack` once content is durable.
- **SkillLoader SPI**: adapters can opt into per-dispatch skill payload
  composition. Hermes + OpenClaw implement; Codex + claude-code are no-ops
  in 2.0 (skill sync still writes files to disk for those, but the
  dispatch-time injection is gated by adapter capability).
- **v2.0 Skill Gate scope**: dispatch-time skill payload coverage validated
  for `hermes` + `openclaw` only. `codex` + `claude-code` skill sync remains
  a file-write no-op pending adapter framework support (tracked v2.1+).
- Live-gate evidence: `dev-loop.sh skill-live-gate` /
  `scripts/sandbox/e2e/skill-agent-dispatch-live.ts` capture 21 Built-in +
  1 magic-marker skill in `POST /v1/runs.instructions` (~31 KB payload).
  See `docs/release200/evidence/05-live-dispatch-gate-2026-05-19.md`.

### Added — **Origin Adapter framework** (promoted from "Unreleased")

`daemon/asset/origin/` — daemon-side asset producers behind a uniform
OriginAdapter SPI (doc 26 §4 Phase 2). Foundation for the v2.0 `assets` +
`ingest` Built-in skills.

- **SPI** (`spi.ts`): `OriginAdapter` interface with
  `kind: 'upload' | 'drop-folder' | 'agent-gen'`,
  `observe / identifySource / fetch` decomposition. Identification stays
  separate from byte fetch so the outbox can dedupe before paying read cost.
- **Outbox** (`outbox.ts`): SQLite-backed pending-upload queue mirroring
  `daemon/memory/outbox.ts` shape — Zod validation → dead-letter,
  `idempotencyKey = sha256(originKind|wid|sourceRef|observedAt)` UNIQUE,
  `claimNext()` transactional, `recordFailure(maxAttempts)` auto-spills to
  dead-letter. Restart-resume-friendly.
- **Drop-folder adapter** (`drop-folder.ts`): polls
  `~/.prismer/workspaces/<wid>/drop/` (1 s tick, recursive), enqueues
  observations, moves files to `uploaded/` on success and `upload-failed/`
  on persistent failure.
- **Agent-gen adapter** (`agent-gen.ts`): synchronous
  `handleAssetWrite(body, { cloud })` for the `POST /local/asset/write` RPC.
- **Web-upload adapter** (`web-upload.ts`): cloud-side marker class for SPI
  symmetry.
- **Upload runner** (`upload-runner.ts`): generic worker draining the
  outbox; `onUploadSuccess` / `onUploadFailure` hooks per adapter.
- **`POST /local/asset/write` route** (`local-server.ts`): wires
  `onAssetWrite` sink alongside `onDispatch` / `attachMemory`. Returns
  `{ assetId, contentHash, prismerUri }`. 400 / 502 / 501 error contract.

### Added — **memory-curation skill** (promoted from "Unreleased")

- **Codex adapter** (`adapters/codex/index.ts`): `buildCodexPrompt()`
  extracted as pure function; injects `MEMORY_CURATION_SKILL_TEXT` as
  system-prompt preamble (Codex has no native skill framework).
- **Embedded skill module** (`src/skills/memory-curation.ts`): regenerated
  from canonical `sdk/prismer-cloud/skill/memory-curation.md` via
  `scripts/regenerate-memory-curation-skill.cjs`.

### Added — **CLI hardening pass** (promoted from "Unreleased")

Audit of the 16-verb CLI surface. No new daemon behavior; existing commands
now fail closed and emit consistent JSON.

- **`prismer config (path|show|set)`** — inspect or edit `~/.prismer/config.toml`.
  `show` redacts the api_key by default; `--reveal` prints clear text.
  `set cloud_api_base <url>` runs through `normalizeCloudUrl`,
  `set api_key sk-…` validates the key format.
- **`prismer setup --check`** — dry-run mode. Validates `--cloud`, prints
  the would-be config target and api-key source, returns without touching
  disk. JSON: `{ok:true, check:true, mode, cloud, …}`.
- **Default `--cloud` URL is `https://prismer.cloud`** (was
  `https://cloud.prismer.dev`). Visible in `setup --help` / `pair --help`.
- **Stable error codes** on every CLI exit path so JSON consumers can
  branch on `error.code` (e.g. `invalid_cloud_url`, `config_missing`,
  `task_create_failed`).

### Fixed — **CLI hardening pass** (promoted from "Unreleased")

- **`--json` was dead code on every subcommand.** `applyCommonFlags`
  stripped `--json` from argv before commander parsed per-command options,
  so JSON branches silently no-op'd (e.g. `prismer status --json` exit 0
  with no body). Now `--json` is kept in argv and declared on every
  printing subcommand.
- **`prismer setup --cloud 0.0.0.0:3000` accepted bare host:port and
  exploded with raw Zod JSON.** `normalizeCloudUrl()` now auto-prefixes
  `http://` for bare host shapes and rejects everything else with a
  single-line error.
- **`exitWithError` is JSON-aware.** Emits
  `{ok:false, error:{code, message}}` to stdout when UI is in JSON mode.
  Every action handler goes through a `runAction(fn, { code })` wrapper.
- **Daemon ignored application-level `AUTH_FAILED`.** The runner now
  detects `AUTH_FAILED` / `AUTH_REQUIRED` / `auth_invalid` payload codes,
  emits `auth-failed`, and `daemon run` clears the pid file + exits 2.
- **`memory stats` returned exit 0 when the gateway was unavailable** even
  though `delete` and `sync` exited 1 in the same condition. Now consistent.
- **`task create` printed `(0): fetch failed`.** Network errors now render
  as `(network error): …` so the `0` HTTP status doesn't leak.
- **`daemon restart` dropped `--port` / `--foreground` / `--no-local-server`
  on the floor.** Restart now forwards the flags through to `start`.
- **`daemon logs --tail` read the entire log file into memory.** Now seeks
  from the end in 64 KiB chunks.

### Tests

- Origin Adapter framework: 44 new vitest assertions across 8 new test files
  (`origin-spi`, `origin-outbox`, `origin-drop-folder`, `origin-agent-gen`,
  `local-server-asset-write`, `origin-web-upload`,
  `skill-memory-curation-sync`, `codex-adapter-skill-injection`).
- Acceptance criteria covered: doc 26 §5 L2-T1 (100-burst, dead-letter=0),
  L2-T2 (restart resume), L2-T3 (RPC sync return).
- Total runtime suite: 192 → 234 passing, 0 failures.

### Cookbook

- `docs/cookbook/m-asset-origin-drop-folder.md`
- `docs/cookbook/m-asset-origin-agent-gen.md`

---

## v1.9.7 — 2026-05-12 — Device capacity fix + setup daemon auto-start

### Fixed

- **`host.declare` now upserts `im_containers` row** so agent.register's
  `assertDeviceCapacityAvailable` can find the daemon device. Previously only
  Redis presence was written; the MySQL `im_containers` table was empty for
  local daemons, causing `UNKNOWN_DAEMON` (409) on every agent create from
  the workspace UI.
- **`prismer setup` auto-starts daemon when config already exists** — the
  "Already configured" branch was returning early before `startDaemonDetached`,
  leaving users with a working config but no running daemon (no device
  appeared in the workspace).

### Internal

- `src/im/ws/handler.ts` — upsert im_containers on host.declare, guarded
  against empty daemonId; `startedAt` preserved across heartbeat redeclares.
- `src/im/api/register.ts` — `assertDeviceCapacityAvailable` matches by
  `OR(agentImUserId, daemonId)` so both runtime-installation and local daemon
  paths find the device row.
- `src/im/db/index.ts` — Prisma client re-export (unchanged, listed for audit
  completeness).

## v1.9.6 — 2026-05-12 — Refactoring wave: register hardening + CLI version sync

Batch delivery of §30 / §31 refactoring items affecting IM register flow,
CEO authorization data layer, and runtime version hygiene.

### Fixed

- **CLI `--version` + banner displayed stale `1.9.3`** after package.json was
  bumped to 1.9.6. `src/cli/index.ts` hardcoded `VERSION` const and
  `src/cli/util.ts` banner strings were missed in the 1.9.4→1.9.5→1.9.6 bump
  chain. Now reads `1.9.6` in both places.
- **Hermes adapter prompt still referenced old `im_send_to_agent` /
  `im_list_agents` tool names** after the MCP 58-tool rename sweep. Replaced
  with `prismer.agent.send` / `prismer.conversation.listAgents`. The old names
  returned 404 at dispatch time if the adapter actually called them.
- **`--json` output from `agent list` now surfaces `local.hosted: true`
  correctly** for agents that were registered with an adapter (was returning
  `local.hosted: false` when the local mirror hadn't synced yet).

### Internal

- Tool name sweep: `sdk/prismer-cloud/runtime/src/adapters/hermes/index.ts`
  (`buildHermesPrompt`), `src/im/types/im-events.ts` (unused old types),
  `src/im/services/message.service.ts` (WS event type const),
  `src/im/daemon/dispatch.ts` (dispatch compose).
- Version files bumped via `sdk/build/version.sh --scope prismer-cloud --patch`:
  `VERSION`, all SDK package.json, `mcp/src/index.ts`,
  `python/prismer/__init__.py`, `rust/Cargo.toml`, plugin manifests, root
  `package.json`, `src/lib/version.ts`.

---

## v1.9.3 — 2026-05-07 — Hosted agents + Hermes long-running + 16-verb CLI

First published cut of `@prismer/runtime`. The runtime is the TS-only daemon that hosts Prismer agents on a user's Mac (under `launchd`) or inside a sandbox pod (as PID 1). One binary, one WebSocket to cloud, four in-process adapters, local SQLite mirror.

### Added

- **CLI: 8 new verbs** — `setup`, `banner`, `chat`, `cookbook`, `asset`, `sandbox`, `memory`, `events` (+ `events:stats`). Plus `workspace` (already shipped). Total surface is now **16 verbs**.
  - `setup` — three onboarding paths (direct API key, `--token <jwt>` mints a daemon-scoped key via `POST /api/keys`, `--pair` delegates to QR/local-only). `--force` archives `local.db` → `local.db.<iso>.bak` when key/cloud/daemon_id changed.
  - `chat` — `me` / `direct` / `messages` / `group (create|send|messages|remove-member)`. Sanitizes `sk-prismer-*` from error messages.
  - `cookbook run` — 54release MVP regression suites (`status` / `im` / `task` / `group` / `asset` / `sandbox`); `--strict` treats skips as failure.
  - `asset` — `list` / `upload` (multipart) / `download` / `get` / `by-hash`.
  - `sandbox` — full `/api/sandboxes` CRUD + `runCmd` + log streaming.
  - `memory` — daemon Memory Gateway first; falls back to read-only view of `~/.prismer/local.db` cache tables when gateway is absent (returns `error.code='memory_gateway_unavailable'` with a fix hint).
  - `events` / `events:stats` — read `~/.prismer/para/events.jsonl` with `--limit / --agent-id / --session-id / --family / --type` filters; stats aggregates `byFamily / byType / byAgentId / bySessionId`.
- **Hermes long-running adapter** — autostart from `~/.hermes/profiles/<name>/config.yaml`, `/v1/runs` SSE consumer, full `tool.started` / `tool.completed` / `reasoning.available` event handling, Kanban + Goal mirror writeback onto `IMTask.metadata.bridge.hermes`. New runtime dep: `yaml@^2.8.2`. Hermes runs in the user's own Python venv; the runtime stays TS-only.
- **Hosted-agent pipeline** — `agent.host.declare` payload now stamps `daemonId` onto `IMAgentCard.metadata` so the workspace runtime view groups daemon-declared agents under the right device (instead of `__unbound__`). New `POST /v1/agents/install` LocalServer endpoint + `POST /:id/installAgent` sandbox-controller proxy enable cloud→daemon agent install RPC.
- **Static binding** — `PRISMER_HOSTED_AGENT_FILE` / `PRISMER_HOSTED_AGENT_JSON` / `PRISMER_STATIC_BINDING_REQUIRED` env vars consumed by `Runner.installStaticHostedAgentFromEnv`. K8s deployments seed one `agents` + `agent_profiles` row before the first `host.declare`.
- **Daemon-local shell route** — `runtimeRoute='shell'` (or `metadata.execution.kind === 'shell'`) routes through `shell-executor.ts`. Output capping (default 256 KiB, hard max 5 MiB), timeout enforcement (default 60s, hard max 30 min), `allowedWorkspaces` allow-list, `bash|zsh|sh` selector, structured error codes (`shell_disabled`, `shell_workspace_not_allowed`, `shell_command_required`, `shell_cwd_missing`, `shell_spawn_failed`, `shell_timeout`, `task_cancelled`, `shell_exit_nonzero`).
- **Stuck-task reaper** (60s) + **per-`taskId` dedupe** in `Runner.runningTasks` — closes the failure mode where cloud's `redispatchPending` fires the same task five times during a long LLM call and an upstream gateway half-closes a connection. Reaper aborts past `max(timeoutMs, 5min)` and emits `task.dispatch.reply {ok:false, error.code:'daemon_task_timeout'}`.
- **30s heartbeat re-declare** — re-sends `agent.host.declare` so cloud's 90s `sweepTimedOut()` doesn't flip status back offline.
- **Bridge + observability writeback** — dispatch PATCH-merges `result.metadata.hermes` onto `IMTask.metadata.bridge.hermes` (with `lastSyncedAt`) and writes `metadata.observability` with `{identity, memory, goals, lastSyncedAt}`.
- **8 new tests** under `test/` (Vitest):
  - `asset.test.ts` (240 LOC) — CLI asset CRUD + envelope normalization.
  - `chat-cli.test.ts` (135 LOC) — chat envelope + `sk-prismer` redaction.
  - `cookbook.test.ts` (148 LOC) — suite parsing, summary, strict-skip.
  - `dispatch.test.ts` (265 LOC) — `composePrompt` / `appendGoalContext` / `appendMemoryContext` + full `handleDispatch` path with mocked resolver/cache/ws/service-pool, plus error paths.
  - `hermes-validate.test.ts` (88 LOC) — `hermesAdapter.validate` accepts/rejects port, apiKey, env-var key regex, provider URL.
  - `sandbox.test.ts` (189 LOC) — sandbox CRUD + `runCmd` + logs streaming.
  - `shell-executor.test.ts` (66 LOC) — `resolveShellConfig` defaults + clamping, `isShellDispatch` routing, `executeShellDispatch` enabled/disabled/timeout.
  - `workspace-cli.test.ts` (89 LOC) — `prismer workspace (list|create|get|runtime|files)` envelope unwrapping.
- **2 opt-in Playwright e2e specs** under `e2e-playwright/specs/`:
  - `workspace-hermes-daemon-runtime.spec.ts` — `WAVE7_HERMES_E2E=1 HERMES_API_KEY=...`. Drives full `pair → register Hermes agent → AgentProfile → host.declare → POST /api/im/tasks → Hermes reply` chain via product APIs only.
  - `workspace-hermes-ui-flow.spec.ts` — `WAVE7_HERMES_UI_E2E=1`. Workspace UI: New Agent dialog → Hermes long-running role → direct session → IM message → reply persisted. Requires a real local daemon on `127.0.0.1:3210`.

### Evolved

- **5 existing CLI verbs reworked**: `adapter` (richer install/uninstall + per-adapter register, new `doctor` + `hooks`), `agent` (host register/list/unregister + 6-check `doctor`), `daemon` (`--foreground` for LaunchAgent + log tail-N + follow), `status` (consolidated banner + composite `/healthz` + `/api/im/me` + `local.db` row counts), `task` (tolerant envelope parsing for both `{task:{...}}` and flat shapes; reads `output` from `task.output` or `task.result.output`).
- **`Runner` + `dispatch` + `LocalServer`** gain hosted-agent paths (~940 lines added across the three files).

### Breaking

- **`package.json` `module` + `exports.import` now point at `dist/index.js`** (was `dist/index.mjs`, which `tsup` never actually emitted — bug fix that may affect bundlers respecting the old field).
- **`yaml@^2.8.2` is a new runtime dependency.** Used by the Hermes adapter to read/write `~/.hermes/profiles/<name>/config.yaml`.
- **`public/install.sh` strict-pins `@prismer/runtime@1.9.3`** (no caret). Stale 1.8.x installs will not auto-upgrade via curl re-run; users must explicitly re-run the installer.
- **LaunchAgent plist `ProgramArguments` now include `--foreground`.** Existing 1.8.x installs that loaded the plist without it would respawn-loop unless the user re-runs the installer (which does `bootout` + `bootstrap`).
- **`agent.host.declare` payload now requires `daemonId`** to be honored by cloud — without it the agent renders under `__unbound__` in the workspace runtime view.
- **`runtimeRoute` extended** with `'shell'` as a valid value of `TaskDispatchRequestPayload.runtimeRoute`. Cloud-side dispatchers that previously hard-coded `'agent'|'sandbox'` need a passthrough for `'shell'`.
- **`adapter list` JSON output now includes `installed: { package_manager, package_name, binary, version, installed_at } | null`** field. Strict-shape consumers need an update.
- **New CLI verbs may shadow user aliases**: `setup`, `banner`, `chat`, `cookbook`, `asset`, `sandbox`, `memory`, `events`, `events:stats`, `workspace`. None overlap with the prior 7-verb shape, but wrapper scripts that did `prismer <unknown>` and got a friendly error will now get command-not-found.
- **claude-code adapter closes child stdin** (`stdio: ['ignore', 'pipe', 'pipe']`). Operators relying on stdin-mode interactive use of `claude` via the daemon (which was never supported) see no behavior change; this only removes the 3s "no stdin" warning that made daemon dispatches appear hung on `claude` ≥ 2.1.128.

### Fixed

- **LaunchAgent KeepAlive respawn loop on macOS** — `install.sh` now passes `--foreground` to `prismer daemon start` in the plist `ProgramArguments`. Without it, `daemon start` spawned a child and exited, `launchd` saw exit-zero, KeepAlive=true respawned immediately. With `--foreground` the binary blocks in the polling loop until `config.toml` appears.

### Internal

- `module` / `exports.import` field correctness (`dist/index.js`).
- `qrcode@^1.5.4` runtime dep added (used by the QR pair flow).
- `eslint-plugin-react-hooks` added to dev tooling.

---

## v1.8.x — Pre-publish scaffolding

The runtime tree was scaffolded across the `feat/refactoring` branch. There were no published cuts before v1.9.3; the package landed at v1.9.3 directly when its public API surface stabilized.

## 2.2.10 (2026-08-07)

- Fix Hermes "No LLM provider configured" on sandbox agents: the provider
  bootstrap wrote `model.provider: custom:prismer`, but hermes' custom-provider
  resolution matches `custom_providers[].name` verbatim — `custom:prismer`
  never matched the `prismer` entry, the gateway fell through with
  provider='custom' and no key, and every turn failed at AIAgent init.
  Exposed on 2.2.9: the dual-write made the gateway read the profile config
  (HERMES_HOME override) for the first time, surfacing the format mismatch.
  Write the bare provider name (`prismer`); verified in-pod that
  `_resolve_runtime_agent_kwargs` then resolves api_key + base_url correctly.
## 2.2.9
