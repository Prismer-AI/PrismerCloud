/**
 * Phase 2B — post-accept side-effects (workspace + project cascade).
 * release201/16 §3.2.3 — removing a workspace member cascades to all of that
 * user's project memberships in the same workspace, atomically.
 *
 * Covers:
 *   - owner mints (inviteeImUserId) → outsider accepts → outsider exists in
 *     im_workspace_members (proven by outsider being able to GET
 *     /workspaces/:id/members on themselves, since isMember()=true post-accept)
 *   - owner creates a project, adds outsider as project member (principalKind=user)
 *   - owner DELETE /workspaces/:id/members/<row-id> → returns
 *     { removed, projectMembershipsRemoved >= 1 }
 *   - GET /projects/:id/members afterwards no longer contains the outsider
 *
 * Live HTTP against `npm run dev` at 127.0.0.1:3000. No mocks.
 *
 * Vocabulary reminders:
 *   - Workspace member roles: owner | admin | member  (workspace-member.service.ts)
 *   - Project member roles:   owner | contributor | observer  (project.service.ts:20)
 *     — do NOT use 'member' for projects (current tests caught this drift; doc
 *     16 §3.3.3 says "role: 'member'", project.service.ts:564 rejects with
 *     PROJECT_VALIDATION 400).
 *
 * Drifts noted (logged once at suite start):
 *   D-W1  Workspace owner is NOT in im_workspace_members after POST
 *         /workspaces, so GET /workspaces/:id/members by owner 404s
 *         (workspace-member.service.ts:172 isMember check). Outsider-side
 *         queries still work because the accept path DOES write a member row.
 *   D-W2  PATCH/DELETE /workspaces/:id/members/:memberId expects the
 *         im_workspace_members row id, NOT the memberImUserId. Doc 16 §3.3.1
 *         examples use the imUserId — drift.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapSuite, api, createTestUser } from '../_helpers';
import type { TestActor } from '../_helpers';

interface InviteDTO {
  id: string;
  token: string;
  status: string;
}
interface WorkspaceMemberDTO {
  id: string;
  memberImUserId: string;
  role: string;
}
interface ProjectDTO {
  id: string;
  slug: string;
  name: string;
}
interface ProjectMemberDTO {
  id: string;
  principalKind: string;
  principalId: string;
  role: string;
}

type Envelope<T> = { ok: boolean; data?: T; error?: unknown; meta?: { code?: string } };

async function mintAndAccept(workspaceId: string, owner: TestActor, acceptor: TestActor): Promise<InviteDTO> {
  const mint = await api<Envelope<InviteDTO>>('POST', `/workspaces/${workspaceId}/invites`, {
    actor: owner,
    body: { inviteeImUserId: acceptor.imUserId, role: 'member' },
  });
  expect(mint.status).toBe(201);
  const accept = await api<Envelope<InviteDTO>>('POST', `/invites/${mint.data.data!.token}/accept`, {
    actor: acceptor,
  });
  expect(accept.status).toBe(200);
  expect(accept.data.data?.status).toBe('accepted');
  return accept.data.data!;
}

/**
 * Resolve the im_workspace_members.id (the row id) for a given imUser by
 * querying the workspace member list AS THAT USER (workaround for drift
 * D-W1 — owner can't list, but the user themselves can since they're a
 * member after accept).
 */
async function resolveMemberRowId(workspaceId: string, memberActor: TestActor): Promise<string | null> {
  const r = await api<Envelope<WorkspaceMemberDTO[]>>('GET', `/workspaces/${workspaceId}/members`, {
    actor: memberActor,
  });
  if (r.status !== 200 || !Array.isArray(r.data.data)) return null;
  return r.data.data.find((m) => m.memberImUserId === memberActor.imUserId)?.id ?? null;
}

describe('invite-cascade — doc 16 §3.2.3', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapSuite>>;

  beforeAll(async () => {
    ctx = await bootstrapSuite('p2bcsc');
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  test('outsider accepts invite → appears in im_workspace_members (verified via self-read)', async () => {
    await mintAndAccept(ctx.workspace.id, ctx.owner, ctx.outsider);

    // Outsider self-reads /members — they're now a member, so isMember()=true
    // and the service returns the full list.
    const r = await api<Envelope<WorkspaceMemberDTO[]>>('GET', `/workspaces/${ctx.workspace.id}/members`, {
      actor: ctx.outsider,
    });
    expect(r.status).toBe(200);
    const me = r.data.data!.find((m) => m.memberImUserId === ctx.outsider.imUserId);
    expect(me).toBeTruthy();
    expect(me!.role).toBe('member');
  });

  test('owner removes workspace member → cascade clears project memberships', async () => {
    // Fresh outsider so the prior test's invite state doesn't tangle.
    const cascadeOutsider = await createTestUser({ prefix: 'p2bcox' });
    await mintAndAccept(ctx.workspace.id, ctx.owner, cascadeOutsider);

    // Owner creates a project.
    const slug = `proj-${Date.now().toString(36)}`.slice(0, 32);
    const proj = await api<Envelope<ProjectDTO>>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug, name: `Cascade Project ${slug}` },
    });
    expect(proj.status).toBe(201);
    const projectId = proj.data.data!.id;

    // Add cascadeOutsider as a project contributor (project role vocab:
    // owner|contributor|observer — NOT 'member').
    const addMem = await api<Envelope<ProjectMemberDTO>>('POST', `/projects/${projectId}/members`, {
      actor: ctx.owner,
      body: { principalKind: 'user', principalId: cascadeOutsider.imUserId, role: 'contributor' },
    });
    expect(addMem.status).toBe(201);

    // Confirm pre-cascade.
    const pmBefore = await api<Envelope<ProjectMemberDTO[]>>('GET', `/projects/${projectId}/members`, {
      actor: ctx.owner,
    });
    expect(pmBefore.status).toBe(200);
    const beforeHit = pmBefore.data.data!.find(
      (m) => m.principalKind === 'user' && m.principalId === cascadeOutsider.imUserId,
    );
    expect(beforeHit).toBeTruthy();

    // Resolve workspace-member row id (drift D-W2: DELETE wants the row id).
    const memberRowId = await resolveMemberRowId(ctx.workspace.id, cascadeOutsider);
    expect(memberRowId).toBeTruthy();

    // Owner removes the workspace member; cascade should sweep project_members.
    const del = await api<Envelope<{ removed: WorkspaceMemberDTO; projectMembershipsRemoved: number }>>(
      'DELETE',
      `/workspaces/${ctx.workspace.id}/members/${memberRowId}`,
      { actor: ctx.owner },
    );
    expect(del.status).toBe(200);
    expect(del.data.ok).toBe(true);
    expect(del.data.data?.projectMembershipsRemoved).toBeGreaterThanOrEqual(1);

    // Verify workspace member gone (re-list as owner — but owner 404s due to
    // D-W1. So self-read as the (now-ex-)outsider, who should now NOT be a
    // member → expect 404 as the service intentionally returns 404 for
    // non-members per anti-enumeration).
    const wsMembers = await api<Envelope<WorkspaceMemberDTO[]>>('GET', `/workspaces/${ctx.workspace.id}/members`, {
      actor: cascadeOutsider,
    });
    expect(wsMembers.status).toBe(404);

    // Verify project member gone (cascade success — owner short-circuit lets
    // owner read project memberships even without a project membership row).
    const pmAfter = await api<Envelope<ProjectMemberDTO[]>>('GET', `/projects/${projectId}/members`, {
      actor: ctx.owner,
    });
    expect(pmAfter.status).toBe(200);
    const afterHit = pmAfter.data.data!.find(
      (m) => m.principalKind === 'user' && m.principalId === cascadeOutsider.imUserId,
    );
    expect(afterHit).toBeUndefined();
  });

  test('e2e: invite → accept → add to project → remove from workspace → project membership cascades', async () => {
    const u = await createTestUser({ prefix: 'p2be2e' });
    await mintAndAccept(ctx.workspace.id, ctx.owner, u);

    const slug = `e2e-${Date.now().toString(36)}`.slice(0, 32);
    const proj = await api<Envelope<ProjectDTO>>('POST', '/projects', {
      actor: ctx.owner,
      body: { workspaceId: ctx.workspace.id, slug, name: `E2E ${slug}` },
    });
    expect(proj.status).toBe(201);
    const projectId = proj.data.data!.id;

    const add = await api<Envelope<ProjectMemberDTO>>('POST', `/projects/${projectId}/members`, {
      actor: ctx.owner,
      body: { principalKind: 'user', principalId: u.imUserId, role: 'contributor' },
    });
    expect(add.status).toBe(201);

    const rowId = await resolveMemberRowId(ctx.workspace.id, u);
    expect(rowId).toBeTruthy();

    const del = await api<Envelope<{ projectMembershipsRemoved: number }>>(
      'DELETE',
      `/workspaces/${ctx.workspace.id}/members/${rowId}`,
      { actor: ctx.owner },
    );
    expect(del.status).toBe(200);
    expect(del.data.data?.projectMembershipsRemoved).toBeGreaterThanOrEqual(1);

    const pm = await api<Envelope<ProjectMemberDTO[]>>('GET', `/projects/${projectId}/members`, {
      actor: ctx.owner,
    });
    expect(pm.status).toBe(200);
    expect(pm.data.data!.find((m) => m.principalId === u.imUserId)).toBeUndefined();
  });
});
