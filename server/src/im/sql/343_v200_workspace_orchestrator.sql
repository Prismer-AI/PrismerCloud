-- ============================================================================
-- Migration 343: v2.0 — im_workspaces orchestrator columns
-- Date: 2026-05-19
-- Spec: docs/release200/15-task-state-machine-and-kanban.md §4, §8
--
-- Background
-- ----------
-- Workspace gets an explicit orchestrator agent slot (replaces the
-- per-agent-profile `taskAuthority='orchestrator'` flag as the authoritative
-- source). Only ONE active orchestrator per workspace; rotation requires
-- revoke + appoint.
--
-- Columns added (all nullable, no FK):
--   orchestratorAgentId              VARCHAR(64)  — im_users.id of agent
--   orchestratorAuthorizedAt         DATETIME(3)  — when appointed
--   orchestratorAuthorizedByImUserId VARCHAR(64)  — im_users.id of human appointer
--   orchestratorRevokedAt            DATETIME(3)  — when revoked (NULL = active)
--
-- FK note
-- -------
-- Cross-table foreign-key constraints to im_users / im_agent_profiles are
-- DELIBERATELY OMITTED. Service layer (P2 work) validates the referenced
-- agent exists + is workspace-scoped. Rationale: avoid InnoDB constraint
-- maintenance overhead during workspace deletion / agent re-onboarding.
--
-- Idempotent: information_schema-guarded ADD COLUMN, safe to re-run.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _343_add_col_if_missing$$
CREATE PROCEDURE _343_add_col_if_missing(
  IN p_table VARCHAR(64),
  IN p_col VARCHAR(64),
  IN p_def TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND column_name = p_col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_col, '` ', p_def);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

CALL _343_add_col_if_missing(
  'im_workspaces',
  'orchestratorAgentId',
  'VARCHAR(64) NULL'
);

CALL _343_add_col_if_missing(
  'im_workspaces',
  'orchestratorAuthorizedAt',
  'DATETIME(3) NULL'
);

CALL _343_add_col_if_missing(
  'im_workspaces',
  'orchestratorAuthorizedByImUserId',
  'VARCHAR(64) NULL'
);

CALL _343_add_col_if_missing(
  'im_workspaces',
  'orchestratorRevokedAt',
  'DATETIME(3) NULL'
);

DROP PROCEDURE _343_add_col_if_missing;

SELECT 'migration 343 v200 workspace orchestrator 4 cols complete' AS status;
