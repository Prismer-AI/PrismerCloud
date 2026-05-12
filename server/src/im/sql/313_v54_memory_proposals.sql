-- ============================================================================
-- Migration 313: v5.4 — Memory proposals (A4 of Memory Line A)
-- Date: 2026-05-08
--
-- Stores agent-authored draft edits awaiting owner approval. baseVersion is
-- the page version snapshot at proposal time; on approve it must match the
-- current page version, otherwise 409 baseVersion_drift is returned.
--
-- Idempotent via CREATE TABLE IF NOT EXISTS.
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_memory_proposals (
  id                VARCHAR(30)  NOT NULL,
  workspaceId       VARCHAR(30)  NOT NULL,
  proposingAgentId  VARCHAR(30)  NOT NULL,
  sessionId         VARCHAR(50)  NULL,
  status            VARCHAR(20)  NOT NULL DEFAULT 'pending',
  pagePath          VARCHAR(500) NOT NULL,
  baseVersion       INT          NOT NULL,
  operation         VARCHAR(20)  NOT NULL,
  contentDiff       LONGTEXT     NOT NULL,
  rationale         TEXT         NULL,
  confidence        DOUBLE       NOT NULL DEFAULT 0,
  sourceRefs        TEXT         NOT NULL,
  expiresAt         DATETIME(3)  NOT NULL,
  createdAt         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decidedAt         DATETIME(3)  NULL,
  decidedByImUserId VARCHAR(30)  NULL,
  rejectionReason   TEXT         NULL,

  PRIMARY KEY (id),
  KEY idx_im_memory_proposals_workspace_status_created (workspaceId, status, createdAt),
  KEY idx_im_memory_proposals_workspace_session (workspaceId, sessionId),
  KEY idx_im_memory_proposals_workspace_path_status (workspaceId, pagePath, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'migration 312 complete' AS status;
