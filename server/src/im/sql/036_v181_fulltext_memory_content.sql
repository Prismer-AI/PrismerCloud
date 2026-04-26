-- v1.8.1: Add FULLTEXT index on im_memory_files.content
--
-- WHY: The existing FULLTEXT index is only on (path, description).
-- This works for reference/fact/semantic memory where the description
-- contains query-relevant keywords. But for episodic memory (conversations),
-- the relevant keywords (person names, events, dates) are in the content
-- body, not in the description. Without indexing content, the search falls
-- back to slow LIKE '%word%' queries that miss most results.
--
-- IMPACT: LoCoMo benchmark with Kimi K2.5 scored 0% non-adversarial
-- because the recall API couldn't find conversation content by keyword.
-- Adding this index enables MATCH(content) AGAINST(...) in the search query.
--
-- SAFE: MySQL supports FULLTEXT on MEDIUMTEXT. Online DDL (non-blocking)
-- in MySQL 5.7+/8.0+. ~234 files currently, negligible build time.
-- Existing queries are unaffected (they reference the old index explicitly).

ALTER TABLE im_memory_files
  ADD FULLTEXT INDEX idx_ft_memory_content (content);
