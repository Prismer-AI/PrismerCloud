-- 131_v195_asset_deleted_at.sql
-- Cloud 2.5 — adds soft-delete to im_assets.

DELIMITER $$
DROP PROCEDURE IF EXISTS _v195_add_deleted_at $$
CREATE PROCEDURE _v195_add_deleted_at()
BEGIN
  DECLARE col_exists INT DEFAULT 0;
  SELECT COUNT(*) INTO col_exists
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'im_assets'
     AND column_name = 'deletedAt';
  IF col_exists = 0 THEN
    ALTER TABLE im_assets ADD COLUMN deletedAt DATETIME(3) NULL;
  END IF;

  SELECT COUNT(*) INTO col_exists
    FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'im_assets'
     AND index_name = 'im_assets_workspaceId_deletedAt_idx';
  IF col_exists = 0 THEN
    CREATE INDEX im_assets_workspaceId_deletedAt_idx ON im_assets (workspaceId, deletedAt);
  END IF;

  -- Replace single-column unique (workspaceId, contentHash) with three-column
  -- unique (workspaceId, contentHash, deletedAt) so re-upload after soft-delete
  -- can succeed (NULL distinct in MySQL composite unique).
  SELECT COUNT(*) INTO col_exists
    FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'im_assets'
     AND index_name = 'im_assets_workspaceId_contentHash_deletedAt_key';
  IF col_exists = 0 THEN
    -- Drop the legacy unique. Prisma's default name is `<table>_<col1>_<col2>_key`.
    SELECT COUNT(*) INTO col_exists
      FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = 'im_assets'
       AND index_name = 'im_assets_workspaceId_contentHash_key';
    IF col_exists > 0 THEN
      ALTER TABLE im_assets DROP INDEX im_assets_workspaceId_contentHash_key;
    END IF;
    -- The 3-column composite unique. NULL columns participate distinctly in MySQL.
    CREATE UNIQUE INDEX im_assets_workspaceId_contentHash_deletedAt_key
      ON im_assets (workspaceId, contentHash, deletedAt);
  END IF;
END $$
DELIMITER ;

CALL _v195_add_deleted_at();
DROP PROCEDURE _v195_add_deleted_at;
