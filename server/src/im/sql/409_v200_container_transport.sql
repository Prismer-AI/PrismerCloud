-- ============================================================================
-- Migration 409: v2.0 — IMContainer transport diagnostics (transport + privacy)
-- Date: 2026-05-21
-- Spec: docs/release200/14-messaging-state-machine-reliability.md §4.8
--       (Track-G external-channel webhook reverse-channel + reachability)
--
-- Background
-- ----------
-- §4.8: external-channel webhook dispatch (agent-dispatcher.ts:340) currently
-- defaults to HTTP `${container.gatewayUrl}/dispatch`, which fails for daemons
-- on private NAT. v2.0 inverts: prefer WS reverse channel (already in use for
-- task dispatch), HTTP only as fallback for same-network dev. To pick a
-- recommended transport per daemon, we persist what the daemon's own
-- transport-probe reported at startup.
--
-- Schema deltas
-- -------------
-- ALTER im_containers:
--   transport         — daemon-reported best transport ('ws' | 'http' | 'both')
--   gatewayIsPrivate  — whether gatewayUrl resolves to RFC1918 / link-local
--                       (cloud → daemon HTTP only viable when false)
--   lastProbeAt       — last successful transport-probe timestamp
--
-- §4.8 diagnose endpoint reads these columns to return recommendedTransport.
--
-- Idempotent
-- ----------
-- Column add guarded by information_schema.
-- ============================================================================

DROP PROCEDURE IF EXISTS pc_v200_alter_container_transport;
DELIMITER //
CREATE PROCEDURE pc_v200_alter_container_transport()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_containers' AND column_name = 'transport'
  ) THEN
    ALTER TABLE im_containers ADD COLUMN transport VARCHAR(10) NULL AFTER gatewayUrl;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_containers' AND column_name = 'gatewayIsPrivate'
  ) THEN
    ALTER TABLE im_containers ADD COLUMN gatewayIsPrivate TINYINT(1) NULL AFTER transport;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_containers' AND column_name = 'lastProbeAt'
  ) THEN
    ALTER TABLE im_containers ADD COLUMN lastProbeAt DATETIME(3) NULL AFTER gatewayIsPrivate;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_containers' AND index_name = 'im_containers_transport_idx'
  ) THEN
    CREATE INDEX im_containers_transport_idx ON im_containers (transport, lastProbeAt);
  END IF;
END//
DELIMITER ;
CALL pc_v200_alter_container_transport();
DROP PROCEDURE pc_v200_alter_container_transport;

SELECT
  'migration 409 v200 container transport complete' AS status,
  (SELECT COUNT(*) FROM im_containers) AS total_containers,
  (SELECT COUNT(*) FROM im_containers WHERE transport IS NOT NULL) AS containers_with_transport;
