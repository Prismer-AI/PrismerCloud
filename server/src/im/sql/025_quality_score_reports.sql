-- 023: Quality Score + Reports (Data Governance v1.7.3)

-- Add qualityScore to im_genes
ALTER TABLE im_genes ADD COLUMN qualityScore DOUBLE NOT NULL DEFAULT 0.01;

-- Add qualityScore to im_skills
ALTER TABLE im_skills ADD COLUMN qualityScore DOUBLE NOT NULL DEFAULT 0.01;

-- Add moderation fields to im_users
ALTER TABLE im_users ADD COLUMN reportBanUntil DATETIME(3) NULL;
ALTER TABLE im_users ADD COLUMN quarantineCount INT NOT NULL DEFAULT 0;
ALTER TABLE im_users ADD COLUMN publishCount INT NOT NULL DEFAULT 0;
ALTER TABLE im_users ADD COLUMN banned TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE im_users ADD COLUMN bannedAt DATETIME(3) NULL;
ALTER TABLE im_users ADD COLUMN banReason VARCHAR(500) NULL;

-- Create im_reports table
CREATE TABLE IF NOT EXISTS im_reports (
  id VARCHAR(30) NOT NULL,
  reporterId VARCHAR(30) NOT NULL,
  targetType VARCHAR(10) NOT NULL,
  targetId VARCHAR(128) NOT NULL,
  reason VARCHAR(30) NOT NULL,
  reasonDetail TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  frozenCredits DOUBLE NOT NULL DEFAULT 0,
  resolvedBy VARCHAR(30) NULL,
  resolvedAt DATETIME(3) NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_reporter_target (reporterId, targetType, targetId),
  KEY idx_status (status),
  KEY idx_target (targetType, targetId),
  KEY idx_reporter (reporterId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Backfill: seed genes get qualityScore = 1.0
UPDATE im_genes SET qualityScore = 1.0 WHERE visibility = 'seed';

-- Backfill: quarantine test data
UPDATE im_genes SET qualityScore = 0, visibility = 'quarantined'
  WHERE title LIKE 'MCP Test Gene%' OR id LIKE 'mcp:test%';

-- Backfill: prismer-source skills get qualityScore = 1.0
UPDATE im_skills SET qualityScore = 1.0 WHERE source = 'prismer';
