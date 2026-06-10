-- ============================================================================
-- Migration 452: v2.1 Conversational Memory Phase 1 — im_conversation_quote_cache
-- Date: 2026-05-29
-- Spec: docs/release201/26-conversational-memory-plan.md §4 (新表 3/5) + §10
--
-- What
-- ----
-- Snapshot of a quoted message at quote time, so a quote still renders even if
-- the source raw message is later deleted (sourceDeletedAt marks that case,
-- rendered as "(source deleted at X)" per §10). Quote ref always points at a
-- raw messageId (decision §3 C). Written in the same transaction as
-- POST /messages from Phase 1 (always-on; dispatcher reads it only in Phase 3).
--
-- Signature chain
-- ---------------
-- DERIVED data. Not signed, does not touch any im_messages row.
--
-- Idempotency
-- -----------
-- CREATE TABLE IF NOT EXISTS; UNIQUE(quotingMessageId, quotedMessageId) makes
-- the same-tx write idempotent. Safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_conversation_quote_cache (
  id                VARCHAR(30)  PRIMARY KEY,
  quotingMessageId  VARCHAR(30)  NOT NULL,
  quotedMessageId   VARCHAR(30)  NOT NULL,
  snapshotContent   TEXT         NOT NULL,        -- frozen body; survives source deletion (§10)
  snapshotSender    VARCHAR(128) NOT NULL,
  snapshotCreatedAt DATETIME(3)  NOT NULL,
  sourceDeletedAt   DATETIME(3)  NULL,            -- set when the quoted raw msg is deleted
  conversationId    VARCHAR(30)  NOT NULL,
  createdAt         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY im_conv_quote_cache_uk (quotingMessageId, quotedMessageId),
  INDEX idx_im_conv_quote_cache_quoted (quotedMessageId),
  INDEX idx_im_conv_quote_cache_conv (conversationId)
);

-- Tracking handled by scripts/db-migrate.sh; no manual _migrations INSERT.
