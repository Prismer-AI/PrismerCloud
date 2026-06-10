-- ============================================================================
-- Migration 339: v2.0 — Sweep legacy `failing` → canonical `errored`
--
-- Release 200 T11 (2026-05-19) tightened the SandboxStatus FSM:
--
--   - State machine `ALLOWED_TRANSITIONS` map dropped every `failing` edge.
--   - `state-machine.ts` collapses the legacy `failing` alias onto `errored`
--     during reads (normalizeSandboxStatus()).
--   - Reconciler `decideNextStatus()` now writes `errored` (was `failing`) for
--     CrashLoopBackOff / OOMKilled / ImagePullBackOff / Failed / Unknown.
--   - `assertSandboxStatusTransition()` THROWS on illegal transitions (was
--     warn-only in S5; v200 promotes to hard guard).
--
-- Migration 333 already enumerated `im_containers.status` to the seven v2.0
-- values, so MySQL would reject any future INSERT/UPDATE that tried to write
-- the literal string `'failing'`. This migration is the defensive sibling for
-- ANY deployment whose status column was widened back to VARCHAR by a hot
-- patch (test envs that ran 333 but then reverted, dev DBs created before
-- 333, schemas that bypassed the ENUM via Prisma `db push --accept-data-loss`).
--
-- Safe to re-run — UPDATE is idempotent.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _339_sweep_failing_to_errored$$
CREATE PROCEDURE _339_sweep_failing_to_errored()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'im_containers'
  ) THEN
    -- Guard against the enum: if the column type is still ENUM(...) without
    -- `failing`, MySQL refuses the UPDATE comparison RHS silently as an
    -- empty match. The COUNT(*) probe protects the SELECT below from no-op
    -- noise.
    UPDATE `im_containers`
    SET `status` = 'errored'
    WHERE `status` = 'failing';
  END IF;
END$$

DELIMITER ;

CALL _339_sweep_failing_to_errored();

DROP PROCEDURE IF EXISTS _339_sweep_failing_to_errored;

SELECT 'migration 339 v200 failing→errored complete' AS status;
