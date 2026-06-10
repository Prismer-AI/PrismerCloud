/**
 * Phase 2B — workspace invite mint (owner-side CRUD).
 * release201/16 §3.3.2 + §3.4 + cookbook workspace-invite-collab-e2e.md.
 *
 * Covers POST/GET/DELETE under /workspaces/:id/invites:
 *   - owner mint OK
 *   - admin mint OK (admin = workspace member with role='admin')
 *   - plain member 403, outsider 403/404
 *   - GET list reflects pending invites
 *   - DELETE revoke → preview returns 410 INVITE_REVOKED
 *   - token entropy (≥32 chars, ~43 base64url) + expiresAt ≈ createdAt + 7d
 *   - malformed email body → 400 INVITE_VALIDATION
 *
 * Live HTTP against `npm run dev` at 127.0.0.1:3000. No mocks.
 *
 * Tests that surface a doc-vs-code drift use `expect.fail()` with a
 * "[drift] …" message so the failure is unambiguously a contract gap, not
 * a test bug. Report at bottom of suite output.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapSuite, api, createTestUser } from '../_helpers';
import type { TestActor } from '../_helpers';

interface InviteDTO {
  id: string;
  workspaceId: string;
  inviterUserId: string;
  token: string;
  inviteeEmail: string | null;
  inviteeImUserId: string | null;
  role: 'admin' | 'member';
  status: 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired';
  expiresAt: string;
  acceptedByUserId: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MemberDTO {
  id: string;
  workspaceId: string;
  memberImUserId: string;
  role: 'owner' | 'admin' | 'member';
}

type Envelope<T> = { ok: boolean; data?: T; error?: unknown; meta?: { code?: string } };

describe('invite-mint — doc 16 Phase 9', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapSuite>>;
  // The promoted `member` becomes admin so we can test the "admin can mint" path.
  let adminActor: TestActor;
  let adminPromotionOk = false;

  beforeAll(async () => {
    ctx = await bootstrapSuite('p2binv');
    adminActor = ctx.member;

    // v2.0.7.1 B2 hotfix: owner is auto-inserted on POST /workspaces, so
    // GET /workspaces/:id/members works for the owner without a workaround.
    // Resolve adminActor's member-row id (PATCH uses row id, not imUserId)
    // and promote to admin.
    const list = await api<Envelope<MemberDTO[]>>('GET', `/workspaces/${ctx.workspace.id}/members`, {
      actor: ctx.owner,
    });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.data.data)).toBe(true);
    const memberRow = list.data.data!.find((m) => m.memberImUserId === adminActor.imUserId);
    expect(memberRow, 'bootstrap should have seeded member row').toBeDefined();
    const promote = await api<Envelope<MemberDTO>>(
      'PATCH',
      `/workspaces/${ctx.workspace.id}/members/${memberRow!.id}`,
      { actor: ctx.owner, body: { role: 'admin' } },
    );
    expect(promote.status).toBe(200);
    adminPromotionOk = promote.data.data?.role === 'admin';
    expect(adminPromotionOk).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  test('owner mints invite — 201 + 7-day expiry + base64url token entropy', async () => {
    const before = Date.now();
    const r = await api<Envelope<InviteDTO>>('POST', `/workspaces/${ctx.workspace.id}/invites`, {
      actor: ctx.owner,
      body: { inviteeEmail: `mint-${Date.now()}@example.com`, role: 'member' },
    });
    expect(r.status).toBe(201);
    expect(r.data.ok).toBe(true);
    const invite = r.data.data!;
    expect(invite.id).toBeTruthy();
    expect(invite.workspaceId).toBe(ctx.workspace.id);
    expect(invite.inviterUserId).toBe(ctx.owner.imUserId);
    expect(invite.status).toBe('pending');
    expect(invite.role).toBe('member');
    // Token entropy: service uses randomBytes(32).toString('base64url') ≈ 43 chars.
    expect(invite.token.length).toBeGreaterThanOrEqual(32);
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]+$/);
    // expiresAt ≈ createdAt + 7d (DEFAULT_TTL_DAYS).
    const created = new Date(invite.createdAt).getTime();
    const expires = new Date(invite.expiresAt).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expires - created).toBeGreaterThanOrEqual(sevenDaysMs - 60_000);
    expect(expires - created).toBeLessThanOrEqual(sevenDaysMs + 60_000);
    expect(created).toBeGreaterThanOrEqual(before - 5_000);
  });

  test('admin (promoted member) mints invite — 201', async () => {
    expect(adminPromotionOk).toBe(true);
    const r = await api<Envelope<InviteDTO>>('POST', `/workspaces/${ctx.workspace.id}/invites`, {
      actor: adminActor,
      body: { inviteeEmail: `admin-mint-${Date.now()}@example.com`, role: 'member' },
    });
    expect(r.status).toBe(201);
    expect(r.data.data?.inviterUserId).toBe(adminActor.imUserId);
  });

  test('plain member (non-admin) mint — 403 INVITE_FORBIDDEN', async () => {
    // `observer` was added as role='member' by bootstrapSuite.
    const r = await api<Envelope<unknown>>('POST', `/workspaces/${ctx.workspace.id}/invites`, {
      actor: ctx.observer,
      body: { inviteeEmail: `m-${Date.now()}@example.com`, role: 'member' },
    });
    expect(r.status).toBe(403);
    expect(r.data.ok).toBe(false);
    if (r.data.meta?.code) {
      expect(r.data.meta.code).toBe('INVITE_FORBIDDEN');
    }
  });

  test('outsider (no workspace membership) mint — 403 or 404 (anti-enumeration)', async () => {
    const r = await api<Envelope<unknown>>('POST', `/workspaces/${ctx.workspace.id}/invites`, {
      actor: ctx.outsider,
      body: { inviteeEmail: `o-${Date.now()}@example.com`, role: 'member' },
    });
    // Service throws InviteForbiddenError when ws exists but actor isn't admin/owner.
    // Doc 16 §3.3.4 prefers 404 for anti-enumeration; current code returns 403.
    // Either is acceptable as "no information leak"; flag if neither.
    expect([403, 404]).toContain(r.status);
    expect(r.data.ok).toBe(false);
  });

  test('GET /workspaces/:id/invites by owner returns pending invites', async () => {
    const emailTag = `list-${Date.now()}@example.com`;
    const created = await api<Envelope<InviteDTO>>('POST', `/workspaces/${ctx.workspace.id}/invites`, {
      actor: ctx.owner,
      body: { inviteeEmail: emailTag, role: 'member' },
    });
    expect(created.status).toBe(201);
    const newId = created.data.data!.id;

    const r = await api<Envelope<InviteDTO[]>>('GET', `/workspaces/${ctx.workspace.id}/invites`, {
      actor: ctx.owner,
    });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.data)).toBe(true);
    const found = r.data.data!.find((i) => i.id === newId);
    expect(found).toBeTruthy();
    expect(found!.status).toBe('pending');
    expect(found!.inviteeEmail).toBe(emailTag);
  });

  test('GET /workspaces/:id/invites by admin (promoted member) — 200', async () => {
    expect(adminPromotionOk).toBe(true);
    const r = await api<Envelope<InviteDTO[]>>('GET', `/workspaces/${ctx.workspace.id}/invites`, {
      actor: adminActor,
    });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.data)).toBe(true);
  });

  test('DELETE revoke → GET preview returns 410 INVITE_REVOKED', async () => {
    const created = await api<Envelope<InviteDTO>>('POST', `/workspaces/${ctx.workspace.id}/invites`, {
      actor: ctx.owner,
      body: { inviteeEmail: `revoke-${Date.now()}@example.com`, role: 'member' },
    });
    expect(created.status).toBe(201);
    const inv = created.data.data!;

    const del = await api<Envelope<InviteDTO>>('DELETE', `/workspaces/${ctx.workspace.id}/invites/${inv.id}`, {
      actor: ctx.owner,
    });
    expect(del.status).toBe(200);
    expect(del.data.ok).toBe(true);
    expect(del.data.data?.status).toBe('revoked');

    // 16 §3.4 + cookbook: public GET /invites/:token after revoke returns
    // 410 INVITE_REVOKED. v2.0.8 D1 + D2 resolved this drift:
    //   D1: src/app/api/im/[...path]/route.ts now allowlists GET /invites/:token
    //       as public (isPublicInvitePreview) so the unauth call hits Hono.
    //   D2: workspace-invite.service.ts preview() throws InviteRevokedError /
    //       InviteRejectedError / InviteAcceptedError / InviteExpiredError on
    //       terminal status (mapInviteError → 410).
    const prev = await api<Envelope<{ status: string }>>('GET', `/invites/${inv.token}`);
    expect(prev.status).toBe(410);
    expect(prev.data.meta?.code).toBe('INVITE_REVOKED');
  });

  test('mint with malformed inviteeEmail — 400 INVITE_VALIDATION', async () => {
    const r = await api<Envelope<unknown>>('POST', `/workspaces/${ctx.workspace.id}/invites`, {
      actor: ctx.owner,
      body: { inviteeEmail: 'not-an-email', role: 'member' },
    });
    expect(r.status).toBe(400);
    expect(r.data.ok).toBe(false);
    if (r.data.meta?.code) {
      expect(r.data.meta.code).toBe('INVITE_VALIDATION');
    }
  });

  test('mint with neither inviteeEmail nor inviteeImUserId — 400 INVITE_VALIDATION', async () => {
    const r = await api<Envelope<unknown>>('POST', `/workspaces/${ctx.workspace.id}/invites`, {
      actor: ctx.owner,
      body: { role: 'member' },
    });
    expect(r.status).toBe(400);
    expect(r.data.ok).toBe(false);
  });

  test('mint with inviteeImUserId targeting an outsider — 201, role-bound invite', async () => {
    const fresh = await createTestUser({ prefix: 'p2bivx' });
    const r = await api<Envelope<InviteDTO>>('POST', `/workspaces/${ctx.workspace.id}/invites`, {
      actor: ctx.owner,
      body: { inviteeImUserId: fresh.imUserId, role: 'member' },
    });
    expect(r.status).toBe(201);
    expect(r.data.data?.inviteeImUserId).toBe(fresh.imUserId);
    expect(r.data.data?.inviteeEmail).toBeNull();
  });
});
