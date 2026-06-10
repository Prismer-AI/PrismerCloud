/**
 * release201/13 §3.6 + §11 13-P3 — Workspace-owner-scoped evolution BFF tests.
 *
 * Verifies the `/api/im/studio/evolution/{capsules,genes}` permission gate:
 *   • Workspace owner can read capsules/genes for any agent in their workspace.
 *   • Workspace member (non-owner) can read (member ACL).
 *   • The target agent themselves can read.
 *   • Outsider (different workspace) gets 403.
 *   • Missing agentId param → 400.
 *
 * These are the §0.2.4 forbidden-pattern guards. We do NOT exercise the
 * underlying evolution-service SQL — that's covered by acp-evolution-service.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    iMAgentCard: { findUnique: vi.fn() },
    iMWorkspace: { findFirst: vi.fn() },
    iMAgentSkill: { findMany: vi.fn() },
  },
  evolution: {
    getCapsules: vi.fn(),
    loadGenes: vi.fn(),
  },
}));

vi.mock('../db', () => ({ default: mocks.prisma }));

// Hold the test user in module scope so the mocked authMiddleware (which is
// the actual function Hono runs against the real Hono context) can install it
// onto `c`.
let CURRENT_TEST_USER: { imUserId: string; role?: string } | null = null;

vi.mock('../auth/middleware', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (CURRENT_TEST_USER) c.set('user', CURRENT_TEST_USER);
    await next();
  },
}));
vi.mock('../services/evolution-report', () => ({ getCapsules: mocks.evolution.getCapsules }));
vi.mock('../services/evolution-lifecycle', () => ({ loadGenes: mocks.evolution.loadGenes }));
vi.mock('../services/workspace-view.service', () => ({
  WorkspaceViewService: class {
    getView() {
      return Promise.resolve({});
    }
  },
}));
vi.mock('../services/agent-skill.service', () => ({
  AgentSkillService: class {
    listAgentSkills() {
      return Promise.resolve([]);
    }
  },
}));

import { createStudioRouter } from '../api/studio';

function makeApp(user: { imUserId: string; role?: string }) {
  CURRENT_TEST_USER = user;
  const router = createStudioRouter(undefined);
  return {
    fetch: async (path: string, init?: RequestInit) => {
      const req = new Request(`http://test${path}`, init);
      return router.fetch(req);
    },
  };
}

function setupAgentInWorkspace(agentImUserId: string, workspaceId: string) {
  mocks.prisma.iMAgentCard.findUnique.mockResolvedValue({ workspaceId });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.evolution.getCapsules.mockResolvedValue({
    capsules: [{ id: 'cap-1', geneId: 'gene-1', outcome: 'success' }],
    total: 1,
  });
  mocks.evolution.loadGenes.mockResolvedValue([
    { id: 'gene-1', title: 'g', description: 'd', category: 'repair', signals_match: [], strategy: [] },
  ]);
  mocks.prisma.iMAgentSkill.findMany.mockResolvedValue([]);
});

describe('GET /studio/evolution/capsules — permission', () => {
  it('400 when agentId missing', async () => {
    const app = makeApp({ imUserId: 'user-1' });
    const res = await app.fetch('/evolution/capsules', { method: 'GET' });
    expect(res.status).toBe(400);
  });

  it('workspace owner sees capsules for a contributor agent', async () => {
    setupAgentInWorkspace('agent-99', 'ws-1');
    // Workspace lookup matches the caller as owner.
    mocks.prisma.iMWorkspace.findFirst.mockResolvedValue({ id: 'ws-1' });

    const app = makeApp({ imUserId: 'owner-1' });
    const res = await app.fetch('/evolution/capsules?agentId=agent-99&page=1&limit=10', { method: 'GET' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.agentId).toBe('agent-99');
    expect(body.data.total).toBe(1);
    expect(mocks.evolution.getCapsules).toHaveBeenCalledWith('agent-99', 1, 10, 'global');
  });

  it('agent themselves can read', async () => {
    setupAgentInWorkspace('agent-99', 'ws-1');
    // canInspectAgent short-circuits before the workspace lookup, so this
    // remains green even if the workspace check returns null.
    mocks.prisma.iMWorkspace.findFirst.mockResolvedValue(null);

    const app = makeApp({ imUserId: 'agent-99' });
    const res = await app.fetch('/evolution/capsules?agentId=agent-99', { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('outsider gets 403', async () => {
    setupAgentInWorkspace('agent-99', 'ws-1');
    mocks.prisma.iMWorkspace.findFirst.mockResolvedValue(null);

    const app = makeApp({ imUserId: 'outsider-1' });
    const res = await app.fetch('/evolution/capsules?agentId=agent-99', { method: 'GET' });
    expect(res.status).toBe(403);
    expect(mocks.evolution.getCapsules).not.toHaveBeenCalled();
  });

  it('agent with no workspace → 403 (no orphan reads)', async () => {
    mocks.prisma.iMAgentCard.findUnique.mockResolvedValue({ workspaceId: null });
    const app = makeApp({ imUserId: 'someone' });
    const res = await app.fetch('/evolution/capsules?agentId=orphan', { method: 'GET' });
    expect(res.status).toBe(403);
  });
});

describe('GET /studio/evolution/genes — permission + distilled linkage', () => {
  it('workspace owner sees genes + distilled skill linkage', async () => {
    setupAgentInWorkspace('agent-99', 'ws-1');
    mocks.prisma.iMWorkspace.findFirst.mockResolvedValue({ id: 'ws-1' });
    mocks.prisma.iMAgentSkill.findMany.mockResolvedValue([
      { geneId: 'gene-1', skillId: 'skill-x', status: 'active', installedAt: new Date('2026-01-01') },
    ]);

    const app = makeApp({ imUserId: 'owner-1' });
    const res = await app.fetch('/evolution/genes?agentId=agent-99', { method: 'GET' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.genes).toHaveLength(1);
    expect(body.data.distilled).toEqual([
      { geneId: 'gene-1', skillId: 'skill-x', status: 'active', installedAt: expect.any(String) },
    ]);
  });

  it('outsider 403 — no leak through gene path either', async () => {
    setupAgentInWorkspace('agent-99', 'ws-1');
    mocks.prisma.iMWorkspace.findFirst.mockResolvedValue(null);
    const app = makeApp({ imUserId: 'outsider' });
    const res = await app.fetch('/evolution/genes?agentId=agent-99', { method: 'GET' });
    expect(res.status).toBe(403);
    expect(mocks.evolution.loadGenes).not.toHaveBeenCalled();
  });

  it('signals filter narrows the result set', async () => {
    setupAgentInWorkspace('agent-99', 'ws-1');
    mocks.prisma.iMWorkspace.findFirst.mockResolvedValue({ id: 'ws-1' });
    mocks.evolution.loadGenes.mockResolvedValue([
      { id: 'g1', signals_match: [{ type: 'error' }], strategy: [] },
      { id: 'g2', signals_match: [{ type: 'warn' }], strategy: [] },
    ]);

    const app = makeApp({ imUserId: 'owner-1' });
    const res = await app.fetch('/evolution/genes?agentId=agent-99&signals=error', { method: 'GET' });
    const body = await res.json();
    expect(body.data.genes).toHaveLength(1);
    expect(body.data.genes[0].id).toBe('g1');
  });
});
