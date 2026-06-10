-- ============================================================================
-- Migration 329: v2.0 — Role template curation fields
--
-- Adds the import/curation metadata required for agency-agents seeding.
-- MySQL strict mode note: JSON metadata is nullable; no TEXT/LONGTEXT literal
-- defaults are introduced.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _329_add_col_if_missing$$
CREATE PROCEDURE _329_add_col_if_missing(
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

DROP PROCEDURE IF EXISTS _329_add_idx_if_missing$$
CREATE PROCEDURE _329_add_idx_if_missing(
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

CALL _329_add_col_if_missing('im_role_templates', 'source', 'VARCHAR(30) NOT NULL DEFAULT ''prismer-native'' AFTER `status`');
CALL _329_add_col_if_missing('im_role_templates', 'sourceSlug', 'VARCHAR(120) NULL AFTER `source`');
CALL _329_add_col_if_missing('im_role_templates', 'sourceCommit', 'VARCHAR(64) NULL AFTER `sourceSlug`');
CALL _329_add_col_if_missing('im_role_templates', 'importedAt', 'DATETIME(3) NULL AFTER `sourceCommit`');
CALL _329_add_col_if_missing('im_role_templates', 'curatedQuality', 'VARCHAR(20) NOT NULL DEFAULT ''review'' AFTER `importedAt`');
CALL _329_add_col_if_missing('im_role_templates', 'metadata', 'JSON NULL AFTER `curatedQuality`');

CALL _329_add_idx_if_missing('im_role_templates', 'im_role_templates_source_idx', '`source`, `curatedQuality`');
CALL _329_add_idx_if_missing('im_role_templates', 'im_role_templates_quality_idx', '`curatedQuality`, `status`');

DROP PROCEDURE IF EXISTS _329_add_col_if_missing;
DROP PROCEDURE IF EXISTS _329_add_idx_if_missing;

SELECT 'migration 329 v200 role templates curation complete' AS status;
