-- ============================================================================
-- Migration 334: v2.0 — Agent skill sync ack fields
--
-- Adds daemon acknowledgement fields used by
-- POST /api/im/agents/:id/skills/ack.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _334_add_col_if_missing$$
CREATE PROCEDURE _334_add_col_if_missing(
  IN p_table VARCHAR(64),
  IN p_col VARCHAR(64),
  IN p_def TEXT
)
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = p_table
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
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

DROP PROCEDURE IF EXISTS _334_add_idx_if_missing$$
CREATE PROCEDURE _334_add_idx_if_missing(
  IN p_table VARCHAR(64),
  IN p_idx VARCHAR(64),
  IN p_cols TEXT
)
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = p_table
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
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

CALL _334_add_col_if_missing('im_agent_skills', 'installedRevision', 'VARCHAR(64) NULL AFTER `version`');
CALL _334_add_col_if_missing('im_agent_skills', 'lastSyncedAt', 'DATETIME(3) NULL AFTER `installedRevision`');
CALL _334_add_col_if_missing('im_agent_skills', 'lastSyncError', 'TEXT NULL AFTER `lastSyncedAt`');
CALL _334_add_idx_if_missing('im_agent_skills', 'im_agent_skills_agentId_lastSyncedAt_idx', '`agentId`, `lastSyncedAt`');

DROP PROCEDURE IF EXISTS _334_add_col_if_missing;
DROP PROCEDURE IF EXISTS _334_add_idx_if_missing;

SELECT 'migration 334 v200 agent skill sync complete' AS status;
