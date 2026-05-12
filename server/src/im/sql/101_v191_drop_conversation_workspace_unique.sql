-- ============================================================================
-- Migration 101: v1.9.1 Drop bogus IMConversation.workspaceId @unique
-- Date: 2026-05-02
-- Track: A (refactor)
--
-- Why: 1.8.2 baseline (migration 001) added `UNIQUE KEY
-- im_conversations_workspaceId_key (workspaceId)` declaring a 1:1 relationship
-- between conversation and workspace. This is wrong: 1.9.x semantics are
-- 1 workspace → N conversations (a workspace can host multiple group chats,
-- DMs, channels). The unique constraint would silently prevent valid use
-- cases (e.g. multi-agent collab cookbook).
--
-- Action: drop the unique key, replace with a normal index. The column itself
-- stays nullable VARCHAR(50) (no data risk — column was almost entirely NULL
-- in baseline because no im_workspaces table existed).
--
-- Idempotent: dynamic SQL guards against re-runs in environments where the
-- key was already dropped or the index was already created.
-- ============================================================================

-- 1. Drop the legacy UNIQUE KEY only if it still exists.
SET @drop_unique := (
  SELECT IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'im_conversations'
       AND INDEX_NAME = 'im_conversations_workspaceId_key') > 0,
    'ALTER TABLE im_conversations DROP INDEX im_conversations_workspaceId_key',
    'SELECT ''skip drop unique: not present'' AS status'
  )
);
PREPARE stmt FROM @drop_unique;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Add the replacement non-unique index (idempotent).
SET @add_index := (
  SELECT IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'im_conversations'
       AND INDEX_NAME = 'idx_conversations_workspace') = 0,
    'CREATE INDEX idx_conversations_workspace ON im_conversations (workspaceId)',
    'SELECT ''skip create index: already present'' AS status'
  )
);
PREPARE stmt FROM @add_index;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
