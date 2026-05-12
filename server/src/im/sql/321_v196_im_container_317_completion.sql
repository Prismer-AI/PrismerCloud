-- ============================================================================
-- Migration 321: v1.9.6 — Complete sandbox §26 B5 (migration 317_v196)
-- Date: 2026-05-11
-- Track: dispatcher fix-forward during Wave-54 refactor merge
--
-- Background
-- ----------
-- 317_v196_im_container_device_semantic.sql (commit b8827129, §26 B5 Stage 1)
-- assumes the prior migration 304_v110_runtimeKind.sql has added
-- `runtimeKind` to im_containers. On databases where 304 was applied that
-- holds; on fresh dev / minimal-init databases the UPDATE step:
--
--     UPDATE im_containers SET deviceType = runtimeKind
--     WHERE deviceType = 'k8s' AND runtimeKind IS NOT NULL ...
--
-- raises `ERROR 1054 Unknown column 'runtimeKind'` and MySQL's default
-- abort-on-error skips the two subsequent CREATE INDEX statements. Net
-- effect on fresh DB:
--   • deviceType / daemonId columns ARE added (CALL succeeded first)
--   • Backfill from runtimeKind does NOT run
--   • idx_im_containers_daemonId / idx_im_containers_deviceType MISSING
--
-- Industry-standard fix is forward-only (append). This migration completes
-- what 317 couldn't finish, guarded so it's safe on either initial-state:
--   • If runtimeKind exists (prod-like, 304 applied) → backfill runs
--   • If runtimeKind missing (fresh init) → backfill skipped without error
--   • Indexes added idempotently in both cases
--
-- Idempotent on any prior run state. Safe to apply repeatedly.
-- ============================================================================

-- Step 1: Backfill deviceType from runtimeKind, only when that column exists.
DROP PROCEDURE IF EXISTS _321_backfill_deviceType;
DELIMITER //
CREATE PROCEDURE _321_backfill_deviceType()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'im_containers'
      AND column_name = 'runtimeKind'
  ) THEN
    UPDATE im_containers
    SET deviceType = runtimeKind
    WHERE deviceType = 'k8s'
      AND runtimeKind IS NOT NULL
      AND runtimeKind <> 'k8s';
  END IF;
END //
DELIMITER ;

CALL _321_backfill_deviceType();
DROP PROCEDURE _321_backfill_deviceType;

-- Step 2: Add the two indexes 317 was supposed to add but didn't reach.
-- Same idempotent pattern as 317's own _317_add_idx_if_missing — replayed
-- here so this migration stands alone without depending on 317's procedure
-- still being in scope.
DROP PROCEDURE IF EXISTS _321_add_idx_if_missing;
DELIMITER //
CREATE PROCEDURE _321_add_idx_if_missing(
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
END //
DELIMITER ;

CALL _321_add_idx_if_missing('im_containers', 'idx_im_containers_daemonId', '`daemonId`');
CALL _321_add_idx_if_missing('im_containers', 'idx_im_containers_deviceType', '`deviceType`');

DROP PROCEDURE _321_add_idx_if_missing;
