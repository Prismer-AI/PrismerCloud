-- ============================================================================
-- Migration 305: v1.9.7 — Workspace asset ingest/index fields
-- Date: 2026-05-07
--
-- Extends im_assets for derived artifacts, asset-index sync, source refs, and
-- ingest status. Creates im_asset_index_counters for workspace-wide monotonic
-- asset index allocation. Idempotent: every column/index/table is guarded.
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS _305_add_col_if_missing$$
CREATE PROCEDURE _305_add_col_if_missing(
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

DROP PROCEDURE IF EXISTS _305_add_idx_if_missing$$
CREATE PROCEDURE _305_add_idx_if_missing(
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

DROP PROCEDURE IF EXISTS _305_create_table_if_missing$$
CREATE PROCEDURE _305_create_table_if_missing(
  IN p_table VARCHAR(64),
  IN p_ddl TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name = p_table
  ) THEN
    SET @sql = p_ddl;
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

CALL _305_add_col_if_missing('im_assets', 'updatedAt', 'DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)');
CALL _305_add_col_if_missing('im_assets', 'parentAssetId', 'VARCHAR(30) NULL');
CALL _305_add_col_if_missing('im_assets', 'derivationKind', 'VARCHAR(32) NULL');
CALL _305_add_col_if_missing('im_assets', 'ingestStatus', 'VARCHAR(32) NOT NULL DEFAULT ''pending''');
CALL _305_add_col_if_missing('im_assets', 'ingestVersion', 'INT NOT NULL DEFAULT 1');
CALL _305_add_col_if_missing('im_assets', 'ingestError', 'TEXT NULL');
CALL _305_add_col_if_missing('im_assets', 'assetIndexSeq', 'BIGINT NOT NULL DEFAULT 0');
CALL _305_add_col_if_missing('im_assets', 'cdnUrl', 'VARCHAR(500) NULL');
CALL _305_add_col_if_missing('im_assets', 'previewAssetId', 'VARCHAR(30) NULL');
CALL _305_add_col_if_missing('im_assets', 'folderPath', 'VARCHAR(700) NULL');
CALL _305_add_col_if_missing('im_assets', 'filename', 'VARCHAR(500) NULL');
CALL _305_add_col_if_missing('im_assets', 'sourceRef', 'VARCHAR(500) NULL');
CALL _305_add_col_if_missing('im_assets', 'sourceKind', 'VARCHAR(32) NULL');
CALL _305_add_col_if_missing('im_assets', 'sourceMetadata', 'TEXT NULL');
CALL _305_add_col_if_missing('im_assets', 'revision', 'INT NOT NULL DEFAULT 1');
CALL _305_add_col_if_missing('im_assets', 'visibility', 'VARCHAR(50) NOT NULL DEFAULT ''workspace''');
CALL _305_add_col_if_missing('im_assets', 'aclJson', 'TEXT NULL');

CALL _305_create_table_if_missing('im_asset_index_counters', '
CREATE TABLE im_asset_index_counters (
  workspaceId VARCHAR(30) NOT NULL,
  nextSeq     BIGINT      NOT NULL DEFAULT 1,
  updatedAt   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (workspaceId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
');

CALL _305_add_idx_if_missing('im_assets', 'idx_im_assets_workspace_asset_index_seq', '`workspaceId`, `assetIndexSeq`');
CALL _305_add_idx_if_missing('im_assets', 'idx_im_assets_workspace_source_ref', '`workspaceId`, `sourceRef`');
CALL _305_add_idx_if_missing('im_assets', 'idx_im_assets_workspace_ingest_status', '`workspaceId`, `ingestStatus`');
CALL _305_add_idx_if_missing('im_assets', 'idx_im_assets_workspace_parent_asset', '`workspaceId`, `parentAssetId`');
CALL _305_add_idx_if_missing('im_assets', 'idx_im_assets_workspace_preview_asset', '`workspaceId`, `previewAssetId`');

DROP PROCEDURE IF EXISTS _305_add_col_if_missing;
DROP PROCEDURE IF EXISTS _305_add_idx_if_missing;
DROP PROCEDURE IF EXISTS _305_create_table_if_missing;

SELECT 'migration 305 complete' AS status;
