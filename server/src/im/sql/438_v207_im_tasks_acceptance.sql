-- ============================================================================
-- Migration 438: v2.0.7 release201/10 — IMTask acceptance criteria fields
-- Date: 2026-05-26
-- Spec: docs/release201/10-task-acceptance.md §3.1
--
-- Why this migration exists
-- -------------------------
-- Task 进 review 时 reviewer 缺结构化"已完成"语义 —— 只能看自由 text result /
-- description 肉眼判断。本迁移加 2 列到 im_tasks:
--   acceptance_criteria_json TEXT  — criteria 数组 (§3.2 结构)
--   acceptance_status        VARCHAR(20) DEFAULT 'none'
--     enum: none / pending / partial / passed / failed
--     由 service 层 (TaskAcceptanceService.recomputeStatus, §4.2) 维护;
--     不依赖 DB trigger.
--
-- 索引: 单独 idx_acceptance_status 让 "本周 passed task 数" 这类聚合 query 走
-- 范围扫描而非全表扫.
--
-- 验收 (§0.2.1):
--   - 列 + 索引存在
--   - default value 'none' (legacy row 不阻塞)
-- ============================================================================

ALTER TABLE im_tasks
  ADD COLUMN acceptance_criteria_json TEXT NULL,
  ADD COLUMN acceptance_status VARCHAR(20) NOT NULL DEFAULT 'none',
  ADD INDEX idx_acceptance_status (acceptance_status);

-- Acceptance — 2 列 + 1 索引必须存在.
SELECT
  'migration 438 im_tasks.acceptance complete' AS status,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_tasks'
      AND column_name = 'acceptance_criteria_json') AS criteria_column_present,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_tasks'
      AND column_name = 'acceptance_status') AS status_column_present,
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_tasks'
      AND index_name = 'idx_acceptance_status') AS status_index_present;
