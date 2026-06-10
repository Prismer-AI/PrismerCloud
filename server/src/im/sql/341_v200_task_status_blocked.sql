-- ============================================================================
-- Migration 341: v2.0 — Task state machine, add 'blocked' status
-- Date: 2026-05-19
-- Spec: docs/release200/15-task-state-machine-and-kanban.md §5.1
--
-- Background
-- ----------
-- The release-200 task state machine adds 'blocked' to the 8-state enum:
--   pending | assigned | running | review | blocked | completed | failed | cancelled
--
-- Status discriminator policy
-- ---------------------------
-- `im_tasks.status` is VARCHAR(20) (NOT a MySQL ENUM column). The valid value
-- set is enforced at the application layer via:
--   * `src/im/types/index.ts` :: TaskStatus union
--   * `src/im/services/task.service.ts` transition validator (P3 work)
--
-- Schema-level: no DDL change required for this migration. Application code
-- updated in parallel (TaskStatus union extended with 'blocked').
--
-- Why not promote to ENUM?
-- ------------------------
-- The contemporary 333_v200_sandbox_status_enum.sql lifted im_containers.status
-- to a real ENUM. For tasks we deliberately stay on VARCHAR because the
-- task state machine churns more often (workflow features, paid review flow)
-- and ALTER TABLE MODIFY COLUMN cost on a large im_tasks table outweighs the
-- DB-level guard benefit. Application invariants are the source of truth.
--
-- Idempotent: no-op DDL. Safe to re-run.
-- ============================================================================

-- Sanity probe: the column exists and is the expected type. If somebody
-- inadvertently promoted it to ENUM without 'blocked', the next INSERT/UPDATE
-- with status='blocked' will fail loudly — this SELECT surfaces the drift
-- during migration apply.
SELECT
  COLUMN_TYPE AS task_status_column_type,
  IS_NULLABLE,
  COLUMN_DEFAULT
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND table_name = 'im_tasks'
  AND column_name = 'status';

SELECT 'migration 341 v200 task status blocked (app-layer enum) complete' AS status;
