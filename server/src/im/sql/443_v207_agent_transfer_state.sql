-- ============================================================================
-- Migration 443: v2.0.7 Phase 3 — im_agent_bindings transfer state tracking
-- Date: 2026-05-27
-- Spec: docs/release201/09-project-abstraction.md §9.7 + §0.2.1 Phase 3 +
--       S31 task brief (3-stage initiate/complete/abort agent transfer protocol)
--
-- Why this migration exists
-- -------------------------
-- Migration 435 加 pausedAt 给 transfer 提供 quiesce 信号。这只能表示 "agent
-- 暂时不接 dispatch",没法表达"transfer 正在哪个阶段","目标 daemon 是谁",
-- "transfer 启动时间多久"。当 export tarball 在源 device 已生成但目标 device
-- import 未完成时,如果出错恢复策略不清:
--
--   1. 哪个 daemon 是 transfer 的 "current owner of the transition"?
--   2. ops 想 abort transfer 时,怎么知道 transfer 还在进行中?
--   3. 二段提交语义在 pausedAt 单字段下表达不完整 — pausedAt 可能是
--      transfer-quiesce 也可能是 admin hold (operator 手动 pause)。
--
-- 加 3 字段做出阶段性追踪:
--
--   transferState         transferToDaemonId   transferInitiatedAt   含义
--   -------------         ------------------   --------------------  ---------
--   'idle'                NULL                 NULL                  正常状态 (默)
--   'initiated'           <toDaemonId>         <ts>                  源已 quiesce,
--                                                                    tar 正在/已生成,
--                                                                    目标 device 接管中
--   'completed'           NULL                 NULL                  rebind 已落 +
--                                                                    pausedAt 已清
--                                                                    (相当于回 idle)
--   'aborted'             NULL                 NULL                  二阶段任一方调
--                                                                    abort,回 idle
--                                                                    boundDaemonId 不动
--
-- 'completed' 和 'aborted' 是瞬态; 落库后立刻设回 'idle' (实际只在 audit
-- 事件中暴露)。
--
-- 设计决策:
--   - 不引入新表 IMAgentTransfer (1 个 agent 一时刻只能在 1 个 transfer 中,
--     用 binding row 字段足够)
--   - transferState 为 enum-like 字符串而非 boolean,便于排查
--   - 不加 index — transfer 操作低频
--
-- 验收 (S31 DoD A):
--   - im_agent_bindings 加 3 列
--   - POST /api/im/agent-transfer/initiate 设 transferState='initiated' +
--     transferToDaemonId + transferInitiatedAt + pausedAt=NOW
--   - POST /api/im/agent-transfer/:transferId/complete 把 boundDaemonId 改
--     成 toDaemonId,清 transfer* + pausedAt
--   - POST /api/im/agent-transfer/:transferId/abort 清 transfer* + pausedAt
--     (boundDaemonId 不动)
-- ============================================================================

ALTER TABLE im_agent_bindings
  ADD COLUMN transferState VARCHAR(20) DEFAULT 'idle',
  ADD COLUMN transferToDaemonId VARCHAR(60) DEFAULT NULL,
  ADD COLUMN transferInitiatedAt DATETIME(3) DEFAULT NULL;

-- Backfill: 老 binding 行没有这些字段,但 DEFAULT 已经在 ADD COLUMN 时
-- 同步写入 transferState='idle'。其它两列保留 NULL = 无在途 transfer。
-- 不需要显式 UPDATE。
