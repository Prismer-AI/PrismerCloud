-- ============================================================================
-- Migration 110: v1.9.2 — workspaceId Phase 1 (NULLable on 24 tables + backfill)
-- Date: 2026-05-02
-- Track: A
--
-- Adds `workspaceId VARCHAR(30) NULL` to all owned IM tables and backfills it
-- using either the existing `scope` field (where present) or the row's
-- ownership column joined through im_users.userId to the human owner's
-- default workspace.
--
-- Tables touched (24):
--   With scope (10 — backfill via scope OR owner column):
--     im_tasks, im_memory_files, im_genes, im_evolution_capsules,
--     im_evolution_metrics, im_agent_skills, im_unmatched_signals,
--     im_evolution_achievements, im_knowledge_links, im_value_metrics
--   Without scope but with owner column (8 — backfill via owner):
--     im_gene_signals (via geneId → im_genes.ownerAgentId),
--     im_evolution_acl (resourceId 三义 split — see special handling),
--     im_agent_cards (via imUserId), im_skills (via ownerAgentId, nullable),
--     im_compaction_summaries (via conversationId → im_conversations.workspaceId),
--     im_community_drafts (via authorId), im_community_bookmarks (via userId)
--   Without scope and without identifiable owner (7 — leave NULL):
--     im_signal_clusters, im_token_baseline, im_atoms, im_hyperedges,
--     im_hyperedge_atoms, im_causal_links, im_anti_cheat_log
--
-- 02 doc said "23 张表"; verified actual = 24 against schema.prisma
-- (im_signal_clusters plural / im_community_drafts / im_community_bookmarks
-- corrections noted in progress.md).
--
-- Idempotent: every ADD COLUMN / CREATE INDEX wrapped in INFORMATION_SCHEMA
-- guards; every UPDATE qualified by `WHERE workspaceId IS NULL` so re-runs
-- on partially-backfilled tables are no-ops on already-set rows.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helper procedures
-- ----------------------------------------------------------------------------

-- All helpers below are **table-existence aware**: if the target table is
-- missing (which currently happens in partial-schema dev-stack environments
-- where some 1.7.x/1.8.x migrations failed — see m3 phase 2 cleanup queue),
-- the helper silently skips that operation rather than aborting migration
-- 110. This means a fresh chain run lands workspaceId on every existing
-- table even when some pre-existing migrations couldn't bootstrap their
-- table; once those pre-existing migrations are fixed in m3, re-running 110
-- backfills the rest.

DROP FUNCTION IF EXISTS _table_exists;
DELIMITER //
CREATE FUNCTION _table_exists(tbl VARCHAR(64)) RETURNS TINYINT
  READS SQL DATA
  DETERMINISTIC
BEGIN
  RETURN (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl);
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS _add_col_if_missing;
DELIMITER //
CREATE PROCEDURE _add_col_if_missing(IN tbl VARCHAR(64), IN col VARCHAR(64), IN col_def TEXT)
BEGIN
  IF _table_exists(tbl) > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col) = 0 THEN
    SET @stmt := CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', col_def);
    PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS _add_idx_if_missing;
DELIMITER //
CREATE PROCEDURE _add_idx_if_missing(IN tbl VARCHAR(64), IN idx_name VARCHAR(64), IN idx_cols TEXT)
BEGIN
  IF _table_exists(tbl) > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND INDEX_NAME = idx_name) = 0 THEN
    SET @stmt := CONCAT('CREATE INDEX `', idx_name, '` ON `', tbl, '` (', idx_cols, ')');
    PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

-- Backfill via owner column (im_users.id) → that user's cloud userId →
-- the human user with that cloud userId → that human's default workspace.
-- Works for both human-owner rows (actor.role='human', actor.userId set) and
-- agent-owner rows (actor.role='agent', actor.userId points to owning human's cloud id).
DROP PROCEDURE IF EXISTS _backfill_via_imuser;
DELIMITER //
CREATE PROCEDURE _backfill_via_imuser(IN tbl VARCHAR(64), IN owner_col VARCHAR(64))
BEGIN
  -- Best-effort: swallow exceptions so an unrelated table's collation
  -- mismatch (which can happen when a Class 2 broken migration created its
  -- table with `DEFAULT CHARSET=utf8mb4` only — MySQL 8 picks
  -- utf8mb4_0900_ai_ci instead of the server-level utf8mb4_unicode_ci)
  -- doesn't abort the rest of the backfill. m3 phase 2 fixes the affected
  -- migrations and re-runs 110 to fill the gaps.
  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
  IF _table_exists(tbl) > 0 THEN
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

-- Backfill via scope field for ws_xxx values (literal workspace id suffix).
-- Requires both the table AND the `scope` column to exist. In partial-schema
-- environments the `scope` column is often added by 034_v180_workspace_scope
-- which is currently in the broken-migration set; this guard makes 110
-- gracefully skip scope-based backfill until the scope column lands.
DROP PROCEDURE IF EXISTS _backfill_via_scope;
DELIMITER //
CREATE PROCEDURE _backfill_via_scope(IN tbl VARCHAR(64))
BEGIN
  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
  IF _table_exists(tbl) > 0
     AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = 'scope') > 0 THEN
    SET @sql := CONCAT(
      'UPDATE `', tbl, '` t ',
      'JOIN im_workspaces w ON w.id = SUBSTRING(t.scope, 4) AND w.deletedAt IS NULL ',
      'SET t.workspaceId = w.id ',
      'WHERE t.workspaceId IS NULL AND t.scope LIKE ''ws\\_%'' ESCAPE ''\\\\'''
    );
    PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

-- ----------------------------------------------------------------------------
-- Step 1: ADD COLUMN workspaceId NULLable + index on each of 24 tables
-- ----------------------------------------------------------------------------

CALL _add_col_if_missing('im_tasks',                    'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_memory_files',             'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_genes',                    'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_gene_signals',             'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_evolution_capsules',       'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_evolution_metrics',        'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_agent_skills',             'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_unmatched_signals',        'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_evolution_achievements',   'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_evolution_acl',            'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_evolution_acl',            'geneId',      'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_signal_clusters',          'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_token_baseline',           'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_agent_cards',              'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_atoms',                    'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_hyperedges',               'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_hyperedge_atoms',          'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_causal_links',             'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_skills',                   'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_compaction_summaries',     'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_knowledge_links',          'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_value_metrics',            'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_anti_cheat_log',           'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_community_drafts',         'workspaceId', 'VARCHAR(30) NULL');
CALL _add_col_if_missing('im_community_bookmarks',      'workspaceId', 'VARCHAR(30) NULL');

CALL _add_idx_if_missing('im_tasks',                    'idx_tasks_workspace',                  'workspaceId, status');
CALL _add_idx_if_missing('im_memory_files',             'idx_memory_workspace',                 'workspaceId');
CALL _add_idx_if_missing('im_genes',                    'idx_genes_workspace',                  'workspaceId');
CALL _add_idx_if_missing('im_gene_signals',             'idx_gene_signals_workspace',           'workspaceId');
CALL _add_idx_if_missing('im_evolution_capsules',       'idx_capsules_workspace',               'workspaceId');
CALL _add_idx_if_missing('im_evolution_metrics',        'idx_metrics_workspace',                'workspaceId');
CALL _add_idx_if_missing('im_agent_skills',             'idx_agent_skills_workspace',           'workspaceId');
CALL _add_idx_if_missing('im_unmatched_signals',        'idx_unmatched_signals_workspace',      'workspaceId');
CALL _add_idx_if_missing('im_evolution_achievements',   'idx_achievements_workspace',           'workspaceId');
CALL _add_idx_if_missing('im_evolution_acl',            'idx_acl_workspace',                    'workspaceId');
CALL _add_idx_if_missing('im_evolution_acl',            'idx_acl_gene',                         'geneId');
CALL _add_idx_if_missing('im_signal_clusters',          'idx_signal_clusters_workspace',        'workspaceId');
CALL _add_idx_if_missing('im_token_baseline',           'idx_token_baseline_workspace',         'workspaceId');
CALL _add_idx_if_missing('im_agent_cards',              'idx_agent_cards_workspace',            'workspaceId');
CALL _add_idx_if_missing('im_atoms',                    'idx_atoms_workspace',                  'workspaceId');
CALL _add_idx_if_missing('im_hyperedges',               'idx_hyperedges_workspace',             'workspaceId');
CALL _add_idx_if_missing('im_hyperedge_atoms',          'idx_hyperedge_atoms_workspace',        'workspaceId');
CALL _add_idx_if_missing('im_causal_links',             'idx_causal_links_workspace',           'workspaceId');
CALL _add_idx_if_missing('im_skills',                   'idx_skills_workspace',                 'workspaceId');
CALL _add_idx_if_missing('im_compaction_summaries',     'idx_compaction_workspace',             'workspaceId');
CALL _add_idx_if_missing('im_knowledge_links',          'idx_knowledge_links_workspace',        'workspaceId');
CALL _add_idx_if_missing('im_value_metrics',            'idx_value_metrics_workspace',          'workspaceId');
CALL _add_idx_if_missing('im_anti_cheat_log',           'idx_anti_cheat_workspace',             'workspaceId');
CALL _add_idx_if_missing('im_community_drafts',         'idx_community_drafts_workspace',       'workspaceId');
CALL _add_idx_if_missing('im_community_bookmarks',      'idx_community_bookmarks_workspace',    'workspaceId');

-- ----------------------------------------------------------------------------
-- Step 2: backfill — order matters (downstream tables join through im_genes /
-- im_conversations / im_users, so process those first)
-- ----------------------------------------------------------------------------

-- 2.1 Owner-based (single-hop through im_users.userId)
CALL _backfill_via_imuser('im_tasks',                  'creatorId');
CALL _backfill_via_imuser('im_genes',                  'ownerAgentId');
CALL _backfill_via_imuser('im_evolution_capsules',     'ownerAgentId');
CALL _backfill_via_imuser('im_agent_skills',           'agentId');
CALL _backfill_via_imuser('im_unmatched_signals',      'agentId');
CALL _backfill_via_imuser('im_evolution_achievements', 'agentId');
CALL _backfill_via_imuser('im_agent_cards',            'imUserId');
CALL _backfill_via_imuser('im_community_drafts',       'authorId');
CALL _backfill_via_imuser('im_community_bookmarks',    'userId');

-- 2.2 im_memory_files — ownerId can be human or agent IM user; same _backfill_via_imuser works
--     because both kinds of IM user have userId pointing to the cloud user.
CALL _backfill_via_imuser('im_memory_files',           'ownerId');

-- 2.3 im_skills — ownerAgentId is NULLable (NULL = community-imported, not user-owned).
--     Only backfill rows that have an owner; rest stay NULL (community/system skills).
CALL _backfill_via_imuser('im_skills',                 'ownerAgentId');

-- 2.4 im_gene_signals — no direct owner column; derive via geneId → im_genes.ownerAgentId
DROP PROCEDURE IF EXISTS _backfill_gene_signals;
DELIMITER //
CREATE PROCEDURE _backfill_gene_signals()
BEGIN
  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
  IF _table_exists('im_gene_signals') > 0 AND _table_exists('im_genes') > 0 THEN
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
CALL _backfill_gene_signals();
DROP PROCEDURE _backfill_gene_signals;

-- 2.5 im_compaction_summaries — derive via conversationId → im_conversations.workspaceId.
--     IMConversation.workspaceId is NULLable in 1.9.x (we removed @unique in m1) so this
--     produces NULL for conversations not yet bound to a workspace; that's fine.
DROP PROCEDURE IF EXISTS _backfill_compaction;
DELIMITER //
CREATE PROCEDURE _backfill_compaction()
BEGIN
  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
  IF _table_exists('im_compaction_summaries') > 0 AND _table_exists('im_conversations') > 0 THEN
    UPDATE im_compaction_summaries t
       JOIN im_conversations c ON c.id = t.conversationId AND c.workspaceId IS NOT NULL
       SET t.workspaceId = c.workspaceId
     WHERE t.workspaceId IS NULL;
  END IF;
END //
DELIMITER ;
CALL _backfill_compaction();
DROP PROCEDURE _backfill_compaction;

-- 2.6 Scope-based (parse 'ws_xxx' suffix where present)
CALL _backfill_via_scope('im_tasks');
CALL _backfill_via_scope('im_memory_files');
CALL _backfill_via_scope('im_genes');
CALL _backfill_via_scope('im_evolution_capsules');
CALL _backfill_via_scope('im_evolution_metrics');
CALL _backfill_via_scope('im_agent_skills');
CALL _backfill_via_scope('im_unmatched_signals');
CALL _backfill_via_scope('im_evolution_achievements');
CALL _backfill_via_scope('im_knowledge_links');
CALL _backfill_via_scope('im_value_metrics');

-- 2.7 im_value_metrics — also backfill rows whose entityType='agent' through the entity
DROP PROCEDURE IF EXISTS _backfill_value_metrics;
DELIMITER //
CREATE PROCEDURE _backfill_value_metrics()
BEGIN
  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
  IF _table_exists('im_value_metrics') > 0 THEN
    UPDATE im_value_metrics t
       JOIN im_users actor   ON actor.id = t.entityId AND t.entityType = 'agent' AND actor.userId IS NOT NULL
       JOIN im_users human   ON human.userId = actor.userId AND human.role = 'human'
       JOIN im_workspaces w  ON w.ownerImUserId = human.id AND w.isDefault = TRUE AND w.deletedAt IS NULL
       SET t.workspaceId = w.id
     WHERE t.workspaceId IS NULL;
  END IF;
END //
DELIMITER ;
CALL _backfill_value_metrics();
DROP PROCEDURE _backfill_value_metrics;

-- 2.8 im_evolution_acl — split resourceId 三义:
--     resourceType='gene'      → resourceId is gene_id  → set geneId
--     resourceType='workspace' → resourceId is 'ws_xxx' → parse to workspaceId
--                              | resourceId is workspace literal id → use directly if found
--     resourceType='capsule_set' → leave both NULL (1.9.x doesn't formalize capsule scope)
DROP PROCEDURE IF EXISTS _backfill_acl;
DELIMITER //
CREATE PROCEDURE _backfill_acl()
BEGIN
  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
  IF _table_exists('im_evolution_acl') > 0 THEN
    UPDATE im_evolution_acl t
       SET t.geneId = t.resourceId
     WHERE t.geneId IS NULL AND t.resourceType = 'gene';

    UPDATE im_evolution_acl t
       JOIN im_workspaces w ON w.id = SUBSTRING(t.resourceId, 4) AND w.deletedAt IS NULL
       SET t.workspaceId = w.id
     WHERE t.workspaceId IS NULL
       AND t.resourceType = 'workspace'
       AND t.resourceId LIKE 'ws\\_%' ESCAPE '\\';

    UPDATE im_evolution_acl t
       JOIN im_workspaces w ON w.id = t.resourceId AND w.deletedAt IS NULL
       SET t.workspaceId = w.id
     WHERE t.workspaceId IS NULL
       AND t.resourceType = 'workspace'
       AND t.resourceId NOT LIKE 'ws\\_%' ESCAPE '\\'
       AND t.resourceId != 'global';
  END IF;
END //
DELIMITER ;
CALL _backfill_acl();
DROP PROCEDURE _backfill_acl;

-- ----------------------------------------------------------------------------
-- Step 3: cleanup helpers
-- ----------------------------------------------------------------------------

DROP PROCEDURE _add_col_if_missing;
DROP PROCEDURE _add_idx_if_missing;
DROP PROCEDURE _backfill_via_imuser;
DROP PROCEDURE _backfill_via_scope;
DROP FUNCTION _table_exists;

-- ----------------------------------------------------------------------------
-- Tables NOT backfilled (workspaceId stays NULL for all existing rows):
--   im_signal_clusters, im_token_baseline, im_atoms, im_hyperedges,
--   im_hyperedge_atoms, im_causal_links, im_anti_cheat_log
-- These tables are aggregate / cross-workspace by design (signal clusters
-- aggregate across all agents, hypergraph atoms are deduplicated globally,
-- anti-cheat log records actions on potentially-cross-workspace entities).
-- Phase 2 (m3) will revisit whether to drop the workspaceId column on these
-- or leave it NULLable forever as an "optional scope tag" field.
-- im_evolution_metrics rows with scope='global' similarly stay NULL because
-- they aggregate across workspaces; only ws_xxx-scoped metric snapshots get
-- a value.
-- ----------------------------------------------------------------------------

SELECT 'migration 110 complete' AS status;
