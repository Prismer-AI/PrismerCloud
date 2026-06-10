-- release201/08 §5.1 — Skill lifecycle SOP columns
--
-- Add 2 columns to im_skills:
--   • lifecycle_stage  VARCHAR(20)  — draft|eval|review|published|archived
--   • publish_scope    VARCHAR(16)  — private|workspace|org|community
--
-- Backfill existing rows so the column is non-NULL safe before service writes
-- treat it as authoritative. Mapping is conservative (see doc §5.1):
--   • status='active'     → published
--   • status='deprecated' → archived
--   • source in (clawhub, awesome-openclaw, prismer)  → publish_scope=community
--   • source='community' & workspaceId IS NOT NULL    → publish_scope=workspace
--   • source='community' & workspaceId IS NULL        → publish_scope=private
--
-- Idempotent: re-runnable; DDL is guarded by INFORMATION_SCHEMA checks at the
-- shell wrapper layer (src/im/sql/README.md). UPDATE statements are safe to
-- re-run.

ALTER TABLE im_skills
  ADD COLUMN lifecycle_stage VARCHAR(20) NOT NULL DEFAULT 'published',
  ADD COLUMN publish_scope   VARCHAR(16) NOT NULL DEFAULT 'private',
  ADD INDEX idx_lifecycle_stage (lifecycle_stage),
  ADD INDEX idx_publish_scope (publish_scope);

-- Historical backfill — keep rows already in marketplace search visible.
UPDATE im_skills SET lifecycle_stage='published'
  WHERE status='active';

UPDATE im_skills SET lifecycle_stage='archived'
  WHERE status='deprecated';

UPDATE im_skills SET publish_scope='community'
  WHERE source IN ('clawhub','awesome-openclaw','prismer');

UPDATE im_skills SET publish_scope='workspace'
  WHERE source='community' AND workspaceId IS NOT NULL;

UPDATE im_skills SET publish_scope='private'
  WHERE source='community' AND workspaceId IS NULL;

-- Draft rows produced by release201/07 skill-authoring engine:
-- align lifecycle_stage with status so the unified invariant holds
--   lifecycle_stage IN (draft,eval,review) ↔ status='draft'
UPDATE im_skills SET lifecycle_stage='draft', publish_scope='private'
  WHERE status='draft';
