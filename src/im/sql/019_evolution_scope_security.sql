-- ============================================================================
-- Migration 019: Evolution Scope + Security Enhancement
-- MySQL 8.0 compatible, idempotent (safe to re-run)
-- Date: 2026-03-23
-- Description:
--   Phase 1: scope field on evolution tables (data domain isolation)
--   Phase 2: encrypted fields on genes/capsules + ephemeralKeys on security
--   Phase 3: im_evolution_acl table (fine-grained sharing)
--   Security: Rate limiting activation on routes (code-only, no SQL)
-- ============================================================================

-- Helper: ADD COLUMN IF NOT EXISTS
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

-- ============================================================================
-- Phase 1: Scope fields
-- ============================================================================

SELECT '=== Phase 1: Adding scope fields ===' AS step;

CALL add_column_if_not_exists('im_genes', 'scope', "VARCHAR(60) NOT NULL DEFAULT 'global'");
CALL add_column_if_not_exists('im_evolution_edges', 'scope', "VARCHAR(60) NOT NULL DEFAULT 'global'");
CALL add_column_if_not_exists('im_evolution_capsules', 'scope', "VARCHAR(60) NOT NULL DEFAULT 'global'");
CALL add_column_if_not_exists('im_unmatched_signals', 'scope', "VARCHAR(60) NOT NULL DEFAULT 'global'");
CALL add_column_if_not_exists('im_evolution_achievements', 'scope', "VARCHAR(60) NOT NULL DEFAULT 'global'");

-- Indexes for scope filtering
CREATE INDEX IF NOT EXISTS idx_genes_scope_vis ON im_genes(scope, visibility);
CREATE INDEX IF NOT EXISTS idx_capsules_scope ON im_evolution_capsules(scope);

-- Rebuild unique constraint on im_evolution_edges to include scope
-- Must drop old unique + create new one
SET @old_idx = (
  SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'im_evolution_edges'
    AND COLUMN_NAME = 'ownerAgentId'
    AND NON_UNIQUE = 0
  LIMIT 1
);
SET @drop_sql = IF(@old_idx IS NOT NULL,
  CONCAT('ALTER TABLE im_evolution_edges DROP INDEX `', @old_idx, '`'),
  'SELECT "No old unique index to drop" AS info'
);
PREPARE stmt FROM @drop_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE im_evolution_edges
  ADD UNIQUE INDEX uq_edge_scope (ownerAgentId, signalKey(200), geneId, mode, scope);

-- Rebuild unique on im_unmatched_signals to include scope
SET @old_ums_idx = (
  SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'im_unmatched_signals'
    AND COLUMN_NAME = 'signalKey'
    AND NON_UNIQUE = 0
  LIMIT 1
);
SET @drop_ums = IF(@old_ums_idx IS NOT NULL,
  CONCAT('ALTER TABLE im_unmatched_signals DROP INDEX `', @old_ums_idx, '`'),
  'SELECT "No old unique index to drop" AS info'
);
PREPARE stmt FROM @drop_ums;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE im_unmatched_signals
  ADD UNIQUE INDEX uq_unmatched_scope (signalKey(200), agentId, scope);

-- Rebuild unique on im_evolution_achievements to include scope
SET @old_ach_idx = (
  SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'im_evolution_achievements'
    AND COLUMN_NAME = 'agentId'
    AND NON_UNIQUE = 0
  LIMIT 1
);
SET @drop_ach = IF(@old_ach_idx IS NOT NULL,
  CONCAT('ALTER TABLE im_evolution_achievements DROP INDEX `', @old_ach_idx, '`'),
  'SELECT "No old unique index to drop" AS info'
);
PREPARE stmt FROM @drop_ach;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE im_evolution_achievements
  ADD UNIQUE INDEX uq_achievement_scope (agentId, badgeKey, scope);

SELECT '  ✅ Phase 1 complete: scope fields + indexes' AS result;

-- ============================================================================
-- Phase 2: Encryption fields
-- ============================================================================

SELECT '=== Phase 2: Adding encryption fields ===' AS step;

CALL add_column_if_not_exists('im_genes', 'encrypted', 'TINYINT(1) NOT NULL DEFAULT 0');
CALL add_column_if_not_exists('im_genes', 'encryptionKeyId', 'VARCHAR(30) NULL');
CALL add_column_if_not_exists('im_evolution_capsules', 'encrypted', 'TINYINT(1) NOT NULL DEFAULT 0');
CALL add_column_if_not_exists('im_conversation_security', 'ephemeralKeys', "TEXT NULL");

SELECT '  ✅ Phase 2 complete: encryption fields' AS result;

-- ============================================================================
-- Phase 3: ACL table
-- ============================================================================

SELECT '=== Phase 3: Creating ACL table ===' AS step;

CREATE TABLE IF NOT EXISTS im_evolution_acl (
  id            VARCHAR(30) NOT NULL,
  resourceType  VARCHAR(20) NOT NULL,
  resourceId    VARCHAR(100) NOT NULL,
  subjectType   VARCHAR(20) NOT NULL,
  subjectId     VARCHAR(100) NOT NULL,
  permission    VARCHAR(20) NOT NULL,
  grantedBy     VARCHAR(30) NOT NULL,
  createdAt     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expiresAt     DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_acl (resourceType, resourceId, subjectType, subjectId, permission),
  INDEX idx_acl_resource (resourceId),
  INDEX idx_acl_subject (subjectType, subjectId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT '  ✅ Phase 3 complete: im_evolution_acl table' AS result;

-- ============================================================================
-- Cleanup
-- ============================================================================

DROP PROCEDURE IF EXISTS add_column_if_not_exists;

SELECT '✅ Migration 019 complete: Evolution Scope + Security Enhancement' AS result;
