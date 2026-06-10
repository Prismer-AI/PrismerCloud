-- ============================================================================
-- Migration 401: v2.0 — IMSyncEvent boundary seq + publishedAt + per-conv counter
-- Date: 2026-05-21
-- Spec: docs/release200/14-messaging-state-machine-reliability.md §4.1 (rev.2)
--
-- Background
-- ----------
-- IMSyncEvent (schema:538) is already a persistent event stream and is the
-- canonical sync log. Two gaps prevent the front-end from gap-detecting
-- per-conversation events:
--   (a) `id` is a global auto_increment — not monotonic per conversation, so
--       the client cannot judge "did I miss seq=N+1 for THIS conversation".
--   (b) DB write + Redis publish is fire-and-forget — publish failure is lost.
--
-- Schema deltas
-- -------------
-- ALTER im_sync_events: add boundarySeq (per-conversation monotonic), publishedAt
-- (publisher worker stamp), publishRetries (retry counter).
--
-- Add im_conversation_seq counter table for LAST_INSERT_ID atomic allocation
-- (see §4.1 rev.2: INSERT path must use `LAST_INSERT_ID(1)` explicitly, NOT
-- `VALUES (?, 1)` — the latter does not populate the session slot).
--
-- Idempotent
-- ----------
-- Columns guarded by information_schema check; counter table uses IF NOT EXISTS.
-- ============================================================================

-- ─── Step A: ALTER im_sync_events ───────────────────────────────────────
DROP PROCEDURE IF EXISTS pc_v200_alter_sync_events;
DELIMITER //
CREATE PROCEDURE pc_v200_alter_sync_events()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_sync_events' AND column_name = 'boundarySeq'
  ) THEN
    ALTER TABLE im_sync_events ADD COLUMN boundarySeq BIGINT NULL AFTER conversationId;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_sync_events' AND column_name = 'publishedAt'
  ) THEN
    ALTER TABLE im_sync_events ADD COLUMN publishedAt DATETIME(3) NULL AFTER createdAt;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_sync_events' AND column_name = 'publishRetries'
  ) THEN
    ALTER TABLE im_sync_events ADD COLUMN publishRetries INT NOT NULL DEFAULT 0 AFTER publishedAt;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_sync_events' AND index_name = 'conv_boundary_idx'
  ) THEN
    CREATE INDEX conv_boundary_idx ON im_sync_events (conversationId, boundarySeq);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_sync_events' AND index_name = 'publish_pending_idx'
  ) THEN
    CREATE INDEX publish_pending_idx ON im_sync_events (publishedAt, id);
  END IF;
END//
DELIMITER ;
CALL pc_v200_alter_sync_events();
DROP PROCEDURE pc_v200_alter_sync_events;

-- ─── Step B: im_conversation_seq counter table ──────────────────────────
-- Per-conversation monotonic seq via MySQL LAST_INSERT_ID atomic mode.
-- Usage (must be inside `prisma.$transaction` — see §4.1 Critical Invariant):
--
--   INSERT INTO im_conversation_seq (conversationId, seq) VALUES (?, LAST_INSERT_ID(1))
--   ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1);
--   SELECT LAST_INSERT_ID() AS new_seq;
--
-- INSERT path MUST use LAST_INSERT_ID(1) (not literal 1) to populate the
-- session slot — otherwise first call returns 0. Verified by exp-seq2.ts.
CREATE TABLE IF NOT EXISTS im_conversation_seq (
  conversationId VARCHAR(30) NOT NULL,
  seq            BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (conversationId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Step C: report ──────────────────────────────────────────────────────
SELECT
  'migration 401 v200 sync_event boundary_seq complete' AS status,
  (SELECT COUNT(*) FROM im_sync_events) AS total_sync_events,
  (SELECT COUNT(*) FROM im_conversation_seq) AS seq_counter_rows;
