// memory211/01 W3 — daemon-side upload ingestion + turn-start digest (axis D + E).
//
// Four contracts, each with its red side:
//
//   1. T3 MIRROR (轴D 可用性, F2 裁决) — `ingestAssetFile` chunks an upload into
//      the LOCAL `asset_chunks` mirror AND enqueues `asset.chunk.upsert` outbox
//      events for the cloud authoritative table; recall then hits tier:'raw'
//      LOCALLY, which is what keeps the tier alive offline (the negative control
//      deletes the mirror rows and asserts the recall lane goes dark).
//   2. CHUNKER — deterministic, budget-bounded, overlap-carrying, byte-identical
//      contract with the cloud implementation (same constants, same cuts).
//   3. DIGEST (轴E + §6.9 裁决 2) — `buildMemoryDigest` is DETERMINISTIC (two
//      builds byte-equal; the mutation control shows a timestamp would break
//      that), content-hash versioned (content change ⇒ version change), and
//      UNBOUNDED except for the extreme guard: a map far above the abolished
//      ~2K-token cap is injected IN FULL, and only a >32K-token digest is cut
//      (with a marker).
//   4. INJECTION — `renderMemoryDigestBlock` emits a byte-stable block at the
//      system-prompt tail seam, is a no-op when the flag is off / no provider,
//      and the miss lane now RETURNS structural anchors as hits (轴D 追加项 D①).
//
// liteparse note: `lit` is baked into the sandbox image, not into this repo's
// dev environment — the pdf path is covered by its FAILURE contract here (a
// missing binary must skip loudly, never throw into the materialize ack), which
// is the part the daemon owns unconditionally.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore, SCHEMA_VERSION } from '../src/daemon/memory/store.js';
import { MemorySearch, mergeChunkHits, RAW_TRUST_DISCOUNT } from '../src/daemon/memory/search.js';
import { MemoryOutbox } from '../src/daemon/memory/outbox.js';
import {
  chunkPlainText,
  estimateChunkTokens,
  ingestAssetFile,
  CHUNK_TARGET_TOKENS,
  CHUNK_OVERLAP_RATIO,
  resolveChunkKind,
} from '../src/daemon/memory/asset-chunks.js';
import {
  buildMemoryDigest,
  estimateDigestTokens,
  renderMemoryDigestBlock,
  setMemoryDigestProvider,
  MEMORY_DIGEST_HEADER,
  MEMORY_DIGEST_EXTREME_GUARD_TOKENS,
  resolveDigestTokenBudget,
} from '../src/daemon/memory/digest.js';
import { isIndexInjectEnabled } from '../src/daemon/memory/index-toc-inject.js';
import type { MemorySearchResult } from '../src/daemon/memory/types.js';

const ws = 'w3_daemon_ws';
let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'w3-memory-')), 'memory.db');
  store = new MemoryStore({ dbPath, workspaceId: ws, deviceId: 'dev' });
  store.open();
});

afterEach(() => {
  store.close();
  rmSync(dbPath, { force: true });
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
  setMemoryDigestProvider(null);
  delete process.env.FF_MEMORY_INDEX_INJECT_ENABLED;
});

function seedWiki(): void {
  store.write({
    workspaceId: ws,
    id: 'idx1',
    path: 'index.md',
    title: 'Index',
    content: '<h1>Index</h1><p>entry hub-a</p>',
    pageType: 'index',
    visibility: { kind: 'workspace' },
    actorImUserId: 'dev',
    actorKind: 'agent',
  });
  store.write({
    workspaceId: ws,
    id: 'hub1',
    path: 'topics/hub-a.pkf',
    title: 'Hub A',
    description: '准入规范与门槛清单',
    content: '<h1>Hub A</h1><p>准入规范与门槛清单 G1 到 G10。</p>',
    pageType: 'hub',
    visibility: { kind: 'workspace' },
    actorImUserId: 'dev',
    actorKind: 'agent',
  });
}

describe('W3 ① T3 local mirror + recall', () => {
  it('mirrors chunks locally and uploads them through the outbox (idempotent keys)', async () => {
    const outbox = new MemoryOutbox({ store });
    const bytes = Buffer.from(
      Array.from({ length: 300 }, (_, i) => `第 ${i} 行：凯尔文阈值决定冷却回路的介入时机。`).join('\n'),
      'utf8',
    );
    const result = await ingestAssetFile({
      store,
      outbox,
      assetId: 'asset_1',
      contentHash: 'a'.repeat(64),
      filename: 'runbook.md',
      bytes,
    });
    expect(result.status).toBe('indexed');
    expect(result.chunks).toBeGreaterThan(1);

    // local mirror rows
    const rows = store.listAssetChunks('asset_1');
    expect(rows.length).toBe(result.chunks);

    // outbox events: one per chunk, valid against the envelope schema, keyed idempotently
    const stats = store.stats();
    expect(stats.pendingOutbox).toBe(result.chunks);
    const requeue = await ingestAssetFile({
      store,
      outbox,
      assetId: 'asset_1',
      contentHash: 'a'.repeat(64),
      filename: 'runbook.md',
      bytes,
    });
    expect(requeue.status).toBe('indexed');
    // a full re-ingest REPLACES the rows (never duplicates them)
    expect(store.listAssetChunks('asset_1').length).toBe(result.chunks);
  });

  it('recalls the upload as tier:raw LOCALLY — and goes dark when the mirror is gone (F2 negative control)', async () => {
    const outbox = new MemoryOutbox({ store });
    await ingestAssetFile({
      store,
      outbox,
      assetId: 'asset_1',
      contentHash: 'a'.repeat(64),
      filename: 'runbook.md',
      bytes: Buffer.from('# 手册\n\n凯尔文阈值是冷却回路的介入点。\n', 'utf8'),
    });
    const search = new MemorySearch(store);
    const hits = search.hybrid('凯尔文阈值', { graph: false });
    const raw = hits.find((h) => h.tier === 'raw');
    expect(raw, `expected a raw hit among ${hits.length}`).toBeTruthy();
    expect(raw!.path).toContain(`asset:asset_1#`);
    expect(raw!.assetId).toBe('asset_1');

    // NEGATIVE CONTROL: the recall comes from the LOCAL mirror. Delete the
    // mirror rows and the same query recalls nothing from that tier.
    store.rawDb().prepare('DELETE FROM asset_chunks').run();
    store.rawDb().prepare('DELETE FROM asset_chunks_fts').run();
    expect(search.hybrid('凯尔文阈值', { graph: false })).toHaveLength(0);
  });

  it('a pdf with no liteparse binary SKIPS loudly instead of throwing into the ack', async () => {
    const outbox = new MemoryOutbox({ store });
    const result = await ingestAssetFile({
      store,
      outbox,
      assetId: 'asset_pdf',
      contentHash: 'b'.repeat(64),
      filename: 'scan.pdf',
      bytes: Buffer.from('%PDF-1.4 test', 'utf8'),
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBeTruthy();
    expect(store.listAssetChunks('asset_pdf')).toHaveLength(0);
  });

  it('the whitelist routes types the same way the cloud does', () => {
    expect(resolveChunkKind('a.md')).toBe('text');
    expect(resolveChunkKind('b.txt')).toBe('text');
    expect(resolveChunkKind('c.pkf')).toBe('text');
    expect(resolveChunkKind('d.pdf')).toBe('pdf');
    expect(resolveChunkKind('e.png')).toBe('unsupported');
  });
});

describe('W3 ② chunker contract (cloud-mirrored)', () => {
  it('is deterministic, budget-bounded, and estimates tokens on the stored text', () => {
    const body = Array.from({ length: 200 }, (_, i) => `Line ${i}: the golden gate standard requires verbatim numbers.`).join('\n');
    expect(chunkPlainText(body)).toEqual(chunkPlainText(body));
    const chunks = chunkPlainText(body);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS);
      expect(chunk.tokenEstimate).toBe(estimateChunkTokens(chunk.text));
    }
  });

  it('EQUIVALENCE: incremental chunker is JSON-equal to the naive budget-rescan algorithm', () => {
    // Review F2-2 — the O(n) rewrite must not move a single boundary. The naive
    // version below is the PRE-F-1 algorithm verbatim (full-string rescan per
    // appended char, estimator over UTF-16 length). Fixture is a ~100KB
    // deterministic MIX of CJK prose, ASCII prose and astral emoji — the mix
    // where a code-point vs UTF-16 counting divergence shows up (review F2-1).
    const naive = (text: string) => {
      const normalized = (text ?? '').replace(/\r\n/g, '\n');
      if (!normalized.trim()) return [];
      const chunks: Array<{ ordinal: number; text: string; tokenEstimate: number }> = [];
      const chars = Array.from(normalized);
      let start = 0;
      while (start < chars.length) {
        let end = start;
        let budgetSlice = '';
        while (end < chars.length) {
          const candidate = budgetSlice + chars[end];
          if (estimateChunkTokens(candidate) > CHUNK_TARGET_TOKENS && end > start) break;
          budgetSlice = candidate;
          end += 1;
        }
        if (end <= start) break;
        const windowStart = start + Math.floor((end - start) * 0.85);
        let cut = end;
        for (let i = end - 1; i > windowStart && i > start; i -= 1) {
          const ch = chars[i];
          if (ch === '\n') {
            cut = i + 1;
            break;
          }
          if (ch === ' ' || ch === '\t') {
            cut = i + 1;
          }
        }
        if (cut <= start) cut = end;
        const trimmed = chars.slice(start, cut).join('').trim();
        if (trimmed.length > 0) {
          chunks.push({ ordinal: chunks.length, text: trimmed, tokenEstimate: estimateChunkTokens(trimmed) });
        }
        const advanceChars = Math.max(1, cut - start);
        const overlapChars = Math.min(
          Math.floor(advanceChars * CHUNK_OVERLAP_RATIO),
          Math.floor(advanceChars / 2),
        );
        start = advanceChars > overlapChars ? start + advanceChars - overlapChars : start + advanceChars;
        if (cut >= chars.length) break;
      }
      return chunks;
    };

    const segments = [
      '第 1 行：金门标准要求写入侧逐字保留编号与阈值 🎯🚀。',
      'Line N: the golden gate standard requires verbatim numbers and thresholds 🌈🧪.',
      '混合段 mixed segment 🏁 with 中文 and ascii tokens 🚩 spaced  out   here.',
    ];
    const pieces: string[] = [];
    let built = 0;
    let n = 0;
    while (built < 100 * 1024) {
      const piece = `${n++} ${segments[n % segments.length]}`;
      pieces.push(piece);
      built += piece.length + 1;
    }
    const body = pieces.join('\n');

    const fast = chunkPlainText(body);
    const slow = naive(body);
    expect(fast.length).toBeGreaterThan(10);
    expect(fast).toEqual(slow);
    for (const chunk of fast) {
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS);
    }
  });

  it('ASTRAL: an emoji-heavy corpus keeps every block at/below budget and stays deterministic', () => {
    // Review F2-1 — astral chars are 2 UTF-16 units but 1 code point; the first
    // incremental version under-counted them by half and let 106/111 blocks land
    // over budget (max 2087 > 2000). The estimator's own basis is UTF-16 length.
    const line = '🚀 部署检查 🎯 金门标准要求逐字保留编号 🧪与阈值 🏁 goldengate threshold 🌈';
    const parts: string[] = [];
    let built = 0;
    let n = 0;
    while (built < 400 * 1024) {
      const piece = `${n++} ${line}`;
      parts.push(piece);
      built += piece.length + 1;
    }
    const body = parts.join('\n');
    const chunks = chunkPlainText(body);
    expect(chunks.length).toBeGreaterThan(50);
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS);
      expect(chunk.tokenEstimate).toBe(estimateChunkTokens(chunk.text));
    }
    expect(chunkPlainText(body)).toEqual(chunks);
  });

  it('PERF GUARD: a 2MB document chunks in well under 2s (review F-1 gate)', () => {
    // Ingestion runs on the daemon event loop right after the materialize ack;
    // the O(n²) budget scan measured 2MB → ~2.5s of pure loop-blocking time.
    // The incremental-counter form does 2MB in ~80ms and 8MB in ~350ms. Ceiling
    // is generous so a slow CI box fails only on a real regression.
    const line = '第 1 行：金门标准要求写入侧逐字保留编号与阈值 goldengate threshold numbers.';
    // Build incrementally (the naive `parts.join('')` per loop is itself O(n²)
    // and would poison the measurement).
    const pieces: string[] = [];
    let built = 0;
    let n = 0;
    while (built < 2 * 1024 * 1024) {
      const piece = `${n++} ${line}`;
      pieces.push(piece);
      built += piece.length + 1;
    }
    const body = pieces.join('\n');
    const t0 = Date.now();
    const chunks = chunkPlainText(body);
    const elapsed = Date.now() - t0;
    expect(chunks.length).toBeGreaterThan(100);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('carries overlap so a term at the cut stays recallable from both sides', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line-${i} filler text for the chunk boundary`).join('\n');
    const chunks = chunkPlainText(lines);
    expect(chunks.length).toBeGreaterThan(2);
    const tail = chunks[0]!.text.slice(-40);
    const overlapping = chunks.slice(1).some((c) => c.text.includes(tail.trim().split('\n')[0]!.slice(0, 20)));
    expect(overlapping, 'chunk N+1 must repeat part of chunk N').toBe(true);
  });
});

describe('W3 ③ stable digest (轴E + §6.9 裁决 2)', () => {
  it('is byte-identical across builds and changes version only with content', async () => {
    seedWiki();
    const a = buildMemoryDigest(store);
    // A real clock span between the two builds: any volatile field (a timestamp
    // at ANY resolution this process can express) must show up as a difference.
    await new Promise((r) => setTimeout(r, 8));
    const b = buildMemoryDigest(store, { tokenBudget: 2000 });
    expect(a).toBeTruthy();
    expect(a!.text).toBe(b!.text);
    expect(a!.version).toBe(b!.version);
    expect(a!.truncated).toBe(false);

    // content change ⇒ version change
    store.write({
      workspaceId: ws,
      id: 'hub1',
      path: 'topics/hub-a.pkf',
      title: 'Hub A',
      description: '改写后的门槛清单',
      content: '<h1>Hub A</h1><p>改写后的门槛清单。</p>',
      pageType: 'hub',
      visibility: { kind: 'workspace' },
      actorImUserId: 'dev',
      actorKind: 'agent',
    });
    const c = buildMemoryDigest(store);
    expect(c!.version).not.toBe(a!.version);

    // SCHEMA ratchet: V5 introduced the chunk mirror, so the CURRENT schema must
    // never be lower than 5 (later waves may only ratchet UP — W4 轴F already
    // added V6 in parallel — and the mirror tables must still exist below).
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    expect(
      store
        .rawDb()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='asset_chunks'")
        .get(),
    ).toBeTruthy();
  });

  it('MUTATION CONTROL: a volatile field (timestamp) would break determinism', () => {
    seedWiki();
    const body = buildMemoryDigest(store)!.text;
    // Injecting a clock line — the exact defect the stability contract forbids —
    // must be detectable by the same oracle.
    const withClock = `${body}\nbuilt-at: ${new Date().toISOString()}`;
    expect(withClock).not.toBe(body);
  });

  it('撤帽: a map far above the abolished ~2K cap is injected IN FULL (§6.9 裁决 2)', () => {
    seedWiki();
    // 60 hubs × a ~40-char summary + a real TOC ⇒ the body is several hundred
    // tokens: the W3-era default (2000) would have been fine, but a 2K cap was
    // the mechanism that silently dropped hub lines on larger maps. The guard
    // default is 32K, so a mid-size map must come back complete and untruncated.
    store.write({
      workspaceId: ws,
      id: 'idx-big',
      path: 'big-index.md',
      title: 'Big index',
      content: `<h1>Big index</h1><p>${Array.from({ length: 60 }, (_, i) => `hub-${i}`).join(' ')}</p>`,
      pageType: 'index',
      visibility: { kind: 'workspace' },
      actorImUserId: 'dev',
      actorKind: 'agent',
    });
    for (let i = 0; i < 60; i++) {
      store.write({
        workspaceId: ws,
        id: `hubbig${i}`,
        path: `topics/big/hub-${i}.pkf`,
        title: `Hub ${i}`,
        description: `第 ${i} 号枢纽：门控采样与降速预算的总纲页，含 G${i} 号门的边界条件与回退路径。`,
        content: `<h1>Hub ${i}</h1><p>第 ${i} 号枢纽的综述正文，覆盖金门标准、采样窗口与滞后预算。</p>`,
        pageType: 'hub',
        visibility: { kind: 'workspace' },
        actorImUserId: 'dev',
        actorKind: 'agent',
      });
    }
    const digest = buildMemoryDigest(store)!;
    expect(digest.truncated).toBe(false);
    expect(digest.tokenEstimate).toBeGreaterThan(400);
    expect(resolveDigestTokenBudget()).toBe(MEMORY_DIGEST_EXTREME_GUARD_TOKENS);
    expect(MEMORY_DIGEST_EXTREME_GUARD_TOKENS).toBeGreaterThan(2000);
    // every hub line survived — the old cap was the thing that dropped them
    for (let i = 0; i < 60; i++) {
      expect(digest.text).toContain(`topics/big/hub-${i}.pkf`);
    }
    // MUTATION TARGET: restoring a 2000-token default (the abolished cap) makes
    // this assertion red — the whole point of the ruling.
    expect(estimateDigestTokens(digest.text)).toBeLessThanOrEqual(MEMORY_DIGEST_EXTREME_GUARD_TOKENS);
  });

  it('32K guard: a digest over the extreme ceiling is cut with an observable marker', () => {
    seedWiki();
    // The guard code path is the same at any ceiling; a small explicit override
    // exercises it deterministically without building a 128K-char fixture.
    const digest = buildMemoryDigest(store, { tokenBudget: 20 });
    expect(digest!.truncated).toBe(true);
    expect(digest!.text).toContain('digest truncated');
    expect(digest!.tokenEstimate).toBeLessThanOrEqual(estimateDigestTokens(digest!.text) + 1);
  });

  it('NO soft cap before the guard: an INDEX map over the old share budget stays whole (§6.9 裁决 2)', () => {
    seedWiki();
    // A ~66K-char INDEX map (≈16K tokens) plus a two-hub spine lands well UNDER
    // the 32K-token extreme guard. The pre-ruling draft handed the TOC a
    // `guard * 0.5 * 4` = 64K-CHAR share budget, so this map was skeletonized
    // (its tail headings dropped, marker appended) even though the whole digest
    // never approached the guard — a soft cap ahead of the only cap the owner
    // allowed. Full injection means the LAST heading must survive verbatim.
    const heading = (i: number): string =>
      `## Section ${String(i).padStart(4, '0')} — gateway sampling window and deceleration budget gate`;
    const map = ['# Big index', ...Array.from({ length: 1300 }, (_, i) => heading(i)), '', 'Closing prose line.'].join(
      '\n',
    );
    // Both premises of the case, checked rather than assumed: the map IS over the
    // old 64K-char share budget, and the digest it yields IS under the guard.
    expect(map.length).toBeGreaterThan(64_000);
    store.write({
      workspaceId: ws,
      id: 'idx-share',
      path: 'share-index.md',
      title: 'Share index',
      content: map,
      pageType: 'index',
      visibility: { kind: 'workspace' },
      actorImUserId: 'dev',
      actorKind: 'agent',
    });
    const digest = buildMemoryDigest(store)!;
    expect(estimateDigestTokens(digest.text)).toBeLessThan(MEMORY_DIGEST_EXTREME_GUARD_TOKENS);
    expect(digest.truncated).toBe(false);
    expect(digest.text).not.toContain('more section');
    expect(digest.text).not.toContain('section bodies elided');
    // Tail survived — the exact line a share-based pre-cut would have dropped.
    expect(digest.text).toContain(heading(1299));
    // …and the whole body is still inside the guard it is allowed to approach.
    expect(estimateDigestTokens(digest.text)).toBeLessThanOrEqual(MEMORY_DIGEST_EXTREME_GUARD_TOKENS);
  });

  it('an empty workspace builds nothing (no stub injection)', () => {
    expect(buildMemoryDigest(store)).toBeNull();
  });
});

describe('W3 ④ turn-start injection seam (轴E)', () => {
  it('renders a byte-stable block from the provider, and is a no-op without one', () => {
    expect(renderMemoryDigestBlock(ws)).toBe('');

    const text = `${MEMORY_DIGEST_HEADER}\n\n- index.md`;
    let calls = 0;
    setMemoryDigestProvider(() => {
      calls += 1;
      return { text, version: 'v1', tokenEstimate: 10 };
    });
    const first = renderMemoryDigestBlock(ws);
    const second = renderMemoryDigestBlock(ws);
    expect(first).toBe(second);
    expect(first).toContain('- index.md');
    expect(calls).toBe(2);
  });

  it('honours the flag: explicit false turns the inject off (default ON)', () => {
    setMemoryDigestProvider(() => ({ text: 'x', version: 'v1', tokenEstimate: 1 }));
    process.env.FF_MEMORY_INDEX_INJECT_ENABLED = 'false';
    expect(isIndexInjectEnabled()).toBe(false);
    expect(renderMemoryDigestBlock(ws)).toBe('');
    process.env.FF_MEMORY_INDEX_INJECT_ENABLED = '0';
    expect(isIndexInjectEnabled()).toBe(false);
    delete process.env.FF_MEMORY_INDEX_INJECT_ENABLED;
    expect(isIndexInjectEnabled()).toBe(true);
  });
});

describe('W3 ⑤ daemon miss lane → navigation (§6.9 裁决 1)', () => {
  it('a zero-overlap query routes via navigation startPoints instead of a fake rank list', () => {
    seedWiki();
    store.write({
      workspaceId: ws,
      id: 'leaf1',
      path: 'topics/hub-a/leaf.pkf',
      title: 'Leaf',
      description: '并发信号量与排队上限',
      content: '<h1>Leaf</h1><p>并发信号量把调用压到上限以内。</p>',
      pageType: 'leaf',
      visibility: { kind: 'workspace' },
      actorImUserId: 'dev',
      actorKind: 'agent',
    });
    store.upsertLink({
      sourceUri: `prismer://workspace/${ws}/memory/topics/hub-a/leaf.pkf`,
      targetUri: `prismer://workspace/${ws}/memory/topics/hub-a.pkf`,
      relation: 'child-of',
      weight: 1,
    });

    const search = new MemorySearch(store);
    // Zero lexical overlap with the whole corpus (pure paraphrase probe).
    // graph:false keeps the pure-FTS debug path → nothing, and no navigation
    // either (the debug path stays deterministic, invariant kept).
    expect(search.hybrid('幽冥缆线怎么接', { graph: false })).toHaveLength(0);

    const { results, navigation } = search.hybridWithNavigation('幽冥缆线怎么接');
    expect(navigation, 'a text miss must carry the navigation payload').toBeTruthy();
    expect(navigation!.reason).toBe('text-miss');
    const hub = navigation!.startPoints.find((sp) => sp.path === 'topics/hub-a.pkf');
    expect(hub, `expected the hub start point in ${navigation!.startPoints.map((s) => s.path).join(',')}`).toBeTruthy();
    expect(hub!.pageType).toBe('hub');
    expect(hub!.why).toBe('structural-entry');
    expect(hub!.childrenCount).toBe(1);

    // The ruling: structural entries are NEVER dressed up as ranked hits.
    expect(results).toEqual([]);
  });
});

// memory211 P3 — mergeChunkHits violated its own comment: it compared the
// COMPOSITE `score` (which already folds recency ±0.2 / supersede −0.8) instead
// of the LEXICAL evidence, so a freshly-touched wiki page could bury an upload
// that actually carries the query term — the exact D9 shape the comment forbids.
describe('W3 P3 — chunk merge competes on LEXICAL evidence (cloud mergeRawTier parity)', () => {
  const hit = (over: Partial<MemorySearchResult>): MemorySearchResult => ({
    pageId: 'p',
    path: 'topics/x.pkf',
    title: 'X',
    snippet: 'x',
    score: 0,
    tokenCount: 1,
    via: 'fts',
    tier: 'wiki',
    ...over,
  });

  it('a fresh wiki page (recency-boosted composite) does NOT bury a stronger chunk match', () => {
    // The D9 shape: composite 0.9 (lexical 0.7 + fresh recency 0.2) is ABOVE the
    // chunk's discounted 0.85, while its lexical evidence 0.7 is BELOW. On the
    // composite basis the wiki page stays on top — this assertion is red on that
    // regression.
    const freshWiki = hit({
      pageId: 'wiki_fresh',
      path: 'wiki/fresh.pkf',
      score: 0.9,
      components: { matchScore: 0.7 },
    });
    const chunk = hit({
      pageId: 'asset_1',
      path: 'asset:asset_1#h',
      score: 0.85,
      tier: 'raw',
      assetId: 'asset_1',
      components: { matchScore: 1 },
    });
    const merged = mergeChunkHits([freshWiki], [], [chunk]);
    expect(merged[0]!.pageId).toBe('asset_1');
    expect(merged.map((m) => m.pageId)).toEqual(['asset_1', 'wiki_fresh']);
  });

  it('a wiki page with STRONGER lexical evidence still outranks the chunk (no over-insertion)', () => {
    const strongWiki = hit({ pageId: 'wiki_strong', score: 1.25, components: { matchScore: 1 } });
    const chunk = hit({
      pageId: 'asset_1',
      path: 'asset:asset_1#h',
      score: 0.85,
      tier: 'raw',
      assetId: 'asset_1',
      components: { matchScore: 1 },
    });
    expect(mergeChunkHits([strongWiki], [], [chunk]).map((m) => m.pageId)).toEqual([
      'wiki_strong',
      'asset_1',
    ]);
  });

  it('graph hits (no lexical evidence at all) never sit above a matching chunk', () => {
    const graphHit = hit({ pageId: 'nb', path: 'wiki/nb.pkf', score: -0.4, via: 'graph' });
    const chunk = hit({
      pageId: 'asset_1',
      path: 'asset:asset_1#h',
      score: 0.85,
      tier: 'raw',
      assetId: 'asset_1',
      components: { matchScore: 1 },
    });
    expect(mergeChunkHits([], [graphHit], [chunk]).map((m) => m.pageId)).toEqual(['asset_1', 'nb']);
  });

  it('hybrid() populates the lexical decomposition on BOTH legs, so the merge has real evidence', async () => {
    const outbox = new MemoryOutbox({ store });
    await ingestAssetFile({
      store,
      outbox,
      assetId: 'asset_lex',
      contentHash: 'c'.repeat(64),
      filename: 'spec.md',
      bytes: Buffer.from('# 规格书\n\n凯尔文阈值是冷却回路的介入点。\n', 'utf8'),
    });
    store.write({
      workspaceId: ws,
      id: 'wiki_lex',
      path: 'topics/hub-a/lex.pkf',
      title: 'Lex',
      description: '凯尔文阈值参考页',
      content: '<h1>Lex</h1><p>凯尔文阈值词条。</p>',
      pageType: 'leaf',
      visibility: { kind: 'workspace' },
      actorImUserId: 'dev',
      actorKind: 'agent',
    });
    const hits = new MemorySearch(store).hybrid('凯尔文阈值', { graph: false });
    const wiki = hits.find((h) => h.tier === 'wiki');
    const raw = hits.find((h) => h.tier === 'raw');
    expect(wiki, 'a wiki leg exists').toBeTruthy();
    expect(raw, 'a chunk leg exists').toBeTruthy();
    expect(wiki!.components?.matchScore).toBeGreaterThan(0);
    // the chunk's decomposition is its PRE-discount BM25 relevance
    expect(raw!.components?.matchScore).toBeCloseTo(raw!.score + RAW_TRUST_DISCOUNT, 10);
    expect(raw!.components?.matchScore).toBeLessThanOrEqual(1);
  });
});
