-- ============================================================================
-- Migration 015: Signal Tags (v0.3.0 — SignalTag Architecture)
-- Version: v1.7.3
-- Date: 2026-03-18 (m3 phase 2 rewrite: 2026-05-02)
-- MySQL 8.0 compatible (no ADD COLUMN IF NOT EXISTS)
--
-- Track A m3 phase 2 fix: original 015 added five snake_case columns
-- (signal_tags, signal_type, bimodality_index, task_success_rate,
-- coverage_level) but the Prisma models for IMGeneSignal /
-- IMEvolutionEdge use camelCase (signalTags, signalType, bimodalityIndex,
-- taskSuccessRate, coverageLevel) without `@map(...)`. Result was a Prisma
-- column-mismatch on every read/write of those fields. Track D originally
-- flagged the gene_signals one; the four edges columns share the same
-- root cause and are repaired in the same pass.
--
-- This rewrite is idempotent in three modes:
--   1. Fresh install: ADD COLUMN as camelCase directly
--   2. Pre-existing snake_case (legacy prod): RENAME to camelCase
--   3. Already migrated (camelCase present): no-op
-- ============================================================================

-- Helper: rename snake_case column to camelCase if it exists, else add
-- a fresh camelCase column. Idempotent under all three modes.
DROP PROCEDURE IF EXISTS _ensure_camelcase_col;
DELIMITER //
CREATE PROCEDURE _ensure_camelcase_col(
  IN tbl VARCHAR(64),
  IN snake VARCHAR(64),
  IN camel VARCHAR(64),
  IN col_def TEXT
)
BEGIN
  DECLARE has_snake INT DEFAULT 0;
  DECLARE has_camel INT DEFAULT 0;
  DECLARE has_table INT DEFAULT 0;
  SELECT COUNT(*) INTO has_table FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl;
  IF has_table > 0 THEN
    SELECT COUNT(*) INTO has_snake FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = snake;
    SELECT COUNT(*) INTO has_camel FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = camel;
    IF has_camel = 0 THEN
      IF has_snake > 0 THEN
        SET @stmt := CONCAT('ALTER TABLE `', tbl, '` RENAME COLUMN `', snake, '` TO `', camel, '`');
      ELSE
        SET @stmt := CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', camel, '` ', col_def);
      END IF;
      PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
    END IF;
  END IF;
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- 1. im_gene_signals.signalTags  (was: signal_tags)
-- ---------------------------------------------------------------------------
CALL _ensure_camelcase_col('im_gene_signals', 'signal_tags', 'signalTags', 'JSON NULL');

-- ---------------------------------------------------------------------------
-- 2. im_evolution_edges: 4 v0.3.0 signal-architecture columns
-- ---------------------------------------------------------------------------
CALL _ensure_camelcase_col('im_evolution_edges', 'signal_type',       'signalType',      'VARCHAR(128) NULL');
CALL _ensure_camelcase_col('im_evolution_edges', 'bimodality_index',  'bimodalityIndex', 'FLOAT NOT NULL DEFAULT 0.0');
CALL _ensure_camelcase_col('im_evolution_edges', 'task_success_rate', 'taskSuccessRate', 'FLOAT NULL');
CALL _ensure_camelcase_col('im_evolution_edges', 'coverage_level',    'coverageLevel',   'TINYINT NOT NULL DEFAULT 0');

-- ---------------------------------------------------------------------------
-- 3. im_unmatched_signals.signalTags (already camelCase in original 015,
--    just guarded for re-run safety)
-- ---------------------------------------------------------------------------
CALL _ensure_camelcase_col('im_unmatched_signals', 'signaltags', 'signalTags', 'JSON NULL');

DROP PROCEDURE _ensure_camelcase_col;

-- ---------------------------------------------------------------------------
-- 4. im_evolution_achievements: ensure table exists (original 015 used
--    CREATE TABLE IF NOT EXISTS — already idempotent, kept verbatim).
-- ---------------------------------------------------------------------------
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

SELECT 'migration 015 complete' AS status;
