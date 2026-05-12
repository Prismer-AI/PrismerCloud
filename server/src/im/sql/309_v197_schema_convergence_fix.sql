-- ============================================================================
-- Migration 309: v1.9.7 schema convergence fix
-- Date: 2026-05-08
--
-- Repairs already-migrated DBs whose 307/308 shapes drifted from
-- prisma/schema.mysql.prisma.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _309_add_unique_idx_if_missing$$
CREATE PROCEDURE _309_add_unique_idx_if_missing(
  IN p_table VARCHAR(64),
  IN p_idx VARCHAR(64),
  IN p_cols TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND index_name = p_idx
      AND non_unique = 0
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD UNIQUE KEY `', p_idx, '` (', p_cols, ')');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DROP PROCEDURE IF EXISTS _309_drop_idx_if_exists$$
CREATE PROCEDURE _309_drop_idx_if_exists(
  IN p_table VARCHAR(64),
  IN p_idx VARCHAR(64)
)
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND index_name = p_idx
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` DROP INDEX `', p_idx, '`');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DROP PROCEDURE IF EXISTS _309_fix_memory_files$$
CREATE PROCEDURE _309_fix_memory_files()
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name = 'im_memory_files'
  ) THEN
    DROP TEMPORARY TABLE IF EXISTS _309_memory_collision_winners;
    CREATE TEMPORARY TABLE _309_memory_collision_winners AS
    SELECT workspaceId, path, MAX(updatedAt) AS winnerUpdatedAt
    FROM im_memory_files
    GROUP BY workspaceId, path
    HAVING COUNT(*) > 1;

    UPDATE im_memory_files f
    JOIN _309_memory_collision_winners w
      ON f.workspaceId = w.workspaceId
     AND f.path = w.path
     AND f.updatedAt < w.winnerUpdatedAt
    SET f.path = CONCAT('agents/', f.ownerId, '/dup-', f.id);

    UPDATE im_memory_files f
    JOIN (
      SELECT workspaceId, path, id
      FROM (
        SELECT
          workspaceId,
          path,
          id,
          ROW_NUMBER() OVER (PARTITION BY workspaceId, path ORDER BY updatedAt DESC, id DESC) AS rn
        FROM im_memory_files
      ) ranked
      WHERE rn > 1
    ) d ON d.id = f.id
    SET f.path = CONCAT('agents/', f.ownerId, '/dup-', f.id);

    DROP TEMPORARY TABLE IF EXISTS _309_memory_collision_winners;
    CALL _309_drop_idx_if_exists('im_memory_files', 'im_memory_files_workspaceId_path_key');
    CALL _309_add_unique_idx_if_missing('im_memory_files', 'im_memory_files_workspaceId_path_key', '`workspaceId`, `path`');
  END IF;
END$$

DROP PROCEDURE IF EXISTS _309_fix_task_runs$$
CREATE PROCEDURE _309_fix_task_runs()
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name = 'im_task_runs'
  ) THEN
    ALTER TABLE im_task_runs
      MODIFY COLUMN runtimeRoute VARCHAR(20) NULL DEFAULT 'agent',
      MODIFY COLUMN input TEXT NOT NULL DEFAULT (_utf8mb4'{}'),
      MODIFY COLUMN metadata TEXT NOT NULL DEFAULT (_utf8mb4'{}');
  END IF;
END$$

DROP PROCEDURE IF EXISTS _309_fix_task_events$$
CREATE PROCEDURE _309_fix_task_events()
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name = 'im_task_events'
  ) THEN
    ALTER TABLE im_task_events
      MODIFY COLUMN payload TEXT NOT NULL DEFAULT (_utf8mb4'{}');
  END IF;
END$$

DELIMITER ;

CALL _309_fix_memory_files();
CALL _309_fix_task_runs();
CALL _309_fix_task_events();

DROP PROCEDURE IF EXISTS _309_fix_memory_files;
DROP PROCEDURE IF EXISTS _309_fix_task_runs;
DROP PROCEDURE IF EXISTS _309_fix_task_events;
DROP PROCEDURE IF EXISTS _309_add_unique_idx_if_missing;
DROP PROCEDURE IF EXISTS _309_drop_idx_if_exists;

SELECT 'migration 309 complete' AS status;
