-- ============================================================================
-- Migration 016: Hypergraph Layer + Metrics (v0.3.1)
-- MySQL 8.0 compatible (no ADD COLUMN IF NOT EXISTS, no reserved word `window`)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. im_atoms
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS im_atoms (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  kind      VARCHAR(30)  NOT NULL,
  value     VARCHAR(255) NOT NULL,
  createdAt DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX idx_kind_value (kind, value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. im_hyperedges
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS im_hyperedges (
  id        VARCHAR(30) PRIMARY KEY,
  type      VARCHAR(20) NOT NULL DEFAULT 'execution',
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_type (type),
  INDEX idx_created (createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. im_hyperedge_atoms
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS im_hyperedge_atoms (
  hyperedgeId VARCHAR(30) NOT NULL,
  atomId      INT         NOT NULL,
  role        VARCHAR(20) NULL,
  PRIMARY KEY (hyperedgeId, atomId),
  INDEX idx_atom_hyperedge (atomId, hyperedgeId),
  CONSTRAINT fk_hea_hyperedge FOREIGN KEY (hyperedgeId) REFERENCES im_hyperedges(id) ON DELETE CASCADE,
  CONSTRAINT fk_hea_atom FOREIGN KEY (atomId) REFERENCES im_atoms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. im_causal_links
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS im_causal_links (
  causeId   VARCHAR(30) NOT NULL,
  effectId  VARCHAR(30) NOT NULL,
  linkType  VARCHAR(20) NOT NULL DEFAULT 'learning',
  strength  FLOAT       NOT NULL DEFAULT 1.0,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (causeId, effectId),
  INDEX idx_effect (effectId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 5. im_evolution_metrics (note: `window` is reserved in MySQL 8, use backticks)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS im_evolution_metrics (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  ts                DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `window`          VARCHAR(10)  NOT NULL DEFAULT '1h',
  mode              VARCHAR(20)  NOT NULL DEFAULT 'standard',
  scope             VARCHAR(30)  NOT NULL DEFAULT 'global',
  ssr               FLOAT NULL,
  cs                INT   NULL,
  rp                FLOAT NULL,
  regp              FLOAT NULL,
  gd                FLOAT NULL,
  er                FLOAT NULL,
  totalCapsules     INT NOT NULL DEFAULT 0,
  successCapsules   INT NOT NULL DEFAULT 0,
  uniqueGenesUsed   INT NOT NULL DEFAULT 0,
  uniqueAgents      INT NOT NULL DEFAULT 0,
  INDEX idx_ts_mode (ts, mode),
  INDEX idx_scope_ts (scope, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 6. Add mode column to existing tables
-- MySQL 8.0: no IF NOT EXISTS for ADD COLUMN — will error if already exists, that's OK
-- ---------------------------------------------------------------------------
ALTER TABLE im_evolution_edges ADD COLUMN mode VARCHAR(20) NOT NULL DEFAULT 'standard';
ALTER TABLE im_evolution_capsules ADD COLUMN mode VARCHAR(20) NOT NULL DEFAULT 'standard';

-- Update unique constraint: old=(ownerAgentId, signalKey, geneId) → new=(+mode)
-- Required for A/B mode coexistence (standard vs hypergraph edges for same signal+gene)
-- Note: will fail if old index doesn't exist — that's OK (means it's already correct)
ALTER TABLE im_evolution_edges
  DROP INDEX idx_owner_signal_gene,
  ADD UNIQUE INDEX idx_owner_signal_gene_mode (ownerAgentId, signalKey, geneId, mode);

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
SELECT 'migration 016 complete' AS status;
