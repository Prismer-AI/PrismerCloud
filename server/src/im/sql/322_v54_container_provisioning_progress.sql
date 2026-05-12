-- ============================================================================
-- Migration 322: v5.4 — IMContainer provisioning progress signals
-- Date: 2026-05-11
-- Track: provisioning-progress feature (workspace UI + admin/sandbox console)
--
-- Background
-- ----------
-- Post-§26 the sandbox provisioning flow runs cloud-side (cloud → K8s API
-- direct, no controller). The 7-step lifecycle:
--   container_create → container_running → daemon_healthy
--   → ws_connected → host_declared → adapter_installed → hermes_ready
-- has no externally-visible progress signal — UI shows "creating…" then
-- "ready" with nothing in between, even though it takes 2-3 seconds.
--
-- This migration adds:
--   provisioningStep    — current step name (null when terminal or not started)
--   provisioningHistory — JSON array of {step, status, startedAt, durationMs, error?}
--
-- Both columns are additive + nullable. Rows existing before this migration
-- get NULL on both; new rows fill them as the cloud-side step emitter runs.
-- Frontend tolerates NULL (renders nothing / "no progress data").
--
-- Idempotent: information_schema-guarded ADD COLUMN.
-- ============================================================================

DROP PROCEDURE IF EXISTS _322_add_col_if_missing;
DELIMITER //
CREATE PROCEDURE _322_add_col_if_missing(
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

-- Current step name; NULL means "no provisioning in flight" (either pre-start
-- or already reached terminal state, see provisioningHistory.status).
CALL _322_add_col_if_missing(
  'im_containers',
  'provisioningStep',
  'VARCHAR(32) NULL'
);

-- Full step history as JSON array. Each entry:
--   { step: string, status: 'in_progress'|'ok'|'error', startedAt: number,
--     durationMs?: number, error?: string }
-- Cloud-side step emitter appends one entry per transition; terminal step's
-- status flips from 'in_progress' → 'ok'/'error' on completion.
CALL _322_add_col_if_missing(
  'im_containers',
  'provisioningHistory',
  'JSON NULL'
);

-- Index on provisioningStep for the admin "in-flight" query:
--   SELECT ... FROM im_containers WHERE provisioningStep IS NOT NULL
DROP PROCEDURE IF EXISTS _322_add_idx_if_missing;
DELIMITER //
CREATE PROCEDURE _322_add_idx_if_missing(
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

CALL _322_add_idx_if_missing('im_containers', 'idx_im_containers_provisioningStep', '`provisioningStep`');

DROP PROCEDURE _322_add_col_if_missing;
DROP PROCEDURE _322_add_idx_if_missing;
