-- ============================================================================
-- Migration 314: v1.9.5 — Relax workspaceId NOT NULL back to NULLable
-- Date: 2026-05-10
-- Track: hotfix for v1.9.56 test deploy regression
--
-- Background
-- ----------
-- Migration 120 (v1.9.3 phase 2) flipped `workspaceId` to NOT NULL on 11
-- "owned" tables. The intent was that every row would have a workspace
-- owner after the m2 backfill. In practice, several legitimate write
-- paths produce rows with no workspace context:
--
--   • IMEvolutionCapsule  — cross-system bridge events (event-bus driven
--     recordOutcome calls have no per-workspace handle)
--   • IMUnmatchedSignal   — global signal tracker, agent-level not workspace
--   • IMEvolutionAchievement — badge grants triggered by aggregate counts
--   • IMCommunityBookmark — user-level bookmarks; community is workspace-agnostic
--   • IMCommunityDraft    — same reasoning
--   • IMAgentCard         — agent identity card; some agents predate workspaces
--   • IMGene / IMGeneSignal / IMAgentSkill / IMUnmatchedSignal seed grants
--     during agent registration — no workspace yet at that point
--
-- The Prisma schema (source-of-truth) declares all 11 columns as
-- `String?`. The runtime divergence — schema nullable, DB NOT NULL —
-- caused failures in v1.9.56 test deploy:
--
--   • POST /api/evolution/report  → IMEvolutionCapsule.create  → NOT NULL violation
--   • POST /api/community/bookmark → IMCommunityBookmark.create → NOT NULL violation
--
-- This migration aligns DB to the Prisma schema by relaxing all 11 columns
-- back to NULLable. NULL semantics: "system-wide / cross-workspace event".
-- The columns themselves stay so future per-workspace facets can populate
-- them when known.
--
-- Idempotent: every MODIFY guards on current NOT NULL state.
-- ============================================================================

DROP PROCEDURE IF EXISTS _314_relax_nullable;
DELIMITER //
CREATE PROCEDURE _314_relax_nullable(IN tbl VARCHAR(64))
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = tbl
      AND column_name = 'workspaceId'
      AND is_nullable = 'NO'
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` MODIFY COLUMN `workspaceId` VARCHAR(30) NULL');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL _314_relax_nullable('im_tasks');
CALL _314_relax_nullable('im_memory_files');
CALL _314_relax_nullable('im_genes');
CALL _314_relax_nullable('im_gene_signals');
CALL _314_relax_nullable('im_evolution_capsules');
CALL _314_relax_nullable('im_agent_skills');
CALL _314_relax_nullable('im_unmatched_signals');
CALL _314_relax_nullable('im_evolution_achievements');
CALL _314_relax_nullable('im_agent_cards');
CALL _314_relax_nullable('im_community_drafts');
CALL _314_relax_nullable('im_community_bookmarks');

DROP PROCEDURE _314_relax_nullable;
