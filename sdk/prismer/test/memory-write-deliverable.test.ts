// product210/03 W1-3 / W1-2 — deliverable admission gates on the memory_write
// RPC (rulings R10 index-bearing distillation, R12 single asset-pointer form,
// §8.1-① ruling A pure-directive autonomy).
//
// What this proves:
//   1. G9 — a write declaring `deliverableSource` WITHOUT a materializable
//      `<a rel="derived-from" href="prismer://asset/<id>">` in the body is
//      rejected 422 `deliverable_pointer_missing`; NO page, NO outbox event.
//   2. G10 — memory211/01 §6.9 裁决 4: a distilled PAGE over 64K CHARACTERS is
//      rejected 422 `sharding_required` (the ceiling is judged on the BODY the
//      gate admits, never on the declared `sizeBytes`, which is informational).
//      NEGATIVE CONTROL: a body at exactly the threshold passes.
//   3. W1-2 idempotency — re-distilling the SAME deliverable (same
//      assetId+contentHash, different path) short-circuits 200 `dedupeHit`
//      with the EXISTING path and emits NO second page.upsert. NEGATIVE
//      CONTROL: a different contentHash writes a new page normally.
//   4. Provenance (G6) — a passing deliverable write carries the deterministic
//      token `asset:<id>#<hash>` in its sourceRefs.
//
// Run: npx vitest run test/memory-write-deliverable.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap } from '../src/daemon/memory/cap.js';
import { CloudClient } from '../src/auth.js';
import { withDescription } from './_helpers/pkf-description.js';
import { SHARDING_THRESHOLD_CHARS } from '../src/daemon/memory/deliverable-gate.js';

const WS = 'ws_deliverable_gate';
const ASSET_ID = 'ast_product_0001';
const ASSET_HASH = 'sha_product_abc';

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';
let cap = '';

const baseState: LocalServerState = {
  daemonId: 'dev_deliverable',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

async function startServer(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-deliverable-'));
  cleanupDirs.push(dir);
  cap = mintCap('im_agent', WS);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_deliverable' });
  const cloud = new CloudClient({
    baseUrl: 'http://cloud.test',
    apiKey: 'sk-test',
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch,
  });
  server = new LocalServer({
    port: 0,
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime, cloud, deviceId: 'dev_deliverable' }),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': cap },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const writeBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  workspaceId: WS,
  path: 'docs/report-notes.pkf',
  content: withDescription(
    `<h1>Report notes</h1><p>Distilled: the report's durable conclusion.</p>` +
      `<a rel="derived-from" href="prismer://asset/${ASSET_ID}">source report</a>`,
  ),
  title: 'Report notes',
  actorImUserId: 'im_agent',
  deliverableSource: { assetId: ASSET_ID, contentHash: ASSET_HASH, sizeBytes: 100_000 },
  ...overrides,
});

/**
 * A deliverable body of EXACTLY `n` characters (the 口径 the gate judges —
 * `content.length`, not the declared `sizeBytes`). The length is asserted, not
 * assumed, so a frontmatter/wrapper change cannot silently move the fixture off
 * the threshold it is testing.
 */
function deliverableBodyOfChars(n: number): string {
  const pointer = `<a rel="derived-from" href="prismer://asset/${ASSET_ID}">src</a>`;
  const wrapper = (fill: string): string => withDescription(`<h1>t</h1><p>${fill}</p>${pointer}`);
  const fill = n - wrapper('').length;
  expect(fill).toBeGreaterThan(0);
  const content = wrapper('y'.repeat(fill));
  expect(content.length).toBe(n);
  return content;
}

function outboxCount(eventType: string): number {
  const db = runtime!.resolve(WS).store.rawDb();
  return (
    db.prepare('SELECT COUNT(*) AS n FROM memory_outbox WHERE eventType = ?').get(eventType) as {
      n: number;
    }
  ).n;
}

beforeEach(() => {
  // Isolate the deliverable gates from the placement guard (both 422 families
  // are under test separately).
  process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'off';
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  runtime?.closeAll();
  runtime = undefined;
  delete process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE;
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* tmp best-effort */
    }
  }
});

describe('product210/03 — deliverable admission gates (G9/G10/idempotency)', () => {
  it('G9 — missing derived-from pointer → 422 deliverable_pointer_missing, nothing written', async () => {
    await startServer();
    const r = await post(
      '/local/memory/write',
      writeBody({
        content: '<h1>Report notes</h1><p>Looks distilled but the pointer is missing.</p>',
      }),
    );
    expect(r.status).toBe(422);
    expect(r.body?.code ?? r.body?.error?.code).toBe('deliverable_pointer_missing');
    expect(outboxCount('memory.page.upsert')).toBe(0);
    const pages = runtime!.resolve(WS).store.stats();
    expect(pages.pageCount).toBe(0);
  });

  // P6 — the pairing side declares a deliverable source on ANY
  // `prismer://asset/<id>` occurrence (including the `<figure><img src>` form
  // the extraction prompt teaches for IMAGE/CHART assets), while this gate used
  // to recognize ONLY `<a rel="derived-from">`. An image-only deliverable's
  // page was therefore gated out wholesale, every time. The gate now accepts
  // the inline image pointer as the same G9 jump pointer.
  it('P6 — an IMAGE pointer <img src="prismer://asset/<id>"> is a valid G9 pointer: an image-only deliverable writes', async () => {
    await startServer();
    const r = await post(
      '/local/memory/write',
      writeBody({
        content: withDescription(
          `<h1>Chart readout</h1>` +
            `<section><h2 id="load-test">Load-test chart</h2>` +
            `<figure><img src="prismer://asset/${ASSET_ID}" alt="throughput vs concurrency"><figcaption>` +
            'per-shard throughput plateaus at 50k/s beyond C=200.</figcaption></figure></section>',
        ),
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body?.page?.path).toBe('docs/report-notes.pkf');
    expect(outboxCount('memory.page.upsert')).toBe(1);
  });

  it('P6 — a bare <img src> pointer (no <figure>) is accepted the same way', async () => {
    await startServer();
    const r = await post(
      '/local/memory/write',
      writeBody({
        content: withDescription(
          `<h1>Chart readout</h1><p>The curve flattens.</p>` +
            `<img src='prismer://asset/${ASSET_ID}' alt="single quotes, no figure">`,
        ),
      }),
    );
    expect(r.status).toBe(200);
    expect(outboxCount('memory.page.upsert')).toBe(1);
  });

  it('P6 negative control — an <img> pointing at a DIFFERENT asset still fails G9', async () => {
    await startServer();
    const r = await post(
      '/local/memory/write',
      writeBody({
        content: withDescription(
          `<h1>Chart readout</h1><img src="prismer://asset/ast_someone_elses_chart" alt="not the declared source">`,
        ),
      }),
    );
    expect(r.status).toBe(422);
    expect(r.body?.code ?? r.body?.error?.code).toBe('deliverable_pointer_missing');
    expect(outboxCount('memory.page.upsert')).toBe(0);
  });

  it('P6 negative control — an <a> WITHOUT rel="derived-from" still fails G9', async () => {
    await startServer();
    const r = await post(
      '/local/memory/write',
      writeBody({
        content: withDescription(
          `<h1>Chart readout</h1><a href="prismer://asset/${ASSET_ID}">untyped link is not a derived-from</a>`,
        ),
      }),
    );
    expect(r.status).toBe(422);
    expect(r.body?.code ?? r.body?.error?.code).toBe('deliverable_pointer_missing');
    expect(String(r.body?.message ?? r.body?.error?.message)).toContain('<img');
  });

  it('G10 (memory211/01 轴A) — a 65KB source no longer hits any anti-copy budget: a copy+reference page is ADMITTED', async () => {    await startServer();
    // The SUPERSEDED behaviour (product210/03 W1) rejected a body over
    // min(32KiB, 10% × source). 轴A reverts the extraction-thinning doctrine: a
    // distilled page may carry the source's near-full content, so a body FAR
    // over that old budget with a 65KB source writes normally.
    const sourceBytes = 65 * 1024;
    const body = 'x'.repeat(40 * 1024); // 40KB ≫ min(32KiB, 6.5KB) — the old gate
    const r = await post(
      '/local/memory/write',
      writeBody({
        content: withDescription(
          `<h1>t</h1><p>${body}</p><a rel="derived-from" href="prismer://asset/${ASSET_ID}">src</a>`,
        ),
        deliverableSource: { assetId: ASSET_ID, contentHash: ASSET_HASH, sizeBytes: sourceBytes },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body?.page?.path).toBe('docs/report-notes.pkf');
    expect(outboxCount('memory.page.upsert')).toBe(1);
  });

  it('G10 (memory211/01 §6.9 裁决 4) — a page body over the 64K-CHARACTER threshold → 422 sharding_required', async () => {
    await startServer();
    const r = await post(
      '/local/memory/write',
      writeBody({
        content: deliverableBodyOfChars(SHARDING_THRESHOLD_CHARS + 1),
        // sizeBytes is INFORMATIONAL since the 裁决 4 口径 change: the ceiling is
        // judged on the body's characters, so the gate must fire even though the
        // declared byte size here is nowhere near any threshold.
        deliverableSource: { assetId: ASSET_ID, contentHash: ASSET_HASH, sizeBytes: 1_000 },
      }),
    );
    expect(r.status).toBe(422);
    expect(r.body?.code ?? r.body?.error?.code).toBe('sharding_required');
    expect(String(r.body?.message ?? r.body?.error?.message)).toContain('sharding');
    expect(outboxCount('memory.page.upsert')).toBe(0);
    expect(runtime!.resolve(WS).store.stats().pageCount).toBe(0);
  });

  it('G10 negative control — a body AT 64K chars exactly is admitted (the trigger is >, not ≥)', async () => {
    await startServer();
    const r = await post(
      '/local/memory/write',
      writeBody({
        content: deliverableBodyOfChars(SHARDING_THRESHOLD_CHARS),
        deliverableSource: { assetId: ASSET_ID, contentHash: ASSET_HASH, sizeBytes: 1_000_000 },
      }),
    );
    expect(r.status).toBe(200);
    expect(outboxCount('memory.page.upsert')).toBe(1);
  });

  it('negative control — a genuine distillation (pointer + within budget) writes normally with provenance', async () => {
    await startServer();
    const r = await post('/local/memory/write', writeBody({ path: 'docs/notes.pkf' }));
    expect(r.status).toBe(200);
    expect(r.body?.dedupeHit).toBeUndefined();
    expect(r.body?.page?.path).toBe('docs/notes.pkf');
    expect(outboxCount('memory.page.upsert')).toBe(1);
    const row = runtime!
      .resolve(WS)
      .store.rawDb()
      .prepare('SELECT sourceRefsJson FROM memory_pages WHERE path = ?')
      .get('docs/notes.pkf') as { sourceRefsJson: string };
    expect(row.sourceRefsJson).toContain(`asset:${ASSET_ID}#${ASSET_HASH}`);
  });

  it('W1-2 idempotency — same asset+contentHash replay → 200 dedupeHit on the EXISTING path, no second upsert', async () => {
    await startServer();
    const first = await post('/local/memory/write', writeBody({ path: 'docs/notes.pkf' }));
    expect(first.status).toBe(200);
    expect(outboxCount('memory.page.upsert')).toBe(1);

    const replay = await post(
      '/local/memory/write',
      writeBody({
        path: 'docs/notes-replayed-elsewhere.pkf',
        content:
          `<h1>Same report, distilled again</h1>` +
          `<a rel="derived-from" href="prismer://asset/${ASSET_ID}">source</a>`,
      }),
    );
    expect(replay.status).toBe(200);
    expect(replay.body?.dedupeHit).toBe(true);
    expect(replay.body?.page?.path).toBe('docs/notes.pkf');
    expect(outboxCount('memory.page.upsert')).toBe(1);
  });

  it('negative control — different contentHash (different deliverable revision) writes a NEW page', async () => {
    await startServer();
    const a = await post('/local/memory/write', writeBody({ path: 'docs/notes-v1.pkf' }));
    expect(a.status).toBe(200);
    const b = await post(
      '/local/memory/write',
      writeBody({
        path: 'docs/notes-v2.pkf',
        content: withDescription(
          `<h1>V2 conclusions</h1>` +
            `<a rel="derived-from" href="prismer://asset/${ASSET_ID}">source</a>`,
        ),
        deliverableSource: { assetId: ASSET_ID, contentHash: 'sha_product_v2', sizeBytes: 100_000 },
      }),
    );
    expect(b.status).toBe(200);
    expect(b.body?.dedupeHit).toBeUndefined();
    expect(outboxCount('memory.page.upsert')).toBe(2);
  });
});
