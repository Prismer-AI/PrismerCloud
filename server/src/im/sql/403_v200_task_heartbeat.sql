-- ============================================================================
-- Migration 403: v2.0 — IMTask phase heartbeat + currentPhase decoupled enum
-- Date: 2026-05-21
-- Spec: docs/release200/14-messaging-state-machine-reliability.md §4.2
--
-- Background
-- ----------
-- handleTimeouts (scheduler.service.ts:191) is already a cron reaper but
-- triggers at task.timeoutMs granularity (5 min default). Users feeling
-- "agent stuck for 45s" need a finer signal. Track-B introduces:
--   • lastHeartbeatAt    — daemon pushes every 15s
--   • heartbeatVersion   — monotonic counter for log ordering
--   • currentPhase       — execution phase decoupled from status; reaper
--                          writes 'stuck' when lastHeartbeatAt > 45s ago
--
-- §4.2 critical invariant: reaper writes ONLY `currentPhase`, never touches
-- `status`. handleTimeouts (existing) remains the final task-level timeout
-- safety net. `stuck` is a phase, not a status — `daemon reconnect → phase
-- auto-recovers` without a transition.
--
-- §14 rev.5: NO `stuckAt` column — currentPhase='stuck' + updatedAt is enough.
--
-- Schema deltas
-- -------------
-- ALTER im_tasks: lastHeartbeatAt + heartbeatVersion + currentPhase
-- + composite index (status, lastHeartbeatAt) for reaper scan.
--
-- Idempotent
-- ----------
-- Column + index add guarded by information_schema.
-- ============================================================================

DROP PROCEDURE IF EXISTS pc_v200_alter_task_heartbeat;
DELIMITER //
CREATE PROCEDURE pc_v200_alter_task_heartbeat()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_tasks' AND column_name = 'lastHeartbeatAt'
  ) THEN
    ALTER TABLE im_tasks ADD COLUMN lastHeartbeatAt DATETIME(3) NULL AFTER lastRunAt;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_tasks' AND column_name = 'heartbeatVersion'
  ) THEN
    ALTER TABLE im_tasks ADD COLUMN heartbeatVersion BIGINT NOT NULL DEFAULT 0 AFTER lastHeartbeatAt;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'im_tasks' AND column_name = 'currentPhase'
  ) THEN
    -- §4.2: enum values (app-layer) — thinking | tool_use | reasoning |
    -- responding | waiting_user | waiting_dep | stuck. NULL when status is
    -- not running/review.
    ALTER TABLE im_tasks ADD COLUMN currentPhase VARCHAR(40) NULL AFTER status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_tasks' AND index_name = 'im_tasks_heartbeat_idx'
  ) THEN
    CREATE INDEX im_tasks_heartbeat_idx ON im_tasks (status, lastHeartbeatAt);
  END IF;
END//
DELIMITER ;
CALL pc_v200_alter_task_heartbeat();
DROP PROCEDURE pc_v200_alter_task_heartbeat;

SELECT
  'migration 403 v200 task heartbeat complete' AS status,
  (SELECT COUNT(*) FROM im_tasks) AS total_tasks,
  (SELECT COUNT(*) FROM im_tasks WHERE lastHeartbeatAt IS NOT NULL) AS tasks_with_heartbeat;
