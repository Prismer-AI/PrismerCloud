// memory211/03 §7 B1 — browse freshness signal (recall-behavior lane).
//
// What this proves:
//  ① structure-first: `hubs[]`/`index` keep EXACTLY the pre-B1 order — hub
//     rows in the daemon's hub listing order (store.list: hub own updatedAt
//     DESC, the order the W1a wave shipped and consumers depend on);
//  ② additive recency: `hubsByRecent[]` is the SAME hub set sorted by the B1
//     `updatedAt` DESC — the field is max(hub own, direct children) so a hub
//     whose leaves were written after the hub row LEADS (the audit pain:
//     freshly-active subtrees must surface even when the hub row is old);
//  ③ every hub row carries `updatedAt` at that finest granularity (subtree
//     max over the browse tree's direct child-of children; hub-win and
//     child-win cases both pinned; childless hub = own value);
//  ④ old-contract negative control: a consumer of the pre-B1 shape
//     ({index, hubs, nearest} with 4-field hub rows) still destructures and
//     reads the same values; `nearest`/`index` keep the flat 4-field rows
//     (no updatedAt leak there) — the B1 fields are purely additive.
//
// Timestamps are pinned by writing memory_pages.updatedAt/createdAt directly
// in the local SQLite fixture (epoch ms, the store's own unit) so the sort
// semantics are asserted against exact values, not same-millisecond write
// races.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap } from '../src/daemon/memory/cap.js';

const WS = 'ws_recent';
const T0 = 1_700_000_000_000;

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';
let cap = '';

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

function tmpRuntime(): void {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-browse-recent-'));
  cleanupDirs.push(dir);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
}

function seed(
  path: string,
  content: string,
  pageType: 'hub' | 'leaf' | 'index',
  title?: string,
): void {
  runtime!.resolve(WS).store.write({
    workspaceId: WS,
    path,
    content,
    title: title ?? path,
    pageType: pageType as never,
    actorImUserId: 'im_seed',
    actorKind: 'human',
  });
}

function link(sourcePath: string, targetPath: string, relation = 'child-of'): void {
  runtime!.resolve(WS).store.upsertLink({
    sourceUri: `pkm://${sourcePath}`,
    targetUri: `pkm://${targetPath}`,
    relation,
    weight: 1,
    extractedFromPageId: null,
  });
}

/** Pin memory_pages.updatedAt/createdAt (both epoch ms) for one path. */
function pinTimestamps(baseDir: string, path: string, ts: number): void {
  const dbPath = join(baseDir, WS.replace(/:/g, '_'), 'memory.db');
  const db = new Database(dbPath);
  try {
    db.prepare(
      'UPDATE memory_pages SET updatedAt = ?, createdAt = ? WHERE workspaceId = ? AND path = ?',
    ).run(ts, ts, WS, path);
  } finally {
    db.close();
  }
}

async function browse(): Promise<{
  index: unknown;
  hubs: Array<{
    path: string;
    title: string | null;
    pageType: string;
    snippet: string;
    children: Array<{ path: string; title: string | null }>;
    updatedAt: number;
  }>;
  hubsByRecent: Array<{ path: string; updatedAt: number }>;
  nearest: Array<Record<string, unknown>>;
}> {
  const res = await fetch(`${baseUrl}/local/memory/place-context?workspaceId=${WS}`, {
    headers: { 'x-prismer-memory-cap': cap },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as never;
}

describe('memory211/03 §7 B1 — browse updatedAt + hubsByRecent[]', () => {
  const cleanup = () => {
    for (const d of cleanupDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  };
  afterEach(async () => {
    await server?.stop();
    server = undefined;
    runtime?.closeAll();
    runtime = undefined;
    cleanup();
  });

  async function startServer(): Promise<void> {
    cap = mintCap('im_seed', WS);
    server = new LocalServer({
      port: 0,
      getState: () => baseState,
      attachMemory: attachMemoryRpc({ runtime: runtime!, deviceId: 'dev_x' }),
    });
    await server.start();
    baseUrl = boundBaseUrl(server);
  }

  it('① structure-first + ② ③ hubsByRecent orders by the subtree max, and hubs[] keeps the existing hub-own-DESC order', async () => {
    tmpRuntime();
    const dir = cleanupDirs[0]!;
    // Hub A: own ts is newest within its subtree (own wins).
    seed('hubs/alpha.md', 'Alpha hub.', 'hub', 'Alpha');
    seed('leaves/alpha-1.md', 'Alpha child.', 'leaf', 'Alpha child');
    link('leaves/alpha-1.md', 'hubs/alpha.md');
    // Hub B: child written far AFTER the hub row (child wins — the pain
    // node: hub row alone would bury a freshly-active subtree).
    seed('hubs/beta.md', 'Beta hub.', 'hub', 'Beta');
    seed('leaves/beta-1.md', 'Beta child.', 'leaf', 'Beta child');
    link('leaves/beta-1.md', 'hubs/beta.md');
    // Hub C: childless — its own timestamp is the value.
    seed('hubs/gamma.md', 'Gamma hub.', 'hub', 'Gamma');
    // Seed order is unsorted; pin exact timestamps now.
    pinTimestamps(dir, 'hubs/alpha.md', T0 + 1_000);
    pinTimestamps(dir, 'leaves/alpha-1.md', T0 + 500);
    pinTimestamps(dir, 'hubs/beta.md', T0 + 2_000);
    pinTimestamps(dir, 'leaves/beta-1.md', T0 + 9_000);
    pinTimestamps(dir, 'hubs/gamma.md', T0 + 3_000);
    await startServer();

    const body = await browse();

    // ③ finest granularity: max(hub own, direct children) per hub row.
    const byPath = new Map(body.hubs.map((h) => [h.path, h.updatedAt]));
    expect(byPath.get('hubs/alpha.md')).toBe(T0 + 1_000); // own beats the stale child
    expect(byPath.get('hubs/beta.md')).toBe(T0 + 9_000); // children beat the hub row
    expect(byPath.get('hubs/gamma.md')).toBe(T0 + 3_000); // childless → own

    // ① structure-first: hubs[] keeps the pre-B1 order (hub own updatedAt DESC
    // as store.list enumerates hubs) — B's children being fresher must NOT
    // move it above C.
    expect(body.hubs.map((h) => h.path)).toEqual([
      'hubs/gamma.md',
      'hubs/beta.md',
      'hubs/alpha.md',
    ]);

    // ② hubsByRecent[] = whole-hub recency order (subtree max DESC) — B now
    // leads even though its hub row is not the newest.
    expect(body.hubsByRecent.map((h) => h.path)).toEqual([
      'hubs/beta.md',
      'hubs/gamma.md',
      'hubs/alpha.md',
    ]);
    // And it is literally the same hub set, desc-sorted by the row value.
    const sorted = [...body.hubs].sort((a, b) => b.updatedAt - a.updatedAt).map((h) => h.path);
    expect(body.hubsByRecent.map((h) => h.path)).toEqual(sorted);
  });

  it('④ negative control — the pre-B1 consumer shape is unbroken; index/nearest stay flat (no updatedAt leak)', async () => {
    tmpRuntime();
    const dir = cleanupDirs[0]!;
    seed('INDEX.pkf', '<h1>INDEX</h1>', 'index');
    seed('hubs/alpha.md', 'Alpha hub.', 'hub', 'Alpha');
    seed('leaves/alpha-1.md', 'Alpha child.', 'leaf', 'Alpha child');
    link('leaves/alpha-1.md', 'hubs/alpha.md');
    pinTimestamps(dir, 'hubs/alpha.md', T0 + 1_000);
    pinTimestamps(dir, 'leaves/alpha-1.md', T0 + 2_000);
    await startServer();

    const body = await browse();
    // The pre-B1 consumer destructures ONLY the old fields and iterates the
    // old hub row keys — extra fields must not crash it.
    const { index, hubs, nearest } = body;
    expect(index).not.toBeNull();
    const oldHub = hubs[0]!;
    const { path, title, pageType, snippet, children } = oldHub;
    expect(path).toBe('hubs/alpha.md');
    expect(title).toBe('Alpha');
    expect(pageType).toBe('hub');
    expect(snippet).toBe('Alpha hub.');
    expect(children).toEqual([{ path: 'leaves/alpha-1.md', title: 'Alpha child' }]);
    // Old hub row shape + the two additive keys — and ONLY those.
    expect(Object.keys(oldHub).sort()).toEqual([
      'children',
      'pageType',
      'path',
      'snippet',
      'title',
      'updatedAt',
    ]);
    // nearest rows keep the pre-B1 flat 4-field shape (no updatedAt leak).
    expect(nearest).toHaveLength(1);
    expect(Object.keys(nearest[0]!).sort()).toEqual(['pageType', 'path', 'snippet', 'title']);
    expect(nearest[0]!.path).toBe('leaves/alpha-1.md');
    // index row keeps the pre-B1 flat 4-field shape (no updatedAt leak).
    expect(Object.keys(index as Record<string, unknown>).sort()).toEqual([
      'pageType',
      'path',
      'snippet',
      'title',
    ]);
    expect(typeof oldHub.updatedAt).toBe('number');
    expect(oldHub.updatedAt).toBe(T0 + 2_000); // child-wins freshness value
    expect(body.hubsByRecent.map((h) => h.path)).toEqual(['hubs/alpha.md']);
  });

  it('empty workspace — hubsByRecent is a present, empty array (never absent)', async () => {
    tmpRuntime();
    await startServer();
    const body = await browse();
    expect(body.hubs).toEqual([]);
    expect(body.hubsByRecent).toEqual([]);
    expect(body.nearest).toEqual([]);
    expect(body.index).toBeNull();
  });
});
