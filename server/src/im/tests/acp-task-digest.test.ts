/**
 * Task Digest — release 200 P9 acceptance tests.
 *
 * Covers `TaskDigestService.upsertTaskDigest` — the single rolling
 * conversation digest message per task. The contract (§7 trailing
 * paragraph + §9 P9):
 *
 *   1. First transition for a (conversation, task) pair → INSERT one
 *      `IMMessage` with `metadata.taskDigest`.
 *   2. Subsequent transitions for the same task → UPDATE the same message
 *      (not a new row).
 *   3. After N transitions, the conversation still has exactly ONE digest
 *      message per task; its `metadata` reflects the most recent state.
 *   4. Different tasks in the same conversation each own their own digest.
 *   5. Tasks without a `conversationId` skip the digest entirely (e.g.
 *      isolated work-item tasks created outside chat).
 *   6. Lookup discriminator: `digestKind:'task_digest'` + the specific
 *      `taskId` — robust to unrelated system messages.
 *
 * Test counts: 9 cases (≥ 8 required by the P9 spec).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Prisma mock — IMMessage.findFirst is the digest-service lookup; the WS2
// re-emit suite below also exercises iMTask.findUnique (task row) +
// iMAsset.count/findMany (live deliverable count + refs).
const prismaMock = {
  iMMessage: { findFirst: vi.fn() },
  iMTask: { findUnique: vi.fn() },
  iMAsset: { count: vi.fn(), findMany: vi.fn() },
};

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/im/db', () => ({ default: prismaMock }));

// WS2 — emitTaskStatusChat fans out a bell notification + sync as a `void`
// side-effect; stub the imported notification helper so the re-emit suite
// stays focused on the digest payload and never reaches the real notifier.
vi.mock('@/lib/notification-emitter', () => ({
  emitTaskStatusNotification: vi.fn(async () => {}),
  emitTaskAssignedNotification: vi.fn(async () => {}),
  emitTaskApprovalRequestedNotification: vi.fn(async () => {}),
}));
// WS2 — task.service.ts imports k8s helpers at module load; stub so the
// re-emit suite can `import('@/im/services/task.service')` without a cluster.
vi.mock('@/lib/k8s-sandbox', () => ({
  K8sSandboxError: class K8sSandboxError extends Error {},
  k8sSandbox: {},
}));
vi.mock('@/lib/k8s-client', () => ({ getK8sNamespace: vi.fn(() => 'test') }));

function resetMocks() {
  prismaMock.iMMessage.findFirst.mockReset();
  prismaMock.iMTask.findUnique.mockReset();
  prismaMock.iMAsset.count.mockReset();
  prismaMock.iMAsset.findMany.mockReset();
}

interface FakeMessage {
  id: string;
  conversationId: string;
  content: string;
  metadataObj: Record<string, unknown>;
}

/**
 * In-memory "messages table" so the test can assert exactly one row per
 * (conversationId, taskId) across many upsert calls. The fake mirrors the
 * real prisma row enough for the digest service's contains-LIKE lookup
 * (we re-implement the filter logic in JS for the tests).
 */
function buildFakeStore() {
  const store: FakeMessage[] = [];
  let nextId = 0;

  const send = vi.fn(async (input: any) => {
    nextId += 1;
    const row: FakeMessage = {
      id: `msg_${nextId}`,
      conversationId: input.conversationId,
      content: input.content,
      metadataObj: input.metadata ?? {},
    };
    store.push(row);
    return { message: row };
  });

  const update = vi.fn(async (id: string, data: any) => {
    const row = store.find((r) => r.id === id);
    if (!row) throw new Error(`message ${id} not found`);
    if (typeof data.content === 'string') row.content = data.content;
    if (data.metadata) row.metadataObj = data.metadata;
    return row;
  });

  // Wire findFirst to the in-memory store. It interprets `metadata.contains`
  // string filters in AND[] the same way Prisma would.
  prismaMock.iMMessage.findFirst.mockImplementation(async (args: any) => {
    const where = args.where ?? {};
    const conversationId = where.conversationId;
    const requiredContains: string[] = [];
    if (Array.isArray(where.AND)) {
      for (const clause of where.AND) {
        if (clause?.metadata?.contains) requiredContains.push(clause.metadata.contains);
      }
    }
    if (where.metadata?.contains) requiredContains.push(where.metadata.contains);
    const candidates = store.filter((row) => row.conversationId === conversationId);
    for (const row of candidates) {
      const json = JSON.stringify(row.metadataObj);
      const allMatch = requiredContains.every((needle) => json.includes(needle));
      if (allMatch) return { id: row.id };
    }
    return null;
  });

  return { store, send, update };
}

async function buildDigestService(deps: { send: any; update: any }) {
  const { TaskDigestService } = await import('@/im/services/task-digest.service');
  return new TaskDigestService({
    messageService: { send: deps.send, update: deps.update },
  });
}

const baseTask = {
  id: 'task_abc',
  title: 'Fix login bug',
  conversationId: 'conv_1',
  creatorId: 'creator_1',
  assigneeId: 'agent_1',
  workspaceId: 'ws_1',
};

describe('TaskDigestService.upsertTaskDigest — release 200 P9', () => {
  beforeEach(resetMocks);

  it('first transition inserts one digest message', async () => {
    const fake = buildFakeStore();
    const svc = await buildDigestService(fake);
    await svc.upsertTaskDigest(baseTask, { from: 'pending', to: 'assigned', by: 'creator_1' });
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.store).toHaveLength(1);
    const row = fake.store[0];
    expect(row.conversationId).toBe('conv_1');
    expect(row.content).toContain('Fix login bug');
    expect(row.metadataObj.digestKind).toBe('task_digest');
    const td = row.metadataObj.taskDigest as any;
    expect(td.taskId).toBe('task_abc');
    expect(td.status).toBe('assigned');
  });

  it('second transition for same task updates the existing row (no new insert)', async () => {
    const fake = buildFakeStore();
    const svc = await buildDigestService(fake);
    await svc.upsertTaskDigest(baseTask, { from: 'pending', to: 'assigned', by: 'creator_1' });
    await svc.upsertTaskDigest(baseTask, { from: 'assigned', to: 'running', by: 'agent_1' });
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.update).toHaveBeenCalledTimes(1);
    expect(fake.store).toHaveLength(1);
    const td = fake.store[0].metadataObj.taskDigest as any;
    expect(td.status).toBe('running');
    expect(td.latestTransition.from).toBe('assigned');
    expect(td.latestTransition.to).toBe('running');
  });

  it('full lifecycle (5 transitions) leaves exactly 1 digest message reflecting final state', async () => {
    const fake = buildFakeStore();
    const svc = await buildDigestService(fake);
    const path: Array<['pending' | 'assigned' | 'running' | 'review' | 'completed', 'assigned' | 'running' | 'review' | 'completed']> = [
      ['pending', 'assigned'],
      ['assigned', 'running'],
      ['running', 'review'],
      ['review', 'completed'],
    ];
    for (const [from, to] of path) {
      await svc.upsertTaskDigest(baseTask, { from, to, by: 'creator_1' });
    }
    expect(fake.store).toHaveLength(1);
    const td = fake.store[0].metadataObj.taskDigest as any;
    expect(td.status).toBe('completed');
    expect(td.latestTransition.from).toBe('review');
    expect(td.latestTransition.to).toBe('completed');
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.update).toHaveBeenCalledTimes(3);
  });

  it('different tasks in same conversation get separate digest rows', async () => {
    const fake = buildFakeStore();
    const svc = await buildDigestService(fake);
    await svc.upsertTaskDigest(baseTask, { from: 'pending', to: 'assigned' });
    await svc.upsertTaskDigest(
      { ...baseTask, id: 'task_xyz', title: 'Other task' },
      { from: 'pending', to: 'assigned' },
    );
    expect(fake.store).toHaveLength(2);
    const ids = fake.store.map((r) => (r.metadataObj.taskDigest as any).taskId).sort();
    expect(ids).toEqual(['task_abc', 'task_xyz']);
  });

  it('skips entirely when task has no conversationId (no insert, no update)', async () => {
    const fake = buildFakeStore();
    const svc = await buildDigestService(fake);
    await svc.upsertTaskDigest(
      { ...baseTask, conversationId: null },
      { from: 'pending', to: 'assigned' },
    );
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.store).toHaveLength(0);
  });

  it('blocked transition records the reason in the digest payload', async () => {
    const fake = buildFakeStore();
    const svc = await buildDigestService(fake);
    await svc.upsertTaskDigest(baseTask, {
      from: 'running',
      to: 'blocked',
      by: 'agent_1',
      reason: 'Missing OPENAI_API_KEY',
    });
    const td = fake.store[0].metadataObj.taskDigest as any;
    expect(td.status).toBe('blocked');
    expect(td.latestTransition.reason).toBe('Missing OPENAI_API_KEY');
    expect(fake.store[0].content).toContain('Missing OPENAI_API_KEY');
  });

  it('failed transition records error in both payload and content (truncated)', async () => {
    const fake = buildFakeStore();
    const svc = await buildDigestService(fake);
    const longError = 'crash: ' + 'X'.repeat(300);
    await svc.upsertTaskDigest(baseTask, {
      from: 'running',
      to: 'failed',
      by: 'agent_1',
      error: longError,
      reason: longError,
    });
    const td = fake.store[0].metadataObj.taskDigest as any;
    expect(td.status).toBe('failed');
    expect(td.error.length).toBeLessThanOrEqual(500);
    expect(fake.store[0].content).toContain('Task failed');
  });

  it('non-digest system messages in the conversation are not mistaken for a digest', async () => {
    const fake = buildFakeStore();
    // Pre-seed a non-digest system message (e.g. a member_join notice).
    fake.store.push({
      id: 'msg_seed',
      conversationId: 'conv_1',
      content: 'member joined',
      metadataObj: { kind: 'member_join' },
    });
    const svc = await buildDigestService(fake);
    await svc.upsertTaskDigest(baseTask, { from: 'pending', to: 'assigned' });
    // Must NOT have updated the seed row.
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.store).toHaveLength(2);
  });

  it('completed transition with resultAssetCount surfaces the product-asset chip payload (B-line)', async () => {
    const fake = buildFakeStore();
    const svc = await buildDigestService(fake);
    await svc.upsertTaskDigest(baseTask, {
      from: 'review',
      to: 'completed',
      by: 'creator_1',
      resultAssetCount: 3,
      resultAssets: [
        { assetId: 'a1', filename: 'research-summary.md', mime: 'text/markdown' },
        { assetId: 'a2', filename: 'data.csv', mime: 'text/csv' },
      ],
    });
    const td = fake.store[0].metadataObj.taskDigest as any;
    expect(td.status).toBe('completed');
    expect(td.resultAssetCount).toBe(3);
    expect(Array.isArray(td.resultAssets)).toBe(true);
    expect(td.resultAssets).toHaveLength(2);
    expect(td.resultAssets[0]).toEqual({ assetId: 'a1', filename: 'research-summary.md', mime: 'text/markdown' });
  });

  it('completed transition with zero resultAssetCount omits the asset fields (zero-noise)', async () => {
    const fake = buildFakeStore();
    const svc = await buildDigestService(fake);
    await svc.upsertTaskDigest(baseTask, {
      from: 'review',
      to: 'completed',
      by: 'creator_1',
      resultAssetCount: 0,
      resultAssets: null,
    });
    const td = fake.store[0].metadataObj.taskDigest as any;
    expect(td.resultAssetCount).toBeUndefined();
    expect(td.resultAssets).toBeUndefined();
  });

  it('caps resultAssets refs at 4 in the payload', async () => {
    const fake = buildFakeStore();
    const svc = await buildDigestService(fake);
    await svc.upsertTaskDigest(baseTask, {
      from: 'review',
      to: 'completed',
      resultAssetCount: 7,
      resultAssets: Array.from({ length: 7 }, (_, i) => ({ assetId: `a${i}`, filename: `f${i}.md` })),
    });
    const td = fake.store[0].metadataObj.taskDigest as any;
    expect(td.resultAssetCount).toBe(7);
    expect(td.resultAssets).toHaveLength(4);
  });

  it('failure inside messageService.send is swallowed (does not throw to caller)', async () => {
    const fake = buildFakeStore();
    fake.send.mockRejectedValueOnce(new Error('mysql tantrum'));
    const svc = await buildDigestService(fake);
    await expect(
      svc.upsertTaskDigest(baseTask, { from: 'pending', to: 'assigned' }),
    ).resolves.toBeUndefined();
    // Subsequent calls still succeed (no internal latch).
    await expect(
      svc.upsertTaskDigest(baseTask, { from: 'pending', to: 'assigned' }),
    ).resolves.toBeUndefined();
  });
});

/**
 * WS2 (release201/3x) — late-arriving / orphan deliverable assets re-upsert
 * the completion digest, so chat's `resultAssetCount` reaches final
 * consistency with the drawer Artifacts tab.
 *
 * Scenario the original code missed: a task closes (`completed`) with N
 * deliverables snapshotted on its digest card; the daemon outbox then flushes
 * an (N+1)-th asset (dispatch.ts "uploaded but unflushed"). POST /assets
 * appends the id to `metadata.outputAssetIds` + drawer, but the chat digest
 * was frozen at N. `TaskService.reemitTerminalDigestForAssetArrival` re-derives
 * the asset set from the persisted row and re-upserts the SAME digest message
 * with the fresh live count (`prisma.iMAsset.count({ deletedAt: null })`).
 */
describe('TaskService.reemitTerminalDigestForAssetArrival — WS2 late-asset digest refresh', () => {
  beforeEach(resetMocks);

  async function buildTaskService(fake: { send: any; update: any }) {
    const { TaskService } = await import('@/im/services/task.service');
    const svc = new TaskService({
      messageService: { send: fake.send, update: fake.update },
      rooms: { sendToUser: vi.fn() },
    } as any);
    // Bell/notification fan-out is a `void` side-effect, not the unit under
    // test — stub the method so the suite focuses on the digest payload.
    (svc as any).fanOutBellSync = vi.fn().mockResolvedValue(undefined);
    return svc;
  }

  function terminalTaskRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'task_abc',
      title: 'Fix login bug',
      conversationId: 'conv_1',
      creatorId: 'creator_1',
      assigneeId: 'agent_1',
      workspaceId: 'ws_1',
      status: 'completed',
      result: JSON.stringify({ assetIds: ['a1', 'a2'] }),
      metadata: JSON.stringify({ outputAssetIds: ['a1', 'a2', 'a3'] }),
      ...overrides,
    };
  }

  // Live-asset count + refs come from prisma; default = all listed ids alive.
  function mockLiveAssets(ids: string[]) {
    prismaMock.iMAsset.count.mockImplementation(async (args: any) => {
      const inIds: string[] = args?.where?.id?.in ?? [];
      return inIds.filter((id) => ids.includes(id)).length;
    });
    prismaMock.iMAsset.findMany.mockImplementation(async (args: any) => {
      const inIds: string[] = args?.where?.id?.in ?? [];
      return inIds
        .filter((id) => ids.includes(id))
        .map((id) => ({ id, filename: `${id}.md`, mime: 'text/markdown' }));
    });
  }

  it('re-upserts the existing digest with the grown resultAssetCount (no new message)', async () => {
    const fake = buildFakeStore();
    // Seed the completion digest as if the task closed with 2 deliverables.
    fake.store.push({
      id: 'msg_digest',
      conversationId: 'conv_1',
      content: '✅ Task completed: **Fix login bug**',
      metadataObj: {
        digestKind: 'task_digest',
        taskId: 'task_abc',
        taskDigest: { taskId: 'task_abc', status: 'completed', resultAssetCount: 2 },
      },
    });
    prismaMock.iMTask.findUnique.mockResolvedValue(terminalTaskRow());
    mockLiveAssets(['a1', 'a2', 'a3']); // the 3rd asset just arrived

    const svc = await buildTaskService(fake);
    await svc.reemitTerminalDigestForAssetArrival('task_abc');

    // Exactly one digest row — UPDATE, never a second INSERT.
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.update).toHaveBeenCalledTimes(1);
    const digestRows = fake.store.filter((r) => (r.metadataObj as any).digestKind === 'task_digest');
    expect(digestRows).toHaveLength(1);
    const td = digestRows[0].metadataObj.taskDigest as any;
    expect(td.status).toBe('completed');
    expect(td.resultAssetCount).toBe(3); // 2 → 3, late asset counted
    expect(td.resultAssets).toHaveLength(3);
  });

  it('count reflects live assets only (deleted late asset does not inflate the chip)', async () => {
    const fake = buildFakeStore();
    prismaMock.iMTask.findUnique.mockResolvedValue(terminalTaskRow());
    mockLiveAssets(['a1', 'a2']); // a3 was deleted before the re-emit ran

    const svc = await buildTaskService(fake);
    await svc.reemitTerminalDigestForAssetArrival('task_abc');

    const td = (fake.store[0].metadataObj.taskDigest as any);
    expect(td.resultAssetCount).toBe(2); // deletedAt:null count, not raw id count of 3
  });

  it('no-ops for a non-terminal task (never resurrects a running task card)', async () => {
    const fake = buildFakeStore();
    prismaMock.iMTask.findUnique.mockResolvedValue(terminalTaskRow({ status: 'running' }));
    mockLiveAssets(['a1', 'a2', 'a3']);

    const svc = await buildTaskService(fake);
    await svc.reemitTerminalDigestForAssetArrival('task_abc');

    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.update).not.toHaveBeenCalled();
    expect(prismaMock.iMAsset.count).not.toHaveBeenCalled();
  });

  it('no-ops when the task has no linked conversation', async () => {
    const fake = buildFakeStore();
    prismaMock.iMTask.findUnique.mockResolvedValue(terminalTaskRow({ conversationId: null }));
    mockLiveAssets(['a1', 'a2', 'a3']);

    const svc = await buildTaskService(fake);
    await svc.reemitTerminalDigestForAssetArrival('task_abc');

    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.update).not.toHaveBeenCalled();
  });

  it('no-ops when the task row does not exist', async () => {
    const fake = buildFakeStore();
    prismaMock.iMTask.findUnique.mockResolvedValue(null);

    const svc = await buildTaskService(fake);
    await svc.reemitTerminalDigestForAssetArrival('missing_task');

    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.update).not.toHaveBeenCalled();
  });

  it('repeated re-emit is idempotent (same payload, just re-writes the row)', async () => {
    const fake = buildFakeStore();
    prismaMock.iMTask.findUnique.mockResolvedValue(terminalTaskRow());
    mockLiveAssets(['a1', 'a2', 'a3']);

    const svc = await buildTaskService(fake);
    await svc.reemitTerminalDigestForAssetArrival('task_abc'); // INSERT (no seed)
    const after1 = (fake.store[0].metadataObj.taskDigest as any).resultAssetCount;
    await svc.reemitTerminalDigestForAssetArrival('task_abc'); // UPDATE
    const digestRows = fake.store.filter((r) => (r.metadataObj as any).digestKind === 'task_digest');
    expect(digestRows).toHaveLength(1); // still one message
    expect((digestRows[0].metadataObj.taskDigest as any).resultAssetCount).toBe(after1);
  });
});
