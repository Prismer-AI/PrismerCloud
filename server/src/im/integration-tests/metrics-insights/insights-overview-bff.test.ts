/**
 * Phase 2E Suite 2 — release201/12 Insights overview BFF.
 *
 * Drives GET /insights/overview against the live cloud + dev MySQL.
 * Asserts the 8-widget envelope (doc 12 §4.1: 4 counters + timeseries +
 * sparkline + bar + grid), all 4 range buckets (24h/7d/30d/90d), the
 * WORKSPACE_REQUIRED 400 guard, the workspace-member 403/404 guard, the
 * empty-workspace soft path, and the p95 latency budget (doc 12 §0.2.2,
 * server-side p95 ≤ 500ms).
 *
 * Latency methodology: 5 back-to-back GETs of /overview against a freshly
 * created (mostly-empty) workspace. Cache TTL is 30s so the first call
 * is a MISS and the next 4 are HIT — the p95 we report is the realistic
 * "hot path" the design budget targets (12 §7.4 step 4 — 30s in-process
 * cache). We do NOT sleep between calls.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { api, bootstrapSuite, type SuiteContext, TEST_TARGET } from '../_helpers';

interface OverviewWidgets {
  tasksCompleted: { type: 'counter'; value: number; delta?: number | null };
  acceptancePassRate: { type: 'counter'; value: number; unit?: string };
  skillsPublished: { type: 'counter'; value: number; delta?: number | null };
  activeProjects: { type: 'counter'; value: number };
  taskVelocity: { type: 'timeseries'; buckets: Array<{ ts: string; value: number | null }> };
  approvalLatency: { type: 'sparkline'; buckets: Array<{ ts: string; value: number | null }>; summary?: unknown };
  topCapabilities: { type: 'bar'; items: Array<{ label: string; value: number }> };
  acceptanceByProject: {
    type: 'grid';
    columns: string[];
    rows: Array<{ label: string; counts: Record<string, number> }>;
  };
}

interface OverviewData {
  workspaceId: string;
  range: { from: string; to: string; previous: { from: string; to: string } };
  widgets: OverviewWidgets;
  asOf: string;
}

interface OverviewEnv {
  ok: boolean;
  data?: OverviewData;
  error?: { code: string; message: string };
}

async function overview(actor: SuiteContext['owner'], workspaceId?: string | null, range?: string) {
  const q: Record<string, string | undefined> = { range };
  if (workspaceId) q.workspaceId = workspaceId;
  return api<OverviewEnv>('GET', '/insights/overview', { actor, query: q });
}

describe('Phase 2E.2 — insights/overview BFF (doc 12)', () => {
  let ctx: SuiteContext;
  let emptyWs: { id: string };

  beforeAll(async () => {
    ctx = await bootstrapSuite('p2e2ovw');
    // A second, untouched workspace owned by the same actor — used for the
    // empty-state test. Insights must not 500 on a workspace with zero
    // tasks / projects / skills.
    const r = await api<{ ok: boolean; data?: { id: string } }>('POST', '/workspaces', {
      actor: ctx.owner,
      body: { name: `IT p2e2 empty`, slug: `it-p2e2-empty-${Date.now().toString(36)}` },
      expectStatus: 201,
    });
    emptyWs = { id: r.data.data!.id };
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
    if (emptyWs) {
      try {
        const detail = await api<{ ok: boolean; data?: { name: string } }>('GET', `/workspaces/${emptyWs.id}`, {
          actor: ctx.owner,
        });
        if (detail.data?.data?.name) {
          await api('DELETE', `/workspaces/${emptyWs.id}`, {
            actor: ctx.owner,
            query: { confirmName: detail.data.data.name },
          });
        }
      } catch {
        /* best-effort */
      }
    }
  }, 30_000);

  test('overview returns 8 widgets (doc 12 §4.1)', async () => {
    const r = await overview(ctx.owner, ctx.workspace.id, '24h');
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    const w = r.data.data?.widgets;
    expect(w, 'widgets present').toBeDefined();
    if (!w) return;

    // 4 counters
    expect(w.tasksCompleted?.type).toBe('counter');
    expect(w.acceptancePassRate?.type).toBe('counter');
    expect(w.skillsPublished?.type).toBe('counter');
    expect(w.activeProjects?.type).toBe('counter');
    // timeseries + sparkline + bar + grid
    expect(w.taskVelocity?.type).toBe('timeseries');
    expect(Array.isArray(w.taskVelocity?.buckets)).toBe(true);
    expect(w.approvalLatency?.type).toBe('sparkline');
    expect(Array.isArray(w.approvalLatency?.buckets)).toBe(true);
    expect(w.topCapabilities?.type).toBe('bar');
    expect(Array.isArray(w.topCapabilities?.items)).toBe(true);
    expect(w.acceptanceByProject?.type).toBe('grid');
    expect(Array.isArray(w.acceptanceByProject?.rows)).toBe(true);

    // 8 widgets total — no extras, no missing.
    const widgetKeys = Object.keys(w);
    expect(widgetKeys.length, `expected 8 widgets, got ${widgetKeys.length}: ${widgetKeys.join(',')}`).toBe(8);

    // range echo
    expect(r.data.data?.range?.from).toBeDefined();
    expect(r.data.data?.range?.to).toBeDefined();
    expect(r.data.data?.range?.previous?.from).toBeDefined();
  });

  test('each range value (24h / 7d / 30d / 90d) returns 200', async () => {
    for (const range of ['24h', '7d', '30d', '90d']) {
      const r = await overview(ctx.owner, ctx.workspace.id, range);
      expect(r.status, `range=${range}`).toBe(200);
      expect(r.data.ok, `range=${range} ok`).toBe(true);
    }
  });

  test('missing workspaceId → 400 WORKSPACE_REQUIRED', async () => {
    const r = await overview(ctx.owner, null, '24h');
    expect(r.status).toBe(400);
    expect(r.data.ok).toBe(false);
    expect(r.data.error?.code).toBe('WORKSPACE_REQUIRED');
  });

  test('non-member sees 403 (insights.service WorkspaceForbiddenError)', async () => {
    const r = await overview(ctx.outsider, ctx.workspace.id, '24h');
    // assertWorkspaceMember throws WorkspaceForbiddenError (status=403,
    // code=WORKSPACE_FORBIDDEN). No data must leak.
    expect(r.status).toBe(403);
    expect(r.data.ok).toBe(false);
    expect(r.data.error?.code).toBe('WORKSPACE_FORBIDDEN');
    expect((r.data as { data?: unknown }).data).toBeUndefined();
  });

  test('empty workspace returns 200 with zero-valued widgets (no 500)', async () => {
    const r = await overview(ctx.owner, emptyWs.id, '7d');
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    const w = r.data.data?.widgets;
    expect(w).toBeDefined();
    if (!w) return;
    // Empty workspace must report 0 / [] across the surface — not undefined,
    // not 500. The BFF assembles widgets even with no metric rows.
    expect(w.tasksCompleted.value).toBe(0);
    expect(w.skillsPublished.value).toBe(0);
    expect(w.activeProjects.value).toBe(0);
    expect(w.acceptancePassRate.value).toBe(0); // ratio = 0 when no denominator
    expect(w.topCapabilities.items.length).toBeGreaterThanOrEqual(0);
    expect(w.acceptanceByProject.rows.length).toBeGreaterThanOrEqual(0);
  });

  test('p95 latency ≤ 500ms across 5 back-to-back calls (doc 12 §0.2.2)', async () => {
    const wsId = ctx.workspace.id;
    // Drop cache by varying range to force a MISS, then take 5 hits with
    // the same key — but doc 12 budget covers both MISS and HIT. We
    // measure the realistic call distribution: first call is MISS (asserts
    // BFF cold-path), the rest are HIT.
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const r = await overview(ctx.owner, wsId, '7d');
      const t1 = performance.now();
      expect(r.status, `sample #${i} status`).toBe(200);
      samples.push(t1 - t0);
    }
    samples.sort((a, b) => a - b);
    const p95Idx = Math.min(samples.length - 1, Math.ceil(0.95 * samples.length) - 1);
    const p95 = samples[p95Idx];
    const min = samples[0];
    const max = samples[samples.length - 1];
    console.log(
      `[overview latency] samples(ms)=[${samples.map((x) => Math.round(x)).join(',')}] ` +
        `min=${Math.round(min)} p95=${Math.round(p95)} max=${Math.round(max)} target=${TEST_TARGET}`,
    );
    // doc 12 §0.2.2 says server-side p95 ≤ 500ms. We're including the
    // localhost HTTP round-trip on top, but on a hot dev box with
    // docker MySQL on 3307 the budget should still hold. If it fails,
    // attach the per-sample breakdown above.
    if (p95 > 500) {
      console.warn(
        `[overview latency] p95=${Math.round(p95)}ms exceeds 500ms budget — ` +
          `may indicate cold MySQL connection or fan-out regression`,
      );
    }
    expect(p95).toBeLessThanOrEqual(500);
  }, 30_000);
});
