-- ============================================================================
-- Migration 013: Knowledge Layer Search Infrastructure
-- Version: v1.7.2
-- Date: 2026-03-16
--
-- Adds search capabilities to Memory and Context layers:
--   1. FULLTEXT index on im_memory_files.content
--   2. tags column on im_context_cache
-- ============================================================================

-- ─── Memory FULLTEXT Index ──────────────────────────────
ALTER TABLE im_memory_files ADD FULLTEXT INDEX ft_memory_content (content);

-- ─── Context Cache Tags ─────────────────────────────────
ALTER TABLE im_context_cache ADD COLUMN tags TEXT NOT NULL DEFAULT '[]' AFTER meta;

-- ─── Verify ─────────────────────────────────────────────
SELECT 'im_memory_files FULLTEXT' AS `index`, COUNT(*) AS `rows` FROM im_memory_files
UNION ALL
SELECT 'im_context_cache tags', COUNT(*) FROM im_context_cache;
