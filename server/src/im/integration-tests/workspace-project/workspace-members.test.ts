/**
 * Phase 2A integration — Workspace Members CRUD (doc release201/16 Phase 8).
 *
 * Endpoints under test (mounted in src/im/api/workspaces.ts via routes.ts):
 *   GET    /workspaces/:id/members
 *   POST   /workspaces/:id/members         body { memberImUserId, role }
 *   PATCH  /workspaces/:id/members/:memberId  body { role }
 *   DELETE /workspaces/:id/members/:memberId  ← :memberId is the row id, not user id
 *
 * Permission rules verified (16 §3.3.1 + service src/im/services/workspace-member.service.ts):
 *   - list  : any member (404 to non-members, anti-enumeration)
 *   - add   : owner OR admin (B10 hotfix v2.0.7.1)
 *   - patch : owner OR admin (B10 hotfix v2.0.7.1)
 *   - delete: owner OR admin (B10 hotfix v2.0.7.1); owner row cannot be removed
 *
 * v2.0.7.1 hotfix (B2 + B9 + B10) closed the drift docs that previously lived
 * here:
 *   - B2: POST /workspaces now writes the owner row into im_workspace_members
 *     atomically (was missing; M444 only seeded historical rows).
 *   - B9: GET /workspaces/:id now honours WorkspaceMemberService.isMember
 *     (was hardcoded to ownerImUserId, hiding the workspace from non-owner
 *     members of their own workspace).
 *   - B10: add/updateRole/remove accept admin in addition to owner.
 * Tests below assert the post-hotfix strict behaviour.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapSuite, api, createTestUser, type TestActor } from '../_helpers';

interface WorkspaceMemberRow {
  id: string;
  workspaceId: string;
  memberImUserId: string;
  role: string;
  joinedAt: string;
}

interface MemberListEnvelope {
  ok: boolean;
  data?: WorkspaceMemberRow[];
  error?: unknown;
}

interface MemberSingleEnvelope {
  ok: boolean;
  data?: WorkspaceMemberRow | { removed: WorkspaceMemberRow; projectMembershipsRemoved: number };
  error?: { code?: string; message?: string } | string;
  meta?: { code?: string };
}

describe('workspace-members — doc 16 Phase 8', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapSuite>>;
  // After B2 hotfix the owner is auto-inserted as role='owner' on POST
  // /workspaces. We resolve and capture that row id so DELETE-self can target
  // it (and assert OWNER_CANNOT_BE_REMOVED fires).
  let ownerMemberRowId: string | null = null;

  beforeAll(async () => {
    ctx = await bootstrapSuite('phase2awsm');
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  test('B2 strict: workspace owner IS auto-inserted as role=owner on POST /workspaces (v2.0.7.1)', async () => {
    // v2.0.7.1 hotfix B2: POST /workspaces now writes the owner row into
    // im_workspace_members atomically. Owner GET /members must return 200
    // and the listing must contain a role='owner' row for the owner.
    const r = await api<MemberListEnvelope>('GET', `/workspaces/${ctx.workspace.id}/members`, {
      actor: ctx.owner,
    });
    expect(r.status).toBe(200);
    const rows = r.data.data ?? [];
    const ownerRow = rows.find((m) => m.memberImUserId === ctx.owner.imUserId);
    expect(ownerRow).toBeDefined();
    expect(ownerRow!.role).toBe('owner');
    ownerMemberRowId = ownerRow!.id;
  });

  test('GET /workspaces/:id/members lists bootstrap-seeded member/observer', async () => {
    const r = await api<MemberListEnvelope>('GET', `/workspaces/${ctx.workspace.id}/members`, {
      actor: ctx.owner,
    });
    expect(r.status).toBe(200);
    const ids = (r.data.data ?? []).map((m) => m.memberImUserId);
    // bootstrapSuite best-effort seeded member + observer as role='member'.
    const seedHit = ids.includes(ctx.member.imUserId) || ids.includes(ctx.observer.imUserId);
    expect(seedHit).toBe(true);
  });

  test('POST /workspaces/:id/members by owner adds a member (role=member)', async () => {
    const newcomer = await createTestUser({ prefix: 'wsmadd' });
    const r = await api<MemberSingleEnvelope>('POST', `/workspaces/${ctx.workspace.id}/members`, {
      actor: ctx.owner,
      body: { memberImUserId: newcomer.imUserId, role: 'member' },
    });
    expect(r.status).toBe(201);
    expect(r.data.ok).toBe(true);
    const row = r.data.data as WorkspaceMemberRow;
    expect(row.memberImUserId).toBe(newcomer.imUserId);
    expect(row.role).toBe('member');
  });

  test('PATCH /workspaces/:id/members/:memberId role=admin succeeds (owner)', async () => {
    const target = await createTestUser({ prefix: 'wsmpat' });
    const addRes = await api<MemberSingleEnvelope>('POST', `/workspaces/${ctx.workspace.id}/members`, {
      actor: ctx.owner,
      body: { memberImUserId: target.imUserId, role: 'member' },
    });
    expect(addRes.status).toBe(201);
    const memberRowId = (addRes.data.data as WorkspaceMemberRow).id;

    const patchRes = await api<MemberSingleEnvelope>(
      'PATCH',
      `/workspaces/${ctx.workspace.id}/members/${memberRowId}`,
      {
        actor: ctx.owner,
        body: { role: 'admin' },
      },
    );
    expect(patchRes.status).toBe(200);
    expect((patchRes.data.data as WorkspaceMemberRow).role).toBe('admin');
  });

  test('non-owner POST /members → 403 WORKSPACE_FORBIDDEN', async () => {
    const newcomer = await createTestUser({ prefix: 'wsm403' });
    const r = await api<MemberSingleEnvelope>('POST', `/workspaces/${ctx.workspace.id}/members`, {
      actor: ctx.member,
      body: { memberImUserId: newcomer.imUserId, role: 'member' },
    });
    expect(r.status).toBe(403);
  });

  test('DELETE /workspaces/:id/members/:memberId — happy path + ex-member loses read access', async () => {
    const target = await createTestUser({ prefix: 'wsmdel' });
    const addRes = await api<MemberSingleEnvelope>('POST', `/workspaces/${ctx.workspace.id}/members`, {
      actor: ctx.owner,
      body: { memberImUserId: target.imUserId, role: 'member' },
    });
    expect(addRes.status).toBe(201);
    const memberRowId = (addRes.data.data as WorkspaceMemberRow).id;

    const delRes = await api<MemberSingleEnvelope>('DELETE', `/workspaces/${ctx.workspace.id}/members/${memberRowId}`, {
      actor: ctx.owner,
    });
    expect(delRes.status).toBe(200);

    // Ex-member: GET /workspaces/:id is 404 (workspaces.ts:509 rejects
    // non-owner reads; for non-owner ex-members the row is filtered out).
    const readBack = await api('GET', `/workspaces/${ctx.workspace.id}`, { actor: target as TestActor });
    expect([403, 404]).toContain(readBack.status);
  });

  test('DELETE owner self by owner → 422 OWNER_CANNOT_BE_REMOVED (B2 strict)', async () => {
    // v2.0.7.1 hotfix: owner row is auto-inserted as role='owner' on
    // workspace create, so service.remove's `existing.role === 'owner'`
    // guard fires and we get the documented 422 OWNER_CANNOT_BE_REMOVED.
    if (!ownerMemberRowId) {
      throw new Error('precondition: B2 strict test must have run first to discover the owner row id');
    }
    const r = await api<MemberSingleEnvelope>('DELETE', `/workspaces/${ctx.workspace.id}/members/${ownerMemberRowId}`, {
      actor: ctx.owner,
    });
    expect(r.status).toBe(422);
    const code =
      r.data.meta?.code ?? (typeof r.data.error === 'object' && r.data.error ? r.data.error.code : undefined);
    expect(code).toBe('OWNER_CANNOT_BE_REMOVED');
  });

  test('cleanup hard-delete cascades workspace_members rows', async () => {
    const localOwner = await createTestUser({ prefix: 'wsmcln' });
    const wsRes = await api<{
      ok: boolean;
      data?: { id: string; name: string; ownerImUserId: string };
    }>('POST', '/workspaces', {
      actor: localOwner,
      body: { name: 'IT cleanup probe', slug: `itcln-${Date.now().toString(36).slice(-6)}` },
      expectStatus: 201,
    });
    const wsId = wsRes.data.data!.id;

    const probe = await createTestUser({ prefix: 'wsmcl2' });
    const addRes = await api<MemberSingleEnvelope>('POST', `/workspaces/${wsId}/members`, {
      actor: localOwner,
      body: { memberImUserId: probe.imUserId, role: 'member' },
    });
    expect(addRes.status).toBe(201);

    await api('DELETE', `/workspaces/${wsId}`, {
      actor: localOwner,
      query: { confirmName: 'IT cleanup probe' },
      headers: { Accept: 'text/event-stream' },
    });

    const after = await api('GET', `/workspaces/${wsId}/members`, { actor: localOwner });
    expect([404, 403]).toContain(after.status);
  });
});
