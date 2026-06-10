-- ============================================================================
-- Migration 453: v2.1 Conversational Memory Phase 1 — im_conversation_quote_backrefs
-- Date: 2026-05-29
-- Spec: docs/release201/26-conversational-memory-plan.md §4 (新表 4/5)
--
-- What
-- ----
-- Reverse lookup "which messages quoted message X" — the inverse of the quote
-- cache's quoting→quoted edge. Indexed by quotedMessageId for fan-in queries
-- ("who referenced this?").
--
-- Signature chain
-- ---------------
-- DERIVED data. Not signed, does not touch any im_messages row.
--
-- Idempotency
-- -----------
-- CREATE TABLE IF NOT EXISTS; UNIQUE(quotedMessageId, quotingMessageId) keeps
-- the backref edge unique. Safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_conversation_quote_backrefs (
  id               VARCHAR(30) PRIMARY KEY,
  quotedMessageId  VARCHAR(30) NOT NULL,
  quotingMessageId VARCHAR(30) NOT NULL,
  conversationId   VARCHAR(30) NOT NULL,
  createdAt        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY im_conv_quote_backref_uk (quotedMessageId, quotingMessageId),
  INDEX idx_im_conv_quote_backref_quoted (quotedMessageId)
);

-- Tracking handled by scripts/db-migrate.sh; no manual _migrations INSERT.
