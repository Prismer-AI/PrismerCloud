-- ============================================================================
-- Migration 441: v2.0.7 — fix migration 438 column casing drift
-- Date: 2026-05-26
-- Spec: docs/release201/10-task-acceptance.md §3.1
--
-- Why this migration exists
-- -------------------------
-- Migration 438 added two columns to im_tasks using snake_case
-- (acceptance_criteria_json / acceptance_status), but Prisma schema
-- (schema.mysql.prisma) declares the matching fields as camelCase
-- (acceptanceCriteriaJson / acceptanceStatus) *without* an @map directive,
-- consistent with the rest of IMTask's columns (assigneeId, runtimeRoute,
-- runCount, maxRuns, retryDelayMs ... 全 camelCase 无 @map).
--
-- Result: `npm run db:check` reported 4 drift items —
--   2 DROP COLUMN (DB has snake, Prisma doesn't know about them)
--   2 ADD COLUMN  (Prisma expects camel, DB lacks)
-- plus a related index `idx_acceptance_status` pointing at the wrong column.
--
-- Migration 438 is immutable once applied (schema_migrations enforces sha
-- mismatch protection). Fix forward: rename columns + rebuild the index so
-- the resulting DB matches the Prisma model exactly.
--
-- Idempotent via INFORMATION_SCHEMA guards — safe to apply on:
--   (a) DBs that already ran 438 (snake_case columns present): RENAME
--   (b) DBs that have camelCase columns from a fresh-state baseline: skip
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _441_rename_col$$
CREATE PROCEDURE _441_rename_col(
  IN p_table VARCHAR(64),
  IN p_old   VARCHAR(64),
  IN p_new   VARCHAR(64),
  IN p_def   TEXT
)
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND column_name = p_old
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND column_name = p_new
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` CHANGE COLUMN `', p_old, '` `', p_new, '` ', p_def);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DROP PROCEDURE IF EXISTS _441_drop_idx$$
CREATE PROCEDURE _441_drop_idx(
  IN p_table VARCHAR(64),
  IN p_idx   VARCHAR(64)
)
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND index_name = p_idx
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` DROP INDEX `', p_idx, '`');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DROP PROCEDURE IF EXISTS _441_add_idx$$
CREATE PROCEDURE _441_add_idx(
  IN p_table VARCHAR(64),
  IN p_idx   VARCHAR(64),
  IN p_cols  TEXT
)
BEGIN
  IF NOT EXISTS (
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

-- 1) Drop index that points at snake_case column (must drop before rename
--    or MySQL retains the old name; rebuilding after ensures the index
--    references the new column name).
CALL _441_drop_idx('im_tasks', 'idx_acceptance_status');

-- 2) Rename snake_case → camelCase to align with Prisma schema.
CALL _441_rename_col(
  'im_tasks',
  'acceptance_criteria_json',
  'acceptanceCriteriaJson',
  'TEXT NULL'
);

CALL _441_rename_col(
  'im_tasks',
  'acceptance_status',
  'acceptanceStatus',
  'VARCHAR(20) NOT NULL DEFAULT ''none'''
);

-- 3) Recreate the index on the camelCase column (Prisma expects
--    `idx_acceptance_status` per @@index([acceptanceStatus], map: ...)).
CALL _441_add_idx('im_tasks', 'idx_acceptance_status', '`acceptanceStatus`');

DROP PROCEDURE IF EXISTS _441_rename_col;
DROP PROCEDURE IF EXISTS _441_drop_idx;
DROP PROCEDURE IF EXISTS _441_add_idx;

-- Acceptance — final state must have the camelCase columns + index, and
-- must NOT retain the snake_case columns.
SELECT
  'migration 441 fix 438 acceptance camelcase complete' AS status,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_tasks'
      AND column_name = 'acceptanceCriteriaJson') AS camel_criteria_present,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_tasks'
      AND column_name = 'acceptanceStatus') AS camel_status_present,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_tasks'
      AND column_name = 'acceptance_criteria_json') AS snake_criteria_residue,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_tasks'
      AND column_name = 'acceptance_status') AS snake_status_residue,
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_tasks'
      AND index_name = 'idx_acceptance_status') AS status_index_present;
