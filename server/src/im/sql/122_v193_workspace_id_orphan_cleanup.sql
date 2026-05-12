-- ============================================================================
-- Migration 122: v1.9.3 follow-up — workspaceId orphan cleanup + NOT NULL flip
-- Date: 2026-05-07
-- Track: A (post-Phase B retrospective)
--
-- Why this exists
-- ----------------
-- Migration 110 (Phase 1, NULLable + backfill) and 120 (Phase 2, NOT NULL +
-- DROP scope) were intentionally defensive: 120's `_120_set_workspace_not_null`
-- procedure ONLY flips a column to NOT NULL when zero rows have NULL. So if
-- 110's backfill failed to resolve a workspace for any row (because:
--   (a) the row's owning IMUser had `userId = NULL` — agent created via
--       direct /register without a cloud account binding; e.g. comprehensive
--       integration tests use `comp_ax_*` / `comp_ay_*` agent fixtures that
--       skip the workspace bootstrap step,
--   (b) the resolved cloud user had no human IMUser row,
--   (c) that human had no isDefault=TRUE workspace yet — fresh dev clouds
--       where Cloud-1 native auth's /me hasn't fired,
--   (d) the table's row predates the auto-bootstrap fix added in api/register.ts
--       v1.9.3 (Phase 2 GA))
-- those rows stayed `workspaceId IS NULL` and 120 silently left the column
-- NULLable. Result: Prisma schema declares `workspaceId String` (NOT NULL) on
-- 11 tables, but the actual MySQL column is NULLable in any environment that
-- had pre-existing orphan rows.
--
-- Symptom (caught in dev push during Phase B closeout, 2026-05-07): 4
-- `im_agent_cards` rows in the local sqlite dev DB had NULL workspaceId.
-- Same risk applies to test/prod MySQL clusters that ran 110 with any
-- unresolvable owner column — 120 would have skipped the NOT NULL flip,
-- leaving an inconsistency between Prisma's expected schema and reality.
--
-- What this migration does
-- ------------------------
-- For each of the 11 tables that Prisma declares NOT NULL on workspaceId:
--   1. Re-run 110's backfill logic (best-effort, idempotent on already-set rows)
--   2. Catch any remaining orphans by routing them to an ops-fallback
--      workspace owned by the orphan's owner (if owner exists), or to a
--      designated catch-all workspace (`ws_orphan_fallback`)
--   3. Once zero NULL rows remain, MODIFY COLUMN to NOT NULL — bringing
--      MySQL into agreement with Prisma's schema declaration
--
-- The fallback workspace `ws_orphan_fallback` is a synthetic workspace
-- created here if missing, owned by a synthetic system IMUser
-- (`im_user_orphan_ops`). Existence checks are idempotent — repeated runs
-- don't duplicate. Production operators can later inspect / migrate /
-- soft-delete orphan rows by querying `WHERE workspaceId = 'ws_orphan_fallback'`.
--
-- Re-runnable: every UPDATE filters `WHERE workspaceId IS NULL`, every CREATE
-- TABLE / INSERT uses IF NOT EXISTS / INSERT IGNORE. Safe on a database that
-- already passed Phase 2 cleanly (no NULL rows → all UPDATEs are no-ops, NOT
-- NULL flips also no-op because the column is already NOT NULL).
--
-- Tables touched (the 11 NOT-NULL-on-workspaceId tables per Phase 2):
--   im_tasks, im_memory_files, im_genes, im_gene_signals,
--   im_evolution_capsules, im_agent_skills, im_unmatched_signals,
--   im_evolution_achievements, im_agent_cards, im_community_drafts,
--   im_community_bookmarks
--
-- Tables NOT touched (Phase 2 deliberately left these NULLable):
--   im_evolution_metrics, im_signal_clusters, im_token_baseline, im_atoms,
--   im_hyperedges, im_hyperedge_atoms, im_causal_links, im_anti_cheat_log,
--   im_compaction_summaries, im_skills, im_evolution_acl, im_value_metrics,
--   im_knowledge_links — aggregate/cross-workspace by design.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helpers (122-prefixed to avoid collision with 110/120 helpers if both still
-- linger in some half-applied environment)
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS _122_table_exists;
DELIMITER //
CREATE FUNCTION _122_table_exists(tbl VARCHAR(64)) RETURNS TINYINT
  READS SQL DATA
  DETERMINISTIC
BEGIN
  RETURN (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl);
END //
DELIMITER ;

DROP FUNCTION IF EXISTS _122_col_exists;
DELIMITER //
CREATE FUNCTION _122_col_exists(tbl VARCHAR(64), col VARCHAR(64)) RETURNS TINYINT
  READS SQL DATA
  DETERMINISTIC
BEGIN
  RETURN (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = tbl
             AND COLUMN_NAME = col);
END //
DELIMITER ;

DROP FUNCTION IF EXISTS _122_col_is_nullable;
DELIMITER //
CREATE FUNCTION _122_col_is_nullable(tbl VARCHAR(64), col VARCHAR(64)) RETURNS TINYINT
  READS SQL DATA
  DETERMINISTIC
BEGIN
  RETURN (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = tbl
             AND COLUMN_NAME = col
             AND IS_NULLABLE = 'YES');
END //
DELIMITER ;

-- ----------------------------------------------------------------------------
-- Step 0: ensure the orphan-fallback workspace exists.
--
-- Strategy: create a synthetic system human IMUser (id literal
-- 'im_user_orphan_ops') and a synthetic workspace 'ws_orphan_fallback'
-- owned by that user. INSERT IGNORE keeps re-runs safe.
--
-- Operators inspecting prod can later:
--   SELECT 'im_agent_cards' AS t, COUNT(*) FROM im_agent_cards
--    WHERE workspaceId='ws_orphan_fallback'
--   UNION ALL ... (and run targeted manual cleanup).
-- ----------------------------------------------------------------------------

-- Only proceed if im_users / im_workspaces actually exist.
DROP PROCEDURE IF EXISTS _122_ensure_fallback_ws;
DELIMITER //
CREATE PROCEDURE _122_ensure_fallback_ws()
BEGIN
  IF _122_table_exists('im_users') = 0 OR _122_table_exists('im_workspaces') = 0 THEN
    -- Schema not bootstrapped enough to host a fallback ws; bail.
    SELECT 'skip _122_ensure_fallback_ws (im_users/im_workspaces missing)' AS status;
  ELSE
    -- Synthetic system human owner. Plausible username; cannot collide with
    -- any cloud user (no cloud user can have `userId='__orphan_ops__'`).
    INSERT IGNORE INTO im_users
      (id, username, displayName, role, userId, createdAt, updatedAt)
    VALUES
      ('im_user_orphan_ops', 'orphan_ops', 'Orphan Ops (system)', 'human',
       '__orphan_ops__', NOW(3), NOW(3));

    -- Synthetic fallback workspace.
    -- IMWorkspace columns vary slightly across migrations 100 vs 110; insert
    -- only the always-present ones and let DB defaults fill the rest.
    INSERT IGNORE INTO im_workspaces
      (id, ownerImUserId, name, slug, isDefault, createdAt, updatedAt)
    VALUES
      ('ws_orphan_fallback', 'im_user_orphan_ops',
       'Orphan Fallback (system)', 'orphan-fallback', 0, NOW(3), NOW(3));
  END IF;
END //
DELIMITER ;
CALL _122_ensure_fallback_ws();
DROP PROCEDURE _122_ensure_fallback_ws;

-- ----------------------------------------------------------------------------
-- Step 1: re-run owner-column-driven backfill for the 11 NOT-NULL tables.
--
-- This is structurally the same as 110's `_backfill_via_imuser` but runs only
-- on rows where workspaceId IS NULL (so already-good rows are untouched).
-- Tables here all have a definite ownership column; the join chain
-- (actor → actor.userId → human.userId='human' → human.default workspace)
-- is the canonical resolution.
-- ----------------------------------------------------------------------------

DROP PROCEDURE IF EXISTS _122_backfill_via_imuser;
DELIMITER //
CREATE PROCEDURE _122_backfill_via_imuser(IN tbl VARCHAR(64), IN owner_col VARCHAR(64))
BEGIN
  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
  IF _122_table_exists(tbl) > 0 AND _122_col_exists(tbl, 'workspaceId') > 0 THEN
    SET @sql := CONCAT(
      'UPDATE `', tbl, '` t ',
      'JOIN im_users actor ON actor.id = t.`', owner_col, '` AND actor.userId IS NOT NULL ',
      'JOIN im_users human ON human.userId = actor.userId AND human.role = ''human'' ',
      'JOIN im_workspaces w ON w.ownerImUserId = human.id AND w.isDefault = TRUE AND w.deletedAt IS NULL ',
      'SET t.workspaceId = w.id ',
      'WHERE t.workspaceId IS NULL'
    );
    PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

CALL _122_backfill_via_imuser('im_tasks',                    'creatorId');
CALL _122_backfill_via_imuser('im_memory_files',             'ownerId');
CALL _122_backfill_via_imuser('im_genes',                    'ownerAgentId');
CALL _122_backfill_via_imuser('im_evolution_capsules',       'ownerAgentId');
CALL _122_backfill_via_imuser('im_agent_skills',             'agentId');
CALL _122_backfill_via_imuser('im_unmatched_signals',        'agentId');
CALL _122_backfill_via_imuser('im_evolution_achievements',   'agentId');
CALL _122_backfill_via_imuser('im_agent_cards',              'imUserId');
CALL _122_backfill_via_imuser('im_community_drafts',         'authorId');
CALL _122_backfill_via_imuser('im_community_bookmarks',      'userId');

-- im_gene_signals: derive via geneId → im_genes.ownerAgentId
DROP PROCEDURE IF EXISTS _122_backfill_gene_signals;
DELIMITER //
CREATE PROCEDURE _122_backfill_gene_signals()
BEGIN
  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
  IF _122_table_exists('im_gene_signals') > 0
     AND _122_table_exists('im_genes') > 0
     AND _122_col_exists('im_gene_signals', 'workspaceId') > 0 THEN
    UPDATE im_gene_signals t
       JOIN im_genes g       ON g.id = t.geneId
       JOIN im_users actor   ON actor.id = g.ownerAgentId AND actor.userId IS NOT NULL
       JOIN im_users human   ON human.userId = actor.userId AND human.role = 'human'
       JOIN im_workspaces w  ON w.ownerImUserId = human.id AND w.isDefault = TRUE AND w.deletedAt IS NULL
       SET t.workspaceId = w.id
     WHERE t.workspaceId IS NULL;
  END IF;
END //
DELIMITER ;
CALL _122_backfill_gene_signals();
DROP PROCEDURE _122_backfill_gene_signals;

-- ----------------------------------------------------------------------------
-- Step 2: own-the-orphan fallback. Any row still NULL after step 1 has no
-- resolvable owner workspace — route it to ws_orphan_fallback so the column
-- can be flipped to NOT NULL. Operators can inspect post-deploy.
-- ----------------------------------------------------------------------------

DROP PROCEDURE IF EXISTS _122_orphan_fallback;
DELIMITER //
CREATE PROCEDURE _122_orphan_fallback(IN tbl VARCHAR(64))
BEGIN
  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
  IF _122_table_exists(tbl) > 0
     AND _122_col_exists(tbl, 'workspaceId') > 0
     AND (SELECT COUNT(*) FROM im_workspaces WHERE id = 'ws_orphan_fallback') > 0 THEN
    SET @sql := CONCAT(
      'UPDATE `', tbl, '` SET workspaceId = ''ws_orphan_fallback'' WHERE workspaceId IS NULL'
    );
    PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

CALL _122_orphan_fallback('im_tasks');
CALL _122_orphan_fallback('im_memory_files');
CALL _122_orphan_fallback('im_genes');
CALL _122_orphan_fallback('im_gene_signals');
CALL _122_orphan_fallback('im_evolution_capsules');
CALL _122_orphan_fallback('im_agent_skills');
CALL _122_orphan_fallback('im_unmatched_signals');
CALL _122_orphan_fallback('im_evolution_achievements');
CALL _122_orphan_fallback('im_agent_cards');
CALL _122_orphan_fallback('im_community_drafts');
CALL _122_orphan_fallback('im_community_bookmarks');

DROP PROCEDURE _122_orphan_fallback;
DROP PROCEDURE _122_backfill_via_imuser;

-- ----------------------------------------------------------------------------
-- Step 3: flip workspaceId to NOT NULL on the 11 tables (idempotent — skips
-- if already NOT NULL or if any NULL rows remain after steps 1+2 — that
-- shouldn't happen but the guard prevents a hard failure).
-- ----------------------------------------------------------------------------

DROP PROCEDURE IF EXISTS _122_set_workspace_not_null;
DELIMITER //
CREATE PROCEDURE _122_set_workspace_not_null(IN tbl VARCHAR(64))
BEGIN
  IF _122_table_exists(tbl) > 0
     AND _122_col_exists(tbl, 'workspaceId') > 0
     AND _122_col_is_nullable(tbl, 'workspaceId') > 0 THEN
    SET @sql := CONCAT('SELECT COUNT(*) INTO @nc FROM `', tbl, '` WHERE workspaceId IS NULL');
    PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
    IF @nc = 0 THEN
      SET @stmt := CONCAT('ALTER TABLE `', tbl, '` MODIFY COLUMN workspaceId VARCHAR(30) NOT NULL');
      PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
    END IF;
  END IF;
END //
DELIMITER ;

CALL _122_set_workspace_not_null('im_tasks');
CALL _122_set_workspace_not_null('im_memory_files');
CALL _122_set_workspace_not_null('im_genes');
CALL _122_set_workspace_not_null('im_gene_signals');
CALL _122_set_workspace_not_null('im_evolution_capsules');
CALL _122_set_workspace_not_null('im_agent_skills');
CALL _122_set_workspace_not_null('im_unmatched_signals');
CALL _122_set_workspace_not_null('im_evolution_achievements');
CALL _122_set_workspace_not_null('im_agent_cards');
CALL _122_set_workspace_not_null('im_community_drafts');
CALL _122_set_workspace_not_null('im_community_bookmarks');

DROP PROCEDURE _122_set_workspace_not_null;

-- ----------------------------------------------------------------------------
-- Cleanup helpers
-- ----------------------------------------------------------------------------

DROP FUNCTION _122_col_is_nullable;
DROP FUNCTION _122_col_exists;
DROP FUNCTION _122_table_exists;

-- ----------------------------------------------------------------------------
-- Post-apply audit query (operators can run manually):
--
--   SELECT 'im_agent_cards' AS t, COUNT(*) AS orphans FROM im_agent_cards
--    WHERE workspaceId = 'ws_orphan_fallback'
--   UNION ALL SELECT 'im_tasks',         COUNT(*) FROM im_tasks         WHERE workspaceId='ws_orphan_fallback'
--   UNION ALL SELECT 'im_genes',         COUNT(*) FROM im_genes         WHERE workspaceId='ws_orphan_fallback'
--   UNION ALL SELECT 'im_gene_signals',  COUNT(*) FROM im_gene_signals  WHERE workspaceId='ws_orphan_fallback'
--   UNION ALL SELECT 'im_memory_files',  COUNT(*) FROM im_memory_files  WHERE workspaceId='ws_orphan_fallback'
--   ;
--
-- Any non-zero count = orphan row that needs human review (likely test
-- fixture residue or pre-1.9.3 row whose owner had no workspace).
-- ----------------------------------------------------------------------------

SELECT 'migration 122 complete' AS status;
