-- ============================================================================
-- Migration 405: v2.0 — IMTaskRunStep activity timeline persistence
-- Date: 2026-05-21
-- Spec: docs/release200/14-messaging-state-machine-reliability.md §4.4
--
-- Background
-- ----------
-- §4.4 makes "agent activity" a first-class persisted log (§P5 axiom:
-- observability is the byproduct of persistence, not transient events).
-- Daemon writes one row per phase change / tool call / reasoning chunk /
-- progress / error. F5 → front-end pulls full timeline via
-- GET /tasks/:id/timeline?afterSeq=N.
--
-- §12.1 two-axis edge: im_task_logs (existing audit axis — transitions /
-- cancels / digest emits) is NOT replaced. im_task_run_steps is the
-- runtime activity axis. Front-end merges both by timestamp.
--
-- Schema
-- ------
-- (id, taskRunId, taskId, seq, kind, payloadJson, occurredAt, durationMs)
-- seq is per-taskRun monotonic (allocated by daemon's StepRecorder).
--
-- Idempotent
-- ----------
-- CREATE TABLE IF NOT EXISTS.
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_task_run_steps (
  id          VARCHAR(40)  NOT NULL,
  taskRunId   VARCHAR(40)  NOT NULL,
  taskId      VARCHAR(40)  NOT NULL,
  seq         BIGINT       NOT NULL,
  kind        VARCHAR(30)  NOT NULL,  -- 'phase_change' | 'tool_call' | 'tool_result' | 'reasoning_chunk' | 'progress' | 'error'
  payloadJson JSON         NOT NULL,
  occurredAt  DATETIME(3)  NOT NULL,
  durationMs  INT          NULL,
  PRIMARY KEY (id),
  KEY taskrun_seq_idx (taskRunId, seq),
  KEY task_occurred_idx (taskId, occurredAt),
  KEY kind_occurred_idx (kind, occurredAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT
  'migration 405 v200 task_run_steps complete' AS status,
  (SELECT COUNT(*) FROM im_task_run_steps) AS total_steps;
