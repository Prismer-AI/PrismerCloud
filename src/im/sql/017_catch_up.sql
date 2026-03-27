-- ============================================================================
-- Migration 017: Catch-up — idempotent补齐 015/016 缺失列和表
-- MySQL 8.0 compatible (uses stored procedure for ADD COLUMN IF NOT EXISTS)
-- Date: 2026-03-19
-- Description:
--   015 (signal_tags) 和 016 (hypergraph) 可能未在 test/prod 执行。
--   此脚本幂等补齐所有缺失列和表，已存在则跳过。
-- ============================================================================

-- Helper: ADD COLUMN IF NOT EXISTS (MySQL 8.0 workaround)
DELIMITER //
DROP PROCEDURE IF EXISTS add_column_if_not_exists//
CREATE PROCEDURE add_column_if_not_exists(
  IN p_table VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_definition VARCHAR(512)
)
BEGIN
  SET @col_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND COLUMN_NAME = p_column
  );
  IF @col_exists = 0 THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_definition);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
    SELECT CONCAT('  ✅ Added ', p_table, '.', p_column) AS result;
  ELSE
    SELECT CONCAT('  ⏭️  ', p_table, '.', p_column, ' already exists') AS result;
  END IF;
END//
DELIMITER ;

-- ═══════════════════════════════════════════════════════════════
-- From migration 014
-- ═══════════════════════════════════════════════════════════════

-- im_genes: circuit breaker columns
CALL add_column_if_not_exists('im_genes', 'breakerState', "VARCHAR(20) NOT NULL DEFAULT 'closed'");
CALL add_column_if_not_exists('im_genes', 'breakerFailCount', 'INT NOT NULL DEFAULT 0');
CALL add_column_if_not_exists('im_genes', 'breakerStateAt', 'DATETIME(3) NULL');

-- im_evolution_capsules: provider
CALL add_column_if_not_exists('im_evolution_capsules', 'provider', 'VARCHAR(50) NULL');

-- ═══════════════════════════════════════════════════════════════
-- From migration 015: signal_tags
-- ═══════════════════════════════════════════════════════════════

-- im_gene_signals.signal_tags (Prisma @map: signalTags → signal_tags)
CALL add_column_if_not_exists('im_gene_signals', 'signal_tags', 'TEXT NULL');

-- im_evolution_edges: v0.3.0 signal architecture fields
CALL add_column_if_not_exists('im_evolution_edges', 'signal_type', 'VARCHAR(128) NULL');
CALL add_column_if_not_exists('im_evolution_edges', 'bimodality_index', 'FLOAT NOT NULL DEFAULT 0.0');
CALL add_column_if_not_exists('im_evolution_edges', 'task_success_rate', 'FLOAT NULL');
CALL add_column_if_not_exists('im_evolution_edges', 'coverage_level', 'TINYINT NOT NULL DEFAULT 0');

-- im_unmatched_signals.signalTags
CALL add_column_if_not_exists('im_unmatched_signals', 'signalTags', 'TEXT NULL');

-- im_evolution_achievements
CREATE TABLE IF NOT EXISTS im_evolution_achievements (
  id         VARCHAR(30)  NOT NULL,
  agentId    VARCHAR(30)  NOT NULL,
  badgeKey   VARCHAR(100) NOT NULL,
  unlockedAt DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  metadata   TEXT         NOT NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uniq_agent_badge (agentId, badgeKey),
  INDEX idx_agent_id (agentId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ═══════════════════════════════════════════════════════════════
-- From migration 016: hypergraph + mode
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS im_atoms (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  kind      VARCHAR(30)  NOT NULL,
  value     VARCHAR(255) NOT NULL,
  createdAt DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX idx_kind_value (kind, value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS im_hyperedges (
  id        VARCHAR(30) PRIMARY KEY,
  type      VARCHAR(20) NOT NULL DEFAULT 'execution',
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_type (type),
  INDEX idx_created (createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS im_hyperedge_atoms (
  hyperedgeId VARCHAR(30) NOT NULL,
  atomId      INT         NOT NULL,
  role        VARCHAR(20) NULL,
  PRIMARY KEY (hyperedgeId, atomId),
  INDEX idx_atom_hyperedge (atomId, hyperedgeId),
  CONSTRAINT fk_hea_hyperedge FOREIGN KEY (hyperedgeId) REFERENCES im_hyperedges(id) ON DELETE CASCADE,
  CONSTRAINT fk_hea_atom FOREIGN KEY (atomId) REFERENCES im_atoms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS im_causal_links (
  causeId   VARCHAR(30) NOT NULL,
  effectId  VARCHAR(30) NOT NULL,
  linkType  VARCHAR(20) NOT NULL DEFAULT 'learning',
  strength  FLOAT       NOT NULL DEFAULT 1.0,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (causeId, effectId),
  INDEX idx_effect (effectId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

-- im_evolution_edges.mode + im_evolution_capsules.mode
CALL add_column_if_not_exists('im_evolution_edges', 'mode', "VARCHAR(20) NOT NULL DEFAULT 'standard'");
CALL add_column_if_not_exists('im_evolution_capsules', 'mode', "VARCHAR(20) NOT NULL DEFAULT 'standard'");

-- ═══════════════════════════════════════════════════════════════
-- Cleanup helper
-- ═══════════════════════════════════════════════════════════════
DROP PROCEDURE IF EXISTS add_column_if_not_exists;

-- ═══════════════════════════════════════════════════════════════
-- Verify
-- ═══════════════════════════════════════════════════════════════
SELECT '--- Migration 017 catch-up complete ---' AS status;
SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'im_gene_signals'
ORDER BY ORDINAL_POSITION;
