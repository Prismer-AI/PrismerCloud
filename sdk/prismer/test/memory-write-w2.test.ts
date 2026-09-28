// memory203/18 W2 DAEMON lane — P0 path/URI normalization, R1.4 write-time
// 回源, R6.4 section-level write, R6.3 placement guard (ramp).
//
// What this proves:
//   1. P0 — memoryPathToUri/normalizeMemoryPath: a page path (or parentHubPath)
//      that ALREADY starts with `memory/` no longer doubles the URI prefix
//      (`…/memory/memory/…` was silently dropped cloud-side, W1-gate 3/3 →
//      0 rows). The link.upsert envelope additionally carries plain
//      `sourcePath`/`targetPath`. NEGATIVE CONTROL: un-prefixed paths keep the
//      W1 envelope shape byte-for-byte (plus the additive plain-path fields).
//   2. R1.4 — a write to a path that is absent locally (or local-only) first
//      回源s the cloud head; the local row ADOPTS the cloud version so the
//      outbox `memory.page.upsert` carries parentVersion=cloudHead (4), not 0.
//      NEGATIVE CONTROL: offline → fail-open, parentVersion=0 as today.
//   3. R6.4 — op=append-section/rewrite-section forwards to the CLOUD section
//      verbs (POST /pages/:id/sections/append|rewrite) and does NOT emit a
//      memory.page.upsert outbox event (the cloud write is authoritative —
//      no double-apply); the local subset copy refreshes from the cloud
//      response. Validation: unknown op → 400; section op without section →
//      400; offline → explicit 503 section_write_requires_cloud.
//   4. R6.3 — placement guard via PRISMER_MEMORY_PLACEMENT_ENFORCE:
//      off → W1 behaviour; warn → write succeeds + placementWarn counter;
//      enforce (DEFAULT) → 422 placement_required with hub candidates.
//      NEGATIVE CONTROLS for both modes (anchored writes always pass).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { withDescription } from './_helpers/pkf-description.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import {
  memoryPathToUri,
  normalizeMemoryPath,
  memoryPathLookupVariants,
} from '../src/daemon/memory/store.js';
import {
  getMemoryStageCounters,
  resetMemoryStageCounters,
} from '../src/daemon/memory/hook-server.js';
import { mintCap } from '../src/daemon/memory/cap.js';
import { CloudClient } from '../src/auth.js';

const WS = 'ws_w2_write';

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';
// spec16 §8.1 — fail-closed RPC: the helpers carry the suite's agent cap.
let cap = '';
/** Every cloud request the stub saw: method + url + parsed body. */
let cloudCalls: Array<{ method: string; url: string; body: unknown }> = [];

const baseState: LocalServerState = {
  daemonId: 'dev_w2',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

interface CloudStubOpts {
  /** Page served by GET /memory/resolve (R1.4 回源). Null → miss. */
  resolvePage?: { id: string; path: string; version: number; content: string } | null;
  /** Response `data` for the section verbs. Default: updated page w/ content. */
  sectionResult?: unknown;
  /** Non-2xx status for section verbs (error passthrough test). */
  sectionStatus?: number;
}

function makeCloud(opts: CloudStubOpts = {}): CloudClient {
  return new CloudClient({
    baseUrl: 'http://cloud.test',
    apiKey: 'sk-test',
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      cloudCalls.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/api/im/memory/resolve')) {
        const p = opts.resolvePage;
        if (!p) return json(200, { ok: true, data: { kind: 'page', hit: false, page: null, content: null } });
        return json(200, {
          ok: true,
          data: {
            kind: 'page',
            hit: true,
            page: { id: p.id, path: p.path, title: 'Cloud page', pageType: 'leaf', version: p.version, visibility: 'workspace', encrypted: false },
            content: p.content,
          },
        });
      }
      if (u.includes('/sections/append') || u.includes('/sections/rewrite')) {
        if (opts.sectionStatus && opts.sectionStatus >= 400) {
          return json(opts.sectionStatus, { ok: false, error: { code: 'section_not_found', message: 'nope' } });
        }
        return json(200, { ok: true, data: opts.sectionResult ?? null });
      }
      return json(200, { ok: true, data: {} });
    }) as typeof fetch,
  });
}

function cloudOffline(): CloudClient {
  return new CloudClient({
    baseUrl: 'http://cloud.test',
    apiKey: 'sk-test',
    fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
  });
}

async function startServer(cloud?: CloudClient): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-w2-write-'));
  cleanupDirs.push(dir);
  cap = mintCap('im_agent', WS);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_w2' });
  server = new LocalServer({
    port: 0, // ephemeral — read the real port back after start (O16-b)
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime, cloud, deviceId: 'dev_w2' }),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);
}

beforeEach(() => {
  cloudCalls = [];
  resetMemoryStageCounters();
  // Most cases in this legacy transport suite isolate URI/sync behavior with
  // historical unplaced fixtures. Placement-specific cases override this.
  process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'warn';
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  runtime?.closeAll();
  runtime = undefined;
  resetMemoryStageCounters();
  delete process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE;
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': cap },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const writeBodyRaw = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  workspaceId: WS,
  // memory211/01 轴H ② — a NEW page must carry a frontmatter description; these
  // fixtures predate the gate and test other contracts, so the mandated
  // frontmatter is stamped here once instead of hand-written per body. The gate
  // itself is exercised in memory-write-gates.test.ts.
  path: 'project/desktop/sync.pkf',
  content: '<h1>Sync</h1><p>outbox + checkpoints</p>',
  title: 'Sync protocol',
  actorImUserId: 'im_agent',
  actorKind: 'agent',
  ...overrides,
});

/** Stamps the mandated frontmatter description (轴H ②) onto the fixture body. */
const writeBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const body = writeBodyRaw(overrides);
  const content = typeof body.content === 'string' ? withDescription(body.content) : body.content;
  return { ...body, content };
};

function outboxEnvelopes(eventType: string): Array<Record<string, unknown>> {
  const db = runtime!.resolve(WS).store.rawDb();
  const rows = db
    .prepare('SELECT envelopeJson FROM memory_outbox WHERE eventType = ? ORDER BY createdAt')
    .all(eventType) as Array<{ envelopeJson: string }>;
  return rows.map((r) => JSON.parse(r.envelopeJson) as Record<string, unknown>);
}

// ─── unit: the shared normalizer ────────────────────────────────────────────

describe('P0 — path/URI normalizer (unit)', () => {
  it('normalizeMemoryPath strips leading slashes and memory/ prefixes (idempotent)', () => {
    expect(normalizeMemoryPath('decisions/x.pkf')).toBe('decisions/x.pkf');
    expect(normalizeMemoryPath('memory/decisions/x.pkf')).toBe('decisions/x.pkf');
    expect(normalizeMemoryPath('memory/memory/decisions/x.pkf')).toBe('decisions/x.pkf');
    expect(normalizeMemoryPath('/memory/decisions/x.pkf')).toBe('decisions/x.pkf');
    expect(normalizeMemoryPath(normalizeMemoryPath('memory/a.pkf'))).toBe('a.pkf');
  });

  it('memoryPathToUri never produces …/memory/memory/…', () => {
    expect(memoryPathToUri(WS, 'decisions/x.pkf')).toBe(`prismer://workspace/${WS}/memory/decisions/x.pkf`);
    expect(memoryPathToUri(WS, 'memory/decisions/x.pkf')).toBe(`prismer://workspace/${WS}/memory/decisions/x.pkf`);
  });

  it('memoryPathLookupVariants covers as-given, ±memory/ and ±.pkf, verbatim first', () => {
    const v = memoryPathLookupVariants('memory/decisions/x.pkf');
    expect(v[0]).toBe('memory/decisions/x.pkf'); // verbatim wins when it exists
    expect(v).toContain('decisions/x.pkf');
    expect(v).toContain('decisions/x');
    const v2 = memoryPathLookupVariants('decisions/x');
    expect(v2).toContain('decisions/x.pkf');
    expect(v2).toContain('memory/decisions/x');
  });
});

// ─── P0 through the write RPC ───────────────────────────────────────────────

describe('P0 — link emission URI normalization (handleWrite)', () => {
  it('a memory/-prefixed parentHubPath AND page path emit single-prefix URIs + plain-path fields', async () => {
    await startServer(makeCloud());
    const r = await post('/local/memory/write', writeBody({
      path: 'memory/project/desktop/sync.pkf',
      parentHubPath: 'memory/project/desktop.pkf',
    }));
    expect(r.status).toBe(200);
    const [link] = outboxEnvelopes('memory.link.upsert');
    expect(link).toBeDefined();
    // THE W1 bug: these were prismer://…/memory/memory/… and dropped cloud-side.
    expect(link!.sourceUri).toBe(`prismer://workspace/${WS}/memory/project/desktop/sync.pkf`);
    expect(link!.targetUri).toBe(`prismer://workspace/${WS}/memory/project/desktop.pkf`);
    expect(String(link!.sourceUri)).not.toContain('/memory/memory/');
    expect(String(link!.targetUri)).not.toContain('/memory/memory/');
    // Additive plain-path fields (cloud lane prefers these over URI parsing).
    expect(link!.sourcePath).toBe('project/desktop/sync.pkf');
    expect(link!.targetPath).toBe('project/desktop.pkf');
  });

  it('NEGATIVE CONTROL — un-prefixed paths keep the W1 URI shape (plus additive plain paths)', async () => {
    await startServer(makeCloud());
    const r = await post('/local/memory/write', writeBody({ parentHubPath: 'project/desktop.pkf' }));
    expect(r.status).toBe(200);
    const [link] = outboxEnvelopes('memory.link.upsert');
    expect(link!.sourceUri).toBe(`prismer://workspace/${WS}/memory/project/desktop/sync.pkf`);
    expect(link!.targetUri).toBe(`prismer://workspace/${WS}/memory/project/desktop.pkf`);
    expect(link!.sourcePath).toBe('project/desktop/sync.pkf');
    expect(link!.targetPath).toBe('project/desktop.pkf');
  });

  it('a repeat write under the OTHER path convention extends the SAME page (no namespace fork)', async () => {
    await startServer(makeCloud());
    const r1 = await post('/local/memory/write', writeBody({ path: 'decisions/auth.pkf' }));
    const r2 = await post('/local/memory/write', writeBody({ path: 'memory/decisions/auth.pkf', content: '<h1>v2</h1>' }));
    expect(r2.status).toBe(200);
    expect(r2.body.page.id).toBe(r1.body.page.id);
    expect(r2.body.page.path).toBe('decisions/auth.pkf'); // existing row's path wins
    expect(r2.body.page.version).toBe(2);
  });
});

// ─── R1.4 write-time 回源 ───────────────────────────────────────────────────

describe('R1.4 — write-time 回源 (parentVersion continues the cloud head)', () => {
  it('cloud page at v4 + empty local subset → write emits parentVersion=4, not 0', async () => {
    await startServer(makeCloud({
      resolvePage: { id: 'page_cloud_v4', path: 'decisions/auth.pkf', version: 4, content: '<h1>Auth v4</h1>' },
    }));
    const r = await post('/local/memory/write', writeBody({ path: 'decisions/auth.pkf', content: '<h1>Auth v5</h1>' }));
    expect(r.status).toBe(200);
    // Local row adopted the cloud head (4) then the write bumped it to 5…
    expect(r.body.page.version).toBe(5);
    expect(r.body.page.id).toBe('page_cloud_v4'); // canonical cloud id adopted too
    // …so the outbox upsert continues the cloud chain instead of base-v0.
    const [up] = outboxEnvelopes('memory.page.upsert');
    expect(up!.parentVersion).toBe(4);
    // The 回源 really happened via GET /memory/resolve.
    expect(cloudCalls.some((c) => c.url.includes('/api/im/memory/resolve'))).toBe(true);
  });

  it('NEGATIVE CONTROL — offline 回源 fail-open: write proceeds with parentVersion=0 (as today)', async () => {
    await startServer(cloudOffline());
    const r = await post('/local/memory/write', writeBody({ path: 'decisions/auth.pkf' }));
    expect(r.status).toBe(200);
    expect(r.body.page.version).toBe(1);
    const [up] = outboxEnvelopes('memory.page.upsert');
    expect(up!.parentVersion).toBe(0);
  });

  it('a local hit that is already acked does NOT 回源 (no cloud call for the write)', async () => {
    await startServer(makeCloud({ resolvePage: null }));
    const r1 = await post('/local/memory/write', writeBody({ path: 'local/first.pkf' }));
    expect(r1.status).toBe(200);
    // Mark it acked (as an outbox flush would) — a subsequent write must not回源.
    runtime!.resolve(WS).store.setSyncStatus(r1.body.page.id as string, 'acked');
    cloudCalls = [];
    const r2 = await post('/local/memory/write', writeBody({ path: 'local/first.pkf', content: '<h1>v2</h1>' }));
    expect(r2.status).toBe(200);
    expect(cloudCalls.filter((c) => c.url.includes('/resolve'))).toHaveLength(0);
  });
});

// ─── R6.4 section-level write ───────────────────────────────────────────────

const SECTION_PAGE = {
  workspaceId: WS,
  path: 'decisions/auth.pkf',
  content: '# Auth\n\n## context\n\nold context\n\n## decision\n\nOAuth chosen\n',
  title: 'Auth',
  actorImUserId: 'im_agent',
  actorKind: 'agent',
};

describe('R6.4 — op=append-section / rewrite-section (cloud section verbs)', () => {
  it('unknown op → 400; section op without section → 400', async () => {
    await startServer(makeCloud());
    const r1 = await post('/local/memory/write', writeBody({ op: 'merge' }));
    expect(r1.status).toBe(400);
    const r2 = await post('/local/memory/write', writeBody({ op: 'append-section' }));
    expect(r2.status).toBe(400);
    expect(String(r2.body.message)).toContain('section');
  });

  it('append-section forwards {workspaceId, section, content} to POST /pages/:id/sections/append and emits NO page.upsert', async () => {
    const updated = { id: '', version: 7, content: '# Auth\n\n## context\n\nold context\n\n## decision\n\nOAuth chosen\n\n## rollout\n\nstaged 5/50/100\n' };
    await startServer(makeCloud({ sectionResult: updated }));
    const seeded = await post('/local/memory/write', SECTION_PAGE);
    expect(seeded.status).toBe(200);
    updated.id = seeded.body.page.id;
    const upsertsBefore = outboxEnvelopes('memory.page.upsert').length;

    const r = await post('/local/memory/write', {
      ...SECTION_PAGE,
      op: 'append-section',
      section: 'rollout',
      content: '## rollout\n\nstaged 5/50/100',
    });
    expect(r.status).toBe(200);
    expect(r.body.op).toBe('append-section');

    const call = cloudCalls.find((c) => c.url.includes('/sections/append'));
    expect(call).toBeDefined();
    expect(call!.url).toContain(encodeURIComponent(seeded.body.page.id));
    expect(call!.body).toEqual({ workspaceId: WS, section: 'rollout', content: '## rollout\n\nstaged 5/50/100' });

    // The cloud write is authoritative — NO additional page.upsert was queued
    // (double-apply guard); the local subset refreshed from the cloud response.
    expect(outboxEnvelopes('memory.page.upsert')).toHaveLength(upsertsBefore);
    const slot = runtime!.resolve(WS);
    const local = slot.store.loadByAnyPath('decisions/auth.pkf')!;
    expect(local.version).toBe(7); // adopted the cloud head version
    expect(slot.store.loadContent(local.id)?.content).toContain('staged 5/50/100');
    expect(local.syncStatus).toBe('acked');
  });

  it('rewrite-section forwards to /sections/rewrite; cloud error status passes through', async () => {
    await startServer(makeCloud({ sectionStatus: 404 }));
    await post('/local/memory/write', SECTION_PAGE);
    const r = await post('/local/memory/write', {
      ...SECTION_PAGE,
      op: 'rewrite-section',
      section: 'nonexistent',
      content: 'new body',
    });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('section_not_found');
    expect(cloudCalls.some((c) => c.url.includes('/sections/rewrite'))).toBe(true);
  });

  it('section op on a page missing locally AND in cloud → 404 memory_page_not_found', async () => {
    await startServer(makeCloud({ resolvePage: null }));
    const r = await post('/local/memory/write', {
      ...SECTION_PAGE,
      path: 'never/existed.pkf',
      op: 'append-section',
      section: 'x',
    });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('memory_page_not_found');
  });

  it('NEGATIVE CONTROL — no cloud wired → explicit 503 section_write_requires_cloud (never a silent local no-op)', async () => {
    await startServer(undefined);
    const r = await post('/local/memory/write', {
      ...SECTION_PAGE,
      op: 'append-section',
      section: 'rollout',
    });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('section_write_requires_cloud');
  });

  it('NEGATIVE CONTROL — cloud unreachable + local page present → explicit 5xx passthrough, local page untouched', async () => {
    // Seed while "online" so the page exists locally, then restart offline.
    await startServer(makeCloud());
    const seeded = await post('/local/memory/write', SECTION_PAGE);
    expect(seeded.status).toBe(200);
    const dir = runtime!.resolve(WS).store.stats().dbPath; // keep the same baseDir
    await server!.stop();
    const baseDir = dir!.replace(/\/[^/]+\/memory\.db$/, '');
    runtime!.closeAll();
    runtime = new MemoryRuntime({ baseDir, deviceId: 'dev_w2' });
    server = new LocalServer({
      port: 0, // ephemeral — read the real port back after start (O16-b)
      getState: () => baseState,
      attachMemory: attachMemoryRpc({ runtime, cloud: cloudOffline(), deviceId: 'dev_w2' }),
    });
    await server.start();
    baseUrl = boundBaseUrl(server);

    const before = runtime.resolve(WS).store.loadByAnyPath('decisions/auth.pkf')!;
    const r = await post('/local/memory/write', {
      ...SECTION_PAGE,
      op: 'append-section',
      section: 'rollout',
    });
    // The forward failed (status 0 → 502 passthrough); never a silent 200.
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(r.body.ok).toBe(false);
    // And the local subset was NOT mutated behind the failed cloud write.
    const after = runtime.resolve(WS).store.loadByAnyPath('decisions/auth.pkf')!;
    expect(after.version).toBe(before.version);
    expect(after.contentHash).toBe(before.contentHash);
  });
});

// ─── R6.3 placement guard (ramp) ────────────────────────────────────────────

describe('R6.3 — placement guard (PRISMER_MEMORY_PLACEMENT_ENFORCE=off|warn|enforce)', () => {
  it('enforce (DEFAULT) — an un-anchored NEW leaf is rejected before it can become unclassified', async () => {
    delete process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE;
    await startServer(makeCloud());
    const before = getMemoryStageCounters().placementWarn;
    const r = await post('/local/memory/write', writeBody({ path: 'orphan/leaf.pkf' }));
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('placement_required');
    expect(getMemoryStageCounters().placementWarn).toBe(before);
  });

  it('default enforcement accepts anchored writes (parentHubPath / pageType=hub / child-of content link / existing page)', async () => {
    delete process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE;
    await startServer(makeCloud());
    const before = getMemoryStageCounters().placementWarn;
    await post('/local/memory/write', writeBody({ path: 'a.pkf', parentHubPath: 'hub.pkf' }));
    await post('/local/memory/write', writeBody({ path: 'topics/hub.pkf', pageType: 'hub' }));
    await post('/local/memory/write', writeBody({
      path: 'b.pkf',
      content: `<h1>B</h1><p><a href="${memoryPathToUri(WS, 'topics/hub.pkf')}" rel="child-of">hub</a></p>`,
    }));
    expect(getMemoryStageCounters().placementWarn).toBe(before);
    // Existing-page update (page b exists now) — still no warn.
    await post('/local/memory/write', writeBody({ path: 'b.pkf', content: '<h1>B v2 plain</h1>' }));
    expect(getMemoryStageCounters().placementWarn).toBe(before);
  });

  it('off — NEGATIVE CONTROL: no warn counter, no rejection (W1 behaviour)', async () => {
    process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'off';
    await startServer(makeCloud());
    const before = getMemoryStageCounters().placementWarn;
    const r = await post('/local/memory/write', writeBody({ path: 'orphan/leaf2.pkf' }));
    expect(r.status).toBe(200);
    expect(getMemoryStageCounters().placementWarn).toBe(before);
  });

  it('enforce — an un-anchored NEW leaf is rejected 422 placement_required with hub candidates', async () => {
    process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'enforce';
    await startServer(makeCloud());
    // Seed a hub so the rejection can offer candidates.
    await post('/local/memory/write', writeBody({ path: 'topics/desktop.pkf', pageType: 'hub', content: '<h1>Desktop</h1>' }));
    const r = await post('/local/memory/write', writeBody({ path: 'orphan/leaf3.pkf' }));
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('placement_required');
    expect(r.body.code).toBe('placement_required');
    expect(Array.isArray(r.body.hubs)).toBe(true);
    expect(r.body.hubs.map((h: { path: string }) => h.path)).toContain('topics/desktop.pkf');
    expect(String(r.body.message)).toContain('parentHubPath');
    // Nothing was written and nothing queued.
    expect(runtime!.resolve(WS).store.loadByAnyPath('orphan/leaf3.pkf')).toBeNull();
  });

  it('enforce — NEGATIVE CONTROL: the same write WITH parentHubPath passes', async () => {
    process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'enforce';
    await startServer(makeCloud());
    await post('/local/memory/write', writeBody({ path: 'topics/desktop.pkf', pageType: 'hub', content: '<h1>Desktop</h1>' }));
    const r = await post('/local/memory/write', writeBody({ path: 'orphan/leaf4.pkf', parentHubPath: 'topics/desktop.pkf' }));
    expect(r.status).toBe(200);
    expect(outboxEnvelopes('memory.link.upsert').length).toBeGreaterThan(0);
  });
});
