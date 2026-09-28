// memory203/18 R1.1 + R8.1 + R1.3 — structural placement on the agent write
// path, traceId propagation into the outbox envelopes, and promote_to_hub
// childPaths pass-through.
//
// What this proves:
//   1. R1.1 — POST /local/memory/write with `parentHubPath` enqueues a
//      `memory.link.upsert` GRAPH event (source=written page, target=hub,
//      relation from body) alongside the page upsert, mirroring the
//      auto-extract leg. NEGATIVE CONTROL: a write WITHOUT parentHubPath must
//      enqueue ZERO link events (the old behavior — page.upsert only).
//   2. R1.1 hub-missing lenience: a parentHubPath that does not exist locally
//      STILL emits the link (cloud resolves / marks broken) — fail-open in W1;
//      the fail-closed guardrail is R6.3 (W2), gated on browse being live.
//   3. R8.1 — a caller-supplied `traceId` lands verbatim on BOTH envelopes
//      (page.upsert + link.upsert); without one the daemon mints a `wr_…` id.
//      NEGATIVE CONTROL: pre-R8.1 envelopes had NO traceId field at all.
//   4. R1.3 — memory_curate promote_to_hub forwards `childPaths` verbatim to
//      the cloud POST body. NEGATIVE CONTROL: absent childPaths → field absent.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { withDescription } from './_helpers/pkf-description.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap } from '../src/daemon/memory/cap.js';
import { MemoryOutbox, type EnqueueResult } from '../src/daemon/memory/outbox.js';
import { MemoryStore } from '../src/daemon/memory/store.js';
import { CloudClient } from '../src/auth.js';
import { canonicalDurabilityCommitKey } from '../src/adapters/coding/shared/lifecycle/canonical-turn-identity.js';

const WS = 'ws_place_write';

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';
// spec16 §8.1 — fail-closed RPC: the post helper carries the suite's agent cap.
let cap = '';
let cloudBodies: Array<{ url: string; body: unknown }> = [];
let durabilityRun: {
  providerSessionId: string;
  taskId: string;
  workspaceId: string;
  agentImUserId: string;
} | null = null;
let stagedExplicitReceipts: Array<{
  providerSessionId: string;
  workspaceId: string;
  agentImUserId: string;
  receipt: { pageId: string; path: string; version: number; contentHash: string; authority?: string };
}> = [];

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
  // This R1 transport suite retains its explicit no-parent negative control;
  // production-default enforcement is locked separately by W2 tests.
  process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'warn';
  const dir = mkdtempSync(join(tmpdir(), 'prismer-write-placement-'));
  cleanupDirs.push(dir);
  cloudBodies = [];
  durabilityRun = null;
  stagedExplicitReceipts = [];
  cap = mintCap('im_agent', WS);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  // Capturing cloud stub — used only by the curate forward (R1.3).
  const cloud = new CloudClient({
    baseUrl: 'http://cloud.test',
    apiKey: 'sk-test',
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      cloudBodies.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ ok: true, data: { promoted: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });
  server = new LocalServer({
    port: 0, // ephemeral — read the real port back after start (O16-b)
    getState: () => baseState,
    attachMemory: attachMemoryRpc({
      runtime,
      cloud,
      deviceId: 'dev_x',
      resolveDurabilityRun: (providerSessionId) =>
        durabilityRun?.providerSessionId === providerSessionId ? durabilityRun : null,
      recordExplicitMemoryReceipt: (input) => stagedExplicitReceipts.push(input),
    }),
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

/** Read the pending outbox envelopes (parsed) for a given eventType. */
function outboxEnvelopes(eventType: string): Array<Record<string, unknown>> {
  const db = runtime!.resolve(WS).store.rawDb();
  const rows = db
    .prepare('SELECT envelopeJson FROM memory_outbox WHERE eventType = ? ORDER BY createdAt')
    .all(eventType) as Array<{ envelopeJson: string }>;
  return rows.map((r) => JSON.parse(r.envelopeJson) as Record<string, unknown>);
}

describe('R1.1 — memory.write structural placement (parentHubPath)', () => {
  it('write with parentHubPath enqueues a child-of memory.link.upsert mirroring the auto-extract leg', async () => {
    // Seed the hub so the local existence check passes.
    await post('/local/memory/write', writeBody({ path: 'project/desktop.pkf', content: '<h1>Desktop</h1>', pageType: 'hub' }));
    const r = await post('/local/memory/write', writeBody({ parentHubPath: 'project/desktop.pkf' }));
    expect(r.status).toBe(200);
    expect(r.body.page.path).toBe('project/desktop/sync.pkf');
    // Additive echo so the calling tool can confirm the edge was queued.
    expect(r.body.link).toEqual({ targetPath: 'project/desktop.pkf', relation: 'child-of' });

    const links = outboxEnvelopes('memory.link.upsert');
    expect(links).toHaveLength(1);
    expect(links[0]!.sourceUri).toBe(`prismer://workspace/${WS}/memory/project/desktop/sync.pkf`);
    expect(links[0]!.targetUri).toBe(`prismer://workspace/${WS}/memory/project/desktop.pkf`);
    expect(links[0]!.relation).toBe('child-of');
    expect(links[0]!.extractedFromPageId).toBe(r.body.page.id);
  });

  it('relation=related is honored; anything else falls back to child-of', async () => {
    const r1 = await post(
      '/local/memory/write',
      writeBody({ path: 'a.pkf', parentHubPath: 'hub.pkf', relation: 'related' }),
    );
    expect(r1.body.link.relation).toBe('related');
    const r2 = await post(
      '/local/memory/write',
      writeBody({ path: 'b.pkf', parentHubPath: 'hub.pkf', relation: 'contradicts' }),
    );
    expect(r2.body.link.relation).toBe('child-of');
    const relations = outboxEnvelopes('memory.link.upsert').map((l) => l.relation);
    expect(relations).toContain('related');
    expect(relations).toContain('child-of');
  });

  it('a locally-missing hub STILL emits the link (cloud resolves; W1 is fail-open, R6.3 gates later)', async () => {
    const r = await post(
      '/local/memory/write',
      writeBody({ parentHubPath: 'project/nonexistent-hub.pkf' }),
    );
    expect(r.status).toBe(200);
    const links = outboxEnvelopes('memory.link.upsert');
    expect(links).toHaveLength(1);
    expect(links[0]!.targetUri).toBe(`prismer://workspace/${WS}/memory/project/nonexistent-hub.pkf`);
  });

  it('NEGATIVE CONTROL — a write WITHOUT parentHubPath enqueues ZERO link events (legacy shape unchanged)', async () => {
    const r = await post('/local/memory/write', writeBody());
    expect(r.status).toBe(200);
    expect(r.body.link).toBeUndefined();
    expect(outboxEnvelopes('memory.link.upsert')).toHaveLength(0);
    // …while the page upsert itself was queued as before.
    expect(outboxEnvelopes('memory.page.upsert')).toHaveLength(1);
  });
});

describe('R8.1 — traceId propagation into outbox envelopes', () => {
  it('a caller-supplied traceId lands verbatim on BOTH page.upsert and link.upsert', async () => {
    const r = await post(
      '/local/memory/write',
      writeBody({ parentHubPath: 'hub.pkf', traceId: 'run_42-abcd1234' }),
    );
    expect(r.status).toBe(200);
    const [page] = outboxEnvelopes('memory.page.upsert');
    const [link] = outboxEnvelopes('memory.link.upsert');
    expect(page!.traceId).toBe('run_42-abcd1234');
    expect(link!.traceId).toBe('run_42-abcd1234');
  });

  it('without a caller traceId the daemon mints a wr_-prefixed one (never an envelope without the field)', async () => {
    await post('/local/memory/write', writeBody());
    const [page] = outboxEnvelopes('memory.page.upsert');
    // NEGATIVE CONTROL for the zod seam: pre-R8.1 the envelope schema stripped
    // unknown fields, so traceId would be undefined here — the field surviving
    // the parse proves envelope.ts carries it.
    expect(typeof page!.traceId).toBe('string');
    expect(page!.traceId as string).toMatch(/^wr_[0-9a-f]{10}$/);
  });
});

describe('R1.3 — memory_curate promote_to_hub childPaths pass-through', () => {
  it('childPaths forwards verbatim in the cloud POST body', async () => {
    const r = await post('/local/memory/curate', {
      workspaceId: WS,
      op: 'promote_to_hub',
      pageId: 'page_x',
      childPaths: ['a.pkf', 'b.pkf'],
    });
    expect(r.status).toBe(200);
    const call = cloudBodies.find((c) => c.url.includes('/promote-to-hub'));
    expect(call).toBeDefined();
    expect((call!.body as Record<string, unknown>).childPaths).toEqual(['a.pkf', 'b.pkf']);
  });

  it('NEGATIVE CONTROL — no childPaths → the field is ABSENT from the cloud body (legacy shape)', async () => {
    const r = await post('/local/memory/curate', {
      workspaceId: WS,
      op: 'promote_to_hub',
      pageId: 'page_x',
    });
    expect(r.status).toBe(200);
    const call = cloudBodies.find((c) => c.url.includes('/promote-to-hub'));
    expect(call).toBeDefined();
    expect('childPaths' in (call!.body as Record<string, unknown>)).toBe(false);
  });
});

// ─── M-OUTBOX-001 / spec16 §10.2 — write/outbox atomicity ───────────────────
//
// The page aggregate (page/version/content/FTS) and its outbox events must
// exist together or not at all: an outbox enqueue failure must roll the whole
// aggregate back AND the RPC must not return success. Fault injection uses a
// real MemoryOutbox subclass that performs the REAL SQLite insert and then
// throws — the rollback assertion is therefore against real committed writes,
// and the oracle is a real store/DB query (not a mock counter).

/**
 * Real-enqueue-then-throw fault injector. `failOnCall` selects which enqueue
 * call fails (1 = page upsert, 2 = link upsert when parentHubPath present).
 * The insert REALLY executes inside the caller's transaction before the throw,
 * so a green rollback assertion proves the transaction undoes real DB writes.
 */
class FaultInjectingOutbox extends MemoryOutbox {
  private calls = 0;
  constructor(
    store: MemoryStore,
    private readonly failOnCall: number,
  ) {
    super({ store });
  }
  enqueue(event: unknown): EnqueueResult {
    this.calls += 1;
    const result = super.enqueue(event);
    if (this.calls === this.failOnCall) {
      throw new Error(`injected outbox failure on enqueue call ${this.calls}`);
    }
    return result;
  }
}

/** DB-terminal-state oracle: counts every table the write aggregate touches. */
function aggregateCounts(): { pages: number; versions: number; content: number; fts: number; outbox: number } {
  const db = runtime!.resolve(WS).store.rawDb();
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    pages: count('memory_pages'),
    versions: count('memory_page_versions'),
    content: count('memory_page_content'),
    fts: count('memory_fts'),
    outbox: count('memory_outbox'),
  };
}

const ZERO_AGGREGATE = { pages: 0, versions: 0, content: 0, fts: 0, outbox: 0 };

describe('M-OUTBOX-001 — §10.2 write/outbox atomicity', () => {
  it('binds an exact provider session write to this turn canonical durability commit key', async () => {
    durabilityRun = {
      providerSessionId: 'provider_session_exact',
      taskId: 'run_cloud_exact',
      workspaceId: WS,
      agentImUserId: 'im_agent',
    };
    const r = await post('/local/memory/write', writeBody({
      providerSessionId: 'provider_session_exact',
      durabilityReceiptIndex: 0,
    }));

    expect(r.status).toBe(200);
    const [event] = outboxEnvelopes('memory.page.upsert');
    expect(event!.idempotencyKey).toBe(canonicalDurabilityCommitKey({
      workspaceId: WS,
      agentImUserId: 'im_agent',
      canonicalTurnId: 'run_cloud_exact',
    }));
    expect(stagedExplicitReceipts).toEqual([
      expect.objectContaining({
        providerSessionId: 'provider_session_exact',
        workspaceId: WS,
        agentImUserId: 'im_agent',
        receipt: expect.objectContaining({
          pageId: r.body.page.id,
          path: r.body.page.path,
          version: r.body.page.version,
          contentHash: r.body.page.contentHash,
          authority: 'outbox',
        }),
      }),
    ]);
  });

  it('NEGATIVE CONTROL — an unknown provider session cannot claim a canonical turn key', async () => {
    durabilityRun = {
      providerSessionId: 'provider_session_exact',
      taskId: 'run_cloud_exact',
      workspaceId: WS,
      agentImUserId: 'im_agent',
    };
    const r = await post('/local/memory/write', writeBody({
      providerSessionId: 'provider_session_tampered',
      durabilityReceiptIndex: 0,
    }));

    expect(r.status).toBe(200);
    const [event] = outboxEnvelopes('memory.page.upsert');
    expect(event!.idempotencyKey).toMatch(/^upsert:/);
    expect(event!.idempotencyKey).not.toContain('durability:');
    expect(stagedExplicitReceipts).toEqual([]);
  });

  it('stages an exact cloud-authoritative section-write receipt for the pre-reply barrier', async () => {
    await post('/local/memory/write', writeBody());
    stagedExplicitReceipts = [];
    durabilityRun = {
      providerSessionId: 'provider_session_section',
      taskId: 'run_cloud_section',
      workspaceId: WS,
      agentImUserId: 'im_agent',
    };

    const r = await post('/local/memory/write', writeBody({
      providerSessionId: 'provider_session_section',
      durabilityReceiptIndex: 0,
      op: 'append-section',
      section: 'acceptance',
      content: '<h2 id="acceptance">Acceptance</h2><p>one write</p>',
    }));

    expect(r.status).toBe(200);
    expect(stagedExplicitReceipts).toEqual([
      expect.objectContaining({
        providerSessionId: 'provider_session_section',
        receipt: expect.objectContaining({
          pageId: r.body.page.id,
          path: r.body.page.path,
          version: r.body.page.version,
          contentHash: r.body.page.contentHash,
          authority: 'cloud',
        }),
      }),
    ]);
  });

  it('success returns localVersion + outboxEventId and the page aggregate exists together with the outbox row', async () => {
    const r = await post('/local/memory/write', writeBody());
    expect(r.status).toBe(200);
    // spec16 §10.2 step 4 — success carries BOTH the local version and the
    // outbox event id, so the caller can correlate the committed aggregate.
    expect(typeof r.body.localVersion).toBe('number');
    expect(r.body.localVersion).toBe(r.body.page.version);
    expect(r.body.outboxEventId).toMatch(/^out_/);
    // The event id is the REAL pending outbox row id (store oracle).
    const row = runtime!.resolve(WS).store
      .rawDb()
      .prepare('SELECT id FROM memory_outbox WHERE id = ?')
      .get(r.body.outboxEventId) as { id: string } | undefined;
    expect(row?.id).toBe(r.body.outboxEventId);
    // Page + aggregate exist together with the outbox row.
    expect(runtime!.resolve(WS).store.loadByPath('project/desktop/sync.pkf')).not.toBeNull();
    expect(aggregateCounts()).toEqual({ pages: 1, versions: 1, content: 1, fts: 1, outbox: 1 });
  });

  it('NEGATIVE CONTROL — a page-upsert enqueue failure rolls back the whole aggregate and the RPC fails', async () => {
    const slot = runtime!.resolve(WS);
    slot.outbox = new FaultInjectingOutbox(slot.store, 1);
    const r = await post(
      '/local/memory/write',
      writeBody({ path: 'project/atomic-fail.pkf', id: 'page_atomic_fail' }),
    );
    // Pre-fix this was a 200 with the page left local-only forever (the
    // M-OUTBOX-001 fork); the RPC must now fail and leave NO trace.
    expect(r.status).toBe(500);
    expect(runtime!.resolve(WS).store.loadByPath('project/atomic-fail.pkf')).toBeNull();
    expect(aggregateCounts()).toEqual(ZERO_AGGREGATE);
  });

  it('NEGATIVE CONTROL — a link-upsert enqueue failure (parentHubPath present) rolls back page AND outbox together', async () => {
    const slot = runtime!.resolve(WS);
    slot.outbox = new FaultInjectingOutbox(slot.store, 2);
    const r = await post(
      '/local/memory/write',
      writeBody({ path: 'project/link-fail.pkf', parentHubPath: 'project/hub.pkf' }),
    );
    expect(r.status).toBe(500);
    expect(runtime!.resolve(WS).store.loadByPath('project/link-fail.pkf')).toBeNull();
    expect(aggregateCounts()).toEqual(ZERO_AGGREGATE);
  });

  it('a retry after a rolled-back enqueue failure keeps the idempotency key (stable caller id)', async () => {
    const slot = runtime!.resolve(WS);
    const original = slot.outbox;
    const body = writeBody({ path: 'project/retry.pkf', id: 'page_retry_stable' });
    // Attempt 1: fault → 500, everything rolled back.
    slot.outbox = new FaultInjectingOutbox(slot.store, 1);
    const failed = await post('/local/memory/write', body);
    expect(failed.status).toBe(500);
    expect(aggregateCounts()).toEqual(ZERO_AGGREGATE);
    // Attempt 2 (the retry): same logical write, same stable id → same key.
    slot.outbox = original;
    const ok = await post('/local/memory/write', body);
    expect(ok.status).toBe(200);
    expect(ok.body.localVersion).toBe(1);
    const [ev] = outboxEnvelopes('memory.page.upsert');
    // spec16 §10.2 step 4 — the key derives ONLY from the logical write
    // identity (page id + parentVersion + contentHash): a retry cannot mint a
    // different key (no eventId / timestamp / attempt counter in the formula).
    const contentHash = createHash('sha256').update(String(body.content)).digest('hex');
    expect(ev!.idempotencyKey).toBe(`upsert:${WS}:page_retry_stable:0:${contentHash}`);
    expect(ev!.pageId).toBe('page_retry_stable');
    expect(aggregateCounts()).toEqual({ pages: 1, versions: 1, content: 1, fts: 1, outbox: 1 });
  });
});
