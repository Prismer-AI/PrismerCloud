-- ============================================================================
-- Migration 439: v2.0.7 release201/10 — Task criteria template store
-- Date: 2026-05-26
-- Spec: docs/release201/10-task-acceptance.md §3.3
--
-- Why this migration exists
-- -------------------------
-- task 创建时按 capability 自动挂 criteria template (e.g. capability='skill-tryout'
-- 默推 3 项 §8.3 from 08 doc). Template 分两个 scope:
--   - workspace_id IS NULL  → global (Prismer 内置, seed 在 cloud 启动时跑)
--   - workspace_id IS 具体   → workspace-level (workspace owner 自定义)
--
-- 4 个 global template (workspace_id=NULL) seed 见 task-criteria-template.service.ts
-- 的 seedDefaults():
--   - general       — 1 项 manual "task completed as described" (兜底)
--   - skill-tryout  — 3 项 (skill installed / triggered once / works as expected)
--   - skill-review  — 3 项 (manifest valid / frontmatter ok / no security warnings)
--   - skill-publish — 2 项 (license confirmed / sample task generated)
--
-- 索引策略:
--   idx_ws_capability (workspace_id, capability)  — workspace lookup 按 capability
--   idx_capability    (capability)                 — global fallback
--   idx_default       (capability, is_default)     — "give me the default" 主路径
--
-- 验收 (§0.2.1):
--   - 表存在 + 3 个索引存在
--   - workspace_id NULLable
--   - is_default 默 false
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_task_criteria_templates (
  id            VARCHAR(30) NOT NULL,
  workspace_id  VARCHAR(30) NULL,
  capability    VARCHAR(100) NOT NULL,
  name          VARCHAR(128) NOT NULL,
  description   TEXT NULL,
  criteria_json TEXT NOT NULL,
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX idx_ws_capability (workspace_id, capability),
  INDEX idx_capability (capability),
  INDEX idx_default (capability, is_default)
);

-- Acceptance — 表 + 3 个 index 必须存在.
SELECT
  'migration 439 im_task_criteria_templates complete' AS status,
  (SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'im_task_criteria_templates') AS table_present,
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_task_criteria_templates'
      AND index_name = 'idx_ws_capability') AS ws_capability_index_present,
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_task_criteria_templates'
      AND index_name = 'idx_capability') AS capability_index_present,
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_task_criteria_templates'
      AND index_name = 'idx_default') AS default_index_present;
