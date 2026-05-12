-- ============================================================================
-- Migration 317: v1.9.6 — IMContainer device-semantic fields (Stage 1)
-- Date: 2026-05-11
-- Track: §26 B5 controller-removal pivot, data layer phase 1
--
-- Background
-- ----------
-- §26 reframes the "1 K8s pod = 1 agent" predesign to "1 device = 1 daemon
-- = N agents". User clarification: K8s sandbox is just one backend; same
-- abstraction as local Mac daemon. Number of devices and agents per device
-- are user choices.
--
-- This is Stage 1 of a multi-release migration:
--   • Stage 1 (this migration): ADD device_type + daemon_id columns; no drops
--   • Stage 2 (future release):  code reads/writes the new fields, agent
--                                 reuse switches to daemonId lookup
--   • Stage 3 (future release):  DROP agent_im_user_id (now obsolete)
--   • Stage 4 (future, optional): RENAME im_containers → im_devices
--
-- Stage 1 is purely additive — existing reads/writes of `agent_im_user_id`,
-- `pod_name`, `runtime_kind` continue to work. Old rows get
-- `device_type=runtime_kind` (backwards-compatible inherit) and
-- `daemon_id=NULL` (filled in when next written by Stage 2 code).
--
-- Idempotent: information_schema guard on every ADD.
-- ============================================================================

-- ============================================================================
-- DEPLOY ORDER (advisory — not strictly required, but recommended)
-- ----------------------------------------------------------------------------
-- This migration is purely ADDITIVE (no DROP/RENAME). Existing cloud code that
-- writes `agent_im_user_id` / `pod_name` / `runtime_kind` continues to work
-- unchanged. New columns (`device_type`, `daemon_id`) default to safe values
-- (`'k8s'` / `NULL`) so pre-Stage-2 inserts populate them correctly.
--
-- → Safe to apply at any point relative to cloud deploy.
--
-- HOWEVER — recommended order:
--   1. Apply this migration FIRST (or alongside) the cloud release that ships
--      Stage 2 code (the code that writes `device_type` / `daemon_id`
--      explicitly). That way new rows written by the post-Stage-2 cloud get
--      the correct device_type immediately rather than relying on the default.
--   2. If you apply it BEFORE Stage 2 cloud ships: new rows still get
--      `device_type='k8s'` by default (matches today's reality — all sandboxes
--      are k8s). The backfill UPDATE at the bottom handles any historical
--      `runtime_kind='docker'` rows.
--   3. If you apply it AFTER Stage 2 cloud ships: rows written between Stage 2
--      deploy and migration apply will fail on `Unknown column 'device_type'`.
--      Avoid this — apply migration BEFORE Stage 2 cloud rollout.
--
-- Re-runnable: every ADD COLUMN / ADD INDEX is information_schema-guarded.
--
-- B5 Stage 2 (FUTURE release) — gated on this migration applied:
--   Stage 2 cloud code will read/write `device_type` + `daemon_id` and switch
--   agent reuse to daemonId lookup. Stage 3 (later) will DROP
--   `agent_im_user_id` (now obsolete). Do not ship Stage 2 cloud before this
--   migration is applied to the target DB.
-- ============================================================================

DROP PROCEDURE IF EXISTS _317_add_col_if_missing;
DELIMITER //
CREATE PROCEDURE _317_add_col_if_missing(
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
END //
DELIMITER ;

-- deviceType: 'local' | 'k8s' | 'docker-host' | (future)
-- Default 'k8s' for new rows. For existing rows, backfilled from runtimeKind
-- below (which already carries 'docker' / 'k8s' since Wave-8 W11).
-- Column naming: camelCase to match the rest of im_containers (runtimeKind,
-- agentImUserId, taskId, podName, ...) and Prisma's default field-name
-- convention. Prior draft used snake_case which collides with Prisma queries.
CALL _317_add_col_if_missing(
  'im_containers',
  'deviceType',
  'VARCHAR(16) NOT NULL DEFAULT ''k8s'''
);

-- daemonId: unique per device (1 device = 1 daemon). Nullable in Stage 1
-- so old rows don't fail backfill. Stage 2 code will populate on every
-- write; Stage 3 can flip to NOT NULL once all in-flight rows have it.
CALL _317_add_col_if_missing(
  'im_containers',
  'daemonId',
  'VARCHAR(64) NULL'
);

-- Backfill deviceType from runtimeKind for existing rows. Both columns
-- exist after this migration runs; runtimeKind stays as-is for backwards
-- compat with the 16 cloud callsites that still read it.
UPDATE im_containers
SET deviceType = runtimeKind
WHERE deviceType = 'k8s' AND runtimeKind IS NOT NULL AND runtimeKind <> 'k8s';

-- Index on daemon_id for the Stage 2 lookup path
-- (`SELECT ... FROM im_containers WHERE daemon_id = ?`).
DROP PROCEDURE IF EXISTS _317_add_idx_if_missing;
DELIMITER //
CREATE PROCEDURE _317_add_idx_if_missing(
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

CALL _317_add_idx_if_missing('im_containers', 'idx_im_containers_daemon_id', '`daemonId`');
CALL _317_add_idx_if_missing('im_containers', 'idx_im_containers_device_type', '`deviceType`');

DROP PROCEDURE _317_add_col_if_missing;
DROP PROCEDURE _317_add_idx_if_missing;
