-- ============================================================================
-- Migration 310: v1.9.4 — Decouple task result from IMAsset + folder index
-- Date: 2026-05-08
--
-- Wave-9 Phase 1+2 (review-locked):
--   1. Soft-delete every legacy IMAsset(kind='task-result'). These were
--      written by createTaskResultAsset() on every task completion as a
--      duplicate of im_messages.content, and had zero readers in cloud /
--      SDK / UI. Storage rows stay (deletedAt set), so the migration is
--      reversible by clearing deletedAt on the target rows.
--   2. Add (workspaceId, folderPath, deletedAt) index to support the new
--      GET /api/im/assets/folders aggregate + folderPath filtering on the
--      asset list endpoint.
--
-- Idempotent. Safe to re-run; soft-delete only fires on rows whose
-- deletedAt is still NULL.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _310_add_idx_if_missing$$
CREATE PROCEDURE _310_add_idx_if_missing(
  IN p_table VARCHAR(64),
  IN p_idx VARCHAR(64),
  IN p_def TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND index_name = p_idx
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table, '` ADD INDEX `', p_idx, '` ', p_def);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

-- ─── 1. Soft-delete legacy task-result assets ─────────────────────────────
--
-- Set deletedAt on every kind='task-result' row that hasn't already been
-- deleted. Rows remain in the table and can be recovered by the inverse
-- UPDATE if needed. Storage GC piggybacks on the existing LRU sweep
-- (content-hashed files; orphans get reclaimed when no row references
-- them).
--
-- Why the ROW_NUMBER() spread: im_assets has a unique key on
-- (workspaceId, contentHash, deletedAt) and `deletedAt` is DATETIME(3)
-- — millisecond precision. Naïve UPDATE … SET deletedAt = NOW(3) would
-- set every row in a single statement to the same NOW(3) value (MySQL
-- evaluates NOW() once per statement), and any duplicate (workspaceId,
-- contentHash) tuple in the targeted set would collide on the unique
-- key. Duplicates are rare but real — agents that produce the same
-- output twice in a workspace generate two content-hashed rows that
-- are both alive (16:17:49.091 + 16:17:49.093 example). Stagger
-- deletedAt by 1 millisecond per row within each (workspaceId,
-- contentHash) group so every soft-delete lands on a distinct
-- DATETIME(3) value. Microsecond intervals would truncate.
UPDATE im_assets AS a
INNER JOIN (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY workspaceId, contentHash ORDER BY createdAt, id) AS rn
  FROM im_assets
  WHERE kind = 'task-result'
    AND deletedAt IS NULL
) AS ranked ON a.id = ranked.id
-- MySQL 8.0 doesn't have a `MILLISECOND` interval unit; multiply rn by
-- 1000 microseconds to land on whole-millisecond increments that
-- DATETIME(3) preserves.
SET a.deletedAt = DATE_ADD(NOW(3), INTERVAL ranked.rn * 1000 MICROSECOND);

-- ─── 2. Folder navigation index ───────────────────────────────────────────
--
-- Phase 2.3 adds GET /api/im/assets/folders + folderPath= filtering on the
-- list endpoint. Without this index, both queries devolve to full-table
-- scans on workspaces with non-trivial asset counts.
CALL _310_add_idx_if_missing(
  'im_assets',
  'idx_im_assets_workspace_folder',
  '(`workspaceId`, `folderPath`, `deletedAt`)'
);

DROP PROCEDURE IF EXISTS _310_add_idx_if_missing;
