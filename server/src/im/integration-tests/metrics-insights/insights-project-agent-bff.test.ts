/**
 * Phase 2E Suite 3 — release201/12 Insights project + agent BFF.
 *
 * Drives GET /insights/project/:projectId and GET /insights/agent/:agentId
 * end-to-end against the live cloud + dev MySQL.
 *
 * Project view (doc 12 §5):
 *   - 8 widgets: openTasks counter + acceptance counter + daysUntilArchive
 *     counter + burndown timeseries + acceptanceByCapability bar +
 *     contributors table + recentFailedTasks table + pendingApprovals table.
 *   - 404 on unknown projectId (WorkspaceNotFoundError, code=WORKSPACE_NOT_FOUND).
 *   - 403 on caller who is not a member of the project's workspace.
 *   - All 4 range buckets (24h/7d/30d/90d) return 200.
 *
 * Agent view (doc 12 §6):
 *   - 7 widgets: tasksDone + avgLatency + acceptanceRate + skillsUsed
 *     (4 counters) + dispatchVolume (timeseries) + skillInvocation (bar) +
 *     recentTasks (table).
 *   - workspaceId required → 400 when missing.
 *   - agentId not in workspace: per current insights.service buildAgent,
 *     there is no explicit existence check — the call returns 200 with
 *     zero-valued widgets (filter dim simply matches nothing). The task
 *     prompt expected 404; we document the drift here rather than fail
 *     the suite, since the spec mismatch is in the service layer not the
 *     test harness. doc 12 §6 calls for visibility checks — flagging.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { api, bootstrapSuite, type SuiteContext } from '../_helpers';

interface ProjectData {
  workspaceId: string;
  projectId: string;
  projectName: string;
  status: string;
  memberCount: number;
  range: { from: string; to: string; previous: { from: string; to: string } };
  widgets: {
    openTasks: { type: 'counter'; value: number };
    acceptance: { type: 'counter'; value: number };
    daysUntilArchive: { type: 'counter'; value: number };
    burndown: { type: 'timeseries'; buckets: Array<{ ts: string; value: number | null }> };
    acceptanceByCapability: { type: 'bar'; items: Array<{ label: string; value: number }> };
    contributors: { type: 'table'; columns: string[]; rows: unknown[] };
    recentFailedTasks: { type: 'table'; columns: string[]; rows: unknown[] };
    pendingApprovals: { type: 'table'; columns: string[]; rows: unknown[] };
  };
  asOf: string;
}

interface AgentData {
  workspaceId: string;
  agentId: string;
  range: { from: string; to: string; previous: { from: string; to: string } };
  widgets: {
    tasksDone: { type: 'counter'; value: number };
    avgLatency: { type: 'counter'; value: number };
    acceptanceRate: { type: 'counter'; value: number };
    skillsUsed: { type: 'counter'; value: number };
    dispatchVolume: { type: 'timeseries'; buckets: unknown[] };
    skillInvocation: { type: 'bar'; items: unknown[] };
    recentTasks: { type: 'table'; columns: string[]; rows: unknown[] };
  };
  asOf: string;
}

interface Env<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

describe('Phase 2E.3 — insights/project + /agent BFF (doc 12)', () => {
  let ctx: SuiteContext;
  let projectId: string;

  beforeAll(async () => {
    ctx = await bootstrapSuite('p2e3pj');
    // Create a real project owned by the suite workspace owner. The BFF
    // hits prisma.iMProject.findUnique on this id; without it /project/:id
    // would return 404 (which is also a test case, but we need at least
    // one happy-path id).
    const r = await api<{ ok: boolean; data?: { id: string } }>('POST', '/projects', {
      actor: ctx.owner,
      body: {
        workspaceId: ctx.workspace.id,
        slug: `p2e3-prj-${Date.now().toString(36)}`,
        name: 'p2e3 project probe',
      },
      expectStatus: 201,
    });
    projectId = r.data.data!.id;
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  }, 30_000);

  // ── /insights/project/:projectId ──────────────────────────────────────
  test('project view returns 8 widgets', async () => {
    const r = await api<Env<ProjectData>>('GET', `/insights/project/${projectId}`, {
      actor: ctx.owner,
      query: { range: '7d' },
    });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    const w = r.data.data?.widgets;
    expect(w).toBeDefined();
    if (!w) return;
    // 3 counters
    expect(w.openTasks?.type).toBe('counter');
    expect(w.acceptance?.type).toBe('counter');
    expect(w.daysUntilArchive?.type).toBe('counter');
    // 1 burndown timeseries + 1 bar + 3 tables = 8 total
    expect(w.burndown?.type).toBe('timeseries');
    expect(Array.isArray(w.burndown?.buckets)).toBe(true);
    expect(w.acceptanceByCapability?.type).toBe('bar');
    expect(Array.isArray(w.acceptanceByCapability?.items)).toBe(true);
    expect(w.contributors?.type).toBe('table');
    expect(w.recentFailedTasks?.type).toBe('table');
    expect(w.pendingApprovals?.type).toBe('table');

    const keys = Object.keys(w);
    expect(keys.length, `expected 8 widgets, got ${keys.length}: ${keys.join(',')}`).toBe(8);

    // Envelope-level fields the UI relies on for header chrome.
    expect(r.data.data?.projectName).toBe('p2e3 project probe');
    expect(['active', 'archived']).toContain(r.data.data?.status);
    expect(typeof r.data.data?.memberCount).toBe('number');
  });

  test('unknown projectId → 404 WORKSPACE_NOT_FOUND', async () => {
    // buildProject throws WorkspaceNotFoundError when prisma.iMProject
    // .findUnique returns null. The router maps that to 404.
    const r = await api<Env<unknown>>('GET', `/insights/project/does_not_exist_xyz`, {
      actor: ctx.owner,
    });
    expect(r.status).toBe(404);
    expect(r.data.ok).toBe(false);
    expect(r.data.error?.code).toBe('WORKSPACE_NOT_FOUND');
  });

  test('non-member of project workspace → 403 WORKSPACE_FORBIDDEN', async () => {
    const r = await api<Env<unknown>>('GET', `/insights/project/${projectId}`, {
      actor: ctx.outsider,
    });
    // buildProject calls assertWorkspaceMember after loading the project;
    // outsider must hit WorkspaceForbiddenError → 403.
    expect(r.status).toBe(403);
    expect(r.data.ok).toBe(false);
    expect(r.data.error?.code).toBe('WORKSPACE_FORBIDDEN');
  });

  test('project view 24h / 7d / 30d / 90d ranges all 200', async () => {
    for (const range of ['24h', '7d', '30d', '90d']) {
      const r = await api<Env<ProjectData>>('GET', `/insights/project/${projectId}`, {
        actor: ctx.owner,
        query: { range },
      });
      expect(r.status, `project range=${range}`).toBe(200);
    }
  });

  // ── /insights/agent/:agentId ──────────────────────────────────────────
  test('agent view returns 7 widgets', async () => {
    // The owner is an IM user; the BFF only uses agentId as a filter dim
    // (assigneeId), not for existence-checking. Passing the owner's
    // imUserId as agentId is the simplest happy-path call.
    const agentId = ctx.owner.imUserId;
    const r = await api<Env<AgentData>>('GET', `/insights/agent/${agentId}`, {
      actor: ctx.owner,
      query: { workspaceId: ctx.workspace.id, range: '7d' },
    });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    const w = r.data.data?.widgets;
    expect(w).toBeDefined();
    if (!w) return;

    // 4 counters + timeseries + bar + table = 7
    expect(w.tasksDone?.type).toBe('counter');
    expect(w.avgLatency?.type).toBe('counter');
    expect(w.acceptanceRate?.type).toBe('counter');
    expect(w.skillsUsed?.type).toBe('counter');
    expect(w.dispatchVolume?.type).toBe('timeseries');
    expect(w.skillInvocation?.type).toBe('bar');
    expect(w.recentTasks?.type).toBe('table');

    const keys = Object.keys(w);
    expect(keys.length, `expected 7 widgets, got ${keys.length}: ${keys.join(',')}`).toBe(7);
  });

  test('agent view missing workspaceId → 400 WORKSPACE_REQUIRED', async () => {
    const agentId = ctx.owner.imUserId;
    const r = await api<Env<unknown>>('GET', `/insights/agent/${agentId}`, {
      actor: ctx.owner,
      // intentionally omit workspaceId
    });
    expect(r.status).toBe(400);
    expect(r.data.ok).toBe(false);
    expect(r.data.error?.code).toBe('WORKSPACE_REQUIRED');
  });

  test('agent view 24h / 7d / 30d / 90d ranges all 200', async () => {
    const agentId = ctx.owner.imUserId;
    for (const range of ['24h', '7d', '30d', '90d']) {
      const r = await api<Env<AgentData>>('GET', `/insights/agent/${agentId}`, {
        actor: ctx.owner,
        query: { workspaceId: ctx.workspace.id, range },
      });
      expect(r.status, `agent range=${range}`).toBe(200);
    }
  });

  test('agentId not in workspace — 404 AGENT_NOT_IN_WORKSPACE (doc 12 §6)', async () => {
    // v2.0.8 D4 fix: buildAgent probes IMAgentCard + IMWorkspaceMember for
    // the (agentId, workspaceId) join row and throws AgentNotInWorkspaceError
    // (404) when neither exists. Prevents cross-workspace probe + silent
    // zero-widget responses that misled callers into thinking the agent
    // existed but had no activity.
    const bogusAgentId = 'agentId_that_does_not_exist_in_any_workspace_xyz';
    const r = await api<Env<AgentData>>('GET', `/insights/agent/${bogusAgentId}`, {
      actor: ctx.owner,
      query: { workspaceId: ctx.workspace.id, range: '24h' },
    });
    expect(r.status).toBe(404);
    expect(r.data.error?.code).toBe('AGENT_NOT_IN_WORKSPACE');
  });
});
