/**
 * Phase 2G integration — Project ACL matrix (doc 09 §5).
 *
 * Verifies project-layer permissions enforced by ProjectService.getEffectiveUserRole
 * + workspace-owner short-circuit (§5.2). Roles:
 *   - workspace-owner   (implicit project owner via short-circuit)
 *   - project-owner     (explicit IMAgentProjectMembership, role='owner')
 *   - contributor       (IMAgentProjectMembership, role='contributor')
 *   - observer          (IMAgentProjectMembership, role='observer')
 *   - workspace-member (no project membership) → effective 'none' (404)
 *   - outsider          (not in workspace)      → 404
 *
 * Tasks:
 *   - POST /tasks with projectId  → contributor / project-owner write OK;
 *                                   observer = 403 (read-only role).
 *
 * Project endpoints under test:
 *   - GET    /projects/:id
 *   - PATCH  /projects/:id              (owner-only)
 *   - DELETE /projects/:id?cascade=archive (owner-only)
 *   - POST   /projects/:id/members      (project-owner only)
 *
 * NOTE: workspace owner is also project owner via short-circuit (09 §5.2);
 * we deliberately split the matrix so a non-workspace-owner project-owner
 * actor is exercised separately — that path tests the explicit membership
 * row rather than the implicit short-circuit.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapSuite, api, createTestUser, type SuiteContext, type TestActor } from '../_helpers';

interface ApiEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: unknown;
}

interface ProjectDTO {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  status: string;
  ownerUserId: string;
}

interface MembershipDTO {
  id: string;
  projectId: string;
  principalKind: string;
  principalId: string;
  role: string;
}

function expectStatus(actorLabel: string, action: string, got: number, ...allowed: number[]): void {
  if (!allowed.includes(got)) {
    console.error(`[drift] ${actorLabel} ${action} expected one of [${allowed.join(',')}], got ${got}`);
  }
  expect(allowed).toContain(got);
}

describe('project-acl — phase 2G', () => {
  let ctx: SuiteContext;
  let project: ProjectDTO;
  // explicit project-owner actor (not the workspace owner — exercises the
  // membership-row path rather than the short-circuit)
  let projectOwner: TestActor;
  let contributor: TestActor;
  let observer: TestActor;
  // workspace member with no project membership — should see 404 on most endpoints
  let unaffiliated: TestActor;

  beforeAll(async () => {
    ctx = await bootstrapSuite('phase2gprj');

    // Create supporting actors. ctx.member, ctx.observer (workspace-members
    // from bootstrap) become contributor + observer respectively. The
    // explicit projectOwner is a fresh user added to the workspace.
    contributor = ctx.member;
    observer = ctx.observer;
    projectOwner = await createTestUser({ prefix: 'p2gpo' });
    unaffiliated = await createTestUser({ prefix: 'p2gpu' });

    // Add projectOwner + unaffiliated as workspace members. (member +
    // observer were best-effort-seeded by bootstrap; we don't re-add them.)
    for (const target of [projectOwner, unaffiliated]) {
      const r = await api('POST', `/workspaces/${ctx.workspace.id}/members`, {
        actor: ctx.owner,
        body: { memberImUserId: target.imUserId, role: 'member' },
      });
      // 201 = newly added; 409 = already a member (idempotent — acceptable)
      expect([200, 201, 409]).toContain(r.status);
    }

    // Create a project owned by ctx.owner (workspace owner) so the
    // workspace-owner short-circuit holds.
    const pRes = await api<ApiEnvelope<ProjectDTO>>('POST', '/projects', {
      actor: ctx.owner,
      body: {
        workspaceId: ctx.workspace.id,
        slug: `p2g-${Math.random().toString(36).slice(2, 8)}`,
        name: 'Phase 2G ACL probe',
      },
      expectStatus: 201,
    });
    project = pRes.data.data!;

    // Add the three explicit project members. projectOwner gets role='owner'
    // (explicit membership), contributor='contributor', observer='observer'.
    for (const [actor, role] of [
      [projectOwner, 'owner'],
      [contributor, 'contributor'],
      [observer, 'observer'],
    ] as const) {
      const r = await api<ApiEnvelope<MembershipDTO>>('POST', `/projects/${project.id}/members`, {
        actor: ctx.owner,
        body: { principalKind: 'user', principalId: actor.imUserId, role },
      });
      expect([200, 201, 409]).toContain(r.status);
    }
  }, 90_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  // ── GET /projects/:id ────────────────────────────────────────────────────
  // Workspace owner short-circuit → owner sees 200. project-owner /
  // contributor / observer have explicit memberships → 200. Workspace
  // member with no project membership → 404 (anti-enumeration, §5.3).
  // Outsider → 404.
  describe('GET /projects/:id', () => {
    const matrix: Array<{ label: string; actorKey: ActorKey; allowed: number[] }> = [
      { label: 'workspace-owner', actorKey: 'wsOwner', allowed: [200] },
      { label: 'project-owner', actorKey: 'projectOwner', allowed: [200] },
      { label: 'contributor', actorKey: 'contributor', allowed: [200] },
      { label: 'observer', actorKey: 'observer', allowed: [200] },
      { label: 'workspace-member-no-project', actorKey: 'unaffiliated', allowed: [404] },
      { label: 'outsider', actorKey: 'outsider', allowed: [404] },
    ];
    for (const row of matrix) {
      test(`${row.label} → ${row.allowed.join('|')}`, async () => {
        const actor = pickActor(row.actorKey);
        const r = await api('GET', `/projects/${project.id}`, { actor });
        expectStatus(row.label, 'GET project', r.status, ...row.allowed);
      });
    }
  });

  // ── POST /tasks with projectId ───────────────────────────────────────────
  // validateProjectWriteScope (task.service.ts:594) requires 'owner' or
  // 'contributor'. Observer is read-only → 403/4xx. Workspace member
  // outside the project → 403/4xx. Outsider → 4xx.
  describe('POST /tasks { projectId }', () => {
    const matrix: Array<{ label: string; actorKey: ActorKey; allowed: number[] }> = [
      { label: 'workspace-owner', actorKey: 'wsOwner', allowed: [200, 201] },
      { label: 'project-owner', actorKey: 'projectOwner', allowed: [200, 201] },
      { label: 'contributor', actorKey: 'contributor', allowed: [200, 201] },
      { label: 'observer', actorKey: 'observer', allowed: [403, 404] },
      { label: 'workspace-member-no-project', actorKey: 'unaffiliated', allowed: [403, 404] },
      { label: 'outsider', actorKey: 'outsider', allowed: [400, 403, 404] },
    ];
    for (const row of matrix) {
      test(`${row.label} → ${row.allowed.join('|')}`, async () => {
        const actor = pickActor(row.actorKey);
        const r = await api('POST', '/tasks', {
          actor,
          body: {
            title: `Phase 2G task probe (${row.label})`,
            workspaceId: ctx.workspace.id,
            projectId: project.id,
          },
        });
        expectStatus(row.label, 'POST task w/ projectId', r.status, ...row.allowed);
      });
    }
  });

  // ── PATCH /projects/:id ──────────────────────────────────────────────────
  // Owner-only (workspace owner via short-circuit OR explicit project-owner).
  describe('PATCH /projects/:id', () => {
    const matrix: Array<{ label: string; actorKey: ActorKey; allowed: number[] }> = [
      { label: 'workspace-owner', actorKey: 'wsOwner', allowed: [200] },
      { label: 'project-owner', actorKey: 'projectOwner', allowed: [200] },
      { label: 'contributor', actorKey: 'contributor', allowed: [403] },
      { label: 'observer', actorKey: 'observer', allowed: [403] },
      { label: 'workspace-member-no-project', actorKey: 'unaffiliated', allowed: [403, 404] },
      { label: 'outsider', actorKey: 'outsider', allowed: [403, 404] },
    ];
    for (const row of matrix) {
      test(`${row.label} → ${row.allowed.join('|')}`, async () => {
        const actor = pickActor(row.actorKey);
        const r = await api('PATCH', `/projects/${project.id}`, {
          actor,
          body: { description: `desc-by-${row.label}-${Date.now()}` },
        });
        expectStatus(row.label, 'PATCH project', r.status, ...row.allowed);
      });
    }
  });

  // ── DELETE /projects/:id (cascade=archive, default) ──────────────────────
  // Each happy-path actor needs its own sacrificial project (since archiving
  // is destructive). Deny-path actors hit the shared project; service should
  // 403/404 before any mutation.
  describe('DELETE /projects/:id?cascade=archive', () => {
    const matrix: Array<{ label: string; actorKey: ActorKey; allowed: number[] }> = [
      { label: 'workspace-owner', actorKey: 'wsOwner', allowed: [200] },
      { label: 'project-owner', actorKey: 'projectOwner', allowed: [200] },
      { label: 'contributor', actorKey: 'contributor', allowed: [403] },
      { label: 'observer', actorKey: 'observer', allowed: [403] },
      { label: 'workspace-member-no-project', actorKey: 'unaffiliated', allowed: [403, 404] },
      { label: 'outsider', actorKey: 'outsider', allowed: [403, 404] },
    ];
    for (const row of matrix) {
      test(`${row.label} → ${row.allowed.join('|')}`, async () => {
        const actor = pickActor(row.actorKey);
        let targetId = project.id;
        if (row.allowed.includes(200)) {
          // Mint a throwaway project owned by ctx.owner for happy-path
          // archive. project-owner case needs the explicit membership too.
          const fresh = await api<ApiEnvelope<ProjectDTO>>('POST', '/projects', {
            actor: ctx.owner,
            body: {
              workspaceId: ctx.workspace.id,
              slug: `p2g-d-${Math.random().toString(36).slice(2, 8)}`,
              name: `Phase 2G archive probe ${row.label}`,
            },
            expectStatus: 201,
          });
          targetId = fresh.data.data!.id;
          if (row.actorKey === 'projectOwner') {
            await api('POST', `/projects/${targetId}/members`, {
              actor: ctx.owner,
              body: { principalKind: 'user', principalId: projectOwner.imUserId, role: 'owner' },
            });
          }
        }
        const r = await api('DELETE', `/projects/${targetId}?cascade=archive`, { actor });
        expectStatus(row.label, 'DELETE project archive', r.status, ...row.allowed);
      });
    }
  });

  // ── POST /projects/:id/members ───────────────────────────────────────────
  // Project-owner only (workspace owner via short-circuit). Adding a fresh
  // user that's been pre-seeded into the workspace satisfies the
  // NOT_WORKSPACE_MEMBER invariant.
  describe('POST /projects/:id/members', () => {
    const matrix: Array<{ label: string; actorKey: ActorKey; allowed: number[] }> = [
      { label: 'workspace-owner', actorKey: 'wsOwner', allowed: [200, 201] },
      { label: 'project-owner', actorKey: 'projectOwner', allowed: [200, 201] },
      { label: 'contributor', actorKey: 'contributor', allowed: [403] },
      { label: 'observer', actorKey: 'observer', allowed: [403] },
      { label: 'workspace-member-no-project', actorKey: 'unaffiliated', allowed: [403, 404] },
      { label: 'outsider', actorKey: 'outsider', allowed: [403, 404] },
    ];
    for (const row of matrix) {
      test(`${row.label} → ${row.allowed.join('|')}`, async () => {
        const actor = pickActor(row.actorKey);
        // Mint + workspace-add the candidate so NOT_WORKSPACE_MEMBER doesn't
        // pre-empt the auth check.
        const candidate = await createTestUser({ prefix: 'p2gcand' });
        const addToWs = await api('POST', `/workspaces/${ctx.workspace.id}/members`, {
          actor: ctx.owner,
          body: { memberImUserId: candidate.imUserId, role: 'member' },
        });
        expect([200, 201, 409]).toContain(addToWs.status);

        const r = await api('POST', `/projects/${project.id}/members`, {
          actor,
          body: { principalKind: 'user', principalId: candidate.imUserId, role: 'contributor' },
        });
        expectStatus(row.label, 'POST project member', r.status, ...row.allowed);
      });
    }
  });

  // ── helpers ──────────────────────────────────────────────────────────────
  type ActorKey = 'wsOwner' | 'projectOwner' | 'contributor' | 'observer' | 'unaffiliated' | 'outsider';
  function pickActor(key: ActorKey): TestActor {
    switch (key) {
      case 'wsOwner':
        return ctx.owner;
      case 'projectOwner':
        return projectOwner;
      case 'contributor':
        return contributor;
      case 'observer':
        return observer;
      case 'unaffiliated':
        return unaffiliated;
      case 'outsider':
        return ctx.outsider;
    }
  }
});
