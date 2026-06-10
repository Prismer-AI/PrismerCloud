-- ============================================================================
-- Migration 434: v2.0.7 Phase 2 — im_assets.boundKind (Library spam 修复)
-- Date: 2026-05-26
-- Spec: docs/release201/09-project-abstraction.md §9.4a.2 + §10.4 Phase 2
--
-- Why this migration exists
-- -------------------------
-- 用户痛点 (2026-05-26 截图证据): library-files-panel.tsx Tasks/Sandbox folder
-- always-render + 每跑一个 task 多一个 cmp*** folder → CEO 找不到 workspace
-- 资料。根因是 IMAsset 缺 "用户视角角色" 信号。本迁移加 boundKind 2 值 enum
-- (应用层):
--   'task-bound'     — agent / sandbox 产物 (sourceTaskId 表"哪个 task")
--   'workspace-file' — owner 显式上传 / 从 task drawer Promote ↑ 上来
--   NULL            — backfill 完成前的 legacy 行 (后续不应再出现)
--
-- 设计决策 (§9.4a.2 + §16 D15/D16/D17):
--   - 简化自原 5 值设计;evidence 角色由 IMTask.acceptanceCriteriaJson.evidenceRefs[]
--     表达,不在 IMAsset 维度区分 (§9.4a.9)
--   - 与 projectId / sourceTaskId / workspaceId 四维各自独立 (§9.4a.2)
--   - Library Root 默 filter 即 boundKind='workspace-file'
--
-- Backfill 策略 (§9.4a.2):
--   - 有 sourceTaskId 或 folder_path '/sandbox/%' → task-bound
--   - 其它 (NULL sourceTaskId 且 folder_path NULL 或非 /sandbox/) → workspace-file
--
-- 验收 (§0.2.1 Phase 2):
--   - im_assets 加 boundKind 列 + idx_im_assets_ws_boundKind
--   - backfill 后无 NULL boundKind (验收脚本)
-- ============================================================================

ALTER TABLE im_assets
  ADD COLUMN boundKind VARCHAR(20) DEFAULT NULL,
  ADD INDEX idx_im_assets_ws_boundKind (workspaceId, boundKind);

-- Backfill — task-bound: 来源是 task / sandbox 的产物。
-- 包含 (a) sourceTaskId 非空 → agent / chat-mention 产物;
--      (b) folderPath '/sandbox/%' → sandbox 输出 (历史 OutboxWatcher path).
-- 注: im_assets 历史上用 camelCase 列名 (sourceTaskId / folderPath),
-- 不是 snake_case。
UPDATE im_assets
   SET boundKind = 'task-bound'
 WHERE sourceTaskId IS NOT NULL
    OR folderPath LIKE '/sandbox/%';

-- Backfill — workspace-file: 其它所有 (无 sourceTaskId 且非 sandbox path).
UPDATE im_assets
   SET boundKind = 'workspace-file'
 WHERE sourceTaskId IS NULL
   AND (folderPath IS NULL OR folderPath NOT LIKE '/sandbox/%');

-- Acceptance — column + index must exist; NULL boundKind 应为 0 (backfill 全覆盖).
SELECT
  'migration 434 im_assets.boundKind complete' AS status,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_assets'
      AND column_name = 'boundKind') AS boundKind_column_present,
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_assets'
      AND index_name = 'idx_im_assets_ws_boundKind') AS ws_boundKind_index_present,
  (SELECT COUNT(*) FROM im_assets WHERE boundKind IS NULL) AS null_boundKind_after_backfill;
