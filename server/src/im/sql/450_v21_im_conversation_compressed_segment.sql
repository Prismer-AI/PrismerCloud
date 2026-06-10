-- ============================================================================
-- Migration 450: v2.1 Conversational Memory Phase 1 — im_conversation_compressed_segments
-- Date: 2026-05-29
-- Spec: docs/release201/26-conversational-memory-plan.md §4 (新表 1/5) + §3 A/B
--
-- What
-- ----
-- L2 "Compressed Session" — Range segment over the L1 raw ledger (im_messages).
-- Phase 1 emits ONLY segmentKind='range' (decision §3 A; Topic/Decision/Entity
-- kinds are future, data-driven). Conversation-scoped (decision §3 B): summary
-- introduces no new visibility beyond the raw msgs it covers.
--
-- Signature chain
-- ---------------
-- DERIVED data. Not signed, does not touch any im_messages row (§4 "签名链影响").
--
-- Concurrency
-- -----------
-- UNIQUE(conversationId, segmentKind, segmentSeq) guards concurrent compaction;
-- Phase 2 producer uses INSERT ... ON DUPLICATE KEY (INSERT OR IGNORE semantics),
-- second worker no-ops (§8 Phase 2 / §10).
--
-- embeddingRef
-- ------------
-- Reserved column for the §12 future embedding index; Phase 1 uses substring +
-- alias only. NULL until then.
--
-- Idempotency
-- -----------
-- CREATE TABLE IF NOT EXISTS; safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_conversation_compressed_segments (
  id                       VARCHAR(30)  PRIMARY KEY,
  conversationId           VARCHAR(30)  NOT NULL,
  segmentKind              VARCHAR(20)  NOT NULL DEFAULT 'range',  -- Phase 1: 'range' only
  segmentSeq               INT          NOT NULL,
  coversFromMessageId      VARCHAR(30)  NOT NULL,
  coversToMessageId        VARCHAR(30)  NOT NULL,
  coveredRawMessageIdsJson TEXT         NOT NULL,                  -- JSON: string[]
  coversFromCreatedAt      DATETIME(3)  NOT NULL,
  coversToCreatedAt        DATETIME(3)  NOT NULL,
  summary                  TEXT         NOT NULL,
  salientFactsJson         TEXT         NOT NULL,                  -- JSON: metric-only counts (§5.1)
  tokenCountCl100k         INT          NOT NULL DEFAULT 0,
  producerModel            VARCHAR(100) NOT NULL,
  producerVersion          VARCHAR(100) NOT NULL,
  supersededBy             VARCHAR(30)  NULL,                      -- segment id that replaced this (regenerate)
  embeddingRef             VARCHAR(255) NULL,                      -- §12 forward-ref; NULL in Phase 1
  createdAt                DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt                DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY im_conv_compressed_seg_uk (conversationId, segmentKind, segmentSeq),
  INDEX idx_im_conv_compressed_seg_conv (conversationId)
);

-- Tracking handled by scripts/db-migrate.sh; no manual _migrations INSERT.
