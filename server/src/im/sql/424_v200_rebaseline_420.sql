-- ============================================================================
-- Migration 424: rebaseline 420_fix_418_drift.sql after its own edit
-- Date: 2026-05-24
--
-- Why this migration exists
-- -------------------------
-- 420 itself was edited *after* first apply on local dev: the original
-- shipped UPDATE schema_migrations unconditionally, which broke on test/prod
-- (those env tracker uses `_migrations` table, not `schema_migrations`).
-- The post-edit 420 wraps the UPDATE in an `IF EXISTS(schema_migrations)`
-- guard, but local dev DBs that already applied the unguarded version now
-- see `db-migrate.sh` sha-guard fail (recorded sha != on-disk sha).
--
-- Fix-forward: mark 420's recorded checksum with the standard
-- `__rebaselined_by_424__` sentinel that the now-generalised db-migrate.sh
-- regex recognises. After one run, db-migrate.sh refreshes the recorded
-- checksum to the actual file sha and the row settles. Subsequent edits
-- of 420 would still trigger the drift gate — only this specific apply-time
-- drift is acknowledged.
--
-- Number 424 (skipped 423) because 423_v200_office_artifacts_skill_first.sql
-- shipped concurrently from another worktree.
--
-- Cross-tracker portability: the UPDATE is guarded by
-- `information_schema.tables` existence check so test/prod (which use
-- `_migrations` table via sync-test-migrations.ts and never had
-- `schema_migrations`) are a no-op. The 424 row itself records normally
-- in whichever tracker is in use.
-- ============================================================================

DROP PROCEDURE IF EXISTS pc_v200_rebaseline_420_via_424;
DELIMITER //
CREATE PROCEDURE pc_v200_rebaseline_420_via_424()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'schema_migrations'
  ) THEN
    UPDATE schema_migrations
    SET checksum = '__rebaselined_by_424__'
    WHERE filename = '420_fix_418_drift.sql'
      AND checksum NOT LIKE '__rebaselined_by_%__';
  END IF;
END//
DELIMITER ;
CALL pc_v200_rebaseline_420_via_424();
DROP PROCEDURE pc_v200_rebaseline_420_via_424;

SELECT 'migration 424 rebaseline 420 complete' AS status;
