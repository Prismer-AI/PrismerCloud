-- ============================================================================
-- Migration 427: v2.1 — Memory role provenance + ACL-aware recall scaffold
-- Date: 2026-05-24
-- Spec: docs/release201/00-ceo-role-and-built-in-skills-review.md §1 P0-6
--       docs/release201/01-ceo-role-optimization.md §0.2 (memory policy)
--
-- Why this migration exists
-- -------------------------
-- v2.1 audit (00 §2.5) found that im_memory_files / im_memory_pages have no
-- way to record WHICH role authored a memory. The schema only knows ownerId
-- (the IMUser) and ownerType ('agent' | 'workspace'). When the same agent
-- is reassigned a different role (or when an orchestrator-only memory is
-- written by CEO), the recall plane cannot distinguish "same-role-sourced"
-- (orchestrator-workspace memory) from "any-role-sourced" — so memoryPolicy
-- in role-runtime-policy.ts has no field to filter on.
--
-- 1516 existing im_memory_files have sourceKind=NULL (00 §2.5 confirms).
-- This migration is DDL-only — no backfill — because we cannot retroactively
-- attribute a role to memories written before role stamping was wired. New
-- writes carry the stamp; old writes stay NULL and recall treats them as
-- "any-role" (matches workspace-public recall pass).
--
-- Three new nullable columns + composite index per memory table:
--   sourceRoleTemplateSlug  — the role slug the writer was bound to at write
--                             time (e.g. 'ceo', 'engineer', 'pm'). NULL if
--                             the writer wasn't bound to a known role
--                             template (workspace ingest, etc.).
--   sourceTaskAuthority     — 'orchestrator' | 'executor' | NULL. Captures
--                             RBAC plane authority at write time so recall
--                             can do "orchestrator-workspace" filtering
--                             without re-reading the (mutable) role template.
--   sourceIsOrchestrator    — TINYINT(1) — convenience predicate index
--                             instead of forcing every recall WHERE clause
--                             to check sourceTaskAuthority='orchestrator'.
--                             Always == (sourceTaskAuthority='orchestrator').
--
-- Note: doc 00 §1 lists P0-6 as having a fuller scope (ACL-aware /recall
-- and FULLTEXT page path). The ACL wiring lives in code (recall.ts +
-- memory-search.service.ts); this migration provides the underlying schema.
-- ============================================================================

DROP PROCEDURE IF EXISTS pc_v201_add_col_if_missing;
DELIMITER //
CREATE PROCEDURE pc_v201_add_col_if_missing(
  IN target_table VARCHAR(64),
  IN col_name     VARCHAR(64),
  IN col_def      VARCHAR(255)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = target_table
      AND column_name  = col_name
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', target_table, '` ADD COLUMN ', col_def);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

DROP PROCEDURE IF EXISTS pc_v201_add_index_if_missing;
DELIMITER //
CREATE PROCEDURE pc_v201_add_index_if_missing(
  IN target_table VARCHAR(64),
  IN index_name   VARCHAR(64),
  IN index_def    VARCHAR(500)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name   = target_table
      AND index_name   = index_name
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', target_table, '` ADD INDEX `', index_name, '` (', index_def, ')');
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

CALL pc_v201_add_col_if_missing('im_memory_files', 'sourceRoleTemplateSlug', '`sourceRoleTemplateSlug` VARCHAR(50) NULL');
CALL pc_v201_add_col_if_missing('im_memory_files', 'sourceTaskAuthority',    '`sourceTaskAuthority` VARCHAR(20) NULL');
CALL pc_v201_add_col_if_missing('im_memory_files', 'sourceIsOrchestrator',   '`sourceIsOrchestrator` TINYINT(1) NULL');
CALL pc_v201_add_index_if_missing('im_memory_files', 'im_memory_files_role_idx', '`workspaceId`, `sourceRoleTemplateSlug`');
CALL pc_v201_add_index_if_missing('im_memory_files', 'im_memory_files_authority_idx', '`workspaceId`, `sourceIsOrchestrator`');

CALL pc_v201_add_col_if_missing('im_memory_pages', 'sourceRoleTemplateSlug', '`sourceRoleTemplateSlug` VARCHAR(50) NULL');
CALL pc_v201_add_col_if_missing('im_memory_pages', 'sourceTaskAuthority',    '`sourceTaskAuthority` VARCHAR(20) NULL');
CALL pc_v201_add_col_if_missing('im_memory_pages', 'sourceIsOrchestrator',   '`sourceIsOrchestrator` TINYINT(1) NULL');
CALL pc_v201_add_index_if_missing('im_memory_pages', 'im_memory_pages_role_idx', '`workspaceId`, `sourceRoleTemplateSlug`');
CALL pc_v201_add_index_if_missing('im_memory_pages', 'im_memory_pages_authority_idx', '`workspaceId`, `sourceIsOrchestrator`');

DROP PROCEDURE pc_v201_add_col_if_missing;
DROP PROCEDURE pc_v201_add_index_if_missing;

SELECT
  'migration 427 memory-role-provenance complete' AS status,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='im_memory_files'
      AND column_name IN ('sourceRoleTemplateSlug','sourceTaskAuthority','sourceIsOrchestrator')) AS files_cols_added,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='im_memory_pages'
      AND column_name IN ('sourceRoleTemplateSlug','sourceTaskAuthority','sourceIsOrchestrator')) AS pages_cols_added;
