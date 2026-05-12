-- ============================================================================
-- Migration 120: v1.9.3 — workspaceId Phase 2 (NOT NULL + DROP scope + DROP resourceId)
-- Date: 2026-05-02
-- Track: A (m3 GA)
--
-- Final cut for the workspace-id transition. After this migration:
--   1. 11 owned tables have `workspaceId` NOT NULL (rows truly belong to one
--      workspace; backfill at 110 covered them via owner-column joins).
--   2. 13 aggregate / cross-workspace tables keep `workspaceId NULLable`
--      (NULL = system-wide / multi-workspace aggregate). The column itself
--      stays so future per-workspace facets can populate it.
--   3. The legacy `scope` string field is DROPPED from all 12 tables that
--      had it (1.8.0 baseline). Reads now use workspaceId exclusively;
--      writes never wrote scope after m2 anyway (`scope` had a DB-level
--      default, so omitting it on INSERT was already safe).
--   4. `im_evolution_acl.resourceId` is DROPPED — replaced by the explicit
--      workspaceId + geneId columns added in 110.
--
-- Defensive: every NOT NULL conversion checks zero NULL rows first; every
-- DROP COLUMN guards on column existence. m3 phase 2 is also re-runnable
-- after a partial apply (no double-drop / double-modify errors).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helpers
-- ----------------------------------------------------------------------------

DROP PROCEDURE IF EXISTS _120_drop_col;
DELIMITER //
CREATE PROCEDURE _120_drop_col(IN tbl VARCHAR(64), IN col VARCHAR(64))
BEGIN
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl) > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col) > 0 THEN
    SET @stmt := CONCAT('ALTER TABLE `', tbl, '` DROP COLUMN `', col, '`');
    PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

-- Convert workspaceId to NOT NULL — only if every row already has a value.
-- Skips silently otherwise so prod environments mid-rollout don't break.
DROP PROCEDURE IF EXISTS _120_set_workspace_not_null;
DELIMITER //
CREATE PROCEDURE _120_set_workspace_not_null(IN tbl VARCHAR(64))
BEGIN
  DECLARE null_count INT DEFAULT 1;
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl) > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = tbl
             AND COLUMN_NAME = 'workspaceId'
             AND IS_NULLABLE = 'YES') > 0 THEN
    SET @sql := CONCAT('SELECT COUNT(*) INTO @nc FROM `', tbl, '` WHERE workspaceId IS NULL');
    PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
    IF @nc = 0 THEN
      SET @stmt := CONCAT('ALTER TABLE `', tbl, '` MODIFY COLUMN workspaceId VARCHAR(30) NOT NULL');
      PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
    END IF;
  END IF;
END //
DELIMITER ;

-- ----------------------------------------------------------------------------
-- Step 1: NOT NULL where the row has a definite workspace owner. 11 tables.
-- ----------------------------------------------------------------------------

CALL _120_set_workspace_not_null('im_tasks');
CALL _120_set_workspace_not_null('im_memory_files');
CALL _120_set_workspace_not_null('im_genes');
CALL _120_set_workspace_not_null('im_gene_signals');
CALL _120_set_workspace_not_null('im_evolution_capsules');
CALL _120_set_workspace_not_null('im_agent_skills');
CALL _120_set_workspace_not_null('im_unmatched_signals');
CALL _120_set_workspace_not_null('im_evolution_achievements');
CALL _120_set_workspace_not_null('im_agent_cards');
CALL _120_set_workspace_not_null('im_community_drafts');
CALL _120_set_workspace_not_null('im_community_bookmarks');

-- The 13 remaining tables keep workspaceId NULLable: aggregate / system-wide
-- (im_evolution_metrics, im_signal_clusters, im_token_baseline, im_atoms,
-- im_hyperedges, im_hyperedge_atoms, im_causal_links, im_anti_cheat_log) or
-- mixed-ownership (im_compaction_summaries via conversation, im_skills with
-- nullable ownerAgentId, im_evolution_acl per resourceType, im_value_metrics
-- with cross-entity entries, im_knowledge_links with no direct owner).

-- ----------------------------------------------------------------------------
-- Step 2: DROP scope from the 12 tables that had it (1.8.0 legacy)
-- ----------------------------------------------------------------------------

CALL _120_drop_col('im_tasks',                  'scope');
CALL _120_drop_col('im_memory_files',           'scope');
CALL _120_drop_col('im_genes',                  'scope');
CALL _120_drop_col('im_evolution_capsules',     'scope');
CALL _120_drop_col('im_evolution_metrics',      'scope');
CALL _120_drop_col('im_agent_skills',           'scope');
CALL _120_drop_col('im_unmatched_signals',      'scope');
CALL _120_drop_col('im_evolution_achievements', 'scope');
CALL _120_drop_col('im_evolution_edges',        'scope');
CALL _120_drop_col('im_knowledge_links',        'scope');
CALL _120_drop_col('im_value_metrics',          'scope');
CALL _120_drop_col('im_community_posts',        'scope');

-- ----------------------------------------------------------------------------
-- Step 3: DROP im_evolution_acl.resourceId — replaced by workspaceId + geneId
-- ----------------------------------------------------------------------------

-- Drop legacy unique key that includes resourceId (replaced by workspaceId/
-- geneId-based ACL semantics; m3+ uses the type-specific columns directly).
DROP PROCEDURE IF EXISTS _120_drop_acl_unique;
DELIMITER //
CREATE PROCEDURE _120_drop_acl_unique()
BEGIN
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'im_evolution_acl') > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'im_evolution_acl'
             AND INDEX_NAME = 'uq_acl') > 0 THEN
    ALTER TABLE im_evolution_acl DROP INDEX uq_acl;
  END IF;
END //
DELIMITER ;
CALL _120_drop_acl_unique();
DROP PROCEDURE _120_drop_acl_unique;

-- Drop the legacy non-unique index too (was on resourceId alone).
DROP PROCEDURE IF EXISTS _120_drop_acl_resource_idx;
DELIMITER //
CREATE PROCEDURE _120_drop_acl_resource_idx()
BEGIN
  IF (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'im_evolution_acl') > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'im_evolution_acl'
             AND INDEX_NAME = 'idx_acl_resource') > 0 THEN
    ALTER TABLE im_evolution_acl DROP INDEX idx_acl_resource;
  END IF;
END //
DELIMITER ;
CALL _120_drop_acl_resource_idx();
DROP PROCEDURE _120_drop_acl_resource_idx;

CALL _120_drop_col('im_evolution_acl', 'resourceId');

-- New unique reflecting the split fields (workspaceId/geneId/subjectType/
-- subjectId/permission). Idempotent.
SET @idx := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'im_evolution_acl'
     AND INDEX_NAME = 'uq_acl_v2'
);
SET @tbl := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'im_evolution_acl'
);
SET @stmt := IF(
  @tbl > 0 AND @idx = 0,
  'ALTER TABLE im_evolution_acl ADD UNIQUE KEY uq_acl_v2 (resourceType, workspaceId, geneId, subjectType, subjectId, permission)',
  'SELECT ''skip uq_acl_v2'' AS status'
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- ----------------------------------------------------------------------------
-- Cleanup
-- ----------------------------------------------------------------------------

DROP PROCEDURE _120_drop_col;
DROP PROCEDURE _120_set_workspace_not_null;

SELECT 'migration 120 complete' AS status;
