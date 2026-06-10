-- ============================================================================
-- Migration 404: v2.0 — Dispatch reply two-phase prepare/commit + idempotency
-- Date: 2026-05-21
-- Spec: docs/release200/14-messaging-state-machine-reliability.md §4.3
--
-- Background
-- ----------
-- Current /dispatch/reply is single-step HTTP — a daemon crash between
-- asset upload and reply leaves orphaned assets, and reply re-sends cause
-- last-write-win drift. §4.3 introduces a two-phase protocol:
--   prepare: daemon uploads assets + posts metadata → cloud writes a
--            dispatch_replies row with status='prepared'; no message yet.
--   commit:  daemon posts replyId → cloud writes message + updates task
--            + outbox event in one transaction; status='committed'.
--
-- Idempotency
-- -----------
-- (taskId, idempotencyKey) UNIQUE — duplicate POST returns existing reply.
-- Re-commit on already-committed row is a no-op.
--
-- Schema deltas
-- -------------
-- New table im_dispatch_replies; no ALTERs.
--
-- Idempotent
-- ----------
-- CREATE TABLE IF NOT EXISTS.
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_dispatch_replies (
  id                  VARCHAR(40)  NOT NULL,
  taskId              VARCHAR(40)  NOT NULL,
  idempotencyKey      VARCHAR(64)  NOT NULL,
  status              VARCHAR(20)  NOT NULL,  -- 'prepared' | 'committed' | 'aborted'
  assetIdsJson        JSON         NOT NULL,
  messageContentJson  JSON         NULL,
  metricsJson         JSON         NULL,
  preparedAt          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  committedAt         DATETIME(3)  NULL,
  abortedAt           DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_task_idem (taskId, idempotencyKey),
  KEY idx_status_prepared_at (status, preparedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT
  'migration 404 v200 dispatch_two_phase complete' AS status,
  (SELECT COUNT(*) FROM im_dispatch_replies) AS total_dispatch_replies;
