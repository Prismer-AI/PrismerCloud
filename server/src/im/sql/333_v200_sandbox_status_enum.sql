-- ============================================================================
-- Migration 333: v2.0 — SandboxStatus enum
--
-- Normalizes historical container status strings and constrains the column to
-- the seven v2.0 states: pending, provisioning, running, degraded, stopping,
-- stopped, errored.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _333_normalize_and_enum_status$$
CREATE PROCEDURE _333_normalize_and_enum_status()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'im_containers'
  ) THEN
    UPDATE `im_containers`
    SET `status` = CASE
      WHEN `status` IN ('pending', 'requested', 'created', 'bound') THEN 'pending'
      WHEN `status` IN ('provisioning', 'creating') THEN 'provisioning'
      WHEN `status` IN ('running', 'active') THEN 'running'
      WHEN `status` IN ('degraded') THEN 'degraded'
      WHEN `status` IN ('stopping', 'failing') THEN 'stopping'
      WHEN `status` IN ('stopped', 'completed', 'removed', 'deleted') THEN 'stopped'
      WHEN `status` IN ('errored', 'error', 'failed', 'timeout') THEN 'errored'
      ELSE 'errored'
    END
    WHERE `status` NOT IN ('pending', 'provisioning', 'running', 'degraded', 'stopping', 'stopped', 'errored')
       OR `status` IS NULL;

    ALTER TABLE `im_containers`
      MODIFY COLUMN `status` ENUM(
        'pending',
        'provisioning',
        'running',
        'degraded',
        'stopping',
        'stopped',
        'errored'
      ) NOT NULL DEFAULT 'pending';
  END IF;
END$$

DELIMITER ;

CALL _333_normalize_and_enum_status();

DROP PROCEDURE IF EXISTS _333_normalize_and_enum_status;

SELECT 'migration 333 v200 sandbox status enum complete' AS status;
