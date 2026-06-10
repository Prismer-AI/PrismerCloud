-- ============================================================================
-- Migration 342: v2.0 — im_tasks.position DOUBLE + kanban order index
-- Date: 2026-05-19
-- Spec: docs/release200/15-task-state-machine-and-kanban.md §1.1, §8
--
-- Background
-- ----------
-- Kanban view fields (status, position) become first-class columns instead of
-- metadata JSON. `position` is a FLOAT/DOUBLE used by the B-tree midpoint
-- algorithm for manual card reordering inside a column.
--
-- Operations
-- ----------
-- 1. ADD COLUMN position DOUBLE NULL on im_tasks (nullable; backfilled by 345)
-- 2. CREATE INDEX idx_im_tasks_workspace_status_position
--      ON im_tasks (workspaceId, status, position)
--    This is the canonical kanban-board query index.
--
-- Idempotent: information_schema-guarded ADD COLUMN + CREATE INDEX.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _342_add_col_if_missing$$
CREATE PROCEDURE _342_add_col_if_missing(
  IN p_table VARCHAR(64),
  IN p_col VARCHAR(64),
  IN p_def TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND column_name = p_col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_col, '` ', p_def);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DROP PROCEDURE IF EXISTS _342_add_idx_if_missing$$
CREATE PROCEDURE _342_add_idx_if_missing(
  IN p_table VARCHAR(64),
  IN p_idx VARCHAR(128),
  IN p_cols TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND index_name = p_idx
  ) THEN
    SET @sql = CONCAT('CREATE INDEX `', p_idx, '` ON `', p_table, '` (', p_cols, ')');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

-- 1. position column (DOUBLE, nullable, backfilled in 345)
CALL _342_add_col_if_missing(
  'im_tasks',
  'position',
  'DOUBLE NULL'
);

-- 2. composite index for kanban-board reads
CALL _342_add_idx_if_missing(
  'im_tasks',
  'idx_im_tasks_workspace_status_position',
  '`workspaceId`, `status`, `position`'
);

DROP PROCEDURE _342_add_col_if_missing;
DROP PROCEDURE _342_add_idx_if_missing;

SELECT 'migration 342 v200 task position column + index complete' AS status;
