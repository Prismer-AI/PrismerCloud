/**
 * Routing test for workspace members endpoints — release201/16 Phase 8 (v2.0.8).
 *
 * Goal: prove that the 4 new endpoints
 *   GET    /workspaces/:id/members
 *   POST   /workspaces/:id/members
 *   PATCH  /workspaces/:id/members/:memberId
 *   DELETE /workspaces/:id/members/:memberId
 * are reachable via Hono's trie router and are NOT shadowed by the
 * neighbouring `/:id/orchestrator`, `/:id/agents`, `/:id` handlers.
 *
 * Strategy:
 *   - In-process Hono via `app.request(url, init)` — no HTTP server.
 *   - Stub `prisma` (same pattern as workspace-member.service.test.ts) to back
 *     both the authMiddleware DB lookups (iMUser.findUnique +
 *     iMWorkspace.findFirst) and the service-layer queries.
 *   - Sign a real JWT with the dev secret so authMiddleware accepts
 *     `Authorization: Bearer ...` and never has to be monkey-patched.
 *
 * Run:
 *   npx tsx src/im/tests/workspace-members-routing.test.ts
 */

// ─── 1) Stub prisma BEFORE anything imports `@/lib/prisma` ──────────────────
// `src/lib/prisma.ts` reads `globalThis.prisma` first and only constructs a
// real client if missing. Setting the global up-front guarantees every module
// in the import chain (db, auth/middleware, services, api/workspaces) shares
// our in-memory stub.

/* eslint-disable @typescript-eslint/no-explicit-any */
const prismaStub: any = {};
(globalThis as any).prisma = prismaStub;

// IMPORTANT: ESM hoists static imports before any code runs, so we must use
// dynamic imports for every module that touches `@/lib/prisma`. By the time
// these awaits resolve, `globalThis.prisma` is already our stub and
// `createPrismaClient()` is never called.
//
// Static imports below are safe — they don't reach into prisma transitively.
import { Hono } from 'hono';

// Filled in by main() after dynamic import. Typed as any to avoid the SDK
// generic dance.
let signToken: (payload: any) => string;
let createWorkspacesRouter: () => any;

// ─── 2) In-memory tables ────────────────────────────────────────────────────

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
type Project = { id: string; workspaceId: string };
type ProjectMembership = {
  id: string;
  projectId: string;
  principalKind: string;
  principalId: string;
  role: string;
  joinedAt: Date;
};
type ImUserRow = {
  id: string;
  role: string;
  trustTier: number;
  suspendedUntil: Date | null;
  primaryDid: string | null;
  banned: boolean;
};

const workspaces: Workspace[] = [];
const members: Member[] = [];
const projects: Project[] = [];
const projectMemberships: ProjectMembership[] = [];
const imUsers: ImUserRow[] = [];
let memberIdCounter = 0;

function resetDb() {
  workspaces.length = 0;
  members.length = 0;
  projects.length = 0;
  projectMemberships.length = 0;
  imUsers.length = 0;
  memberIdCounter = 0;
}

// ─── 3) Bind stub model implementations ─────────────────────────────────────

prismaStub.iMUser = {
  async findUnique({ where }: any) {
    if (!where?.id) return null;
    return imUsers.find((u) => u.id === where.id) ?? null;
  },
};

prismaStub.iMWorkspace = {
  async findFirst({ where }: any) {
    return (
      workspaces.find((w) => {
        if (where.id && w.id !== where.id) return false;
        if (where.ownerImUserId && w.ownerImUserId !== where.ownerImUserId) return false;
        if (where.isDefault !== undefined && w.isDefault !== where.isDefault) return false;
        if (where.deletedAt !== undefined && w.deletedAt !== where.deletedAt) return false;
        return true;
      }) ?? null
    );
  },
  async create({ data }: any) {
    const now = new Date();
    const row: Workspace = {
      id: data.id ?? `ws_${workspaces.length + 1}`,
      ownerImUserId: data.ownerImUserId,
      name: data.name,
      slug: data.slug,
      isDefault: data.isDefault ?? false,
      metadata: typeof data.metadata === 'string' ? data.metadata : '{}',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      orchestratorAgentId: null,
      orchestratorAuthorizedAt: null,
      orchestratorAuthorizedByImUserId: null,
      orchestratorRevokedAt: null,
    };
    workspaces.push(row);
    return row;
  },
};

prismaStub.iMWorkspaceMember = {
  async findUnique({ where }: any) {
    if (where.id) return members.find((m) => m.id === where.id) ?? null;
    if (where.workspaceId_memberImUserId) {
      const { workspaceId, memberImUserId } = where.workspaceId_memberImUserId;
      return members.find((m) => m.workspaceId === workspaceId && m.memberImUserId === memberImUserId) ?? null;
    }
    return null;
  },
  async findFirst({ where }: any) {
    return (
      members.find((m) => {
        if (where.workspaceId && m.workspaceId !== where.workspaceId) return false;
        if (where.memberImUserId && m.memberImUserId !== where.memberImUserId) return false;
        return true;
      }) ?? null
    );
  },
  async findMany({ where }: any) {
    return members.filter((m) => !where?.workspaceId || m.workspaceId === where.workspaceId);
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
  async update({ where, data }: any) {
    const idx = members.findIndex((m) => m.id === where.id);
    if (idx === -1) throw new Error('Record to update not found');
    members[idx] = { ...members[idx], ...data };
    return members[idx];
  },
  async delete({ where }: any) {
    const idx = members.findIndex((m) => m.id === where.id);
    if (idx === -1) throw new Error('Record to delete not found');
    const [removed] = members.splice(idx, 1);
    return removed;
  },
};

prismaStub.iMProject = {
  async findMany({ where }: any) {
    return projects.filter((p) => !where?.workspaceId || p.workspaceId === where.workspaceId);
  },
};

// release201/16 Phase 10 — from-contact endpoint needs IMContactRelation +
// IMBlock stubs. Minimal in-memory tables; only the shapes the service uses.
type ContactRelation = { userId: string; contactId: string };
type Block = { userId: string; blockedId: string };
const contactRelations: ContactRelation[] = [];
const blocks: Block[] = [];

prismaStub.iMContactRelation = {
  async findUnique({ where }: any) {
    if (where.userId_contactId) {
      const { userId, contactId } = where.userId_contactId;
      return contactRelations.find((r) => r.userId === userId && r.contactId === contactId) ?? null;
    }
    return null;
  },
};

prismaStub.iMBlock = {
  async findUnique({ where }: any) {
    if (where.userId_blockedId) {
      const { userId, blockedId } = where.userId_blockedId;
      return blocks.find((b) => b.userId === userId && b.blockedId === blockedId) ?? null;
    }
    return null;
  },
};

prismaStub.iMAgentProjectMembership = {
  async deleteMany({ where }: any) {
    const before = projectMemberships.length;
    for (let i = projectMemberships.length - 1; i >= 0; i--) {
      const m = projectMemberships[i];
      const projectIdMatch =
        where.projectId && typeof where.projectId === 'object' && 'in' in where.projectId
          ? (where.projectId.in as string[]).includes(m.projectId)
          : m.projectId === where.projectId;
      const kindMatch = !where.principalKind || m.principalKind === where.principalKind;
      const idMatch = !where.principalId || m.principalId === where.principalId;
      if (projectIdMatch && kindMatch && idMatch) projectMemberships.splice(i, 1);
    }
    return { count: before - projectMemberships.length };
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

// ─── 4) Test harness ────────────────────────────────────────────────────────

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

// ─── 5) Test app + JWT helpers ──────────────────────────────────────────────

const OWNER_ID = 'imu_owner';
const ALICE_ID = 'imu_alice';
const STRANGER_ID = 'imu_stranger';
const BOB_ID = 'imu_bob';

function makeApp() {
  const app = new Hono();
  app.route('/api/im/workspaces', createWorkspacesRouter());
  return app;
}

function authHeaderFor(imUserId: string): string {
  const token = signToken({ sub: imUserId, username: imUserId, role: 'user' as any });
  return `Bearer ${token}`;
}

interface ReqOpts {
  method?: string;
  body?: unknown;
  // when body === undefined → no Content-Type / no body. when string → sent literally.
  rawBody?: string;
}
async function req(app: Hono, path: string, actor: string | null, opts: ReqOpts = {}) {
  const init: RequestInit = { method: opts.method ?? 'GET' };
  const headers: Record<string, string> = {};
  if (actor) headers['Authorization'] = authHeaderFor(actor);
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  } else if (opts.rawBody !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = opts.rawBody;
  }
  init.headers = headers;
  const res = await app.request(path, init);
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json };
}

function seedWorkspace(id: string, ownerId: string, name = 'Personal'): Workspace {
  const ws: Workspace = {
    id,
    ownerImUserId: ownerId,
    name,
    slug: id.toLowerCase(),
    isDefault: true,
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
  // M444 owner backfill row
  members.push({
    id: `wsm_owner_${id}`,
    workspaceId: id,
    memberImUserId: ownerId,
    role: 'owner',
    joinedAt: new Date(),
  });
  return ws;
}

function seedUser(id: string, role: 'human' | 'agent' = 'human') {
  imUsers.push({ id, role, trustTier: 0, suspendedUntil: null, primaryDid: null, banned: false });
}

function fullReset() {
  resetDb();
  contactRelations.length = 0;
  blocks.length = 0;
  // Always make sure the JWT subjects exist as IMUser rows (authMiddleware checks).
  seedUser(OWNER_ID);
  seedUser(ALICE_ID);
  seedUser(STRANGER_ID);
  seedUser(BOB_ID);
}

// ─── 6) Tests ───────────────────────────────────────────────────────────────

async function main() {
  // Pull the modules NOW — after the prisma stub is installed on globalThis.
  ({ signToken } = await import('../auth/jwt'));
  ({ createWorkspacesRouter } = await import('../api/workspaces'));

  const app = makeApp();

  await groupBlock('routing — members endpoints not shadowed by /:id catch-alls', async () => {
    fullReset();
    seedWorkspace('ws_a', OWNER_ID);

    // GET /:id/members hits members handler (returns array)
    const list = await req(app, '/api/im/workspaces/ws_a/members', OWNER_ID);
    eq('GET .../members 200', list.status, 200);
    truthy('list returns array', Array.isArray(list.json?.data));
    eq('owner row present in list', list.json.data.length, 1);

    // GET /:id/orchestrator still hits orchestrator handler (regression)
    const orch = await req(app, '/api/im/workspaces/ws_a/orchestrator', OWNER_ID);
    eq('GET .../orchestrator 200', orch.status, 200);
    truthy(
      'orchestrator response shape (workspace + orchestrator keys)',
      orch.json?.data && 'workspace' in orch.json.data && 'orchestrator' in orch.json.data,
    );

    // GET /:id (single workspace) — must not be shadowed by /:id/members
    const single = await req(app, '/api/im/workspaces/ws_a', OWNER_ID);
    eq('GET /:id 200', single.status, 200);
    eq('single returns workspace object id', single.json?.data?.id, 'ws_a');

    // GET /:id/agents — must keep working (no shadow)
    const agents = await req(app, '/api/im/workspaces/ws_a/agents', OWNER_ID);
    eq('GET .../agents 200', agents.status, 200);
    truthy('agents returns array', Array.isArray(agents.json?.data));
  });

  await groupBlock('routing — PATCH/DELETE with :memberId reach correct handlers', async () => {
    fullReset();
    seedWorkspace('ws_b', OWNER_ID);

    const created = await req(app, '/api/im/workspaces/ws_b/members', OWNER_ID, {
      method: 'POST',
      body: { memberImUserId: ALICE_ID, role: 'member' },
    });
    eq('POST .../members 201', created.status, 201);
    const memberId: string = created.json.data.id;
    truthy('member id returned', !!memberId);

    const patched = await req(app, `/api/im/workspaces/ws_b/members/${memberId}`, OWNER_ID, {
      method: 'PATCH',
      body: { role: 'admin' },
    });
    eq('PATCH .../members/:memberId 200', patched.status, 200);
    eq('role updated to admin', patched.json?.data?.role, 'admin');

    const removed = await req(app, `/api/im/workspaces/ws_b/members/${memberId}`, OWNER_ID, {
      method: 'DELETE',
    });
    eq('DELETE .../members/:memberId 200', removed.status, 200);
    eq('removed wraps a member dto', removed.json?.data?.removed?.memberImUserId, ALICE_ID);
  });

  await groupBlock('status codes — GET non-member 404; POST non-owner 403', async () => {
    fullReset();
    seedWorkspace('ws_c', OWNER_ID);

    const stranger = await req(app, '/api/im/workspaces/ws_c/members', STRANGER_ID);
    eq('non-member GET 404 (anti-enumeration)', stranger.status, 404);

    const nonOwnerPost = await req(app, '/api/im/workspaces/ws_c/members', STRANGER_ID, {
      method: 'POST',
      body: { memberImUserId: ALICE_ID, role: 'member' },
    });
    eq('non-owner POST 403', nonOwnerPost.status, 403);
  });

  await groupBlock('status codes — PATCH role=owner 400; DELETE owner 422; DELETE phantom 404', async () => {
    fullReset();
    seedWorkspace('ws_d', OWNER_ID);

    const created = await req(app, '/api/im/workspaces/ws_d/members', OWNER_ID, {
      method: 'POST',
      body: { memberImUserId: ALICE_ID, role: 'member' },
    });
    const memberId: string = created.json.data.id;

    const promoteToOwner = await req(app, `/api/im/workspaces/ws_d/members/${memberId}`, OWNER_ID, {
      method: 'PATCH',
      body: { role: 'owner' },
    });
    eq('PATCH role=owner 400', promoteToOwner.status, 400);
    eq('error code WORKSPACE_VALIDATION', promoteToOwner.json?.meta?.code, 'WORKSPACE_VALIDATION');

    // The owner row (M444 backfill) — cannot be deleted
    const ownerRow = members.find((m) => m.workspaceId === 'ws_d' && m.role === 'owner')!;
    const deleteOwner = await req(app, `/api/im/workspaces/ws_d/members/${ownerRow.id}`, OWNER_ID, {
      method: 'DELETE',
    });
    eq('DELETE owner row 422', deleteOwner.status, 422);
    eq('error code OWNER_CANNOT_BE_REMOVED', deleteOwner.json?.meta?.code, 'OWNER_CANNOT_BE_REMOVED');

    const phantom = await req(app, '/api/im/workspaces/ws_d/members/wsm_phantom', OWNER_ID, {
      method: 'DELETE',
    });
    eq('DELETE phantom memberId 404', phantom.status, 404);
    eq('error code MEMBER_NOT_FOUND', phantom.json?.meta?.code, 'MEMBER_NOT_FOUND');
  });

  await groupBlock('cross-workspace isolation', async () => {
    fullReset();
    seedWorkspace('ws_w1', OWNER_ID);
    seedWorkspace('ws_w2', OWNER_ID, 'Other');

    // alice → W1 only
    const add = await req(app, '/api/im/workspaces/ws_w1/members', OWNER_ID, {
      method: 'POST',
      body: { memberImUserId: ALICE_ID, role: 'member' },
    });
    eq('add alice to W1 → 201', add.status, 201);

    const w1List = await req(app, '/api/im/workspaces/ws_w1/members', OWNER_ID);
    const w2List = await req(app, '/api/im/workspaces/ws_w2/members', OWNER_ID);
    eq('W1 sees 2 members (owner + alice)', w1List.json.data.length, 2);
    eq('W2 still only owner', w2List.json.data.length, 1);
    truthy('W2 has no alice row', !w2List.json.data.some((m: any) => m.memberImUserId === ALICE_ID));

    // Also add alice to W2 + seed alice project memberships in both workspaces
    await req(app, '/api/im/workspaces/ws_w2/members', OWNER_ID, {
      method: 'POST',
      body: { memberImUserId: ALICE_ID, role: 'member' },
    });
    projects.push({ id: 'proj_w1_a', workspaceId: 'ws_w1' });
    projects.push({ id: 'proj_w2_a', workspaceId: 'ws_w2' });
    projectMemberships.push({
      id: 'pm_w1',
      projectId: 'proj_w1_a',
      principalKind: 'user',
      principalId: ALICE_ID,
      role: 'contributor',
      joinedAt: new Date(),
    });
    projectMemberships.push({
      id: 'pm_w2',
      projectId: 'proj_w2_a',
      principalKind: 'user',
      principalId: ALICE_ID,
      role: 'contributor',
      joinedAt: new Date(),
    });

    const aliceInW1 = members.find((m) => m.workspaceId === 'ws_w1' && m.memberImUserId === ALICE_ID)!;
    const rm = await req(app, `/api/im/workspaces/ws_w1/members/${aliceInW1.id}`, OWNER_ID, {
      method: 'DELETE',
    });
    eq('remove alice from W1 → 200', rm.status, 200);
    eq('cascade count = 1 (only W1 project)', rm.json?.data?.projectMembershipsRemoved, 1);
    truthy(
      'W1 project membership for alice gone',
      !projectMemberships.find((m) => m.projectId === 'proj_w1_a' && m.principalId === ALICE_ID),
    );
    truthy(
      'W2 project membership for alice preserved',
      !!projectMemberships.find((m) => m.projectId === 'proj_w2_a' && m.principalId === ALICE_ID),
    );
    truthy(
      'W2 alice workspace membership preserved',
      !!members.find((m) => m.workspaceId === 'ws_w2' && m.memberImUserId === ALICE_ID),
    );
  });

  await groupBlock('body defence — POST/PATCH empty / non-object / non-JSON → 400', async () => {
    fullReset();
    seedWorkspace('ws_e', OWNER_ID);

    // POST with no body — Hono c.req.json() throws → handler returns 400
    const noBody = await req(app, '/api/im/workspaces/ws_e/members', OWNER_ID, {
      method: 'POST',
    });
    eq('POST no body → 400', noBody.status, 400);

    // POST with non-JSON body string
    const nonJson = await req(app, '/api/im/workspaces/ws_e/members', OWNER_ID, {
      method: 'POST',
      rawBody: 'not json',
    });
    eq('POST non-JSON → 400', nonJson.status, 400);

    // POST with JSON string body (`"hello"`) — body.memberImUserId is undefined → 400 (validation)
    const stringBody = await req(app, '/api/im/workspaces/ws_e/members', OWNER_ID, {
      method: 'POST',
      body: 'hello',
    });
    eq('POST JSON string body → 400 (validation, not 500)', stringBody.status, 400);

    // POST with null body
    const nullBody = await req(app, '/api/im/workspaces/ws_e/members', OWNER_ID, {
      method: 'POST',
      body: null,
    });
    eq('POST null body → 400 (validation, not 500)', nullBody.status, 400);

    // POST with numeric body
    const numBody = await req(app, '/api/im/workspaces/ws_e/members', OWNER_ID, {
      method: 'POST',
      body: 42,
    });
    eq('POST numeric body → 400 (validation, not 500)', numBody.status, 400);

    // Seed a member to PATCH against
    const created = await req(app, '/api/im/workspaces/ws_e/members', OWNER_ID, {
      method: 'POST',
      body: { memberImUserId: BOB_ID, role: 'member' },
    });
    const memberId: string = created.json.data.id;

    // PATCH with no body
    const patchNoBody = await req(app, `/api/im/workspaces/ws_e/members/${memberId}`, OWNER_ID, {
      method: 'PATCH',
    });
    eq('PATCH no body → 400', patchNoBody.status, 400);

    // PATCH with non-JSON
    const patchNonJson = await req(app, `/api/im/workspaces/ws_e/members/${memberId}`, OWNER_ID, {
      method: 'PATCH',
      rawBody: '???',
    });
    eq('PATCH non-JSON → 400', patchNonJson.status, 400);

    // PATCH with null body
    const patchNull = await req(app, `/api/im/workspaces/ws_e/members/${memberId}`, OWNER_ID, {
      method: 'PATCH',
      body: null,
    });
    eq('PATCH null body → 400 (validation, not 500)', patchNull.status, 400);
  });

  await groupBlock('auth — missing/invalid token → 401', async () => {
    fullReset();
    seedWorkspace('ws_f', OWNER_ID);

    const noAuth = await req(app, '/api/im/workspaces/ws_f/members', null);
    eq('no Authorization header → 401', noAuth.status, 401);
  });

  await groupBlock('from-contact — happy path + idempotency', async () => {
    fullReset();
    seedWorkspace('ws_fc1', OWNER_ID);
    // Owner has alice in contacts.
    contactRelations.push({ userId: OWNER_ID, contactId: ALICE_ID });

    const created = await req(app, `/api/im/workspaces/ws_fc1/members/from-contact?contactId=${ALICE_ID}`, OWNER_ID, {
      method: 'POST',
    });
    eq('add-from-contact → 201', created.status, 201);
    eq('role default member', created.json?.data?.role, 'member');
    eq('memberImUserId echoed', created.json?.data?.memberImUserId, ALICE_ID);

    // Idempotent: calling again returns the existing row, no 409.
    const again = await req(app, `/api/im/workspaces/ws_fc1/members/from-contact?contactId=${ALICE_ID}`, OWNER_ID, {
      method: 'POST',
    });
    eq('idempotent add → 201', again.status, 201);
    eq('returns same member id', again.json?.data?.id, created.json?.data?.id);
  });

  await groupBlock('from-contact — NOT_CONTACT when relation missing', async () => {
    fullReset();
    seedWorkspace('ws_fc2', OWNER_ID);
    // No contactRelations seeded.

    const res = await req(app, `/api/im/workspaces/ws_fc2/members/from-contact?contactId=${ALICE_ID}`, OWNER_ID, {
      method: 'POST',
    });
    eq('add-from-non-contact → 404', res.status, 404);
    eq('code NOT_CONTACT', res.json?.meta?.code, 'NOT_CONTACT');
  });

  await groupBlock('from-contact — PRINCIPAL_BLOCKED when block exists', async () => {
    fullReset();
    seedWorkspace('ws_fc3', OWNER_ID);
    contactRelations.push({ userId: OWNER_ID, contactId: ALICE_ID });
    // Alice has blocked owner.
    blocks.push({ userId: ALICE_ID, blockedId: OWNER_ID });

    const res = await req(app, `/api/im/workspaces/ws_fc3/members/from-contact?contactId=${ALICE_ID}`, OWNER_ID, {
      method: 'POST',
    });
    eq('add-blocked-contact → 422', res.status, 422);
    eq('code PRINCIPAL_BLOCKED', res.json?.meta?.code, 'PRINCIPAL_BLOCKED');
  });

  await groupBlock('from-contact — non-owner-admin gets 403', async () => {
    fullReset();
    seedWorkspace('ws_fc4', OWNER_ID);
    // Stranger has alice in contacts but isn't a workspace owner.
    contactRelations.push({ userId: STRANGER_ID, contactId: ALICE_ID });

    const res = await req(app, `/api/im/workspaces/ws_fc4/members/from-contact?contactId=${ALICE_ID}`, STRANGER_ID, {
      method: 'POST',
    });
    eq('non-owner add-from-contact → 403', res.status, 403);
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
