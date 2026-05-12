-- ============================================================================
-- Migration 023 -> filed as 025: Quality Score + Reports (Data Governance v1.7.3)
--
-- Track A m1+ regression fix (2026-05-02): wrapped each ADD COLUMN in
-- INFORMATION_SCHEMA guards. Reason: new 012_add_skill_catalog.sql now
-- creates im_skills with qualityScore already attached, so a fresh chain
-- run would otherwise hit a duplicate-column error here. Same guards added
-- to im_genes / im_users ALTERs for consistency and re-run safety.
-- ============================================================================

-- Generic guard procedure: idempotent ADD COLUMN.
DROP PROCEDURE IF EXISTS _add_column_if_missing;
DELIMITER //
CREATE PROCEDURE _add_column_if_missing(IN tbl VARCHAR(64), IN col VARCHAR(64), IN col_def TEXT)
BEGIN
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = tbl
         AND COLUMN_NAME = col) = 0 THEN
    SET @stmt := CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', col_def);
    PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

-- Add qualityScore to im_genes
CALL _add_column_if_missing('im_genes',  'qualityScore', 'DOUBLE NOT NULL DEFAULT 0.01');

-- Add qualityScore to im_skills (already in 012 for fresh installs)
CALL _add_column_if_missing('im_skills', 'qualityScore', 'DOUBLE NOT NULL DEFAULT 0.01');

-- Add moderation fields to im_users
CALL _add_column_if_missing('im_users',  'reportBanUntil',  'DATETIME(3) NULL');
CALL _add_column_if_missing('im_users',  'quarantineCount', 'INT NOT NULL DEFAULT 0');
CALL _add_column_if_missing('im_users',  'publishCount',    'INT NOT NULL DEFAULT 0');
CALL _add_column_if_missing('im_users',  'banned',          'TINYINT(1) NOT NULL DEFAULT 0');
CALL _add_column_if_missing('im_users',  'bannedAt',        'DATETIME(3) NULL');
CALL _add_column_if_missing('im_users',  'banReason',       'VARCHAR(500) NULL');

DROP PROCEDURE _add_column_if_missing;

-- Create im_reports table
CREATE TABLE IF NOT EXISTS im_reports (
  id            VARCHAR(30)  NOT NULL,
  reporterId    VARCHAR(30)  NOT NULL,
  targetType    VARCHAR(10)  NOT NULL,
  targetId      VARCHAR(128) NOT NULL,
  reason        VARCHAR(30)  NOT NULL,
  reasonDetail  TEXT         NULL,
  status        VARCHAR(20)  NOT NULL DEFAULT 'pending',
  frozenCredits DOUBLE       NOT NULL DEFAULT 0,
  resolvedBy    VARCHAR(30)  NULL,
  resolvedAt    DATETIME(3)  NULL,
  createdAt     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_reporter_target (reporterId, targetType, targetId),
  KEY idx_status (status),
  KEY idx_target (targetType, targetId),
  KEY idx_reporter (reporterId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Backfill: seed genes get qualityScore = 1.0 (idempotent)
UPDATE im_genes SET qualityScore = 1.0 WHERE visibility = 'seed' AND qualityScore = 0.01;

-- Backfill: quarantine test data (idempotent)
UPDATE im_genes SET qualityScore = 0, visibility = 'quarantined'
  WHERE (title LIKE 'MCP Test Gene%' OR id LIKE 'mcp:test%') AND visibility != 'quarantined';

-- Backfill: prismer-source skills get qualityScore = 1.0 (idempotent)
UPDATE im_skills SET qualityScore = 1.0 WHERE source = 'prismer' AND qualityScore = 0.01;
