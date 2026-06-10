-- ============================================================================
-- Migration 340: v2.0.0 — bump device default maxAgents 3 → 10
-- Date: 2026-05-19
-- Track: §30 Unified Creation Interface — device capacity policy update
--
-- Background
-- ----------
-- Migration 323 introduced `im_containers.maxAgents` with `DEFAULT 3` to match
-- the v5.4 base Web subscription quota. v2.0.0 raises the ceiling to 10 so a
-- single sandbox pod can host a richer agency team (Simple-mode users now have
-- ~205 role templates to choose from after the agency-agents import).
--
-- Two changes:
--   1. ALTER the column default so newly-provisioned containers start at 10.
--   2. Bump existing rows whose maxAgents is still the legacy default 3 to 10.
--      Rows that have been manually customised (any value != 3) are left alone.
--
-- Idempotent: re-running the migration is a no-op (the DEFAULT change is
-- idempotent; the UPDATE only touches rows still at 3).
-- ============================================================================

ALTER TABLE im_containers ALTER COLUMN maxAgents SET DEFAULT 10;

UPDATE im_containers SET maxAgents = 10 WHERE maxAgents = 3;
