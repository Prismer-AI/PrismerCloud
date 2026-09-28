// Composite (lexical + graph) recall over the daemon memory store.
//
// Strategy (doc memory202/07 §4 — "召回主路径在 daemon 本地"):
//   1. FTS5 BM25 over (title, path, description, content) — single corpus
//      ranked by SQLite's built-in BM25 implementation. SQLite returns
//      negative BM25 scores (lower = better); we normalize to a 0-1
//      relevance score for the result struct.
//   2. Graph expansion: take the top-K FTS hits as seeds and walk the
//      `memory_links` graph (memory202/05 §4.3 复合召回抽象) to surface pages
//      that the keyword query would miss but that are reachable from a strong
//      lexical hit. When the text leg has hits, graph hits land in a STRICTLY
//      LOWER negative score band so they never outrank a direct FTS match
//      (mirrors the cloud `memory-search.service.ts#expandViaGraph` banded
//      scoring). When the text leg misses ENTIRELY, memory211/01 §6.9 裁决 1
//      applies: the response carries navigation startPoints (INDEX + hubs,
//      children-first) with walking instructions instead of a fabricated rank
//      list.
//      memory211/01 §3 轴C also re-cast the hit payload: every returned hit now
//      carries the hop-decision fields (hubPath / tier / link counts /
//      outboundPreview) so the agent can decide 直读 vs 多跳 without a second
//      call.
//   3. Token budgeter caps aggregate snippet bytes under maxBytes so a
//      caller (e.g. recall hook) can pre-bound prompt cost.
//
// Multi-hop ring protection (memory202/05 §4.2): `maxDepth` (default 1, hard
// cap 5) + a visited-set guards against A→B→A cycles, each hop fans out to its
// top-K neighbors by edge weight, and score decays monotonically per hop so a
// 3-hop page can never tie a 1-hop page.
//
// Still out of scope here:
//   - Multi-corpus blending (BM25 over wiki + vector recall over raw chats)
//     — out of scope until embeddings ship (post-MVP).
//   - Active-memory sub-agent gating (doc 23 §10) — sits above this layer.

import type {
  MemoryStore,
  MemoryLinkNeighbor,
  MemoryPageGraphContext,
} from './store.js';
import type {
  MemorySearchOptions,
  MemorySearchResult,
  MemoryPageType,
  MemoryNavigation,
  MemoryNavigationStartPoint,
} from './types.js';
import { sliceSection } from './section.js';
import { cjkRuns } from './store.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('MemorySearch');

const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_BYTES = 8 * 1024;
const DEFAULT_THRESHOLD = 0;

// Graph-expansion defaults (memory202/05 §4.2 + §4.3).
const DEFAULT_MAX_DEPTH = 1; // align with cloud expandViaGraph (1-hop)
const HARD_MAX_DEPTH = 5; // ring-protection hard cap
const DEFAULT_GRAPH_FAN_OUT = 8; // per-hop top-N neighbors by edge weight
// Each graph hop sits one full unit below the weakest FTS hit, then decays by
// this per-hop step so a 2-hop page never ties a 1-hop page. Monotone decay.
const GRAPH_HOP_BAND = 1;
const GRAPH_HOP_DECAY = 0.5;

// ── memory211/01 §6.9 裁决 1 — the miss lane is NAVIGATION, not a band ────────
//
// The W1a "dynamic miss band" (GRAPH_MISS_PROMOTED_BAND / GRAPH_MISS_DECAY_BAND
// + applyMissBands) is REMOVED by the owner ruling: on a text miss there is no
// rank evidence at all, so scoring structural entries into a band — any band —
// was presenting a guess as a ranked answer. A miss now returns the structural
// entries in `navigation.startPoints` (INDEX + hubs, children-first) with the
// walking instructions attached; only hits with real lexical evidence (FTS or
// the T3 chunk tier) stay in the ranked `results` list.
//
// The supplement invariant is untouched: with FTS hits present, graph hits still
// sit one full band below the weakest FTS hit (test/memory-search-graph ③).

// ── memory203 doc26 Wave 4 — temporal / supersede re-scoring constants ──
// Magnitudes MIRROR the cloud ranker (`src/im/services/memory-search.service.ts`)
// so the daemon's LOCAL recall (the store the agent's `memory_search` tool hits)
// ranks temporally the same way cloud does. Kept modest so the 0-1 BM25 lexical
// relevance stays dominant — these only reorder near-ties and sink demoted pages.
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // ~30-day half-life (cloud parity)
const RECENCY_WEIGHT = 0.2; // cloud: recencyDecay · 0.2
const STALE_PENALTY = -0.5; // cloud: stale ? −0.5
const SUPERSEDED_DEMOTION = -0.8; // cloud: older/superseded/contradicted side −0.8
const SUPERSEDING_PROMOTION = 0.05; // cloud: replacing/newer side +0.05

// memory211/01 §3 轴C W1a — miss-lane structural seeds. When text misses, the
// expansion walks out from the workspace's structural entry points (INDEX +
// hubs) rather than from nothing. Bounded: the biggest workspace hub set we
// are willing to use as seeds for one recall.
const MISS_SEED_HUB_LIMIT = 8;

// memory211/01 §6.9 裁决 1 — the walking instructions attached to every miss
// response. Same three steps the skill's recall protocol teaches; the payload is
// what the model actually reads at miss time, so it carries them itself.
const MISS_NAVIGATION_GUIDANCE =
  '这些是起点不是答案。从起点走：看起点的子页列表 → 批量读（memory_search 带 queries[] 一次多查，' +
  'memory_load 逐页直读）→ 顺 links 继续展开。';
// sectionPreview cap on the hop-decision payload (memory211/01 轴C 载荷).
const SECTION_PREVIEW_CHARS = 200;

// ── memory211/01 W3 轴D — T3 raw chunk tier (band FINALIZED) ────────────────
//
// `asset_chunks_fts` (store V5) joins the recall corpus as tier:'raw'. The band
// ruling mirrors the cloud ranker (`memory-search.service.ts#mergeRawTier`):
//   • the raw hit competes on its LEXICAL evidence minus ONE trust discount
//     (raw text is uncurated — spec 轴C gives T3 the lowest trust band);
//   • it is NOT sunk below graph hits, because a graph hit carries NO lexical
//     evidence while a chunk hit matched the query — burying the upload that
//     holds the term under a structural guess re-creates D9.
const RAW_TRUST_DISCOUNT = 0.15;
export { RAW_TRUST_DISCOUNT };
/** Cap on raw hits returned per query (one upload cannot flood the recall). */
const RAW_TOP_K = 3;

interface FtsRow {
  pageId: string;
  path: string;
  title: string | null;
  snippet: string;
  // memory203 doc26 W4 — carried out of the SELECT so the post-BM25 re-scoring
  // pass can compute the stale penalty + recency decay per candidate.
  stale: number;
  updatedAt: number;
  bm25Score: number;
}

export class MemorySearch {
  constructor(private readonly store: MemoryStore) {}

  /**
   * Legacy single-list entry point. Identical to {@link hybridWithNavigation}
   * minus the navigation payload — every existing caller (recall hook, place
   * context, compaction) keeps its shape.
   */
  hybrid(query: string, options?: MemorySearchOptions): MemorySearchResult[] {
    return this.hybridWithNavigation(query, options).results;
  }

  /**
   * memory211/01 §6.9 裁决 1 — recall with the miss-path payload.
   *
   * `results` carries only hits with LEXICAL evidence (wiki FTS, T3 chunks, and
   * graph neighbours pulled FROM such hits). When the query text-missed the wiki
   * corpus, `navigation` carries the structural entry points instead — the
   * honest answer to "where does this knowledge live" is a routing map plus
   * walking instructions, not a fabricated rank list.
   */
  hybridWithNavigation(
    query: string,
    options?: MemorySearchOptions,
  ): { results: MemorySearchResult[]; navigation?: MemoryNavigation } {
    const trimmed = query.trim();
    if (trimmed.length === 0) return { results: [] };

    const topK = clamp(options?.topK ?? DEFAULT_TOP_K, 1, 50);
    const maxBytes = Math.max(options?.maxBytes ?? DEFAULT_MAX_BYTES, 256);
    const threshold = options?.relevanceThreshold ?? DEFAULT_THRESHOLD;
    const pageTypes = options?.pageType ?? null;

    const tokens = tokenizeFtsTerms(trimmed);
    if (tokens.length === 0) return { results: [] };

    const db = this.store.rawDb();
    // Pull 2x topK so threshold/budget filtering still has headroom to fill
    // the requested result count. column_index=5 → content (matches FTS5
    // column declaration in store.ts: pageId, workspaceId, path, title,
    // description, content).
    const sqlBase = `
      SELECT
        f.pageId AS pageId,
        f.path AS path,
        f.title AS title,
        snippet(memory_fts, 5, '«', '»', ' … ', 24) AS snippet,
        p.stale AS stale,
        p.updatedAt AS updatedAt,
        bm25(memory_fts) AS bm25Score
      FROM memory_fts f
      JOIN memory_pages p ON p.id = f.pageId
      WHERE f.workspaceId = ?
        AND memory_fts MATCH ?
        AND p.stale = 0
        AND p.archivedAt IS NULL
    `;
    const pageTypeClause = pageTypes && pageTypes.length > 0
      ? ` AND p.pageType IN (${pageTypes.map(() => '?').join(',')})`
      : '';
    const sql = `${sqlBase}${pageTypeClause} ORDER BY bm25Score LIMIT ?`;

    const runFts = (ftsQuery: string): FtsRow[] => {
      const params: unknown[] = [
        this.store.workspaceId(),
        ftsQuery,
        ...(pageTypes ?? []),
        topK * 2,
      ];
      try {
        return db.prepare(sql).all(...params) as FtsRow[];
      } catch (err) {
        // FTS5 throws on syntactically invalid MATCH expressions. We sanitize
        // input via tokenizeFtsTerms() so this is unexpected — surface as empty
        // results rather than propagating to the caller. Log line tags the
        // query for observability.
        log.warn(
          `FTS5 MATCH rejected query=${JSON.stringify(ftsQuery)}: ${(err as Error).message}`,
        );
        return [];
      }
    };

    // AND-first, OR-fallback (precision preferred; OR is the recall gate).
    // The default AND join is the most precise: a page must contain every term.
    // When that yields nothing AND the query has ≥2 terms, relax to OR so a
    // multi-word query ("helios throughput target") still recalls pages that
    // match a subset — BM25 still ranks pages matching MORE terms higher, so
    // precision is preserved within the relaxed set. Single-term queries have
    // no AND/OR distinction, so we never run the second pass for them.
    // W2 #7: both passes go through buildFtsMatchQuery, which offers the query's
    // CJK bigrams as alternatives (see its docstring) — a pure-Chinese query is
    // no longer a guaranteed zero.
    let rows = runFts(buildFtsMatchQuery(trimmed, 'AND'));
    if (rows.length === 0 && tokens.length > 1) {
      const orRows = runFts(buildFtsMatchQuery(trimmed, 'OR'));
      if (orRows.length > 0) {
        log.info(
          `AND miss → OR fallback recalled ${orRows.length} hit(s) for ${tokens.length}-term query`,
        );
        rows = orRows;
      }
    }

    // Graph knobs are resolved up front because they gate the supplement lane.
    const graphEnabled = options?.graph !== false;
    const maxDepth = clamp(options?.maxDepth ?? DEFAULT_MAX_DEPTH, 0, HARD_MAX_DEPTH);
    const fanOut = clamp(options?.graphFanOut ?? DEFAULT_GRAPH_FAN_OUT, 1, 100);

    // W3 轴D — the chunk tier runs on EVERY query: it is part of the same
    // corpus. Kept SEPARATE from the wiki BM25 rows (a chunk has no page row, so
    // BM25 normalization across the two corpora would be meaningless) and merged
    // at the end by lexical evidence.
    const chunkHits = this.searchAssetChunks(trimmed, Math.min(topK, RAW_TOP_K));

    // ── memory211/01 §6.9 裁决 1 — text fully missed: navigation, not a band ──
    // The legacy behaviour returned the structural graph lane as hits (W1a) or
    // nothing at all (pre-W1a). Now the miss answer is the routing map; the
    // chunk tier (which DID match the query) stays in the ranked list.
    // `graph: false` / maxDepth 0 keeps the pure-FTS debug path (chunk hits
    // only, no navigation) for eval determinism.
    if (rows.length === 0) {
      if (!graphEnabled || maxDepth === 0) {
        return { results: applyTokenBudget(chunkHits, topK, maxBytes) };
      }
      const navigation = this.navigationOnTextMiss();
      log.info(
        `text miss → chunk lane ${chunkHits.length} hit(s), navigation ` +
          `${navigation ? navigation.startPoints.length : 0} start point(s)`,
      );
      return {
        results: enrichWithGraphContext(this.store, applyTokenBudget(chunkHits, topK, maxBytes)),
        ...(navigation ? { navigation } : {}),
      };
    }

    const normalized = normalizeBm25(rows);

    // ── memory203 doc26 Wave 4 — post-BM25 temporal / supersede re-scoring ──
    // Mirror the cloud R4 ranker terms the LOCAL store can support, layered as
    // SMALL adjustments on top of the 0-1 BM25 relevance (BM25 still dominates
    // lexical order; these only reorder near-ties and sink demoted pages):
    //   • recency decay  — +recencyDecay(updatedAt)·RECENCY_WEIGHT (fresh↑, old→0)
    //   • stale penalty  — STALE_PENALTY when stale=1 (cloud −0.5). NOTE: the FTS
    //     SQL above hard-filters `p.stale = 0` (a deliberate invariant shared with
    //     linkNeighbors — stale pages are suppressed from local recall), so every
    //     candidate here is non-stale and this term is INERT today. It is kept for
    //     cloud parity + so it goes live automatically if a `stale='all'` recall
    //     option is ever added (matching the cloud, which only demotes — rather
    //     than hard-excludes — stale pages when `stale='all'` is requested).
    //   • supersede/contradicts demotion — SUPERSEDED_DEMOTION for a page on the
    //     older/superseded/contradicted side of a supersede-or-contradicts link
    //     (cloud −0.8); a small SUPERSEDING_PROMOTION for the replacing side. This
    //     term is LIVE: the local `memory_links` table carries those relations.
    //
    // DEFERRED (R4.1 validity window): the cloud also penalises an EXPIRED fact
    // (`validUntil < now` → −0.6) and a not-yet-effective one (`validFrom > now`
    // → −0.3). The daemon `memory_pages` subset carries NEITHER `validFrom` NOR
    // `validUntil` (the cloud mig491/493 columns are not in the local schema), so
    // this term CANNOT be computed locally yet and is intentionally NOT added in
    // this pass. Enabling it requires a local-store schema addition + a
    // cloud→daemon down-sync of the two columns first (a separate migration).
    const now = Date.now();
    const { demoted, superseding } = this.store.supersedeSides(rows.map((r) => r.path));
    const ftsHits = normalized
      // normalizeBm25 preserves row order 1:1, so index-zip back to the source
      // row for its stale flag + updatedAt.
      .map((r, i) => ({ r, row: rows[i]! }))
      // Threshold stays a floor on the BM25 RELEVANCE (semantics unchanged): the
      // temporal terms adjust RANK, they don't gate presence — a lexically-matched
      // page is demoted, never dropped, by a penalty.
      .filter(({ r }) => r.score >= threshold)
      .map(({ r, row }) => {
        const recency = recencyDecay(row.updatedAt, now) * RECENCY_WEIGHT;
        const stalePenalty = row.stale ? STALE_PENALTY : 0;
        const supersede = supersedeContradictsTerm(row.path, demoted, superseding);
        return { ...r, score: r.score + recency + stalePenalty + supersede, via: 'fts' as const };
      })
      // Re-sort: a penalty/boost can move a page past a near-tie neighbor. The
      // graph band below is computed from these (adjusted) FTS scores, so graph
      // hits stay strictly below the weakest FTS hit regardless of adjustment.
      .sort((a, b) => b.score - a.score);

    // Composite recall: supplement FTS hits with link-graph neighbors at a
    // strictly lower score band (memory202/07 §4 — local recall is lexical +
    // graph). Additive: never reorders/drops FTS hits. Disabled when
    // options.graph === false (FTS-only debug path) or no FTS seeds.
    if (graphEnabled && maxDepth > 0 && ftsHits.length > 0) {
      const graphHits = this.expandViaGraph(ftsHits, topK, maxDepth, fanOut);
      const combined = mergeChunkHits(ftsHits, graphHits, chunkHits);
      return { results: enrichWithGraphContext(this.store, applyTokenBudget(combined, topK, maxBytes)) };
    }

    return {
      results: enrichWithGraphContext(
        this.store,
        applyTokenBudget(mergeChunkHits(ftsHits, [], chunkHits), topK, maxBytes),
      ),
    };
  }

  /**
   * memory211/01 W3 轴D — T3 chunk recall over the local `asset_chunks_fts`
   * mirror. A hit addresses an ASSET, not a page: `path` is the provenance token
   * `asset:<id>#<hash>` (the same form G9/轴F derived-from pointers carry),
   * `title` is the upload filename, and `assetId`/`chunkOrdinal` carry the jump
   * coordinates. Scored with the SAME query bigrams the wiki FTS uses
   * (`buildFtsMatchQuery`), then discounted by RAW_TRUST_DISCOUNT.
   *
   * Local-only by design (F2 裁决): the mirror is populated at materialize time,
   * so an OFFLINE daemon still recalls the upload — this method never touches the
   * cloud.
   */
  private searchAssetChunks(query: string, topK: number): MemorySearchResult[] {
    let db: ReturnType<MemoryStore['rawDb']>;
    try {
      db = this.store.rawDb();
    } catch {
      return [];
    }
    let rows: Array<{ assetId: string; ordinal: number; path: string; title: string; content: string; sid: string | null; bm25Score: number }>;
    // memory211/01 W4 轴F — the chunk TABLE carries the span sid (the FTS shadow
    // table does not): LEFT JOIN it in so a minted span can be surfaced as T2
    // asset tier. sid NULL = never cited = T3 raw.
    // NOTE: an FTS5 table cannot be aliased (`f.asset_chunks_fts.x` is a
    // syntax error in SQLite), so the shadow table stays under its own name and
    // the chunk table takes the alias.
    const sql = `
      SELECT asset_chunks_fts.assetId AS assetId, asset_chunks_fts.ordinal AS ordinal,
             asset_chunks_fts.path AS path, asset_chunks_fts.title AS title,
             asset_chunks_fts.content AS content, c.sid AS sid,
             bm25(asset_chunks_fts) AS bm25Score
      FROM asset_chunks_fts
      LEFT JOIN asset_chunks c
        ON c.workspaceId = asset_chunks_fts.workspaceId
       AND c.assetId = asset_chunks_fts.assetId
       AND c.ordinal = asset_chunks_fts.ordinal
      WHERE asset_chunks_fts.workspaceId = ? AND asset_chunks_fts MATCH ?
      ORDER BY bm25Score, ordinal LIMIT ?`;
    const runs = [buildFtsMatchQuery(query, 'AND')];
    runs.push(buildFtsMatchQuery(query, 'OR'));
    const collected = new Map<
      string,
      { assetId: string; ordinal: number; path: string; title: string; content: string; sid: string | null; bm25Score: number }
    >();
    for (const match of runs) {
      if (!match) continue;
      try {
        const out = db
          .prepare(sql)
          .all(this.store.workspaceId(), match, Math.max(topK * 3, 12)) as Array<{
          assetId: string;
          ordinal: number;
          path: string;
          title: string;
          content: string;
          sid: string | null;
          bm25Score: number;
        }>;
        for (const r of out) {
          // Dedupe by CHUNK identity, not by path: every chunk of one asset
          // shares the same `asset:<id>#<hash>` path, so a path key collapsed a
          // whole upload's chunk set to whichever single chunk the (arbitrary,
          // equal-bm25) SQL ordering happened to surface first — one hit no
          // matter how many chunks matched, and mint-即升层 invisible whenever
          // the cited chunk lost that coin flip.
          const key = `${r.assetId}#${r.ordinal}`;
          if (!collected.has(key)) collected.set(key, r);
        }
      } catch (err) {
        log.warn(`asset_chunks_fts MATCH rejected (${(err as Error).message})`);
      }
      if (collected.size > 0) break; // AND pass won — don't dilute with the OR pass
    }
    rows = [...collected.values()];
    if (rows.length === 0) return [];

    // BM25 across the chunk corpus only; normalize to 0-1 like the wiki leg.
    const scores = rows.map((r) => r.bm25Score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const span = max - min;
    return rows
      .map((r) => {
        // memory211/01 W4 轴F — mint 即升层: a cited chunk carries its minted
        // span sid and leaves the T3 band (T2 asset = no trust discount). The
        // sid column IS the tier switch, mirroring the cloud resolver.
        const tier: MemorySearchResult['tier'] = r.sid ? 'asset' : 'raw';
        const lexical = span === 0 ? 1 : 1 - (r.bm25Score - min) / span;
        const score = lexical - (tier === 'raw' ? RAW_TRUST_DISCOUNT : 0);
        return {
          pageId: r.assetId,
          path: r.path,
          title: r.title || null,
          snippet: r.content.slice(0, 240),
          score,
          tokenCount: estimateTokens(r.content),
          via: 'fts' as const,
          tier,
          // P3 — same decomposition the wiki leg carries (lexical evidence,
          // pre-discount); `mergeChunkHits` compares chunk-vs-wiki on it.
          components: { matchScore: lexical },
          ...(r.sid ? { spanSid: r.sid } : {}),
          assetId: r.assetId,
          chunkOrdinal: r.ordinal,
          ...(r.content ? { sectionBody: r.content } : {}),
        } as MemorySearchResult;
      })
      .slice(0, topK);
  }

  /**
   * Multi-hop link-graph expansion (memory202/05 §4.2 + §4.3).
   *
   * Seeds are the top-K FTS hits (this lane runs only when the text leg HAS
   * hits — a miss produces `navigation` instead, §6.9 裁决 1). From each
   * frontier we pull 1-hop neighbors via store.linkNeighbors(), keep only
   * neighbors not already seen (visited-set = cycle protection: A→B→A
   * terminates), fan out to the top-`fanOut` by edge weight, then recurse to
   * the next depth.
   *
   * Banding: every hit sits one full band below the weakest FTS hit and decays
   * monotonically per hop, so a deeper page can never tie a shallower one and
   * no graph hit ever outranks a direct FTS match (mirrors the cloud
   * expandViaGraph sink band).
   *
   * Bucket-local: linkNeighbors is scoped to this store's workspaceId, and this
   * store IS the agent/shared bucket the caller resolved, so neighbors share the
   * same ACL scope as the seeds (no cross-bucket / cross-agent leakage).
   */
  private expandViaGraph(
    seeds: MemorySearchResult[],
    topK: number,
    maxDepth: number,
    fanOut: number,
  ): MemorySearchResult[] {
    // Strictly below the weakest FTS hit so graph hits never outrank a match.
    const minFtsScore = seeds.reduce((m, s) => Math.min(m, s.score), Infinity);
    const baseBand = (Number.isFinite(minFtsScore) ? minFtsScore : 0) - GRAPH_HOP_BAND;

    // Visited = every page already surfaced (FTS seeds + earlier graph hops).
    // Seeds are excluded from results AND from re-expansion (cycle guard).
    const visited = new Set<string>(seeds.map((s) => s.path));
    const out: MemorySearchResult[] = [];

    // Anchor expansion on the top-K strongest FTS hits.
    let frontier = seeds.slice(0, topK).map((s) => s.path);
    const seenInResults = new Set<string>();

    for (let depth = 1; depth <= maxDepth; depth += 1) {
      if (frontier.length === 0) break;

      // 1-hop neighbors of the whole frontier, then drop anything already
      // visited (this is the ring guard: a back-edge to a visited page is
      // silently dropped instead of looping).
      const neighbors = this.store
        .linkNeighbors(frontier)
        .filter((n) => !visited.has(n.path));
      if (neighbors.length === 0) break;

      // Fan-out: keep only the top-`fanOut` by edge weight (then recency as a
      // stable tiebreak) so a hub page can't explode the frontier.
      const ranked = dedupeByPathBestWeight(neighbors)
        .sort((a, b) => b.weight - a.weight || b.updatedAt - a.updatedAt)
        .slice(0, fanOut);

      // Monotone per-hop band: hop 1 at baseBand, each deeper hop lower still.
      const hopBand = baseBand - (depth - 1) * GRAPH_HOP_DECAY;

      const nextFrontier: string[] = [];
      for (let i = 0; i < ranked.length; i += 1) {
        const n = ranked[i];
        if (!n) continue;
        visited.add(n.path);
        nextFrontier.push(n.path);
        if (seenInResults.has(n.path)) continue;
        seenInResults.add(n.path);
        const snippet = snippetFromNeighbor(n);
        // P1b: when the reaching link addressed this neighbor at a `#section`,
        // slice that sub-section out of the neighbor's content so the recall
        // injector injects only that node (sectionBody) instead of the snippet.
        // Slug miss (rename) or no content → null → whole-page fallback
        // (section/sectionBody stay unset; byte-for-byte original behaviour).
        let section: string | undefined;
        let sectionBody: string | undefined;
        if (n.section && n.content) {
          const sliced = sliceSection(n.content, n.section);
          if (sliced !== null) {
            section = n.section;
            sectionBody = sliced;
          }
        }
        out.push({
          pageId: n.pageId,
          path: n.path,
          title: n.title,
          // Tiny per-position offset keeps a deterministic order within a hop
          // without crossing into the next hop's band.
          score: hopBand - i * 1e-6,
          snippet,
          tokenCount: estimateTokens(snippet),
          via: 'graph',
          ...(section ? { section, sectionBody } : {}),
        });
      }

      // Cap total graph hits at topK (the token budgeter trims further).
      if (out.length >= topK) break;
      frontier = nextFrontier;
    }

    return out.slice(0, topK);
  }

  /**
   * memory211/01 §6.9 裁决 1 — the miss-path navigation payload (daemon side).
   *
   * Replaces the W1a miss lane (expandOnTextMiss + its hub-context banding): instead
   * of scoring INDEX/hubs and their 1-hop neighbours into a rank band, the
   * structural entries are returned AS start points, children-first, with the
   * walking instructions. The agent — not a fabricated ranker — does the
   * walking from there (browse children → batch read → follow links).
   *
   * No structural entries (no INDEX, no hubs) → `undefined` — an empty
   * workspace stays empty, and a navigation payload with zero start points
   * would be noise.
   */
  private navigationOnTextMiss(): MemoryNavigation | undefined {
    const seedPages = this.structuralSeeds();
    if (seedPages.length === 0) return undefined;

    let contexts: Map<string, MemoryPageGraphContext> | null = null;
    try {
      contexts = this.store.pageGraphContext(seedPages.map((p) => p.id));
    } catch (err) {
      // Navigation is additive: a closed replica / store hiccup must not turn a
      // completed (if empty) recall into a throw. Without context the start
      // points still carry their identity, just no fan-out count.
      log.warn(`miss navigation degraded (graph context unavailable): ${(err as Error).message}`);
    }

    const startPoints: MemoryNavigationStartPoint[] = seedPages
      .map((p) => {
        const ctx = contexts?.get(p.id);
        return {
          path: p.path,
          title: p.title,
          pageType: (ctx?.pageType === 'index' ? 'index' : 'hub') as 'index' | 'hub',
          childrenCount: ctx?.childrenCount ?? 0,
          why: 'structural-entry' as const,
        };
      })
      // 有子上优先 (§6.9 裁决 1): a hub that fans out routes better than one that
      // doesn't; path order keeps the tie deterministic.
      .sort((a, b) => b.childrenCount - a.childrenCount || a.path.localeCompare(b.path));

    return { reason: 'text-miss', startPoints, guidance: MISS_NAVIGATION_GUIDANCE };
  }

  /** INDEX + hubs, the structural entry points offered on a text miss. */
  private structuralSeeds(): Array<{ id: string; path: string; title: string | null }> {
    const seeds: Array<{ id: string; path: string; title: string | null }> = [];
    const index = this.store.loadIndexPage();
    if (index) seeds.push({ id: index.id, path: index.path, title: index.title });
    for (const hub of this.store.list({ pageType: 'hub', limit: MISS_SEED_HUB_LIMIT })) {
      if (seeds.some((s) => s.path === hub.path)) continue;
      seeds.push({ id: hub.id, path: hub.path, title: hub.title });
    }
    return seeds;
  }
}

/**
 * Cross-tier comparison key (P3) — mirrors the cloud `lexicalEvidence`
 * (memory-search.service.ts). A wiki page is compared on its LEXICAL component
 * only: `recency` (+0.2) / supersede (−0.8) are workspace priors folded into the
 * composite `score`, not evidence that THIS query's terms live in that page.
 * Graph hits carry no lexical evidence at all, so they always sit below a chunk
 * that matched. Objects built outside the search layer may lack the
 * decomposition; `score` is the conservative fallback there (those callers never
 * feed a temporal-adjusted hit into this merge).
 */
function lexicalEvidence(hit: MemorySearchResult): number {
  if (hit.via === 'graph') return -Infinity;
  return hit.components?.matchScore ?? hit.score;
}

/**
 * memory211/01 W3 轴D — merge the T3 chunk hits into the wiki result list.
 * Wiki order (FTS + graph bands) is untouched; each chunk hit is inserted ahead
 * of the first wiki hit whose LEXICAL evidence (`components.matchScore`, P3) is
 * weaker, so workspace priors (recency ±0.2 / supersede −0.8) never bury the
 * upload that actually carries the query term. This IS the same comparison the
 * cloud `mergeRawTier` makes (its `lexicalEvidence(existing) < hit.score`
 * insertion test) — two implementations of one ruling, kept mirroring on purpose.
 * Exported so the merge CONTRACT (lexical basis, not composite) is pinned
 * directly; `hybrid()` is the only production caller.
 */
export function mergeChunkHits(
  ftsHits: MemorySearchResult[],
  graphHits: MemorySearchResult[],
  chunkHits: MemorySearchResult[],
): MemorySearchResult[] {
  if (chunkHits.length === 0) return [...ftsHits, ...graphHits];
  const merged = [...ftsHits, ...graphHits];
  for (const hit of chunkHits) {
    // The chunk's discounted BM25 band is its evidence level. A wiki hit whose
    // OWN normalized BM25 relevance is weaker slots below it — even when the
    // wiki page is fresher and its composite score is higher (the D9 shape).
    let at = merged.length;
    for (let i = 0; i < merged.length; i += 1) {
      const existing = merged[i]!;
      const evidence = existing.tier === 'raw' || existing.tier === 'asset' ? existing.score : lexicalEvidence(existing);
      if (evidence < hit.score) {
        at = i;
        break;
      }
    }
    merged.splice(at, 0, hit);
  }
  return merged;
}


/**
 * memory211/01 §3 轴C W1a — attach the hop-decision payload
 * ({pagePath, hubPath, version, tier, inboundLinkCount, childrenCount,
 * outboundPreview, sectionAnchor, sectionPreview}) to whatever hits are actually
 * returned. Existing fields are NEVER touched (backward compat), and the pass
 * is strictly additive: any store failure returns the hits unmodified rather
 * than failing a recall that already succeeded.
 *
 * Runs AFTER the token budgeter so the extra reads are bounded by what the
 * caller will actually see (topK, not the whole candidate set).
 */
function enrichWithGraphContext(
  store: MemoryStore,
  hits: MemorySearchResult[],
): MemorySearchResult[] {
  if (hits.length === 0) return hits;
  let contexts: Map<string, MemoryPageGraphContext> | null = null;
  try {
    contexts = store.pageGraphContext(hits.map((h) => h.pageId));
  } catch (err) {
    log.warn(`hop-decision payload skipped (graph context unavailable): ${(err as Error).message}`);
    return hits;
  }
  return hits.map((h) => {
    const ctx = contexts?.get(h.pageId);
    if (!ctx) return h;
    const isIndex = ctx.pageType === 'index';
    return {
      ...h,
      pagePath: h.path,
      version: ctx.version,
      tier: 'wiki' as const,
      // A root / INDEX page hangs under nothing → explicit null (the agent's
      // "this is top-level" signal), never a dangling path.
      hubPath: isIndex ? null : ctx.hubPath,
      inboundLinkCount: ctx.inboundLinkCount,
      childrenCount: ctx.childrenCount,
      outboundPreview: ctx.outboundPreview,
      ...(h.section ? { sectionAnchor: h.section } : {}),
      ...(h.sectionBody ? { sectionPreview: h.sectionBody.slice(0, SECTION_PREVIEW_CHARS) } : {}),
    };
  });
}

/**
 * Collapse duplicate neighbor paths (a page can be reached by multiple edges in
 * one hop) keeping the strongest edge weight + freshest row.
 */
function dedupeByPathBestWeight(neighbors: MemoryLinkNeighbor[]): MemoryLinkNeighbor[] {
  const byPath = new Map<string, MemoryLinkNeighbor>();
  for (const n of neighbors) {
    const prev = byPath.get(n.path);
    if (!prev || n.weight > prev.weight) byPath.set(n.path, n);
  }
  return [...byPath.values()];
}

/**
 * Build a snippet for a graph-recalled neighbor. We don't have an FTS-matched
 * span (the keyword didn't hit), so fall back to title/description/path — same
 * spirit as the cloud graph path sourcing its snippet from page metadata.
 */
function snippetFromNeighbor(n: MemoryLinkNeighbor): string {
  const desc = n.description?.trim();
  if (desc) return desc.slice(0, 240);
  const title = n.title?.trim();
  if (title) return title.slice(0, 240);
  return n.path;
}

/**
 * Tokenize user input into safe FTS5 terms: split on whitespace, strip FTS5
 * operator chars, drop empties. Each surviving term is later quoted so SQLite
 * treats it as a literal phrase (no operator injection). Returned unquoted so
 * the caller can join them with AND (implicit) or OR.
 */
function tokenizeFtsTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/["()]/g, ''))
    .filter((t) => t.length > 0);
}

/**
 * memory211/01 W2 #7 — the query side of the CJK bigram contract: each CJK run
 * of ≥2 chars becomes its adjacent 2-grams, a 1-char run stays a 1-gram. Mirrors
 * the index side (`cjkBigramText` in store.ts) exactly — a gram the index does
 * not hold could never match.
 */
function cjkGramsOf(text: string): string[] {
  const out: string[] = [];
  for (const run of cjkRuns(text)) {
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

/**
 * memory211/01 W2 #7 — build the FTS5 MATCH expression for a query.
 *
 * ASCII terms keep the legacy semantics (AND pass = implicit space join, every
 * term must match; OR pass = any term). CJK does NOT fit that shape: unicode61
 * indexes a whole CJK run as one token, so a Chinese term could only ever match
 * an identical run — a 2-char query inside a longer run ("金门" in "金门标准")
 * was structurally unreachable. The store now indexes a CJK bigram projection
 * (`store.cjkBigramText`, memory_fts.cjk), and the query side offers the query's
 * own bigrams as alternatives, grouped per input term:
 *
 *   AND pass:  记忆体方案 golden gate  →  ("记忆" OR "忆体" OR "体方" OR "方案") "golden" "gate"
 *   OR pass:   记忆体方案 golden gate  →  "记忆" OR "忆体" OR … OR "golden" OR "gate"
 *
 * A 1-char CJK run stays a 1-gram (nothing to pair it with, and a single char is
 * still a real token inside the indexed columns).
 */
export function buildFtsMatchQuery(query: string, mode: 'AND' | 'OR'): string {
  const groups: string[][] = [];
  for (const term of tokenizeFtsTerms(query)) {
    const alternatives = cjkGramsOf(term).map((g) => `"${g}"`);
    if (alternatives.length === 0) {
      groups.push([`"${term}"`]);
      continue;
    }
    // Mixed term (e.g. "G7金门"): the ASCII fragment keeps its own quoted term
    // alongside the CJK bigram alternatives.
    const asciiRest = term.replace(/[㐀-鿿豈-﫿぀-゠ヿ-鿿가-힯]+/g, ' ').trim();
    if (asciiRest.length > 0) alternatives.push(`"${asciiRest}"`);
    groups.push(alternatives);
  }
  if (mode === 'OR') return groups.flat().join(' OR ');
  // NOTE: FTS5 has no implicit AND in front of a parenthesized group —
  // `"a" ("b" OR "c")` is a syntax error while `"a" AND ("b" OR "c")` parses —
  // so the AND pass spells the operator out between groups.
  return groups.map((g) => (g.length > 1 ? `(${g.join(' OR ')})` : g[0]!)).join(' AND ');
}

/**
 * SQLite bm25() returns negative scores (more negative = better match).
 * Normalize to a 0-1 relevance score where 1 = best in this result set.
 * Single-row results get score=1 by convention.
 */
function normalizeBm25(rows: FtsRow[]): MemorySearchResult[] {
  if (rows.length === 0) return [];
  const scores = rows.map((r) => r.bm25Score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const span = max - min;
  return rows.map((r) => {
    const score = span === 0 ? 1 : 1 - (r.bm25Score - min) / span;
    return {
      pageId: r.pageId,
      path: r.path,
      title: r.title,
      snippet: r.snippet,
      score,
      tokenCount: estimateTokens(r.snippet),
      // P3 — the lexical component survives the temporal re-scoring pass below,
      // which is what lets the cross-tier merge compare BM25 against BM25.
      components: { matchScore: score },
    };
  });
}

/**
 * Greedy fill: take results in order until either topK is reached or the
 * accumulated snippet bytes would exceed maxBytes. Always returns at least
 * one result if the input is non-empty (smallest snippet wins if all exceed
 * the budget on first try).
 */
function applyTokenBudget(
  results: MemorySearchResult[],
  topK: number,
  maxBytes: number,
): MemorySearchResult[] {
  const out: MemorySearchResult[] = [];
  let acc = 0;
  for (const r of results) {
    const bytes = Buffer.byteLength(r.snippet, 'utf8');
    if (out.length === 0 && bytes > maxBytes) {
      // Single result exceeds the budget; honor it anyway so the caller gets
      // SOME response. Truncation policy is the caller's responsibility.
      out.push(r);
      break;
    }
    if (acc + bytes > maxBytes) break;
    acc += bytes;
    out.push(r);
    if (out.length >= topK) break;
  }
  return out;
}

/** Rough English heuristic: ~4 chars per token. Good enough for budgeter. */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * memory203 doc26 W4 — exponential recency decay in [0,1]: 1 for a just-updated
 * page, halving every RECENCY_HALF_LIFE_MS. `updatedAtMs` is epoch ms
 * (memory_pages.updatedAt). Mirrors the cloud `recencyDecay` shape.
 */
function recencyDecay(updatedAtMs: number, now: number): number {
  const ageMs = Math.max(0, now - updatedAtMs);
  return Math.exp((-ageMs * Math.LN2) / RECENCY_HALF_LIFE_MS);
}

/**
 * memory203 doc26 W4 — supersede/contradicts ranking term (cloud R4.2 parity). A
 * page on the OLDER/superseded/contradicted side of a supersede-or-contradicts
 * edge is demoted BEYOND the stale penalty (−0.8 vs −0.5) so its replacement
 * reliably outranks it; the replacing/newer side gets a slight promotion. The
 * demotion wins if a page is somehow on both sides. Touched by neither ⇒ 0.
 */
function supersedeContradictsTerm(
  path: string,
  demoted: Set<string>,
  superseding: Set<string>,
): number {
  if (demoted.has(path)) return SUPERSEDED_DEMOTION;
  if (superseding.has(path)) return SUPERSEDING_PROMOTION;
  return 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

// Re-export so external callers don't have to import from types.ts separately.
export type { MemoryPageType, MemorySearchOptions, MemorySearchResult };
