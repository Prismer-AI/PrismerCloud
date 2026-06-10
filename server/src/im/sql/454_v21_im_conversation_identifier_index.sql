-- ============================================================================
-- Migration 454: v2.1 Conversational Memory Phase 1 — im_conversation_identifier_index
-- Date: 2026-05-29
-- Spec: docs/release201/26-conversational-memory-plan.md §4 (新表 5/5) + §8 Phase 3
--
-- What
-- ----
-- Entity name → canonical id resolution per conversation (person / entity /
-- artifact / ...). aliasesJson holds the observed surface forms; canonicalId
-- the resolved target. Phase 1 only LANDS the table; population (message
-- persist hook) and envelope consumption are Phase 3 (§8).
--
-- Signature chain
-- ---------------
-- DERIVED data. Not signed, does not touch any im_messages row.
--
-- Idempotency
-- -----------
-- CREATE TABLE IF NOT EXISTS; UNIQUE(conversationId, identifierKind, canonicalId)
-- keeps one row per canonical entity per conversation. Safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_conversation_identifier_index (
  id                      VARCHAR(30)  PRIMARY KEY,
  conversationId          VARCHAR(30)  NOT NULL,
  identifierKind          VARCHAR(32)  NOT NULL,        -- person | entity | artifact | ...
  canonicalId             VARCHAR(255) NOT NULL,
  aliasesJson             TEXT         NOT NULL,         -- JSON: string[]
  firstSeenMessageId      VARCHAR(30)  NOT NULL,
  lastReferencedMessageId VARCHAR(30)  NOT NULL,
  displayLabel            VARCHAR(255) NULL,
  metadataJson            TEXT         NOT NULL,         -- JSON
  createdAt               DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt               DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY im_conv_identifier_uk (conversationId, identifierKind, canonicalId),
  INDEX idx_im_conv_identifier_conv (conversationId)
);

-- Tracking handled by scripts/db-migrate.sh; no manual _migrations INSERT.
