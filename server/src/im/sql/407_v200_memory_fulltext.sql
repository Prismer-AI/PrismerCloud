-- ============================================================================
-- Migration 407: v2.0 — Memory FULLTEXT indexes for daemon-first recall
-- Date: 2026-05-21
-- Spec: docs/release200/14-messaging-state-machine-reliability.md §4.7
--
-- Background
-- ----------
-- §4.7 Track-F: cloud-side memory search currently uses code-level TF-IDF.
-- v1.8.1 added `ft_memory_content` on im_memory_files.content; v2.0 adds
-- the missing index on im_memory_pages.content for page-level search, plus
-- a composite FULLTEXT on im_memory_files (path, description) — both feed
-- the MATCH ... AGAINST path that replaces the application-layer TF-IDF
-- (mirrors the v1.8.1 community FULLTEXT pattern).
--
-- Note: doc §4.7 originally specified `ft_title_summary (title, summary)`
-- but im_memory_files schema does not have title/summary columns — actual
-- searchable text fields are `path / description / content`. Adjusted
-- accordingly. `ft_memory_content` (existing in v1.8.1) is the canonical
-- content FULLTEXT and is NOT re-created here.
--
-- Schema deltas
-- -------------
-- ADD FULLTEXT INDEX im_memory_pages.ft_page_content ON (content)
-- ADD FULLTEXT INDEX im_memory_files.ft_memory_path_desc ON (path, description)
--   (composite for combined `MATCH(path, description) AGAINST(?)`)
--
-- Idempotent
-- ----------
-- Index add guarded by information_schema.
-- ============================================================================

DROP PROCEDURE IF EXISTS pc_v200_memory_fulltext;
DELIMITER //
CREATE PROCEDURE pc_v200_memory_fulltext()
BEGIN
  -- ─── im_memory_pages.content ─────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_memory_pages'
      AND index_name = 'ft_page_content'
  ) THEN
    CREATE FULLTEXT INDEX ft_page_content ON im_memory_pages (content);
  END IF;

  -- ─── im_memory_files (path, description) composite ───────────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'im_memory_files'
      AND index_name = 'ft_memory_path_desc'
  ) THEN
    CREATE FULLTEXT INDEX ft_memory_path_desc ON im_memory_files (path, description);
  END IF;
END//
DELIMITER ;
CALL pc_v200_memory_fulltext();
DROP PROCEDURE pc_v200_memory_fulltext;

SELECT
  'migration 407 v200 memory fulltext complete' AS status,
  (SELECT COUNT(*) FROM im_memory_pages) AS total_pages,
  (SELECT COUNT(*) FROM im_memory_files) AS total_memory_files;
