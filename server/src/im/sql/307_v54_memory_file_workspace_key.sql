-- ============================================================================
-- Migration 307: v5.4 — im_memory_files workspace key bridge closeout
-- Date: 2026-05-07
--
-- Adds Phase A bridge metadata fields and flips legacy memory files from the
-- owner/path namespace to workspace/path. Historical same-workspace path
-- collisions are preserved by moving non-winner rows under agents/<ownerId>/dup-<id>.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _307_add_col_if_missing$$
CREATE PROCEDURE _307_add_col_if_missing(
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

DROP PROCEDURE IF EXISTS _307_add_idx_if_missing$$
CREATE PROCEDURE _307_add_idx_if_missing(
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
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD INDEX `', p_idx, '` (', p_cols, ')');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DROP PROCEDURE IF EXISTS _307_add_unique_idx_if_missing$$
CREATE PROCEDURE _307_add_unique_idx_if_missing(
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

DROP PROCEDURE IF EXISTS _307_drop_idx_if_exists$$
CREATE PROCEDURE _307_drop_idx_if_exists(
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

DELIMITER ;

CALL _307_add_col_if_missing('im_memory_files', 'visibility', 'VARCHAR(50) NOT NULL DEFAULT ''workspace''');
CALL _307_add_col_if_missing('im_memory_files', 'aclJson', 'TEXT NULL');
CALL _307_add_col_if_missing('im_memory_files', 'encrypted', 'BOOLEAN NOT NULL DEFAULT FALSE');
CALL _307_add_col_if_missing('im_memory_files', 'contentHash', 'CHAR(64) NULL');
CALL _307_add_col_if_missing('im_memory_files', 'etag', 'VARCHAR(64) NULL');
CALL _307_add_col_if_missing('im_memory_files', 'sourceKind', 'VARCHAR(32) NULL');
CALL _307_add_col_if_missing('im_memory_files', 'sourceRef', 'VARCHAR(500) NULL');

UPDATE im_memory_files
SET contentHash = SHA2(COALESCE(content, ''), 256)
WHERE contentHash IS NULL OR contentHash = '';

UPDATE im_memory_files
SET etag = contentHash
WHERE etag IS NULL OR etag = '';

ALTER TABLE im_memory_files
  MODIFY COLUMN contentHash CHAR(64) NOT NULL;

CREATE TEMPORARY TABLE _307_memory_collision_winners AS
SELECT workspaceId, path, MAX(updatedAt) AS winnerUpdatedAt
FROM im_memory_files
GROUP BY workspaceId, path
HAVING COUNT(*) > 1;

UPDATE im_memory_files f
JOIN _307_memory_collision_winners w
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

DROP TEMPORARY TABLE IF EXISTS _307_memory_collision_winners;

CALL _307_drop_idx_if_exists('im_memory_files', 'im_memory_files_ownerId_path_key');
CALL _307_drop_idx_if_exists('im_memory_files', 'ownerId_path');

CALL _307_add_unique_idx_if_missing('im_memory_files', 'im_memory_files_workspaceId_path_key', '`workspaceId`, `path`');
CALL _307_add_idx_if_missing('im_memory_files', 'idx_im_memory_files_workspace_source_ref', '`workspaceId`, `sourceRef`');

DROP PROCEDURE IF EXISTS _307_add_col_if_missing;
DROP PROCEDURE IF EXISTS _307_add_idx_if_missing;
DROP PROCEDURE IF EXISTS _307_add_unique_idx_if_missing;
DROP PROCEDURE IF EXISTS _307_drop_idx_if_exists;

SELECT 'migration 307 complete' AS status;
