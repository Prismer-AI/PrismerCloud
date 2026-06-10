/**
 * Phase 2G integration — Workspace RBAC matrix.
 *
 * Verifies the workspace-layer permission contract (doc 16 §3.3 +
 * src/im/services/workspace-member.service.ts) by hitting 8 endpoints with
 * 5 actor tiers (owner / admin / member / observer / outsider) and asserting
 * the expected HTTP status code.
 *
 * Matrix:
 *
 *   | Action                                  | owner | admin | member | observer | outsider |
 *   |-----------------------------------------|-------|-------|--------|----------|----------|
 *   | GET    /workspaces/:id                  |  200  |  200  |  200   |   200    |   403/404 |
 *   | GET    /workspaces/:id/members          |  200  |  200  |  200   |   200    |   403/404 |
 *   | POST   /workspaces/:id/members          |  201  |  201  |  403   |   403    |   403    |
 *   | PATCH  /workspaces/:id/members/:uid     |  200  |  200  |  403   |   403    |   403    |
 *   | DELETE /workspaces/:id/members/:uid     |  200  |  200  |  403   |   403    |   403    |
 *   | POST   /workspaces/:id/invites          |  201  |  201  |  403   |   403    |   403    |
 *   | GET    /workspaces/:id/invites          |  200  |  200  |  403   |   403    |   403    |
 *   | DELETE /workspaces/:id (hard, owner-only)|  200  |  403  |  403   |   403    |   403    |
 *
 * NOTE on `outsider` vs in-workspace `403`: anti-enumeration policy returns
 * 404 to non-members on read endpoints (16 §0.2.4); accept either 403 or 404
 * so the test passes whichever the implementation chose, but assert one OR
 * the other rather than letting any 2xx slip through.
 *
 * Bootstrap promotes `member` → 'admin' before running the matrix; that
 * actor variable becomes the admin row, and a fresh `member2` is minted to
 * occupy the plain-member slot.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapSuite, api, createTestUser, type TestActor, type SuiteContext } from '../_helpers';

interface ApiEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: unknown;
  meta?: { code?: string };
}

interface MemberRow {
  id: string;
  workspaceId: string;
  memberImUserId: string;
  role: string;
  joinedAt: string;
}

/** All-or-nothing assertion that an actor saw exactly one of the expected codes. */
function expectStatus(actorLabel: string, action: string, got: number, ...allowed: number[]): void {
  if (!allowed.includes(got)) {
    // Drift report — log so the test summary can capture spec-vs-code mismatch.

    console.error(`[drift] ${actorLabel} ${action} expected one of [${allowed.join(',')}], got ${got}`);
  }
  expect(allowed).toContain(got);
}

describe('workspace-rbac — phase 2G', () => {
  let ctx: SuiteContext;
  let admin: TestActor; // promoted from ctx.member
  let plainMember: TestActor; // a fresh user added at role='member'
  let memberRowIds: { admin: string; plainMember: string; observer: string };

  beforeAll(async () => {
    ctx = await bootstrapSuite('phase2gws');

    // v2.0.7.1 B2 hotfix: POST /workspaces now writes the owner row into
    // im_workspace_members atomically (as role='owner'). No more workaround
    // needed — the owner row exists by the time bootstrapSuite returns.

    // bootstrapSuite seeded `member` + `observer` as 'member'. We promote
    // `member` to 'admin' and treat them as the admin actor in the matrix.
    admin = ctx.member;
    plainMember = await createTestUser({ prefix: 'p2gwsm' });

    // Add plainMember as member.
    const addPlain = await api<ApiEnvelope<MemberRow>>('POST', `/workspaces/${ctx.workspace.id}/members`, {
      actor: ctx.owner,
      body: { memberImUserId: plainMember.imUserId, role: 'member' },
    });
    expect([200, 201]).toContain(addPlain.status);

    // Look up row ids needed for PATCH/DELETE assertions.
    const list = await api<ApiEnvelope<MemberRow[]>>('GET', `/workspaces/${ctx.workspace.id}/members`, {
      actor: ctx.owner,
    });
    expect(list.status).toBe(200);
    const rows = list.data.data ?? [];

    const adminRow = rows.find((r) => r.memberImUserId === admin.imUserId);
    const plainRow = rows.find((r) => r.memberImUserId === plainMember.imUserId);
    const observerRow = rows.find((r) => r.memberImUserId === ctx.observer.imUserId);

    // Promote admin via PATCH role=admin.
    if (adminRow && adminRow.role !== 'admin') {
      const promote = await api<ApiEnvelope<MemberRow>>(
        'PATCH',
        `/workspaces/${ctx.workspace.id}/members/${adminRow.id}`,
        { actor: ctx.owner, body: { role: 'admin' } },
      );
      expect(promote.status).toBe(200);
    } else if (!adminRow) {
      // Bootstrap failed to seed — explicitly add then promote.
      const reAdd = await api<ApiEnvelope<MemberRow>>('POST', `/workspaces/${ctx.workspace.id}/members`, {
        actor: ctx.owner,
        body: { memberImUserId: admin.imUserId, role: 'member' },
      });
      expect([200, 201]).toContain(reAdd.status);
      const row = reAdd.data.data!;
      await api('PATCH', `/workspaces/${ctx.workspace.id}/members/${row.id}`, {
        actor: ctx.owner,
        body: { role: 'admin' },
      });
    }

    // If observer wasn't seeded by bootstrap (best-effort), force-add at role='member'.
    let resolvedObserverRow = observerRow;
    if (!resolvedObserverRow) {
      const addObs = await api<ApiEnvelope<MemberRow>>('POST', `/workspaces/${ctx.workspace.id}/members`, {
        actor: ctx.owner,
        body: { memberImUserId: ctx.observer.imUserId, role: 'member' },
      });
      expect([200, 201]).toContain(addObs.status);
      resolvedObserverRow = addObs.data.data!;
    }

    memberRowIds = {
      admin: adminRow!.id,
      plainMember: plainRow!.id,
      observer: resolvedObserverRow!.id,
    };
  }, 90_000);

  afterAll(async () => {
    // ctx.cleanup uses ctx.owner; that still works even if owner's row was
    // touched by the matrix (we never delete the owner row — the matrix
    // exercises DELETE on plainMember & observer rows only).
    await ctx.cleanup();
  });

  // ── Row 1: GET /workspaces/:id ─────────────────────────────────────────────
  // v2.0.7.1 B9 hotfix: workspaces.ts GET /:id now uses
  // WorkspaceMemberService.isMember instead of ownerImUserId equality, so
  // any workspace member (owner / admin / plain / observer) sees 200.
  // Outsider still gets 404 (anti-enumeration per 16 §0.2.4).
  describe('GET /workspaces/:id', () => {
    const rows: Array<{ label: string; actorKey: keyof MatrixActors; allowed: number[] }> = [
      { label: 'owner', actorKey: 'owner', allowed: [200] },
      { label: 'admin', actorKey: 'admin', allowed: [200] },
      { label: 'plainMember', actorKey: 'plainMember', allowed: [200] },
      { label: 'observer', actorKey: 'observer', allowed: [200] },
      { label: 'outsider', actorKey: 'outsider', allowed: [403, 404] },
    ];
    for (const row of rows) {
      test(`${row.label} → ${row.allowed.join('|')}`, async () => {
        const actors = collectActors();
        const r = await api('GET', `/workspaces/${ctx.workspace.id}`, { actor: actors[row.actorKey] });
        expectStatus(row.label, 'GET /workspaces/:id', r.status, ...row.allowed);
      });
    }
  });

  // ── Row 2: GET /workspaces/:id/members ────────────────────────────────────
  describe('GET /workspaces/:id/members', () => {
    const rows: Array<{ label: string; actorKey: keyof MatrixActors; allowed: number[] }> = [
      { label: 'owner', actorKey: 'owner', allowed: [200] },
      { label: 'admin', actorKey: 'admin', allowed: [200] },
      { label: 'plainMember', actorKey: 'plainMember', allowed: [200] },
      { label: 'observer', actorKey: 'observer', allowed: [200] },
      { label: 'outsider', actorKey: 'outsider', allowed: [403, 404] },
    ];
    for (const row of rows) {
      test(`${row.label} → ${row.allowed.join('|')}`, async () => {
        const actors = collectActors();
        const r = await api('GET', `/workspaces/${ctx.workspace.id}/members`, {
          actor: actors[row.actorKey],
        });
        expectStatus(row.label, 'GET /workspaces/:id/members', r.status, ...row.allowed);
      });
    }
  });

  // ── Row 3: POST /workspaces/:id/members ───────────────────────────────────
  // v2.0.7.1 B10 hotfix: owner + admin can both POST member rows.
  describe('POST /workspaces/:id/members', () => {
    const rows: Array<{ label: string; actorKey: keyof MatrixActors; allowed: number[] }> = [
      { label: 'owner', actorKey: 'owner', allowed: [201] },
      { label: 'admin', actorKey: 'admin', allowed: [201] },
      { label: 'plainMember', actorKey: 'plainMember', allowed: [403] },
      { label: 'observer', actorKey: 'observer', allowed: [403] },
      { label: 'outsider', actorKey: 'outsider', allowed: [403, 404] },
    ];
    for (const row of rows) {
      test(`${row.label} → ${row.allowed.join('|')}`, async () => {
        const actors = collectActors();
        const newcomer = await createTestUser({ prefix: 'pwadd' });
        const r = await api('POST', `/workspaces/${ctx.workspace.id}/members`, {
          actor: actors[row.actorKey],
          body: { memberImUserId: newcomer.imUserId, role: 'member' },
        });
        expectStatus(row.label, 'POST /workspaces/:id/members', r.status, ...row.allowed);
      });
    }
  });

  // ── Row 4: PATCH /workspaces/:id/members/:uid ─────────────────────────────
  // v2.0.7.1 B10 hotfix: owner + admin can both PATCH member roles
  // (admin still can't demote the owner — protected by the
  // OwnerCannotBeRemovedError / cannot-demote-owner guards in the service).
  describe('PATCH /workspaces/:id/members/:uid', () => {
    const rows: Array<{ label: string; actorKey: keyof MatrixActors; allowed: number[] }> = [
      { label: 'owner', actorKey: 'owner', allowed: [200] },
      { label: 'admin', actorKey: 'admin', allowed: [200] },
      { label: 'plainMember', actorKey: 'plainMember', allowed: [403] },
      { label: 'observer', actorKey: 'observer', allowed: [403] },
      { label: 'outsider', actorKey: 'outsider', allowed: [403, 404] },
    ];
    for (const row of rows) {
      test(`${row.label} → ${row.allowed.join('|')}`, async () => {
        const actors = collectActors();
        const r = await api('PATCH', `/workspaces/${ctx.workspace.id}/members/${memberRowIds.plainMember}`, {
          actor: actors[row.actorKey],
          body: { role: 'member' },
        });
        expectStatus(row.label, 'PATCH member role', r.status, ...row.allowed);
      });
    }
  });

  // ── Row 5: DELETE /workspaces/:id/members/:uid ────────────────────────────
  // v2.0.7.1 B10 hotfix: owner + admin can both DELETE member rows
  // (admin still can't remove the owner — OwnerCannotBeRemovedError fires).
  describe('DELETE /workspaces/:id/members/:uid', () => {
    const rows: Array<{ label: string; actorKey: keyof MatrixActors; allowed: number[] }> = [
      { label: 'owner', actorKey: 'owner', allowed: [200] },
      { label: 'admin', actorKey: 'admin', allowed: [200] },
      { label: 'plainMember', actorKey: 'plainMember', allowed: [403] },
      { label: 'observer', actorKey: 'observer', allowed: [403] },
      { label: 'outsider', actorKey: 'outsider', allowed: [403, 404] },
    ];
    for (const row of rows) {
      test(`${row.label} → ${row.allowed.join('|')}`, async () => {
        const actors = collectActors();
        let targetRowId = memberRowIds.observer;
        if (row.allowed.includes(200)) {
          // Mint a sacrificial row owned by ctx.owner so happy-path callers
          // have something to delete.
          const sac = await createTestUser({ prefix: 'pwsac' });
          const addRes = await api<ApiEnvelope<MemberRow>>('POST', `/workspaces/${ctx.workspace.id}/members`, {
            actor: ctx.owner,
            body: { memberImUserId: sac.imUserId, role: 'member' },
          });
          expect(addRes.status).toBe(201);
          targetRowId = addRes.data.data!.id;
        }
        const r = await api('DELETE', `/workspaces/${ctx.workspace.id}/members/${targetRowId}`, {
          actor: actors[row.actorKey],
        });
        expectStatus(row.label, 'DELETE member', r.status, ...row.allowed);
      });
    }
  });

  // ── Row 6: POST /workspaces/:id/invites ───────────────────────────────────
  // Invite role=member; invitee is a fresh imUser per test. Invite service
  // gates at owner+admin per doc 16 §3.3.2.
  describe('POST /workspaces/:id/invites', () => {
    const rows: Array<{ label: string; actorKey: keyof MatrixActors; allowed: number[] }> = [
      { label: 'owner', actorKey: 'owner', allowed: [201] },
      { label: 'admin', actorKey: 'admin', allowed: [201] },
      { label: 'plainMember', actorKey: 'plainMember', allowed: [403] },
      { label: 'observer', actorKey: 'observer', allowed: [403] },
      { label: 'outsider', actorKey: 'outsider', allowed: [403, 404] },
    ];
    for (const row of rows) {
      test(`${row.label} → ${row.allowed.join('|')}`, async () => {
        const actors = collectActors();
        const r = await api('POST', `/workspaces/${ctx.workspace.id}/invites`, {
          actor: actors[row.actorKey],
          body: {
            inviteeEmail: `it-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`,
            role: 'member',
            expiresInDays: 1,
          },
        });
        expectStatus(row.label, 'POST invite', r.status, ...row.allowed);
      });
    }
  });

  // ── Row 7: GET /workspaces/:id/invites ────────────────────────────────────
  // Note: invite-service.list() returns 404 (not 403) to non-owner/admin
  // for anti-enumeration (workspace-invite.service.ts:329-330). We accept
  // 404 alongside 403 for the deny tier.
  describe('GET /workspaces/:id/invites', () => {
    const rows: Array<{ label: string; actorKey: keyof MatrixActors; allowed: number[] }> = [
      { label: 'owner', actorKey: 'owner', allowed: [200] },
      { label: 'admin', actorKey: 'admin', allowed: [200] },
      { label: 'plainMember', actorKey: 'plainMember', allowed: [403, 404] },
      { label: 'observer', actorKey: 'observer', allowed: [403, 404] },
      { label: 'outsider', actorKey: 'outsider', allowed: [403, 404] },
    ];
    for (const row of rows) {
      test(`${row.label} → ${row.allowed.join('|')}`, async () => {
        const actors = collectActors();
        const r = await api('GET', `/workspaces/${ctx.workspace.id}/invites`, {
          actor: actors[row.actorKey],
        });
        expectStatus(row.label, 'GET invites', r.status, ...row.allowed);
      });
    }
  });

  // ── Row 8: DELETE /workspaces/:id (owner-only hard delete) ────────────────
  // The hard-delete endpoint requires `?confirmName=<exact name>` (cef45d0a).
  // We mint a *throwaway* workspace per assertion so the test doesn't
  // disrupt the shared bootstrap workspace.
  describe('DELETE /workspaces/:id (hard delete) — owner-only', () => {
    const rows: Array<{ label: string; actorKey: keyof MatrixActors; allowed: number[] }> = [
      { label: 'owner', actorKey: 'owner', allowed: [200] },
      { label: 'admin', actorKey: 'admin', allowed: [403] },
      { label: 'plainMember', actorKey: 'plainMember', allowed: [403] },
      { label: 'observer', actorKey: 'observer', allowed: [403] },
      { label: 'outsider', actorKey: 'outsider', allowed: [403, 404] },
    ];
    for (const row of rows) {
      test(`${row.label} → ${row.allowed.join('|')}`, async () => {
        // Throwaway workspace owned by ctx.owner so we don't blow up the
        // shared fixture. Add admin + the actor under test as members so
        // the access path mirrors the matrix.
        const wsRes = await api<ApiEnvelope<{ id: string; name: string }>>('POST', '/workspaces', {
          actor: ctx.owner,
          body: {
            name: `IT del-row ${row.label} ${Date.now().toString(36)}`,
            slug: `itdel-${row.label}-${Math.random().toString(36).slice(2, 6)}`,
          },
          expectStatus: 201,
        });
        const ws = wsRes.data.data!;
        // Add admin so admin-tier deny path is exercised.
        await api('POST', `/workspaces/${ws.id}/members`, {
          actor: ctx.owner,
          body: { memberImUserId: admin.imUserId, role: 'member' },
        });
        // Promote admin
        const lst = await api<ApiEnvelope<MemberRow[]>>('GET', `/workspaces/${ws.id}/members`, {
          actor: ctx.owner,
        });
        const adminRow = (lst.data.data ?? []).find((r) => r.memberImUserId === admin.imUserId);
        if (adminRow) {
          await api('PATCH', `/workspaces/${ws.id}/members/${adminRow.id}`, {
            actor: ctx.owner,
            body: { role: 'admin' },
          });
        }

        const actors = collectActors();
        const r = await api('DELETE', `/workspaces/${ws.id}`, {
          actor: actors[row.actorKey],
          query: { confirmName: ws.name },
          headers: { Accept: 'text/event-stream' },
        });
        expectStatus(row.label, 'DELETE workspace', r.status, ...row.allowed);

        // If the actor wasn't the owner, mop up so the test doesn't leak.
        if (!row.allowed.includes(200)) {
          await api('DELETE', `/workspaces/${ws.id}`, {
            actor: ctx.owner,
            query: { confirmName: ws.name },
            headers: { Accept: 'text/event-stream' },
          }).catch(() => undefined);
        }
      });
    }
  });

  // ── release201/19 D3 — PATCH/DELETE accept imUserId in path ───────────────
  // doc 16 §3.3.1 names the path param `:memberId`. v2.0.8 D3 fix:
  // workspace-member.service resolveMemberRowId() resolves the path param
  // as EITHER the row id (legacy) OR the member's imUserId (doc-aligned).
  // Validates that the imUserId form lands on the same row as the row id
  // form and produces the same response shape.
  describe('release201/19 D3 — PATCH/DELETE accepts imUserId path param', () => {
    test('PATCH /workspaces/:id/members/:imUserId — owner can flip role using imUserId', async () => {
      const newcomer = await createTestUser({ prefix: 'd3patch' });
      const add = await api<ApiEnvelope<MemberRow>>('POST', `/workspaces/${ctx.workspace.id}/members`, {
        actor: ctx.owner,
        body: { memberImUserId: newcomer.imUserId, role: 'member' },
      });
      expect(add.status).toBe(201);

      const r = await api<ApiEnvelope<MemberRow>>(
        'PATCH',
        `/workspaces/${ctx.workspace.id}/members/${newcomer.imUserId}`,
        { actor: ctx.owner, body: { role: 'admin' } },
      );
      expect(r.status).toBe(200);
      expect(r.data.data?.role).toBe('admin');
      expect(r.data.data?.memberImUserId).toBe(newcomer.imUserId);
    });

    test('DELETE /workspaces/:id/members/:imUserId — owner can remove using imUserId', async () => {
      const newcomer = await createTestUser({ prefix: 'd3del' });
      const add = await api<ApiEnvelope<MemberRow>>('POST', `/workspaces/${ctx.workspace.id}/members`, {
        actor: ctx.owner,
        body: { memberImUserId: newcomer.imUserId, role: 'member' },
      });
      expect(add.status).toBe(201);

      const r = await api<ApiEnvelope<{ removed: MemberRow }>>(
        'DELETE',
        `/workspaces/${ctx.workspace.id}/members/${newcomer.imUserId}`,
        { actor: ctx.owner },
      );
      expect(r.status).toBe(200);
      expect(r.data.data?.removed.memberImUserId).toBe(newcomer.imUserId);
    });

    test('PATCH /workspaces/:id/members/:imUserId — unknown imUserId → 404 MEMBER_NOT_FOUND', async () => {
      const r = await api<ApiEnvelope<unknown>>(
        'PATCH',
        `/workspaces/${ctx.workspace.id}/members/imUser_does_not_exist_xyz`,
        { actor: ctx.owner, body: { role: 'member' } },
      );
      expect(r.status).toBe(404);
    });
  });

  // ── helpers ────────────────────────────────────────────────────────────────
  interface MatrixActors {
    owner: TestActor;
    admin: TestActor;
    plainMember: TestActor;
    observer: TestActor;
    outsider: TestActor;
  }
  function collectActors(): MatrixActors {
    return {
      owner: ctx.owner,
      admin,
      plainMember,
      observer: ctx.observer,
      outsider: ctx.outsider,
    };
  }
});
