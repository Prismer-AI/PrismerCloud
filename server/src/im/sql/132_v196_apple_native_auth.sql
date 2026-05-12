-- ============================================================================
-- Migration 132: v1.9.6 — Native Auth: Sign in with Apple provider id
--
-- Adds im_users.appleId for native iOS Sign in with Apple. The value is
-- Apple's stable `sub` claim from the verified identity token. NULL remains
-- allowed so existing email / Google / GitHub / agent rows are untouched.
-- ============================================================================

DROP FUNCTION IF EXISTS _132_table_exists;
DELIMITER //
CREATE FUNCTION _132_table_exists(tbl VARCHAR(64)) RETURNS TINYINT
  READS SQL DATA
  DETERMINISTIC
BEGIN
  RETURN (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl);
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS _132_add_col_if_missing;
DELIMITER //
CREATE PROCEDURE _132_add_col_if_missing(IN tbl VARCHAR(64), IN col VARCHAR(64), IN col_def TEXT)
BEGIN
  IF _132_table_exists(tbl) > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col) = 0 THEN
    SET @_132_stmt := CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', col_def);
    PREPARE _132_s FROM @_132_stmt; EXECUTE _132_s; DEALLOCATE PREPARE _132_s;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS _132_add_unique_if_missing;
DELIMITER //
CREATE PROCEDURE _132_add_unique_if_missing(IN tbl VARCHAR(64), IN idx_name VARCHAR(64), IN col VARCHAR(64))
BEGIN
  IF _132_table_exists(tbl) > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND INDEX_NAME = idx_name) = 0 THEN
    SET @_132_stmt := CONCAT('ALTER TABLE `', tbl, '` ADD UNIQUE KEY `', idx_name, '` (`', col, '`)');
    PREPARE _132_s FROM @_132_stmt; EXECUTE _132_s; DEALLOCATE PREPARE _132_s;
  END IF;
END //
DELIMITER ;

CALL _132_add_col_if_missing('im_users', 'appleId',
  'VARCHAR(128) NULL DEFAULT NULL COMMENT ''Apple stable subject id (Sign in with Apple)''');
CALL _132_add_unique_if_missing('im_users', 'im_users_appleId_key', 'appleId');

DROP PROCEDURE IF EXISTS _132_add_col_if_missing;
DROP PROCEDURE IF EXISTS _132_add_unique_if_missing;
DROP FUNCTION  IF EXISTS _132_table_exists;

SELECT 'migration 132 complete' AS status;
