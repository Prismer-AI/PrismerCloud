-- ============================================================================
-- Migration 014: Gene Security — DB-persisted Circuit Breaker + Gene/Signal tables
-- Version: v1.7.3
-- Date: 2026-03-18
-- MySQL 8.0 compatible (no ADD COLUMN IF NOT EXISTS)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- im_genes: Gene独立表
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS im_genes (
  id               VARCHAR(100)  NOT NULL,
  category         VARCHAR(20)   NOT NULL,
  title            VARCHAR(200)  NOT NULL DEFAULT '',
  description      TEXT          NOT NULL,
  strategySteps    TEXT          NOT NULL,
  preconditions    TEXT          NOT NULL,
  `constraints`    TEXT          NOT NULL,
  visibility       VARCHAR(20)   NOT NULL DEFAULT 'private',
  ownerAgentId     VARCHAR(30)   NOT NULL,
  parentId         VARCHAR(100)  NULL,
  generation       INT           NOT NULL DEFAULT 1,
  forkCount        INT           NOT NULL DEFAULT 0,
  successCount     INT           NOT NULL DEFAULT 0,
  failureCount     INT           NOT NULL DEFAULT 0,
  lastUsedAt       DATETIME(3)   NULL,
  createdAt        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  breakerState     VARCHAR(20)   NOT NULL DEFAULT 'closed',
  breakerFailCount INT           NOT NULL DEFAULT 0,
  breakerStateAt   DATETIME(3)   NULL,

  PRIMARY KEY (id),
  INDEX idx_owner     (ownerAgentId),
  INDEX idx_category  (category),
  INDEX idx_visibility(visibility),
  INDEX idx_parent    (parentId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- im_gene_signals: Signal affinity links
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS im_gene_signals (
  geneId    VARCHAR(100)  NOT NULL,
  signalId  VARCHAR(200)  NOT NULL,
  affinity  DOUBLE        NOT NULL DEFAULT 1.0,

  PRIMARY KEY (geneId, signalId),
  INDEX idx_signal (signalId),
  CONSTRAINT fk_gene_signals_gene
    FOREIGN KEY (geneId) REFERENCES im_genes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- im_unmatched_signals: Evolution frontier
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS im_unmatched_signals (
  id          VARCHAR(30)   NOT NULL,
  signalKey   VARCHAR(500)  NOT NULL,
  signals     TEXT          NOT NULL,
  agentId     VARCHAR(30)   NOT NULL,
  context     TEXT          NOT NULL,
  count       INT           NOT NULL DEFAULT 1,
  resolvedBy  VARCHAR(100)  NULL,
  createdAt   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uq_signal_agent (signalKey, agentId),
  INDEX idx_signalKey (`signalKey`(191)),
  INDEX idx_count (`count`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- ALTER existing tables: add provider to capsules (MySQL 8.0 safe)
-- If column already exists, ALTER will fail harmlessly — run in try/catch.
-- ---------------------------------------------------------------------------
-- Run these separately; if they error "Duplicate column", that's OK:
ALTER TABLE im_evolution_capsules ADD COLUMN provider VARCHAR(50) NULL;
-- ALTER TABLE im_evolution_capsules ADD INDEX idx_provider (provider);

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
SELECT 'im_genes' AS tbl, COUNT(*) AS cnt FROM im_genes
UNION ALL SELECT 'im_gene_signals', COUNT(*) FROM im_gene_signals
UNION ALL SELECT 'im_unmatched_signals', COUNT(*) FROM im_unmatched_signals;
