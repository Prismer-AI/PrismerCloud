// Stage-1 manifest builder — M-B (doc 25 §3 支柱 2).
//
// Stage-1 is "zero-LLM page enumeration": scan SQLite for the workspace's
// pages, project to (path, title, description, mtime, pageType), and
// rank. Two ranking modes:
//
//   1. Free-text query — use FTS5 BM25 to surface candidates that
//      mention any of the query terms. Falls back to mode 2 when the
//      query is empty / whitespace.
//   2. No query — order by `updatedAt DESC` so the freshest pages float
//      first. Used by the host's idle-recall hint flow when there's no
//      explicit user question.
//
// Both modes cap at MAX_MANIFEST_ENTRIES (200, mirrors CC's selector
// budget). Entries beyond the cap are dropped, with `truncated: true`
// signaled in the response so the host can decide whether to re-query
// with a narrower scope.

import type { MemoryRuntime } from '../runtime.js';
import { MAX_MANIFEST_ENTRIES } from './select-memories.js';
import { createLogger } from '../../../lib/logger.js';

const log = createLogger('memory.fork.manifest');
import type { ManifestEntry, ManifestResponse } from './types.js';

interface PageRow {
  pageId: string;
  path: string;
  title: string | null;
  pageType: string;
  description: string | null;
  updatedAt: number;
}

interface FtsRow {
  pageId: string;
  path: string;
  title: string | null;
  pageType: string;
  description: string | null;
  updatedAt: number;
  bm25Score: number;
}

export interface ManifestOptions {
  /** Override the default cap (200). Clamped to [1, 500]. */
  limit?: number;
  /**
   * Optional filter on page type. When supplied, only the named types
   * are returned (e.g. ['decision', 'glossary']).
   */
  pageType?: ReadonlyArray<string>;
}

/**
 * Build a Stage-1 manifest for a workspace. Pure SQLite — no LLM.
 *
 * The order matters: the selector's "be selective" instruction works
 * best when the most-likely-relevant entries are at the top of the
 * list. FTS-ordered when the query is non-empty; updatedAt-ordered
 * otherwise.
 */
export function buildManifest(
  runtime: MemoryRuntime,
  workspaceId: string,
  query: string,
  options?: ManifestOptions,
): ManifestResponse {
  const slot = runtime.peek(workspaceId);
  if (!slot) {
    return { workspaceId, query, entries: [], truncated: false };
  }

  const limit = clamp(options?.limit ?? MAX_MANIFEST_ENTRIES, 1, 500);
  const pageTypes = options?.pageType?.length ? Array.from(new Set(options.pageType)) : null;
  const trimmedQuery = query.trim();

  const db = slot.store.rawDb();

  let entries: ManifestEntry[] = [];
  let totalAvailable = 0;

  if (trimmedQuery.length > 0) {
    const ftsTerms = buildFtsTerms(trimmedQuery);
    if (ftsTerms.length > 0) {
      const params: unknown[] = [workspaceId, ftsTerms];
      let sql = `
        SELECT
          f.pageId       AS pageId,
          p.path         AS path,
          p.title        AS title,
          p.pageType     AS pageType,
          p.description  AS description,
          p.updatedAt  AS updatedAt,
          bm25(memory_fts) AS bm25Score
        FROM memory_fts f
        JOIN memory_pages p ON p.id = f.pageId
        WHERE f.workspaceId = ?
          AND memory_fts MATCH ?
          AND p.stale = 0
          AND p.archivedAt IS NULL
      `;
      if (pageTypes) {
        sql += ` AND p.pageType IN (${pageTypes.map(() => '?').join(',')})`;
        params.push(...pageTypes);
      }
      sql += ` ORDER BY bm25Score LIMIT ?`;
      params.push(limit + 1);

      let rows: FtsRow[] = [];
      try {
        rows = db.prepare(sql).all(...params) as FtsRow[];
      } catch (err) {
        // Bad FTS expression. Caller's input was sanitized in
        // buildFtsTerms; if SQLite still rejects, surface as no results
        // instead of crashing the recall flow.
        log.warn(
          `FTS rejected query=${JSON.stringify(ftsTerms)}: ${(err as Error).message}`,
        );
      }
      totalAvailable = rows.length;
      entries = rows.slice(0, limit).map(rowToEntry);
    }
  }

  // Either no query, or FTS returned nothing — fall back to recently-updated.
  if (entries.length === 0) {
    const params: unknown[] = [workspaceId];
    let sql = `
      SELECT id AS pageId, path, title, pageType, description, updatedAt
      FROM memory_pages
      WHERE workspaceId = ?
        AND stale = 0
        AND archivedAt IS NULL
    `;
    if (pageTypes) {
      sql += ` AND pageType IN (${pageTypes.map(() => '?').join(',')})`;
      params.push(...pageTypes);
    }
    sql += ` ORDER BY updatedAt DESC LIMIT ?`;
    params.push(limit + 1);
    const rows = db.prepare(sql).all(...params) as PageRow[];
    totalAvailable = rows.length;
    entries = rows.slice(0, limit).map(rowToEntry);
  }

  return {
    workspaceId,
    query: trimmedQuery,
    entries,
    truncated: totalAvailable > limit,
  };
}

function rowToEntry(row: PageRow | FtsRow): ManifestEntry {
  return {
    path: row.path,
    title: row.title,
    pageType: row.pageType,
    description: row.description,
    // SQLite stores `updatedAt` as INTEGER epoch millis (see store.ts
    // schema). The fork SPI exposes that as `mtimeMs` because the field
    // crosses the daemon→host boundary and the host (Hermes / CC /
    // OpenClaw / Codex) consumes it as a Unix epoch millisecond integer.
    mtimeMs: row.updatedAt,
  };
}

function buildFtsTerms(query: string): string {
  // Same sanitizer pattern as `search.ts:buildFtsQuery`. Keep them in
  // lockstep — both fields are produced by the same SQLite FTS5 module.
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/["()]/g, ''))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' ');
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
