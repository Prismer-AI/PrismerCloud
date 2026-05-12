-- Migration 319 — M-D (doc 25 §4)
--
-- Numbering: bumped from 317 to 319 to avoid collision with Line B's
-- 317_v54_asset_description.sql and 318_v54_ingest_claims.sql, which
-- land before this one in the refactor stack.
--
-- Adds parallel HTML source fields to im_memory_pages. HTML is INDEPENDENT
-- from `content` (markdown), not a derivation. Two writable fields:
--
--   content            — markdown source (existing). Agents, ingest pipeline,
--                        CLI editors write this.
--   contentHtml        — HTML source (new). Library rich-text editor writes
--                        this directly. Backfill cron may also derive it from
--                        `content` for historical rows where it is NULL.
--   contentHtmlVersion — render-pipeline version for derived rows; 0 means
--                        user-authored (backfill cron never re-renders these).
--
-- Markdown writes do NOT clobber existing contentHtml.
-- HTML writes do NOT clobber existing content.
-- See `src/lib/markdown-render.ts` for the render pipeline + version constant.

-- Idempotent column adds — repeated migration runs (replays / partial fail
-- recovery) skip columns that already exist.
DROP PROCEDURE IF EXISTS _add_col_content_html;
DELIMITER //
CREATE PROCEDURE _add_col_content_html()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'im_memory_pages'
      AND COLUMN_NAME = 'contentHtml'
  ) THEN
    ALTER TABLE im_memory_pages ADD COLUMN contentHtml LONGTEXT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'im_memory_pages'
      AND COLUMN_NAME = 'contentHtmlVersion'
  ) THEN
    ALTER TABLE im_memory_pages ADD COLUMN contentHtmlVersion INT NULL DEFAULT 0;
  END IF;
END //
DELIMITER ;

CALL _add_col_content_html();
DROP PROCEDURE _add_col_content_html;
