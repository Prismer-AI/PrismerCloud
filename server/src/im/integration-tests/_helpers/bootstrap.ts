/**
 * Test fixture bootstrap — creates real users + workspaces against the live IM
 * server. No mocking, no Prisma direct writes.
 *
 * Endpoint choices (verified live against v2.0.7):
 *   - POST /api/im/register   (the public, optional-auth path mounted at /
 *                             in routes.ts). Returns { token, imUserId, ... }.
 *                             Login fallback is via /api/im/users/login.
 *   - POST /api/im/workspaces (auth required; returns { id, ownerImUserId, ... }).
 *
 * Each suite gets its own (owner, member, observer, outsider) actor set so
 * parallel suite execution cannot collide on usernames; we mix a per-process
 * suite counter into the username slug.
 */

import { api, IntegrationError } from './http';
import { deleteTestWorkspace } from './cleanup';

export interface TestActor {
  imUserId: string;
  token: string;
  username: string;
  displayName: string;
  role: 'human' | 'agent';
}

export interface TestWorkspace {
  id: string;
  ownerImUserId: string;
  name: string;
  slug: string;
}

export interface SuiteContext {
  workspace: TestWorkspace;
  owner: TestActor;
  member: TestActor;
  observer: TestActor;
  outsider: TestActor;
  cleanup: () => Promise<void>;
}

let suiteCounter = 0;
function uniqSlug(prefix: string): string {
  suiteCounter += 1;
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  // Keep ≤ 32 chars (im_users.username regex: [a-z0-9_-]{3,32}).
  return `${prefix}_${t}_${suiteCounter}_${r}`.slice(0, 32);
}

interface RegisterResult {
  imUserId: string;
  username: string;
  displayName: string;
  role: 'human' | 'agent';
  token: string;
}

interface RegisterEnvelope {
  ok: boolean;
  data?: RegisterResult;
  error?: unknown;
}

/**
 * Create one test user. Defaults to a human registration; pass `role: 'agent'`
 * to mint an agent (requires agentType).
 *
 * Falls back to /users/login when register returns 409 (username taken). That
 * shouldn't normally happen with uniqSlug, but is useful when a test suite
 * deliberately reuses a fixed username across runs.
 */
export async function createTestUser(opts: {
  prefix: string;
  role?: 'human' | 'agent';
  agentType?: 'assistant' | 'specialist' | 'orchestrator' | 'tool' | 'bot';
  displayName?: string;
}): Promise<TestActor> {
  const role = opts.role ?? 'human';
  const username = uniqSlug(opts.prefix);
  const displayName = opts.displayName ?? `IT ${opts.prefix} ${username.slice(-6)}`;

  const reqBody: Record<string, unknown> = {
    type: role,
    username,
    displayName,
  };
  if (role === 'agent') {
    reqBody.agentType = opts.agentType ?? 'assistant';
  }

  const res = await api<RegisterEnvelope>('POST', '/register', { body: reqBody });
  if ((res.status === 200 || res.status === 201) && res.data?.ok && res.data.data) {
    const d = res.data.data;
    return {
      imUserId: d.imUserId,
      token: d.token,
      username: d.username,
      displayName: d.displayName,
      role: d.role,
    };
  }

  // Fallback: username taken → try login (works when username is reused
  // intentionally across runs; password-less human/agent rows accept login
  // with just the username, see src/im/api/users.ts login handler).
  if (res.status === 409) {
    const login = await api<{
      ok: boolean;
      data?: { user: { id: string; username: string; displayName: string; role: 'human' | 'agent' }; token: string };
    }>('POST', '/users/login', { body: { username } });
    if (login.status === 200 && login.data?.ok && login.data.data) {
      const u = login.data.data.user;
      return {
        imUserId: u.id,
        token: login.data.data.token,
        username: u.username,
        displayName: u.displayName,
        role: u.role,
      };
    }
  }

  throw new IntegrationError({
    method: 'POST',
    url: '/api/im/register',
    status: res.status,
    expected: 201,
    body: res.data,
  });
}

/**
 * Create a workspace owned by `owner`. Note that registering a human via
 * /api/im/register auto-creates a default workspace for them — this helper
 * creates an *additional* non-default workspace which becomes the
 * suite-scoped sandbox. That keeps the default workspace clean for any
 * cross-test "ensure default exists" assertions.
 */
export async function createTestWorkspace(
  owner: TestActor,
  opts: { name?: string; slug?: string } = {},
): Promise<TestWorkspace> {
  const slug = opts.slug ?? uniqSlug('itws').toLowerCase().replace(/_/g, '-').slice(0, 32);
  const name = opts.name ?? `IT WS ${slug}`;
  const res = await api<{ ok: boolean; data?: { id: string; ownerImUserId: string; name: string; slug: string } }>(
    'POST',
    '/workspaces',
    {
      actor: owner,
      body: { name, slug },
      expectStatus: 201,
    },
  );
  const ws = res.data.data!;
  return { id: ws.id, ownerImUserId: ws.ownerImUserId, name: ws.name, slug: ws.slug };
}

/**
 * Standard 4-actor suite: owner + 2 in-workspace members + 1 outsider.
 *
 * The two members are added via POST /workspaces/:id/members. Failures there
 * are non-fatal (older deployments may not have the endpoint mounted yet —
 * see release201/16 Phase 8); the actors are still returned so a suite can
 * exercise member-add itself.
 */
export async function bootstrapSuite(suiteName: string): Promise<SuiteContext> {
  const safePrefix =
    suiteName
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 8)
      .toLowerCase() || 'suite';

  const owner = await createTestUser({ prefix: `${safePrefix}o` });
  const member = await createTestUser({ prefix: `${safePrefix}m` });
  const observer = await createTestUser({ prefix: `${safePrefix}v` });
  const outsider = await createTestUser({ prefix: `${safePrefix}x` });

  const workspace = await createTestWorkspace(owner, { name: `IT ${suiteName}` });

  // Best-effort member add — keep going if the endpoint shape evolves.
  for (const [actor, role] of [
    [member, 'member'],
    [observer, 'member'],
  ] as const) {
    try {
      await api('POST', `/workspaces/${workspace.id}/members`, {
        actor: owner,
        body: { memberImUserId: actor.imUserId, role },
      });
    } catch {
      // Ignore — suite-specific tests can re-attempt with explicit assertions.
    }
  }

  const cleanup = async () => {
    await deleteTestWorkspace(workspace.id, owner).catch(() => undefined);
  };

  return { workspace, owner, member, observer, outsider, cleanup };
}
