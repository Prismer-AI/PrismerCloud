-- ============================================================================
-- Migration 316: v1.9.5 — Drop im_containers.warmPoolHit column
-- Date: 2026-05-11
-- Track: warm-pool removal sweep (W1-W5 code/chart/docs already landed)
--
-- Background
-- ----------
-- Warm pool was a luminpulse-era OpenClaw workaround for 30-40s gateway boot.
-- Daemon-first runtime starts in seconds, so warm pool is now resource waste
-- with no semantic role. W1 deleted the controller's k8sWarmPool.ts and
-- /internal/v1/warm-pool API. W2 stripped warmPoolHit field from cloud
-- routes/types/UI. The DB column itself (added in 300_v110_sandbox.sql) is
-- now dead — every row is warmPoolHit=false because cold-start is the only
-- path. Drop the column.
--
-- Idempotent: column drop guarded via information_schema.
-- Re-runnable safely; no row data lost since the column is already
-- functionally dead post-W1.
-- ============================================================================

-- ============================================================================
-- DEPLOY ORDER (mandatory)
-- ----------------------------------------------------------------------------
-- This migration drops a column that pre-W2 cloud code writes to.
-- Apply ONLY AFTER:
--   1. New cloud Docker image (post-commit 14735b72) is rolled out to ALL
--      pods in the target environment (test or prod). Verify via:
--        kubectl -n <ns> rollout status deploy/prismer-saas-next
--   2. Wait 5 minutes + tail cloud logs to confirm no pod is still writing
--      `warmPoolHit`:
--        kubectl -n <ns> logs deploy/prismer-saas-next --since=5m | grep warmPoolHit
--      Expected: no matches.
--   3. THEN apply this migration.
--
-- If applied BEFORE step 1+2, any cloud pod still on the pre-W2 image will
-- start throwing "Unknown column 'warmPoolHit' in 'field list'" 5xxs on
-- IMContainer.create(), surfacing as runtime-installations 500s.
-- ============================================================================

DROP PROCEDURE IF EXISTS _316_drop_col_if_present;
DELIMITER //
CREATE PROCEDURE _316_drop_col_if_present(
  IN p_table VARCHAR(64),
  IN p_col VARCHAR(64)
)
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND column_name = p_col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` DROP COLUMN `', p_col, '`');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL _316_drop_col_if_present('im_containers', 'warmPoolHit');

DROP PROCEDURE _316_drop_col_if_present;
