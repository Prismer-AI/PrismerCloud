-- Migration 456: release202/09 §3.3 — capability-stack governance flags
-- Date: 2026-06-04
-- Spec: docs/release202/09-capability-stack-and-file-delivery-overhaul.md §3.3 + §5 (P4)
--
-- Add 2 columns to im_skills:
--   • is_system        BOOLEAN — true = system-capability built-in (A-list).
--                      Makes the old soft predicate
--                      `source='prismer' AND category='built-in'` explicit.
--   • default_enabled  BOOLEAN — true = auto-installed onto NEW agents by default.
--                      General (B-list) built-ins seed `false` so the owner
--                      re-enables them one-by-one via /admin/skills.
--
-- Why: we stopped installing the full 26-skill catalog to every agent. Only the
-- 15 system (A-list) built-ins are default-installed going forward; the 10
-- general (B-list) built-ins are catalog-visible but default-off.
--
-- Backfill is by slug for source='prismer' built-ins only. It does NOT touch any
-- per-agent install rows (im_agent_skills) — existing agents keep whatever they
-- already have. This migration is catalog-level metadata only.
--
-- Idempotent: each ADD COLUMN is guarded by an INFORMATION_SCHEMA check
-- (same pattern as 317/318/etc.). UPDATE statements are naturally idempotent.

SET @col_is_system := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'im_skills'
    AND COLUMN_NAME = 'is_system'
);
SET @stmt := IF(
  @col_is_system = 0,
  'ALTER TABLE im_skills ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT FALSE',
  'SELECT 1'
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @col_default_enabled := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'im_skills'
    AND COLUMN_NAME = 'default_enabled'
);
SET @stmt := IF(
  @col_default_enabled = 0,
  'ALTER TABLE im_skills ADD COLUMN default_enabled BOOLEAN NOT NULL DEFAULT FALSE',
  'SELECT 1'
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- A-list (system capability, 15) — isSystem=1, defaultEnabled=1.
-- These are auto-installed onto every new agent.
UPDATE im_skills
  SET is_system = TRUE, default_enabled = TRUE
  WHERE source = 'prismer'
    AND slug IN (
      'agent-coordination',
      'agent-meta',
      'assets',
      'claim-agent-ownership',
      'human-approval',
      'image-generate',
      'ingest',
      'liteparse',
      'memory',
      'memory-curation',
      'office-artifacts',
      'prismer-im-collab',
      'skill-authoring',
      'tasks',
      'team'
    );

-- B-list (general, 10) — isSystem=0, defaultEnabled=0.
-- Catalog-visible but NOT auto-installed; owner enables per-agent via /admin/skills.
UPDATE im_skills
  SET is_system = FALSE, default_enabled = FALSE
  WHERE source = 'prismer'
    AND slug IN (
      'canvas-design',
      'claude-api',
      'doc-coauthoring',
      'frontend-design',
      'internal-comms',
      'mcp-builder',
      'skill-creator',
      'slack-gif-creator',
      'web-artifacts-builder',
      'webapp-testing'
    );

-- Tracking handled by scripts/db-migrate.sh; no manual _migrations INSERT.
