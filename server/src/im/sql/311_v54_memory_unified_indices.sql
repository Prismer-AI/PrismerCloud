-- ============================================================================
-- Migration 311: v5.4 — Workspace memory unified read indices
-- Date: 2026-05-08
--
-- Adds the (workspaceId, pageType, contentHash) composite index used by
-- duplicate cluster detection in GET /memory/health/duplicates. Lets the
-- duplicate query stay O(N) on the index rather than full-table O(N²).
--
-- Idempotent: index creation guarded via stored procedure.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _311_add_idx_if_missing$$
CREATE PROCEDURE _311_add_idx_if_missing(
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

CALL _311_add_idx_if_missing(
  'im_memory_pages',
  'idx_im_memory_pages_workspace_pagetype_contenthash',
  '`workspaceId`, `pageType`, `contentHash`'
);

DROP PROCEDURE IF EXISTS _311_add_idx_if_missing;

SELECT 'migration 309 complete' AS status;
