-- ============================================================================
-- Migration 328: v5.4 — Asset dedup key follows sourceRef
-- Date: 2026-05-13
--
-- The runtime drop-folder producer must allow identical bytes in different
-- workspace folders. Older schemas enforce workspace+contentHash uniqueness
-- (`uk_ws_hash` from 100, or Prisma's workspaceId_contentHash_deletedAt key),
-- which makes the second path fail at INSERT time. Replace those constraints
-- with a path-aware key. API-level dedup still handles generic uploads that
-- do not carry sourceRef.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _328_drop_idx_if_exists$$
CREATE PROCEDURE _328_drop_idx_if_exists(
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

DROP PROCEDURE IF EXISTS _328_add_unique_if_missing$$
CREATE PROCEDURE _328_add_unique_if_missing(
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
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD UNIQUE INDEX `', p_idx, '` (', p_cols, ')');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

CALL _328_drop_idx_if_exists('im_assets', 'uk_ws_hash');
CALL _328_drop_idx_if_exists('im_assets', 'im_assets_workspaceId_contentHash_key');
CALL _328_drop_idx_if_exists('im_assets', 'im_assets_workspaceId_contentHash_deletedAt_key');

CALL _328_add_unique_if_missing(
  'im_assets',
  'uk_im_assets_ws_hash_source_deleted',
  '`workspaceId`, `contentHash`, `sourceRef`, `deletedAt`'
);

DROP PROCEDURE IF EXISTS _328_drop_idx_if_exists;
DROP PROCEDURE IF EXISTS _328_add_unique_if_missing;

SELECT 'migration 328 complete' AS status;
