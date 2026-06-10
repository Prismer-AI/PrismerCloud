-- ============================================================================
-- Migration 337: v2.0 — Sandbox resource samples (reconciler time-series)
--
-- Per docs/release200/08-execution-environment-design.md §6.1 + §5.4:
--   The reconciler loop samples per-container CPU%, memory, and daemon RTT
--   every ~30s. Rows are retained for 7 days then trimmed by a maintenance
--   job (out of scope here). Powers /admin/analytics charts (§7.1) and the
--   degraded-state diagnostics surfaced in /admin/sandbox-metrics (§7.2).
--
-- Indexes:
--   - (containerId, sampledAt) for per-container time-series scans
--   - (sampledAt) for the 7-day retention sweep
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_sandbox_resource_samples (
  id            VARCHAR(30) NOT NULL PRIMARY KEY,
  containerId   VARCHAR(30) NOT NULL,
  sampledAt     DATETIME(3) NOT NULL,
  cpuUsagePct   FLOAT NOT NULL,
  memUsedBytes  BIGINT NOT NULL,
  memLimitBytes BIGINT NOT NULL,
  daemonRttMs   INT NOT NULL,
  createdAt     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_im_sandbox_resource_samples_container
    FOREIGN KEY (containerId) REFERENCES im_containers(id)
    ON DELETE CASCADE,
  KEY idx_im_sandbox_resource_samples_container (containerId, sampledAt),
  KEY idx_im_sandbox_resource_samples_recent (sampledAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'migration 337 v200 sandbox resource samples complete' AS status;
