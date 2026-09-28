// memory211/01 §3 轴H — the write admission gates landed by W2, plus the 轴A
// extraction-path gate and the W2 #7 CJK recall fix.
//
// What this proves:
//   ① placement — a leaf whose child-of edge ALREADY sits in the local graph
//      mirror is placed (the gate consults edges, not just the body's content
//      link). NEGATIVE CONTROL: the same write without that edge is still 422
//      placement_required.
//   ② description_required — a NEW PKF page with no frontmatter description is
//      rejected 422 and NOTHING lands. NEGATIVE CONTROLS: the same body with a
//      description writes; an EXTEND of an existing page is not gated (edits
//      never lose the page); a markdown body is not gated (legacy input).
//   ③ pkf_invalid — a body the bundled validator rejects at the STRUCTURE level
//      (unknown rel) is rejected 422 with the validator's code. NEGATIVE
//      CONTROLS: warnings never reject (untyped link passes); markdown skips
//      validation; and the gate runs AFTER the bare-asset upgrade, so the taught
//      `prismer://asset/<id>` pointer form (G9) is not re-flagged by the strict
//      v1.1 `bare-asset-uri` rule.
//   轴H — the MAIN extraction path runs the same deliverable gate
//      (`filterGatedExtractedPages`): a page declaring a source it does not
//      reference is dropped. NEGATIVE CONTROL: a page that references its
//      declared source is kept.
//   轴A — the lexicon coverage acceptance metric (extractLexicon / coverage).
//   W2 #7 — CJK recall: a 2-char Chinese query INSIDE a longer run recalls the
//      page (it could never match under unicode61 before), and the store's V4
//      migration rebuilds an old FTS index into the bigram shape.
//
// Run: npx vitest run test/memory-write-gates.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintCap } from '../src/daemon/memory/cap.js';
import {
  cjkBigramText,
  MemoryStore,
  normalizeMemoryPath,
  SCHEMA_VERSION,
} from '../src/daemon/memory/store.js';
import {
  checkDeliverableGate,
  filterGatedExtractedPages,
  parseDeliverableSource,
  SHARDING_THRESHOLD_CHARS,
} from '../src/daemon/memory/deliverable-gate.js';
import {
  checkDescriptionGate,
  checkPkfProjection,
  extractPkfFrontmatterDescription,
} from '../src/daemon/memory/write-gate.js';
import { coverage, extractLexicon } from '../src/daemon/memory/extract.js';
import { buildFtsMatchQuery } from '../src/daemon/memory/search.js';
import { MemorySearch } from '../src/daemon/memory/search.js';

const WS = 'ws_write_gates';

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';
let cap = '';

const baseState: LocalServerState = {
  daemonId: 'dev_write_gates',
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
  const dir = mkdtempSync(join(tmpdir(), 'prismer-write-gates-'));
  cleanupDirs.push(dir);
  cap = mintCap('im_gates', WS);
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_write_gates' });
  server = new LocalServer({
    port: 0,
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime, deviceId: 'dev_write_gates' }),
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

const DESCRIPTION =
  '<script type="application/prismer+json">{"type":"note","title":"t","description":"gate fixture page","pkfVersion":"1.1"}</script>';

function outboxCount(eventType: string): number {
  const db = runtime!.resolve(WS).store.rawDb();
  return (
    db.prepare('SELECT COUNT(*) AS n FROM memory_outbox WHERE eventType = ?').get(eventType) as {
      n: number;
    }
  ).n;
}

beforeEach(() => {
  // The placement gate is under test in ① only; the other cases place or extend.
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

describe('轴H ① — placement consults an EXISTING child-of edge', () => {
  it('a NEW path whose child-of edge is already in the graph is accepted', async () => {
    await startServer();
    const slot = runtime!.resolve(WS);
    const path = 'topics/placed-by-edge.pkf';
    // The page row is absent, but the graph mirror already says this page hangs
    // under its hub (a pruned row, or the edge arrived via down-sync first).
    slot.store.upsertLink({
      workspaceId: WS,
      sourceUri: `prismer://workspace/${WS}/memory/${normalizeMemoryPath(path)}`,
      targetUri: `prismer://workspace/${WS}/memory/topics/hub.pkf`,
      relation: 'child-of',
      weight: 1,
    });
    const r = await post('/local/memory/write', {
      workspaceId: WS,
      path,
      content: `${DESCRIPTION}<h1>Placed by edge</h1>`,
      actorImUserId: 'im_gates',
      actorKind: 'agent',
    });
    expect(r.status).toBe(200);
    expect(r.body?.page?.path).toBe(path);
  });

  it('NEGATIVE CONTROL — the same write WITHOUT the edge is still 422 placement_required', async () => {
    await startServer();
    process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'enforce';
    const r = await post('/local/memory/write', {
      workspaceId: WS,
      path: 'topics/orphan.pkf',
      content: `${DESCRIPTION}<h1>Orphan</h1>`,
      actorImUserId: 'im_gates',
      actorKind: 'agent',
    });
    expect(r.status).toBe(422);
    expect(r.body?.code ?? r.body?.error?.code).toBe('placement_required');
  });
});

describe('轴H ② — description_required', () => {
  it('a NEW PKF page without a frontmatter description → 422, nothing written', async () => {
    await startServer();
    const r = await post('/local/memory/write', {
      workspaceId: WS,
      path: 'notes/no-description.pkf',
      content: '<h1>No description</h1><p>The body is fine but the summary is missing.</p>',
      actorImUserId: 'im_gates',
      actorKind: 'agent',
    });
    expect(r.status).toBe(422);
    expect(r.body?.code ?? r.body?.error?.code).toBe('description_required');
    expect(outboxCount('memory.page.upsert')).toBe(0);
    expect(runtime!.resolve(WS).store.stats().pageCount).toBe(0);
  });

  it('NEGATIVE CONTROL — an empty frontmatter description is also rejected', async () => {
    await startServer();
    const r = await post('/local/memory/write', {
      workspaceId: WS,
      path: 'notes/empty-description.pkf',
      content:
        '<script type="application/prismer+json">{"type":"note","title":"t","description":"   "}</script>' +
        '<h1>Empty</h1>',
      actorImUserId: 'im_gates',
      actorKind: 'agent',
    });
    expect(r.status).toBe(422);
    expect(r.body?.code ?? r.body?.error?.code).toBe('description_required');
  });

  it('NEGATIVE CONTROL — the same body WITH a description writes normally', async () => {
    await startServer();
    const r = await post('/local/memory/write', {
      workspaceId: WS,
      path: 'notes/with-description.pkf',
      content: `${DESCRIPTION}<h1>Has description</h1><p>fine</p>`,
      actorImUserId: 'im_gates',
      actorKind: 'agent',
    });
    expect(r.status).toBe(200);
    expect(outboxCount('memory.page.upsert')).toBe(1);
  });

  it('an EXTEND of an existing page is not gated (an edit never loses the page)', async () => {
    await startServer();
    const path = 'notes/existing.pkf';
    const first = await post('/local/memory/write', {
      workspaceId: WS,
      path,
      content: `${DESCRIPTION}<h1>v1</h1>`,
      actorImUserId: 'im_gates',
      actorKind: 'agent',
    });
    expect(first.status).toBe(200);
    const second = await post('/local/memory/write', {
      workspaceId: WS,
      path,
      content: '<h1>v2 — description dropped by the edit</h1>',
      actorImUserId: 'im_gates',
      actorKind: 'agent',
    });
    expect(second.status).toBe(200);
    expect(second.body?.page?.version).toBe((first.body?.page?.version ?? 1) + 1);
  });

  it('a MARKDOWN body is not gated (legacy compatibility input)', async () => {
    await startServer();
    const r = await post('/local/memory/write', {
      workspaceId: WS,
      path: 'notes/plain.md',
      content: '# Plain markdown\n\nno frontmatter, no PKF tags, still lands',
      actorImUserId: 'im_gates',
      actorKind: 'agent',
    });
    expect(r.status).toBe(200);
  });
});

describe('轴H ③ — pkf_invalid (structure validation of the HTML projection body)', () => {
  it('an unknown rel → 422 pkf_invalid carrying the validator code, nothing written', async () => {
    await startServer();
    const r = await post('/local/memory/write', {
      workspaceId: WS,
      path: 'notes/bad-rel.pkf',
      content:
        `${DESCRIPTION}<h1>Bad rel</h1>` +
        '<a rel="wibble" href="prismer://workspace/ws/memory/other.pkf">not a relation</a>',
      actorImUserId: 'im_gates',
      actorKind: 'agent',
    });
    expect(r.status).toBe(422);
    expect(r.body?.code ?? r.body?.error?.code).toBe('pkf_invalid');
    expect(r.body?.detail).toBe('invalid-rel');
    expect(outboxCount('memory.page.upsert')).toBe(0);
    expect(runtime!.resolve(WS).store.stats().pageCount).toBe(0);
  });

  it('NEGATIVE CONTROL — a WARNING never rejects (untyped link still lands)', async () => {
    await startServer();
    const r = await post('/local/memory/write', {
      workspaceId: WS,
      path: 'notes/untyped-link.pkf',
      content:
        `${DESCRIPTION}<h1>Untyped</h1>` +
        '<a href="https://example.com/post">no rel, only a warning</a>',
      actorImUserId: 'im_gates',
      actorKind: 'agent',
    });
    expect(r.status).toBe(200);
    expect(outboxCount('memory.page.upsert')).toBe(1);
  });

  it('the gate runs AFTER the bare-asset upgrade: the taught G9 pointer form is not re-flagged', async () => {
    await startServer();
    // A v1.1 (strict) body whose derived-from pointer uses the bare asset form
    // the skill teaches. The upgrade rewrites it to the scoped form BEFORE
    // validation, so the strict-only `bare-asset-uri` error cannot reject it.
    const r = await post('/local/memory/write', {
      workspaceId: WS,
      path: 'notes/bare-pointer.pkf',
      content:
        `${DESCRIPTION}<h1>Bare pointer</h1>` +
        '<a rel="derived-from" href="prismer://asset/ast_gates_0001">source</a>',
      actorImUserId: 'im_gates',
      actorKind: 'agent',
    });
    expect(r.status).toBe(200);
    const stored = runtime!.resolve(WS).store.loadContent(
      (runtime!.resolve(WS).store.loadByPath('notes/bare-pointer.pkf') as { id: string }).id,
    );
    expect(stored?.content).toContain('prismer://workspace/');
  });
});

describe('轴H — the main extraction path runs the deliverable gate', () => {
  it('a page declaring a source it does not reference is dropped', () => {
    const pages = [
      {
        path: 'distill/orphan.pkf',
        content: '<h1>No pointer</h1><p>looks distilled, references nothing</p>',
        deliverableSource: { assetId: 'ast_x' },
      },
    ];
    const { kept, rejected } = filterGatedExtractedPages(pages);
    expect(kept).toHaveLength(0);
    expect(rejected.map((r) => r.code)).toEqual(['deliverable_pointer_missing']);
  });

  it('NEGATIVE CONTROL — a page that references its declared source is kept', () => {
    const pages = [
      {
        path: 'distill/ok.pkf',
        content:
          '<h1>Ok</h1><p>carries the knowledge</p>' +
          '<a rel="derived-from" href="prismer://asset/ast_x">source</a>',
        deliverableSource: { assetId: 'ast_x' },
      },
      {
        path: 'distill/plain.pkf',
        content: '<h1>Plain</h1><p>no declared source, gate is a no-op</p>',
      },
    ];
    const { kept, rejected } = filterGatedExtractedPages(pages);
    expect(rejected).toHaveLength(0);
    expect(kept.map((p) => p.path)).toEqual(['distill/ok.pkf', 'distill/plain.pkf']);
  });

  it('the sharding trigger fires on the shared gate (unit) — 64K CHARACTERS per page', () => {
    // §6.9 裁决 4 — 每页 ≤64K: the gate measures the PAGE BODY in characters
    // (the copy+reference doctrine lets a page carry the source's near-full
    // body, so the page length IS the sharding fact the gate can check
    // deterministically). Boundary is exact: at the threshold it passes, one
    // character over it is refused.
    const ds = parseDeliverableSource({ assetId: 'ast_big' });
    const pointer = '<a rel="derived-from" href="prismer://asset/ast_big">s</a>';
    const atBody = pointer + 'x'.repeat(SHARDING_THRESHOLD_CHARS - pointer.length);
    expect(atBody.length).toBe(SHARDING_THRESHOLD_CHARS);
    expect(checkDeliverableGate(ds, atBody)).toBeNull();

    const overBody = `${atBody}x`;
    expect(checkDeliverableGate(ds, overBody)?.code).toBe('sharding_required');

    // A page over the ceiling is refused even when the DECLARED source bytes
    // look small (bytes are no longer the gate's measure — chars are).
    const smallBytes = parseDeliverableSource({ assetId: 'ast_small_bytes', sizeBytes: 10 });
    const smallBody =
      '<a rel="derived-from" href="prismer://asset/ast_small_bytes">s</a>' +
      'x'.repeat(SHARDING_THRESHOLD_CHARS);
    expect(checkDeliverableGate(smallBytes, smallBody)?.code).toBe('sharding_required');

    // No declared source → the gate is a no-op for an ordinary memory write
    // (even an oversized one: without a deliverable there is nothing to shard).
    expect(checkDeliverableGate(null, overBody)).toBeNull();
  });
});

describe('轴A — lexicon coverage acceptance metric', () => {
  const source =
    '金门标准是我们的准入规范 golden gate G10 Kestrel 400ms PKF 复核清单';
  it('extracts proper nouns, codes/numbers and CJK term bigrams', () => {
    const lexicon = extractLexicon(source);
    // Proper nouns, codes/measurements and CJK term bigrams — NOT common nouns
    // ('golden', 'gate' are ordinary words, the proper-noun heuristic skips them).
    for (const term of ['Kestrel', 'G10', '400ms', 'PKF', '金门', '复核', '清单']) {
      expect(lexicon).toContain(term);
    }
    expect(lexicon).not.toContain('gate');
    // Deterministic + deduplicated (case-insensitive).
    expect(extractLexicon(source)).toEqual(lexicon);
    expect(extractLexicon('PKF pkf')).toEqual(['PKF']);
  });

  it('coverage is 1 for a page that carries the source, low for one that drops its terms', () => {
    const lexicon = extractLexicon(source);
    expect(coverage(source, lexicon)).toBe(1);
    expect(coverage('a page that kept none of the source vocabulary', lexicon)).toBeLessThan(0.2);
    expect(coverage('', lexicon)).toBe(0);
    // A source with no recoverable vocabulary cannot fail a page.
    expect(coverage('anything', [])).toBe(1);
  });

  it('NEGATIVE CONTROL — the metric is not vacuously green: a prose-only page scores under the target', () => {
    const lexicon = extractLexicon(source);
    expect(coverage('qwerty uiop asdf', lexicon)).toBe(0);
  });
});

describe('W2 #7 — CJK recall (daemon FTS + V4 index rebuild)', () => {
  it('a 2-char Chinese term INSIDE a longer run recalls the page; an unrelated query does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismer-cjk-search-'));
    cleanupDirs.push(dir);
    const ws = 'ws_cjk';
    const store = new MemoryStore({ dbPath: join(dir, 'm.db'), workspaceId: ws, deviceId: 'dev' });
    store.open();
    try {
      store.write({
        workspaceId: ws,
        path: 'gates/admission.pkf',
        title: '准入规范与门槛清单',
        content:
          '<h1>准入规范</h1><section><h2 id="g1">G1 写入门</h2>' +
          '<p>金门标准是我们的准入规范，金门标准不可绕过。</p></section>',
        actorImUserId: 'a',
        actorKind: 'agent',
      });
      const search = new MemorySearch(store);
      // Measured pre-fix on the bundled SQLite: `"金门"` could not match the
      // indexed run `金门标准` — unicode61 keeps a whole run as ONE token.
      const insideRun = search.hybrid('金门', { graph: false });
      expect(insideRun.map((r) => r.path)).toContain('gates/admission.pkf');
      expect(search.hybrid('金门标准', { graph: false })).toHaveLength(1);
      // Mixed CJK + ASCII term, AND-joined.
      expect(search.hybrid('G1 写入门', { graph: false })).toHaveLength(1);
      // NEGATIVE CONTROL — the matcher is not vacuously green.
      expect(search.hybrid('幽灵缆线', { graph: false })).toHaveLength(0);
      // The index really is carrying the bigram projection (not an ASCII fluke).
      expect(cjkBigramText('金门标准')).toBe('金门 门标 标准');
      expect(buildFtsMatchQuery('金门标准 golden', 'AND')).toBe(
        '("金门" OR "门标" OR "标准") AND "golden"',
      );
    } finally {
      store.close();
    }
  });

  it('the V4 migration rebuilds a pre-W2 FTS index into the bigram shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismer-cjk-migration-'));
    cleanupDirs.push(dir);
    const ws = 'ws_cjk_mig';
    const dbPath = join(dir, 'm.db');
    const store = new MemoryStore({ dbPath, workspaceId: ws, deviceId: 'dev' });
    store.open();
    const page = store.write({
      workspaceId: ws,
      path: 'notes/cjk.pkf',
      title: '金门标准',
      content: '<h1>金门标准</h1><p>金门标准不可绕过。</p>',
      actorImUserId: 'a',
      actorKind: 'agent',
    });
    // Roll the store back to the PRE-W2 shape: schema v3 + an FTS table with no
    // `cjk` column. Reopening must rebuild (drop/recreate/re-index) and stamp v4.
    {
      const db = store.rawDb();
      db.prepare('DROP TABLE memory_fts').run();
      db.prepare(
        `CREATE VIRTUAL TABLE memory_fts USING fts5(
           pageId UNINDEXED, workspaceId UNINDEXED, path, title, description, content,
           tokenize = 'porter unicode61 remove_diacritics 1')`,
      ).run();
      db.prepare(
        `INSERT INTO memory_fts (pageId, workspaceId, path, title, description, content)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(page.id, ws, 'notes/cjk.pkf', '金门标准', '', '<h1>金门标准</h1><p>金门标准不可绕过。</p>');
      db.prepare('UPDATE memory_schema_version SET version = 3').run();
      store.close();
    }

    const reopened = new MemoryStore({ dbPath, workspaceId: ws, deviceId: 'dev' });
    reopened.open();
    try {
      const version = (reopened.rawDb().prepare('SELECT version FROM memory_schema_version').get() as {
        version: number;
      }).version;
      // W3 bumped the schema to V5 (T3 asset-chunk mirror) — a V3 store migrates
      // ALL the way forward, so the reopened store lands at the CURRENT version.
      expect(version).toBe(SCHEMA_VERSION);
      const columns = reopened
        .rawDb()
        .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
        .all('memory_fts') as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toContain('cjk');
      // The rebuilt index carries the bigrams, so the 2-char query inside the
      // longer run is reachable again on the MIGRATED row.
      expect(new MemorySearch(reopened).hybrid('金门', { graph: false })).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});

describe('gate helpers (pure units)', () => {
  it('extractPkfFrontmatterDescription reads the description and tolerates junk', () => {
    expect(extractPkfFrontmatterDescription(`${DESCRIPTION}<h1>x</h1>`)).toBe('gate fixture page');
    expect(extractPkfFrontmatterDescription('<h1>no frontmatter</h1>')).toBeNull();
    expect(
      extractPkfFrontmatterDescription(
        '<script type="application/prismer+json">not json at all</script><h1>x</h1>',
      ),
    ).toBeNull();
  });

  it('checkDescriptionGate skips markdown and accepts a present description', () => {
    expect(checkDescriptionGate('# markdown\n\ntext')).toBeNull();
    expect(checkDescriptionGate(`${DESCRIPTION}<h1>x</h1>`)).toBeNull();
    expect(checkDescriptionGate('<h1>no description</h1>')?.code).toBe('description_required');
  });

  it('checkPkfProjection skips markdown and reports only structural failures', () => {
    expect(checkPkfProjection('# markdown\n\ntext')).toBeNull();
    expect(checkPkfProjection(`${DESCRIPTION}<h1>ok</h1><p>body</p>`)).toBeNull();
    const bad = checkPkfProjection(
      `${DESCRIPTION}<h1>bad</h1><a rel="wibble" href="https://example.com">x</a>`,
    );
    expect(bad?.code).toBe('pkf_invalid');
    expect(bad?.detail).toBe('invalid-rel');
  });
});
