-- ============================================================================
-- Migration 300: v1.10.0 Cloud-3 Sandbox tables (S2)
-- Date: 2026-05-03
-- See docs/54release/07-cloud-sandbox.md §5.1 for schema rationale.
--
-- Adds 3 tables: im_containers, im_container_snapshots, im_sandbox_run_logs.
-- All ADD-only; no DROP / RENAME of existing v1.9.x state.
--
-- Idempotent: each CREATE TABLE is wrapped in an INFORMATION_SCHEMA guard
-- procedure (matches the pattern from migrations 029-037 and 130). Re-running
-- on a DB that already has these tables is a no-op.
--
-- Note: `trigger` is a MySQL reserved word (CREATE TRIGGER), but is permitted
-- as a column identifier without backticks in CREATE TABLE. We still quote it
-- with backticks defensively to keep the DDL portable across strict SQL modes.
-- No application-enforced foreign keys here — convention across im_* tables
-- is FK-free in MySQL (relations enforced at the application layer).
-- ============================================================================

DROP PROCEDURE IF EXISTS _300_create_table;
DELIMITER //
CREATE PROCEDURE _300_create_table(IN tbl VARCHAR(64), IN ddl TEXT)
BEGIN
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl) = 0 THEN
    SET @stmt := ddl;
    PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

-- im_containers ------------------------------------------------------------
CALL _300_create_table('im_containers', '
CREATE TABLE im_containers (
  id              VARCHAR(30)  NOT NULL,
  workspaceId     VARCHAR(30)  NOT NULL,
  tenantId        VARCHAR(30)  NOT NULL,
  agentImUserId   VARCHAR(30)  DEFAULT NULL,
  taskId          VARCHAR(30)  DEFAULT NULL,
  podName         VARCHAR(64)  NOT NULL,
  namespace       VARCHAR(64)  NOT NULL DEFAULT ''default'',
  image           VARCHAR(255) NOT NULL,
  imageTag        VARCHAR(64)  NOT NULL,
  status          VARCHAR(32)  NOT NULL,
  warmPoolHit     TINYINT(1)   NOT NULL DEFAULT 0,
  cpuRequest      VARCHAR(16)  NOT NULL,
  cpuLimit        VARCHAR(16)  NOT NULL,
  memoryRequest   VARCHAR(16)  NOT NULL,
  memoryLimit     VARCHAR(16)  NOT NULL,
  gatewayUrl      VARCHAR(255) DEFAULT NULL,
  startedAt       DATETIME(3)  DEFAULT NULL,
  stoppedAt       DATETIME(3)  DEFAULT NULL,
  createdAt       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_im_containers_pod (podName),
  KEY idx_im_containers_ws_status (workspaceId, status),
  KEY idx_im_containers_tenant (tenantId),
  KEY idx_im_containers_task (taskId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
');

-- im_container_snapshots ---------------------------------------------------
CALL _300_create_table('im_container_snapshots', '
CREATE TABLE im_container_snapshots (
  id           VARCHAR(30) NOT NULL,
  containerId  VARCHAR(30) NOT NULL,
  imageTag     VARCHAR(64) NOT NULL,
  imageDigest  VARCHAR(80) DEFAULT NULL,
  sizeBytes    BIGINT      DEFAULT NULL,
  createdBy    VARCHAR(30) NOT NULL,
  createdAt    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_im_container_snapshots_container_created (containerId, createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
');

-- im_sandbox_run_logs ------------------------------------------------------
CALL _300_create_table('im_sandbox_run_logs', '
CREATE TABLE im_sandbox_run_logs (
  id             VARCHAR(30)  NOT NULL,
  containerId    VARCHAR(30)  NOT NULL,
  workspaceId    VARCHAR(30)  NOT NULL,
  tenantId       VARCHAR(30)  NOT NULL,
  startedAt      DATETIME(3)  NOT NULL,
  endedAt        DATETIME(3)  DEFAULT NULL,
  durationMs     INT          DEFAULT NULL,
  cpuSeconds     DOUBLE       DEFAULT NULL,
  memoryGbHours  DOUBLE       DEFAULT NULL,
  `trigger`      VARCHAR(32)  NOT NULL,
  taskId         VARCHAR(30)  DEFAULT NULL,
  exitReason     VARCHAR(32)  DEFAULT NULL,
  exitCode       INT          DEFAULT NULL,
  createdAt      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_im_sandbox_run_logs_tenant_started (tenantId, startedAt),
  KEY idx_im_sandbox_run_logs_ws_started (workspaceId, startedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
');

DROP PROCEDURE _300_create_table;
