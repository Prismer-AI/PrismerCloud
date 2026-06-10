-- ============================================================================
-- Migration 440: v2.0.7 — im_metric_events table + 3 indexes
-- Date: 2026-05-26
-- Spec: docs/release201/11-task-and-project-metrics.md §2.1 + §11 Phase 1
--
-- Why this migration exists
-- -------------------------
-- v2.0.7 release201/11 introduces a unified metric data channel that sits
-- alongside (not replacing) the existing per-domain audit tables
-- (im_task_events / im_memory_observability_events / im_task_logs).
--
-- The three existing event tables each have different schemas and mix
-- audit-log semantics with telemetry. Aggregating cross-domain metrics
-- (e.g. "weekly task velocity by capability") required ad-hoc joins.
--
-- This migration adds a single append-only metric event table that any
-- service (cloud or daemon) can emit into. namespace/name discriminates
-- metrics; dims_json carries free-form dimensions. Three indexes cover
-- the three primary read patterns: namespace+name+ts (top-level filter),
-- workspaceId+ts (per-workspace slice), source+receivedAt (daemon ingest
-- audit).
--
-- Retention: 90 days, enforced by daily cron (Phase 4); no partitioning
-- in v2.0.7. Expected upper bound ~11M rows steady-state.
-- ============================================================================

-- workspaceId is stored as a real column (not a generated/functional index on
-- dims_json) for two reasons:
--   1. Prisma 6 has no first-class GENERATED ALWAYS support; raw-SQL access
--      is fine for ingest but inserts via the client need to set the column.
--   2. A real B-tree column index outperforms a JSON functional index for
--      the high-volume workspace slice query (release201/11 §0.2.2: 10M-row
--      count under 500ms). MetricService writes workspaceId from
--      dims.workspaceId; the dim is also kept inside dims_json so the
--      single source of truth (the JSON dim bag) is preserved.

CREATE TABLE IF NOT EXISTS im_metric_events (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  namespace     VARCHAR(64)  NOT NULL,
  name          VARCHAR(64)  NOT NULL,
  ts            DATETIME(3)  NOT NULL,
  value_numeric DOUBLE       NULL,
  value_string  VARCHAR(256) NULL,
  dims_json     TEXT         NULL,
  source        VARCHAR(32)  NOT NULL,
  source_id     VARCHAR(64)  NULL,
  emitted_at    DATETIME(3)  NOT NULL,
  received_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  workspace_id  VARCHAR(30)  NULL,
  PRIMARY KEY (id),
  INDEX idx_ns_name_ts (namespace, name, ts),
  INDEX idx_ws_ts      (workspace_id, namespace, name, ts),
  INDEX idx_source     (source, source_id, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT
  'migration 440 im_metric_events complete' AS status,
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name='im_metric_events'
      AND index_name IN ('idx_ns_name_ts','idx_ws_ts','idx_source')) AS indexes_created;
