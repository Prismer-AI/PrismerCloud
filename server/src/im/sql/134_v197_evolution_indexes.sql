-- ============================================================================
-- Migration 134 (v1.9.7): backfill 6 secondary indexes that Prisma models
--                        declare via @@index but raw SQL never created
-- Date: 2026-05-12
-- MySQL 8.0 compatible — idempotent (CREATE INDEX guarded via INFORMATION_SCHEMA)
-- ============================================================================
--
-- These indexes appear in prisma/schema.mysql.prisma as @@index entries
-- but never made it into any of 001-132 raw SQL migrations. Evolution
-- queries that filter by signalType / mode / provider / signalKey were
-- doing full table scans.
--
-- Index names match Prisma's <table>_<column>_idx convention so future
-- `prisma migrate diff` output stays clean (no rename noise).
--
-- ============================================================================

DROP PROCEDURE IF EXISTS create_index_if_missing_v197;
DELIMITER //
CREATE PROCEDURE create_index_if_missing_v197(
  IN p_table   VARCHAR(64),
  IN p_index   VARCHAR(64),
  IN p_columns VARCHAR(512)
)
BEGIN
  DECLARE has_idx INT DEFAULT 0;
  SELECT COUNT(*) INTO has_idx FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = p_table
     AND INDEX_NAME = p_index;
  IF has_idx = 0 THEN
    SET @stmt := CONCAT('CREATE INDEX `', p_index, '` ON `', p_table, '` (', p_columns, ')');
    PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
    SELECT CONCAT('  ✅ Created ', p_index, ' on ', p_table) AS result;
  ELSE
    SELECT CONCAT('  ⏭️  ', p_index, ' already exists') AS result;
  END IF;
END//
DELIMITER ;

CALL create_index_if_missing_v197('im_community_tags',     'im_community_tags_name_idx',           '`name`');
CALL create_index_if_missing_v197('im_evolution_capsules', 'im_evolution_capsules_provider_idx',   '`provider`');
CALL create_index_if_missing_v197('im_evolution_capsules', 'im_evolution_capsules_mode_idx',       '`mode`');
CALL create_index_if_missing_v197('im_evolution_edges',    'im_evolution_edges_signalType_idx',    '`signalType`');
CALL create_index_if_missing_v197('im_evolution_edges',    'im_evolution_edges_mode_idx',          '`mode`');
CALL create_index_if_missing_v197('im_unmatched_signals',  'im_unmatched_signals_signalKey_idx',   '`signalKey`');

DROP PROCEDURE create_index_if_missing_v197;

SELECT '--- Migration 134 v1.9.7 evolution_indexes complete ---' AS status;
