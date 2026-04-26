-- ============================================================================
-- Migration 037: v1.8.2 Task model extensions for Lumin iOS parity
-- Date: 2026-04-13
-- NOTE: Column names use camelCase to match Prisma's default mapping
-- ============================================================================

-- Task progress tracking + conversation association
ALTER TABLE im_tasks
  ADD COLUMN progress        DOUBLE       DEFAULT NULL AFTER status,
  ADD COLUMN statusMessage   VARCHAR(500) DEFAULT NULL AFTER progress,
  ADD COLUMN conversationId  VARCHAR(36)  DEFAULT NULL AFTER scope,
  ADD COLUMN completedAt     DATETIME(3)  DEFAULT NULL AFTER deadline;

-- ownerType / assigneeType: NOT stored in DB
-- Resolved dynamically by enrichTask() from im_users.type (avoids redundancy)

ALTER TABLE im_tasks
  ADD INDEX idx_conversation (conversationId),
  ADD INDEX idx_completed (completedAt);

-- Quote reply support (iOS inline reply, distinct from parentId threading)
ALTER TABLE im_messages
  ADD COLUMN quotedMessageId VARCHAR(30) DEFAULT NULL AFTER parentId;

ALTER TABLE im_messages
  ADD INDEX idx_quoted (quotedMessageId);
