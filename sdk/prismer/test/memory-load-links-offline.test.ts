// memory211/01 §3 轴C W1a — load 离线 links.
//
// GET /local/memory/load used to attach `links` ONLY when the cloud answered;
// offline the field silently vanished, so 「顺着索引往下看」 died with the
// network. What this proves:
//   ① cloud unreachable → links come from the LOCAL `memory_links` mirror, in
//      the cloud `{ outbound, backlinks }` envelope.
//   ② cloud non-2xx → same local fallback (an authoritative "no" from the
//      cloud is different from an unreachable cloud — but the local table is
//      still the best available read; asserted below).
//   ③ an authoritative cloud ANSWER is never overridden by the local table.
//   ④ no cloud wired at all (unit wiring) → local links, never a 5xx.
//   ⑤ MUTATION TARGET: deleting the `if (links === undefined) links = …`
//      fallback turns ①/④ red (links disappears again).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudClient } from '../src/auth.js';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap } from '../src/daemon/memory/cap.js';

const WS = 'ws_links';

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

/** Cloud that 500s the links route but resolves pages normally. */
function cloudLinksErroring(counter: { linksCalls: number }): CloudClient {
  return new CloudClient({
    apiKey: 'sk-test',
    baseUrl: 'http://cloud.test',
    fetchImpl: ((url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
      if (u.includes('/links?workspaceId=')) {
        counter.linksCalls++;
        return Promise.resolve({
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ ok: false, error: { code: 'boom' } }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, data: {} }),
      } as unknown as Response);
    }) as unknown as typeof fetch,
  });
}

/** Cloud that serves the links route authoritatively (counted). */
function cloudLinksOk(counter: { linksCalls: number }, payload: unknown): CloudClient {
  return new CloudClient({
    apiKey: 'sk-test',
    baseUrl: 'http://cloud.test',
    fetchImpl: ((url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
      if (u.includes('/links?workspaceId=')) {
        counter.linksCalls++;
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, data: payload }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, data: {} }),
      } as unknown as Response);
    }) as unknown as typeof fetch,
  });
}

/** Cloud whose every request rejects (transport-level offline). */
function cloudOffline(): CloudClient {
  return new CloudClient({
    apiKey: 'sk-test',
    baseUrl: 'http://cloud.test',
    fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
  });
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-load-links-'));
  cleanupDirs.push(dir);
  cap = mintCap('im_a', WS);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  runtime?.closeAll();
  runtime = undefined;
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function startServer(cloud?: CloudClient): Promise<void> {
  server = new LocalServer({
    port: 0,
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime: runtime!, cloud }),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);
}

/** Seed a hub→leaf tree edge + a backlink edge locally. */
function seedTree(): void {
  const store = runtime!.resolve(WS).store;
  store.write({
    workspaceId: WS,
    path: 'hubs/auth.md',
    content: 'Authentication hub.',
    title: 'Auth hub',
    pageType: 'hub',
    actorImUserId: 'im_a',
    actorKind: 'human',
  });
  store.write({
    workspaceId: WS,
    path: 'leaves/rotation.md',
    content: 'Rotate tokens every seven days.',
    title: 'Rotation',
    pageType: 'leaf',
    actorImUserId: 'im_a',
    actorKind: 'human',
  });
  // leaves/rotation.md --child-of--> hubs/auth.md (outbound from the leaf,
  // backlink onto the hub).
  store.upsertLink({
    sourceUri: 'pkm://leaves/rotation.md',
    targetUri: 'pkm://hubs/auth.md',
    relation: 'child-of',
    weight: 1,
    extractedFromPageId: null,
  });
}

async function load(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(
    `${baseUrl}/local/memory/load?workspaceId=${WS}&path=${encodeURIComponent(path)}`,
    { headers: { 'x-prismer-memory-cap': cap } },
  );
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('memory211 W1a — load offline links', () => {
  it('① cloud unreachable → links served from the local mirror', async () => {
    await startServer(cloudOffline());
    seedTree();
    const r = await load('leaves/rotation.md');
    expect(r.status).toBe(200);
    const links = r.body.links;
    expect(links).toBeDefined();
    expect(links.outbound).toEqual([
      {
        sourceUri: 'pkm://leaves/rotation.md',
        targetUri: 'pkm://hubs/auth.md',
        sourcePageId: expect.any(String),
        targetPageId: expect.any(String),
        relation: 'child-of',
        weight: 1,
        sourceSection: null,
        targetSection: null,
        updatedAt: expect.any(String),
      },
    ]);
    expect(links.backlinks).toEqual([]);
  });

  it('①b the same envelope read from the HUB side yields the backlink', async () => {
    await startServer(cloudOffline());
    seedTree();
    const r = await load('hubs/auth.md');
    expect(r.status).toBe(200);
    expect(r.body.links.outbound).toEqual([]);
    expect(r.body.links.backlinks).toHaveLength(1);
    expect(r.body.links.backlinks[0]).toMatchObject({
      relation: 'child-of',
      sourceUri: 'pkm://leaves/rotation.md',
      targetUri: 'pkm://hubs/auth.md',
    });
  });

  it('② cloud answers non-2xx → local fallback (never a 5xx, never a missing field)', async () => {
    const counter = { linksCalls: 0 };
    await startServer(cloudLinksErroring(counter));
    seedTree();
    const r = await load('leaves/rotation.md');
    expect(r.status).toBe(200);
    expect(counter.linksCalls).toBe(1);
    expect(r.body.links.outbound).toHaveLength(1);
    expect(r.body.links.outbound[0].relation).toBe('child-of');
  });

  it('③ an authoritative cloud answer is NEVER overridden by the local table', async () => {
    const counter = { linksCalls: 0 };
    const cloudPayload = { outbound: [{ relation: 'references', fromCloud: true }], backlinks: [] };
    await startServer(cloudLinksOk(counter, cloudPayload));
    seedTree();
    const r = await load('leaves/rotation.md');
    expect(r.status).toBe(200);
    expect(counter.linksCalls).toBe(1);
    expect(r.body.links).toEqual(cloudPayload);
  });

  it('④ no cloud wired → local links, load still 200', async () => {
    await startServer(undefined);
    seedTree();
    const r = await load('leaves/rotation.md');
    expect(r.status).toBe(200);
    expect(r.body.links.outbound).toHaveLength(1);
  });

  it('⑤ a page with no edges gets empty groups (shape-stable)', async () => {
    await startServer(cloudOffline());
    const store = runtime!.resolve(WS).store;
    store.write({
      workspaceId: WS,
      path: 'lonely.md',
      content: 'No edges here.',
      pageType: 'leaf',
      actorImUserId: 'im_a',
      actorKind: 'human',
    });
    const r = await load('lonely.md');
    expect(r.status).toBe(200);
    expect(r.body.links).toEqual({ outbound: [], backlinks: [] });
  });
});
