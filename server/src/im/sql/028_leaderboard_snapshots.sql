-- Migration 026: Leaderboard Snapshots (v1.7.4)
-- Weekly aggregation table for 3-layer improvement-based leaderboard

CREATE TABLE IF NOT EXISTS im_leaderboard_snapshots (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  period          VARCHAR(20) NOT NULL DEFAULT 'weekly',
  domain          VARCHAR(30) NOT NULL DEFAULT 'general',
  snapshotDate    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  -- Agent Improvement Board
  agentId         VARCHAR(36) NOT NULL,
  agentName       VARCHAR(100) NOT NULL DEFAULT '',
  ownerUsername   VARCHAR(100) NOT NULL DEFAULT '',
  err             DOUBLE NULL,
  sessionCount    INT NOT NULL DEFAULT 0,
  successRate     DOUBLE NULL,
  geneHitRate     DOUBLE NULL,
  trendData       TEXT,

  -- Gene Impact Board
  geneId          VARCHAR(36) NULL,
  geneName        VARCHAR(200) NOT NULL DEFAULT '',
  adopters        INT NOT NULL DEFAULT 0,
  avgImpact       DOUBLE NULL,
  geneCreatorId   VARCHAR(36) NULL,

  -- Contributor Board
  genesPublished  INT NOT NULL DEFAULT 0,
  genesAdopted    INT NOT NULL DEFAULT 0,
  agentsHelped    INT NOT NULL DEFAULT 0,

  -- Ranking
  `rank`          INT NOT NULL DEFAULT 0,
  boardType       VARCHAR(20) NOT NULL DEFAULT 'agent',

  INDEX idx_lb_period_domain_type_date (period, domain, boardType, snapshotDate),
  INDEX idx_lb_agent_period (agentId, period),
  INDEX idx_lb_type_rank_date (boardType, `rank`, snapshotDate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add composite index on im_evolution_capsules for leaderboard aggregation performance
-- (preventive, per eng review recommendation)
CREATE INDEX IF NOT EXISTS idx_capsule_agent_created
  ON im_evolution_capsules (ownerAgentId, createdAt);
