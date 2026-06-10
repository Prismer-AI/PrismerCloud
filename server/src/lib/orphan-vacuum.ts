/**
 * Orphan vacuum — admin-side data-hygiene sweep.
 *
 * The 2026-05-24 forensic on local dev DB found ~10k rows whose
 * `workspaceId` pointed to a workspace that no longer exists in
 * `im_workspaces`. Pre-history: e2e harnesses + earlier ad-hoc tests
 * called `DELETE FROM im_workspaces WHERE id=X` directly, but since most
 * workspace-keyed tables in this schema lack `onDelete: Cascade` (the
 * relation is `String` not `relation`), the children just sat there as
 * permanent orphans. The new `workspace-clear.service.ts` cascade closes
 * the on-going leak; this vacuum cleans up the historical residue.
 *
 * Scope (matches the same tables `workspace-clear.service.ts` reaches):
 *   - Workspace-keyed tables → `WHERE workspaceId NOT IN (SELECT id FROM im_workspaces)`
 *   - FK-chain tables → `WHERE <fk> NOT IN (SELECT id FROM <parent>)`
 *
 * Uses `$executeRawUnsafe` per table so the NOT-IN subquery is pushed
 * down to MySQL (set-based DELETE, single round-trip). Each table is
 * independent: one failure logs + continues.
 *
 * Two entry points:
 *   - `previewOrphanVacuum()`  — counts only, read-only
 *   - `executeOrphanVacuum()`  — runs the deletes, returns per-table counts
 */

import prisma from './prisma';
import { logger } from './logger';

interface TargetTable {
  name: string;
  /** Parent table whose `id` column the FK must exist in. */
  parentTable: string;
  /** FK column on the orphan candidate. */
  fkColumn: string;
  /**
   * When true, only consider rows where the FK column IS NOT NULL —
   * for nullable FKs we leave NULL rows alone (they represent
   * standalone/orphan-by-design entities like agent-direct task runs).
   */
  fkNullable: boolean;
}

/**
 * Tables to vacuum. Ordered so workspace-keyed (the bulk) goes first;
 * chain-orphan removals depend on the parent table being already clean,
 * so workspace-keyed parents (im_conversations, im_tasks, etc.) must be
 * stable before chain-orphan scan walks their FK fields.
 *
 * If you add a new workspace-scoped table to the schema:
 *   1. Add it to this list under the appropriate `parentTable`
 *   2. Confirm the cascade is also covered in `workspace-clear.service.ts`
 */
const TARGETS: TargetTable[] = [
  // ── Workspace-keyed (the bulk; pre-existing dev-env orphans live here) ──
  // Agents
  { name: 'im_agent_profiles', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  { name: 'im_agent_cards', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_agent_snapshots', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  { name: 'im_agent_skills', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  // Workspace meta
  { name: 'im_workspace_members', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  { name: 'im_workspace_files', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  { name: 'im_channel_accounts', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  // Conversations + tasks (parents for FK chain below)
  { name: 'im_conversations', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_tasks', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  // Containers + sandbox (parents for FK chain below)
  { name: 'im_containers', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  { name: 'im_sandbox_runs', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  { name: 'im_sandbox_quotas', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  // Assets
  { name: 'im_assets', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  { name: 'im_asset_index_counters', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  { name: 'im_asset_revisions', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  // Memory + knowledge
  { name: 'im_memory_files', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  { name: 'im_memory_pages', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  { name: 'im_memory_links', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  { name: 'im_memory_sync_events', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_memory_observability_events', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_memory_proposals', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_compaction_summaries', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  { name: 'im_knowledge_links', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_skills', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  // Evolution
  { name: 'im_genes', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_gene_signals', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_unmatched_signals', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_signal_clusters', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_evolution_capsules', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_evolution_metrics', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_evolution_achievements', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_evolution_acl', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_token_baseline', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_value_metrics', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  // Hypergraph
  { name: 'im_atoms', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_hyperedges', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_hyperedge_atoms', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_causal_links', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  // Community (workspace-scoped only — boards / posts / tags are global)
  { name: 'im_community_bookmarks', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_community_drafts', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  // Approvals / task-runs / task-events / sandbox-run-logs all have direct workspaceId
  { name: 'im_approvals', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  { name: 'im_task_runs', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_task_events', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_sandbox_run_logs', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: false },
  { name: 'im_ingest_claims', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },
  { name: 'im_anti_cheat_log', parentTable: 'im_workspaces', fkColumn: 'workspaceId', fkNullable: true },

  // ── FK chain (parents themselves are workspace-keyed; ordering matters) ──
  // Conversation chain — runs AFTER im_conversations vacuum above
  { name: 'im_messages', parentTable: 'im_conversations', fkColumn: 'conversationId', fkNullable: false },
  { name: 'im_message_partials', parentTable: 'im_conversations', fkColumn: 'conversationId', fkNullable: false },
  { name: 'im_message_reactions', parentTable: 'im_conversations', fkColumn: 'conversationId', fkNullable: false },
  { name: 'im_participants', parentTable: 'im_conversations', fkColumn: 'conversationId', fkNullable: false },
  { name: 'im_read_cursors', parentTable: 'im_conversations', fkColumn: 'conversationId', fkNullable: false },
  { name: 'im_sync_events', parentTable: 'im_conversations', fkColumn: 'conversationId', fkNullable: true },
  { name: 'im_conversation_seq', parentTable: 'im_conversations', fkColumn: 'conversationId', fkNullable: false },
  { name: 'im_conversation_security', parentTable: 'im_conversations', fkColumn: 'conversationId', fkNullable: false },
  { name: 'im_conversation_policy', parentTable: 'im_conversations', fkColumn: 'conversationId', fkNullable: false },
  // Task chain — runs AFTER im_tasks vacuum above
  { name: 'im_task_run_steps', parentTable: 'im_tasks', fkColumn: 'taskId', fkNullable: false },
  { name: 'im_task_logs', parentTable: 'im_tasks', fkColumn: 'taskId', fkNullable: false },
  { name: 'im_dispatch_replies', parentTable: 'im_tasks', fkColumn: 'taskId', fkNullable: false },
  // Container/sandbox chain — runs AFTER im_containers / im_sandbox_runs vacuum
  { name: 'im_container_snapshots', parentTable: 'im_containers', fkColumn: 'containerId', fkNullable: false },
  { name: 'im_sandbox_resource_samples', parentTable: 'im_sandbox_runs', fkColumn: 'runId', fkNullable: false },
];

export interface TableOrphanReport {
  name: string;
  parentTable: string;
  fkColumn: string;
  orphanCount: number;
  /** First few ghost IDs (FK values not present in parent) — for UI display. */
  sampleGhostIds: string[];
}

export interface VacuumPreview {
  tables: TableOrphanReport[];
  totalOrphans: number;
  parentTableCounts: Record<string, number>;
}

export interface VacuumResult {
  tables: Array<{ name: string; deleted: number; error?: string }>;
  totalDeleted: number;
  durationMs: number;
}

/** Build the WHERE clause that matches orphan rows for a target. */
function whereOrphan(t: TargetTable): string {
  // Backtick-quote identifiers — they're trusted (from TARGETS const)
  // but explicit quoting future-proofs against MySQL reserved-word edge cases.
  const fk = `\`${t.fkColumn}\``;
  const nullGuard = t.fkNullable ? ` AND ${fk} IS NOT NULL` : '';
  return `${fk} NOT IN (SELECT id FROM \`${t.parentTable}\`)${nullGuard}`;
}

/**
 * Count orphans per table + sample ghost FK values. Read-only.
 */
export async function previewOrphanVacuum(): Promise<VacuumPreview> {
  const reports: TableOrphanReport[] = [];
  const parentTableCounts: Record<string, number> = {};
  let totalOrphans = 0;

  for (const t of TARGETS) {
    try {
      const countRows = (await prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS cnt FROM \`${t.name}\` WHERE ${whereOrphan(t)}`,
      )) as Array<{ cnt: bigint | number }>;
      const count = Number(countRows[0]?.cnt ?? 0);
      let sampleGhostIds: string[] = [];
      if (count > 0) {
        const sampleRows = (await prisma.$queryRawUnsafe(
          `SELECT DISTINCT \`${t.fkColumn}\` AS ghost FROM \`${t.name}\` WHERE ${whereOrphan(t)} LIMIT 5`,
        )) as Array<{ ghost: string }>;
        sampleGhostIds = sampleRows.map((r) => r.ghost).filter(Boolean);
      }
      reports.push({
        name: t.name,
        parentTable: t.parentTable,
        fkColumn: t.fkColumn,
        orphanCount: count,
        sampleGhostIds,
      });
      totalOrphans += count;
      parentTableCounts[t.parentTable] = (parentTableCounts[t.parentTable] ?? 0) + count;
    } catch (err) {
      logger.warn(
        { table: t.name, err: err instanceof Error ? err.message : String(err) },
        '[orphan-vacuum] preview failed for table — including 0 in report',
      );
      reports.push({
        name: t.name,
        parentTable: t.parentTable,
        fkColumn: t.fkColumn,
        orphanCount: 0,
        sampleGhostIds: [],
      });
    }
  }

  return { tables: reports, totalOrphans, parentTableCounts };
}

/**
 * Execute the vacuum. Returns per-table delete counts.
 *
 * Pass `onlyTables` to scope the run (e.g. user clicked one row). The
 * table order in TARGETS is preserved so workspace-keyed parents drain
 * before chain-orphan walks them (otherwise the chain walks might catch
 * rows whose parents would have been deleted in the same run).
 */
export async function executeOrphanVacuum(opts: { onlyTables?: string[] } = {}): Promise<VacuumResult> {
  const filter = opts.onlyTables ? new Set(opts.onlyTables) : null;
  const started = Date.now();
  const results: VacuumResult['tables'] = [];
  let totalDeleted = 0;

  for (const t of TARGETS) {
    if (filter && !filter.has(t.name)) continue;
    try {
      const deleted = await prisma.$executeRawUnsafe(
        `DELETE FROM \`${t.name}\` WHERE ${whereOrphan(t)}`,
      );
      const n = Number(deleted);
      results.push({ name: t.name, deleted: n });
      totalDeleted += n;
      if (n > 0) {
        logger.info({ table: t.name, deleted: n }, '[orphan-vacuum] deleted');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ table: t.name, err: msg }, '[orphan-vacuum] delete failed (continuing)');
      results.push({ name: t.name, deleted: 0, error: msg });
    }
  }

  return { tables: results, totalDeleted, durationMs: Date.now() - started };
}
