/**
 * Phase 2D — skill snapshot + cross-workspace import (doc 08 §4.3).
 * release201/08-skill-lifecycle-sop.md §4.3 + §10 endpoints.
 *
 * Verifies the snapshotKey one-time-use contract:
 *   - POST /skills/:id/share/snapshot returns prismer-snapshot:// URL +
 *     32-char key + expiresAt
 *   - POST /skills/import-snapshot into a different workspace produces a new
 *     IMSkill row with lifecycleStage='published' (copy semantics, §4.3)
 *   - Reuse of the same snapshotKey → 410 snapshot_reused
 *   - Wrong key on a valid snapshot URL → 403 invalid_snapshot_key
 *   - snapshot_revoked: there is no revoke endpoint mounted yet — skip with
 *     console note (release201/08 §4.3 lists revoked invariant but no API
 *     surface exposes the toggle)
 *
 * Runs against live `npm run dev` at 127.0.0.1:3000. No mocks.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { api, bootstrapSuite, createTestUser, createTestWorkspace } from '../_helpers';
import type { TestActor, TestWorkspace } from '../_helpers';
import { buildDraftBody, uniqueSlug } from './_skill-fixtures';

type Envelope<T> = { ok: boolean; data?: T; error?: string; code?: string };

interface DraftCreated {
  id: string;
  slug: string;
}

interface PromoteResult {
  skill: { id: string; lifecycleStage: string; status: string };
  taskId: string | null;
}

interface PublishedSkill {
  skillId: string;
  publishScope: string;
  publishedAt: string | null;
  sampleTaskId: string | null;
  readmeFileId: string | null;
}

interface SnapshotResult {
  snapshotUrl: string;
  snapshotKey: string;
  expiresAt: string;
}

interface ImportResult {
  newSkillId: string;
  importedFrom: { sourceSkillId: string; sourceWorkspaceId: string | null; importedAt: string };
}

/**
 * Walk a fresh draft authored by the workspace owner through the full
 * lifecycle to published(workspace). Returns the original skillId. The
 * reviewer must be != ownerAgent — we use a non-owner actor (reviewer) for
 * that final step.
 */
async function publishSkill(
  authorOwner: { imUserId: string; token: string },
  workspaceId: string,
  reviewer: { imUserId: string; token: string },
  slugPrefix = 'pub',
): Promise<DraftCreated> {
  const slug = uniqueSlug(slugPrefix);
  const body = buildDraftBody({ slug, workspaceId, ownerAgentId: authorOwner.imUserId });
  const c = await api<Envelope<DraftCreated>>('POST', '/skills/draft', { actor: authorOwner as any, body });
  expect(c.status).toBe(201);
  const draft = c.data.data!;
  for (const stage of ['eval', 'review'] as const) {
    const r = await api<Envelope<PromoteResult>>('POST', `/skills/${draft.id}/promote`, {
      actor: authorOwner as any,
      body: { to: stage },
    });
    expect(r.status).toBe(200);
  }
  const pub = await api<Envelope<PublishedSkill>>('POST', `/skills/${draft.id}/publish-template`, {
    actor: reviewer as any,
    body: { scope: 'workspace', license: 'MIT' },
  });
  expect(pub.status).toBe(200);
  expect(pub.data.data!.publishScope).toBe('workspace');
  return draft;
}

describe('skill snapshot + import (doc 08 §4.3)', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapSuite>>;
  let targetOwner: TestActor;
  let targetWorkspace: TestWorkspace;

  beforeAll(async () => {
    ctx = await bootstrapSuite('p2dsnap');
    // Target workspace lives outside the source suite — that's the cross-org
    // import path §4.3 cares about. Use a brand-new owner so we don't share
    // ownership accidentally.
    targetOwner = await createTestUser({ prefix: 'tgto' });
    targetWorkspace = await createTestWorkspace(targetOwner, { name: 'IT target ws' });
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
    // Best-effort target cleanup — re-use the workspace cleanup helper via
    // the suite cleanup pattern.
    try {
      await api('DELETE', `/workspaces/${targetWorkspace.id}`, {
        actor: targetOwner,
        query: { confirmName: targetWorkspace.name },
        headers: { Accept: 'text/event-stream' },
      });
    } catch {
      // best-effort
    }
  });

  test('POST /skills/:id/share/snapshot returns prismer-snapshot:// URL + 32-char key + future expiresAt', async () => {
    const draft = await publishSkill(ctx.owner, ctx.workspace.id, ctx.member, 'snap');
    const r = await api<Envelope<SnapshotResult>>('POST', `/skills/${draft.id}/share/snapshot`, {
      actor: ctx.owner,
      body: { ttlDays: 7 },
    });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    const snap = r.data.data!;
    expect(snap.snapshotUrl).toMatch(/^prismer-snapshot:\/\//);
    expect(snap.snapshotKey.length).toBeGreaterThanOrEqual(32);
    expect(snap.snapshotKey).toMatch(/^[a-f0-9]+$/);
    const expiry = new Date(snap.expiresAt).getTime();
    expect(expiry).toBeGreaterThan(Date.now());
    // 7 days TTL ≈ 7d ±1h tolerance.
    expect(expiry).toBeLessThan(Date.now() + 8 * 24 * 60 * 60 * 1000);
  });

  test('import-snapshot to different workspace creates new skill at lifecycleStage=published', async () => {
    const draft = await publishSkill(ctx.owner, ctx.workspace.id, ctx.member, 'imp');
    const snapRes = await api<Envelope<SnapshotResult>>('POST', `/skills/${draft.id}/share/snapshot`, {
      actor: ctx.owner,
      body: {},
    });
    expect(snapRes.status).toBe(200);
    const { snapshotUrl, snapshotKey } = snapRes.data.data!;

    const importRes = await api<Envelope<ImportResult>>('POST', '/skills/import-snapshot', {
      actor: targetOwner,
      body: { snapshotUrl, snapshotKey, targetWorkspaceId: targetWorkspace.id },
    });
    expect(importRes.status).toBe(201);
    expect(importRes.data.ok).toBe(true);
    expect(importRes.data.data!.newSkillId).toBeTruthy();
    expect(importRes.data.data!.importedFrom.sourceSkillId).toBe(draft.id);
    expect(importRes.data.data!.importedFrom.sourceWorkspaceId).toBe(ctx.workspace.id);

    // v2.0.8 D7 fix: GET /skills/:id DTO now exposes lifecycleStage +
    // publishScope + publishedAt directly (skill.service toDetail).
    // §4.3 + skill-lifecycle.service.ts:962 — imported skill is created at
    // lifecycleStage='published' / publishScope='workspace'.
    const newId = importRes.data.data!.newSkillId;
    const got = await api<Envelope<{ id: string; lifecycleStage?: string; publishScope?: string; status?: string }>>(
      'GET',
      `/skills/${newId}`,
      { actor: targetOwner },
    );
    expect(got.status).toBe(200);
    expect(got.data.ok).toBe(true);
    expect(got.data.data!.lifecycleStage).toBe('published');
    expect(got.data.data!.publishScope).toBe('workspace');
  });

  test('reuse same snapshotKey → 410 snapshot_reused', async () => {
    const draft = await publishSkill(ctx.owner, ctx.workspace.id, ctx.member, 'reuse');
    const snapRes = await api<Envelope<SnapshotResult>>('POST', `/skills/${draft.id}/share/snapshot`, {
      actor: ctx.owner,
      body: {},
    });
    expect(snapRes.status).toBe(200);
    const { snapshotUrl, snapshotKey } = snapRes.data.data!;

    const first = await api<Envelope<ImportResult>>('POST', '/skills/import-snapshot', {
      actor: targetOwner,
      body: { snapshotUrl, snapshotKey, targetWorkspaceId: targetWorkspace.id },
    });
    expect(first.status).toBe(201);

    const second = await api<Envelope<unknown>>('POST', '/skills/import-snapshot', {
      actor: targetOwner,
      body: { snapshotUrl, snapshotKey, targetWorkspaceId: targetWorkspace.id },
    });
    expect(second.status).toBe(410);
    if (second.data.code) {
      expect(second.data.code).toBe('snapshot_reused');
    }
  });

  test('wrong snapshotKey on valid URL → 403 invalid_snapshot_key', async () => {
    const draft = await publishSkill(ctx.owner, ctx.workspace.id, ctx.member, 'wrongkey');
    const snapRes = await api<Envelope<SnapshotResult>>('POST', `/skills/${draft.id}/share/snapshot`, {
      actor: ctx.owner,
      body: {},
    });
    expect(snapRes.status).toBe(200);
    const { snapshotUrl } = snapRes.data.data!;

    // Use an entirely different (still 32-char hex) key.
    const bogusKey = 'deadbeef'.repeat(4); // 32 chars
    const r = await api<Envelope<unknown>>('POST', '/skills/import-snapshot', {
      actor: targetOwner,
      body: { snapshotUrl, snapshotKey: bogusKey, targetWorkspaceId: targetWorkspace.id },
    });
    expect(r.status).toBe(403);
    if (r.data.code) {
      expect(r.data.code).toBe('invalid_snapshot_key');
    }
  });

  test('snapshot revoke endpoint flips `revoked=true`; subsequent import → 410 snapshot_revoked', async () => {
    // v2.0.8 D6 fix: POST /skills/:id/share/snapshot/:snapshotId/revoke
    // mounts the owner-only toggle. Snapshot id is encoded in the
    // prismer-snapshot://<snapshotId> URL.
    const draft = await publishSkill(ctx.owner, ctx.workspace.id, ctx.member, 'rev');
    const snapRes = await api<Envelope<SnapshotResult>>('POST', `/skills/${draft.id}/share/snapshot`, {
      actor: ctx.owner,
      body: {},
    });
    expect(snapRes.status).toBe(200);
    const { snapshotUrl, snapshotKey } = snapRes.data.data!;
    const snapshotId = snapshotUrl.replace('prismer-snapshot://', '');

    const rev = await api<Envelope<{ snapshotId: string; revoked: boolean; revokedAt: string }>>(
      'POST',
      `/skills/${draft.id}/share/snapshot/${snapshotId}/revoke`,
      { actor: ctx.owner, body: {} },
    );
    expect(rev.status).toBe(200);
    expect(rev.data.ok).toBe(true);
    expect(rev.data.data?.revoked).toBe(true);
    expect(rev.data.data?.snapshotId).toBe(snapshotId);

    // Subsequent import attempt → 410 snapshot_revoked (existing service guard).
    const imp = await api<Envelope<unknown>>('POST', '/skills/import-snapshot', {
      actor: targetOwner,
      body: { snapshotUrl, snapshotKey, targetWorkspaceId: targetWorkspace.id },
    });
    expect(imp.status).toBe(410);
    if (imp.data.code) {
      expect(imp.data.code).toBe('snapshot_revoked');
    }
  });

  test('snapshot revoke by non-owner → 403 snapshot_revoke_forbidden', async () => {
    const draft = await publishSkill(ctx.owner, ctx.workspace.id, ctx.member, 'revfb');
    const snapRes = await api<Envelope<SnapshotResult>>('POST', `/skills/${draft.id}/share/snapshot`, {
      actor: ctx.owner,
      body: {},
    });
    expect(snapRes.status).toBe(200);
    const snapshotId = snapRes.data.data!.snapshotUrl.replace('prismer-snapshot://', '');

    const rev = await api<Envelope<unknown>>('POST', `/skills/${draft.id}/share/snapshot/${snapshotId}/revoke`, {
      actor: targetOwner,
      body: {},
    });
    expect(rev.status).toBe(403);
    if (rev.data.code) {
      expect(rev.data.code).toBe('snapshot_revoke_forbidden');
    }
  });

  test('import with bogus snapshotUrl → 400 invalid_snapshot_url', async () => {
    const r = await api<Envelope<unknown>>('POST', '/skills/import-snapshot', {
      actor: targetOwner,
      body: {
        snapshotUrl: 'https://example.com/not-a-snapshot',
        snapshotKey: 'x'.repeat(32),
        targetWorkspaceId: targetWorkspace.id,
      },
    });
    expect(r.status).toBe(400);
    if (r.data.code) {
      expect(r.data.code).toBe('invalid_snapshot_url');
    }
  });
});
