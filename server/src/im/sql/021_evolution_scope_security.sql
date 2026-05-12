-- ============================================================================
-- Migration 019 -> filed as 021: Evolution Scope + Security Enhancement
-- MySQL 8.0 compatible, idempotent (safe to re-run)
-- Date: 2026-03-23 (m3 phase 2 rewrite: 2026-05-02)
-- Description:
--   Phase 1: scope field on evolution tables (data domain isolation)
--   Phase 2: encrypted fields on genes/capsules + ephemeralKeys on security
--   Phase 3: im_evolution_acl table (fine-grained sharing)
--
-- Track A m3 phase 2 fix:
--   - Lines 52-53 used `CREATE INDEX IF NOT EXISTS` (MariaDB-only) — replaced
--     with a `_create_index_if_missing` helper procedure.
--   - Lines 73-114's UNIQUE INDEX additions weren't idempotent; wrapped in
--     INFORMATION_SCHEMA guards so re-runs are no-ops.
-- ============================================================================

-- Helper: ADD COLUMN IF NOT EXISTS
DROP PROCEDURE IF EXISTS add_column_if_not_exists;
DELIMITER //
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
  END IF;
END //
DELIMITER ;

-- Helper: CREATE INDEX IF NOT EXISTS (MySQL 8 doesn't support the literal syntax)
DROP PROCEDURE IF EXISTS create_index_if_missing;
DELIMITER //
CREATE PROCEDURE create_index_if_missing(
  IN p_table VARCHAR(64),
  IN p_index_name VARCHAR(64),
  IN p_columns VARCHAR(512),
  IN p_unique TINYINT
)
BEGIN
  SET @idx_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND INDEX_NAME = p_index_name
  );
  IF @idx_exists = 0 THEN
    SET @sql = CONCAT(
      'ALTER TABLE `', p_table, '` ADD ',
      IF(p_unique = 1, 'UNIQUE ', ''),
      'INDEX `', p_index_name, '` (', p_columns, ')'
    );
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- Helper: drop a unique index by column-coverage, in preparation for replacing
-- it with a wider unique that includes scope. Idempotent: drops only if a
-- unique index covering the seed column still exists.
DROP PROCEDURE IF EXISTS drop_unique_by_column;
DELIMITER //
CREATE PROCEDURE drop_unique_by_column(
  IN p_table VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_replacement_idx VARCHAR(64)
)
BEGIN
  -- If the replacement unique already exists, the old unique was already dropped.
  SET @already = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND INDEX_NAME = p_replacement_idx
  );
  IF @already = 0 THEN
    SET @old_idx = (
      SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = p_table
        AND COLUMN_NAME = p_column
        AND NON_UNIQUE = 0
      LIMIT 1
    );
    IF @old_idx IS NOT NULL THEN
      SET @sql = CONCAT('ALTER TABLE `', p_table, '` DROP INDEX `', @old_idx, '`');
      PREPARE stmt FROM @sql;
      EXECUTE stmt;
      DEALLOCATE PREPARE stmt;
    END IF;
  END IF;
END //
DELIMITER ;

-- ============================================================================
-- Phase 1: Scope fields
-- ============================================================================

CALL add_column_if_not_exists('im_genes',                  'scope', "VARCHAR(60) NOT NULL DEFAULT 'global'");
CALL add_column_if_not_exists('im_evolution_edges',        'scope', "VARCHAR(60) NOT NULL DEFAULT 'global'");
CALL add_column_if_not_exists('im_evolution_capsules',     'scope', "VARCHAR(60) NOT NULL DEFAULT 'global'");
CALL add_column_if_not_exists('im_unmatched_signals',      'scope', "VARCHAR(60) NOT NULL DEFAULT 'global'");
CALL add_column_if_not_exists('im_evolution_achievements', 'scope', "VARCHAR(60) NOT NULL DEFAULT 'global'");

-- Indexes for scope filtering
CALL create_index_if_missing('im_genes',              'idx_genes_scope_vis', 'scope, visibility', 0);
CALL create_index_if_missing('im_evolution_capsules', 'idx_capsules_scope',  'scope',             0);

-- Rebuild unique constraints to include scope (idempotent: drops old + adds new only when needed)
CALL drop_unique_by_column('im_evolution_edges',        'ownerAgentId', 'uq_edge_scope');
CALL create_index_if_missing('im_evolution_edges', 'uq_edge_scope', 'ownerAgentId, signalKey(200), geneId, mode, scope', 1);

CALL drop_unique_by_column('im_unmatched_signals',      'signalKey',    'uq_unmatched_scope');
CALL create_index_if_missing('im_unmatched_signals', 'uq_unmatched_scope', 'signalKey(200), agentId, scope', 1);

CALL drop_unique_by_column('im_evolution_achievements', 'agentId',      'uq_achievement_scope');
CALL create_index_if_missing('im_evolution_achievements', 'uq_achievement_scope', 'agentId, badgeKey, scope', 1);

-- ============================================================================
-- Phase 2: Encryption fields
-- ============================================================================

CALL add_column_if_not_exists('im_genes',                'encrypted',         'TINYINT(1) NOT NULL DEFAULT 0');
CALL add_column_if_not_exists('im_genes',                'encryptionKeyId',   'VARCHAR(30) NULL');
CALL add_column_if_not_exists('im_evolution_capsules',   'encrypted',         'TINYINT(1) NOT NULL DEFAULT 0');
CALL add_column_if_not_exists('im_conversation_security','ephemeralKeys',     'TEXT NULL');

-- ============================================================================
-- Phase 3: ACL table
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_evolution_acl (
  id            VARCHAR(30)  NOT NULL,
  resourceType  VARCHAR(20)  NOT NULL,
  resourceId    VARCHAR(100) NOT NULL,
  subjectType   VARCHAR(20)  NOT NULL,
  subjectId     VARCHAR(100) NOT NULL,
  permission    VARCHAR(20)  NOT NULL,
  grantedBy     VARCHAR(30)  NOT NULL,
  createdAt     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expiresAt     DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_acl (resourceType, resourceId, subjectType, subjectId, permission),
  INDEX idx_acl_resource (resourceId),
  INDEX idx_acl_subject (subjectType, subjectId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- Cleanup
-- ============================================================================

DROP PROCEDURE IF EXISTS add_column_if_not_exists;
DROP PROCEDURE IF EXISTS create_index_if_missing;
DROP PROCEDURE IF EXISTS drop_unique_by_column;

SELECT 'migration 021 complete' AS status;
