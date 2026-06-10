/**
 * Phase 2D — skill lifecycle promote state machine (doc 08).
 * release201/08-skill-lifecycle-sop.md §2 (5 main stages + 7 valid transitions)
 * §0.2.4 forbidden patterns (reviewer ≠ owner).
 *
 * Covers POST /api/im/skills/:id/promote happy paths + the two key invariants:
 *   - valid transitions: draft → eval → review → published → archived
 *   - skip jump (draft → published) blocked with 409
 *   - self-review block (actor === ownerAgentId on review → published) → 403
 *
 * Authoring agent ownership: per skill-draft.service.ts step 2, ownerAgentId
 * must either be in IMAgentProfile for the workspace OR be the workspace
 * owner. Our test harness has only human IMUser rows for the bootstrap actors
 * (no agent profiles), so we author as ctx.owner (the workspace owner) and
 * use a non-owner actor (ctx.member) as reviewer. This naturally satisfies
 * §0.2.4 reviewer ≠ ownerAgent.
 *
 * No daemon needed — eval task is auto-created at promote-time (skill-eval
 * IMTask on draft→eval; skill-review IMTask on eval→review). The actual eval
 * run + sample task creation is exercised by sibling test files.
 *
 * Runs against live `npm run dev` at 127.0.0.1:3000. No mocks.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { api, bootstrapSuite } from '../_helpers';
import { buildDraftBody, uniqueSlug } from './_skill-fixtures';

type Envelope<T> = { ok: boolean; data?: T; error?: string; code?: string };

interface PromoteResult {
  skill: { id: string; lifecycleStage: string; status: string };
  taskId: string | null;
}

interface DraftCreated {
  id: string;
  slug: string;
  reviewTaskId: string | null;
}

interface PublishedSkill {
  skillId: string;
  publishScope: string;
  publishedAt: string | null;
  sampleTaskId: string | null;
  readmeFileId: string | null;
}

/**
 * Mint a fresh draft authored by the workspace owner. The owner's imUserId
 * doubles as ownerAgentId — that satisfies step 2 of createDraft (the
 * workspaceOwned branch). For self-review tests we use the owner as both
 * author AND reviewer (actor) and assert the 403.
 */
async function newDraftAsOwner(
  owner: { imUserId: string; token: string },
  workspaceId: string,
  slugPrefix = 'promote',
) {
  const slug = uniqueSlug(slugPrefix);
  const body = buildDraftBody({ slug, workspaceId, ownerAgentId: owner.imUserId });
  const r = await api<Envelope<DraftCreated>>('POST', '/skills/draft', {
    actor: owner as any,
    body,
  });
  expect(r.status).toBe(201);
  return r.data.data!;
}

describe('skill-lifecycle promote (doc 08 state machine)', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapSuite>>;

  beforeAll(async () => {
    ctx = await bootstrapSuite('p2dprm');
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  test('draft → eval (owner-author triggers) returns lifecycleStage=eval + creates skill-eval task', async () => {
    const draft = await newDraftAsOwner(ctx.owner, ctx.workspace.id);
    const r = await api<Envelope<PromoteResult>>('POST', `/skills/${draft.id}/promote`, {
      actor: ctx.owner,
      body: { to: 'eval' },
    });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(r.data.data!.skill.lifecycleStage).toBe('eval');
    // §0.2.3 status mapping: eval → status='draft'
    expect(r.data.data!.skill.status).toBe('draft');
    expect(r.data.data!.taskId).toBeTruthy();
  });

  test('full sequence draft → eval → review → published(workspace scope)', async () => {
    const draft = await newDraftAsOwner(ctx.owner, ctx.workspace.id, 'fullseq');
    // owner-as-author promotes to eval
    const r1 = await api<Envelope<PromoteResult>>('POST', `/skills/${draft.id}/promote`, {
      actor: ctx.owner,
      body: { to: 'eval' },
    });
    expect(r1.status).toBe(200);
    expect(r1.data.data!.skill.lifecycleStage).toBe('eval');

    // owner promotes to review
    const r2 = await api<Envelope<PromoteResult>>('POST', `/skills/${draft.id}/promote`, {
      actor: ctx.owner,
      body: { to: 'review' },
    });
    expect(r2.status).toBe(200);
    expect(r2.data.data!.skill.lifecycleStage).toBe('review');

    // Different actor (ctx.member, ≠ ownerAgent) approves via /publish-template
    // satisfies §0.2.4 reviewer ≠ owner invariant.
    const pub = await api<Envelope<PublishedSkill>>('POST', `/skills/${draft.id}/publish-template`, {
      actor: ctx.member,
      body: { scope: 'workspace', license: 'MIT' },
    });
    expect(pub.status).toBe(200);
    expect(pub.data.ok).toBe(true);
    expect(pub.data.data!.publishScope).toBe('workspace');
    expect(pub.data.data!.publishedAt).toBeTruthy();

    // sampleTaskId should be created (skill-tryout capability, §8.2 boilerplate).
    if (!pub.data.data!.sampleTaskId) {
      expect.fail(
        '[doc-drift] publish-template did not create a sample task (release201/08 §8.2 expects auto-generated try-out task)',
      );
    }
    const tryoutTasks = await api<Envelope<Array<{ id: string; capability: string; status: string }>>>(
      'GET',
      '/tasks',
      {
        actor: ctx.owner,
        query: { workspaceId: ctx.workspace.id, capability: 'skill-tryout', view: 'all' },
      },
    );
    expect(tryoutTasks.status).toBe(200);
    const tryoutHit = (tryoutTasks.data.data ?? []).find((t) => t.id === pub.data.data!.sampleTaskId);
    expect(tryoutHit, 'skill-tryout task should appear via GET /tasks').toBeTruthy();

    // README is written to workspace files at skills/<slug>/README.md (§8.1).
    // v2.0.7.1 hotfix (B7): path stored without leading '/' so direct
    // GET ?path=skills/<slug>/README.md resolves via normalizePath.
    if (!pub.data.data!.readmeFileId) {
      expect.fail(
        '[doc-drift] publish-template did not return readmeFileId — release201/08 §8.1 expects auto-generated README in workspace files',
      );
    }
    const listRes = await api<Envelope<Array<{ id: string; path: string }>>>(
      'GET',
      `/workspaces/${ctx.workspace.id}/files`,
      { actor: ctx.owner },
    );
    expect(listRes.status).toBe(200);
    const readmePath = `skills/${draft.slug}/README.md`;
    const hit = (listRes.data.data ?? []).find((f) => f.id === pub.data.data!.readmeFileId);
    expect(hit, `readmeFileId ${pub.data.data!.readmeFileId} should appear in GET /workspaces/:id/files`).toBeTruthy();
    expect(hit!.path).toBe(readmePath);

    // Direct path lookup via GET ?path= must resolve (B7 strict assertion).
    const directRes = await api<Envelope<{ id: string; path: string }>>(
      'GET',
      `/workspaces/${ctx.workspace.id}/files`,
      { actor: ctx.owner, query: { path: readmePath } },
    );
    expect(directRes.status).toBe(200);
    expect(directRes.data.ok).toBe(true);
    expect(directRes.data.data!.id).toBe(pub.data.data!.readmeFileId);
    expect(directRes.data.data!.path).toBe(readmePath);
  });

  test('published → archived (terminal) succeeds for workspace owner', async () => {
    const draft = await newDraftAsOwner(ctx.owner, ctx.workspace.id, 'arch');
    // promote up to review (owner as author)
    await api<Envelope<PromoteResult>>('POST', `/skills/${draft.id}/promote`, {
      actor: ctx.owner,
      body: { to: 'eval' },
    });
    await api<Envelope<PromoteResult>>('POST', `/skills/${draft.id}/promote`, {
      actor: ctx.owner,
      body: { to: 'review' },
    });
    // ctx.member (≠ ownerAgent) publishes
    const pub = await api<Envelope<PublishedSkill>>('POST', `/skills/${draft.id}/publish-template`, {
      actor: ctx.member,
      body: { scope: 'workspace', license: 'MIT' },
    });
    expect(pub.status).toBe(200);

    // archive — anyone with valid auth can promote (no extra workspace check
    // in service; revoke + archive are owner intent but not enforced).
    const r = await api<Envelope<PromoteResult>>('POST', `/skills/${draft.id}/promote`, {
      actor: ctx.owner,
      body: { to: 'archived', reason: 'test archive' },
    });
    expect(r.status).toBe(200);
    expect(r.data.data!.skill.lifecycleStage).toBe('archived');
    expect(r.data.data!.skill.status).toBe('deprecated'); // §0.2.3 mapping
  });

  test('invalid jump draft → published rejected with 409 invalid_transition', async () => {
    const draft = await newDraftAsOwner(ctx.owner, ctx.workspace.id, 'jump');
    const r = await api<Envelope<unknown>>('POST', `/skills/${draft.id}/promote`, {
      actor: ctx.owner,
      body: { to: 'published' },
    });
    expect(r.status).toBe(409);
    expect(r.data.ok).toBe(false);
    if (r.data.code) {
      expect(r.data.code).toBe('invalid_transition');
    }
  });

  test('self-review blocked: ownerAgent cannot promote review → published (§0.2.4)', async () => {
    const draft = await newDraftAsOwner(ctx.owner, ctx.workspace.id, 'self');
    await api<Envelope<PromoteResult>>('POST', `/skills/${draft.id}/promote`, {
      actor: ctx.owner,
      body: { to: 'eval' },
    });
    await api<Envelope<PromoteResult>>('POST', `/skills/${draft.id}/promote`, {
      actor: ctx.owner,
      body: { to: 'review' },
    });
    // owner is also ownerAgentId — promote to published should 403 self_review.
    const r = await api<Envelope<unknown>>('POST', `/skills/${draft.id}/promote`, {
      actor: ctx.owner,
      body: { to: 'published' },
    });
    expect(r.status).toBe(403);
    expect(r.data.ok).toBe(false);
    if (r.data.code) {
      expect(r.data.code).toBe('self_review');
    }
  });

  test('self-review blocked at publish-template too', async () => {
    const draft = await newDraftAsOwner(ctx.owner, ctx.workspace.id, 'self2');
    await api<Envelope<PromoteResult>>('POST', `/skills/${draft.id}/promote`, {
      actor: ctx.owner,
      body: { to: 'eval' },
    });
    await api<Envelope<PromoteResult>>('POST', `/skills/${draft.id}/promote`, {
      actor: ctx.owner,
      body: { to: 'review' },
    });
    const r = await api<Envelope<unknown>>('POST', `/skills/${draft.id}/publish-template`, {
      actor: ctx.owner,
      body: { scope: 'workspace', license: 'MIT' },
    });
    expect(r.status).toBe(403);
    if (r.data.code) {
      expect(r.data.code).toBe('self_review');
    }
  });
});
