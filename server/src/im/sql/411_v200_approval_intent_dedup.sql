-- ============================================================================
-- Migration 411: v2.0 — IMApproval.intentHash (server-side intent dedup)
-- Date: 2026-05-21
-- Spec: docs/release200/14-messaging-state-machine-reliability.md §4.4.8.3
--
-- Background
-- ----------
-- §4.4.8 screenshot evidence: 3 nearly-identical approvals defaulted to fully
-- expanded UI, eating ~50% of composer area. Beyond the UI fix (collapse +
-- bottom sheet, see §4.4.8.2), the same multi-agent flow keeps emitting
-- duplicate-intent approvals → we need server-side dedup so the second /
-- third call returns the existing pending approval instead of spamming the
-- queue.
--
-- intentHash formula
-- ------------------
-- sha256(workspaceId + ':' + conversationId + ':' + category + ':' +
--        normalizeTaskId(metadata.taskId) + ':' + dateBucket(createdAt, '1h'))
--
-- Same workspace + conversation + category + taskId within the same 1h
-- bucket → same intentHash → existing approval is returned.
--
-- Schema deltas
-- -------------
-- ALTER im_approvals: add intentHash VARCHAR(64) NULL + composite index
-- (workspaceId, conversationId, intentHash, status) for the lookup query
-- "is there already a pending approval for this intent in this conversation?"
--
-- Idempotent
-- ----------
-- Column + index add guarded by information_schema.
-- ============================================================================

DROP PROCEDURE IF EXISTS pc_v200_alter_approval_intent;
DELIMITER //
CREATE PROCEDURE pc_v200_alter_approval_intent()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_approvals' AND column_name = 'intentHash'
  ) THEN
    ALTER TABLE im_approvals ADD COLUMN intentHash VARCHAR(64) NULL AFTER category;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_approvals' AND index_name = 'intent_idx'
  ) THEN
    CREATE INDEX intent_idx ON im_approvals (workspaceId, conversationId, intentHash, status);
  END IF;
END//
DELIMITER ;
CALL pc_v200_alter_approval_intent();
DROP PROCEDURE pc_v200_alter_approval_intent;

SELECT
  'migration 411 v200 approval intent_dedup complete' AS status,
  (SELECT COUNT(*) FROM im_approvals) AS total_approvals,
  (SELECT COUNT(*) FROM im_approvals WHERE intentHash IS NOT NULL) AS approvals_with_intent_hash;
