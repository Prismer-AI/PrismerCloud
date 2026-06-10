-- ============================================================================
-- Migration 455: v2.1 Conversational Memory Phase 1 — im_messages.tokenCountCl100k
-- Date: 2026-05-29
-- Spec: docs/release201/26-conversational-memory-plan.md §4 (字段加 1 个) + §6 §10
--
-- What
-- ----
-- Nullable cl100k (tiktoken) token count per message. cloud budgets context in
-- cl100k units (§6); adapters convert to their native tokenizer. Backfilled by
-- a background worker (Phase 1 §8) — NULL until counted.
--
-- Signature chain — EXPLICITLY EXCLUDED (verified)
-- ------------------------------------------------
-- The signing canonical strings (src/im/crypto/index.ts:175-232) are:
--   full: version|senderId|senderKeyId|conversationId|sequence|type|timestamp|contentHash|prevHash
--   lite: secVersion|senderDid|type|timestamp|contentHash
-- Neither includes any token-count field, and contentHash = SHA-256(content)
-- only (computeContentHash, index.ts:166-171) — it does NOT hash the whole row.
-- Therefore backfilling tokenCountCl100k NEVER invalidates an existing
-- signature. grep confirms no other site folds an entire im_messages row into a
-- hash. A signing unit test must still assert secVersion verifies identical
-- before/after backfill (§8 Phase 1 acceptance).
--
-- Idempotency
-- -----------
-- Column add is not natively IF NOT EXISTS in MySQL 8; re-run will error
-- "Duplicate column name". The migration runner tracks applied files, so each
-- migration applies once. Add it manually-once if patching out of band.
-- ============================================================================

ALTER TABLE im_messages
  ADD COLUMN tokenCountCl100k INT NULL;

-- Tracking handled by scripts/db-migrate.sh; no manual _migrations INSERT.
