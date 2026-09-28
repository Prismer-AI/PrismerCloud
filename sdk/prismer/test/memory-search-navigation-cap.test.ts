// memory211/01 §6.9 裁决 1 + W6-finish fix round 1 (F2) — the cap read boundary
// covers the MISS-LANE NAVIGATION too, not just the hits.
//
// `runWorkspaceSearch` filters `results` through `canCapReadPage` (a private
// page's snippet must not leak via search any more than via load/list), but a
// start point leaks just as much: path + title + childrenCount of a hub/INDEX
// the actor cannot read is metadata about a page it must not even know exists.
// The cloud side already filters start points through `allowedPageIds` + the
// per-row read verdict, so this closes the daemon half of the parity claim.
//
// End to end over the real RPC surface: a real LocalServer + attachMemoryRpc, a
// minted agent cap, one workspace hub the actor CAN read and one agent-private
// hub it CANNOT, and a zero-overlap query that text-misses.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap, __resetCapKeyForTest } from '../src/daemon/memory/cap.js';

const WS = 'ws_nav_cap';
const ACTOR = 'im_nav_actor';
const OTHER = 'im_nav_other';
const CAP_HEADER = 'x-prismer-memory-cap';

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

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';

beforeEach(async () => {
  process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'warn';
  delete process.env.PRISMER_WORKSPACE_ID;
  delete process.env.PRISMER_MEMORY_CAP;
  __resetCapKeyForTest();
  const dir = mkdtempSync(join(tmpdir(), 'prismer-nav-cap-'));
  cleanupDirs.push(dir);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  server = new LocalServer({
    port: 0,
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime }),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);
});

afterEach(async () => {
  await server?.stop();
  runtime?.closeAll();
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE;
  delete process.env.PRISMER_WORKSPACE_ID;
  process.exitCode = undefined;
});

interface Nav {
  reason: string;
  guidance: string;
  startPoints: Array<{ path: string; pageType: string; childrenCount: number }>;
}

function seedHubs(): void {
  const store = runtime!.resolve(WS).store;
  const seed = (path: string, title: string, visibility: Record<string, unknown>): void => {
    store.write({
      workspaceId: WS,
      path,
      title,
      // A page that never matches the miss query by construction.
      content: `# ${title}\n\nsteady-state keeper page for the navigation boundary case.`,
      pageType: 'hub',
      visibility: visibility as never,
      actorImUserId: ACTOR,
      actorKind: 'agent',
    });
  };
  seed('hubs/open.md', 'Open hub', { kind: 'workspace' });
  seed('hubs/secret.md', 'Secret hub', { kind: 'private', imUserId: OTHER });
}

describe('daemon miss navigation respects the cap read boundary (F2)', () => {
  it('a hub the actor cannot read is dropped from startPoints — and navigation omits itself if none survive', async () => {
    seedHubs();
    const cap = mintCap(ACTOR, WS)!;
    const get = async (q: string): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await fetch(`${baseUrl}/local/memory/search?workspaceId=${WS}&q=${encodeURIComponent(q)}`, {
        headers: { [CAP_HEADER]: cap },
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    // Precondition: a text miss really did happen (no hits), so the response is
    // navigation-shaped rather than a hit list.
    const missed = await get('zzqxvm nothing matches this');
    expect(missed.status).toBe(200);
    const first = missed.body as { query: string; results: unknown[]; navigation?: Nav };
    expect(first.results).toEqual([]);
    expect(first.navigation).toBeDefined();
    expect(first.navigation!.reason).toBe('text-miss');

    const paths = first.navigation!.startPoints.map((sp) => sp.path);
    expect(paths).toContain('hubs/open.md');
    expect(paths).not.toContain('hubs/secret.md');
    // …and the private hub's TITLE leaked nowhere either.
    expect(JSON.stringify(first.navigation)).not.toContain('Secret hub');

    // NEGATIVE CONTROL SURFACE — the fixture really is unreadable to this cap:
    // the load path denies the SAME page with 404 (not 403 — the F5 boundary is
    // deliberately indistinguishable from a missing page, so no existence leak),
    // which is exactly the boundary the start-point filter now mirrors.
    const load = await fetch(`${baseUrl}/local/memory/load?workspaceId=${WS}&path=hubs%2Fsecret.md`, {
      headers: { [CAP_HEADER]: cap },
    });
    expect(load.status).toBe(404);
    expect(((await load.json()) as { error?: string }).error).toBe('memory_page_not_found');
  });

  it('only-unreadable structure ⇒ no navigation at all (never a padded or leaked list)', async () => {
    const store = runtime!.resolve(WS).store;
    store.write({
      workspaceId: WS,
      path: 'hubs/only-secret.md',
      title: 'Only secret hub',
      content: '# Only secret hub\n\nunmatched keeper page.',
      pageType: 'hub',
      visibility: { kind: 'private', imUserId: OTHER } as never,
      actorImUserId: ACTOR,
      actorKind: 'agent',
    });
    const cap = mintCap(ACTOR, WS)!;
    const res = await fetch(`${baseUrl}/local/memory/search?workspaceId=${WS}&q=zzqxvm nothing matches`, {
      headers: { [CAP_HEADER]: cap },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; navigation?: Nav };
    expect(body.results).toEqual([]);
    expect(body.navigation).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('Only secret hub');
  });
});
