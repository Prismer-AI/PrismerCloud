-- ============================================================================
-- Migration 433: v2.0.7 Phase 2 — im_tasks.projectId NULL
-- Date: 2026-05-26
-- Spec: docs/release201/09-project-abstraction.md §10.4 Phase 2 + §3.3
--
-- Why this migration exists
-- -------------------------
-- Phase 1 (432) 建立 IMProject 主体但未关联现有资源。Phase 2 在 im_tasks 加
-- projectId 列 (NULL = workspace-level / unscoped),配套 task list endpoint
-- ?projectId= filter (§4.2) 与 new-task-dialog Project 下拉。
--
-- 设计决策 (§16 + §3.3):
--   - NULL 是合法状态(opt-in),不创建 default project 兜底
--   - 复合索引 (projectId, status) 支持 board 按 project + status filter
--
-- 验收 (§0.2.1 Phase 2):
--   - im_tasks 加 projectId 列 + idx_im_tasks_project_status
--   - 已有 task list endpoint 不退化 (projectId 不传时行为不变)
-- ============================================================================

ALTER TABLE im_tasks
  ADD COLUMN projectId VARCHAR(30) NULL,
  ADD INDEX idx_im_tasks_project_status (projectId, status);

-- Acceptance — column must exist and the composite index must be present.
SELECT
  'migration 433 im_tasks.projectId complete' AS status,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_tasks'
      AND column_name = 'projectId') AS projectId_column_present,
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_tasks'
      AND index_name = 'idx_im_tasks_project_status') AS project_status_index_present;
