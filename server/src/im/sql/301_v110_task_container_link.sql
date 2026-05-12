-- ============================================================================
-- Migration 301: v1.10.0 Cloud-3 task → sandbox routing (S3)
-- Date: 2026-05-03
--
-- Adds 2 columns to im_tasks:
--   - runtimeRoute (NULLable, default 'agent') — execution surface selector
--   - containerId  (NULLable) — backref to im_containers (S2) when routed to sandbox
--
-- Adds 2 indexes:
--   - idx_im_tasks_runtimeRoute_status — composite for routing dispatcher queries
--   - idx_im_tasks_containerId         — single-column for container backref lookups
--
-- All ADD-only; no DROP / RENAME.
-- Idempotent via INFORMATION_SCHEMA guards (Track A 029-037 + 300 pattern).
-- No application-enforced foreign keys here — convention across im_* tables
-- is FK-free in MySQL (relations enforced at the application layer).
-- ============================================================================

DROP PROCEDURE IF EXISTS _301_add_col;
DELIMITER //
CREATE PROCEDURE _301_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN col_def TEXT)
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

DROP PROCEDURE IF EXISTS _301_add_idx;
DELIMITER //
CREATE PROCEDURE _301_add_idx(IN tbl VARCHAR(64), IN idx_name VARCHAR(64), IN cols TEXT)
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

CALL _301_add_col('im_tasks', 'runtimeRoute', 'VARCHAR(20) DEFAULT ''agent''');
CALL _301_add_col('im_tasks', 'containerId',  'VARCHAR(30) DEFAULT NULL');

CALL _301_add_idx('im_tasks', 'idx_im_tasks_runtimeRoute_status', '`runtimeRoute`, `status`');
CALL _301_add_idx('im_tasks', 'idx_im_tasks_containerId',         '`containerId`');

DROP PROCEDURE _301_add_col;
DROP PROCEDURE _301_add_idx;
