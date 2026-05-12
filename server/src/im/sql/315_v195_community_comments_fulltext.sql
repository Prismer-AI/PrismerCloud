-- ============================================================================
-- Migration 315: v1.9.5 — FULLTEXT index on im_community_comments.content
-- Date: 2026-05-10
-- Track: hotfix for v1.9.56 test deploy
--
-- Background
-- ----------
-- CommunitySearchService.searchCommentsMysql runs:
--   MATCH(c.content) AGAINST (? IN BOOLEAN MODE)
-- against im_community_comments. Migration 031 only created a FULLTEXT
-- index on im_community_posts(title, content) — comments were left out.
-- The query falls back gracefully (the service catches and substitutes
-- LIKE-based search), so this is non-blocking, but the FULLTEXT path is
-- the intended fast path and the warn-spam pollutes prod logs.
--
-- Idempotent: index creation guards on information_schema.statistics.
-- ============================================================================

DROP PROCEDURE IF EXISTS _315_add_fulltext_if_missing;
DELIMITER //
CREATE PROCEDURE _315_add_fulltext_if_missing(
  IN p_table VARCHAR(64),
  IN p_idx VARCHAR(64),
  IN p_cols VARCHAR(255)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND index_name = p_idx
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD FULLTEXT INDEX `', p_idx, '` (', p_cols, ')');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL _315_add_fulltext_if_missing('im_community_comments', 'ft_comment_content', '`content`');

DROP PROCEDURE _315_add_fulltext_if_missing;
