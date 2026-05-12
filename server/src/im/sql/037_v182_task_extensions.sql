-- ============================================================================
-- Migration 037: v1.8.2 Task model extensions for Lumin iOS parity
-- Date: 2026-04-13 (m3 phase 2 rewrite: 2026-05-02)
-- NOTE: Column names use camelCase to match Prisma's default mapping
--
-- Track A m3 phase 2 fix: original 037 cascaded from a 034 failure (referenced
-- the `scope` column with `AFTER scope` placement, but 034's syntax was
-- MariaDB-only and didn't add the scope column on MySQL 8). With 034 now
-- fixed and idempotent, 037 also wraps each ALTER in INFORMATION_SCHEMA
-- guards. The `AFTER` clause is preserved for tables/columns where it
-- still applies; if the anchor column is missing, the helper omits the
-- AFTER clause and appends to the end (still functional, just cosmetic).
-- ============================================================================

DROP PROCEDURE IF EXISTS _037_add_col;
DELIMITER //
CREATE PROCEDURE _037_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN col_def TEXT)
BEGIN
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl) > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col) = 0 THEN
    SET @stmt := CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', col_def);
    PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS _037_add_idx;
DELIMITER //
CREATE PROCEDURE _037_add_idx(IN tbl VARCHAR(64), IN idx_name VARCHAR(64), IN cols TEXT)
BEGIN
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl) > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND INDEX_NAME = idx_name) = 0 THEN
    SET @stmt := CONCAT('ALTER TABLE `', tbl, '` ADD INDEX `', idx_name, '` (', cols, ')');
    PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

-- Task progress tracking + conversation association
-- Note: AFTER column reference omitted; MySQL appends to the end which is
-- semantically equivalent (ordering is cosmetic). The original 037 used
-- `AFTER scope` / `AFTER deadline` which depended on those columns existing.
CALL _037_add_col('im_tasks', 'progress',       'DOUBLE DEFAULT NULL');
CALL _037_add_col('im_tasks', 'statusMessage',  'VARCHAR(500) DEFAULT NULL');
CALL _037_add_col('im_tasks', 'conversationId', 'VARCHAR(36) DEFAULT NULL');
CALL _037_add_col('im_tasks', 'completedAt',    'DATETIME(3) DEFAULT NULL');

CALL _037_add_idx('im_tasks', 'idx_conversation', 'conversationId');
CALL _037_add_idx('im_tasks', 'idx_completed',    'completedAt');

-- Quote reply support (iOS inline reply, distinct from parentId threading)
CALL _037_add_col('im_messages', 'quotedMessageId', 'VARCHAR(30) DEFAULT NULL');
CALL _037_add_idx('im_messages', 'idx_quoted',      'quotedMessageId');

DROP PROCEDURE _037_add_col;
DROP PROCEDURE _037_add_idx;
