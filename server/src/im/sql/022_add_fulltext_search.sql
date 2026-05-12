-- v1.7.2: Add FULLTEXT indexes for skill and gene search
-- Requires MySQL 5.7+ / InnoDB
--
-- Track A m1+ regression fix (2026-05-02): wrapped each ADD FULLTEXT INDEX
-- in INFORMATION_SCHEMA guards. Reasons:
--   1. New 012_add_skill_catalog.sql now creates im_skills with the FULLTEXT
--      indexes already attached, so a fresh dev chain run would otherwise
--      hit duplicate-index errors here.
--   2. Original 022 also referenced the `signals` column, which is added by
--      023 (later in the lex chain) — fresh runs failed even before the new
--      012 because of this cross-dep. Guard makes it irrelevant.
-- Behaviour on environments where 022 was already applied (prod): all three
-- guards detect existing index → no-op. Safe to re-run.

-- Guard 1: ft_skills_search (name, description, tags)
SET @idx := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'im_skills'
     AND INDEX_NAME = 'ft_skills_search'
);
SET @stmt := IF(
  @idx = 0,
  'ALTER TABLE im_skills ADD FULLTEXT INDEX ft_skills_search (name, description, tags)',
  'SELECT ''skip ft_skills_search: already exists'' AS status'
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Guard 2: ft_skills_signals (signals) — also requires `signals` column to exist
SET @idx := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'im_skills'
     AND INDEX_NAME = 'ft_skills_signals'
);
SET @col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'im_skills'
     AND COLUMN_NAME = 'signals'
);
SET @stmt := IF(
  @idx = 0 AND @col > 0,
  'ALTER TABLE im_skills ADD FULLTEXT INDEX ft_skills_signals (signals)',
  'SELECT ''skip ft_skills_signals: already exists or signals column missing'' AS status'
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Guard 3: ft_genes_search (title, description, strategySteps)
SET @idx := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'im_genes'
     AND INDEX_NAME = 'ft_genes_search'
);
SET @stmt := IF(
  @idx = 0,
  'ALTER TABLE im_genes ADD FULLTEXT INDEX ft_genes_search (title, description, strategySteps)',
  'SELECT ''skip ft_genes_search: already exists'' AS status'
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
