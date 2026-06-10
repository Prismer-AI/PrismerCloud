/**
 * Forensic DB-snapshot helpers for the admin debug pipeline.
 *
 * Phase A scope (docs/release201/06-debug-pipeline-design.md §3.7): a single
 * read-only `getWorkspaceSnapshot()` that returns the same join shape the
 * `scripts/forensics/*.ts` ad-hoc queries used to produce. Phase C extends
 * with `task`, `conversation`, `container` entities.
 *
 * Read-only Prisma access. Each query is bounded (`take: N`) so a single
 * call against a large workspace stays well under route budget.
 */

import prisma from '@/lib/prisma';

const RECENT_MESSAGES_LIMIT = 50;
const RECENT_TASK_RUNS_LIMIT = 20;
const MEMBERS_HARD_CAP = 200;
const AGENTS_HARD_CAP = 100;
const CONVERSATIONS_HARD_CAP = 100;
const TASKS_HARD_CAP = 100;
const CONTAINERS_HARD_CAP = 50;
const ASSETS_HARD_CAP = 100;

export interface WorkspaceSnapshotMember {
  id: string;
  memberImUserId: string;
  role: string;
  joinedAt: string;
}

export interface WorkspaceSnapshotAgent {
  id: string;
  agentImUserId: string;
  adapterName: string;
  name: string;
  version: number;
  createdAt: string;
  deletedAt: string | null;
}

export interface WorkspaceSnapshotConversation {
  id: string;
  type: string;
  title: string | null;
  status: string;
  createdById: string;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface WorkspaceSnapshotTask {
  id: string;
  title: string;
  status: string;
  currentPhase: string | null;
  creatorId: string;
  assigneeId: string | null;
  containerId: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSnapshotContainer {
  id: string;
  podName: string;
  namespace: string;
  status: string;
  runtimeKind: string;
  image: string;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  daemonId: string | null;
  lastDaemonHealthAt: string | null;
}

export interface WorkspaceSnapshotAsset {
  id: string;
  kind: string;
  mime: string | null;
  sizeBytes: string | null; // BigInt → string for JSON safety
  contentHash: string;
  sourceTaskId: string | null;
  createdAt: string;
}

export interface WorkspaceSnapshotMessage {
  id: string;
  conversationId: string;
  senderId: string;
  type: string;
  contentPreview: string;
  status: string;
  createdAt: string;
}

export interface WorkspaceSnapshotTaskRun {
  id: string;
  taskId: string | null;
  status: string;
  conversationId: string | null;
  assigneeId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface WorkspaceSnapshot {
  workspace: {
    id: string;
    name: string;
    slug: string;
    ownerImUserId: string;
    isDefault: boolean;
    orchestratorAgentId: string | null;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
  };
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
  members: WorkspaceSnapshotMember[];
  agents: WorkspaceSnapshotAgent[];
  conversations: WorkspaceSnapshotConversation[];
  tasks: WorkspaceSnapshotTask[];
  containers: WorkspaceSnapshotContainer[];
  assets: WorkspaceSnapshotAsset[];
  recentMessages: WorkspaceSnapshotMessage[];
  recentTaskRuns: WorkspaceSnapshotTaskRun[];
}

export class WorkspaceSnapshotNotFoundError extends Error {
  constructor(id: string) {
    super(`workspace not found: ${id}`);
    this.name = 'WorkspaceSnapshotNotFoundError';
  }
}

export class TaskSnapshotNotFoundError extends Error {
  constructor(id: string) {
    super(`task not found: ${id}`);
    this.name = 'TaskSnapshotNotFoundError';
  }
}

export class ConversationSnapshotNotFoundError extends Error {
  constructor(id: string) {
    super(`conversation not found: ${id}`);
    this.name = 'ConversationSnapshotNotFoundError';
  }
}

export class ContainerSnapshotNotFoundError extends Error {
  constructor(id: string) {
    super(`container not found: ${id}`);
    this.name = 'ContainerSnapshotNotFoundError';
  }
}

function bigIntToString(v: bigint | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'bigint' ? v.toString() : String(v);
}

function preview(s: string | null | undefined, max = 200): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/**
 * Read-only workspace snapshot — workspace meta + counts (via the
 * `previewWorkspaceClear` aggregate that already exists) + bounded lists
 * of the most-recent related rows. All queries are read-only / no FK side
 * effects.
 */
export async function getWorkspaceSnapshot(workspaceId: string): Promise<WorkspaceSnapshot> {
  const ws = await prisma.iMWorkspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      slug: true,
      ownerImUserId: true,
      isDefault: true,
      orchestratorAgentId: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
    },
  });

  if (!ws) throw new WorkspaceSnapshotNotFoundError(workspaceId);

  // Counts mirror `previewWorkspaceClear` (src/im/services/workspace-clear.service.ts)
  // so the snapshot's counts match what the workspace-clear modal would show.
  // Inlined here to honour the lib→lib boundary rule (no `@/im` imports from lib).
  const [
    agentCount,
    conversationCount,
    messageCount,
    taskCount,
    taskRunCount,
    containerCount,
    runningContainerCount,
    assetCount,
    memoryFileCount,
    workspaceFileCount,
    channelCount,
    memberCount,
  ] = await Promise.all([
    prisma.iMAgentProfile.count({ where: { workspaceId } }),
    prisma.iMConversation.count({ where: { workspaceId } }),
    prisma.iMMessage.count({ where: { conversation: { workspaceId } } }),
    prisma.iMTask.count({ where: { workspaceId } }),
    prisma.iMTaskRun.count({ where: { workspaceId } }),
    prisma.iMContainer.count({ where: { workspaceId } }),
    prisma.iMContainer.count({
      where: { workspaceId, status: { notIn: ['stopped', 'errored', 'failed'] } },
    }),
    prisma.iMAsset.count({ where: { workspaceId } }),
    prisma.iMMemoryFile.count({ where: { workspaceId } }),
    prisma.iMWorkspaceFile.count({ where: { workspaceId } }),
    prisma.iMChannelAccount.count({ where: { workspaceId } }),
    prisma.iMWorkspaceMember.count({ where: { workspaceId } }),
  ]);
  const counts: WorkspaceSnapshot['counts'] = {
    agents: agentCount,
    conversations: conversationCount,
    messages: messageCount,
    tasks: taskCount,
    taskRuns: taskRunCount,
    containers: containerCount,
    runningContainers: runningContainerCount,
    assets: assetCount,
    memoryFiles: memoryFileCount,
    workspaceFiles: workspaceFileCount,
    channels: channelCount,
    members: memberCount,
  };

  const [
    members,
    agents,
    conversations,
    tasks,
    containers,
    assets,
    recentMessages,
    recentTaskRuns,
  ] = await Promise.all([
    prisma.iMWorkspaceMember.findMany({
      where: { workspaceId },
      orderBy: { joinedAt: 'asc' },
      take: MEMBERS_HARD_CAP,
      select: { id: true, memberImUserId: true, role: true, joinedAt: true },
    }),
    prisma.iMAgentProfile.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: AGENTS_HARD_CAP,
      select: {
        id: true,
        agentImUserId: true,
        adapterName: true,
        name: true,
        version: true,
        createdAt: true,
        deletedAt: true,
      },
    }),
    prisma.iMConversation.findMany({
      where: { workspaceId },
      orderBy: { lastMessageAt: 'desc' },
      take: CONVERSATIONS_HARD_CAP,
      select: {
        id: true,
        type: true,
        title: true,
        status: true,
        createdById: true,
        lastMessageAt: true,
        createdAt: true,
      },
    }),
    prisma.iMTask.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      take: TASKS_HARD_CAP,
      select: {
        id: true,
        title: true,
        status: true,
        currentPhase: true,
        creatorId: true,
        assigneeId: true,
        containerId: true,
        runCount: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.iMContainer.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: CONTAINERS_HARD_CAP,
      select: {
        id: true,
        podName: true,
        namespace: true,
        status: true,
        runtimeKind: true,
        image: true,
        createdAt: true,
        startedAt: true,
        stoppedAt: true,
        daemonId: true,
        lastDaemonHealthAt: true,
      },
    }),
    prisma.iMAsset.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: ASSETS_HARD_CAP,
      select: {
        id: true,
        kind: true,
        mime: true,
        sizeBytes: true,
        contentHash: true,
        sourceTaskId: true,
        createdAt: true,
      },
    }),
    // Recent messages — join via conversation.workspaceId since IMMessage
    // itself doesn't carry workspaceId.
    prisma.iMMessage.findMany({
      where: { conversation: { workspaceId } },
      orderBy: { createdAt: 'desc' },
      take: RECENT_MESSAGES_LIMIT,
      select: {
        id: true,
        conversationId: true,
        senderId: true,
        type: true,
        content: true,
        status: true,
        createdAt: true,
      },
    }),
    prisma.iMTaskRun.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: RECENT_TASK_RUNS_LIMIT,
      select: {
        id: true,
        taskId: true,
        status: true,
        conversationId: true,
        assigneeId: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    workspace: {
      id: ws.id,
      name: ws.name,
      slug: ws.slug,
      ownerImUserId: ws.ownerImUserId,
      isDefault: ws.isDefault,
      orchestratorAgentId: ws.orchestratorAgentId ?? null,
      createdAt: ws.createdAt.toISOString(),
      updatedAt: ws.updatedAt.toISOString(),
      deletedAt: ws.deletedAt ? ws.deletedAt.toISOString() : null,
    },
    counts,
    members: (members as Array<{ id: string; memberImUserId: string; role: string; joinedAt: Date }>).map((m) => ({
      id: m.id,
      memberImUserId: m.memberImUserId,
      role: m.role,
      joinedAt: m.joinedAt.toISOString(),
    })),
    agents: (agents as Array<{
      id: string;
      agentImUserId: string;
      adapterName: string;
      name: string;
      version: number;
      createdAt: Date;
      deletedAt: Date | null;
    }>).map((a) => ({
      id: a.id,
      agentImUserId: a.agentImUserId,
      adapterName: a.adapterName,
      name: a.name,
      version: a.version,
      createdAt: a.createdAt.toISOString(),
      deletedAt: a.deletedAt ? a.deletedAt.toISOString() : null,
    })),
    conversations: (conversations as Array<{
      id: string;
      type: string;
      title: string | null;
      status: string;
      createdById: string;
      lastMessageAt: Date | null;
      createdAt: Date;
    }>).map((c) => ({
      id: c.id,
      type: c.type,
      title: c.title,
      status: c.status,
      createdById: c.createdById,
      lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
      createdAt: c.createdAt.toISOString(),
    })),
    tasks: (tasks as Array<{
      id: string;
      title: string;
      status: string;
      currentPhase: string | null;
      creatorId: string;
      assigneeId: string | null;
      containerId: string | null;
      runCount: number;
      createdAt: Date;
      updatedAt: Date;
    }>).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      currentPhase: t.currentPhase,
      creatorId: t.creatorId,
      assigneeId: t.assigneeId,
      containerId: t.containerId,
      runCount: t.runCount,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
    containers: (containers as Array<{
      id: string;
      podName: string;
      namespace: string;
      status: string;
      runtimeKind: string;
      image: string;
      createdAt: Date;
      startedAt: Date | null;
      stoppedAt: Date | null;
      daemonId: string | null;
      lastDaemonHealthAt: Date | null;
    }>).map((c) => ({
      id: c.id,
      podName: c.podName,
      namespace: c.namespace,
      status: c.status,
      runtimeKind: c.runtimeKind,
      image: c.image,
      createdAt: c.createdAt.toISOString(),
      startedAt: c.startedAt ? c.startedAt.toISOString() : null,
      stoppedAt: c.stoppedAt ? c.stoppedAt.toISOString() : null,
      daemonId: c.daemonId,
      lastDaemonHealthAt: c.lastDaemonHealthAt ? c.lastDaemonHealthAt.toISOString() : null,
    })),
    assets: (assets as Array<{
      id: string;
      kind: string;
      mime: string | null;
      sizeBytes: bigint | null;
      contentHash: string;
      sourceTaskId: string | null;
      createdAt: Date;
    }>).map((a) => ({
      id: a.id,
      kind: a.kind,
      mime: a.mime,
      sizeBytes: bigIntToString(a.sizeBytes),
      contentHash: a.contentHash,
      sourceTaskId: a.sourceTaskId,
      createdAt: a.createdAt.toISOString(),
    })),
    recentMessages: (recentMessages as Array<{
      id: string;
      conversationId: string;
      senderId: string;
      type: string;
      content: string;
      status: string;
      createdAt: Date;
    }>).map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,
      type: m.type,
      contentPreview: preview(m.content),
      status: m.status,
      createdAt: m.createdAt.toISOString(),
    })),
    recentTaskRuns: (recentTaskRuns as Array<{
      id: string;
      taskId: string | null;
      status: string;
      conversationId: string | null;
      assigneeId: string | null;
      startedAt: Date | null;
      completedAt: Date | null;
      createdAt: Date;
    }>).map((r) => ({
      id: r.id,
      taskId: r.taskId,
      status: r.status,
      conversationId: r.conversationId,
      assigneeId: r.assigneeId,
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

// ============================================================================
// Phase C — task / conversation / container entity snapshots
// (docs/release201/06-debug-pipeline-design.md §3.7)
// ============================================================================

const TASK_RUN_STEPS_LIMIT = 50;
const TASK_EVENTS_LIMIT = 50;
const TASK_LOGS_LIMIT = 50;
const TASK_DISPATCH_REPLIES_LIMIT = 20;
const TASK_APPROVALS_LIMIT = 20;
const TASK_ASSETS_LIMIT = 50;
const TASK_SURROUNDING_MESSAGES_LIMIT = 10;
const TASK_SURROUNDING_WINDOW_MS = 5 * 60 * 1000;

const CONV_MESSAGES_LIMIT = 100;
const CONV_PARTIALS_LIMIT = 50;
const CONV_TASK_REFS_LIMIT = 50;

const CONTAINER_SNAPSHOTS_LIMIT = 20;
const CONTAINER_SANDBOX_RUNS_LIMIT = 20;
const CONTAINER_BINDINGS_LIMIT = 50;
const CONTAINER_DISPATCH_REPLIES_LIMIT = 50;

export interface TaskSnapshot {
  task: {
    id: string;
    title: string;
    description: string | null;
    capability: string | null;
    runtimeRoute: string | null;
    status: string;
    currentPhase: string | null;
    progress: number | null;
    statusMessage: string | null;
    creatorId: string;
    assigneeId: string | null;
    conversationId: string | null;
    workspaceId: string | null;
    containerId: string | null;
    contextUri: string | null;
    resultUri: string | null;
    error: string | null;
    inputPreview: string;
    resultPreview: string;
    runCount: number;
    cost: number;
    metadataPreview: string;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    lastRunAt: string | null;
    lastHeartbeatAt: string | null;
  };
  runs: Array<{
    id: string;
    status: string;
    runtimeRoute: string | null;
    assigneeId: string | null;
    conversationId: string | null;
    error: string | null;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
  }>;
  runSteps: Array<{
    id: string;
    taskRunId: string;
    seq: string;
    kind: string;
    payloadPreview: string;
    occurredAt: string;
    durationMs: number | null;
  }>;
  events: Array<{
    id: string;
    runId: string;
    type: string;
    level: string;
    message: string | null;
    payloadPreview: string;
    createdAt: string;
  }>;
  logs: Array<{
    id: string;
    actorId: string | null;
    action: string;
    message: string | null;
    createdAt: string;
  }>;
  dispatchReplies: Array<{
    id: string;
    idempotencyKey: string;
    status: string;
    preparedAt: string;
    committedAt: string | null;
    abortedAt: string | null;
  }>;
  approvals: Array<{
    id: string;
    workspaceId: string;
    conversationId: string | null;
    category: string;
    title: string;
    status: string;
    selectedValue: string | null;
    decidedById: string | null;
    decidedAt: string | null;
    createdAt: string;
  }>;
  assetsByTaskId: Array<{
    id: string;
    kind: string;
    mime: string | null;
    sizeBytes: string | null;
    contentHash: string;
    filename: string | null;
    folderPath: string | null;
    createdAt: string;
  }>;
  surroundingMessages: Array<{
    id: string;
    conversationId: string;
    senderId: string;
    type: string;
    contentPreview: string;
    status: string;
    createdAt: string;
  }>;
}

/**
 * Read-only single-task snapshot — task row + recent runs / runSteps / events /
 * logs / dispatch-replies / approvals + assets sourced by taskId + the
 * surrounding ±5min messages in the task's conversation (if any).
 *
 * Bounded queries; safe to call on hot tasks (each list capped).
 */
export async function getTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
  const task = await prisma.iMTask.findUnique({ where: { id: taskId } });
  if (!task) throw new TaskSnapshotNotFoundError(taskId);

  const createdAt = task.createdAt;
  const windowStart = new Date(createdAt.getTime() - TASK_SURROUNDING_WINDOW_MS);
  const windowEnd = new Date(createdAt.getTime() + TASK_SURROUNDING_WINDOW_MS);

  const [
    runs,
    runSteps,
    events,
    logs,
    dispatchReplies,
    approvals,
    assetsByTaskId,
    surroundingMessages,
  ] = await Promise.all([
    prisma.iMTaskRun.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      take: RECENT_TASK_RUNS_LIMIT,
      select: {
        id: true,
        status: true,
        runtimeRoute: true,
        assigneeId: true,
        conversationId: true,
        error: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
    }),
    prisma.iMTaskRunStep.findMany({
      where: { taskId },
      orderBy: { occurredAt: 'desc' },
      take: TASK_RUN_STEPS_LIMIT,
      select: {
        id: true,
        taskRunId: true,
        seq: true,
        kind: true,
        payloadJson: true,
        occurredAt: true,
        durationMs: true,
      },
    }),
    prisma.iMTaskEvent.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      take: TASK_EVENTS_LIMIT,
      select: {
        id: true,
        runId: true,
        type: true,
        level: true,
        message: true,
        payload: true,
        createdAt: true,
      },
    }),
    prisma.iMTaskLog.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      take: TASK_LOGS_LIMIT,
      select: {
        id: true,
        actorId: true,
        action: true,
        message: true,
        createdAt: true,
      },
    }),
    prisma.iMDispatchReply.findMany({
      where: { taskId },
      orderBy: { preparedAt: 'desc' },
      take: TASK_DISPATCH_REPLIES_LIMIT,
      select: {
        id: true,
        idempotencyKey: true,
        status: true,
        preparedAt: true,
        committedAt: true,
        abortedAt: true,
      },
    }),
    prisma.iMApproval.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      take: TASK_APPROVALS_LIMIT,
      select: {
        id: true,
        workspaceId: true,
        conversationId: true,
        category: true,
        title: true,
        status: true,
        selectedValue: true,
        decidedById: true,
        decidedAt: true,
        createdAt: true,
      },
    }),
    prisma.iMAsset.findMany({
      where: { sourceTaskId: taskId },
      orderBy: { createdAt: 'desc' },
      take: TASK_ASSETS_LIMIT,
      select: {
        id: true,
        kind: true,
        mime: true,
        sizeBytes: true,
        contentHash: true,
        filename: true,
        folderPath: true,
        createdAt: true,
      },
    }),
    task.conversationId
      ? prisma.iMMessage.findMany({
          where: {
            conversationId: task.conversationId,
            createdAt: { gte: windowStart, lte: windowEnd },
          },
          orderBy: { createdAt: 'asc' },
          take: TASK_SURROUNDING_MESSAGES_LIMIT,
          select: {
            id: true,
            conversationId: true,
            senderId: true,
            type: true,
            content: true,
            status: true,
            createdAt: true,
          },
        })
      : Promise.resolve([] as Array<{
          id: string;
          conversationId: string;
          senderId: string;
          type: string;
          content: string;
          status: string;
          createdAt: Date;
        }>),
  ]);

  return {
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      capability: task.capability,
      runtimeRoute: task.runtimeRoute,
      status: task.status,
      currentPhase: task.currentPhase,
      progress: task.progress,
      statusMessage: task.statusMessage,
      creatorId: task.creatorId,
      assigneeId: task.assigneeId,
      conversationId: task.conversationId,
      workspaceId: task.workspaceId,
      containerId: task.containerId,
      contextUri: task.contextUri,
      resultUri: task.resultUri,
      error: task.error,
      inputPreview: preview(task.input, 500),
      resultPreview: preview(task.result, 500),
      runCount: task.runCount,
      cost: task.cost,
      metadataPreview: preview(task.metadata, 500),
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      completedAt: task.completedAt ? task.completedAt.toISOString() : null,
      lastRunAt: task.lastRunAt ? task.lastRunAt.toISOString() : null,
      lastHeartbeatAt: task.lastHeartbeatAt ? task.lastHeartbeatAt.toISOString() : null,
    },
    runs: (runs as Array<{
      id: string;
      status: string;
      runtimeRoute: string | null;
      assigneeId: string | null;
      conversationId: string | null;
      error: string | null;
      startedAt: Date | null;
      completedAt: Date | null;
      createdAt: Date;
    }>).map((r) => ({
      id: r.id,
      status: r.status,
      runtimeRoute: r.runtimeRoute,
      assigneeId: r.assigneeId,
      conversationId: r.conversationId,
      error: r.error,
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    runSteps: (runSteps as Array<{
      id: string;
      taskRunId: string;
      seq: bigint | number;
      kind: string;
      payloadJson: string;
      occurredAt: Date;
      durationMs: number | null;
    }>).map((s) => ({
      id: s.id,
      taskRunId: s.taskRunId,
      seq: typeof s.seq === 'bigint' ? s.seq.toString() : String(s.seq),
      kind: s.kind,
      payloadPreview: preview(s.payloadJson, 500),
      occurredAt: s.occurredAt.toISOString(),
      durationMs: s.durationMs,
    })),
    events: (events as Array<{
      id: string;
      runId: string;
      type: string;
      level: string;
      message: string | null;
      payload: string;
      createdAt: Date;
    }>).map((e) => ({
      id: e.id,
      runId: e.runId,
      type: e.type,
      level: e.level,
      message: e.message,
      payloadPreview: preview(e.payload, 500),
      createdAt: e.createdAt.toISOString(),
    })),
    logs: (logs as Array<{
      id: string;
      actorId: string | null;
      action: string;
      message: string | null;
      createdAt: Date;
    }>).map((l) => ({
      id: l.id,
      actorId: l.actorId,
      action: l.action,
      message: l.message,
      createdAt: l.createdAt.toISOString(),
    })),
    dispatchReplies: (dispatchReplies as Array<{
      id: string;
      idempotencyKey: string;
      status: string;
      preparedAt: Date;
      committedAt: Date | null;
      abortedAt: Date | null;
    }>).map((d) => ({
      id: d.id,
      idempotencyKey: d.idempotencyKey,
      status: d.status,
      preparedAt: d.preparedAt.toISOString(),
      committedAt: d.committedAt ? d.committedAt.toISOString() : null,
      abortedAt: d.abortedAt ? d.abortedAt.toISOString() : null,
    })),
    approvals: (approvals as Array<{
      id: string;
      workspaceId: string;
      conversationId: string | null;
      category: string;
      title: string;
      status: string;
      selectedValue: string | null;
      decidedById: string | null;
      decidedAt: Date | null;
      createdAt: Date;
    }>).map((a) => ({
      id: a.id,
      workspaceId: a.workspaceId,
      conversationId: a.conversationId,
      category: a.category,
      title: a.title,
      status: a.status,
      selectedValue: a.selectedValue,
      decidedById: a.decidedById,
      decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
      createdAt: a.createdAt.toISOString(),
    })),
    assetsByTaskId: (assetsByTaskId as Array<{
      id: string;
      kind: string;
      mime: string | null;
      sizeBytes: bigint | null;
      contentHash: string;
      filename: string | null;
      folderPath: string | null;
      createdAt: Date;
    }>).map((a) => ({
      id: a.id,
      kind: a.kind,
      mime: a.mime,
      sizeBytes: bigIntToString(a.sizeBytes),
      contentHash: a.contentHash,
      filename: a.filename,
      folderPath: a.folderPath,
      createdAt: a.createdAt.toISOString(),
    })),
    surroundingMessages: (surroundingMessages as Array<{
      id: string;
      conversationId: string;
      senderId: string;
      type: string;
      content: string;
      status: string;
      createdAt: Date;
    }>).map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,
      type: m.type,
      contentPreview: preview(m.content),
      status: m.status,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

export interface ConversationSnapshot {
  conversation: {
    id: string;
    type: string;
    title: string | null;
    description: string | null;
    status: string;
    workspaceId: string | null;
    createdById: string;
    lastMessageAt: string | null;
    metadataPreview: string;
    createdAt: string;
    updatedAt: string;
  };
  participants: Array<{
    id: string;
    imUserId: string;
    role: string;
    joinedAt: string;
    leftAt: string | null;
    pinned: boolean;
    muted: boolean;
  }>;
  recentMessages: Array<{
    id: string;
    senderId: string;
    type: string;
    contentPreview: string;
    status: string;
    parentId: string | null;
    quotedMessageId: string | null;
    idempotencyKey: string | null;
    encrypted: boolean;
    createdAt: string;
  }>;
  partials: Array<{
    id: string;
    messageId: string;
    chunkSeq: number;
    chunkPreview: string;
    createdAt: string;
  }>;
  taskRefs: Array<{
    id: string;
    title: string;
    status: string;
    currentPhase: string | null;
    assigneeId: string | null;
    containerId: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}

/**
 * Read-only single-conversation snapshot — conversation meta + participants
 * + last 100 messages + recent partials (in-flight streaming chunks) +
 * tasks referencing this conversation.
 */
export async function getConversationSnapshot(convId: string): Promise<ConversationSnapshot> {
  const conv = await prisma.iMConversation.findUnique({ where: { id: convId } });
  if (!conv) throw new ConversationSnapshotNotFoundError(convId);

  const [participants, recentMessages, taskRefs] = await Promise.all([
    prisma.iMParticipant.findMany({
      where: { conversationId: convId },
      orderBy: { joinedAt: 'asc' },
      take: MEMBERS_HARD_CAP,
      select: {
        id: true,
        imUserId: true,
        role: true,
        joinedAt: true,
        leftAt: true,
        pinned: true,
        muted: true,
      },
    }),
    prisma.iMMessage.findMany({
      where: { conversationId: convId },
      orderBy: { createdAt: 'desc' },
      take: CONV_MESSAGES_LIMIT,
      select: {
        id: true,
        senderId: true,
        type: true,
        content: true,
        status: true,
        parentId: true,
        quotedMessageId: true,
        idempotencyKey: true,
        encrypted: true,
        createdAt: true,
      },
    }),
    prisma.iMTask.findMany({
      where: { conversationId: convId },
      orderBy: { updatedAt: 'desc' },
      take: CONV_TASK_REFS_LIMIT,
      select: {
        id: true,
        title: true,
        status: true,
        currentPhase: true,
        assigneeId: true,
        containerId: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  // Partials are keyed by messageId — fetch the partial rows whose
  // messageId belongs to one of the recent messages we just pulled.
  const recentMessageIds = (recentMessages as Array<{ id: string }>).map((m) => m.id);
  const partials = recentMessageIds.length === 0
    ? []
    : await prisma.iMMessagePartial.findMany({
        where: { messageId: { in: recentMessageIds } },
        orderBy: { createdAt: 'desc' },
        take: CONV_PARTIALS_LIMIT,
        select: {
          id: true,
          messageId: true,
          chunkSeq: true,
          chunkText: true,
          createdAt: true,
        },
      });

  return {
    conversation: {
      id: conv.id,
      type: conv.type,
      title: conv.title,
      description: conv.description,
      status: conv.status,
      workspaceId: conv.workspaceId,
      createdById: conv.createdById,
      lastMessageAt: conv.lastMessageAt ? conv.lastMessageAt.toISOString() : null,
      metadataPreview: preview(conv.metadata, 500),
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
    },
    participants: (participants as Array<{
      id: string;
      imUserId: string;
      role: string;
      joinedAt: Date;
      leftAt: Date | null;
      pinned: boolean;
      muted: boolean;
    }>).map((p) => ({
      id: p.id,
      imUserId: p.imUserId,
      role: p.role,
      joinedAt: p.joinedAt.toISOString(),
      leftAt: p.leftAt ? p.leftAt.toISOString() : null,
      pinned: p.pinned,
      muted: p.muted,
    })),
    recentMessages: (recentMessages as Array<{
      id: string;
      senderId: string;
      type: string;
      content: string;
      status: string;
      parentId: string | null;
      quotedMessageId: string | null;
      idempotencyKey: string | null;
      encrypted: boolean;
      createdAt: Date;
    }>).map((m) => ({
      id: m.id,
      senderId: m.senderId,
      type: m.type,
      contentPreview: preview(m.content),
      status: m.status,
      parentId: m.parentId,
      quotedMessageId: m.quotedMessageId,
      idempotencyKey: m.idempotencyKey,
      encrypted: m.encrypted,
      createdAt: m.createdAt.toISOString(),
    })),
    partials: (partials as Array<{
      id: string;
      messageId: string;
      chunkSeq: number;
      chunkText: string;
      createdAt: Date;
    }>).map((p) => ({
      id: p.id,
      messageId: p.messageId,
      chunkSeq: p.chunkSeq,
      chunkPreview: preview(p.chunkText, 200),
      createdAt: p.createdAt.toISOString(),
    })),
    taskRefs: (taskRefs as Array<{
      id: string;
      title: string;
      status: string;
      currentPhase: string | null;
      assigneeId: string | null;
      containerId: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      currentPhase: t.currentPhase,
      assigneeId: t.assigneeId,
      containerId: t.containerId,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
  };
}

export interface ContainerSnapshot {
  container: {
    id: string;
    podName: string;
    namespace: string;
    workspaceId: string;
    tenantId: string;
    taskId: string | null;
    agentImUserId: string | null;
    status: string;
    runtimeKind: string;
    deviceType: string;
    providerKind: string;
    image: string;
    imageTag: string;
    daemonId: string | null;
    gatewayUrl: string | null;
    transport: string | null;
    gatewayIsPrivate: boolean | null;
    cpuRequest: string;
    cpuLimit: string;
    memoryRequest: string;
    memoryLimit: string;
    maxAgents: number;
    provisioningStep: string | null;
    provisioningHistory: unknown;
    daemonHealthMisses: number;
    lastDaemonHealthAt: string | null;
    lastProbeAt: string | null;
    startedAt: string | null;
    stoppedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  snapshots: Array<{
    id: string;
    imageTag: string | null;
    imageDigest: string | null;
    sizeBytes: string | null;
    createdBy: string;
    metadataPreview: string;
    createdAt: string;
  }>;
  sandboxRuns: Array<{
    id: string;
    providerKind: string;
    executionKind: string;
    workspaceId: string;
    taskId: string | null;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    exitCode: number | null;
    exitReason: string | null;
    cpuSeconds: number | null;
    memoryGbHours: number | null;
    billedAmountCents: number | null;
    createdAt: string;
  }>;
  bindings: Array<{
    id: string;
    agentImUserId: string;
    boundDaemonId: string;
    boundDaemonKind: string;
    boundDaemonLabel: string;
    boundAt: string;
    boundBy: string;
    lastHostDeclareAt: string;
    lastDispatchAt: string | null;
    contestedSince: string | null;
    contestCount: number;
  }>;
  recentDispatches: Array<{
    id: string;
    taskId: string;
    idempotencyKey: string;
    status: string;
    preparedAt: string;
    committedAt: string | null;
    abortedAt: string | null;
  }>;
}

/**
 * Read-only single-container snapshot — container row (incl. provisioning
 * history) + snapshots + sandboxRuns + agent bindings whose
 * `boundDaemonId === container.daemonId` + recent dispatch replies whose
 * `taskId` belongs to tasks dispatched to this container's daemonId
 * (best-effort: filtered via `IMTask.containerId === container.id`).
 */
export async function getContainerSnapshot(containerId: string): Promise<ContainerSnapshot> {
  const container = await prisma.iMContainer.findUnique({ where: { id: containerId } });
  if (!container) throw new ContainerSnapshotNotFoundError(containerId);

  const [snapshots, sandboxRuns, bindings] = await Promise.all([
    prisma.iMContainerSnapshot.findMany({
      where: { containerId },
      orderBy: { createdAt: 'desc' },
      take: CONTAINER_SNAPSHOTS_LIMIT,
      select: {
        id: true,
        imageTag: true,
        imageDigest: true,
        sizeBytes: true,
        createdBy: true,
        metadata: true,
        createdAt: true,
      },
    }),
    prisma.iMSandboxRun.findMany({
      where: { containerId },
      orderBy: { startedAt: 'desc' },
      take: CONTAINER_SANDBOX_RUNS_LIMIT,
      select: {
        id: true,
        providerKind: true,
        executionKind: true,
        workspaceId: true,
        taskId: true,
        startedAt: true,
        endedAt: true,
        durationMs: true,
        exitCode: true,
        exitReason: true,
        cpuSeconds: true,
        memoryGbHours: true,
        billedAmountCents: true,
        createdAt: true,
      },
    }),
    container.daemonId
      ? prisma.iMAgentBinding.findMany({
          where: { boundDaemonId: container.daemonId },
          orderBy: { boundAt: 'desc' },
          take: CONTAINER_BINDINGS_LIMIT,
          select: {
            id: true,
            agentImUserId: true,
            boundDaemonId: true,
            boundDaemonKind: true,
            boundDaemonLabel: true,
            boundAt: true,
            boundBy: true,
            lastHostDeclareAt: true,
            lastDispatchAt: true,
            contestedSince: true,
            contestCount: true,
          },
        })
      : Promise.resolve([] as Array<{
          id: string;
          agentImUserId: string;
          boundDaemonId: string;
          boundDaemonKind: string;
          boundDaemonLabel: string;
          boundAt: Date;
          boundBy: string;
          lastHostDeclareAt: Date;
          lastDispatchAt: Date | null;
          contestedSince: Date | null;
          contestCount: number;
        }>),
  ]);

  // Best-effort recent dispatches: tasks whose containerId points at this
  // container, then collect their dispatch replies. Bounded by
  // CONTAINER_DISPATCH_REPLIES_LIMIT after a small task scan.
  const localTaskRows = await prisma.iMTask.findMany({
    where: { containerId },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: { id: true },
  });
  const taskIds = (localTaskRows as Array<{ id: string }>).map((t) => t.id);
  const recentDispatches = taskIds.length === 0
    ? []
    : await prisma.iMDispatchReply.findMany({
        where: { taskId: { in: taskIds } },
        orderBy: { preparedAt: 'desc' },
        take: CONTAINER_DISPATCH_REPLIES_LIMIT,
        select: {
          id: true,
          taskId: true,
          idempotencyKey: true,
          status: true,
          preparedAt: true,
          committedAt: true,
          abortedAt: true,
        },
      });

  return {
    container: {
      id: container.id,
      podName: container.podName,
      namespace: container.namespace,
      workspaceId: container.workspaceId,
      tenantId: container.tenantId,
      taskId: container.taskId,
      agentImUserId: container.agentImUserId,
      status: container.status,
      runtimeKind: container.runtimeKind,
      deviceType: container.deviceType,
      providerKind: container.providerKind,
      image: container.image,
      imageTag: container.imageTag,
      daemonId: container.daemonId,
      gatewayUrl: container.gatewayUrl,
      transport: container.transport,
      gatewayIsPrivate: container.gatewayIsPrivate,
      cpuRequest: container.cpuRequest,
      cpuLimit: container.cpuLimit,
      memoryRequest: container.memoryRequest,
      memoryLimit: container.memoryLimit,
      maxAgents: container.maxAgents,
      provisioningStep: container.provisioningStep,
      provisioningHistory: container.provisioningHistory ?? null,
      daemonHealthMisses: container.daemonHealthMisses,
      lastDaemonHealthAt: container.lastDaemonHealthAt
        ? container.lastDaemonHealthAt.toISOString()
        : null,
      lastProbeAt: container.lastProbeAt ? container.lastProbeAt.toISOString() : null,
      startedAt: container.startedAt ? container.startedAt.toISOString() : null,
      stoppedAt: container.stoppedAt ? container.stoppedAt.toISOString() : null,
      createdAt: container.createdAt.toISOString(),
      updatedAt: container.updatedAt.toISOString(),
    },
    snapshots: (snapshots as Array<{
      id: string;
      imageTag: string | null;
      imageDigest: string | null;
      sizeBytes: bigint | null;
      createdBy: string;
      metadata: string;
      createdAt: Date;
    }>).map((s) => ({
      id: s.id,
      imageTag: s.imageTag,
      imageDigest: s.imageDigest,
      sizeBytes: bigIntToString(s.sizeBytes),
      createdBy: s.createdBy,
      metadataPreview: preview(s.metadata, 500),
      createdAt: s.createdAt.toISOString(),
    })),
    sandboxRuns: (sandboxRuns as Array<{
      id: string;
      providerKind: string;
      executionKind: string;
      workspaceId: string;
      taskId: string | null;
      startedAt: Date;
      endedAt: Date | null;
      durationMs: number | null;
      exitCode: number | null;
      exitReason: string | null;
      cpuSeconds: number | null;
      memoryGbHours: number | null;
      billedAmountCents: number | null;
      createdAt: Date;
    }>).map((r) => ({
      id: r.id,
      providerKind: r.providerKind,
      executionKind: r.executionKind,
      workspaceId: r.workspaceId,
      taskId: r.taskId,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
      durationMs: r.durationMs,
      exitCode: r.exitCode,
      exitReason: r.exitReason,
      cpuSeconds: r.cpuSeconds,
      memoryGbHours: r.memoryGbHours,
      billedAmountCents: r.billedAmountCents,
      createdAt: r.createdAt.toISOString(),
    })),
    bindings: (bindings as Array<{
      id: string;
      agentImUserId: string;
      boundDaemonId: string;
      boundDaemonKind: string;
      boundDaemonLabel: string;
      boundAt: Date;
      boundBy: string;
      lastHostDeclareAt: Date;
      lastDispatchAt: Date | null;
      contestedSince: Date | null;
      contestCount: number;
    }>).map((b) => ({
      id: b.id,
      agentImUserId: b.agentImUserId,
      boundDaemonId: b.boundDaemonId,
      boundDaemonKind: b.boundDaemonKind,
      boundDaemonLabel: b.boundDaemonLabel,
      boundAt: b.boundAt.toISOString(),
      boundBy: b.boundBy,
      lastHostDeclareAt: b.lastHostDeclareAt.toISOString(),
      lastDispatchAt: b.lastDispatchAt ? b.lastDispatchAt.toISOString() : null,
      contestedSince: b.contestedSince ? b.contestedSince.toISOString() : null,
      contestCount: b.contestCount,
    })),
    recentDispatches: (recentDispatches as Array<{
      id: string;
      taskId: string;
      idempotencyKey: string;
      status: string;
      preparedAt: Date;
      committedAt: Date | null;
      abortedAt: Date | null;
    }>).map((d) => ({
      id: d.id,
      taskId: d.taskId,
      idempotencyKey: d.idempotencyKey,
      status: d.status,
      preparedAt: d.preparedAt.toISOString(),
      committedAt: d.committedAt ? d.committedAt.toISOString() : null,
      abortedAt: d.abortedAt ? d.abortedAt.toISOString() : null,
    })),
  };
}
