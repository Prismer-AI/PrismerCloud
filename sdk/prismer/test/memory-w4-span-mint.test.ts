// memory211/01 W4 轴F — daemon lazy span mint (mint 即升层) + recall tier flip.
//
// Contracts, each with a red side:
//   1. MINT — a distilled page that cites a raw chunk (scoped/bare/token pointer
//      forms) gets that chunk's mirror row a deterministic `sp-<16hex>` sid, and
//      the SAME sid the cloud twin derives (byte-identical algorithm).
//   2. PROMOTE — the minted chunk recalls as `tier:'asset'` LOCALLY and no longer
//      pays the raw trust discount; an uncited chunk stays `tier:'raw'`.
//   3. UPSYNC — the mint rides the SAME idempotent `asset.chunk.upsert` channel
//      with the sid attached, so the cloud authoritative row promotes too.
//   4. IDEMPOTENT + ONE-WAY — re-running the mint keeps one sid, one outbox event
//      (idempotencyKey), and never un-mints. Negative control: an asset with no
//      mirror rows cannot be minted, and content without pointers is a no-op.
//
// Store V6 note: the mirror gains the `sid` column; a V5 store is migrated
// forward on open (SCHEMA_VERSION pin below is the regression tripwire).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore, SCHEMA_VERSION } from '../src/daemon/memory/store.js';
import { MemorySearch } from '../src/daemon/memory/search.js';
import { MemoryOutbox } from '../src/daemon/memory/outbox.js';
import { ingestAssetFile } from '../src/daemon/memory/asset-chunks.js';
import {
  extractAssetRefs,
  isSpanSid,
  mintChunkSid,
  promoteReferencedAssetSpans,
} from '../src/daemon/memory/span-mint.js';

const ws = 'w4_daemon_ws';
let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'w4-memory-')), 'memory.db');
  store = new MemoryStore({ dbPath, workspaceId: ws, deviceId: 'dev' });
  store.open();
});

afterEach(() => {
  store.close();
  rmSync(dbPath, { force: true });
});

async function seedMirror(assetId: string, contentHash: string, body: string): Promise<number> {
  const outbox = new MemoryOutbox({ store });
  const res = await ingestAssetFile({ store, outbox, assetId, contentHash, filename: 'runbook.md', bytes: Buffer.from(body, 'utf8') });
  expect(res.status).toBe('indexed');
  return res.chunks;
}

const RUNBOOK = [
  '# Zenith bypass runbook',
  '',
  ...Array.from({ length: 400 }, (_, i) => `第 ${i} 行：凯尔文阈值决定冷却回路的介入时机，Zenith Bypass 是硬件级旁路。`),
  '',
  '## Quench',
  '',
  '淬火窗口限制 Halcyon Lattice 重新武装的频率。',
].join('\n');

describe('W4 ① lazy mint (deterministic, mirrored with cloud)', () => {
  it('pins the schema bump to V6 (store V6 = chunk mirror + span sid)', () => {
    expect(SCHEMA_VERSION).toBe(6);
  });

  it('mints the SHARED literal vector — the cloud⇄daemon drift tripwire (W4 fix W4-2b)', () => {
    // Recomputing the algorithm locally proves nothing about AGREEMENT: if the
    // daemon twin or the cloud twin ever drifts, both suites stay green while
    // sections' rawSpanSids dangle. Both sides therefore pin the SAME five-tuple
    // to the SAME literal hex.
    // cloud counterpart: src/im/tests/acp-memory-span-anchors.test.ts「shared literal vector」.
    expect(
      mintChunkSid({
        assetId: 'asset_vector',
        contentHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        ordinal: 3,
        text: 'golden vector',
      }),
    ).toBe('sp-c9f901cbad3c8af1');
  });

  it('mints a cited chunk with the same sid the cloud twin derives', async () => {
    const hash = 'c'.repeat(64);
    await seedMirror('asset_1', hash, RUNBOOK);
    const chunk = store.currentAssetChunks('asset_1')[0]!;
    const expected = `sp-${(
      // cloud twin: src/im/services/memory-span-sid.ts#mintChunkSid
      require('node:crypto').createHash('sha256')
        .update(['chunk-span:v1', chunk.assetId, chunk.contentHash, String(chunk.ordinal), require('node:crypto').createHash('sha256').update(chunk.text, 'utf8').digest('hex')].join('\n'))
        .digest('hex')
        .slice(0, 16)
    )}`;

    const outbox = new MemoryOutbox({ store });
    const before = store.stats().pendingOutbox;
    const res = promoteReferencedAssetSpans({
      store,
      outbox,
      // scoped form — the ONLY form PKF v1.1 strict lets an author write
      content: `<p>Carried from <a href="prismer://workspace/${ws}/asset/${hash}#chunk-${chunk.ordinal}" rel="derived-from">runbook</a></p>`,
      deviceId: 'dev',
    });
    expect(res.promoted).toHaveLength(1);
    expect(res.enqueued).toBe(1);
    expect(res.promoted[0]!.sid).toBe(expected);
    expect(store.currentAssetChunks('asset_1')[chunk.ordinal]!.sid).toBe(expected);
    expect(isSpanSid(expected)).toBe(true);
    expect(mintChunkSid(chunk)).toBe(expected);
    void before;
  });

  it('recognises all three pointer forms', () => {
    const hash = 'd'.repeat(64);
    expect(extractAssetRefs(`<a href="prismer://asset/asset_9#chunk-2">x</a>`)).toEqual([
      { assetId: 'asset_9', ordinal: 2 },
    ]);
    expect(extractAssetRefs(`see asset:asset_9#${hash}`)).toEqual([{ assetId: 'asset_9', contentHash: hash }]);
    expect(extractAssetRefs(`prismer://workspace/w1/asset/${hash}#chunk-3`)).toEqual([
      { contentHash: hash, ordinal: 3 },
    ]);
    expect(extractAssetRefs('no pointers here')).toEqual([]);
  });
});

describe('W4 ② mint 即升层 in local recall', () => {
  it('a minted chunk recalls as tier:asset at full evidence; uncited chunks stay raw', async () => {
    const hash = 'e'.repeat(64);
    await seedMirror('asset_1', hash, RUNBOOK);
    const outbox = new MemoryOutbox({ store });

    const before = new MemorySearch(store).hybrid('凯尔文阈值', { graph: false }).find((h) => h.tier !== undefined);
    expect(before!.tier).toBe('raw');

    promoteReferencedAssetSpans({
      store,
      outbox,
      content: `<p>Source: <a href="prismer://workspace/${ws}/asset/${hash}#chunk-0" rel="derived-from">runbook</a></p>`,
    });

    const hits = new MemorySearch(store).hybrid('凯尔文阈值', { graph: false });
    const minted = hits.find((h) => h.chunkOrdinal === 0);
    expect(minted, `expected a hit for chunk 0 among ${JSON.stringify(hits)}`).toBeTruthy();
    expect(minted!.tier).toBe('asset');
    expect(minted!.spanSid).toMatch(/^sp-[0-9a-f]{16}$/);

    // W6-finish follow-up — the chunk lane must surface MORE THAN ONE chunk of
    // the same asset. It used to dedupe by `path`, which every chunk of an asset
    // SHARES, so an 11-chunk upload recalled exactly one chunk (whichever the
    // equal-bm25 SQL ordering surfaced first) and mint-即升层 was invisible
    // whenever the cited chunk lost that coin flip — this assertion is red on
    // that collapse.
    const ordinals = hits.filter((h) => h.chunkOrdinal !== undefined).map((h) => h.chunkOrdinal);
    expect(
      new Set(ordinals).size,
      `one asset must be able to contribute several chunk hits (got ${JSON.stringify(ordinals)})`,
    ).toBeGreaterThan(1);

    // MUTATION TARGET: dropping the tier flip (or the discount branch) makes this
    // stay 'raw' — the local negative control for mint 即升层.
    const rawStill = new MemorySearch(store)
      .hybrid('淬火窗口', { graph: false })
      .find((h) => h.tier === 'raw');
    expect(rawStill, 'an uncited chunk must still recall as raw').toBeTruthy();
  });

  it('the T3 chunk window is DETERMINISTIC — equal-bm25 chunks do not reshuffle between recalls', () => {
    // W6-finish follow-up. 400 identical-structure lines make every chunk's
    // bm25 near-identical, which is exactly the corpus shape where an
    // unspecified SQL tie order shows up as flaky "which chunk is in the
    // window" failures. The lane now tie-breaks bm25-equal chunks by ordinal,
    // so repeated recalls over an unchanged store must return the SAME window
    // in the SAME order. (Assertion on an order-DEPENDENT property would just
    // move the fragility; this asserts the order itself is stable.)
    const hash = '9'.repeat(64);
    seedMirror('asset_1', hash, RUNBOOK);
    const recall = (): number[] =>
      new MemorySearch(store)
        .hybrid('凯尔文阈值', { graph: false })
        .map((h) => h.chunkOrdinal)
        .filter((o): o is number => typeof o === 'number');
    const first = recall();
    expect(first.length, 'precondition: the corpus yields a multi-chunk window').toBeGreaterThan(1);
    expect(recall()).toEqual(first);
    expect(recall()).toEqual(first);
  });
});

describe('W4 ③④ upsync + idempotency (negative controls)', () => {
  it('re-minting is a no-op: one sid, one outbox event, no un-mint', async () => {
    const hash = 'f'.repeat(64);
    await seedMirror('asset_1', hash, RUNBOOK);
    const outbox = new MemoryOutbox({ store });
    const content = `<p>Source: <a href="prismer://workspace/${ws}/asset/${hash}#chunk-0" rel="derived-from">runbook</a></p>`;

    const first = promoteReferencedAssetSpans({ store, outbox, content });
    expect(first.promoted).toHaveLength(1);
    const pendingAfterFirst = store.stats().pendingOutbox;

    const second = promoteReferencedAssetSpans({ store, outbox, content });
    expect(second.promoted).toHaveLength(0); // already minted → nothing new
    expect(store.stats().pendingOutbox).toBe(pendingAfterFirst);
    expect(store.currentAssetChunks('asset_1')[0]!.sid).toBe(first.promoted[0]!.sid);
  });

  it('content without pointers, or an unknown asset, mints nothing', async () => {
    const outbox = new MemoryOutbox({ store });
    const pending = store.stats().pendingOutbox;
    expect(promoteReferencedAssetSpans({ store, outbox, content: '<p>plain prose</p>' }).promoted).toHaveLength(0);
    expect(
      promoteReferencedAssetSpans({
        store,
        outbox,
        content: `<p><a href="prismer://asset/ghost_asset#chunk-0">missing</a></p>`,
      }).promoted,
    ).toHaveLength(0);
    expect(store.stats().pendingOutbox).toBe(pending);
  });
});
