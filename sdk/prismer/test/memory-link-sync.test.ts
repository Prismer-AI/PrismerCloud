// M-LINK-SYNC (daemon side) — syncLinksFromCloud, exercised end-to-end via the
// public initialSyncFromCloud entry (the link sync is its non-blocking tail).
//
// We drive a CloudClient whose fetchImpl dispatches by URL: `/memory/pages`
// returns the page list; `/memory/links/sync` returns the link payload. After a
// sync we assert against a REAL MemoryStore (better-sqlite3) — no store mocks.
//
// Coverage:
//   ① after sync, the local `memory_links` table holds the cloud link, and
//      graph traversal (linkNeighbors + MemorySearch.hybrid) recovers the
//      keyword-miss neighbor page (sync → graph end-to-end).
//   ② idempotent: a second identical pull writes no duplicate edge
//      (upsertLink keys on (workspace, sourceUri, targetUri, relation)).
//   ③ link-sync failure (cloud 500 on /links/sync) does NOT regress the page
//      sync — pages still land; it's swallowed as non-blocking.
//   ④ a row missing sourceUri/targetUri is skipped, never written.
//   ⑤ broken-edge guard: a `broken: true` row in the cloud payload is NOT
//      written to memory_links, so the graph never traverses it.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudClient } from '../src/auth.js';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { initialSyncFromCloud } from '../src/daemon/memory/cloud-sync.js';
import { MemorySearch } from '../src/daemon/memory/search.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'prismer-link-sync-'));
}

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface MockPage {
  id: string;
  path: string;
  pageType?: string;
  visibility?: string;
  title?: string | null;
  content?: string | null;
}

interface MockLink {
  sourcePageId?: string | null;
  sourceUri?: string | null;
  targetUri?: string | null;
  relation?: string | null;
  weight?: number | null;
  broken?: boolean | null;
}

/**
 * Build a CloudClient that dispatches by URL: pages-list vs links/sync. An
 * optional `linksStatus` lets a test force the /links/sync call to fail while
 * the page list still succeeds. `counters` records how many times each surface
 * was hit (for the idempotency test).
 */
function cloudWith(opts: {
  pages: MockPage[];
  links: MockLink[];
  linksStatus?: number;
  counters?: { pages: number; links: number };
}): CloudClient {
  return new CloudClient({
    apiKey: 'sk-test',
    baseUrl: 'http://cloud.test',
    fetchImpl: ((url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url ?? '';
      if (urlStr.includes('/memory/links/sync')) {
        if (opts.counters) opts.counters.links++;
        if (opts.linksStatus && opts.linksStatus >= 400) {
          return Promise.resolve(
            mockResponse(opts.linksStatus, { ok: false, error: { code: 'e', message: 'mock link error' } }),
          );
        }
        return Promise.resolve(mockResponse(200, { ok: true, data: opts.links }));
      }
      // Page list (and page-detail) endpoint.
      if (opts.counters) opts.counters.pages++;
      return Promise.resolve(mockResponse(200, { ok: true, data: opts.pages }));
    }) as unknown as typeof fetch,
  });
}

// Two pages where only `auth.md` matches "OAuth"; `session.md` is the
// keyword-miss neighbor recovered through the synced link.
const PAGES: MockPage[] = [
  { id: 'p_auth', path: 'auth.md', pageType: 'decision', visibility: 'workspace', title: 'Auth', content: 'We chose OAuth over SAML.' },
  { id: 'p_session', path: 'session.md', pageType: 'leaf', visibility: 'workspace', title: 'Session', content: 'cookie rotation and refresh policy' },
];

// Daemon graph keys on `<scheme>://<path>` URIs (pathFromMemoryUri); use the
// pkm:// form so the synced edge resolves to the page paths above.
const LINK_AUTH_SESSION: MockLink = {
  sourcePageId: 'p_auth',
  sourceUri: 'pkm://auth.md',
  targetUri: 'pkm://session.md',
  relation: 'markdown',
  weight: 1,
  broken: false,
};

describe('M-LINK-SYNC (daemon) — syncLinksFromCloud', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  // ① sync → graph end-to-end.
  it('① writes cloud links locally; graph recovers the keyword-miss neighbor', async () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_test' });
    runtime.resolve('ws_test');

    const cloud = cloudWith({ pages: PAGES, links: [LINK_AUTH_SESSION] });
    const result = await initialSyncFromCloud(runtime, cloud, 'ws_test');
    expect(result.pulled).toBe(2);

    const slot = runtime.peek('ws_test')!;

    // (a) the link landed: linkNeighbors of auth.md includes session.md.
    const neighbors = slot.store.linkNeighbors(['auth.md']);
    expect(neighbors.map((n) => n.path)).toContain('session.md');

    // (b) end-to-end: hybrid search recovers session.md via the graph layer.
    const ftsOnly = new MemorySearch(slot.store).hybrid('OAuth', { graph: false });
    expect(ftsOnly.map((r) => r.path)).toEqual(['auth.md']);

    const composite = new MemorySearch(slot.store).hybrid('OAuth');
    const recovered = composite.find((r) => r.path === 'session.md');
    expect(recovered).toBeTruthy();
    expect(recovered?.via).toBe('graph');
  });

  // ② idempotent re-pull → no duplicate edge.
  it('② re-pulling identical links writes no duplicate edge', async () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_test' });
    runtime.resolve('ws_test');
    const slot = runtime.peek('ws_test')!;

    const cloud = cloudWith({ pages: PAGES, links: [LINK_AUTH_SESSION] });
    await initialSyncFromCloud(runtime, cloud, 'ws_test');
    await initialSyncFromCloud(runtime, cloud, 'ws_test'); // second pull, same payload

    // Count rows directly — upsert on the @unique key must not duplicate.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (slot.store as any).requireDb();
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM memory_links WHERE workspaceId = ?')
      .get('ws_test') as { n: number };
    expect(row.n).toBe(1);

    // And the neighbor still resolves exactly once.
    const neighbors = slot.store.linkNeighbors(['auth.md']);
    expect(neighbors.filter((n) => n.path === 'session.md').length).toBe(1);
  });

  // ③ link-sync failure must not regress the page sync.
  it('③ a /links/sync failure does not regress the page sync', async () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_test' });
    runtime.resolve('ws_test');

    const cloud = cloudWith({ pages: PAGES, links: [LINK_AUTH_SESSION], linksStatus: 500 });
    const result = await initialSyncFromCloud(runtime, cloud, 'ws_test');

    // Pages still landed despite the link surface 500ing.
    expect(result.pulled).toBe(2);
    const slot = runtime.peek('ws_test')!;
    expect(slot.store.loadByPath('auth.md')).not.toBeNull();
    expect(slot.store.loadByPath('session.md')).not.toBeNull();

    // No links written → graph layer is inert, FTS still works.
    expect(slot.store.linkNeighbors(['auth.md'])).toHaveLength(0);
  });

  // ④ malformed row (missing URIs) is skipped, never written.
  it('④ skips link rows missing source/target URIs', async () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_test' });
    runtime.resolve('ws_test');

    const cloud = cloudWith({
      pages: PAGES,
      links: [
        { sourcePageId: 'p_auth', sourceUri: 'pkm://auth.md', targetUri: null }, // missing target
        { sourcePageId: 'p_auth', sourceUri: null, targetUri: 'pkm://session.md' }, // missing source
        LINK_AUTH_SESSION, // the one good row
      ],
    });
    await initialSyncFromCloud(runtime, cloud, 'ws_test');

    const slot = runtime.peek('ws_test')!;
    // Only the well-formed edge survives.
    const neighbors = slot.store.linkNeighbors(['auth.md']);
    expect(neighbors.map((n) => n.path)).toEqual(['session.md']);
  });

  // ⑤ broken-edge guard — broken rows are dropped at sync, never traversed.
  it('⑤ broken edges are not written and never surface in the graph', async () => {
    const dir = tmpDir();
    cleanup.push(dir);
    const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_test' });
    runtime.resolve('ws_test');

    const cloud = cloudWith({
      pages: PAGES,
      links: [
        { ...LINK_AUTH_SESSION, targetUri: 'pkm://session.md', broken: true }, // broken auth→session
      ],
    });
    await initialSyncFromCloud(runtime, cloud, 'ws_test');

    const slot = runtime.peek('ws_test')!;
    // Broken edge dropped at sync → no neighbor, graph can't recover session.md.
    expect(slot.store.linkNeighbors(['auth.md'])).toHaveLength(0);
    const composite = new MemorySearch(slot.store).hybrid('OAuth');
    expect(composite.some((r) => r.path === 'session.md')).toBe(false);
  });
});
