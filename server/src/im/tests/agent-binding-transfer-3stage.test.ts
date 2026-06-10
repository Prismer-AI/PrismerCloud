/**
 * agent-transfer-3stage.test.ts — release201/09 §9.7 Phase 3 + S31 A.
 *
 * Covers the 3-stage transfer protocol endpoints:
 *   POST /api/im/agent-transfer/initiate
 *   POST /api/im/agent-transfer/:transferId/complete
 *   POST /api/im/agent-transfer/:transferId/abort
 *
 * Validates:
 *   - state machine transitions (idle → initiated → completed | aborted → idle)
 *   - idempotent initiate when (agentId, toDaemonId) already in flight
 *   - 409 when initiate proposes a different toDaemonId mid-transfer
 *   - 410 when complete/abort called against idle state
 *   - 403 when actor is not workspace owner / orchestrator / admin / agent owner
 *   - sync event emission for each state transition
 *
 * Mocks prisma + sync service so test does not require MySQL or Redis.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createAgentTransferRouter } from '../api/agent-transfer';

// ────────────────────────── Mock state + helpers ──────────────────────────

type Binding = {
  agentImUserId: string;
  boundDaemonId: string;
  boundDaemonKind: string;
  boundDaemonLabel: string;
  boundBy: string;
  boundAt: Date;
  lastHostDeclareAt: Date;
  contestedSince: Date | null;
  contestCount: number;
  pausedAt: Date | null;
  transferState: string | null;
  transferToDaemonId: string | null;
  transferInitiatedAt: Date | null;
};

type Card = { imUserId: string; workspaceId: string; ownerImUserId: string };
type Workspace = {
  id: string;
  ownerImUserId: string;
  orchestratorAgentId: string | null;
  orchestratorRevokedAt: Date | null;
  deletedAt: Date | null;
};
type Container = {
  daemonId: string;
  workspaceId: string;
  deviceType: 'k8s' | 'local' | 'edge';
  podName: string | null;
  status: string;
  stoppedAt: Date | null;
};

const state: {
  bindings: Binding[];
  cards: Card[];
  workspaces: Workspace[];
  containers: Container[];
} = { bindings: [], cards: [], workspaces: [], containers: [] };

function resetState() {
  state.bindings = [
    {
      agentImUserId: 'agent_alice',
      boundDaemonId: 'daemon-src',
      boundDaemonKind: 'local',
      boundDaemonLabel: 'src host',
      boundBy: 'auto-first-declare',
      boundAt: new Date('2026-05-20T00:00:00.000Z'),
      lastHostDeclareAt: new Date('2026-05-20T00:00:00.000Z'),
      contestedSince: null,
      contestCount: 0,
      pausedAt: null,
      transferState: 'idle',
      transferToDaemonId: null,
      transferInitiatedAt: null,
    },
  ];
  state.cards = [{ imUserId: 'agent_alice', workspaceId: 'ws_demo', ownerImUserId: 'user_owner' }];
  state.workspaces = [
    {
      id: 'ws_demo',
      ownerImUserId: 'user_owner',
      orchestratorAgentId: null,
      orchestratorRevokedAt: null,
      deletedAt: null,
    },
  ];
  state.containers = [
    {
      daemonId: 'daemon-src',
      workspaceId: 'ws_demo',
      deviceType: 'local',
      podName: 'src-host',
      status: 'running',
      stoppedAt: null,
    },
    {
      daemonId: 'daemon-tgt',
      workspaceId: 'ws_demo',
      deviceType: 'local',
      podName: 'tgt-host',
      status: 'running',
      stoppedAt: null,
    },
  ];
}

// `prismaMock` is hoisted alongside `vi.mock` so the factory below resolves
// the same object when the SUT executes its `import prisma from '../db'`.
const prismaMock = vi.hoisted(() => {
  const inner = {
    iMAgentBinding: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    iMAgentCard: { findFirst: vi.fn() },
    iMWorkspace: { findFirst: vi.fn() },
    iMContainer: { findFirst: vi.fn() },
  };
  return inner;
});

// Mock src/im/db's default export. Hoisted with vi.hoisted to dodge the
// initialization-order trap (see Vitest docs `vi.mock` § hoisting).
vi.mock('../db', () => ({ default: prismaMock }));

// Mock authMiddleware so request context surfaces `user`.
vi.mock('../auth/middleware', () => ({
  authMiddleware: async (
    c: { set: (key: string, value: unknown) => void; req: { header: (k: string) => string | undefined } },
    next: () => Promise<void>,
  ) => {
    const header = c.req.header('x-test-actor') ?? 'user_owner';
    c.set('user', { imUserId: header, role: header === 'admin' ? 'admin' : 'user' });
    await next();
  },
}));

// Wire concrete implementations now that `state` exists (this runs in test
// setup order, not in module hoisting).
function wirePrismaMockImplementations() {
  prismaMock.iMAgentBinding.findUnique.mockImplementation(async ({ where }: { where: { agentImUserId: string } }) => {
    const row = state.bindings.find((b) => b.agentImUserId === where.agentImUserId);
    return row ? { ...row } : null;
  });
  prismaMock.iMAgentBinding.update.mockImplementation(
    async ({ where, data }: { where: { agentImUserId: string }; data: Record<string, unknown> }) => {
      const row = state.bindings.find((b) => b.agentImUserId === where.agentImUserId);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return { ...row };
    },
  );
  prismaMock.iMAgentCard.findFirst.mockImplementation(async ({ where }: { where: { imUserId: string } }) => {
    const c = state.cards.find((x) => x.imUserId === where.imUserId);
    return c ?? null;
  });
  prismaMock.iMWorkspace.findFirst.mockImplementation(async ({ where }: { where: { id: string; deletedAt: null } }) => {
    const w = state.workspaces.find((x) => x.id === where.id && x.deletedAt === null);
    return w ?? null;
  });
  prismaMock.iMContainer.findFirst.mockImplementation(
    async ({ where }: { where: { workspaceId: string; daemonId: string } }) => {
      const c = state.containers.find((x) => x.workspaceId === where.workspaceId && x.daemonId === where.daemonId);
      return c ?? null;
    },
  );
}

// ────────────────────────── Suite ──────────────────────────

interface MockSyncService {
  writeEvent: ReturnType<typeof vi.fn>;
}

function buildApp() {
  const sync: MockSyncService = { writeEvent: vi.fn(async () => undefined) };
  const app = new Hono();
  app.route(
    '/agent-transfer',
    createAgentTransferRouter({
      syncService: sync as unknown as Parameters<typeof createAgentTransferRouter>[0]['syncService'],
    }),
  );
  return { app, sync };
}

async function jsonPost(app: Hono, path: string, body: unknown, actor = 'user_owner') {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-actor': actor },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data as Record<string, unknown> };
}

describe('agent-transfer 3-stage protocol', () => {
  beforeEach(() => {
    resetState();
    wirePrismaMockImplementations();
    prismaMock.iMAgentBinding.findUnique.mockClear();
    prismaMock.iMAgentBinding.update.mockClear();
    prismaMock.iMAgentCard.findFirst.mockClear();
    prismaMock.iMWorkspace.findFirst.mockClear();
    prismaMock.iMContainer.findFirst.mockClear();
  });

  it('initiate flips state to initiated and quiesces the agent', async () => {
    const { app, sync } = buildApp();
    const { status, body } = await jsonPost(app, '/agent-transfer/initiate', {
      agentId: 'agent_alice',
      fromDaemonId: 'daemon-src',
      toDaemonId: 'daemon-tgt',
    });
    expect(status).toBe(201);
    expect(body.ok).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(data.status).toBe('initiated');
    expect(typeof data.transferId).toBe('string');

    const row = state.bindings[0]!;
    expect(row.transferState).toBe('initiated');
    expect(row.transferToDaemonId).toBe('daemon-tgt');
    expect(row.transferInitiatedAt).toBeInstanceOf(Date);
    expect(row.pausedAt).toBeInstanceOf(Date);
    // boundDaemonId is NOT yet flipped — flip happens on complete.
    expect(row.boundDaemonId).toBe('daemon-src');
    expect(sync.writeEvent).toHaveBeenCalledWith(
      'agent.transfer.initiated',
      expect.objectContaining({ agentImUserId: 'agent_alice', toDaemonId: 'daemon-tgt' }),
      null,
      'user_owner',
    );
  });

  it('initiate is idempotent on (agentId, toDaemonId)', async () => {
    const { app } = buildApp();
    const first = await jsonPost(app, '/agent-transfer/initiate', {
      agentId: 'agent_alice',
      fromDaemonId: 'daemon-src',
      toDaemonId: 'daemon-tgt',
    });
    const second = await jsonPost(app, '/agent-transfer/initiate', {
      agentId: 'agent_alice',
      fromDaemonId: 'daemon-src',
      toDaemonId: 'daemon-tgt',
    });
    expect(second.status).toBe(200);
    const secondData = second.body.data as Record<string, unknown>;
    const firstData = first.body.data as Record<string, unknown>;
    expect(secondData.idempotent).toBe(true);
    expect(secondData.transferId).toBe(firstData.transferId);
  });

  it('initiate rejects a different toDaemonId mid-flight (409)', async () => {
    const { app } = buildApp();
    await jsonPost(app, '/agent-transfer/initiate', {
      agentId: 'agent_alice',
      fromDaemonId: 'daemon-src',
      toDaemonId: 'daemon-tgt',
    });
    // Add a third daemon row so target lookup passes the registered check.
    state.containers.push({
      daemonId: 'daemon-other',
      workspaceId: 'ws_demo',
      deviceType: 'local',
      podName: 'other',
      status: 'running',
      stoppedAt: null,
    });
    const second = await jsonPost(app, '/agent-transfer/initiate', {
      agentId: 'agent_alice',
      fromDaemonId: 'daemon-src',
      toDaemonId: 'daemon-other',
    });
    expect(second.status).toBe(409);
  });

  it('initiate refuses fromDaemonId that does not match current owner', async () => {
    const { app } = buildApp();
    const { status, body } = await jsonPost(app, '/agent-transfer/initiate', {
      agentId: 'agent_alice',
      fromDaemonId: 'daemon-impostor',
      toDaemonId: 'daemon-tgt',
    });
    expect(status).toBe(409);
    expect(body.error).toContain('fromDaemonId mismatch');
  });

  it('initiate refuses identical from/to (400)', async () => {
    const { app } = buildApp();
    const { status } = await jsonPost(app, '/agent-transfer/initiate', {
      agentId: 'agent_alice',
      fromDaemonId: 'daemon-src',
      toDaemonId: 'daemon-src',
    });
    expect(status).toBe(400);
  });

  it('initiate is forbidden for non-owner / non-admin actors', async () => {
    const { app } = buildApp();
    const { status } = await jsonPost(
      app,
      '/agent-transfer/initiate',
      {
        agentId: 'agent_alice',
        fromDaemonId: 'daemon-src',
        toDaemonId: 'daemon-tgt',
      },
      'user_stranger',
    );
    expect(status).toBe(403);
  });

  it('complete flips boundDaemonId, clears transfer state, resumes dispatch', async () => {
    const { app, sync } = buildApp();
    const init = await jsonPost(app, '/agent-transfer/initiate', {
      agentId: 'agent_alice',
      fromDaemonId: 'daemon-src',
      toDaemonId: 'daemon-tgt',
    });
    const transferId = (init.body.data as Record<string, string>).transferId;
    const { status, body } = await jsonPost(app, `/agent-transfer/${encodeURIComponent(transferId)}/complete`, {
      tarballHash: 'a'.repeat(64),
    });
    expect(status).toBe(200);
    const data = body.data as Record<string, unknown>;
    expect(data.status).toBe('completed');
    expect(data.previousDaemonId).toBe('daemon-src');
    expect(data.newDaemonId).toBe('daemon-tgt');

    const row = state.bindings[0]!;
    expect(row.boundDaemonId).toBe('daemon-tgt');
    expect(row.boundBy).toBe('transfer');
    expect(row.pausedAt).toBeNull();
    expect(row.transferState).toBe('idle');
    expect(row.transferToDaemonId).toBeNull();
    expect(row.transferInitiatedAt).toBeNull();

    expect(sync.writeEvent).toHaveBeenCalledWith(
      'agent.transfer.completed',
      expect.objectContaining({
        agentImUserId: 'agent_alice',
        previousDaemonId: 'daemon-src',
        newDaemonId: 'daemon-tgt',
        tarballHash: 'a'.repeat(64),
      }),
      null,
      'user_owner',
    );
  });

  it('complete rejects missing tarballHash (400)', async () => {
    const { app } = buildApp();
    const init = await jsonPost(app, '/agent-transfer/initiate', {
      agentId: 'agent_alice',
      fromDaemonId: 'daemon-src',
      toDaemonId: 'daemon-tgt',
    });
    const transferId = (init.body.data as Record<string, string>).transferId;
    const { status } = await jsonPost(app, `/agent-transfer/${encodeURIComponent(transferId)}/complete`, {});
    expect(status).toBe(400);
  });

  it('complete on idle state returns 410 transfer_not_active', async () => {
    const { app } = buildApp();
    // No initiate — straight to complete.
    const transferId = `agent_alice.${Date.now()}`;
    const { status, body } = await jsonPost(app, `/agent-transfer/${encodeURIComponent(transferId)}/complete`, {
      tarballHash: 'a'.repeat(64),
    });
    expect(status).toBe(410);
    expect(body.error).toBe('transfer_not_active');
  });

  it('abort clears transfer state, resumes dispatch on source, boundDaemonId unchanged', async () => {
    const { app, sync } = buildApp();
    const init = await jsonPost(app, '/agent-transfer/initiate', {
      agentId: 'agent_alice',
      fromDaemonId: 'daemon-src',
      toDaemonId: 'daemon-tgt',
    });
    const transferId = (init.body.data as Record<string, string>).transferId;
    const { status, body } = await jsonPost(app, `/agent-transfer/${encodeURIComponent(transferId)}/abort`, {
      reason: 'target_disk_full',
    });
    expect(status).toBe(200);
    const data = body.data as Record<string, unknown>;
    expect(data.status).toBe('aborted');
    expect(data.reason).toBe('target_disk_full');

    const row = state.bindings[0]!;
    expect(row.boundDaemonId).toBe('daemon-src'); // unchanged
    expect(row.transferState).toBe('idle');
    expect(row.transferToDaemonId).toBeNull();
    expect(row.transferInitiatedAt).toBeNull();
    expect(row.pausedAt).toBeNull();

    expect(sync.writeEvent).toHaveBeenCalledWith(
      'agent.transfer.aborted',
      expect.objectContaining({
        agentImUserId: 'agent_alice',
        fromDaemonId: 'daemon-src',
        reason: 'target_disk_full',
      }),
      null,
      'user_owner',
    );
  });

  it('abort on idle state returns 410 transfer_not_active', async () => {
    const { app } = buildApp();
    const transferId = `agent_alice.${Date.now()}`;
    const { status, body } = await jsonPost(app, `/agent-transfer/${encodeURIComponent(transferId)}/abort`, {
      reason: 'nope',
    });
    expect(status).toBe(410);
    expect(body.error).toBe('transfer_not_active');
  });

  it('admin actor can drive the transfer end-to-end', async () => {
    const { app } = buildApp();
    const init = await jsonPost(
      app,
      '/agent-transfer/initiate',
      {
        agentId: 'agent_alice',
        fromDaemonId: 'daemon-src',
        toDaemonId: 'daemon-tgt',
      },
      'admin',
    );
    expect(init.status).toBe(201);
    const transferId = (init.body.data as Record<string, string>).transferId;
    const complete = await jsonPost(
      app,
      `/agent-transfer/${encodeURIComponent(transferId)}/complete`,
      { tarballHash: 'b'.repeat(64) },
      'admin',
    );
    expect(complete.status).toBe(200);
  });

  it('invalid transferId returns 400', async () => {
    const { app } = buildApp();
    const { status } = await jsonPost(app, `/agent-transfer/${encodeURIComponent('not-an-id')}/complete`, {
      tarballHash: 'a'.repeat(64),
    });
    expect(status).toBe(400);
  });
});
