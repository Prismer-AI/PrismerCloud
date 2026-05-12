-- 318_v54_ingest_claims.sql — Wave-54 B7
--
-- Multi-daemon coordination for asset parse / ingest work. A claim is
-- "daemon D on device X is parsing asset A at ingestVersion V". Other
-- daemons see the claim and skip their copy of the same work.
--
-- Lifecycle:
--   active     : owner is heartbeating; heartbeatAt within TTL.
--   completed  : owner reported parse success; no further work needed.
--   abandoned  : heartbeat went stale; another daemon may take over by
--                refreshing the same row (claimantImUserId/device overwritten).
--
-- Uniqueness on (workspaceId, assetId, ingestVersion) means exactly one
-- claim row exists per ingestVersion of the asset. Takeover reuses the
-- row in place; we never accumulate stale rows. Completed rows are
-- preserved as a tombstone so re-acquire returns 409 with the verdict.
--
-- See docs/54release/26-asset-multi-tier-sync.md (two-daemons-same-claim
-- acceptance test — exactly one daemon takes over a stale row).

SET @table_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'im_ingest_claims'
);

SET @stmt := IF(
  @table_exists = 0,
  '
    CREATE TABLE im_ingest_claims (
      id                 VARCHAR(30) NOT NULL,
      workspaceId        VARCHAR(30) NOT NULL,
      assetId            VARCHAR(30) NOT NULL,
      ingestVersion      INT         NOT NULL,
      claimantImUserId   VARCHAR(30) NOT NULL,
      claimantDeviceId   VARCHAR(120) NOT NULL,
      status             VARCHAR(20) NOT NULL DEFAULT ''active'',
      claimedAt          DATETIME(3) NOT NULL,
      heartbeatAt        DATETIME(3) NOT NULL,
      completedAt        DATETIME(3) NULL,
      createdAt          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_ingest_claim_target (workspaceId, assetId, ingestVersion),
      KEY idx_ingest_claim_heartbeat (status, heartbeatAt),
      KEY idx_ingest_claim_claimant (claimantImUserId, claimantDeviceId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  ',
  'SELECT 1'
);

PREPARE s FROM @stmt;
EXECUTE s;
DEALLOCATE PREPARE s;
