-- TODO-1 (2026-05-25) — index on im_sync_events.createdAt to make the
-- daily cleanup cron (sync-event-cleanup.service.ts) O(deleted rows)
-- instead of clustered-PK scan. Without this, a 5M-row table takes
-- minutes to find the 100k-row 30-day cutoff window.
--
-- Safe to run online: MySQL 8 supports CREATE INDEX with ALGORITHM=INPLACE
-- + LOCK=NONE for non-FK indexes on InnoDB; concurrent writes proceed.
CREATE INDEX idx_sync_events_created_at
  ON im_sync_events (createdAt)
  ALGORITHM=INPLACE
  LOCK=NONE;
