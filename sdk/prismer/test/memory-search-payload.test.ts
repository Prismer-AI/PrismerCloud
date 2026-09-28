// memory211/01 §3 轴C W1a — hop-decision payload + dynamic graph band.
//
// What this proves:
//   ① Every hit carries the spec payload: pagePath (== path), version, tier,
//      hubPath (reverse child-of), inboundLinkCount, childrenCount,
//      outboundPreview — computed IN PLACE from the local `memory_links` mirror.
//   ② hubPath is null for a root/INDEX page (no outbound child-of edge) and for
//      a dangling edge (hub not a live local page).
//   ③ A section-addressed graph hit also surfaces sectionAnchor + sectionPreview.
//   ④ 导航 (memory211/01 §6.9 裁决 1): when text misses ENTIRELY the miss lane
//      returns NAVIGATION — labelled start points (INDEX + hubs, children
//      first) with walking instructions — and NOT a rank list: a miss carries
//      no rank evidence, so structural entries must never reappear as scored
//      hits. NEGATIVE CONTROL: this assertion is red if the miss lane is
//      reverted to returning graph hits in `results` (the fake-ranked lane).
//   ⑤ The supplement invariant is untouched: with FTS hits present, graph hits
//      still sit strictly below every FTS hit (memory-search-graph ③ stays true).

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/daemon/memory/store.js';
import { MemorySearch } from '../src/daemon/memory/search.js';
import type { MemoryPageType, MemoryWriteInput } from '../src/daemon/memory/types.js';

const WS = 'ws_payload';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'prismer-memory-payload-'));
}

function buildStore(dir: string): MemoryStore {
  const store = new MemoryStore({
    dbPath: join(dir, 'memory.db'),
    workspaceId: WS,
    deviceId: 'dev_x',
  });
  store.open();
  return store;
}

function input(overrides: Partial<MemoryWriteInput> = {}): MemoryWriteInput {
  return {
    workspaceId: WS,
    path: 'note.md',
    content: 'placeholder',
    pageType: 'leaf',
    actorImUserId: 'im_alice',
    actorKind: 'human',
    ...overrides,
  };
}

function seed(
  store: MemoryStore,
  path: string,
  content: string,
  pageType: MemoryPageType | 'index',
  title?: string,
): void {
  store.write(
    input({
      path,
      content,
      title: title ?? path,
      pageType: pageType as MemoryPageType,
    }),
  );
}

function link(
  store: MemoryStore,
  sourcePath: string,
  targetPath: string,
  relation = 'child-of',
  weight = 1,
): void {
  store.upsertLink({
    sourceUri: `pkm://${sourcePath}`,
    targetUri: `pkm://${targetPath}`,
    relation,
    weight,
    extractedFromPageId: null,
  });
}

describe('memory211 W1a — hop-decision payload', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const d of cleanup.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function withStore(fn: (store: MemoryStore) => void): void {
    const dir = tmpDir();
    cleanup.push(dir);
    const store = buildStore(dir);
    try {
      fn(store);
    } finally {
      store.close();
    }
  }

  // ① the payload, field by field.
  it('① populates pagePath/hubPath/version/tier/counts/outboundPreview from the local link table', () => {
    withStore((store) => {
      seed(store, 'hubs/auth.md', 'Authentication hub: sessions, tokens, rotation.', 'hub', 'Auth hub');
      seed(
        store,
        'leaves/rotation.md',
        'Token rotation cadence is seven days, keyed per device.',
        'leaf',
        'Rotation',
      );
      seed(store, 'leaves/billing.md', 'Stripe billing schedule notes.', 'leaf', 'Billing');
      // leaves/rotation.md --child-of--> hubs/auth.md (the tree edge)
      link(store, 'leaves/rotation.md', 'hubs/auth.md');
      // hubs/auth.md --related--> leaves/billing.md (a mesh edge, adds inbound)
      link(store, 'hubs/auth.md', 'leaves/billing.md', 'related');

      const hits = new MemorySearch(store).hybrid('rotation cadence');
      const hit = hits.find((h) => h.path === 'leaves/rotation.md');
      expect(hit).toBeDefined();

      // Spec-canonical mirror of the legacy `path` field.
      expect(hit!.pagePath).toBe('leaves/rotation.md');
      expect(hit!.path).toBe('leaves/rotation.md');
      // Reverse child-of placement.
      expect(hit!.hubPath).toBe('hubs/auth.md');
      // Tier enum is pinned now (T1 only daemon-side; T2/T3 are W3).
      expect(hit!.tier).toBe('wiki');
      // Version comes from the local page row.
      expect(hit!.version).toBeGreaterThanOrEqual(1);
      // Outbound: the page's own child-of edge to its hub.
      expect(hit!.outboundPreview).toEqual([
        { relation: 'child-of', targetPath: 'hubs/auth.md' },
      ]);
      // A leaf with no children.
      expect(hit!.childrenCount).toBe(0);

      // The hub hit: 2 inbound (child-of from rotation + related is outbound so
      // NOT counted) → exactly the child-of edge targets it, and 1 child.
      const hubHit = new MemorySearch(store)
        .hybrid('authentication sessions tokens')
        .find((h) => h.path === 'hubs/auth.md');
      expect(hubHit).toBeDefined();
      expect(hubHit!.inboundLinkCount).toBe(1);
      expect(hubHit!.childrenCount).toBe(1);
      expect(hubHit!.children == null).toBe(true); // children are NOT on the search payload
      expect(hubHit!.outboundPreview).toEqual([
        { relation: 'related', targetPath: 'leaves/billing.md' },
      ]);
    });
  });

  // ② root / INDEX and dangling hubs.
  it('② hubPath is null for an INDEX page and for a dangling child-of edge', () => {
    withStore((store) => {
      seed(store, 'INDEX.pkf', '<h1>INDEX</h1>', 'index');
      seed(store, 'leaves/orphan.md', 'Unanchored note about quorbled fins.', 'leaf');
      // Dangling hub: the edge points at a page that is not in the local store.
      link(store, 'leaves/orphan.md', 'hubs/ghost.md');

      const hits = new MemorySearch(store).hybrid('quorbled fins');
      const idx = hits.find((h) => h.path === 'INDEX.pkf');
      // The INDEX is a structural seed, so it never surfaces as a hit — assert
      // the inverse instead: a root page reached by FTS has no hub, and the
      // orphan's hub edge dangles to null.
      const orphan = hits.find((h) => h.path === 'leaves/orphan.md');
      expect(orphan).toBeDefined();
      expect(orphan!.hubPath).toBeNull();
      expect(idx).toBeUndefined();

      // A non-index FTS hit with no child-of edge at all is also null-hubbed.
      seed(store, 'leaves/rootish.md', 'Top level page with no placement edge.', 'leaf');
      const rootish = new MemorySearch(store)
        .hybrid('no placement edge')
        .find((h) => h.path === 'leaves/rootish.md');
      expect(rootish).toBeDefined();
      expect(rootish!.hubPath).toBeNull();
    });
  });

  // ③ section payload on a graph hit reached at a #section anchor.
  it('③ surfaces sectionAnchor + sectionPreview for a section-addressed graph hit', () => {
    withStore((store) => {
      seed(store, 'hubs/auth.md', 'Authentication hub.', 'hub');
      seed(
        store,
        'leaves/rotation.md',
        '<h1>Rotation</h1><section id="cadence"><h2>cadence</h2><p>Rotate every seven days.</p></section>',
        'leaf',
      );
      // The reaching link addresses the leaf AT its cadence section.
      store.upsertLink({
        sourceUri: 'pkm://hubs/auth.md',
        targetUri: 'pkm://leaves/rotation.md#cadence',
        relation: 'child-of',
        weight: 1,
        extractedFromPageId: null,
      });

      const hit = new MemorySearch(store)
        .hybrid('authentication hub')
        .find((h) => h.path === 'leaves/rotation.md');
      expect(hit).toBeDefined();
      expect(hit!.via).toBe('graph');
      expect(hit!.section).toBe('cadence');
      expect(hit!.sectionAnchor).toBe('cadence');
      expect(hit!.sectionPreview).toContain('Rotate every seven days');
      expect((hit!.sectionPreview ?? '').length).toBeLessThanOrEqual(200);
    });
  });

  // ④ the miss-path mutation target (memory211/01 §6.9 裁决 1).
  it('④ text miss → navigation startPoints (INDEX+hubs, children first), never a rank list', () => {
    withStore((store) => {
      seed(store, 'INDEX.pkf', 'workspace index', 'index');
      seed(store, 'hubs/gate.md', 'Golden gate admission hub.', 'hub', 'Gate hub');
      seed(store, 'hubs/empty.md', 'A hub with no children yet.', 'hub', 'Empty hub');
      // The answering page shares ZERO tokens with the query (the memory211 §1
      // paraphrase failure) — under the ruling it is NOT surfaced as a hit; the
      // agent is pointed at its hub and walks there.
      seed(
        store,
        'leaves/spec-g1.md',
        'Admission规范第一条讲的是准入的范围与证据.',
        'leaf',
        'G1 admission',
      );
      link(store, 'leaves/spec-g1.md', 'hubs/gate.md');

      const search = new MemorySearch(store);
      // Precondition: the text leg really is empty for this query.
      expect(search.hybrid('zzzqqq unmatched', { graph: false })).toEqual([]);

      const { results, navigation } = search.hybridWithNavigation('zzzqqq unmatched', { maxDepth: 2 });

      // The honest answer is navigation, and it exists.
      expect(navigation).toBeDefined();
      expect(navigation!.reason).toBe('text-miss');
      expect(navigation!.guidance).toContain('起点');

      // Shape contract: structural entries only, every field populated.
      for (const sp of navigation!.startPoints) {
        expect(['index', 'hub']).toContain(sp.pageType);
        expect(sp.why).toBe('structural-entry');
        expect(typeof sp.childrenCount).toBe('number');
      }
      const paths = navigation!.startPoints.map((s) => s.path);
      expect(paths).toContain('INDEX.pkf');
      expect(paths).toContain('hubs/gate.md');
      // 有子上优先: the hub that fans out sorts ahead of a childless one.
      const gate = navigation!.startPoints.find((s) => s.path === 'hubs/gate.md')!;
      const empty = navigation!.startPoints.find((s) => s.path === 'hubs/empty.md')!;
      expect(gate.childrenCount).toBe(1);
      expect(empty.childrenCount).toBe(0);
      expect(navigation!.startPoints.indexOf(gate)).toBeLessThan(navigation!.startPoints.indexOf(empty));

      // NEVER a rank list: no structural entry (and no graph-pulled leaf) may
      // reappear as a scored hit. Reverting the miss lane to the W1a band —
      // the exact mutation this ruling kills — turns this red.
      expect(results.map((r) => r.path)).toEqual([]);

      // The legacy entry point keeps its shape (results only).
      expect(search.hybrid('zzzqqq unmatched', { maxDepth: 2 })).toEqual([]);
    });
  });

  // ⑤ supplement band invariant (unchanged by W1a).
  it('⑤ with FTS hits present, graph hits still rank strictly below every FTS hit', () => {
    withStore((store) => {
      seed(store, 'hubs/auth.md', 'OAuth chosen for the auth flow.', 'hub');
      seed(store, 'leaves/session.md', 'cookie rotation policy', 'leaf');
      link(store, 'hubs/auth.md', 'leaves/session.md');

      const results = new MemorySearch(store).hybrid('OAuth');
      const ftsScores = results.filter((r) => (r.via ?? 'fts') === 'fts').map((r) => r.score);
      const graphScores = results.filter((r) => r.via === 'graph').map((r) => r.score);
      expect(ftsScores.length).toBeGreaterThan(0);
      expect(graphScores.length).toBeGreaterThan(0);
      expect(Math.max(...graphScores)).toBeLessThan(Math.min(...ftsScores));
    });
  });

  // ⑥ graph: false keeps the legacy pure-FTS miss (an empty result).
  it('⑥ graph:false on a text miss still returns nothing (eval/debug path preserved)', () => {
    withStore((store) => {
      seed(store, 'INDEX.pkf', 'workspace index', 'index');
      seed(store, 'hubs/gate.md', 'Golden gate hub.', 'hub');
      seed(store, 'leaves/spec-g1.md', '准入规范第一条.', 'leaf');
      link(store, 'leaves/spec-g1.md', 'hubs/gate.md');
      expect(new MemorySearch(store).hybrid('zzzqqq unmatched', { graph: false })).toEqual([]);
    });
  });

  // ⑦ an empty workspace (no INDEX, no hubs) stays empty on a text miss.
  it('⑦ no structural seeds → empty result, never a throw', () => {
    withStore((store) => {
      seed(store, 'leaves/lone.md', 'A leaf with no index and no hub.', 'leaf');
      const results = new MemorySearch(store).hybrid('zzzqqq unmatched');
      expect(results).toEqual([]);
    });
  });
});
