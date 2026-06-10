-- ============================================================================
-- Migration 412: v2.0 — IMMemoryFile scope + shared owner sentinel
-- Date: 2026-05-21
-- Spec: docs/release200/13-agent-spec-and-lifecycle.md §6.1
--
-- Reintroduces storage scope after v1.9.2 dropped it. We avoid generated
-- columns so SQLite dev and MySQL prod share the same Prisma shape.
--
-- workspace-shared rows are normalized by service layer to:
--   ownerType='workspace', ownerId='__shared__'
-- This lets a normal UNIQUE(workspaceId, scope, ownerType, ownerId, path)
-- represent "one shared path per workspace" and "one private path per owner".
-- ============================================================================

DROP PROCEDURE IF EXISTS pc_v200_memory_scope_sentinel;
DELIMITER //
CREATE PROCEDURE pc_v200_memory_scope_sentinel()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_memory_files' AND column_name = 'scope'
  ) THEN
    ALTER TABLE im_memory_files
      ADD COLUMN scope VARCHAR(20) NOT NULL DEFAULT 'workspace-shared' AFTER workspaceId;
  END IF;

  UPDATE im_memory_files
  SET ownerType = 'workspace',
      ownerId = '__shared__',
      scope = 'workspace-shared'
  WHERE scope = 'workspace-shared'
    AND (ownerType <> 'workspace' OR ownerId <> '__shared__');

  IF EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_memory_files'
      AND index_name = 'im_memory_files_workspaceId_path_key'
  ) THEN
    ALTER TABLE im_memory_files DROP INDEX im_memory_files_workspaceId_path_key;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_memory_files'
      AND index_name = 'im_memory_files_bucket_path_key'
  ) THEN
    ALTER TABLE im_memory_files
      ADD UNIQUE KEY im_memory_files_bucket_path_key (workspaceId, scope, ownerType, ownerId, path);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_memory_files'
      AND index_name = 'im_memory_files_scope_idx'
  ) THEN
    ALTER TABLE im_memory_files
      ADD KEY im_memory_files_scope_idx (workspaceId, scope, ownerType, ownerId);
  END IF;
END//
DELIMITER ;
CALL pc_v200_memory_scope_sentinel();
DROP PROCEDURE pc_v200_memory_scope_sentinel;

SELECT 'migration 412 v200 memory scope sentinel complete' AS status;
