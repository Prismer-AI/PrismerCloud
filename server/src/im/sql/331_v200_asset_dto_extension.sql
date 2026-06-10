-- ============================================================================
-- Migration 331: v2.0 — IMAsset DTO extension
--
-- Adds the cross-client preview fields. cdnUrl and revision already exist from
-- earlier asset migrations; this migration intentionally does not add version.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _331_add_col_if_missing$$
CREATE PROCEDURE _331_add_col_if_missing(
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

CALL _331_add_col_if_missing('im_assets', 'thumbnailUrl', 'VARCHAR(500) NULL AFTER `cdnUrl`');
CALL _331_add_col_if_missing('im_assets', 'previewUrls', 'JSON NULL AFTER `thumbnailUrl`');

DROP PROCEDURE IF EXISTS _331_add_col_if_missing;

SELECT 'migration 331 v200 asset dto extension complete' AS status;
