-- ============================================================================
-- Migration 428: v2.1 — Fixup the 4 missing role-provenance indexes from 427
-- Date: 2026-05-24
--
-- Why this migration exists
-- -------------------------
-- Migration 427's `pc_v201_add_index_if_missing` stored procedure had a
-- variable-name collision bug:
--
--     CREATE PROCEDURE pc_v201_add_index_if_missing(
--       IN target_table VARCHAR(64),
--       IN index_name   VARCHAR(64),
--       ...)
--     BEGIN
--       IF NOT EXISTS (
--         SELECT 1 FROM information_schema.statistics
--         WHERE table_schema = DATABASE()
--           AND table_name   = target_table
--           AND index_name   = index_name      -- ← BUG
--       ) THEN ...
--
-- Inside the procedure body, `index_name` resolves to the PARAMETER, not the
-- information_schema.statistics column — and `param = param` is `true`
-- unconditionally. So EXISTS returns true for every input, IF NOT EXISTS is
-- always false, and the CREATE INDEX block never executes.
--
-- The COLUMN additions worked because `pc_v201_add_col_if_missing` used a
-- different parameter name (`col_name` vs the schema column `column_name`),
-- so no collision happened there.
--
-- Net post-427 state: 6 columns added (3 per table) ✓, 0 indexes created ✗.
--
-- This migration adds the 4 missing indexes idempotently using direct
-- information_schema lookups (no PROCEDURE PARAM at all — pure literals).
-- ============================================================================

DROP PROCEDURE IF EXISTS pc_v201_add_index_idempotent;
DELIMITER //
CREATE PROCEDURE pc_v201_add_index_idempotent(
  IN p_table VARCHAR(64),
  IN p_index VARCHAR(64),
  IN p_cols  VARCHAR(500)
)
BEGIN
  DECLARE existing INT DEFAULT 0;
  -- Qualify the schema column explicitly via table alias to avoid the
  -- parameter-vs-column shadowing trap that broke migration 427.
  SELECT COUNT(*) INTO existing
    FROM information_schema.statistics s
   WHERE s.table_schema = DATABASE()
     AND s.table_name   = p_table
     AND s.index_name   = p_index;
  IF existing = 0 THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD INDEX `', p_index, '` (', p_cols, ')');
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

CALL pc_v201_add_index_idempotent('im_memory_files', 'im_memory_files_role_idx',      '`workspaceId`, `sourceRoleTemplateSlug`');
CALL pc_v201_add_index_idempotent('im_memory_files', 'im_memory_files_authority_idx', '`workspaceId`, `sourceIsOrchestrator`');
CALL pc_v201_add_index_idempotent('im_memory_pages', 'im_memory_pages_role_idx',      '`workspaceId`, `sourceRoleTemplateSlug`');
CALL pc_v201_add_index_idempotent('im_memory_pages', 'im_memory_pages_authority_idx', '`workspaceId`, `sourceIsOrchestrator`');

DROP PROCEDURE pc_v201_add_index_idempotent;

SELECT
  'migration 428 memory-role-indexes-fixup complete' AS status,
  (SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name='im_memory_files'
      AND index_name IN ('im_memory_files_role_idx','im_memory_files_authority_idx')) AS files_indexes,
  (SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name='im_memory_pages'
      AND index_name IN ('im_memory_pages_role_idx','im_memory_pages_authority_idx')) AS pages_indexes;
