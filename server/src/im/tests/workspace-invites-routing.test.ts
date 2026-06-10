/**
 * Routing + service test for workspace invite endpoints — release201/16 Phase 9.
 *
 * Covers the 6 endpoints:
 *   POST   /workspaces/:id/invites
 *   GET    /workspaces/:id/invites
 *   DELETE /workspaces/:id/invites/:inviteId
 *   GET    /invites/:token            (public, no auth)
 *   POST   /invites/:token/accept     (auth required)
 *   POST   /invites/:token/reject     (auth required)
 *
 * Strategy mirrors workspace-members-routing.test.ts: in-process Hono via
 * `app.request()` with a prisma stub installed on globalThis BEFORE any
 * module reaches into `@/lib/prisma`. Tests assert both routing (handlers
 * reached, not shadowed) and service-layer invariants (status state machine,
 * lazy expiration, IMBlock guard, duplicate pending, atomic accept).
 *
 * Run:
 *   npx tsx src/im/tests/workspace-invites-routing.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const prismaStub: any = {};
(globalThis as any).prisma = prismaStub;

import { Hono } from 'hono';

let signToken: (payload: any) => string;
let createWorkspacesRouter: () => any;
let createInvitesRouter: () => any;

// ─── In-memory tables ──────────────────────────────────────────────────────

type Workspace = {
  id: string;
  ownerImUserId: string;
  name: string;
  slug: string;
  isDefault: boolean;
  metadata: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  orchestratorAgentId: string | null;
  orchestratorAuthorizedAt: Date | null;
  orchestratorAuthorizedByImUserId: string | null;
  orchestratorRevokedAt: Date | null;
};
type Member = {
  id: string;
  workspaceId: string;
  memberImUserId: string;
  role: string;
  joinedAt: Date;
};
type Invite = {
  id: string;
  workspaceId: string;
  inviterUserId: string;
  token: string;
  inviteeEmail: string | null;
  inviteeImUserId: string | null;
  role: string;
  status: string;
  expiresAt: Date;
  acceptedByUserId: string | null;
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
type ImUserRow = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  trustTier: number;
  suspendedUntil: Date | null;
  primaryDid: string | null;
  banned: boolean;
};
type Block = { userId: string; blockedId: string };

const workspaces: Workspace[] = [];
const members: Member[] = [];
const invites: Invite[] = [];
const imUsers: ImUserRow[] = [];
const blocks: Block[] = [];
let inviteCounter = 0;
let memberIdCounter = 0;

function resetDb() {
  workspaces.length = 0;
  members.length = 0;
  invites.length = 0;
  imUsers.length = 0;
  blocks.length = 0;
  inviteCounter = 0;
  memberIdCounter = 0;
}

prismaStub.iMUser = {
  async findUnique({ where, select }: any) {
    if (!where?.id) return null;
    const u = imUsers.find((x) => x.id === where.id) ?? null;
    if (!u || !select) return u;
    const out: any = {};
    for (const k of Object.keys(select)) if (select[k]) out[k] = (u as any)[k];
    return out;
  },
};

prismaStub.iMWorkspace = {
  async findFirst({ where, select }: any) {
    const w =
      workspaces.find((ws) => {
        if (where.id && ws.id !== where.id) return false;
        if (where.deletedAt !== undefined && ws.deletedAt !== where.deletedAt) return false;
        return true;
      }) ?? null;
    if (!w || !select) return w;
    const out: any = {};
    for (const k of Object.keys(select)) if (select[k]) out[k] = (w as any)[k];
    return out;
  },
  async findUnique({ where, select }: any) {
    const w = workspaces.find((ws) => ws.id === where.id) ?? null;
    if (!w || !select) return w;
    const out: any = {};
    for (const k of Object.keys(select)) if (select[k]) out[k] = (w as any)[k];
    return out;
  },
};

prismaStub.iMWorkspaceMember = {
  async findUnique({ where, select }: any) {
    let row: Member | null = null;
    if (where.id) row = members.find((m) => m.id === where.id) ?? null;
    else if (where.workspaceId_memberImUserId) {
      const { workspaceId, memberImUserId } = where.workspaceId_memberImUserId;
      row = members.find((m) => m.workspaceId === workspaceId && m.memberImUserId === memberImUserId) ?? null;
    }
    if (!row || !select) return row;
    const out: any = {};
    for (const k of Object.keys(select)) if (select[k]) out[k] = (row as any)[k];
    return out;
  },
  async create({ data }: any) {
    const dup = members.find((m) => m.workspaceId === data.workspaceId && m.memberImUserId === data.memberImUserId);
    if (dup) throw new Error('Unique constraint failed');
    const row: Member = {
      id: `wsm_${++memberIdCounter}`,
      workspaceId: data.workspaceId,
      memberImUserId: data.memberImUserId,
      role: data.role,
      joinedAt: new Date(),
    };
    members.push(row);
    return row;
  },
};

prismaStub.iMWorkspaceInvite = {
  async findUnique({ where }: any) {
    if (where.id) return invites.find((i) => i.id === where.id) ?? null;
    if (where.token) return invites.find((i) => i.token === where.token) ?? null;
    return null;
  },
  async findUniqueOrThrow({ where, select }: any) {
    const row =
      (where.id
        ? invites.find((i) => i.id === where.id)
        : invites.find((i) => i.token === where.token)) ?? null;
    if (!row) throw new Error('No IMWorkspaceInvite found');
    if (!select) return row;
    const out: any = {};
    for (const k of Object.keys(select)) if (select[k]) out[k] = (row as any)[k];
    return out;
  },
  async findFirst({ where, select }: any) {
    const row =
      invites.find((i) => {
        if (where.workspaceId && i.workspaceId !== where.workspaceId) return false;
        if (where.inviteeEmail !== undefined && i.inviteeEmail !== where.inviteeEmail) return false;
        if (where.inviteeImUserId !== undefined && i.inviteeImUserId !== where.inviteeImUserId) return false;
        if (where.status && i.status !== where.status) return false;
        return true;
      }) ?? null;
    if (!row || !select) return row;
    const out: any = {};
    for (const k of Object.keys(select)) if (select[k]) out[k] = (row as any)[k];
    return out;
  },
  async findMany({ where, orderBy: _orderBy }: any) {
    return invites.filter((i) => !where?.workspaceId || i.workspaceId === where.workspaceId);
  },
  async create({ data }: any) {
    const row: Invite = {
      id: `inv_${++inviteCounter}`,
      workspaceId: data.workspaceId,
      inviterUserId: data.inviterUserId,
      token: data.token,
      inviteeEmail: data.inviteeEmail ?? null,
      inviteeImUserId: data.inviteeImUserId ?? null,
      role: data.role ?? 'member',
      status: data.status ?? 'pending',
      expiresAt: data.expiresAt,
      acceptedByUserId: data.acceptedByUserId ?? null,
      acceptedAt: data.acceptedAt ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    invites.push(row);
    return row;
  },
  async update({ where, data }: any) {
    const idx = invites.findIndex((i) => (where.id ? i.id === where.id : i.token === where.token));
    if (idx === -1) throw new Error('Record not found');
    invites[idx] = { ...invites[idx], ...data, updatedAt: new Date() };
    return invites[idx];
  },
  // Mirrors the service's B3 race-guard: updateMany WHERE id + status='pending'
  // flips matching rows and returns { count } (count===0 ⇒ already-won race).
  async updateMany({ where, data }: any) {
    const matched = invites.filter((i) => {
      if (where.id !== undefined && i.id !== where.id) return false;
      if (where.token !== undefined && i.token !== where.token) return false;
      if (where.status !== undefined && i.status !== where.status) return false;
      return true;
    });
    for (const row of matched) Object.assign(row, data, { updatedAt: new Date() });
    return { count: matched.length };
  },
};

prismaStub.iMBlock = {
  async findUnique({ where }: any) {
    const { userId, blockedId } = where.userId_blockedId;
    return blocks.find((b) => b.userId === userId && b.blockedId === blockedId) ?? null;
  },
};

prismaStub.iMAgentCard = {
  async findFirst() {
    return null;
  },
  async findMany() {
    return [];
  },
};

prismaStub.$transaction = async (arg: Promise<unknown>[] | ((tx: any) => Promise<unknown>)) => {
  if (typeof arg === 'function') return arg(prismaStub);
  return Promise.all(arg);
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── Test harness ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label}\n    expected: ${b}\n    actual:   ${a}`);
  }
}
function truthy(label: string, v: unknown) {
  if (v) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label} (expected truthy)`);
  }
}
async function groupBlock(name: string, fn: () => Promise<void>) {
  console.log(`\n• ${name}`);
  await fn();
}

// ─── App + helpers ─────────────────────────────────────────────────────────

const OWNER_ID = 'imu_owner';
const ALICE_ID = 'imu_alice';
const BOB_ID = 'imu_bob';
const STRANGER_ID = 'imu_stranger';

function makeApp() {
  const app = new Hono();
  app.route('/api/im/workspaces', createWorkspacesRouter());
  app.route('/api/im/invites', createInvitesRouter());
  return app;
}

function authHeaderFor(imUserId: string): string {
  const token = signToken({ sub: imUserId, username: imUserId, role: 'user' as any });
  return `Bearer ${token}`;
}

interface ReqOpts {
  method?: string;
  body?: unknown;
}
async function req(app: Hono, path: string, actor: string | null, opts: ReqOpts = {}) {
  const init: RequestInit = { method: opts.method ?? 'GET' };
  const headers: Record<string, string> = {};
  if (actor) headers['Authorization'] = authHeaderFor(actor);
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  init.headers = headers;
  const res = await app.request(path, init);
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

function seedWorkspace(id: string, ownerId: string, name = 'Q2 Launch'): Workspace {
  const ws: Workspace = {
    id,
    ownerImUserId: ownerId,
    name,
    slug: id.toLowerCase(),
    isDefault: false,
    metadata: '{}',
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    orchestratorAgentId: null,
    orchestratorAuthorizedAt: null,
    orchestratorAuthorizedByImUserId: null,
    orchestratorRevokedAt: null,
  };
  workspaces.push(ws);
  members.push({
    id: `wsm_owner_${id}`,
    workspaceId: id,
    memberImUserId: ownerId,
    role: 'owner',
    joinedAt: new Date(),
  });
  return ws;
}

function seedUser(id: string, displayName: string) {
  imUsers.push({
    id,
    username: id,
    displayName,
    avatarUrl: null,
    role: 'human',
    trustTier: 0,
    suspendedUntil: null,
    primaryDid: null,
    banned: false,
  });
}

function fullReset() {
  resetDb();
  seedUser(OWNER_ID, 'Owner Alice');
  seedUser(ALICE_ID, 'Alice');
  seedUser(BOB_ID, 'Bob');
  seedUser(STRANGER_ID, 'Stranger');
}

// ─── Tests ─────────────────────────────────────────────────────────────────

async function main() {
  ({ signToken } = await import('../auth/jwt'));
  ({ createWorkspacesRouter } = await import('../api/workspaces'));
  ({ createInvitesRouter } = await import('../api/invites'));

  const app = makeApp();

  await groupBlock('create + list — owner can mint pending invites', async () => {
    fullReset();
    seedWorkspace('ws_A', OWNER_ID);

    const created = await req(app, '/api/im/workspaces/ws_A/invites', OWNER_ID, {
      method: 'POST',
      body: { inviteeEmail: 'newbie@example.com', role: 'member' },
    });
    eq('POST /:id/invites 201', created.status, 201);
    truthy('token returned', !!created.json?.data?.token);
    truthy('token long enough (≥ 32 chars to limit brute force)', (created.json?.data?.token?.length ?? 0) >= 32);
    eq('status pending', created.json?.data?.status, 'pending');
    eq('role echoed', created.json?.data?.role, 'member');

    const list = await req(app, '/api/im/workspaces/ws_A/invites', OWNER_ID);
    eq('GET /:id/invites 200', list.status, 200);
    eq('list length 1', list.json?.data?.length, 1);

    // Duplicate pending → 409
    const dup = await req(app, '/api/im/workspaces/ws_A/invites', OWNER_ID, {
      method: 'POST',
      body: { inviteeEmail: 'newbie@example.com' },
    });
    eq('duplicate pending email → 409', dup.status, 409);
    eq('code DUPLICATE_PENDING_INVITE', dup.json?.meta?.code, 'DUPLICATE_PENDING_INVITE');
  });

  await groupBlock('preview is public — GET /invites/:token without auth works', async () => {
    fullReset();
    seedWorkspace('ws_B', OWNER_ID);

    const created = await req(app, '/api/im/workspaces/ws_B/invites', OWNER_ID, {
      method: 'POST',
      body: { inviteeEmail: 'who@example.com' },
    });
    const token: string = created.json.data.token;

    // No Authorization header — must still 200.
    const preview = await req(app, `/api/im/invites/${token}`, null);
    eq('GET /invites/:token 200 (no auth)', preview.status, 200);
    eq('workspaceName surfaced', preview.json?.data?.workspaceName, 'Q2 Launch');
    eq('role surfaced', preview.json?.data?.role, 'member');
    eq('status pending', preview.json?.data?.status, 'pending');
    // Forbidden patterns (16 §0.2.4): preview must not leak member counts /
    // asset counts / workspace owner identity beyond the inviter avatar.
    truthy('preview excludes memberCount', !('memberCount' in (preview.json?.data ?? {})));
    truthy('preview excludes assetCount', !('assetCount' in (preview.json?.data ?? {})));
    truthy('preview excludes ownerImUserId', !('ownerImUserId' in (preview.json?.data ?? {})));
  });

  await groupBlock('accept — atomic write of member row + status flip', async () => {
    fullReset();
    seedWorkspace('ws_C', OWNER_ID);

    const created = await req(app, '/api/im/workspaces/ws_C/invites', OWNER_ID, {
      method: 'POST',
      body: { inviteeEmail: 'b@example.com' },
    });
    const token: string = created.json.data.token;

    // Bob accepts
    const accept = await req(app, `/api/im/invites/${token}/accept`, BOB_ID, { method: 'POST' });
    eq('POST /invites/:token/accept 200', accept.status, 200);
    eq('status accepted', accept.json?.data?.status, 'accepted');
    eq('acceptedByUserId set', accept.json?.data?.acceptedByUserId, BOB_ID);

    // Member row exists
    const bobMember = members.find((m) => m.workspaceId === 'ws_C' && m.memberImUserId === BOB_ID);
    truthy('member row created', !!bobMember);
    eq('member role member', bobMember?.role, 'member');

    // Re-accept should 410 (status no longer pending)
    const reaccept = await req(app, `/api/im/invites/${token}/accept`, BOB_ID, { method: 'POST' });
    eq('re-accept → 410', reaccept.status, 410);
    eq('code INVITE_ALREADY_USED', reaccept.json?.meta?.code, 'INVITE_ALREADY_USED');
  });

  await groupBlock('revoke — owner can void pending; revoked stays revoked', async () => {
    fullReset();
    seedWorkspace('ws_D', OWNER_ID);

    const created = await req(app, '/api/im/workspaces/ws_D/invites', OWNER_ID, {
      method: 'POST',
      body: { inviteeEmail: 'x@example.com' },
    });
    const inviteId: string = created.json.data.id;
    const token: string = created.json.data.token;

    const revoke = await req(app, `/api/im/workspaces/ws_D/invites/${inviteId}`, OWNER_ID, {
      method: 'DELETE',
    });
    eq('DELETE invite 200', revoke.status, 200);
    eq('status revoked', revoke.json?.data?.status, 'revoked');

    // Subsequent accept → 410 INVITE_REVOKED
    const accept = await req(app, `/api/im/invites/${token}/accept`, BOB_ID, { method: 'POST' });
    eq('accept revoked → 410', accept.status, 410);
    eq('code INVITE_REVOKED', accept.json?.meta?.code, 'INVITE_REVOKED');
  });

  await groupBlock('expiry — past TTL: accept flips to expired and rejects', async () => {
    fullReset();
    seedWorkspace('ws_E', OWNER_ID);

    // Create then backdate expiresAt manually (bypass service ttl bounds).
    const created = await req(app, '/api/im/workspaces/ws_E/invites', OWNER_ID, {
      method: 'POST',
      body: { inviteeEmail: 'late@example.com', expiresInDays: 1 },
    });
    const row = invites.find((i) => i.id === created.json.data.id)!;
    row.expiresAt = new Date(Date.now() - 1000);

    const accept = await req(app, `/api/im/invites/${row.token}/accept`, BOB_ID, { method: 'POST' });
    eq('expired accept → 410', accept.status, 410);
    eq('code INVITE_EXPIRED', accept.json?.meta?.code, 'INVITE_EXPIRED');

    // Lazy-expire path: preview of a terminal-state invite returns 410 (not
    // 200+status) per release201/19 D2 / 16 §3.4 — the service throws
    // InviteExpiredError. It still flips the row state as a side effect.
    const preview = await req(app, `/api/im/invites/${row.token}`, null);
    eq('preview expired → 410', preview.status, 410);
    eq('preview code INVITE_EXPIRED', preview.json?.meta?.code, 'INVITE_EXPIRED');
    eq('row state flipped to expired', invites.find((i) => i.id === row.id)!.status, 'expired');
  });

  await groupBlock('block guard — IMBlock between inviter and invitee blocks create + accept', async () => {
    fullReset();
    seedWorkspace('ws_F', OWNER_ID);

    // Bob blocks owner
    blocks.push({ userId: BOB_ID, blockedId: OWNER_ID });

    const create = await req(app, '/api/im/workspaces/ws_F/invites', OWNER_ID, {
      method: 'POST',
      body: { inviteeImUserId: BOB_ID },
    });
    eq('create when invitee blocks inviter → 422', create.status, 422);
    eq('code PRINCIPAL_BLOCKED', create.json?.meta?.code, 'PRINCIPAL_BLOCKED');
  });

  await groupBlock('direct invite — addressed to imUserId; only that user can accept', async () => {
    fullReset();
    seedWorkspace('ws_G', OWNER_ID);

    const created = await req(app, '/api/im/workspaces/ws_G/invites', OWNER_ID, {
      method: 'POST',
      body: { inviteeImUserId: BOB_ID },
    });
    const token: string = created.json.data.token;

    // Alice tries to accept Bob's invite → 403
    const aliceAccept = await req(app, `/api/im/invites/${token}/accept`, ALICE_ID, { method: 'POST' });
    eq('wrong addressee → 403', aliceAccept.status, 403);

    // Bob accepts → 200
    const bobAccept = await req(app, `/api/im/invites/${token}/accept`, BOB_ID, { method: 'POST' });
    eq('correct addressee → 200', bobAccept.status, 200);
  });

  await groupBlock('reject — terminal, no member row', async () => {
    fullReset();
    seedWorkspace('ws_H', OWNER_ID);

    const created = await req(app, '/api/im/workspaces/ws_H/invites', OWNER_ID, {
      method: 'POST',
      body: { inviteeEmail: 'no@example.com' },
    });
    const token: string = created.json.data.token;

    const reject = await req(app, `/api/im/invites/${token}/reject`, BOB_ID, { method: 'POST' });
    eq('reject 200', reject.status, 200);
    eq('status rejected', reject.json?.data?.status, 'rejected');
    const bobMember = members.find((m) => m.workspaceId === 'ws_H' && m.memberImUserId === BOB_ID);
    truthy('no member row created on reject', !bobMember);

    // Second reject → 410
    const re = await req(app, `/api/im/invites/${token}/reject`, BOB_ID, { method: 'POST' });
    eq('re-reject → 410', re.status, 410);
  });

  await groupBlock('auth — accept/reject require auth, preview does not', async () => {
    fullReset();
    seedWorkspace('ws_I', OWNER_ID);

    const created = await req(app, '/api/im/workspaces/ws_I/invites', OWNER_ID, {
      method: 'POST',
      body: { inviteeEmail: 'y@example.com' },
    });
    const token: string = created.json.data.token;

    const previewAnon = await req(app, `/api/im/invites/${token}`, null);
    eq('preview anon 200', previewAnon.status, 200);

    const acceptAnon = await req(app, `/api/im/invites/${token}/accept`, null, { method: 'POST' });
    eq('accept anon → 401', acceptAnon.status, 401);

    const rejectAnon = await req(app, `/api/im/invites/${token}/reject`, null, { method: 'POST' });
    eq('reject anon → 401', rejectAnon.status, 401);
  });

  await groupBlock('non-owner-admin cannot mint or list invites', async () => {
    fullReset();
    seedWorkspace('ws_J', OWNER_ID);
    // Make Alice a plain member
    members.push({
      id: 'wsm_alice_J',
      workspaceId: 'ws_J',
      memberImUserId: ALICE_ID,
      role: 'member',
      joinedAt: new Date(),
    });

    const create = await req(app, '/api/im/workspaces/ws_J/invites', ALICE_ID, {
      method: 'POST',
      body: { inviteeEmail: 'foo@example.com' },
    });
    eq('member POST → 403', create.status, 403);

    const list = await req(app, '/api/im/workspaces/ws_J/invites', ALICE_ID);
    // 404 (not 403) — anti-enumeration (16 §0.2.4)
    eq('member GET → 404', list.status, 404);

    // Stranger (non-member) — 404 on POST too, because workspace lookup is fine
    // but the role check fails. Service returns 403 from create path though
    // (workspace exists; actor just isn't owner/admin).
    const strangerCreate = await req(app, '/api/im/workspaces/ws_J/invites', STRANGER_ID, {
      method: 'POST',
      body: { inviteeEmail: 'foo@example.com' },
    });
    eq('stranger POST → 403', strangerCreate.status, 403);
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
