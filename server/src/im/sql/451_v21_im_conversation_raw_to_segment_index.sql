-- ============================================================================
-- Migration 451: v2.1 Conversational Memory Phase 1 — im_conversation_raw_to_segment_index
-- Date: 2026-05-29
-- Spec: docs/release201/26-conversational-memory-plan.md §4 (新表 2/5)
--
-- What
-- ----
-- Reverse index raw messageId → owning compressed segment. Lets the renderer
-- resolve a quote (which always points at a raw messageId, decision §3 C) to
-- the segment that now covers it once the raw msg has been compacted out of
-- the recent window.
--
-- Signature chain
-- ---------------
-- DERIVED data. Not signed, does not touch any im_messages row.
--
-- Idempotency
-- -----------
-- CREATE TABLE IF NOT EXISTS; safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_conversation_raw_to_segment_index (
  id           VARCHAR(30) PRIMARY KEY,
  rawMessageId VARCHAR(30) NOT NULL,
  segmentId    VARCHAR(30) NOT NULL,
  segmentKind  VARCHAR(20) NOT NULL DEFAULT 'range',
  createdAt    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_im_conv_raw_to_seg_raw (rawMessageId),
  INDEX idx_im_conv_raw_to_seg_seg (segmentId)
);

-- Tracking handled by scripts/db-migrate.sh; no manual _migrations INSERT.
