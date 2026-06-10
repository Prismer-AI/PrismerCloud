-- ============================================================================
-- Migration 417: v2.0 — Streaming partial render persistence (im_message_partials)
-- Date: 2026-05-22
-- Spec: docs/release200/14-messaging-state-machine-reliability.md §4.4.7
--
-- Background
-- ----------
-- §4.4.7 streaming partial render: stream.service flushes a partial chunk to
-- SSE every ~200ms while the agent is generating; UI shows a live-typing
-- placeholder. Without persistence, a browser F5 in the middle of a stream
-- loses the half-written text. We persist each emitted chunk to this table so
-- the front-end hydration endpoint (`GET /messages/:cid/:mid/partials?afterSeq=N`)
-- can replay the partial buffer on reload.
--
-- Lifecycle
-- ---------
-- Row written every flush tick (~200ms granularity).
-- Final `message.created` event arrives via outbox publisher (Wave 2-B1).
-- Partial rows live 24h (scheduler.sweepMessagePartials cron), then reaped.
-- 24h matches the "user closes laptop overnight" reload window.
--
-- Why a dedicated table (not outbox)
-- ----------------------------------
-- Partial chunks are sub-message granularity (10-1000x more rows than
-- im_sync_events). Putting them in the outbox would force the publisher
-- worker to churn through partials at 50ms cadence and inflate the
-- conversation seq counter past the message-level invariant. Direct
-- Redis publish + dedicated persistence table keeps the outbox semantics
-- intact.
--
-- Schema
-- ------
-- (id PK, messageId, chunkText, chunkSeq, createdAt)
-- chunkSeq is per-message monotonic (allocated by stream.service in-memory;
-- the partial buffer is the source of truth — DB is only for F5 hydration).
--
-- Idempotent
-- ----------
-- CREATE TABLE IF NOT EXISTS.
-- ============================================================================

-- id / messageId widened to VARCHAR(60) so a `msg-stream-<uuid>` (47 chars)
-- stream-allocated id (and the row's own uuid id) fits comfortably above
-- the 30/40-char cuid widths used elsewhere.
CREATE TABLE IF NOT EXISTS im_message_partials (
  id          VARCHAR(60)  NOT NULL,
  messageId   VARCHAR(60)  NOT NULL,
  chunkText   MEDIUMTEXT   NOT NULL,
  chunkSeq    INT          NOT NULL,
  createdAt   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY msg_seq_idx (messageId, chunkSeq),
  KEY created_idx (createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT
  'migration 417 v200 message_partials complete' AS status,
  (SELECT COUNT(*) FROM im_message_partials) AS total_partials;
