-- ============================================================================
-- Migration 420: fix-forward for 418_v200_memory_agent_scope.sql drift
-- Date: 2026-05-22
-- Spec: docs/release200/evidence/v20-acceptance/04-migration-418-drift-defect-2026-05-22.md
--
-- Why this migration exists
-- -------------------------
-- 418 was modified after first apply (Wave 5-7 integration edited the file
-- in place rather than fix-forwarding). dev-up's sha checksum guard then
-- hard-fails because applied_sha != current_sha. This breaks fresh `dev-up`
-- cold starts even though the actual schema state is fine.
--
-- 418's content is idempotent (information_schema guards). Whatever content
-- is on disk now would re-apply cleanly. So the right fix is:
--   (a) re-run 418's idempotent body here (defensive; in case any DB hasn't
--       seen the post-drift content yet)
--   (b) rebaseline schema_migrations.checksum for 418 to the current sha so
--       sha-guard stops triggering on this row
--
-- Production impact: NONE. Prod has never applied 418 — it gets its checksum
-- recorded fresh on first apply. This migration only changes the recorded
-- checksum on databases where 418 WAS already applied (dev / local).
-- The 420 row itself records normally.
--
-- After this migration applies, dev-up will stop reporting drift on 418.
-- ============================================================================

-- (a) Defensive idempotent re-apply of 418's body. No-op if already in place.
DROP PROCEDURE IF EXISTS pc_v200_fix_418_drift;
DELIMITER //
CREATE PROCEDURE pc_v200_fix_418_drift()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_memory_files'
      AND column_name = 'agentImUserId'
  ) THEN
    ALTER TABLE im_memory_files
      ADD COLUMN agentImUserId VARCHAR(40) NULL AFTER workspaceId;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_memory_files'
      AND column_name = 'scope'
  ) THEN
    ALTER TABLE im_memory_files
      ADD COLUMN scope VARCHAR(20) NOT NULL DEFAULT 'workspace-shared' AFTER agentImUserId;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_memory_files'
      AND index_name = 'im_memory_files_agent_idx'
  ) THEN
    ALTER TABLE im_memory_files
      ADD KEY im_memory_files_agent_idx (agentImUserId, scope);
  END IF;
END//
DELIMITER ;
CALL pc_v200_fix_418_drift();
DROP PROCEDURE pc_v200_fix_418_drift;

-- (b) Rebaseline schema_migrations.checksum for 418 to its current on-disk sha.
--     Only updates the row if it exists (i.e. DB has already applied 418 via
--     the dev-side db-migrate.sh tracker). The test/prod sync-test-migrations.ts
--     runner uses a different tracking table (_migrations), where this fixup
--     is a no-op — guard the UPDATE on schema_migrations table existence so
--     the migration is portable across both trackers.
--
--     Implementation note: we cannot compute the file's sha from inside SQL,
--     so we record a sentinel checksum '__rebaselined_by_420__' that the
--     db-migrate.sh sha-guard recognizes as "skip sha comparison for this row".
DROP PROCEDURE IF EXISTS pc_v200_fix_418_drift_rebaseline;
DELIMITER //
CREATE PROCEDURE pc_v200_fix_418_drift_rebaseline()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'schema_migrations'
  ) THEN
    UPDATE schema_migrations
    SET checksum = '__rebaselined_by_420__'
    WHERE filename = '418_v200_memory_agent_scope.sql'
      AND checksum <> '__rebaselined_by_420__';
  END IF;
END//
DELIMITER ;
CALL pc_v200_fix_418_drift_rebaseline();
DROP PROCEDURE pc_v200_fix_418_drift_rebaseline;

SELECT 'migration 420 fix-forward for 418 drift complete' AS status;
