-- ============================================================================
-- Migration 336: v2.0 — Sandbox container health + provider kind
--
-- Per docs/release200/08-execution-environment-design.md §6.1 + §5.4:
--   - Adds `providerKind` column to im_containers as the convergence field
--     replacing the dual `runtimeKind` + `deviceType` lineage. Old columns
--     are retained for ~3 months of dual-write (v210 will drop them); this
--     migration only adds — never removes.
--   - Adds `daemonHealthMisses` + `lastDaemonHealthAt` so the reconciler
--     loop can track consecutive /healthz misses and drive the
--     running → degraded → errored FSM transitions defined in §6.2.
--   - Adds a composite (`providerKind`, `status`) index for admin
--     analytics group-by queries (§7.1 /admin/analytics).
--
-- Note: the `status` column ENUM conversion is OUT OF SCOPE here. Migration
-- 333 already declared the ENUM target in its body (it ran on most envs);
-- if any env still has VARCHAR, a separate follow-up migration will handle
-- the conversion. This migration is purely additive.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _336_add_col_if_missing$$
CREATE PROCEDURE _336_add_col_if_missing(
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

DROP PROCEDURE IF EXISTS _336_add_idx_if_missing$$
CREATE PROCEDURE _336_add_idx_if_missing(
  IN p_table VARCHAR(64),
  IN p_idx VARCHAR(64),
  IN p_cols TEXT
)
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = p_table
  ) AND NOT EXISTS (
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

-- §6.1 provider abstraction collapse field. Defaults to 'k8s' to match the
-- existing deviceType default; backfill from runtimeKind/deviceType is handled
-- in application code (write path) during the dual-write window.
CALL _336_add_col_if_missing(
  'im_containers',
  'providerKind',
  'VARCHAR(64) NOT NULL DEFAULT ''k8s'' AFTER `deviceType`'
);

-- §5.4 daemon handshake reconciler: consecutive /healthz miss counter.
CALL _336_add_col_if_missing(
  'im_containers',
  'daemonHealthMisses',
  'INT NOT NULL DEFAULT 0'
);

-- §5.4 last successful daemon /healthz timestamp (NULL until first success).
CALL _336_add_col_if_missing(
  'im_containers',
  'lastDaemonHealthAt',
  'DATETIME(3) NULL'
);

-- §7.1 admin analytics group-by: containers grouped by providerKind + status.
CALL _336_add_idx_if_missing(
  'im_containers',
  'idx_im_containers_provider_kind',
  '`providerKind`, `status`'
);

DROP PROCEDURE IF EXISTS _336_add_col_if_missing;
DROP PROCEDURE IF EXISTS _336_add_idx_if_missing;

SELECT 'migration 336 v200 sandbox container health complete' AS status;
