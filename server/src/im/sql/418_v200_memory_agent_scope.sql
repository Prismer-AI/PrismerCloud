-- ============================================================================
-- Migration 418: v2.0 — IMMemoryFile.agentImUserId + scope (agent-private bucket)
-- Date: 2026-05-22
-- Spec: docs/release200/13-agent-spec-and-lifecycle.md §6.1
--       docs/release200/14-messaging-state-machine-reliability.md §4.7 (Track-F)
--
-- Coexistence with 412 (Wave 5 F1 reconciliation)
-- -----------------------------------------------
-- Migration 412 (`memory_scope_sentinel`) installs:
--   - im_memory_files.scope column + default 'workspace-shared'
--   - workspace-shared rows normalized to ownerType='workspace' ownerId='__shared__'
--   - UNIQUE(workspaceId, scope, ownerType, ownerId, path)
--
-- This migration (418) augments by adding:
--   - im_memory_files.agentImUserId column (NULL for shared, required for agent-private)
--   - compound index (agentImUserId, scope) for agent-scope lookups
--
-- Both are idempotent (information_schema guards). Both must apply.
-- Applied in numeric order: 412 first (installs scope + sentinel), then 418.
--
-- Background
-- ----------
-- 13 doc §6.1 introduces a 2-bucket model for memory:
--   - scope='workspace-shared' (agentImUserId NULL): all agents in workspace can RW
--   - scope='agent-private'    (agentImUserId required): only this agent can RW
--
-- This unlocks Wave 4-E6 Track-F:
--   - Daemon-side SQLite bucketing: ~/.prismer/memory/<workspace>/{_shared.db | agents/<id>.db}
--   - Cloud-side ACL enforce: scope='agent-private' requires agentImUserId match
--   - Recall auto-inject can filter by scope per-agent
--
-- Idempotent
-- ----------
-- Column add + key add guarded by information_schema; safe to re-run.
-- ============================================================================

DROP PROCEDURE IF EXISTS pc_v200_memory_agent_scope;
DELIMITER //
CREATE PROCEDURE pc_v200_memory_agent_scope()
BEGIN
  -- ─── im_memory_files.agentImUserId (NULL when scope='workspace-shared') ────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_memory_files'
      AND column_name = 'agentImUserId'
  ) THEN
    ALTER TABLE im_memory_files
      ADD COLUMN agentImUserId VARCHAR(40) NULL AFTER workspaceId;
  END IF;

  -- ─── im_memory_files.scope (defensive — earlier deployment already added) ─
  -- (Already added in an earlier migration on this DB; idempotent guard for fresh)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_memory_files'
      AND column_name = 'scope'
  ) THEN
    ALTER TABLE im_memory_files
      ADD COLUMN scope VARCHAR(20) NOT NULL DEFAULT 'workspace-shared' AFTER agentImUserId;
  END IF;

  -- ─── compound index for agent-scope lookups ───────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_memory_files'
      AND index_name = 'im_memory_files_agent_idx'
  ) THEN
    ALTER TABLE im_memory_files
      ADD KEY im_memory_files_agent_idx (agentImUserId, scope);
  END IF;
END//
DELIMITER ;
CALL pc_v200_memory_agent_scope();
DROP PROCEDURE pc_v200_memory_agent_scope;

SELECT
  'migration 412 v200 memory agent scope complete' AS status,
  (SELECT COUNT(*) FROM im_memory_files WHERE scope = 'workspace-shared') AS workspace_shared,
  (SELECT COUNT(*) FROM im_memory_files WHERE scope = 'agent-private')    AS agent_private;
