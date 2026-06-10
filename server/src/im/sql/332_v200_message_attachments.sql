-- ============================================================================
-- Migration 332: v2.0 — IMMessage.attachments
--
-- Adds first-class asset attachments while preserving legacy metadata.fileUrl
-- and metadata.fileName compatibility.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _332_add_col_if_missing$$
CREATE PROCEDURE _332_add_col_if_missing(
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

DELIMITER ;

CALL _332_add_col_if_missing('im_messages', 'attachments', 'JSON NULL AFTER `metadata`');

DROP PROCEDURE IF EXISTS _332_add_col_if_missing;

SELECT 'migration 332 v200 message attachments complete' AS status;
