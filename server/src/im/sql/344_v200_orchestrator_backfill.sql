-- ============================================================================
-- Migration 344: v2.0 — Backfill workspace.orchestratorAgentId from agent
--                       profile taskAuthority='orchestrator'
-- Date: 2026-05-19
-- Spec: docs/release200/15-task-state-machine-and-kanban.md §4, §8 row 344
--
-- Background
-- ----------
-- Until release-200, agents carried `taskAuthority ∈ {'orchestrator', 'executor'}`
-- inside im_agent_profiles.config JSON (see docs/release200/12-role-template-
-- seeding.md §3.2). The new contract elevates orchestrator-ship to a workspace
-- attribute (one active orchestrator per workspace). This migration walks the
-- existing agent_profile data and picks the OLDEST orchestrator profile per
-- workspace as the seed value.
--
-- Selection rule (deterministic)
-- ------------------------------
-- For each workspace where orchestratorAgentId IS NULL and at least one
-- non-deleted agent profile in that workspace has
-- JSON_EXTRACT(config, '$.taskAuthority') = 'orchestrator', pick the OLDEST
-- such profile (ORDER BY createdAt ASC) and write its agentImUserId.
--
-- authorizedByImUserId is set to workspace.ownerImUserId (the workspace owner
-- conceptually authorized the role-template seed).
-- authorizedAt is set to NOW(3).
--
-- Idempotent: WHERE orchestratorAgentId IS NULL guards against re-runs.
-- ============================================================================

UPDATE im_workspaces w
SET
  w.orchestratorAgentId = (
    SELECT p.agentImUserId
    FROM im_agent_profiles p
    WHERE p.workspaceId = w.id
      AND p.deletedAt IS NULL
      AND JSON_UNQUOTE(JSON_EXTRACT(p.config, '$.taskAuthority')) = 'orchestrator'
    ORDER BY p.createdAt ASC
    LIMIT 1
  ),
  w.orchestratorAuthorizedAt = NOW(3),
  w.orchestratorAuthorizedByImUserId = w.ownerImUserId
WHERE w.orchestratorAgentId IS NULL
  AND EXISTS (
    SELECT 1 FROM im_agent_profiles p
    WHERE p.workspaceId = w.id
      AND p.deletedAt IS NULL
      AND JSON_UNQUOTE(JSON_EXTRACT(p.config, '$.taskAuthority')) = 'orchestrator'
  );

SELECT
  'migration 344 v200 orchestrator backfill complete' AS status,
  (SELECT COUNT(*) FROM im_workspaces WHERE orchestratorAgentId IS NOT NULL) AS workspaces_with_orchestrator;
