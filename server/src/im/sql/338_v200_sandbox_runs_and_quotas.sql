-- ============================================================================
-- Migration 338: v2.0 — Sandbox runs + per-workspace quotas
--
-- Per docs/release200/08-execution-environment-design.md §6.1:
--   (a) im_sandbox_runs — unified billing + audit record covering both
--       ephemeral and persistent executions. Replaces (does not drop) the
--       legacy IMSandboxRunLog table; ephemeral runs have containerId = NULL
--       since no pod is provisioned. Indexed for workspace billing rollups,
--       task lookups, provider/kind dashboards, and error-rate analytics.
--   (b) im_sandbox_quotas — per-workspace concurrency + monthly caps.
--       Defaults are intentionally loose (10 concurrent / 1000 pod-hours /
--       10000 ephemeral runs) so v200 rollout cannot generate 503 false
--       positives (§11 risk register). No FK on workspaceId — the workspace
--       table's PK convention varies across migrations and we avoid a
--       cascading constraint failure on fresh inits.
-- ============================================================================

-- (a) im_sandbox_runs — billable + auditable run records
CREATE TABLE IF NOT EXISTS im_sandbox_runs (
  id                VARCHAR(30) NOT NULL PRIMARY KEY,
  containerId       VARCHAR(30) NULL,
  providerKind      VARCHAR(64) NOT NULL,
  executionKind     ENUM('ephemeral', 'persistent') NOT NULL,
  workspaceId       VARCHAR(30) NOT NULL,
  tenantId          VARCHAR(64) NULL,
  taskId            VARCHAR(30) NULL,
  startedAt         DATETIME(3) NOT NULL,
  endedAt           DATETIME(3) NULL,
  durationMs        INT NULL,
  exitCode          INT NULL,
  exitReason        VARCHAR(255) NULL,
  cpuSeconds        FLOAT NULL,
  memoryGbHours     FLOAT NULL,
  billedAmountCents INT NULL,
  createdAt         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_im_sandbox_runs_container
    FOREIGN KEY (containerId) REFERENCES im_containers(id)
    ON DELETE SET NULL,
  KEY idx_im_sandbox_runs_ws_started (workspaceId, startedAt),
  KEY idx_im_sandbox_runs_task (taskId),
  KEY idx_im_sandbox_runs_provider_kind (providerKind, executionKind),
  KEY idx_im_sandbox_runs_exit (exitCode, startedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- (b) im_sandbox_quotas — per-workspace concurrency + monthly caps
CREATE TABLE IF NOT EXISTS im_sandbox_quotas (
  workspaceId             VARCHAR(30) NOT NULL PRIMARY KEY,
  maxConcurrentRuns       INT NOT NULL DEFAULT 10,
  maxMonthlyPodHours      INT NOT NULL DEFAULT 1000,
  maxMonthlyEphemeralRuns INT NOT NULL DEFAULT 10000,
  currentPodHours         FLOAT NOT NULL DEFAULT 0,
  currentEphemeralRuns    INT NOT NULL DEFAULT 0,
  rollingWindowStartedAt  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt               DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'migration 338 v200 sandbox runs and quotas complete' AS status;
