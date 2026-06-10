-- ============================================================================
-- Migration 327: v5.4 ACP drift fix
--
-- Repairs local databases that applied an earlier ACP migration before the
-- final Prisma schema settled. Keep this forward-only: do not edit/replay 326.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _327_add_col_if_missing$$
CREATE PROCEDURE _327_add_col_if_missing(
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

DELIMITER ;

CALL _327_add_col_if_missing(
  'im_approvals',
  'updatedAt',
  'DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'
);

DROP TABLE IF EXISTS `role_templates`;

DROP PROCEDURE IF EXISTS _327_add_col_if_missing;

SELECT 'migration 327 acp drift fix complete' AS status;
