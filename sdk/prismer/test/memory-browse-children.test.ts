// memory211/01 §3 轴C W1a — tree-shaped browse (hub → children).
//
// What this proves:
//   ① Each hub in the place-context payload carries its child-of children
//      (path + best-effort title), aggregated from the LOCAL `memory_links`
//      mirror — the browse tree needs no extra cloud round-trip.
//   ② The children survive the buildRecallContext projection in
//      GET /local/memory/place-context (they are zipped back on by path).
//   ③ An empty hub / empty workspace stays shape-stable (children: []).
//   ④ The extraction leg (the other assemblePlaceContext consumer) is
//      unaffected: buildRecallContext still projects the flat 4-field row.
//   ⑤ `nearest` is deliberately unchanged this wave (graph-distance ordering is
//      deferred to W1b) — asserted so the deferral is a documented contract,
//      not an accident.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap } from '../src/daemon/memory/cap.js';
import { assemblePlaceContext } from '../src/daemon/memory/hook-server.js';
import { buildRecallContext } from '../src/daemon/memory/extract.js';

const WS = 'ws_tree';

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
  const dir = mkdtempSync(join(tmpdir(), 'prismer-browse-tree-'));
  cleanupDirs.push(dir);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
}

function seed(
  path: string,
  content: string,
  pageType: 'hub' | 'leaf' | 'index' | 'decision',
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

describe('memory211 W1a — tree-shaped browse', () => {
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

  it('① assemblePlaceContext lists each hub child-of children with titles', () => {
    tmpRuntime();
    cap = mintCap('im_seed', WS);
    seed('hubs/auth.md', 'Authentication hub.', 'hub', 'Auth hub');
    seed('leaves/rotation.md', 'Token rotation cadence.', 'leaf', 'Rotation');
    seed('leaves/sessions.md', 'Session lifetime rules.', 'leaf', 'Sessions');
    seed('leaves/billing.md', 'Billing notes.', 'leaf');
    link('leaves/rotation.md', 'hubs/auth.md');
    link('leaves/sessions.md', 'hubs/auth.md');
    // A mesh edge must NOT become a child.
    link('leaves/billing.md', 'hubs/auth.md', 'related');

    const parts = assemblePlaceContext(runtime!.resolve(WS), undefined, {
      isSystem: false,
      imUserId: 'im_seed',
    } as never);
    const hub = parts.hubPages.find((h) => h.path === 'hubs/auth.md');
    expect(hub).toBeDefined();
    expect(hub!.children.map((c) => c.path).sort()).toEqual([
      'leaves/rotation.md',
      'leaves/sessions.md',
    ]);
    expect(hub!.children.every((c) => typeof c.title === 'string')).toBe(true);
  });

  it('② GET /local/memory/place-context returns the tree (children survive projection)', async () => {
    tmpRuntime();
    cap = mintCap('im_seed', WS);
    runtime = new MemoryRuntime({ baseDir: join(cleanupDirs[0]!), deviceId: 'dev_x' });
    server = new LocalServer({
      port: 0,
      getState: () => baseState,
      attachMemory: attachMemoryRpc({ runtime, deviceId: 'dev_x' }),
    });
    await server.start();
    baseUrl = boundBaseUrl(server);
    seed('INDEX.pkf', '<h1>INDEX</h1>', 'index');
    seed('hubs/auth.md', 'Authentication hub.', 'hub', 'Auth hub');
    seed('leaves/rotation.md', 'Token rotation cadence.', 'leaf', 'Rotation');
    link('leaves/rotation.md', 'hubs/auth.md');

    const res = await fetch(`${baseUrl}/local/memory/place-context?workspaceId=${WS}`, {
      headers: { 'x-prismer-memory-cap': cap },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const hub = (body.hubs as Array<{ path: string; children: Array<{ path: string; title: string | null }> }>).find(
      (h) => h.path === 'hubs/auth.md',
    );
    expect(hub).toBeDefined();
    expect(hub!.children).toEqual([{ path: 'leaves/rotation.md', title: 'Rotation' }]);
    // The rest of the browse shape is untouched.
    expect(body.index.pageType).toBe('index');
    expect(Array.isArray(body.nearest)).toBe(true);
  });

  it('③ a childless hub and an empty workspace stay shape-stable', async () => {
    tmpRuntime();
    cap = mintCap('im_seed', WS);
    runtime = new MemoryRuntime({ baseDir: join(cleanupDirs[0]!), deviceId: 'dev_x' });
    server = new LocalServer({
      port: 0,
      getState: () => baseState,
      attachMemory: attachMemoryRpc({ runtime, deviceId: 'dev_x' }),
    });
    await server.start();
    baseUrl = boundBaseUrl(server);

    // Empty workspace first (memory211/03 §7 B1: hubsByRecent is part of the
    // contract — empty sets stay empty arrays, never absent).
    let res = await fetch(`${baseUrl}/local/memory/place-context?workspaceId=${WS}`, {
      headers: { 'x-prismer-memory-cap': cap },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ index: null, hubs: [], hubsByRecent: [], nearest: [] });

    // A hub with no children still carries an (empty) children array + the
    // B1 `updatedAt` freshness field (value varies per write — shape asserted).
    seed('hubs/lonely.md', 'A hub nobody hangs under.', 'hub');
    res = await fetch(`${baseUrl}/local/memory/place-context?workspaceId=${WS}`, {
      headers: { 'x-prismer-memory-cap': cap },
    });
    const body = await res.json();
    expect(body.hubs).toHaveLength(1);
    expect(body.hubs[0]).toMatchObject({
      path: 'hubs/lonely.md',
      title: 'hubs/lonely.md',
      pageType: 'hub',
      snippet: 'A hub nobody hangs under.',
      children: [],
    });
    expect(typeof (body.hubs[0] as { updatedAt: unknown }).updatedAt).toBe('number');
    expect((body.hubsByRecent as Array<{ path: string }>).map((h) => h.path)).toEqual([
      'hubs/lonely.md',
    ]);
  });

  it('④ the extraction leg still gets the flat recall row (no children leak into the prompt)', () => {
    tmpRuntime();
    seed('hubs/auth.md', 'Authentication hub.', 'hub', 'Auth hub');
    seed('leaves/rotation.md', 'Rotation cadence.', 'leaf', 'Rotation');
    link('leaves/rotation.md', 'hubs/auth.md');
    const parts = assemblePlaceContext(runtime!.resolve(WS));
    const recall = buildRecallContext(parts.indexPage, parts.indexSnippet, parts.hubPages, parts.nearest);
    const hub = recall.find((p) => p.path === 'hubs/auth.md');
    expect(hub).toBeDefined();
    expect(Object.keys(hub!).sort()).toEqual(['pageType', 'path', 'snippet', 'title']);
  });

  it('⑤ nearest ordering is unchanged this wave (W1b deferral is contractual)', async () => {
    tmpRuntime();
    cap = mintCap('im_seed', WS);
    runtime = new MemoryRuntime({ baseDir: join(cleanupDirs[0]!), deviceId: 'dev_x' });
    server = new LocalServer({
      port: 0,
      getState: () => baseState,
      attachMemory: attachMemoryRpc({ runtime, deviceId: 'dev_x' }),
    });
    await server.start();
    baseUrl = boundBaseUrl(server);
    seed('notes/caching.pkf', 'distributed caching strategies: write-through, TTL eviction', 'leaf');
    const res = await fetch(
      `${baseUrl}/local/memory/place-context?workspaceId=${WS}&q=${encodeURIComponent('distributed caching')}`,
      { headers: { 'x-prismer-memory-cap': cap } },
    );
    const body = await res.json();
    expect((body.nearest as Array<{ path: string }>)[0]?.path).toBe('notes/caching.pkf');
    // nearest rows keep the flat shape (no children key).
    expect(Object.keys((body.nearest as Array<Record<string, unknown>>)[0]!).sort()).toEqual([
      'pageType',
      'path',
      'snippet',
      'title',
    ]);
  });
});
