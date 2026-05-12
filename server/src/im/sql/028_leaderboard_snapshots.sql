-- Migration 028 (was 026): Leaderboard Snapshots (v1.7.4)
-- Weekly aggregation table for 3-layer improvement-based leaderboard
--
-- Track A m3 phase 2 fix: line 43's `CREATE INDEX IF NOT EXISTS` was MariaDB-only
-- syntax — replaced with MySQL 8.0 INFORMATION_SCHEMA guard.

CREATE TABLE IF NOT EXISTS im_leaderboard_snapshots (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  period          VARCHAR(20)  NOT NULL DEFAULT 'weekly',
  domain          VARCHAR(30)  NOT NULL DEFAULT 'general',
  snapshotDate    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  -- Agent Improvement Board
  agentId         VARCHAR(36)  NOT NULL,
  agentName       VARCHAR(100) NOT NULL DEFAULT '',
  ownerUsername   VARCHAR(100) NOT NULL DEFAULT '',
  err             DOUBLE       NULL,
  sessionCount    INT          NOT NULL DEFAULT 0,
  successRate     DOUBLE       NULL,
  geneHitRate     DOUBLE       NULL,
  trendData       TEXT,

  -- Gene Impact Board
  geneId          VARCHAR(36)  NULL,
  geneName        VARCHAR(200) NOT NULL DEFAULT '',
  adopters        INT          NOT NULL DEFAULT 0,
  avgImpact       DOUBLE       NULL,
  geneCreatorId   VARCHAR(36)  NULL,

  -- Contributor Board
  genesPublished  INT          NOT NULL DEFAULT 0,
  genesAdopted    INT          NOT NULL DEFAULT 0,
  agentsHelped    INT          NOT NULL DEFAULT 0,

  -- Ranking
  `rank`          INT          NOT NULL DEFAULT 0,
  boardType       VARCHAR(20)  NOT NULL DEFAULT 'agent',

  INDEX idx_lb_period_domain_type_date (period, domain, boardType, snapshotDate),
  INDEX idx_lb_agent_period (agentId, period),
  INDEX idx_lb_type_rank_date (boardType, `rank`, snapshotDate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Idempotent: composite index on im_evolution_capsules for leaderboard
-- aggregation perf (preventive, per eng review). Original used the
-- MariaDB-only `CREATE INDEX IF NOT EXISTS` syntax.
SET @idx := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'im_evolution_capsules'
     AND INDEX_NAME = 'idx_capsule_agent_created'
);
SET @tbl := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'im_evolution_capsules'
);
SET @stmt := IF(
  @tbl > 0 AND @idx = 0,
  'CREATE INDEX idx_capsule_agent_created ON im_evolution_capsules (ownerAgentId, createdAt)',
  'SELECT ''skip idx_capsule_agent_created'' AS status'
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
