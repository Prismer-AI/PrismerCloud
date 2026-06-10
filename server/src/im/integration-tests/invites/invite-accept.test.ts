/**
 * Phase 2B — workspace invite accept / reject (invitee-side).
 * release201/16 §3.3.2 (token endpoints) + §0.2.3 (atomic accept).
 *
 * Covers:
 *   - GET /invites/:token (anon, no auth) — preview surface is minimal
 *   - POST /invites/:token/accept — happy path; outsider becomes member
 *   - second accept on same token → 410 INVITE_ALREADY_USED
 *   - POST /invites/:token/reject — terminal; subsequent preview returns 410
 *   - accept after revoke → 410 INVITE_REVOKED
 *   - accept after expired (deferred — no helper backdates expiresAt)
 *   - concurrent accept by two users — exactly one wins (single-use invariant)
 *
 * Live HTTP against `npm run dev` at 127.0.0.1:3000. No mocks.
 *
 * Drift discovered (see invite-mint suite for full inventory):
 *   D-1  Public GET /invites/:token blocked by Next.js shim apiGuard (401)
 *        — Hono mounts the route public, the catch-all proxy doesn't allowlist it.
 *   D-2  preview() doesn't 410 on terminal states (revoked/rejected/expired).
 *   D-3  RESOLVED (v2.0.7.1 hotfix B3): accept() now gates the status flip
 *        with `updateMany WHERE status='pending'` inside $transaction —
 *        concurrent accepts: exactly one wins, the loser sees 410
 *        INVITE_ALREADY_USED. See workspace-invite.service.ts.
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

interface InvitePreview {
  workspaceName: string;
  inviterDisplayName: string;
  inviterAvatar: string | null;
  role: 'admin' | 'member';
  status: 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired';
  expiresAt: string;
}

type Envelope<T> = { ok: boolean; data?: T; error?: unknown; meta?: { code?: string } };

async function mintEmailInvite(workspaceId: string, owner: TestActor, emailTag: string): Promise<InviteDTO> {
  const r = await api<Envelope<InviteDTO>>('POST', `/workspaces/${workspaceId}/invites`, {
    actor: owner,
    body: { inviteeEmail: emailTag, role: 'member' },
  });
  expect(r.status).toBe(201);
  return r.data.data!;
}

describe('invite-accept — doc 16 Phase 9', () => {
  let ctx: Awaited<ReturnType<typeof bootstrapSuite>>;

  beforeAll(async () => {
    ctx = await bootstrapSuite('p2bacc');
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  test('GET /invites/:token — public preview returns minimal safe fields, no auth (16 §3.1.4)', async () => {
    const inv = await mintEmailInvite(ctx.workspace.id, ctx.owner, `prev-${Date.now()}@example.com`);

    // Anonymous (no actor, no Authorization header).
    // v2.0.8 D1 fix: src/app/api/im/[...path]/route.ts allowlists GET
    // /invites/:token (isPublicInvitePreview) so unauth callers reach the
    // Hono router with no Authorization header — 200 + minimal preview.
    const r = await api<Envelope<InvitePreview>>('GET', `/invites/${inv.token}`);
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    const preview = r.data.data!;
    expect(preview.workspaceName).toBe(ctx.workspace.name);
    expect(preview.inviterDisplayName).toBe(ctx.owner.displayName);
    expect(preview.role).toBe('member');
    expect(preview.status).toBe('pending');
    expect(preview.expiresAt).toBeTruthy();
    // §0.2.4 forbidden patterns: never leak owner imUserId / inviter id / counts.
    const exposed = Object.keys(preview);
    expect(exposed).not.toContain('ownerImUserId');
    expect(exposed).not.toContain('inviterUserId');
    expect(exposed).not.toContain('inviterImUserId');
    expect(exposed).not.toContain('memberCount');
    expect(exposed).not.toContain('assetCount');
  });

  test('POST /invites/:token/accept — outsider becomes workspace member', async () => {
    const inv = await mintEmailInvite(ctx.workspace.id, ctx.owner, `acc-${Date.now()}@example.com`);

    // Before accept: outsider can't read the workspace (owner-only GET /:id).
    const before = await api<Envelope<{ id: string }>>('GET', `/workspaces/${ctx.workspace.id}`, {
      actor: ctx.outsider,
    });
    expect(before.status).toBe(404);

    const accept = await api<Envelope<InviteDTO>>('POST', `/invites/${inv.token}/accept`, {
      actor: ctx.outsider,
    });
    expect(accept.status).toBe(200);
    expect(accept.data.ok).toBe(true);
    expect(accept.data.data?.status).toBe('accepted');
    expect(accept.data.data?.acceptedByUserId).toBe(ctx.outsider.imUserId);
    expect(accept.data.data?.acceptedAt).toBeTruthy();

    // Verify the member row was written. GET /workspaces/:id/members must
    // succeed for the outsider (the just-added member). Note this is the
    // same endpoint that 404s for owners in the mint suite — but the
    // outsider IS in im_workspace_members after accept, so isMember()=true.
    const members = await api<Envelope<Array<{ memberImUserId: string }>>>(
      'GET',
      `/workspaces/${ctx.workspace.id}/members`,
      { actor: ctx.outsider },
    );
    expect(members.status).toBe(200);
    const found = members.data.data!.find((m) => m.memberImUserId === ctx.outsider.imUserId);
    expect(found).toBeTruthy();
  });

  test('second accept on same token — 410 INVITE_ALREADY_USED', async () => {
    const inv = await mintEmailInvite(ctx.workspace.id, ctx.owner, `dup-${Date.now()}@example.com`);
    const u1 = await createTestUser({ prefix: 'p2baccu1' });

    const a1 = await api<Envelope<InviteDTO>>('POST', `/invites/${inv.token}/accept`, { actor: u1 });
    expect(a1.status).toBe(200);
    expect(a1.data.data?.status).toBe('accepted');

    const u2 = await createTestUser({ prefix: 'p2baccu2' });
    const a2 = await api<Envelope<unknown>>('POST', `/invites/${inv.token}/accept`, { actor: u2 });
    expect(a2.status).toBe(410);
    expect(a2.data.ok).toBe(false);
    expect(a2.data.meta?.code).toBe('INVITE_ALREADY_USED');
  });

  test('POST /invites/:token/reject — terminal; subsequent preview returns 410 INVITE_REJECTED', async () => {
    const inv = await mintEmailInvite(ctx.workspace.id, ctx.owner, `rej-${Date.now()}@example.com`);
    const u = await createTestUser({ prefix: 'p2brej' });

    const rej = await api<Envelope<InviteDTO>>('POST', `/invites/${inv.token}/reject`, { actor: u });
    expect(rej.status).toBe(200);
    expect(rej.data.data?.status).toBe('rejected');

    // v2.0.8 D2 fix: workspace-invite.service preview() throws
    // InviteRejectedError (410) on terminal status.
    const prev = await api<Envelope<InvitePreview>>('GET', `/invites/${inv.token}`);
    expect(prev.status).toBe(410);
    expect(prev.data.meta?.code).toBe('INVITE_REJECTED');
  });

  test('accept after revoke — 410 INVITE_REVOKED', async () => {
    const inv = await mintEmailInvite(ctx.workspace.id, ctx.owner, `revacc-${Date.now()}@example.com`);
    const del = await api<Envelope<InviteDTO>>('DELETE', `/workspaces/${ctx.workspace.id}/invites/${inv.id}`, {
      actor: ctx.owner,
    });
    expect(del.status).toBe(200);

    const u = await createTestUser({ prefix: 'p2brevacc' });
    const acc = await api<Envelope<unknown>>('POST', `/invites/${inv.token}/accept`, { actor: u });
    expect(acc.status).toBe(410);
    expect(acc.data.meta?.code).toBe('INVITE_REVOKED');
  });

  test('accept after expired — deferred (harness cannot backdate expiresAt)', () => {
    // workspace-invites-routing.test.ts already proves lazy-expiry against a
    // stub prisma. The live harness has no public endpoint to set expiresAt
    // and no direct-DB write hook. Tracked here as an explicit deferral,
    // not a silent skip.
    expect(true).toBe(true);
  });

  test('concurrent accept by two users — exactly one wins (single-use invariant)', async () => {
    // v2.0.7.1 hotfix B3: accept() gates the status flip on
    // `updateMany WHERE status='pending'` inside $transaction. Two parallel
    // accepts on the same token now resolve to exactly one 200 + one 410.
    const inv = await mintEmailInvite(ctx.workspace.id, ctx.owner, `race-${Date.now()}@example.com`);
    const u1 = await createTestUser({ prefix: 'p2bracea' });
    const u2 = await createTestUser({ prefix: 'p2braceb' });

    const [r1, r2] = await Promise.all([
      api<Envelope<InviteDTO>>('POST', `/invites/${inv.token}/accept`, { actor: u1 }),
      api<Envelope<InviteDTO>>('POST', `/invites/${inv.token}/accept`, { actor: u2 }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 410]);

    const winner = r1.status === 200 ? r1 : r2;
    expect(winner.data.ok).toBe(true);
    expect(winner.data.data?.status).toBe('accepted');

    const loser = r1.status === 410 ? r1 : r2;
    expect(loser.data.ok).toBe(false);
    expect(loser.data.meta?.code).toBe('INVITE_ALREADY_USED');
  });
});
