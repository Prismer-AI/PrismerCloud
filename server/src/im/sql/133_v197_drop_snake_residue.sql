-- ============================================================================
-- Migration 133 (v1.9.7): drop snake_case residue from im_evolution_edges
--                        and im_gene_signals
-- Date: 2026-05-12
-- MySQL 8.0 compatible — idempotent (DROP COLUMN IF EXISTS via INFORMATION_SCHEMA)
-- ============================================================================
--
-- Root cause:
--   017_catch_up.sql (original) re-ADDed 5 snake_case columns even when
--   015's rewrite had already created the canonical camelCase versions.
--   Result: every fresh init carried 4 dead cols on im_evolution_edges and
--   1 on im_gene_signals — Prisma client reads camelCase only, so the
--   snake cols just consumed space + NOT NULL DEFAULT values on every
--   INSERT. 017 is now patched to stop re-introducing them.
--
-- This migration cleans up any DB (fresh or legacy) that still carries
-- the residue. Safe to re-run.
--
-- ============================================================================

DROP PROCEDURE IF EXISTS drop_column_if_exists;
DELIMITER //
CREATE PROCEDURE drop_column_if_exists(
  IN p_table  VARCHAR(64),
  IN p_column VARCHAR(64)
)
BEGIN
  DECLARE has_col INT DEFAULT 0;
  SELECT COUNT(*) INTO has_col FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = p_table
     AND COLUMN_NAME = p_column;
  IF has_col > 0 THEN
    SET @stmt := CONCAT('ALTER TABLE `', p_table, '` DROP COLUMN `', p_column, '`');
    PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
    SELECT CONCAT('  ✅ Dropped ', p_table, '.', p_column) AS result;
  ELSE
    SELECT CONCAT('  ⏭️  ', p_table, '.', p_column, ' already absent') AS result;
  END IF;
END//
DELIMITER ;

-- im_evolution_edges: 4 snake_case residues
CALL drop_column_if_exists('im_evolution_edges', 'signal_type');
CALL drop_column_if_exists('im_evolution_edges', 'bimodality_index');
CALL drop_column_if_exists('im_evolution_edges', 'task_success_rate');
CALL drop_column_if_exists('im_evolution_edges', 'coverage_level');

-- im_gene_signals: 1 snake_case residue
CALL drop_column_if_exists('im_gene_signals', 'signal_tags');

DROP PROCEDURE drop_column_if_exists;

SELECT '--- Migration 133 v1.9.7 drop_snake_residue complete ---' AS status;
