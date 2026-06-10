/**
 * Phase 2C — Acceptance criteria CRUD + unified verify entry (rev 2 §6.2).
 *
 * Covers:
 *   - POST /tasks/:id/criteria — verifyMode ∈ {qualitative, quantitative,
 *                                              agent-self-check, manual}
 *   - PATCH /tasks/:id/criteria/:cid — update expectation
 *   - DELETE /tasks/:id/criteria/:cid
 *   - POST /tasks/:id/criteria/:cid/verify — outcome ∈ {passed, failed, n/a, waived}
 *   - GET /tasks/:id/acceptance — overall + criteria[] + passRate
 *   - POST /tasks/:id/apply-template — non-existent template → 404
 *
 * No mocking — real HTTP against live cloud.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { api, bootstrapSuite, type SuiteContext } from '../_helpers';

describe('task-lifecycle — acceptance criteria CRUD + verify', () => {
  let ctx: SuiteContext;
  let taskId: string;
  const criterionIds: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await bootstrapSuite('p2ccrit');
    // Create a real task to attach criteria to.
    const r = await api<{ ok: boolean; data?: { id: string } }>('POST', '/tasks', {
      actor: ctx.owner,
      body: {
        workspaceId: ctx.workspace.id,
        title: 'P2C criteria test',
        capability: 'generic',
        metadata: { kind: 'work_item' },
      },
      expectStatus: 201,
    });
    taskId = r.data.data!.id;
  });

  afterAll(async () => {
    await ctx?.cleanup?.();
  });

  test('POST criterion (qualitative) → returns criterion + acceptance', async () => {
    const r = await api<{
      ok: boolean;
      data?: {
        acceptance: { criteria: Array<{ id: string }>; totalCount: number; overall: string };
        criterion: { id: string; verifyMode: string; expectation: string; status: string };
      };
    }>('POST', `/tasks/${taskId}/criteria`, {
      actor: ctx.owner,
      body: {
        verifyMode: 'qualitative',
        expectation: 'UI looks polished and on-brand.',
      },
    });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(r.data.data?.criterion.verifyMode).toBe('qualitative');
    expect(r.data.data?.criterion.status).toBe('pending');
    expect(r.data.data?.criterion.id).toMatch(/^c[\w-]+/);
    expect(r.data.data?.acceptance.totalCount).toBe(1);
    criterionIds.qualitative = r.data.data!.criterion.id;
  });

  test('POST 3 more criteria covers quantitative, agent-self-check, manual', async () => {
    const cases: Array<{ key: string; verifyMode: string; expectation: string }> = [
      { key: 'quantitative', verifyMode: 'quantitative', expectation: 'p95 latency < 200ms' },
      {
        key: 'agentSelfCheck',
        verifyMode: 'agent-self-check',
        expectation: 'Assignee confirms TODO items completed.',
      },
      { key: 'manual', verifyMode: 'manual', expectation: 'Reviewer eyeballs UX flow.' },
    ];
    for (const c of cases) {
      const r = await api<{
        ok: boolean;
        data?: { criterion: { id: string; verifyMode: string } };
      }>('POST', `/tasks/${taskId}/criteria`, {
        actor: ctx.owner,
        body: { verifyMode: c.verifyMode, expectation: c.expectation },
      });
      expect(r.status, `add ${c.verifyMode}`).toBe(200);
      expect(r.data.data?.criterion.verifyMode).toBe(c.verifyMode);
      criterionIds[c.key] = r.data.data!.criterion.id;
    }

    const g = await api<{
      ok: boolean;
      data?: { criteria: Array<{ id: string; verifyMode: string }>; totalCount: number };
    }>('GET', `/tasks/${taskId}/acceptance`, { actor: ctx.owner });
    expect(g.status).toBe(200);
    expect(g.data.data?.totalCount).toBe(4);
    const modes = new Set(g.data.data?.criteria.map((c) => c.verifyMode));
    expect(modes).toEqual(new Set(['qualitative', 'quantitative', 'agent-self-check', 'manual']));
  });

  test('PATCH criterion updates expectation', async () => {
    const cid = criterionIds.qualitative!;
    const r = await api<{
      ok: boolean;
      data?: { criteria: Array<{ id: string; expectation: string; status: string }> };
    }>('PATCH', `/tasks/${taskId}/criteria/${cid}`, {
      actor: ctx.owner,
      body: { expectation: 'UI looks polished on dark + light themes.' },
    });
    expect(r.status).toBe(200);
    const updated = r.data.data?.criteria.find((c) => c.id === cid);
    expect(updated?.expectation).toBe('UI looks polished on dark + light themes.');
    // Significant change → status reset to pending (per §0.2.3, already was pending).
    expect(updated?.status).toBe('pending');
  });

  test('DELETE one criterion → totalCount drops to 3', async () => {
    const cid = criterionIds.manual!;
    const r = await api<{
      ok: boolean;
      data?: { criteria: Array<{ id: string }>; totalCount: number };
    }>('DELETE', `/tasks/${taskId}/criteria/${cid}`, { actor: ctx.owner });
    expect(r.status).toBe(200);
    expect(r.data.data?.totalCount).toBe(3);
    expect(r.data.data?.criteria.find((c) => c.id === cid)).toBeUndefined();
    delete criterionIds.manual;
  });

  test('POST verify with outcome=passed flips criterion + overall recompute', async () => {
    const cid = criterionIds.quantitative!;
    const r = await api<{
      ok: boolean;
      data?: {
        criteria: Array<{ id: string; status: string; verifiedBy: string | null; verifyOutcomeNote: string | null }>;
        overall: string;
      };
    }>('POST', `/tasks/${taskId}/criteria/${cid}/verify`, {
      actor: ctx.owner,
      body: {
        outcome: 'passed',
        note: 'Benchmark p95 = 148ms (n=200).',
      },
    });
    expect(r.status).toBe(200);
    const verified = r.data.data?.criteria.find((c) => c.id === cid);
    expect(verified?.status).toBe('passed');
    expect(verified?.verifiedBy).toBe(ctx.owner.imUserId);
    expect(verified?.verifyOutcomeNote).toBe('Benchmark p95 = 148ms (n=200).');
    // 1 of 3 passed, others still pending → overall=partial.
    expect(r.data.data?.overall).toBe('partial');
  });

  test('GET /acceptance reflects pass rate + overall state', async () => {
    const r = await api<{
      ok: boolean;
      data?: {
        overall: string;
        totalCount: number;
        completedCount: number;
        passRate: number;
        criteria: Array<{ id: string; status: string }>;
      };
    }>('GET', `/tasks/${taskId}/acceptance`, { actor: ctx.owner });
    expect(r.status).toBe(200);
    expect(r.data.data?.totalCount).toBe(3);
    expect(r.data.data?.completedCount).toBe(1);
    expect(r.data.data?.passRate).toBeCloseTo(1 / 3, 5);
    expect(r.data.data?.overall).toBe('partial');
  });

  test('verify outcome=failed flips overall to failed', async () => {
    const cid = criterionIds.qualitative!;
    const r = await api<{
      ok: boolean;
      data?: { overall: string; criteria: Array<{ id: string; status: string }> };
    }>('POST', `/tasks/${taskId}/criteria/${cid}/verify`, {
      actor: ctx.owner,
      body: { outcome: 'failed', note: 'theme tokens leak.' },
    });
    expect(r.status).toBe(200);
    expect(r.data.data?.overall).toBe('failed');
    const c = r.data.data?.criteria.find((x) => x.id === cid);
    expect(c?.status).toBe('failed');
  });

  test('POST verify rejects bad outcome', async () => {
    const cid = criterionIds.agentSelfCheck!;
    const r = await api<{ ok: boolean; error?: unknown }>('POST', `/tasks/${taskId}/criteria/${cid}/verify`, {
      actor: ctx.owner,
      body: { outcome: 'sortof' },
    });
    expect(r.status).toBe(400);
    expect(r.data.ok).toBe(false);
  });

  test('POST apply-template with bogus id → 404 template_not_found', async () => {
    const r = await api<{ ok: boolean; error?: { code: string } }>('POST', `/tasks/${taskId}/apply-template`, {
      actor: ctx.owner,
      body: { templateId: 'tpl_does_not_exist_xxx' },
    });
    // Service surfaces 404 + code template_not_found per task-acceptance.service.ts.
    expect(r.status).toBe(404);
    expect(r.data.ok).toBe(false);
    expect(r.data.error?.code).toBe('template_not_found');
  });

  test('PATCH single field does NOT clobber other fields (v2.0.7.1 hotfix B6)', async () => {
    // Repro of B6: pre-hotfix the PATCH endpoint synthesised `undefined`
    // for every omitted body field, the service spread that over the
    // existing row, and JSON-encoded `undefined` → null. So patching only
    // `evidenceRefs` silently wiped `verifierAgentId` (and weight, required,
    // expectation, verifyMode).
    //
    // Use a fresh task so the surrounding totalCount assertions stay valid.
    const t = await api<{ ok: boolean; data?: { id: string } }>('POST', '/tasks', {
      actor: ctx.owner,
      body: {
        workspaceId: ctx.workspace.id,
        title: 'P2C B6 patch-preserve probe',
        capability: 'generic',
        metadata: { kind: 'work_item' },
      },
      expectStatus: 201,
    });
    const probeTaskId = t.data.data!.id;

    const seed = await api<{ ok: boolean; data?: { criterion: { id: string } } }>(
      'POST',
      `/tasks/${probeTaskId}/criteria`,
      {
        actor: ctx.owner,
        body: {
          verifyMode: 'qualitative',
          expectation: 'Accessibility audit passes.',
          verifierAgentId: 'agent_lookout_v1',
          weight: 3,
          required: true,
        },
      },
    );
    expect(seed.status).toBe(200);
    const cid = seed.data.data!.criterion.id;

    // Patch only evidenceRefs.
    const patched = await api<{
      ok: boolean;
      data?: {
        criteria: Array<{
          id: string;
          verifyMode: string;
          expectation: string;
          verifierAgentId: string | null;
          weight: number;
          required: boolean;
          evidenceRefs: string[];
        }>;
      };
    }>('PATCH', `/tasks/${probeTaskId}/criteria/${cid}`, {
      actor: ctx.owner,
      body: { evidenceRefs: ['note:wcag-AA'] },
    });
    expect(patched.status).toBe(200);
    const row = patched.data.data?.criteria.find((c) => c.id === cid);
    expect(row, 'patched row must be present').toBeDefined();
    // Touched field landed.
    expect(row?.evidenceRefs).toEqual(['note:wcag-AA']);
    // Other fields untouched (no spread-undefined clobber).
    expect(row?.verifierAgentId).toBe('agent_lookout_v1');
    expect(row?.weight).toBe(3);
    expect(row?.required).toBe(true);
    expect(row?.expectation).toBe('Accessibility audit passes.');
    expect(row?.verifyMode).toBe('qualitative');
  });
});
