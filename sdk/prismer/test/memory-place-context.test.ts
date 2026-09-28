// memory203/18 R6.1 + R6.2 — write-time structure view (memory_browse).
//
// What this proves:
//   1. R6.1 hub-snippet wiring: `assemblePlaceContext` surfaces WHAT each hub is
//      about — the hub's `description` when authored, else the first ~200 chars
//      of its content — and that snippet reaches the assembled recall context
//      (`buildRecallContext`) the extract model sees. NEGATIVE CONTROL: the
//      pre-fix behavior (hub mapped WITHOUT a snippet → '') must NOT reproduce
//      for a described hub; a hub with neither description nor content still
//      degrades to '' (best-effort, never a throw).
//   2. R6.2 GET /local/memory/place-context: returns `{ index, hubs, nearest }`
//      assembled by the SAME shared helper the extraction leg uses — INDEX with
//      snippet, hubs with snippet, and `nearest` populated ONLY when `q` is
//      given (negative control: no `q` → nearest []).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap, mintSystemCap } from '../src/daemon/memory/cap.js';
import { assemblePlaceContext } from '../src/daemon/memory/hook-server.js';
import { buildRecallContext } from '../src/daemon/memory/extract.js';
import type { MemoryPageType } from '../src/daemon/memory/types.js';

const WS = 'ws_place';

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

// spec16 §8.1 — fail-closed RPC: the get helper carries the suite's agent cap.
let cap = '';

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-place-context-'));
  cleanupDirs.push(dir);
  cap = mintCap('im_seed', WS);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  server = new LocalServer({
    port: 0, // ephemeral — read the real port back after start (O16-b)
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime, deviceId: 'dev_x' }),
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
});

function seed(
  path: string,
  content: string,
  pageType: MemoryPageType | 'index',
  description?: string,
): void {
  runtime!.resolve(WS).store.write({
    workspaceId: WS,
    path,
    content,
    title: path,
    ...(description ? { description } : {}),
    pageType: pageType as MemoryPageType,
    actorImUserId: 'im_seed',
    actorKind: 'human',
  });
}

async function get(path: string, capOverride?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'x-prismer-memory-cap': capOverride ?? cap },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('R6.1 — assemblePlaceContext hub snippets', () => {
  it('a hub WITH a description surfaces it in the assembled recall context (negative control: snippet must not be empty)', () => {
    seed('project/desktop.pkf', '<h1>Desktop</h1><p>sync protocol notes</p>', 'hub', 'Everything about the desktop app: OTA, sync, gateway');
    const slot = runtime!.resolve(WS);

    const parts = assemblePlaceContext(slot);
    const hub = parts.hubPages.find((h) => h.path === 'project/desktop.pkf');
    expect(hub).toBeDefined();
    // The负控 core: the pre-fix caller mapped hubs WITHOUT a snippet, so this
    // was '' — a revert of R6.1 turns this assertion red.
    expect(hub!.snippet).toBe('Everything about the desktop app: OTA, sync, gateway');

    // …and the SAME snippet reaches the recall context the extract model sees.
    const recall = buildRecallContext(parts.indexPage, parts.indexSnippet, parts.hubPages, parts.nearest);
    const recallHub = recall.find((p) => p.path === 'project/desktop.pkf');
    expect(recallHub).toBeDefined();
    expect(recallHub!.snippet).toContain('Everything about the desktop app');
  });

  it('a hub WITHOUT a description falls back to the first ~200 chars of content', () => {
    const body = '<h1>Billing</h1><p>' + 'stripe topup credits '.repeat(30) + '</p>';
    seed('project/billing.pkf', body, 'hub');
    const parts = assemblePlaceContext(runtime!.resolve(WS));
    const hub = parts.hubPages.find((h) => h.path === 'project/billing.pkf');
    expect(hub).toBeDefined();
    expect(hub!.snippet).toBe(body.slice(0, 200));
    expect(hub!.snippet.length).toBeLessThanOrEqual(200);
  });

  it('nearest surfaces recent leaves even without a query, and FTS-ranks with one', () => {
    // memory203/24 Step4 (recall-before-write reliability) — assemblePlaceContext now
    // ALWAYS folds the most-recently-written leaves into `nearest` (recency-first),
    // so a same-session earlier write is visible even when the FTS query misranks it
    // (or there is no query). Without a query: recent leaves surface (NOT empty).
    seed('notes/caching.pkf', 'distributed caching strategies: write-through, TTL eviction', 'leaf');
    const slot = runtime!.resolve(WS);
    const noQuery = assemblePlaceContext(slot).nearest;
    expect(noQuery.length).toBeGreaterThan(0); // recency-merge surfaces the recent leaf
    expect(noQuery.some((n) => n.path === 'notes/caching.pkf')).toBe(true);
    const withQuery = assemblePlaceContext(slot, 'distributed caching strategies');
    expect(withQuery.nearest.length).toBeGreaterThan(0);
    expect(withQuery.nearest[0]?.path).toBe('notes/caching.pkf');
  });
});

describe('R6.2 — GET /local/memory/place-context (memory_browse)', () => {
  it('400 without workspaceId (system cap — an agent cap would default to cap.ws)', async () => {
    // spec16 §8.1: a scoped agent cap with no workspaceId DEFAULTS to cap.ws
    // (covered in memory-cap-rpc.test.ts); the 400 path needs the system cap,
    // which has no default ws to fall back to.
    const r = await get('/local/memory/place-context', mintSystemCap());
    expect(r.status).toBe(400);
  });

  it('returns { index, hubs-with-snippet, nearest:[] } for a structure-only browse (no q)', async () => {
    seed('INDEX.pkf', '<h1>INDEX</h1><p>workspace map</p>', 'index');
    seed('project/desktop.pkf', '<h1>Desktop</h1>', 'hub', 'Desktop app knowledge hub');
    const r = await get(`/local/memory/place-context?workspaceId=${WS}`);
    expect(r.status).toBe(200);
    expect(r.body.index).not.toBeNull();
    expect(r.body.index.pageType).toBe('index');
    expect(r.body.index.snippet).toContain('workspace map');
    const hub = (r.body.hubs as Array<{ path: string; snippet: string }>).find(
      (h) => h.path === 'project/desktop.pkf',
    );
    expect(hub).toBeDefined();
    expect(hub!.snippet).toBe('Desktop app knowledge hub');
    // Negative control: no `q` → the nearest lane must stay empty (structure only).
    expect(r.body.nearest).toEqual([]);
  });

  it('q= adds nearest pages via the same local hybrid search the extraction leg uses', async () => {
    seed('notes/caching.pkf', 'distributed caching strategies: write-through, TTL eviction', 'leaf');
    const r = await get(
      `/local/memory/place-context?workspaceId=${WS}&q=${encodeURIComponent('distributed caching')}`,
    );
    expect(r.status).toBe(200);
    const nearest = r.body.nearest as Array<{ path: string; snippet: string }>;
    expect(nearest.length).toBeGreaterThan(0);
    expect(nearest[0]?.path).toBe('notes/caching.pkf');
  });

  it('empty workspace → { index: null, hubs: [], hubsByRecent: [], nearest: [] } (never a 5xx)', async () => {
    const r = await get(`/local/memory/place-context?workspaceId=${WS}`);
    expect(r.status).toBe(200);
    // memory211/03 §7 B1 — `hubsByRecent[]` is part of the browse contract now
    // (additive; empty set stays an empty array, never absent).
    expect(r.body).toEqual({ index: null, hubs: [], hubsByRecent: [], nearest: [] });
  });
});
