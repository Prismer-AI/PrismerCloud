/**
 * Phase 2G integration — Cross-workspace isolation.
 *
 * Drives 2 independent bootstrap suites (ws1 + ws2) and proves that
 * ws1.owner cannot reach into ws2's surfaces via:
 *   - GET    /workspaces/<ws2.id>                    → 403/404
 *   - POST   /projects { workspaceId: ws2.id }       → 403/404
 *   - POST   /tasks    { workspaceId: ws2.id }       → 403/404 or task rejected
 *   - GET    /insights/overview?workspaceId=ws2.id   → 403
 *   - GET    /skills?workspaceId=ws2.id              → ws1 skills only (not 200 w/ ws2 content)
 *
 * Metrics isolation (doc 12 §0.2.4) — left as a TODO smoke; emitting a
 * synthetic metric requires test-only access to metric.service which
 * isn't exposed via HTTP. We assert the insights aggregate path filters
 * by workspaceId by hitting `/insights/overview?workspaceId=ws2.id` from
 * ws1.owner and expecting 403.
 *
 * Note on skill lifecycle promote: the lifecycle service does not expose
 * "list skills belonging to ws2" via HTTP, so we mark that as conditional —
 * we only assert the cross-workspace promote if a probe skill is reachable.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapSuite, api, type SuiteContext } from '../_helpers';

interface ApiEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: unknown;
}

function expectStatus(label: string, action: string, got: number, ...allowed: number[]): void {
  if (!allowed.includes(got)) {
    console.error(`[drift] ${label} ${action} expected one of [${allowed.join(',')}], got ${got}`);
  }
  expect(allowed).toContain(got);
}

describe('cross-workspace-isolation — phase 2G', () => {
  let ws1: SuiteContext;
  let ws2: SuiteContext;

  beforeAll(async () => {
    ws1 = await bootstrapSuite('p2gws1');
    ws2 = await bootstrapSuite('p2gws2');
  }, 90_000);

  afterAll(async () => {
    await ws1.cleanup();
    await ws2.cleanup();
  });

  test('ws1.owner GET /workspaces/<ws2.id> → 403/404', async () => {
    const r = await api('GET', `/workspaces/${ws2.workspace.id}`, { actor: ws1.owner });
    expectStatus('ws1.owner', 'GET ws2', r.status, 403, 404);
  });

  test('ws1.owner GET /workspaces/<ws2.id>/members → 403/404', async () => {
    const r = await api('GET', `/workspaces/${ws2.workspace.id}/members`, { actor: ws1.owner });
    expectStatus('ws1.owner', 'GET ws2 members', r.status, 403, 404);
  });

  test('ws1.owner POST /projects { workspaceId: ws2.id } → 403/404', async () => {
    const r = await api('POST', '/projects', {
      actor: ws1.owner,
      body: {
        workspaceId: ws2.workspace.id,
        slug: `crossp-${Math.random().toString(36).slice(2, 8)}`,
        name: 'ws1 owner cross probe',
      },
    });
    expectStatus('ws1.owner', 'POST cross-ws project', r.status, 403, 404);
  });

  test('ws1.owner POST /tasks { workspaceId: ws2.id } → 403 NOT_WORKSPACE_MEMBER', async () => {
    // release201/19 B1 hotfix (v2.0.7.1): task.service.createTask now gates
    // on iMWorkspaceMember.findUnique before any side-effect. ws1.owner has
    // no membership row in ws2 → TaskAccessError → API surfaces 403
    // TASK_ACCESS_DENIED. Strict assertion replaces the drift pin.
    const r = await api<ApiEnvelope<{ id: string; workspaceId?: string }>>('POST', '/tasks', {
      actor: ws1.owner,
      body: {
        title: 'cross-workspace task probe',
        workspaceId: ws2.workspace.id,
      },
    });
    expect(r.status, `expected 403, got ${r.status}; body=${JSON.stringify(r.data)}`).toBe(403);
    expect(r.data?.ok).toBe(false);
    const errCode = (r.data?.error as { code?: string } | undefined)?.code;
    expect(errCode).toBe('TASK_ACCESS_DENIED');
  });

  test('ws1.owner GET /insights/overview?workspaceId=<ws2.id> → 403', async () => {
    const r = await api('GET', '/insights/overview', {
      actor: ws1.owner,
      query: { workspaceId: ws2.workspace.id },
    });
    expectStatus('ws1.owner', 'GET cross-ws insights overview', r.status, 403, 404);
  });

  test('ws1.owner GET /skills?workspaceId=<ws2.id> — must not leak ws2 skills', async () => {
    const r = await api<ApiEnvelope<unknown[] | { skills: unknown[] }>>('GET', '/skills', {
      actor: ws1.owner,
      query: { workspaceId: ws2.workspace.id },
    });

    // Two acceptable outcomes:
    //   (a) 403 / 404 — endpoint refuses cross-ws workspaceId
    //   (b) 200 — but the response must NOT contain skills belonging to ws2.
    //       In practice, the skills router does not currently take a
    //       workspaceId scope (skills.ts:50 — search is workspace-agnostic),
    //       so a 200 here mostly returns global / built-in skills. We assert
    //       that no skill in the response carries ws2.workspaceId.
    if (r.status === 200) {
      const payload = r.data?.data;
      const items: Array<{ workspaceId?: string }> = Array.isArray(payload)
        ? (payload as Array<{ workspaceId?: string }>)
        : Array.isArray((payload as { skills?: unknown[] })?.skills)
          ? (payload as { skills: Array<{ workspaceId?: string }> }).skills
          : [];
      const ws2Leak = items.filter((s) => s.workspaceId === ws2.workspace.id);
      if (ws2Leak.length > 0) {
        console.error(`[drift] /skills?workspaceId=ws2 leaked ${ws2Leak.length} ws2-scoped skills to ws1.owner`);
        expect.fail(`skills leak: ${ws2Leak.length} entries`);
      }
    } else {
      expectStatus('ws1.owner', 'GET cross-ws skills', r.status, 403, 404);
    }
  });

  test('ws1.owner GET /projects?workspaceId=<ws2.id> — must not enumerate ws2 projects', async () => {
    // Create one project in ws2 so there's something to leak.
    const pRes = await api<ApiEnvelope<{ id: string }>>('POST', '/projects', {
      actor: ws2.owner,
      body: {
        workspaceId: ws2.workspace.id,
        slug: `p2gisol-${Math.random().toString(36).slice(2, 8)}`,
        name: 'ws2 private project',
      },
      expectStatus: 201,
    });
    const ws2ProjId = pRes.data.data!.id;

    const r = await api<ApiEnvelope<{ items: Array<{ id: string }>; total: number }>>('GET', '/projects', {
      actor: ws1.owner,
      query: { workspaceId: ws2.workspace.id },
    });
    // Implementation in project.service.ts list:
    //   - non-owner: only projects with explicit membership; otherwise empty.
    //   - ws1.owner has NO membership in ws2; so total should be 0.
    // Accept either 200-with-empty or 403/404.
    if (r.status === 200) {
      const items = r.data?.data?.items ?? [];
      const total = r.data?.data?.total ?? 0;
      if (items.some((p) => p.id === ws2ProjId) || total > 0) {
        console.error(`[drift] /projects?workspaceId=ws2 leaked ws2 project ${ws2ProjId} to ws1.owner`);
        expect.fail('ws2 project leaked to ws1.owner');
      }
      expect(items.length).toBe(0);
    } else {
      expectStatus('ws1.owner', 'GET cross-ws projects', r.status, 403, 404);
    }
  });

  test('ws1.owner GET /tasks?workspaceId=<ws2.id> — must return zero ws2 tasks', async () => {
    // Create one ws2 task as ws2.owner so leak detection is meaningful.
    const created = await api<ApiEnvelope<{ id: string }>>('POST', '/tasks', {
      actor: ws2.owner,
      body: { title: 'ws2 private task probe', workspaceId: ws2.workspace.id },
    });
    // POST /tasks may or may not return 201 depending on credit / escrow
    // gating; in dev the call returns 201 cleanly. If it fails we still
    // exercise the leak check on the (possibly empty) list.
    expect([200, 201, 402, 403, 500]).toContain(created.status);

    const r = await api<ApiEnvelope<{ items?: unknown[]; tasks?: unknown[] }>>('GET', '/tasks', {
      actor: ws1.owner,
      query: { workspaceId: ws2.workspace.id },
    });
    if (r.status === 200) {
      const payload = r.data?.data;
      const items = Array.isArray(payload)
        ? (payload as unknown[])
        : Array.isArray((payload as { tasks?: unknown[] })?.tasks)
          ? (payload as { tasks: unknown[] }).tasks
          : Array.isArray((payload as { items?: unknown[] })?.items)
            ? (payload as { items: unknown[] }).items
            : [];
      // The task listing endpoint should filter by visibility to the caller.
      // ws1.owner has zero visibility into ws2 tasks → expect 0.
      if (items.length > 0) {
        console.error(`[drift] /tasks?workspaceId=ws2 leaked ${items.length} entries to ws1.owner`);
        expect.fail(`task leak: ${items.length} entries`);
      }
      expect(items.length).toBe(0);
    } else {
      expectStatus('ws1.owner', 'GET cross-ws tasks', r.status, 403, 404);
    }
  });
});
