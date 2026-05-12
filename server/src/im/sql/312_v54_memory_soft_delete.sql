-- ============================================================================
-- Migration 312: v5.4 — Workspace memory soft-delete column
-- Date: 2026-05-08
--
-- Adds `deletedAt` to im_memory_pages so DELETE /memory/pages/:id is reversible
-- within the 30-day cron retention window. Soft-deleted rows are excluded from
-- list/read APIs by `archivedAt IS NULL AND deletedAt IS NULL` filters.
--
-- Idempotent: column addition guarded via stored procedure.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _312_add_col_if_missing$$
CREATE PROCEDURE _312_add_col_if_missing(
  IN p_table VARCHAR(64),
  IN p_col VARCHAR(64),
  IN p_def TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND column_name = p_col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_col, '` ', p_def);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DROP PROCEDURE IF EXISTS _312_add_idx_if_missing$$
CREATE PROCEDURE _312_add_idx_if_missing(
  IN p_table VARCHAR(64),
  IN p_idx VARCHAR(64),
  IN p_cols TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND index_name = p_idx
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD INDEX `', p_idx, '` (', p_cols, ')');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

CALL _312_add_col_if_missing('im_memory_pages', 'deletedAt', 'DATETIME(3) NULL');
CALL _312_add_idx_if_missing(
  'im_memory_pages',
  'idx_im_memory_pages_workspace_deleted',
  '`workspaceId`, `deletedAt`'
);

DROP PROCEDURE IF EXISTS _312_add_col_if_missing;
DROP PROCEDURE IF EXISTS _312_add_idx_if_missing;

SELECT 'migration 311 complete' AS status;
