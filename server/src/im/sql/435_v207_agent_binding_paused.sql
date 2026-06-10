-- ============================================================================
-- Migration 435: v2.0.7 Phase 3 — im_agent_bindings.pausedAt (agent transfer)
-- Date: 2026-05-26
-- Spec: docs/release201/09-project-abstraction.md §9.7.2 + §0.2.1 Phase 3 + §16 D12
--
-- Why this migration exists
-- -------------------------
-- Phase 3 引入 agent transfer 协议 (`prismer agent export/import`)。Transfer
-- 前必须 quiesce 源 device 的 dispatch (否则 transfer 进行中 cloud 仍把任务
-- 路由到旧 device,丢消息 / 双重执行)。Quiesce 信号是新加 pausedAt 列:
--
--   pausedAt = NULL  → 正常 dispatch
--   pausedAt = <ts>  → cloud dispatch loop SKIP 这个 agent;返回
--                       agent_paused 状态给 client / sender
--
-- Resume 时清回 NULL。Transfer endpoint 拿 binding update + pausedAt clear
-- 一并完成,resume 之前业务上 agent 已 rebind 到目标 device 了。
--
-- 设计决策 (§16 D12):
--   - 不引入新表 IMAgentBindingTransferLog;transfer 日志走 sync_events
--     ('agent.binding.rebound' 事件,reason='transfer') + 现有 AgentBindingService
--     metadata 字段。Single source of truth = IMAgentBinding row。
--   - pausedAt 是 DATETIME(3) 而非 boolean,便于排查 "已 paused 多久"
--     (>15 分钟未 resume → ops 告警可加)。
--   - 不加 index — pause 操作低频 (人工 transfer);dispatch loop 已按
--     agentImUserId 查 binding,加载 row 自然带出 pausedAt。
--
-- 验收 (§0.2.1 Phase 3):
--   - im_agent_bindings 加 pausedAt 列
--   - POST /api/im/agents/:id/pause 设此列;POST /resume 清此列
--   - POST /api/im/agent-bindings/transfer 完成 rebind 后 resume 一气呵成
-- ============================================================================

ALTER TABLE im_agent_bindings
  ADD COLUMN pausedAt DATETIME(3) DEFAULT NULL;

-- 无 backfill — 老 binding 行默 NULL = 正常 dispatch,语义等价 pre-migration
-- 行为,不需要 UPDATE。
