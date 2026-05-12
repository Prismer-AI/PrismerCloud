-- 317_v54_asset_description.sql — Wave-54 B2
--
-- Add IMAsset.description column (VARCHAR(500), nullable).
-- Surfaced in POST /assets, POST /assets/:id/derived, PATCH /assets/:id, and
-- in the DTO returned by list/detail/by-hash/index. Intended as an
-- agent-authored hint ("what this asset is for") so a different agent
-- consuming the same Library row gets useful context without having to
-- re-parse the file. See docs/54release/26-asset-multi-tier-sync.md
-- (asset.description hint column).
--
-- Safe to apply on populated tables: column is nullable with no default
-- backfill, so no rewrite. Idempotent guard via INFORMATION_SCHEMA check.

SET @col_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'im_assets'
    AND COLUMN_NAME = 'description'
);

SET @stmt := IF(
  @col_exists = 0,
  'ALTER TABLE im_assets ADD COLUMN description VARCHAR(500) NULL AFTER aclJson',
  'SELECT 1'
);

PREPARE s FROM @stmt;
EXECUTE s;
DEALLOCATE PREPARE s;
