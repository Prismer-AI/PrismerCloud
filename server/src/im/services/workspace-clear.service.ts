/**
 * Workspace hard-clear cascade — A2 semantics per 2026-05-24 scope review.
 *
 * Deletes a workspace ENTIRELY:
 *   - Workspace row + members + all child rows across 46 directly-keyed
 *     tables + FK-chain children (messages via conversationId, runs via
 *     taskId, snapshots via containerId, ...)
 *   - K8s pods backing every IMContainer in the workspace (best-effort)
 *   - Agent IMUser rows (role='agent') belonging to this workspace
 *
 * Does NOT touch:
 *   - Owner IMUser (their other workspaces stay; pc_user_credits stays)
 *   - pc_api_keys (account-level)
 *   - pc_usage_records / pc_payments / pc_subscriptions (billing audit)
 *   - Global tables: ContextCache, IMRoleTemplate, community boards/posts,
 *     IMUser non-agent rows, IMEvolutionEdge, IMDIDMapping, leaderboards
 *
 * The cascade is NOT wrapped in a $transaction — large workspaces would
 * lock multiple tables for minutes. Instead each table is its own
 * deleteMany; if interrupted mid-way the operation is idempotent (re-run
 * picks up whatever is left because filters are workspaceId-based or
 * id-in-collected-list-based).
 *
 * Caller responsibility:
 *   - Verify ownership BEFORE invoking (this service does not re-check)
 *   - Acquire a Redis lock so two parallel clears don't race
 *
 * Progress reporting: the `emit` callback is called for each step transition
 * so the HTTP route can stream SSE events back to the browser. The progress
 * type is the discriminated union below.
 */

import prisma from '../db';
import { resolvePersistent } from '../../lib/sandbox/registry';
import { logger } from '../../lib/logger';
import type { RoomManager } from '../ws/rooms';
import { ServerEvents } from '../ws/events';

export type ClearProgressStep =
  | 'authorize'
  | 'collect-ids'
  | 'k8s-pods-teardown'
  | 'messaging'
  | 'tasks'
  | 'containers'
  | 'assets'
  | 'agents'
  | 'memory-knowledge'
  | 'evolution-graph'
  | 'community-files-channels'
  | 'misc-tables'
  | 'agent-imusers'
  | 'workspace-row'
  // release201/09 §9.4b — final cascade step: fan out to every daemon that
  // hosted any agent in the cleared workspace so they wipe local hermes
  // profile memories + per-agent memory dir cloud cannot see.
  | 'daemon-cleanup';

export interface ClearProgressEvent {
  step: ClearProgressStep;
  status: 'in_progress' | 'completed' | 'error';
  /** Items affected this step (rows deleted or pods killed). */
  count?: number;
  /** Human-readable label for UI rendering. */
  label?: string;
  error?: string;
}

export interface WorkspaceClearPreview {
  workspaceId: string;
  name: string;
  ownerImUserId: string;
  counts: {
    agents: number;
    conversations: number;
    messages: number;
    tasks: number;
    taskRuns: number;
    containers: number;
    runningContainers: number;
    assets: number;
    memoryFiles: number;
    workspaceFiles: number;
    channels: number;
    members: number;
  };
}

export class WorkspaceClearError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'NOT_OWNER' | 'INTERNAL',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceClearError';
  }
}

/**
 * Compute the preview counts shown in the confirm modal. Read-only.
 */
export async function previewWorkspaceClear(workspaceId: string): Promise<WorkspaceClearPreview> {
  const ws = (await (prisma as any).iMWorkspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, ownerImUserId: true, deletedAt: true },
  })) as { id: string; name: string; ownerImUserId: string; deletedAt: Date | null } | null;
  if (!ws || ws.deletedAt) throw new WorkspaceClearError('NOT_FOUND', 'Workspace not found');

  const [
    agents,
    conversations,
    messages,
    tasks,
    taskRuns,
    containers,
    runningContainers,
    assets,
    memoryFiles,
    workspaceFiles,
    channels,
    members,
  ] = await Promise.all([
    (prisma as any).iMAgentProfile.count({ where: { workspaceId } }),
    (prisma as any).iMConversation.count({ where: { workspaceId } }),
    (prisma as any).iMMessage.count({ where: { conversation: { workspaceId } } }),
    (prisma as any).iMTask.count({ where: { workspaceId } }),
    (prisma as any).iMTaskRun.count({ where: { workspaceId } }),
    (prisma as any).iMContainer.count({ where: { workspaceId } }),
    (prisma as any).iMContainer.count({
      where: { workspaceId, status: { notIn: ['stopped', 'errored', 'failed'] } },
    }),
    (prisma as any).iMAsset.count({ where: { workspaceId } }),
    (prisma as any).iMMemoryFile.count({ where: { workspaceId } }),
    (prisma as any).iMWorkspaceFile.count({ where: { workspaceId } }),
    (prisma as any).iMChannelAccount.count({ where: { workspaceId } }),
    (prisma as any).iMWorkspaceMember.count({ where: { workspaceId } }),
  ]);

  return {
    workspaceId,
    name: ws.name,
    ownerImUserId: ws.ownerImUserId,
    counts: {
      agents,
      conversations,
      messages,
      tasks,
      taskRuns,
      containers,
      runningContainers,
      assets,
      memoryFiles,
      workspaceFiles,
      channels,
      members,
    },
  };
}

type EmitFn = (event: ClearProgressEvent) => void | Promise<void>;

interface StepRunner {
  step: ClearProgressStep;
  label: string;
  run: () => Promise<number>;
}

/**
 * Execute the cascade. Calls `emit(...)` before + after each step so the
 * caller can fan progress out via SSE.
 *
 * Caller must have already verified the requester owns the workspace.
 */
export interface ClearWorkspaceCascadeOptions {
  /** RoomManager for the final daemon-side wipe fan-out (release201/09 §9.4b).
   * Optional so tests / non-WS callers can still run the cloud-side cascade;
   * when null the daemon-cleanup step logs "skipped (no rooms)" and the
   * cascade still completes successfully. */
  rooms?: RoomManager | null;
}

export async function clearWorkspaceCascade(
  workspaceId: string,
  emit: EmitFn,
  options: ClearWorkspaceCascadeOptions = {},
): Promise<void> {
  const ws = (await (prisma as any).iMWorkspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, ownerImUserId: true },
  })) as { id: string; ownerImUserId: string } | null;
  if (!ws) throw new WorkspaceClearError('NOT_FOUND', 'Workspace not found');

  await emit({ step: 'authorize', status: 'completed', label: 'Verified workspace exists' });

  // ── Collect IDs across all child tables in a single pass ──────────────
  await emit({ step: 'collect-ids', status: 'in_progress', label: 'Indexing child rows' });
  const [conversations, tasks, containers, sandboxRuns, agentProfiles] = await Promise.all([
    (prisma as any).iMConversation.findMany({ where: { workspaceId }, select: { id: true } }),
    (prisma as any).iMTask.findMany({ where: { workspaceId }, select: { id: true } }),
    (prisma as any).iMContainer.findMany({
      where: { workspaceId },
      select: { id: true, podName: true, runtimeKind: true, status: true },
    }),
    (prisma as any).iMSandboxRun.findMany({ where: { workspaceId }, select: { id: true } }),
    (prisma as any).iMAgentProfile.findMany({ where: { workspaceId }, select: { agentImUserId: true } }),
  ]);
  const conversationIds = (conversations as Array<{ id: string }>).map((r) => r.id);
  const taskIds = (tasks as Array<{ id: string }>).map((r) => r.id);
  const containerIds = (containers as Array<{ id: string }>).map((r) => r.id);
  const sandboxRunIds = (sandboxRuns as Array<{ id: string }>).map((r) => r.id);
  const agentImUserIds = (agentProfiles as Array<{ agentImUserId: string }>)
    .map((r) => r.agentImUserId)
    .filter(Boolean);
  await emit({
    step: 'collect-ids',
    status: 'completed',
    count: conversationIds.length + taskIds.length + containerIds.length + agentImUserIds.length,
    label: `${conversationIds.length} convs, ${taskIds.length} tasks, ${containerIds.length} containers, ${agentImUserIds.length} agents`,
  });

  // ── K8s pods (best-effort, parallel) ──────────────────────────────────
  const activePods = (containers as Array<{ podName: string; runtimeKind: string; status: string }>).filter(
    (c) => c.runtimeKind === 'k8s' && c.status !== 'stopped' && c.status !== 'errored' && c.status !== 'failed',
  );
  await emit({ step: 'k8s-pods-teardown', status: 'in_progress', label: `Tearing down ${activePods.length} pod(s)` });
  let podsKilled = 0;
  if (activePods.length > 0) {
    const provider = resolvePersistent('k8s');
    await Promise.all(
      activePods.map(async (c) => {
        try {
          await provider.removeEnvironment(c.podName);
          podsKilled++;
        } catch (err) {
          logger.warn(
            { workspaceId, podName: c.podName, err: err instanceof Error ? err.message : String(err) },
            '[workspace-clear] pod teardown failed (continuing)',
          );
        }
      }),
    );
  }
  await emit({ step: 'k8s-pods-teardown', status: 'completed', count: podsKilled, label: `Killed ${podsKilled}/${activePods.length} pod(s)` });

  // ── Helpers ──────────────────────────────────────────────────────────
  const safeDeleteMany = async (label: string, fn: () => Promise<{ count: number }>): Promise<number> => {
    try {
      const r = await fn();
      return r.count;
    } catch (err) {
      logger.warn(
        { workspaceId, label, err: err instanceof Error ? err.message : String(err) },
        '[workspace-clear] deleteMany failed (continuing)',
      );
      return 0;
    }
  };

  const runStep = async (step: ClearProgressStep, label: string, fn: () => Promise<number>): Promise<void> => {
    await emit({ step, status: 'in_progress', label });
    try {
      const count = await fn();
      await emit({ step, status: 'completed', count, label });
    } catch (err) {
      await emit({
        step,
        status: 'error',
        label,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  // ── Messaging children (deepest first) ────────────────────────────────
  await runStep('messaging', 'Deleting messages, partials, sync events, conv security/policy', async () => {
    let total = 0;
    // IMMessage cascades reactions; partials deleted explicitly. Sync events,
    // participants, read cursors cascade from IMConversation. Belt-and-suspenders:
    // delete each table explicitly so cascade availability variations don't matter.
    if (conversationIds.length > 0) {
      total += await safeDeleteMany('msg_partials', () =>
        (prisma as any).iMMessagePartial.deleteMany({ where: { conversationId: { in: conversationIds } } }),
      );
      total += await safeDeleteMany('msg_reactions', () =>
        (prisma as any).iMMessageReaction.deleteMany({ where: { conversationId: { in: conversationIds } } }),
      );
      total += await safeDeleteMany('messages', () =>
        (prisma as any).iMMessage.deleteMany({ where: { conversationId: { in: conversationIds } } }),
      );
      total += await safeDeleteMany('participants', () =>
        (prisma as any).iMParticipant.deleteMany({ where: { conversationId: { in: conversationIds } } }),
      );
      total += await safeDeleteMany('read_cursors', () =>
        (prisma as any).iMReadCursor.deleteMany({ where: { conversationId: { in: conversationIds } } }),
      );
      total += await safeDeleteMany('sync_events', () =>
        (prisma as any).iMSyncEvent.deleteMany({ where: { conversationId: { in: conversationIds } } }),
      );
      total += await safeDeleteMany('conv_seq', () =>
        (prisma as any).iMConversationSeq.deleteMany({ where: { conversationId: { in: conversationIds } } }),
      );
      total += await safeDeleteMany('conv_security', () =>
        (prisma as any).iMConversationSecurity.deleteMany({ where: { conversationId: { in: conversationIds } } }),
      );
      total += await safeDeleteMany('conv_policy', () =>
        (prisma as any).iMConversationPolicy.deleteMany({ where: { conversationId: { in: conversationIds } } }),
      );
    }
    return total;
  });

  // ── Task children ────────────────────────────────────────────────────
  // Belt-and-suspenders: FK-based delete (taskId IN [...]) catches the
  // common case where the run/event/approval is tied to a still-existing
  // parent task we already collected. The workspaceId-based delete that
  // follows catches the gap exposed in 2026-05-24 forensic on workspace
  // cmp49uds5: 70 free-standing IMTaskRun rows had `taskId=null` (created
  // via runtimeRoute='agent' direct dispatch, never reified into im_tasks),
  // so the `taskId IN (...)` filter passed over them silently — `NULL IN
  // (any-list)` is `UNKNOWN` in SQL, never matches. Same risk applies to
  // any other child table whose FK to the parent is nullable.
  await runStep('tasks', 'Deleting task runs, steps, events, logs, approvals', async () => {
    let total = 0;
    if (taskIds.length > 0) {
      total += await safeDeleteMany('task_run_steps', () =>
        (prisma as any).iMTaskRunStep.deleteMany({ where: { taskId: { in: taskIds } } }),
      );
      total += await safeDeleteMany('task_runs_by_task', () =>
        (prisma as any).iMTaskRun.deleteMany({ where: { taskId: { in: taskIds } } }),
      );
      total += await safeDeleteMany('task_events_by_task', () =>
        (prisma as any).iMTaskEvent.deleteMany({ where: { taskId: { in: taskIds } } }),
      );
      total += await safeDeleteMany('task_logs', () =>
        (prisma as any).iMTaskLog.deleteMany({ where: { taskId: { in: taskIds } } }),
      );
      total += await safeDeleteMany('dispatch_replies', () =>
        (prisma as any).iMDispatchReply.deleteMany({ where: { taskId: { in: taskIds } } }),
      );
      total += await safeDeleteMany('approvals_by_task', () =>
        (prisma as any).iMApproval.deleteMany({ where: { taskId: { in: taskIds } } }),
      );
    }
    // Workspace-level safety net for the 3 child tables that also carry
    // workspaceId. These catch standalone runs (taskId=null) + rows whose
    // parent task was already deleted out-of-band before this cascade ran.
    total += await safeDeleteMany('task_runs_by_workspace', () =>
      (prisma as any).iMTaskRun.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('task_events_by_workspace', () =>
      (prisma as any).iMTaskEvent.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('approvals_by_workspace', () =>
      (prisma as any).iMApproval.deleteMany({ where: { workspaceId } }),
    );
    return total;
  });

  // ── Container + sandbox children ──────────────────────────────────────
  await runStep('containers', 'Deleting container snapshots, sandbox runs + logs + samples', async () => {
    let total = 0;
    if (containerIds.length > 0) {
      total += await safeDeleteMany('container_snapshots', () =>
        (prisma as any).iMContainerSnapshot.deleteMany({ where: { containerId: { in: containerIds } } }),
      );
    }
    if (sandboxRunIds.length > 0) {
      total += await safeDeleteMany('sandbox_run_logs_by_run', () =>
        (prisma as any).iMSandboxRunLog.deleteMany({ where: { runId: { in: sandboxRunIds } } }),
      );
      total += await safeDeleteMany('sandbox_resource_samples', () =>
        (prisma as any).iMSandboxResourceSample.deleteMany({ where: { runId: { in: sandboxRunIds } } }),
      );
    }
    // Workspace-level safety net (same rationale as task_runs above).
    total += await safeDeleteMany('sandbox_run_logs_by_workspace', () =>
      (prisma as any).iMSandboxRunLog.deleteMany({ where: { workspaceId } }),
    );
    return total;
  });

  // ── Asset children (revisions cascade from IMAsset but explicit anyway) ─
  await runStep('assets', 'Deleting asset revisions + refs + counters', async () => {
    let total = 0;
    total += await safeDeleteMany('asset_revisions', () =>
      (prisma as any).iMAssetRevision.deleteMany({ where: { workspaceId } }),
    );
    return total;
  });

  // ── Agent children (bindings, snapshots) ──────────────────────────────
  await runStep('agents', 'Deleting agent bindings, snapshots, cards, skills', async () => {
    let total = 0;
    if (agentImUserIds.length > 0) {
      total += await safeDeleteMany('agent_bindings', () =>
        (prisma as any).iMAgentBinding.deleteMany({ where: { agentImUserId: { in: agentImUserIds } } }),
      );
    }
    total += await safeDeleteMany('agent_snapshots', () =>
      (prisma as any).iMAgentSnapshot.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('agent_cards', () =>
      (prisma as any).iMAgentCard.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('agent_skills', () =>
      (prisma as any).iMAgentSkill.deleteMany({ where: { workspaceId } }),
    );
    return total;
  });

  // ── Memory + Knowledge ────────────────────────────────────────────────
  await runStep('memory-knowledge', 'Deleting memory files, pages, links, knowledge graph', async () => {
    let total = 0;
    total += await safeDeleteMany('memory_file_versions', () =>
      // No direct workspaceId on versions in some schemas; fall through.
      (prisma as any).iMMemoryFileVersion?.deleteMany?.({
        where: { memoryFile: { workspaceId } },
      }) ?? Promise.resolve({ count: 0 }),
    );
    total += await safeDeleteMany('memory_page_versions', () =>
      (prisma as any).iMMemoryPageVersion?.deleteMany?.({
        where: { memoryPage: { workspaceId } },
      }) ?? Promise.resolve({ count: 0 }),
    );
    total += await safeDeleteMany('memory_files', () =>
      (prisma as any).iMMemoryFile.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('memory_pages', () =>
      (prisma as any).iMMemoryPage.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('memory_links', () =>
      (prisma as any).iMMemoryLink.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('memory_sync_events', () =>
      (prisma as any).iMMemorySyncEvent.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('memory_observability_events', () =>
      (prisma as any).iMMemoryObservabilityEvent.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('memory_proposals', () =>
      (prisma as any).iMMemoryProposal.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('compaction_summaries', () =>
      (prisma as any).iMCompactionSummary.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('knowledge_links', () =>
      (prisma as any).iMKnowledgeLink.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('skills', () =>
      (prisma as any).iMSkill.deleteMany({ where: { workspaceId } }),
    );
    return total;
  });

  // ── Evolution + Hypergraph + Causal ──────────────────────────────────
  await runStep('evolution-graph', 'Deleting evolution metrics, capsules, atoms, hyperedges', async () => {
    let total = 0;
    total += await safeDeleteMany('genes', () => (prisma as any).iMGene.deleteMany({ where: { workspaceId } }));
    total += await safeDeleteMany('gene_signals', () =>
      (prisma as any).iMGeneSignal.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('unmatched_signals', () =>
      (prisma as any).iMUnmatchedSignal.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('signal_clusters', () =>
      (prisma as any).iMSignalCluster.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('evolution_capsules', () =>
      (prisma as any).iMEvolutionCapsule.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('evolution_metrics', () =>
      (prisma as any).iMEvolutionMetrics.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('evolution_achievements', () =>
      (prisma as any).iMEvolutionAchievement.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('evolution_acl', () =>
      (prisma as any).iMEvolutionACL.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('token_baseline', () =>
      (prisma as any).iMTokenBaseline.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('value_metrics', () =>
      (prisma as any).iMValueMetrics.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('hyperedge_atoms', () =>
      (prisma as any).iMHyperedgeAtom.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('hyperedges', () =>
      (prisma as any).iMHyperedge.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('atoms', () => (prisma as any).iMAtom.deleteMany({ where: { workspaceId } }));
    total += await safeDeleteMany('causal_links', () =>
      (prisma as any).iMCausalLink.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('ingest_claims', () =>
      (prisma as any).iMIngestClaim.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('anti_cheat_log', () =>
      (prisma as any).iMAntiCheatLog.deleteMany({ where: { workspaceId } }),
    );
    return total;
  });

  // ── Community-bookmarks/drafts + workspace files + channels ──────────
  await runStep('community-files-channels', 'Deleting community refs, files, channels', async () => {
    let total = 0;
    total += await safeDeleteMany('community_bookmarks', () =>
      (prisma as any).iMCommunityBookmark.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('community_drafts', () =>
      (prisma as any).iMCommunityDraft.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('workspace_files', () =>
      (prisma as any).iMWorkspaceFile.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('channel_accounts', () =>
      (prisma as any).iMChannelAccount.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('asset_index_counters', () =>
      (prisma as any).iMAssetIndexCounter.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('approvals_orphan', () =>
      // Already deleted by task step; safe no-op if none remain.
      (prisma as any).iMApproval.deleteMany({ where: { workspaceId } }),
    );
    return total;
  });

  // ── Main entity rows ─────────────────────────────────────────────────
  await runStep('misc-tables', 'Deleting conversations, tasks, containers, sandboxes, assets, profiles', async () => {
    let total = 0;
    total += await safeDeleteMany('containers', () =>
      (prisma as any).iMContainer.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('sandbox_runs', () =>
      (prisma as any).iMSandboxRun.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('sandbox_quotas', () =>
      (prisma as any).iMSandboxQuota.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('assets', () => (prisma as any).iMAsset.deleteMany({ where: { workspaceId } }));
    total += await safeDeleteMany('tasks', () => (prisma as any).iMTask.deleteMany({ where: { workspaceId } }));
    total += await safeDeleteMany('conversations', () =>
      (prisma as any).iMConversation.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('agent_profiles', () =>
      (prisma as any).iMAgentProfile.deleteMany({ where: { workspaceId } }),
    );
    total += await safeDeleteMany('workspace_members', () =>
      (prisma as any).iMWorkspaceMember.deleteMany({ where: { workspaceId } }),
    );
    return total;
  });

  // ── Agent IMUser rows (role='agent', belong to this workspace) ───────
  await runStep('agent-imusers', 'Deleting agent user rows', async () => {
    if (agentImUserIds.length === 0) return 0;
    const r = await safeDeleteMany('agent_imusers', () =>
      (prisma as any).iMUser.deleteMany({
        where: { id: { in: agentImUserIds }, role: 'agent' },
      }),
    );
    return r;
  });

  // ── Final: IMWorkspace row itself ────────────────────────────────────
  await runStep('workspace-row', 'Deleting workspace row', async () => {
    const r = await safeDeleteMany('workspace', () =>
      (prisma as any).iMWorkspace.deleteMany({ where: { id: workspaceId } }),
    );
    return r;
  });

  // ── Daemon-side wipe (release201/09 §9.4b) ──────────────────────────
  // Last step intentionally — cloud rows are now all gone, so the daemon
  // fan-out is purely local-FS cleanup of the 4 paths cloud cannot see
  // (~/.hermes/profiles/<n>/memories/{MEMORY,USER}.md + sessions/state.db
  // + SOUL.md, plus ~/.prismer/devices/<did>/agents/<aid>/memory/*). Wipe
  // is best-effort: emission failure is logged but never throws (cloud
  // cascade already succeeded; orphan files are a degraded but consistent
  // outcome). Skill dirs are NOT wiped — sha256-diff sync (§9.3.2) owns
  // skill lifecycle and a future configure / dispatch will re-emit the
  // memory: + hooks: blocks in config.yaml.
  await runStep('daemon-cleanup', 'Fan out daemon-side wipe', async () => {
    if (!options.rooms) {
      logger.info(
        { workspaceId, agents: agentImUserIds.length },
        '[workspace-clear] daemon-cleanup skipped (no RoomManager provided)',
      );
      return 0;
    }
    if (agentImUserIds.length === 0) return 0;
    const event = ServerEvents.workspaceClearDaemonCleanup({
      workspaceId,
      agentImUserIds,
      clearedAt: new Date().toISOString(),
    });
    let delivered = 0;
    for (const agentImUserId of agentImUserIds) {
      try {
        options.rooms.sendToUser(agentImUserId, event);
        delivered++;
      } catch (err) {
        logger.warn(
          { workspaceId, agentImUserId, err: err instanceof Error ? err.message : String(err) },
          '[workspace-clear] daemon-cleanup fan-out failed for agent (continuing)',
        );
      }
    }
    return delivered;
  });

  logger.info({ workspaceId, ownerImUserId: ws.ownerImUserId }, '[workspace-clear] complete');
}
