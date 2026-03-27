-- ============================================================================
-- Migration 009: Add Skill Evolution tables
-- Version: v1.7.2
-- Date: 2026-03-09
-- Description: Memory graph (evolution edges) + capsule records for
--              Agent Skill Evolution system
-- ============================================================================

-- Evolution Edges: (signal_key, gene_id) → outcome confidence network
CREATE TABLE IF NOT EXISTS im_evolution_edges (
  id              VARCHAR(30)   NOT NULL PRIMARY KEY,
  ownerAgentId    VARCHAR(30)   NOT NULL,
  signalKey       VARCHAR(500)  NOT NULL,
  geneId          VARCHAR(100)  NOT NULL,
  successCount    INT           NOT NULL DEFAULT 0,
  failureCount    INT           NOT NULL DEFAULT 0,
  lastScore       DOUBLE,
  lastUsedAt      DATETIME(3),
  createdAt       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE INDEX idx_owner_signal_gene (ownerAgentId, signalKey, geneId),
  INDEX idx_owner (ownerAgentId),
  INDEX idx_gene (geneId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Evolution Capsules: Gene execution records (success/failure log)
CREATE TABLE IF NOT EXISTS im_evolution_capsules (
  id              VARCHAR(30)   NOT NULL PRIMARY KEY,
  ownerAgentId    VARCHAR(30)   NOT NULL,
  geneId          VARCHAR(100)  NOT NULL,
  signalKey       VARCHAR(500)  NOT NULL,
  triggerSignals  TEXT          NOT NULL,
  outcome         VARCHAR(20)   NOT NULL DEFAULT 'pending',
  score           DOUBLE,
  summary         TEXT          NOT NULL,
  costCredits     DOUBLE        NOT NULL DEFAULT 0,
  metadata        TEXT          NOT NULL,
  createdAt       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_owner (ownerAgentId),
  INDEX idx_gene (geneId),
  INDEX idx_owner_outcome (ownerAgentId, outcome)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Verify
SELECT 'im_evolution_edges' AS table_name, COUNT(*) AS row_count FROM im_evolution_edges
UNION ALL
SELECT 'im_evolution_capsules', COUNT(*) FROM im_evolution_capsules;
