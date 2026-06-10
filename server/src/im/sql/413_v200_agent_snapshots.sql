-- ============================================================================
-- Migration 413: v2.0 — Agent-level snapshots
-- Date: 2026-05-21
-- Spec: docs/release200/13-agent-spec-and-lifecycle.md §6.2
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_agent_snapshots (
  id                        VARCHAR(30) PRIMARY KEY,
  agentImUserId             VARCHAR(30) NOT NULL,
  workspaceId               VARCHAR(30) NOT NULL,
  definitionJson            JSON NOT NULL,
  skillsJson                JSON NOT NULL,
  containerSnapshotId       VARCHAR(30) NULL,
  perAgentDirManifestJson   JSON NULL,
  memoryDumpRef             VARCHAR(255) NULL,
  includeMemory             TINYINT(1) NOT NULL DEFAULT 0,
  createdAt                 DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  createdBy                 VARCHAR(30) NOT NULL,
  status                    VARCHAR(20) NOT NULL DEFAULT 'ready',
  sizeBytes                 BIGINT NULL,
  KEY im_agent_snapshots_agent_idx (agentImUserId, createdAt),
  KEY im_agent_snapshots_workspace_idx (workspaceId, createdAt),
  KEY im_agent_snapshots_container_idx (containerSnapshotId),
  CONSTRAINT im_agent_snapshots_container_fk
    FOREIGN KEY (containerSnapshotId) REFERENCES im_container_snapshots(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'migration 413 v200 agent snapshots complete' AS status;
