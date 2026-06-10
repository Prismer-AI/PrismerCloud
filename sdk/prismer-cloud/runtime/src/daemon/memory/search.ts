// Hybrid search over the daemon memory store.
//
// Phase-0 strategy:
//   1. FTS5 BM25 over (title, path, description, content) — single corpus
//      ranked by SQLite's built-in BM25 implementation. SQLite returns
//      negative BM25 scores (lower = better); we normalize to a 0-1
//      relevance score for the result struct.
//   2. Token budgeter caps aggregate snippet bytes under maxBytes so a
//      caller (e.g. recall hook in phase-1) can pre-bound prompt cost.
//
// Phase-1 extension points (deliberately out of scope here):
//   - Link-graph expansion: walk memory_links to add neighbor pages whose
//     score < threshold but are 1-hop from a high-scoring hit. Owner
//     decides expansion depth + weight decay.
//   - Multi-corpus blending (BM25 over wiki + vector recall over raw chats)
//     — out of scope until embeddings ship (post-MVP).
//   - Active-memory sub-agent gating (doc 23 §10) — sits above this layer.

import type { MemoryStore } from './store.js';
import type {
  MemorySearchOptions,
  MemorySearchResult,
  MemoryPageType,
} from './types.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('MemorySearch');

const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_BYTES = 8 * 1024;
const DEFAULT_THRESHOLD = 0;

interface FtsRow {
  pageId: string;
  path: string;
  title: string | null;
  snippet: string;
  bm25Score: number;
}

export class MemorySearch {
  constructor(private readonly store: MemoryStore) {}

  hybrid(query: string, options?: MemorySearchOptions): MemorySearchResult[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const topK = clamp(options?.topK ?? DEFAULT_TOP_K, 1, 50);
    const maxBytes = Math.max(options?.maxBytes ?? DEFAULT_MAX_BYTES, 256);
    const threshold = options?.relevanceThreshold ?? DEFAULT_THRESHOLD;
    const pageTypes = options?.pageType ?? null;

    const ftsQuery = buildFtsQuery(trimmed);
    if (ftsQuery.length === 0) return [];

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

    const params: unknown[] = [
      this.store.workspaceId(),
      ftsQuery,
      ...(pageTypes ?? []),
      topK * 2,
    ];

    let rows: FtsRow[];
    try {
      rows = db.prepare(sql).all(...params) as FtsRow[];
    } catch (err) {
      // FTS5 throws on syntactically invalid MATCH expressions. We sanitize
      // input via buildFtsQuery() so this is unexpected — surface as empty
      // results rather than propagating to the caller. Log line tags the
      // query for observability.
      log.warn(
        `FTS5 MATCH rejected query=${JSON.stringify(ftsQuery)}: ${(err as Error).message}`,
      );
      return [];
    }

    if (rows.length === 0) return [];

    const normalized = normalizeBm25(rows);
    const filtered = normalized.filter((r) => r.score >= threshold);
    return applyTokenBudget(filtered, topK, maxBytes);
  }
}

/** Translate user input into a safe FTS5 MATCH expression. */
function buildFtsQuery(query: string): string {
  // Tokenize on whitespace + strip FTS5 operator chars; quote each surviving
  // term so SQLite treats it as a literal phrase. Implicit AND between terms.
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/["()]/g, ''))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' ');
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

// Re-export so external callers don't have to import from types.ts separately.
export type { MemoryPageType, MemorySearchOptions, MemorySearchResult };
