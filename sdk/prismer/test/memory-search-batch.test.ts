// memory211/01 §3 轴C W1a — batch recall on GET /local/memory/search.
//
// What this proves:
//   ① `queries` (JSON array) returns one grouped entry per query, in order.
//   ② Legacy compat: `query`/`results` stay the FIRST query's, so an old
//      consumer reading only those two fields sees today's shape unchanged.
//   ③ >8 queries are cut to 8 with `truncated: true` (spec open ruling point 1
//      default).
//   ④ Single `q` = a ONE-ELEMENT batch: `resultsByQuery` is ALWAYS present, and
//      `truncated` shows up only when the input actually exceeded the cap
//      (never for a single query).
//   ⑤ Malformed / empty `queries` is a 400, never a 5xx.
//   ⑥ The F5 visibility predicate still applies per batched query.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap, mintSystemCap } from '../src/daemon/memory/cap.js';

const WS = 'ws_batch';

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

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-memory-batch-'));
  cleanupDirs.push(dir);
  cap = mintCap('im_batch', WS);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  server = new LocalServer({
    port: 0,
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime, deviceId: 'dev_x' }),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);

  const slot = runtime.resolve(WS);
  slot.store.write({
    workspaceId: WS,
    path: 'decisions/auth.md',
    content: 'We chose OAuth over SAML for the auth flow.',
    title: 'Auth decision',
    pageType: 'decision',
    actorImUserId: 'im_batch',
    actorKind: 'human',
  });
  slot.store.write({
    workspaceId: WS,
    path: 'notes/billing.md',
    content: 'Stripe billing runs monthly for the workspace.',
    title: 'Billing',
    pageType: 'leaf',
    actorImUserId: 'im_batch',
    actorKind: 'human',
  });
  slot.store.write({
    workspaceId: WS,
    path: 'notes/private-other.md',
    content: 'Another agent private note about zebra quotas.',
    title: 'Private',
    pageType: 'leaf',
    visibility: { kind: 'agent', imUserId: 'im_someone_else' },
    actorImUserId: 'im_someone_else',
    actorKind: 'agent',
  });
}, 20_000);

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

async function search(rawQueries: string, capOverride?: string): Promise<{ status: number; body: any }> {
  const url =
    `${baseUrl}/local/memory/search?workspaceId=${WS}` +
    `&queries=${encodeURIComponent(rawQueries)}`;
  const res = await fetch(url, {
    headers: { 'x-prismer-memory-cap': capOverride ?? cap },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('memory211 W1a — batch recall', () => {
  it('① groups one entry per query, in request order', async () => {
    const r = await search(JSON.stringify(['OAuth', 'Stripe billing']));
    expect(r.status).toBe(200);
    const groups = r.body.resultsByQuery as Array<{ query: string; results: Array<{ path: string }> }>;
    expect(groups.map((g) => g.query)).toEqual(['OAuth', 'Stripe billing']);
    expect(groups[0].results.map((h) => h.path)).toContain('decisions/auth.md');
    expect(groups[1].results.map((h) => h.path)).toContain('notes/billing.md');
    // Each hit carries the W1a hop-decision payload end to end.
    const hit = groups[0].results.find((h) => h.path === 'decisions/auth.md')!;
    expect(hit.tier).toBe('wiki');
    expect(hit.pagePath).toBe('decisions/auth.md');
    expect(typeof hit.inboundLinkCount).toBe('number');
    expect(Array.isArray(hit.outboundPreview)).toBe(true);
  });

  it('② query/results stay the FIRST query (legacy consumer shape)', async () => {
    const r = await search(JSON.stringify(['OAuth', 'Stripe billing']));
    expect(r.body.query).toBe('OAuth');
    expect((r.body.results as Array<{ path: string }>).map((h) => h.path)).toContain(
      'decisions/auth.md',
    );
    expect(r.body.truncated).toBeUndefined();
  });

  it('③ more than 8 queries is sliced to 8 and flagged truncated', async () => {
    const queries = Array.from({ length: 11 }, (_, i) => `query number ${i}`);
    const r = await search(JSON.stringify(queries));
    expect(r.status).toBe(200);
    const groups = r.body.resultsByQuery as Array<{ query: string }>;
    expect(groups).toHaveLength(8);
    expect(groups.map((g) => g.query)).toEqual(queries.slice(0, 8));
    expect(r.body.truncated).toBe(true);
  });

  it('④ exactly 8 queries is NOT flagged truncated', async () => {
    const queries = Array.from({ length: 8 }, (_, i) => `boundary query ${i}`);
    const r = await search(JSON.stringify(queries));
    expect(r.status).toBe(200);
    expect(r.body.resultsByQuery).toHaveLength(8);
    expect(r.body.truncated).toBeUndefined();
  });

  it('⑤ single q is expressed as a batch of one (no truncated flag)', async () => {
    const res = await fetch(`${baseUrl}/local/memory/search?workspaceId=${WS}&q=OAuth`, {
      headers: { 'x-prismer-memory-cap': cap },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.query).toBe('OAuth');
    // One uniform shape: a single query IS a batch of one, so the grouped field
    // is always present (only `truncated` is conditional).
    const groups = body.resultsByQuery as Array<{ query: string; results: unknown[] }>;
    expect(groups).toHaveLength(1);
    expect(groups[0].query).toBe('OAuth');
    expect(body.results).toEqual(groups[0].results);
    expect(body.truncated).toBeUndefined();
  });

  it('⑤b malformed / empty queries is a 400 with a message (never a 5xx)', async () => {
    expect((await search('not-json')).status).toBe(400);
    expect((await search(JSON.stringify('a-string'))).status).toBe(400);
    expect((await search(JSON.stringify([]))).status).toBe(400);
    expect((await search(JSON.stringify([42]))).status).toBe(400);
    expect((await search(JSON.stringify(['   ']))).status).toBe(400);
    const bad = await search('not-json');
    expect(bad.body.error).toBe('invalid_request');
  });

  it('⑥ the visibility boundary predicate holds for every batched query', async () => {
    const r = await search(JSON.stringify(['zebra quotas', 'OAuth']));
    expect(r.status).toBe(200);
    const groups = r.body.resultsByQuery as Array<{ query: string; results: Array<{ path: string }> }>;
    // The other agent's private page is filtered even though it is the only hit
    // for its query: the group stays, the leaked row does not.
    expect(groups[0].query).toBe('zebra quotas');
    expect(groups[0].results).toEqual([]);
    // ...and a system cap (no workspace default) still needs the ws param.
    const sys = await fetch(`${baseUrl}/local/memory/search?queries=${encodeURIComponent('["x"]')}`, {
      headers: { 'x-prismer-memory-cap': mintSystemCap() },
    });
    expect(sys.status).toBe(400);
  });
});
