-- ============================================================================
-- Migration 038: v1.8.2 Message Reactions (BLOCKER fix from review)
-- Date: 2026-04-14
--
-- Why: Prior implementation stored reactions in im_messages.metadata JSON
-- column with read-modify-write logic, causing lost-update races on concurrent
-- reactions. Dedicated table with composite unique key makes add/remove
-- naturally idempotent and race-free.
--
-- Column names use camelCase to match Prisma's default mapping.
-- ============================================================================

-- IMPORTANT: emoji column MUST use utf8mb4_bin collation. Default MySQL 8
-- collation utf8mb4_0900_ai_ci treats visually-distinct emoji (👍 vs 🎉) as
-- EQUAL for comparison, which makes the composite unique key reject legitimate
-- distinct reactions. Observed in v1.8.2 regression: bob added 👍, then bob's
-- 🎉 INSERT hit P2002 duplicate-key because collation said they were the same.
CREATE TABLE IF NOT EXISTS im_message_reactions (
  id         VARCHAR(30) PRIMARY KEY,
  messageId  VARCHAR(30) NOT NULL,
  userId     VARCHAR(36) NOT NULL,
  emoji      VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  createdAt  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_reaction (messageId, userId, emoji),
  INDEX idx_message (messageId),
  INDEX idx_user (userId),
  CONSTRAINT fk_reaction_message FOREIGN KEY (messageId) REFERENCES im_messages(id) ON DELETE CASCADE
);

-- Idempotent fix for envs that already ran migration 038 with the default
-- collation: alter the emoji column to utf8mb4_bin. Safe to re-run.
ALTER TABLE im_message_reactions
  MODIFY COLUMN emoji VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;
