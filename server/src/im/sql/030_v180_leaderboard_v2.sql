-- Leaderboard V2: Value Metrics + Anti-Cheat + Token Baseline
-- Run against prismer_info database
--
-- Track A m3 phase 2 fix: replaced single-statement multi-`ADD COLUMN IF NOT
-- EXISTS` (lines 51-58) with INFORMATION_SCHEMA guard procedure. Tables also
-- now declare COLLATE explicitly to avoid the MySQL 8 default
-- utf8mb4_0900_ai_ci collation drift that caused JOIN failures with the
-- rest of the schema (which uses utf8mb4_unicode_ci).

CREATE TABLE IF NOT EXISTS im_value_metrics (
  id              INT          AUTO_INCREMENT PRIMARY KEY,
  entityType      VARCHAR(20)  NOT NULL,
  entityId        VARCHAR(191) NOT NULL,
  period          VARCHAR(20)  NOT NULL,
  snapshotDate    DATETIME     NOT NULL,
  tokenSaved      DOUBLE       NOT NULL DEFAULT 0,
  moneySaved      DOUBLE       NOT NULL DEFAULT 0,
  co2Reduced      DOUBLE       NOT NULL DEFAULT 0,
  devHoursSaved   DOUBLE       NOT NULL DEFAULT 0,
  errorPatterns   INT          NOT NULL DEFAULT 0,
  agentsHelped    INT          NOT NULL DEFAULT 0,
  adoptionCount   INT          NOT NULL DEFAULT 0,
  rankByValue     INT          NULL,
  rankByImpact    INT          NULL,
  percentile      DOUBLE       NULL,
  prevPeriodValue DOUBLE       NULL,
  growthRate      DOUBLE       NULL,
  scope           VARCHAR(100) NOT NULL DEFAULT 'global',
  INDEX idx_entity_period_date (entityType, period, snapshotDate),
  INDEX idx_entity_id_period   (entityType, entityId, period),
  INDEX idx_period_rank_date   (period, rankByValue, snapshotDate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS im_anti_cheat_log (
  id          INT          AUTO_INCREMENT PRIMARY KEY,
  ruleKey     VARCHAR(50)  NOT NULL,
  entityType  VARCHAR(20)  NOT NULL,
  entityId    VARCHAR(191) NOT NULL,
  detail      TEXT         NOT NULL,
  action      VARCHAR(20)  NOT NULL,
  reviewedBy  VARCHAR(191) NULL,
  reviewedAt  DATETIME     NULL,
  createdAt   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rule_created (ruleKey, createdAt),
  INDEX idx_entity       (entityId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS im_token_baseline (
  id              INT          AUTO_INCREMENT PRIMARY KEY,
  signalKey       VARCHAR(500) NOT NULL,
  avgTokensNoGene DOUBLE       NOT NULL,
  sampleCount     INT          NOT NULL,
  updatedAt       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX idx_signal_key (signalKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- v1.8.0 leaderboard snapshot extensions
DROP PROCEDURE IF EXISTS _030_add_col;
DELIMITER //
CREATE PROCEDURE _030_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN col_def TEXT)
BEGIN
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl) > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col) = 0 THEN
    SET @stmt := CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', col_def);
    PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

CALL _030_add_col('im_leaderboard_snapshots', 'tokenSaved',     'DOUBLE NOT NULL DEFAULT 0');
CALL _030_add_col('im_leaderboard_snapshots', 'moneySaved',     'DOUBLE NOT NULL DEFAULT 0');
CALL _030_add_col('im_leaderboard_snapshots', 'co2Reduced',     'DOUBLE NOT NULL DEFAULT 0');
CALL _030_add_col('im_leaderboard_snapshots', 'devHoursSaved',  'DOUBLE NOT NULL DEFAULT 0');
CALL _030_add_col('im_leaderboard_snapshots', 'percentile',     'DOUBLE NULL');
CALL _030_add_col('im_leaderboard_snapshots', 'growthRate',     'DOUBLE NULL');
CALL _030_add_col('im_leaderboard_snapshots', 'prevRank',       'INT NULL');

DROP PROCEDURE _030_add_col;
