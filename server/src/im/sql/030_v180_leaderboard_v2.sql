-- Leaderboard V2: Value Metrics + Anti-Cheat + Token Baseline
-- Run against prismer_info database

CREATE TABLE IF NOT EXISTS im_value_metrics (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entityType VARCHAR(20) NOT NULL,
  entityId VARCHAR(191) NOT NULL,
  period VARCHAR(20) NOT NULL,
  snapshotDate DATETIME NOT NULL,
  tokenSaved DOUBLE NOT NULL DEFAULT 0,
  moneySaved DOUBLE NOT NULL DEFAULT 0,
  co2Reduced DOUBLE NOT NULL DEFAULT 0,
  devHoursSaved DOUBLE NOT NULL DEFAULT 0,
  errorPatterns INT NOT NULL DEFAULT 0,
  agentsHelped INT NOT NULL DEFAULT 0,
  adoptionCount INT NOT NULL DEFAULT 0,
  rankByValue INT NULL,
  rankByImpact INT NULL,
  percentile DOUBLE NULL,
  prevPeriodValue DOUBLE NULL,
  growthRate DOUBLE NULL,
  scope VARCHAR(100) NOT NULL DEFAULT 'global',
  INDEX idx_entity_period_date (entityType, period, snapshotDate),
  INDEX idx_entity_id_period (entityType, entityId, period),
  INDEX idx_period_rank_date (period, rankByValue, snapshotDate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS im_anti_cheat_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ruleKey VARCHAR(50) NOT NULL,
  entityType VARCHAR(20) NOT NULL,
  entityId VARCHAR(191) NOT NULL,
  detail TEXT NOT NULL,
  action VARCHAR(20) NOT NULL,
  reviewedBy VARCHAR(191) NULL,
  reviewedAt DATETIME NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rule_created (ruleKey, createdAt),
  INDEX idx_entity (entityId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS im_token_baseline (
  id INT AUTO_INCREMENT PRIMARY KEY,
  signalKey VARCHAR(500) NOT NULL,
  avgTokensNoGene DOUBLE NOT NULL,
  sampleCount INT NOT NULL,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX idx_signal_key (signalKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE im_leaderboard_snapshots
  ADD COLUMN IF NOT EXISTS tokenSaved DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS moneySaved DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS co2Reduced DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS devHoursSaved DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS percentile DOUBLE NULL,
  ADD COLUMN IF NOT EXISTS growthRate DOUBLE NULL,
  ADD COLUMN IF NOT EXISTS prevRank INT NULL;
