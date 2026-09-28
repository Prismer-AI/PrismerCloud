import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { canCapReadAsset, canCapReadPage } from '../src/daemon/memory/acl-predicate.js';
import { mintCap, systemCap, verifyCap, __resetCapKeyForTest } from '../src/daemon/memory/cap.js';

// doc 08 §5 (P0.5) — daemon boundary predicate (F5): within a workspace, the
// cap may still only read its own agent/private pages. Workspace-visible pages
// are shared. The system cap (daemon-internal) sees all.

describe('canCapReadPage boundary predicate (doc 08 P0.5)', () => {
  afterEach(() => __resetCapKeyForTest());
  const capA = () => verifyCap(mintCap('im_a', 'ws_w'))!;

  it('cross-workspace → false regardless of visibility', () => {
    expect(canCapReadPage(capA(), { workspaceId: 'ws_other', visibility: { kind: 'workspace' } })).toBe(false);
  });

  it('workspace-visible page → readable by any in-workspace cap', () => {
    expect(canCapReadPage(capA(), { workspaceId: 'ws_w', visibility: { kind: 'workspace' } })).toBe(true);
  });

  it('agent/private page → only the owning subject', () => {
    expect(canCapReadPage(capA(), { workspaceId: 'ws_w', visibility: { kind: 'agent', imUserId: 'im_a' } })).toBe(true);
    expect(canCapReadPage(capA(), { workspaceId: 'ws_w', visibility: { kind: 'agent', imUserId: 'im_b' } })).toBe(false);
    expect(canCapReadPage(capA(), { workspaceId: 'ws_w', visibility: { kind: 'private', imUserId: 'im_a' } })).toBe(true);
    expect(canCapReadPage(capA(), { workspaceId: 'ws_w', visibility: { kind: 'private', imUserId: 'im_b' } })).toBe(false);
  });

  it('system cap sees every page', () => {
    expect(canCapReadPage(systemCap(), { workspaceId: 'ws_w', visibility: { kind: 'agent', imUserId: 'im_b' } })).toBe(true);
    expect(canCapReadPage(systemCap(), { workspaceId: 'any', visibility: { kind: 'private', imUserId: 'x' } })).toBe(true);
  });
});

// product204/34 Track 0.1 — role/council are now FAIL-CLOSED at the daemon
// boundary, judged locally from membership carried in the signed cap. These
// branches had ZERO coverage before (31-batch §8). Side-effect oracle = the
// boolean predicate over a directly-constructed cap.
describe('canCapReadPage role/council fail-closed (product204/34 Track 0.1)', () => {
  afterEach(() => __resetCapKeyForTest());
  const capForRole = (slug: string) => verifyCap(mintCap('im_r', 'ws_w', { roleSlugs: [slug] }))!;
  const capOrchestrator = () => verifyCap(mintCap('im_o', 'ws_w', { isOrchestrator: true }))!;
  const capForCouncil = (id: string) => verifyCap(mintCap('im_c', 'ws_w', { councilIds: [id] }))!;
  const capPlain = () => verifyCap(mintCap('im_p', 'ws_w'))!; // no membership at all

  const rolePage = (slug: string) => ({ workspaceId: 'ws_w', visibility: { kind: 'role' as const, slug } });
  const councilPage = (id: string) => ({ workspaceId: 'ws_w', visibility: { kind: 'council' as const, id } });

  it('role: reader with a DIFFERENT role slug → false (no cross-role read)', () => {
    expect(canCapReadPage(capForRole('roleB'), rolePage('roleA'))).toBe(false);
  });

  it('role: reader owning the slug → true', () => {
    expect(canCapReadPage(capForRole('roleB'), rolePage('roleB'))).toBe(true);
  });

  it('role: orchestrator cap → reads any role page', () => {
    expect(canCapReadPage(capOrchestrator(), rolePage('roleA'))).toBe(true);
    expect(canCapReadPage(capOrchestrator(), rolePage('anything'))).toBe(true);
  });

  it('role: cap with NO role membership → false (fail-closed)', () => {
    expect(canCapReadPage(capPlain(), rolePage('roleA'))).toBe(false);
  });

  it('council: reading a DIFFERENT council than the cap belongs to → false', () => {
    // cap/context for conversation A reading council:B → deny
    expect(canCapReadPage(capForCouncil('A'), councilPage('B'))).toBe(false);
  });

  it('council: reading the SAME council the cap belongs to → true', () => {
    expect(canCapReadPage(capForCouncil('A'), councilPage('A'))).toBe(true);
  });

  it('council: cap with NO council membership → false (fail-closed, never fail-open)', () => {
    expect(canCapReadPage(capPlain(), councilPage('A'))).toBe(false);
  });

  it('council: orchestrator flag does NOT grant cross-council read (membership only)', () => {
    // An orchestrator of council A must not read council B's page.
    expect(canCapReadPage(capOrchestrator(), councilPage('B'))).toBe(false);
  });

  it('system cap still sees role/council pages (daemon-internal)', () => {
    expect(canCapReadPage(systemCap(), rolePage('roleA'))).toBe(true);
    expect(canCapReadPage(systemCap(), councilPage('B'))).toBe(true);
  });

  it('membership claims survive a mint→verify round-trip', () => {
    const cap = verifyCap(mintCap('im_x', 'ws_w', { roleSlugs: ['r1', 'r2'], isOrchestrator: true, councilIds: ['c1'] }))!;
    expect(cap.roleSlugs).toEqual(['r1', 'r2']);
    expect(cap.isOrchestrator).toBe(true);
    expect(cap.councilIds).toEqual(['c1']);
  });
});

describe('daemon boundary predicate over RPC (doc 08 P0.5)', () => {
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
    // ACL tests intentionally create flat fixtures; placement enforcement is
    // exercised independently by memory-write-w2.test.ts.
    process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'warn';
    __resetCapKeyForTest();
    const dir = mkdtempSync(join(tmpdir(), 'prismer-acl-pred-'));
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
    delete process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE;
    await server?.stop();
    runtime?.closeAll();
    for (const d of cleanupDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  async function writeAgentPrivate(sub: string, path: string, content: string, cap: string): Promise<number> {
    const res = await fetch(`${baseUrl}/local/memory/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': cap },
      body: JSON.stringify({
        workspaceId: 'ws_w',
        path,
        content,
        pageType: 'leaf',
        actorImUserId: sub,
        actorKind: 'agent',
        visibility: { kind: 'agent', imUserId: sub },
      }),
    });
    return res.status;
  }

  async function load(path: string, cap: string): Promise<number> {
    const res = await fetch(`${baseUrl}/local/memory/load?workspaceId=ws_w&path=${encodeURIComponent(path)}`, {
      headers: { 'x-prismer-memory-cap': cap },
    });
    return res.status;
  }

  it('agent B cannot load agent A private page in the same workspace (404, no leak)', async () => {
    const capA = mintCap('im_a', 'ws_w');
    const capB = mintCap('im_b', 'ws_w');
    expect(await writeAgentPrivate('im_a', 'a-private.md', 'A only', capA)).toBe(200);
    // A reads its own private page
    expect(await load('a-private.md', capA)).toBe(200);
    // B is in the same workspace but cannot read A's private page — 404 (looks missing)
    expect(await load('a-private.md', capB)).toBe(404);
  });

  async function search(q: string, cap: string): Promise<string[]> {
    const res = await fetch(`${baseUrl}/local/memory/search?workspaceId=ws_w&q=${encodeURIComponent(q)}`, {
      headers: { 'x-prismer-memory-cap': cap },
    });
    const body = (await res.json()) as { results: Array<{ path: string }> };
    return body.results.map((r) => r.path);
  }

  it('search hides other agents private page hits but keeps workspace-visible ones (F5收口)', async () => {
    const capA = mintCap('im_a', 'ws_w');
    const capB = mintCap('im_b', 'ws_w');
    await writeAgentPrivate('im_a', 'a-private.md', 'pineapple secret', capA);
    // workspace-visible page with the same distinctive term
    await fetch(`${baseUrl}/local/memory/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': capA },
      body: JSON.stringify({
        workspaceId: 'ws_w',
        path: 'shared.md',
        content: 'pineapple shared',
        pageType: 'leaf',
        actorImUserId: 'im_a',
        actorKind: 'agent',
        visibility: { kind: 'workspace' },
      }),
    });
    // A sees both its private page and the shared page
    const aHits = await search('pineapple', capA);
    expect(aHits).toContain('a-private.md');
    expect(aHits).toContain('shared.md');
    // B sees only the workspace-visible page — A's private hit is filtered out
    const bHits = await search('pineapple', capB);
    expect(bHits).toContain('shared.md');
    expect(bHits).not.toContain('a-private.md');
  });

  it('list hides other agents private pages but keeps workspace-visible ones', async () => {
    const capA = mintCap('im_a', 'ws_w');
    const capB = mintCap('im_b', 'ws_w');
    await writeAgentPrivate('im_a', 'a-private.md', 'A only', capA);
    // a workspace-visible shared page
    await fetch(`${baseUrl}/local/memory/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': capA },
      body: JSON.stringify({
        workspaceId: 'ws_w',
        path: 'shared.md',
        content: 'team',
        pageType: 'leaf',
        actorImUserId: 'im_a',
        actorKind: 'agent',
        visibility: { kind: 'workspace' },
      }),
    });
    const res = await fetch(`${baseUrl}/local/memory/list?workspaceId=ws_w`, {
      headers: { 'x-prismer-memory-cap': capB },
    });
    const body = (await res.json()) as { pages: Array<{ path: string }> };
    const paths = body.pages.map((p) => p.path);
    expect(paths).toContain('shared.md'); // workspace-visible → B sees it
    expect(paths).not.toContain('a-private.md'); // A's private → hidden from B
  });

  // product204/34 Track 0.1 (§2.2) — write-forge cap-authz. An agent whose cap
  // carries NO council membership cannot forge a `council:<id>` write. Oracle =
  // 403 status AND no row (a subsequent load returns 404).
  async function writeVisibility(path: string, visibility: string, cap: string): Promise<number> {
    const res = await fetch(`${baseUrl}/local/memory/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': cap },
      body: JSON.stringify({
        workspaceId: 'ws_w',
        path,
        content: 'forged council decision',
        pageType: 'leaf',
        visibility,
      }),
    });
    return res.status;
  }

  it('agent cannot forge a council:<id> write it is not a member of → 403, no row', async () => {
    const capX = mintCap('im_x', 'ws_w'); // no councilIds membership
    // forge attempt → 403
    expect(await writeVisibility('forged.md', 'council:cnl_x', capX)).toBe(403);
    // side-effect oracle: nothing was written (load 404)
    expect(await load('forged.md', capX)).toBe(404);
  });

  it('agent cannot forge a role:<slug> write outside its role → 403, no row', async () => {
    const capRoleA = mintCap('im_x', 'ws_w', { roleSlugs: ['roleA'] });
    expect(await writeVisibility('forged-role.md', 'role:roleB', capRoleA)).toBe(403);
    expect(await load('forged-role.md', capRoleA)).toBe(404);
  });

  it('a member cap CAN write its own council:<id> page → 200', async () => {
    const capMember = mintCap('im_x', 'ws_w', { councilIds: ['cnl_ok'] });
    expect(await writeVisibility('council-ok.md', 'council:cnl_ok', capMember)).toBe(200);
    expect(await load('council-ok.md', capMember)).toBe(200);
  });

  // product204/34 Track 0.1d — fork-recall (memory_recall) manifest + finalize.
  // buildManifest/finalizeSelected ran RAW (no visibility filter); finalize
  // returns page CONTENT. Seed role/council/workspace pages directly, then prove
  // a non-member cap gets neither their manifest entries nor their content.
  const RTOK = 'forkrecalltoken';
  function seedScopedPages(): void {
    const store = runtime!.resolve('ws_w').store;
    store.write({ workspaceId: 'ws_w', path: 'fr-shared.md', content: `${RTOK} shared`, pageType: 'leaf', actorImUserId: 'im_seed', actorKind: 'human', visibility: { kind: 'workspace' } });
    store.write({ workspaceId: 'ws_w', path: 'fr-roleB.md', content: `${RTOK} roleB secret`, pageType: 'leaf', actorImUserId: 'im_seed', actorKind: 'agent', visibility: { kind: 'role', slug: 'roleB' } });
    store.write({ workspaceId: 'ws_w', path: 'fr-convB.md', content: `${RTOK} convB secret`, pageType: 'leaf', actorImUserId: 'im_seed', actorKind: 'agent', visibility: { kind: 'council', id: 'convB' } });
  }
  async function manifestPaths(cap: string): Promise<string[]> {
    const res = await fetch(`${baseUrl}/local/memory/recall/manifest?workspaceId=ws_w&q=${RTOK}`, { headers: { 'x-prismer-memory-cap': cap } });
    const body = (await res.json()) as { entries: Array<{ path: string }> };
    return body.entries.map((e) => e.path);
  }
  async function finalizePaths(cap: string, paths: string[]): Promise<string[]> {
    const res = await fetch(`${baseUrl}/local/memory/recall/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': cap },
      body: JSON.stringify({ workspaceId: 'ws_w', paths }),
    });
    const body = (await res.json()) as { results: Array<{ path: string }> };
    return body.results.map((r) => r.path);
  }

  it('fork-recall manifest hides role/council pages from a non-member cap', async () => {
    seedScopedPages();
    const capX = mintCap('im_x', 'ws_w'); // no role/council membership
    const paths = await manifestPaths(capX);
    expect(paths).toContain('fr-shared.md');
    expect(paths).not.toContain('fr-roleB.md');
    expect(paths).not.toContain('fr-convB.md');
  });

  it('fork-recall finalize refuses to return role/council CONTENT to a non-member cap', async () => {
    seedScopedPages();
    const capX = mintCap('im_x', 'ws_w');
    // Even when the selector explicitly names the scoped paths, content is denied.
    const got = await finalizePaths(capX, ['fr-shared.md', 'fr-roleB.md', 'fr-convB.md']);
    expect(got).toContain('fr-shared.md');
    expect(got).not.toContain('fr-roleB.md');
    expect(got).not.toContain('fr-convB.md');
  });

  it('fork-recall manifest + finalize DO return the role page to a member cap (positive)', async () => {
    seedScopedPages();
    const capRoleB = mintCap('im_x', 'ws_w', { roleSlugs: ['roleB'] });
    expect(await manifestPaths(capRoleB)).toContain('fr-roleB.md');
    expect(await finalizePaths(capRoleB, ['fr-roleB.md'])).toContain('fr-roleB.md');
  });
});

// memory211 fix round (external review P1) — the T3 chunk lane's asset
// boundary. A chunk hit addresses an ASSET and the daemon judges it strictly on
// the two ACL fields its own projection mirrors; anything unverifiable DENIES.
describe('canCapReadAsset boundary predicate (asset projection, P1)', () => {
  afterEach(() => __resetCapKeyForTest());
  const capA = () => verifyCap(mintCap('im_a', 'ws_w'))!;

  it('workspace-visible asset → readable by any in-workspace cap', () => {
    expect(canCapReadAsset(capA(), { visibility: 'workspace', ownerImUserId: 'im_other' })).toBe(true);
    expect(canCapReadAsset(capA(), { visibility: 'workspace', ownerImUserId: null })).toBe(true);
  });

  it('an asset the cap owns is readable at any visibility', () => {
    expect(canCapReadAsset(capA(), { visibility: 'user', ownerImUserId: 'im_a' })).toBe(true);
    expect(canCapReadAsset(capA(), { visibility: null, ownerImUserId: 'im_a' })).toBe(true);
  });

  it('another actor-owned / restricted asset → false', () => {
    expect(canCapReadAsset(capA(), { visibility: 'user', ownerImUserId: 'im_b' })).toBe(false);
    expect(canCapReadAsset(capA(), { visibility: 'quarantined', ownerImUserId: 'im_b' })).toBe(false);
    expect(canCapReadAsset(capA(), { visibility: 'task:task_1', ownerImUserId: 'im_b' })).toBe(false);
  });

  it('no verdict at all → DENY (fail-closed: pre-v17 row, unsynced, older cloud)', () => {
    expect(canCapReadAsset(capA(), null)).toBe(false);
    expect(canCapReadAsset(capA(), undefined)).toBe(false);
    expect(canCapReadAsset(capA(), { visibility: null, ownerImUserId: null })).toBe(false);
    expect(canCapReadAsset(capA(), {})).toBe(false);
  });

  it('system cap sees every asset (same bypass as canCapReadPage)', () => {
    expect(canCapReadAsset(systemCap(), null)).toBe(true);
    expect(canCapReadAsset(systemCap(), { visibility: 'quarantined', ownerImUserId: 'im_b' })).toBe(true);
  });
});
