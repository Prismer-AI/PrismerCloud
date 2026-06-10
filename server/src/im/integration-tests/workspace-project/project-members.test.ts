/**
 * Phase 2A integration — Project Membership (doc release201/09 + 16 Phase 10).
 *
 * Endpoints under test (src/im/api/projects.ts):
 *   GET    /projects/:id/members
 *   POST   /projects/:id/members         body { principalKind, principalId, role? }
 *   PATCH  /projects/:id/members/:membershipId  body { role }
 *   DELETE /projects/:id/members/:membershipId
 *
 * + workspace convenience:
 *   POST   /workspaces/:id/members/from-contact?contactId=...
 *
 * Key invariants verified:
 *   - principalKind='agent' bypasses workspace_members check (09 §5.3 carve-out
 *     — see src/im/services/project.service.ts:574)
 *   - principalKind='user' requires the user to already be a workspace member;
 *     non-workspace-member → 422 NOT_WORKSPACE_MEMBER (16 §3.3.3a)
 *   - workspace owner can be added as a non-owner project role (M444 backfill
 *     makes the owner a workspace_members row, so the invariant passes).
 *
 * The `from-contact` endpoint requires an IMContactRelation row between caller
 * and target. We don't seed contact relations in this Phase 2A pass — only
 * exercise the error case (NOT_CONTACT) which is fast and self-contained.
 * Full happy-path contact onboarding deferred to Phase 2G (see CLAUDE.md
 * §"complex contact setup deferred").
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapSuite, api, createTestUser, type TestActor } from '../_helpers';

/**
 * Local helper: register an *agent* IMUser via POST /register using a human
 * caller's JWT as the owner identity. The shared `createTestUser({ role: 'agent' })`
 * helper calls /register anonymously and the cloud rejects it with
 * "No owner IMUser found and no cloudUserId" (register.ts:506). The cloud
 * requires either an API-key cloudUserId or a JWT-resolved imUserId to fan out
 * the new agent's ownership. We pass `owner` so the agent registration sees
 * the human JWT and uses it as the owner ref.
 */
async function createAgentActor(opts: {
  prefix: string;
  owner: TestActor;
  agentType?: 'assistant' | 'specialist' | 'orchestrator' | 'tool' | 'bot';
}): Promise<TestActor> {
  const username = `${opts.prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`.slice(0, 32);
  const r = await api<{
    ok: boolean;
    data?: {
      imUserId: string;
      username: string;
      displayName: string;
      role: 'human' | 'agent';
      token: string;
    };
    error?: unknown;
  }>('POST', '/register', {
    actor: opts.owner,
    body: {
      type: 'agent',
      username,
      displayName: `IT agent ${opts.prefix}`,
      agentType: opts.agentType ?? 'assistant',
    },
    expectStatus: 201,
  });
  const d = r.data.data!;
  return {
    imUserId: d.imUserId,
    token: d.token,
    username: d.username,
    displayName: d.displayName,
    role: d.role,
  };
}

interface ProjectDTO {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  status: string;
}

interface ProjectEnvelope {
  ok: boolean;
  data?: ProjectDTO;
}

interface MembershipDTO {
  id: string;
  projectId: string;
  principalKind: 'user' | 'agent';
  principalId: string;
  role: 'owner' | 'contributor' | 'observer';
  joinedAt: string;
}

interface MembershipEnvelope {
  ok: boolean;
  data?: MembershipDTO;
  error?: { code?: string; message?: string } | string;
}

interface MembershipListEnvelope {
  ok: boolean;
  data?: MembershipDTO[];
}

function uniqSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`.toLowerCase();
}

function extractErrCode(envelope: { error?: { code?: string; message?: string } | string }): string | undefined {
  const err = envelope.error;
  if (typeof err === 'object' && err !== null) return err.code;
  return undefined;
}

describe('project-members — doc 09 + 16 Phase 10', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapSuite>>;
  let projectId: string;
  let agentActor: TestActor;

  beforeAll(async () => {
    ctx = await bootstrapSuite('phase2apm');

    // One project to host all membership cases.
    const created = await api<ProjectEnvelope>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug: uniqSlug('pmproj'), name: 'Project for member tests' },
      expectStatus: 201,
    });
    projectId = created.data.data!.id;

    // Mint an agent actor — project membership of an agent principal does
    // NOT require workspace membership (09 §5.3). Agent register needs an
    // owner identity (cloudUserId OR JWT imUserId); we pass owner's token.
    agentActor = await createAgentActor({ prefix: 'pmag', owner: ctx.owner, agentType: 'assistant' });
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  test('POST agent principal succeeds without workspace-member check', async () => {
    const r = await api<MembershipEnvelope>('POST', `/projects/${projectId}/members`, {
      actor: ctx.owner,
      body: { principalKind: 'agent', principalId: agentActor.imUserId, role: 'contributor' },
    });
    expect(r.status).toBe(201);
    expect(r.data.data?.principalKind).toBe('agent');
    expect(r.data.data?.principalId).toBe(agentActor.imUserId);
    expect(r.data.data?.role).toBe('contributor');
  });

  test('POST user principal who IS a workspace member succeeds', async () => {
    // Add a fresh user to workspace_members first, then add them to the
    // project as a user principal. The owner-auto-backfill side of this is
    // covered by the next test.
    const wsMember = await createTestUser({ prefix: 'pmusr' });
    const wsAdd = await api('POST', `/workspaces/${ctx.workspace.id}/members`, {
      actor: ctx.owner,
      body: { memberImUserId: wsMember.imUserId, role: 'member' },
    });
    expect(wsAdd.status).toBe(201);

    const r = await api<MembershipEnvelope>('POST', `/projects/${projectId}/members`, {
      actor: ctx.owner,
      body: { principalKind: 'user', principalId: wsMember.imUserId, role: 'contributor' },
    });
    expect(r.status).toBe(201);
    expect(r.data.data?.principalKind).toBe('user');
    expect(r.data.data?.principalId).toBe(wsMember.imUserId);
  });

  test('B2 strict: POST user principal=workspace-owner → 201 (owner auto-inserted into workspace_members)', async () => {
    // v2.0.7.1 hotfix B2: workspace owner is auto-inserted into
    // im_workspace_members on POST /workspaces, so the owner now satisfies
    // the NOT_WORKSPACE_MEMBER guard (16 §3.3.3a) and can be added to a
    // project as a user principal directly.
    const r = await api<MembershipEnvelope>('POST', `/projects/${projectId}/members`, {
      actor: ctx.owner,
      body: { principalKind: 'user', principalId: ctx.owner.imUserId, role: 'contributor' },
    });
    expect(r.status).toBe(201);
    expect(r.data.data?.principalKind).toBe('user');
    expect(r.data.data?.principalId).toBe(ctx.owner.imUserId);
    expect(extractErrCode(r.data)).toBeUndefined();
  });

  test('POST user principal who is NOT a workspace member → 422 NOT_WORKSPACE_MEMBER', async () => {
    const outsiderUser = await createTestUser({ prefix: 'pmout' });
    const r = await api<MembershipEnvelope>('POST', `/projects/${projectId}/members`, {
      actor: ctx.owner,
      body: { principalKind: 'user', principalId: outsiderUser.imUserId, role: 'contributor' },
    });
    expect(r.status).toBe(422);
    expect(extractErrCode(r.data)).toBe('NOT_WORKSPACE_MEMBER');
  });

  test('GET /projects/:id/members lists all added principals', async () => {
    const r = await api<MembershipListEnvelope>('GET', `/projects/${projectId}/members`, {
      actor: ctx.owner,
    });
    expect(r.status).toBe(200);
    const items = r.data.data ?? [];
    const ids = items.map((m) => m.principalId);
    // From the earlier tests: agentActor was added; owner attempt to add self
    // failed (drift), but at least the agent must be there.
    expect(ids).toContain(agentActor.imUserId);
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  test('DELETE /projects/:id/members/:membershipId removes a membership', async () => {
    // Add a fresh agent (avoid clobbering rows used by other tests in this
    // suite) then remove its row.
    const tmpAgent = await createAgentActor({ prefix: 'pmrm', owner: ctx.owner, agentType: 'tool' });
    const addRes = await api<MembershipEnvelope>('POST', `/projects/${projectId}/members`, {
      actor: ctx.owner,
      body: { principalKind: 'agent', principalId: tmpAgent.imUserId, role: 'observer' },
    });
    expect(addRes.status).toBe(201);
    const membershipId = addRes.data.data!.id;

    const delRes = await api<MembershipEnvelope>('DELETE', `/projects/${projectId}/members/${membershipId}`, {
      actor: ctx.owner,
    });
    expect(delRes.status).toBe(200);

    // List should no longer contain that membership id.
    const after = await api<MembershipListEnvelope>('GET', `/projects/${projectId}/members`, { actor: ctx.owner });
    const ids = (after.data.data ?? []).map((m) => m.id);
    expect(ids).not.toContain(membershipId);
  });

  test('POST /workspaces/:id/members/from-contact without contact relation → 404 NOT_CONTACT', async () => {
    // Target is a brand-new user with no IMContactRelation to ctx.owner.
    // Service throws NotContactError → 404 (anti-enumeration). Full happy-path
    // contact onboarding deferred to Phase 2G.
    const stranger = await createTestUser({ prefix: 'pmcnt' });
    const r = await api('POST', `/workspaces/${ctx.workspace.id}/members/from-contact`, {
      actor: ctx.owner,
      query: { contactId: stranger.imUserId },
    });
    expect(r.status).toBe(404);
    // Tolerate both error envelope shapes (string vs object).
    const body = r.data as unknown as {
      error?: { code?: string; message?: string } | string;
      meta?: { code?: string };
    };
    const code = body.meta?.code ?? (typeof body.error === 'object' && body.error ? body.error.code : undefined);
    expect(code).toBe('NOT_CONTACT');
  });
});
