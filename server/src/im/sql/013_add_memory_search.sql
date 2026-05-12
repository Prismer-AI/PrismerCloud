-- ============================================================================
-- Migration 013: Knowledge Layer Search Infrastructure
-- Version: v1.7.2
-- Date: 2026-03-16 (m3 phase 2 rewrite: 2026-05-02)
--
-- Adds search capabilities to Memory and Context layers:
--   1. FULLTEXT index on im_memory_files.content
--   2. tags column on im_context_cache
--
-- Track A m3 phase 2 fix: original 013 line 15 used `TEXT NOT NULL DEFAULT
-- '[]'` which MySQL 8.0 strict mode rejects (literal DEFAULT not allowed on
-- TEXT/JSON/BLOB). Switched to MySQL 8.0.13+ expression-default syntax
-- `DEFAULT ('[]')`. Both ALTERs wrapped in INFORMATION_SCHEMA guards for
-- re-run safety.
-- ============================================================================

-- Guard 1: FULLTEXT index on im_memory_files.content
SET @idx := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'im_memory_files'
     AND INDEX_NAME = 'ft_memory_content'
);
SET @tbl := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'im_memory_files'
);
SET @stmt := IF(
  @tbl > 0 AND @idx = 0,
  'ALTER TABLE im_memory_files ADD FULLTEXT INDEX ft_memory_content (content)',
  'SELECT ''skip ft_memory_content: missing table or already exists'' AS status'
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Guard 2: ADD COLUMN tags TEXT NOT NULL DEFAULT ('[]') — expression-default
-- syntax supported by MySQL 8.0.13+.
SET @col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'im_context_cache'
     AND COLUMN_NAME = 'tags'
);
SET @tbl := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'im_context_cache'
);
SET @stmt := IF(
  @tbl > 0 AND @col = 0,
  'ALTER TABLE im_context_cache ADD COLUMN tags TEXT NOT NULL DEFAULT (''[]'') AFTER meta',
  'SELECT ''skip tags: missing table or already exists'' AS status'
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SELECT 'migration 013 complete' AS status;
