// pkf v1.1 — write-time bare-asset-URI upgrade on the memory_write RPC.
//
// Background: PKF v1.1 strict validation rejects bare `prismer://asset/<id>`
// URIs (compatibility-read only — packages/pkf/src/core/validator.ts
// 'bare-asset-uri'); the canonical authoring form is
// `prismer://workspace/<wsId>/asset/<contentHash>` (scoped, uri.ts §4.7). The
// memory skill + extraction prompt still teach the bare form (G9 pointer and
// <img src> pointers), and the daemon write path persisted it verbatim — every
// page carrying an asset pointer failed v1.1 validation on read-back diagnosis.
//
// What this proves:
//   1. Canonical upgrade — with an asset-hash resolver wired, bare href/src
//      pointers are rewritten to `prismer://workspace/<ws>/asset/<contentHash>`
//      BEFORE the write lands; rel, link text, quote style and attribute order
//      survive; the outbox up-sync payload carries the SAME upgraded content.
//   2. NEGATIVE CONTROL (resolver miss) — an asset the resolver cannot resolve
//      degrades to the workspace-scoped assetId form
//      `prismer://workspace/<ws>/asset/<assetId>` (still v1.1-valid); the
//      write is NEVER blocked.
//   3. NEGATIVE CONTROL (resolver throws / not wired) — same degrade path;
//      a broken resolver must not fail the write.
//   4. Content without bare asset URIs passes through byte-identical and no
//      upgrade counter moves.
//
// Run: npx vitest run test/memory-write-bare-uri-upgrade.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { withDescription } from './_helpers/pkf-description.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap } from '../src/daemon/memory/cap.js';
import { CloudClient } from '../src/auth.js';
import {
  getMemoryStageCounters,
  resetMemoryStageCounters,
} from '../src/daemon/memory/hook-server.js';

const WS = 'ws_bare_uri_upgrade';
const AST_REPORT = 'ast_report_0001';
const AST_CHART = 'ast_chart_0002';
const HASH_REPORT = 'sha256_report_aaaa';
const HASH_CHART = 'sha256_chart_bbbb';

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';
let cap = '';

const baseState: LocalServerState = {
  daemonId: 'dev_bare_uri',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

type Resolver = (workspaceId: string, assetId: string) => Promise<string | null>;

async function startServer(resolver?: Resolver): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-bare-uri-'));
  cleanupDirs.push(dir);
  cap = mintCap('im_agent', WS);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_bare_uri' });
  const cloud = new CloudClient({
    baseUrl: 'http://cloud.test',
    apiKey: 'sk-test',
    fetchImpl: (async () =>
      new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch,
  });
  server = new LocalServer({
    port: 0,
    getState: () => baseState,
    attachMemory: attachMemoryRpc({
      runtime,
      cloud,
      deviceId: 'dev_bare_uri',
      ...(resolver ? { resolveAssetContentHash: resolver } : {}),
    }),
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

const writeBodyRaw = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  workspaceId: WS,
  // memory211/01 轴H ② — a NEW page must carry a frontmatter description; these
  // fixtures predate the gate and test other contracts, so the mandated
  // frontmatter is stamped here once instead of hand-written per body. The gate
  // itself is exercised in memory-write-gates.test.ts.
  path: 'docs/report-notes.pkf',
  content:
    `<h1>Report notes</h1><p>Distilled: the report's durable conclusion.</p>` +
    `<a rel="derived-from" href="prismer://asset/${AST_REPORT}">source report</a>`,
  title: 'Report notes',
  actorImUserId: 'im_agent',
  ...overrides,
});

/** Stamps the mandated frontmatter description (轴H ②) onto the fixture body. */
const writeBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const body = writeBodyRaw(overrides);
  const content = typeof body.content === 'string' ? withDescription(body.content) : body.content;
  return { ...body, content };
};

/** Latest stored page body for a path (memory_page_content.payloadValue). */
function storedContent(path: string): string {
  const row = runtime!
    .resolve(WS)
    .store.rawDb()
    .prepare(
      'SELECT c.payloadValue AS content FROM memory_page_content c ' +
        'JOIN memory_pages p ON p.id = c.pageId WHERE p.path = ? ORDER BY c.version DESC LIMIT 1',
    )
    .get(path) as { content: string } | undefined;
  return row?.content ?? '';
}

/** The memory.page.upsert envelope that will carry this page to the cloud. */
function lastPageUpsertEnvelope(): Record<string, any> {
  const row = runtime!
    .resolve(WS)
    .store.rawDb()
    .prepare(
      "SELECT envelopeJson FROM memory_outbox WHERE eventType = 'memory.page.upsert' " +
        'ORDER BY createdAt DESC, rowid DESC LIMIT 1',
    )
    .get() as { envelopeJson: string } | undefined;
  return row ? (JSON.parse(row.envelopeJson) as Record<string, any>) : {};
}

const knowsBothAssets: Resolver = async (_ws, assetId) => {
  if (assetId === AST_REPORT) return HASH_REPORT;
  if (assetId === AST_CHART) return HASH_CHART;
  return null;
};

beforeEach(() => {
  // Isolate from the placement guard (422 family is under test elsewhere).
  process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'off';
  resetMemoryStageCounters();
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  runtime?.closeAll();
  runtime = undefined;
  delete process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE;
  resetMemoryStageCounters();
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* tmp best-effort */
    }
  }
});

describe('memory_write — write-time bare-asset-URI upgrade (pkf v1.1)', () => {
  it('canonical upgrade — bare href becomes prismer://workspace/<ws>/asset/<contentHash>; rel + text survive', async () => {
    await startServer(knowsBothAssets);
    const r = await post('/local/memory/write', writeBody());
    expect(r.status).toBe(200);

    const content = storedContent('docs/report-notes.pkf');
    // Canonical form landed…
    expect(content).toContain(`href="prismer://workspace/${WS}/asset/${HASH_REPORT}"`);
    // …the bare form is gone…
    expect(content).not.toContain(`prismer://asset/${AST_REPORT}`);
    // …and the link relation + text survived the rewrite.
    expect(content).toContain(`<a rel="derived-from" href="prismer://workspace/${WS}/asset/${HASH_REPORT}">source report</a>`);

    // Up-sync carries the SAME upgraded content (the cloud never sees bare).
    const env = lastPageUpsertEnvelope();
    expect(env?.payload?.content).toContain(`prismer://workspace/${WS}/asset/${HASH_REPORT}`);
    expect(env?.payload?.content).not.toContain(`prismer://asset/${AST_REPORT}`);

    expect(getMemoryStageCounters().bareUriUpgraded).toBeGreaterThanOrEqual(1);
  });

  it('attribute variants — href-first order, single-quoted <img src>, dedupe across repeats', async () => {
    await startServer(knowsBothAssets);
    const content =
      `<h1>Mixed</h1>` +
      `<a href="prismer://asset/${AST_REPORT}" rel="derived-from">report</a>` +
      `<figure><img src='prismer://asset/${AST_CHART}' alt="chart"><figcaption>cap</figcaption></figure>` +
      `<p>again: <a href="prismer://asset/${AST_REPORT}">report</a></p>`;
    const r = await post('/local/memory/write', writeBody({ content }));
    expect(r.status).toBe(200);

    const stored = storedContent('docs/report-notes.pkf');
    expect(stored).not.toContain('prismer://asset/');
    // href-first attribute order keeps rel after href, text intact.
    expect(stored).toContain(`<a href="prismer://workspace/${WS}/asset/${HASH_REPORT}" rel="derived-from">report</a>`);
    // Single-quoted src is rewritten inside its original quotes.
    expect(stored).toContain(`<img src='prismer://workspace/${WS}/asset/${HASH_CHART}' alt="chart">`);
    // Repeated assetIds resolve once but every occurrence is rewritten.
    expect(stored.match(new RegExp(HASH_REPORT, 'g'))).toHaveLength(2);
    expect(getMemoryStageCounters().bareUriUpgraded).toBeGreaterThanOrEqual(1);
  });

  it('NEGATIVE CONTROL — unresolvable asset degrades to the scoped assetId form; write not blocked', async () => {
    // Resolver wired but the asset is unknown to it (e.g. index not synced yet).
    await startServer(async () => null);
    const r = await post('/local/memory/write', writeBody());
    expect(r.status).toBe(200);
    expect(r.body?.page?.path).toBe('docs/report-notes.pkf');

    const content = storedContent('docs/report-notes.pkf');
    // Still left the bare form: workspace-scoped assetId URI (v1.1-valid).
    expect(content).toContain(`href="prismer://workspace/${WS}/asset/${AST_REPORT}"`);
    expect(content).not.toContain(`prismer://asset/${AST_REPORT}`);
    expect(getMemoryStageCounters().bareUriScopedDegrade).toBeGreaterThanOrEqual(1);
  });

  it('NEGATIVE CONTROL — a throwing resolver degrades the same way and never fails the write', async () => {
    await startServer(async () => {
      throw new Error('metadata index offline');
    });
    const r = await post('/local/memory/write', writeBody());
    expect(r.status).toBe(200);
    const content = storedContent('docs/report-notes.pkf');
    expect(content).toContain(`href="prismer://workspace/${WS}/asset/${AST_REPORT}"`);
    expect(content).not.toContain(`prismer://asset/${AST_REPORT}`);
  });

  it('NEGATIVE CONTROL — resolver not wired at all degrades to scoped form (legacy wiring unaffected)', async () => {
    await startServer(); // no resolveAssetContentHash option
    const r = await post('/local/memory/write', writeBody());
    expect(r.status).toBe(200);
    const content = storedContent('docs/report-notes.pkf');
    expect(content).toContain(`href="prismer://workspace/${WS}/asset/${AST_REPORT}"`);
    expect(content).not.toContain(`prismer://asset/${AST_REPORT}`);
    expect(getMemoryStageCounters().bareUriScopedDegrade).toBeGreaterThanOrEqual(1);
  });

  it('no bare asset URIs → content passes through byte-identical, no upgrade counters move', async () => {
    await startServer(knowsBothAssets);
    const content =
      `<h1>Clean</h1>` +
      `<a href="prismer://workspace/${WS}/asset/${HASH_REPORT}" rel="references">already canonical</a>` +
      `<a href="https://example.com/post" rel="related">web</a>`;
    const body = writeBody({ content });
    const r = await post('/local/memory/write', body);
    expect(r.status).toBe(200);
    // The invariant is "the upgrade did not touch the body", so the comparison
    // is against what was SENT (which now carries the mandated frontmatter
    // description, 轴H ②) — not against the local fixture literal.
    expect(storedContent('docs/report-notes.pkf')).toBe(body.content);
    expect(getMemoryStageCounters().bareUriUpgraded).toBe(0);
    expect(getMemoryStageCounters().bareUriScopedDegrade).toBe(0);
  });
});
