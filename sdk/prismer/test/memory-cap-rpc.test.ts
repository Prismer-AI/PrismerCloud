// spec16 §8.1 MA-0S — cap v1 fail-closed (M-CAP-001).
//
// The previous enforce-off-by-default branch (PRISMER_MEMORY_CAP_ENFORCE,
// doc 08 §2.4 "one release cycle") is DELETED: agent Memory read/write RPC
// with a missing, expired, tampered, forged or wrong-workspace cap is always
// denied. Error codes (spec16 §13.4): missing cap → 401
// `memory_cap_required`; invalid cap (expired / bad signature / tampered
// payload) → 401 `memory_cap_invalid`; a workspace mismatch at the CAP layer
// (request workspaceId ≠ the verified cap's own ws claim, incl. wildcard
// claims) → 401 `memory_cap_invalid` — the old 403
// `memory_ws_scope_violation` is retired (there is no non-cap ws-scope
// guard). The acting identity is ALWAYS the verified cap subject — body/
// query actor fields are never trusted. AccessVersion is Task 10 — NOT
// tested here (v1 wire shape is frozen).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import {
  mintCap,
  mintCapV2,
  mintSystemCap,
  verifyCap,
  registerMemoryAuthoritySnapshot,
  invalidateMemoryAuthoritySnapshot,
  computeMemoryAuthoritySnapshotHash,
  wildcardScopeRequiresSystemSub,
  capWsClaimMatchesScope,
  __resetCapKeyForTest,
} from '../src/daemon/memory/cap.js';
import { buildMemoryToolImpls } from '../src/adapters/memory-tools.js';

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';

const baseState: LocalServerState = {
  daemonId: 'dev_x',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

beforeEach(async () => {
  delete process.env.PRISMER_MEMORY_CAP;
  delete process.env.PRISMER_MEMORY_CAP_ENFORCE;
  __resetCapKeyForTest();
  const dir = mkdtempSync(join(tmpdir(), 'prismer-cap-rpc-'));
  cleanupDirs.push(dir);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  server = new LocalServer({
    port: 0, // ephemeral — read the real port back after start (O16-b)
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime }),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);
});

afterEach(async () => {
  await server?.stop();
  runtime?.closeAll();
  delete process.env.PRISMER_MEMORY_CAP;
  delete process.env.PRISMER_MEMORY_CAP_ENFORCE;
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

const CAP_HEADER = 'x-prismer-memory-cap';

async function get(path: string, cap?: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: cap ? { [CAP_HEADER]: cap } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path: string, body: unknown, cap?: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cap ? { [CAP_HEADER]: cap } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const writeBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  workspaceId: 'ws_a',
  path: 'INDEX.md',
  content: '# index',
  pageType: 'hub',
  title: 'Index',
  actorImUserId: 'im_alice',
  actorKind: 'human',
  ...overrides,
});

/** Tamper the SIGNATURE (one char flip) without touching the payload. */
function flipSigChar(token: string): string {
  return token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
}

/** Tamper the PAYLOAD (re-scope to another ws) but keep the original signature
 *  — the "篡改 payload 不重签" negative control (a re-sign is impossible
 *  without the daemon's per-boot key, which is the security property itself). */
function reScopePayload(token: string, ws: string): string {
  const [v, payloadB64, sig] = token.split('.');
  const payload = JSON.parse(
    Buffer.from(payloadB64!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
  ) as Record<string, unknown>;
  payload.ws = ws;
  payload.scope = [`ws:${ws}`];
  const forged = Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${v}.${forged}.${sig}`;
}

describe('memory RPC cap fail-closed (spec16 §8.1 MA-0S)', () => {
  it('refreshes an expired signed v2 cap through current authority and rejects after revocation', async () => {
    const now = Date.now();
    const snapshotBody = {
      schemaVersion: 1 as const,
      workspaceId: 'ws_a',
      daemonId: 'dev_x',
      replicaMode: 'strict' as const,
      minRuntimeVersion: '2.2.12',
      requiredRuntimeCapabilities: [
        'memory-authority-snapshot-v1' as const,
        'memory-replica-manifest-v1' as const,
        'memory-replica-content-v1' as const,
      ],
      accessVersion: 1,
      replicaSubjectHash: 'subject-v1',
      issuedAt: new Date(now - 20 * 60_000).toISOString(),
      validUntil: new Date(now + 40 * 60_000).toISOString(),
      actors: [
        {
          actorId: 'im_alice',
          actorKind: 'agent' as const,
          principalKind: 'human' as const,
          principalId: 'human_alice',
          authority: 'specialist' as const,
          roleSlugs: [],
          taskIds: [],
          councilIds: [],
          canCurate: false,
          canReplicate: true,
        },
      ],
    };
    const snapshot = {
      ...snapshotBody,
      snapshotHash: computeMemoryAuthoritySnapshotHash(snapshotBody),
    };
    expect(registerMemoryAuthoritySnapshot(snapshot, 'dev_x', now)).toBe(true);
    const expired = mintCapV2('im_alice', 'ws_a', { now: now - 16 * 60_000 })!;
    expect(verifyCap(expired, now)).toBeNull();

    const refreshed = await post('/local/memory/cap/refresh', {}, expired);

    expect(refreshed.status).toBe(200);
    const refreshedToken = (refreshed.body as { cap: string }).cap;
    expect(verifyCap(refreshedToken, now)).toMatchObject({ sub: 'im_alice', ws: 'ws_a', ver: 2 });

    invalidateMemoryAuthoritySnapshot('ws_a');
    const revoked = await post('/local/memory/cap/refresh', {}, expired);
    expect(revoked.status).toBe(401);
    expect(revoked.body).toEqual({ error: 'memory_cap_invalid' });
  });

  it('shared native tool client renews an expired cap once, retries the read, and stays fail-closed after revocation', async () => {
    const now = Date.now();
    const snapshotBody = {
      schemaVersion: 1 as const,
      workspaceId: 'ws_a',
      daemonId: 'dev_x',
      replicaMode: 'strict' as const,
      minRuntimeVersion: '2.2.12',
      requiredRuntimeCapabilities: [
        'memory-authority-snapshot-v1' as const,
        'memory-replica-manifest-v1' as const,
        'memory-replica-content-v1' as const,
      ],
      accessVersion: 1,
      replicaSubjectHash: 'tool-refresh-subject-v1',
      issuedAt: new Date(now - 20 * 60_000).toISOString(),
      validUntil: new Date(now + 40 * 60_000).toISOString(),
      actors: [
        {
          actorId: 'im_alice',
          actorKind: 'agent' as const,
          principalKind: 'human' as const,
          principalId: 'human_alice',
          authority: 'specialist' as const,
          roleSlugs: [],
          taskIds: [],
          councilIds: [],
          canCurate: false,
          canReplicate: true,
        },
      ],
    };
    expect(
      registerMemoryAuthoritySnapshot(
        { ...snapshotBody, snapshotHash: computeMemoryAuthoritySnapshotHash(snapshotBody) },
        'dev_x',
        now,
      ),
    ).toBe(true);
    const fresh = mintCapV2('im_alice', 'ws_a', { now })!;
    const expired = mintCapV2('im_alice', 'ws_a', { now: now - 16 * 60_000 })!;
    expect(verifyCap(expired, now)).toBeNull();
    expect(
      (await post('/local/memory/write', writeBody({ path: 'renewed.md', content: 'renewed read' }), fresh)).status,
    ).toBe(200);

    const tools = buildMemoryToolImpls({ daemonUrl: baseUrl, workspaceId: 'ws_a', cap: expired });
    await expect(tools.load({ workspaceId: 'ws_a', path: 'renewed.md' })).resolves.toMatchObject({
      content: 'renewed read',
    });

    invalidateMemoryAuthoritySnapshot('ws_a');
    const revokedTools = buildMemoryToolImpls({ daemonUrl: baseUrl, workspaceId: 'ws_a', cap: expired });
    await expect(revokedTools.load({ workspaceId: 'ws_a', path: 'renewed.md' })).rejects.toThrow(/HTTP 401/);
  });

  it('no cap read → 401 memory_cap_required (was 200 behave-as-today)', async () => {
    const r = await get('/local/memory/list?workspaceId=ws_a');
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe('memory_cap_required');
  });

  it('no cap write → 401 memory_cap_required', async () => {
    const r = await post('/local/memory/write', writeBody({ path: 'a.md', content: 'hi' }));
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe('memory_cap_required');
  });

  it('no cap → 401 memory_cap_required on every read surface', async () => {
    const reads = [
      '/local/memory/stats?workspaceId=ws_a',
      '/local/memory/list?workspaceId=ws_a',
      '/local/memory/conflicts?workspaceId=ws_a',
      '/local/memory/health?workspaceId=ws_a',
      '/local/memory/search?workspaceId=ws_a&q=x',
      '/local/memory/place-context?workspaceId=ws_a',
      '/local/memory/load?workspaceId=ws_a&path=x.md',
      '/local/memory/recall/manifest?workspaceId=ws_a&q=x',
    ];
    for (const p of reads) {
      const r = await get(p);
      expect(r.status, `no-cap read ${p}`).toBe(401);
      expect((r.body as { error: string }).error, p).toBe('memory_cap_required');
    }
  });

  it('no cap → 401 memory_cap_required on every write surface', async () => {
    const writes: Array<[string, unknown]> = [
      ['/local/memory/write', writeBody()],
      ['/local/memory/flush', { workspaceId: 'ws_a' }],
      ['/local/memory/invalidate', { workspaceId: 'ws_a', pageIds: [] }],
      ['/local/memory/mirror', { workspaceId: 'ws_a', action: 'add', target: 't', content: 'c' }],
      ['/local/memory/observability/emit', { eventType: 'recall_pull', workspaceId: 'ws_a' }],
      ['/local/memory/curate', { workspaceId: 'ws_a', op: 'rebuild_index' }],
      ['/local/memory/recall/finalize', { workspaceId: 'ws_a', paths: [] }],
    ];
    for (const [p, b] of writes) {
      const r = await post(p, b);
      expect(r.status, p).toBe(401);
      expect((r.body as { error: string }).error, p).toBe('memory_cap_required');
    }
  });

  it('invalid cap (garbage token) → 401 memory_cap_invalid', async () => {
    const r = await get('/local/memory/list?workspaceId=ws_a', 'v1.garbage.sig');
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe('memory_cap_invalid');
  });

  it('expired cap → 401 memory_cap_invalid', async () => {
    const cap = mintCap('im_alice', 'ws_a', { now: Date.now() - 60_000, ttlMs: 1_000 });
    const r = await get('/local/memory/list?workspaceId=ws_a', cap);
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe('memory_cap_invalid');
  });

  it('tampered signature (forged sig, valid payload) → 401 memory_cap_invalid', async () => {
    const cap = flipSigChar(mintCap('im_alice', 'ws_a'));
    const r = await get('/local/memory/list?workspaceId=ws_a', cap);
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe('memory_cap_invalid');
  });

  it('tampered payload (re-scoped ws_a→ws_b, original sig) → 401 memory_cap_invalid', async () => {
    const cap = reScopePayload(mintCap('im_alice', 'ws_a'), 'ws_b');
    const r = await get('/local/memory/list?workspaceId=ws_b', cap);
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe('memory_cap_invalid');
  });

  it('PRISMER_MEMORY_CAP_ENFORCE is dead: setting it false does NOT reopen the no-cap bypass', async () => {
    process.env.PRISMER_MEMORY_CAP_ENFORCE = 'false';
    const r = await get('/local/memory/list?workspaceId=ws_a');
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe('memory_cap_required');
  });

  it('cross-ws load: cap{ws:A} → load?workspaceId=B → 401 cap-layer ws mismatch', async () => {
    const cap = mintCap('im_alice', 'ws_a');
    const r = await get('/local/memory/load?workspaceId=ws_b&path=x.md', cap);
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe('memory_cap_invalid');
  });

  it('cross-ws load via ?uri= is also gated (no silent cross-ws load)', async () => {
    const cap = mintCap('im_alice', 'ws_a');
    const uri = encodeURIComponent('prismer://workspace/ws_b/memory/x.md');
    const r = await get(`/local/memory/load?uri=${uri}`, cap);
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe('memory_cap_invalid');
  });

  it('cross-ws write/search/list/stats/recall all → 401', async () => {
    const cap = mintCap('im_alice', 'ws_a');
    expect((await post('/local/memory/write', writeBody({ workspaceId: 'ws_b' }), cap)).status).toBe(401);
    expect((await get('/local/memory/search?workspaceId=ws_b&q=x', cap)).status).toBe(401);
    expect((await get('/local/memory/list?workspaceId=ws_b', cap)).status).toBe(401);
    expect((await get('/local/memory/stats?workspaceId=ws_b', cap)).status).toBe(401);
    expect((await get('/local/memory/recall/manifest?workspaceId=ws_b&q=x', cap)).status).toBe(401);
    expect((await post('/local/memory/recall/finalize', { workspaceId: 'ws_b', paths: [] }, cap)).status).toBe(401);
    expect((await post('/local/memory/flush', { workspaceId: 'ws_b' }, cap)).status).toBe(401);
    expect((await post('/local/memory/invalidate', { workspaceId: 'ws_b', pageIds: [] }, cap)).status).toBe(401);
    expect(
      (await post('/local/memory/mirror', { workspaceId: 'ws_b', action: 'add', target: 't', content: 'c' }, cap))
        .status,
    ).toBe(401);
  });

  it('agent cannot claim a wildcard workspace: ?workspaceId=* with an agent cap → 401', async () => {
    const cap = mintCap('im_alice', 'ws_a');
    expect((await get('/local/memory/stats?workspaceId=*', cap)).status).toBe(401);
    expect((await get('/local/memory/list?workspaceId=*', cap)).status).toBe(401);
    expect((await post('/local/memory/write', writeBody({ workspaceId: '*' }), cap)).status).toBe(401);
    // The mint site itself refuses to produce a wildcard agent cap.
    expect(() => mintCap('im_alice', '*')).toThrow();
  });

  it('agent wildcard grant is rejected at verify: wildcard scope requires the system subject', () => {
    // Negative controls (injected wildcard + agent sub → fail closed):
    expect(wildcardScopeRequiresSystemSub('im_alice', ['ws:*'])).toBe(false);
    expect(wildcardScopeRequiresSystemSub('im_alice', ['ws:ws_a', 'ws:*'])).toBe(false);
    // Positive controls:
    expect(wildcardScopeRequiresSystemSub('daemon-system', ['ws:*'])).toBe(true);
    expect(wildcardScopeRequiresSystemSub('im_alice', ['ws:ws_a'])).toBe(true);
    // End-to-end: a daemon-minted agent cap still verifies (no regression).
    const cap = mintCap('im_alice', 'ws_a');
    expect(cap).toBeTruthy();
  });

  it('cap ws claim must agree with its scope (verify-level ws mismatch → invalid)', () => {
    // Negative controls (injected ws/scope disagreement → fail closed):
    expect(capWsClaimMatchesScope('ws_a', ['ws:ws_b'])).toBe(false);
    expect(capWsClaimMatchesScope('*', ['ws:ws_a'])).toBe(false);
    expect(capWsClaimMatchesScope('ws_a', [])).toBe(false);
    // Positive controls:
    expect(capWsClaimMatchesScope('ws_a', ['ws:ws_a'])).toBe(true);
    expect(capWsClaimMatchesScope('*', ['ws:*'])).toBe(true);
  });

  it('same-ws cap{ws:A} → write + load on ws_a succeed (valid v1 cap, no regression)', async () => {
    const cap = mintCap('im_alice', 'ws_a');
    const w = await post('/local/memory/write', writeBody({ path: 'a.md', content: 'hi' }), cap);
    expect(w.status).toBe(200);
    const r = await get('/local/memory/load?workspaceId=ws_a&path=a.md', cap);
    expect(r.status).toBe(200);
    expect((r.body as { content: string }).content).toBe('hi');
  });

  it('scoped cap with omitted workspaceId defaults to cap.ws', async () => {
    const cap = mintCap('im_alice', 'ws_a');
    await post('/local/memory/write', writeBody({ path: 'a.md', content: 'hi' }), cap);
    // /stats without ?workspaceId= → scoped to cap.ws (not a global aggregate)
    const r = await get('/local/memory/stats', cap);
    expect(r.status).toBe(200);
    expect((r.body as { workspaceId?: string }).workspaceId).toBe('ws_a');
  });

  it('write actor = verified cap.sub — body actorImUserId is ignored (DB oracle)', async () => {
    const cap = mintCap('im_alice', 'ws_a');
    const w = await post(
      '/local/memory/write',
      writeBody({ path: 'actor.md', content: 'x', actorImUserId: 'im_evil', actorKind: 'human' }),
      cap,
    );
    expect(w.status).toBe(200);
    const page = (w.body as { page: { id: string } }).page;
    const slot = runtime!.peek('ws_a');
    const dbPath = slot!.store.stats().dbPath;
    const db = new Database(dbPath!, { readonly: true });
    try {
      const row = db
        .prepare('SELECT actorImUserId, actorKind FROM memory_page_versions WHERE pageId = ?')
        .get(page.id) as { actorImUserId: string; actorKind: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.actorImUserId).toBe('im_alice'); // cap.sub, NOT im_evil
      expect(row!.actorKind).toBe('agent');
    } finally {
      db.close();
    }
  });

  it('system cap reaches any ws (internal-only path) + global stats', async () => {
    const sys = mintSystemCap();
    expect((await get('/local/memory/list?workspaceId=ws_b', sys)).status).toBe(200);
    const r = await get('/local/memory/stats', sys);
    expect(r.status).toBe(200);
    // system cap → global aggregate shape (workspaces[], not a single ws)
    expect((r.body as { workspaceCount?: number }).workspaceCount).toBeDefined();
  });

  it('adapter tool client auto-carries the env cap (PRISMER_MEMORY_CAP) — same ws OK', async () => {
    const cap = mintCap('im_alice', 'ws_a');
    await post('/local/memory/write', writeBody({ path: 'a.md', content: 'hello world' }), cap);
    process.env.PRISMER_MEMORY_CAP = cap;
    try {
      const tools = buildMemoryToolImpls({ daemonUrl: baseUrl, workspaceId: 'ws_a' });
      const loaded = await tools.load({ workspaceId: 'ws_a', path: 'a.md' });
      expect(loaded.content).toBe('hello world');
      const searched = await tools.search({ query: 'hello' });
      expect(searched.results.length).toBeGreaterThan(0);
    } finally {
      delete process.env.PRISMER_MEMORY_CAP;
    }
  });

  it('adapter tool client with a cross-ws env cap is denied (401 → throws, no leak)', async () => {
    process.env.PRISMER_MEMORY_CAP = mintCap('im_alice', 'ws_a');
    try {
      const tools = buildMemoryToolImpls({ daemonUrl: baseUrl, workspaceId: 'ws_b' });
      await expect(tools.load({ workspaceId: 'ws_b', path: 'x.md' })).rejects.toThrow();
      await expect(tools.search({ query: 'x' })).rejects.toThrow();
    } finally {
      delete process.env.PRISMER_MEMORY_CAP;
    }
  });

  it('adapter tool client with NO env cap is denied 401 (fail closed)', async () => {
    const tools = buildMemoryToolImpls({ daemonUrl: baseUrl, workspaceId: 'ws_a' });
    await expect(tools.load({ workspaceId: 'ws_a', path: 'x.md' })).rejects.toThrow(/401/);
  });
});
