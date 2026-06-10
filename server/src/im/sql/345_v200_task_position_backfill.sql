-- ============================================================================
-- Migration 345: v2.0 — Backfill im_tasks.position from legacy metadata.kanban.*
--                       and strip kanban view fields from metadata JSON
-- Date: 2026-05-19
-- Spec: docs/release200/15-task-state-machine-and-kanban.md §1.1, §8 row 345
--
-- Background
-- ----------
-- Pre-200, kanban manual order rode inside metadata JSON as either
-- `metadata.kanban.cardOrder` or the flatter `metadata.cardOrder`. Release-200
-- elevates `position DOUBLE` to a real column (migration 342). This migration:
--
--   Step A — Backfill position
--     COALESCE precedence:
--       1) existing position (idempotent guard, written by a previous run)
--       2) metadata.kanban.cardOrder
--       3) metadata.cardOrder
--       4) fallback: createdAt as ms-epoch (preserves rough chronological order)
--
--   Step B — Strip kanban view fields from metadata JSON
--     Removes: $.kanban, $.columnId, $.cardOrder, $.cardStatus, $.cardPriority
--     Preserves business fields (priority, tags, kind, context, profileId, etc.).
--     If none of those paths exist, JSON_REMOVE is a no-op so the WHERE clause
--     keeps the UPDATE narrow.
--
-- Idempotent
-- ----------
-- Step A: WHERE position IS NULL filter — re-runs do not overwrite manual
-- positions assigned after migration.
-- Step B: WHERE JSON_CONTAINS_PATH ... — only touches rows that still carry
-- legacy paths; once stripped, the row is skipped on subsequent runs.
-- ============================================================================

-- ─── Step A: backfill position column ────────────────────────────────────
UPDATE im_tasks
SET position = COALESCE(
  position,
  CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.kanban.cardOrder')) AS DOUBLE),
  CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.cardOrder')) AS DOUBLE),
  CAST(UNIX_TIMESTAMP(createdAt) * 1000 AS DOUBLE)
)
WHERE position IS NULL;

-- ─── Step B: strip legacy kanban view fields from metadata JSON ─────────
UPDATE im_tasks
SET metadata = JSON_REMOVE(
  metadata,
  '$.kanban',
  '$.columnId',
  '$.cardOrder',
  '$.cardStatus',
  '$.cardPriority'
)
WHERE JSON_CONTAINS_PATH(
  metadata,
  'one',
  '$.kanban',
  '$.columnId',
  '$.cardOrder',
  '$.cardStatus',
  '$.cardPriority'
);

SELECT
  'migration 345 v200 task position backfill complete' AS status,
  (SELECT COUNT(*) FROM im_tasks WHERE position IS NOT NULL) AS tasks_with_position,
  (SELECT COUNT(*) FROM im_tasks) AS total_tasks,
  (SELECT COUNT(*) FROM im_tasks WHERE JSON_CONTAINS_PATH(
    metadata, 'one', '$.kanban', '$.columnId', '$.cardOrder', '$.cardStatus', '$.cardPriority'
  )) AS tasks_with_legacy_kanban;
