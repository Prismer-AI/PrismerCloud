-- Migration 035: Add FULLTEXT index on im_genes for /recall evolution search
--
-- Before this, /recall?scope=all's evolution branch used capsule.signalKey `LIKE '%query%'`
-- which never matches natural language queries. With this FULLTEXT index, the evolution
-- branch can use MATCH(title, description) AGAINST(query IN BOOLEAN MODE) to find genes
-- whose title/description mention the query keywords — enabling real source diversity
-- in convergence metrics (previously stuck at 0.6%).
--
-- Safe: ADD INDEX is non-blocking on InnoDB for FULLTEXT indexes.
-- Rollback: DROP INDEX ft_genes_title_desc ON im_genes;

ALTER TABLE im_genes ADD FULLTEXT INDEX ft_genes_title_desc (title, description(500));
