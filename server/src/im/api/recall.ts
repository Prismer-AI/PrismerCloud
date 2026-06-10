/**
 * Prismer IM — Recall API
 *
 * Unified search across all knowledge layers:
 *   - Memory (episodic memory files)
 *   - Cache (context cache entries)
 *   - Evolution (evolution capsules / gene execution history)
 *
 * GET /recall?q=timeout&scope=all&limit=10
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import prisma from '../db';
import type { MemoryService } from '../services/memory.service';
import type { KnowledgeLinkService } from '../services/knowledge-link.service';
import type { EventBusService } from '../services/event-bus.service';
import type { ApiResponse } from '../types/index';
import { recallMemory, type RecallStrategy } from '../services/memory-recall';
import {
  WorkspaceResolutionError,
  memoryWorkspaceErrorResponse,
  resolveMemoryWorkspaceIdForRequest,
} from './workspace-resolver';
// Release 201 P0-6 — IMMemoryPage recall paths bypassed visibility ACL
// (queried by workspaceId only). Wire MemoryAclContext so the page query
// filters on allowed visibilities + prefixes, matching the predicate the
// /memory page-read endpoints already enforce. Without this, a delegated
// agent caller could recall any visibility class (e.g. another agent's
// agent:<id> private memory page) by issuing a /recall request.
import { loadWorkspaceForMemoryAccess, type MemoryAclContext } from '../services/memory-acl';

interface RecallResult {
  source: 'memory' | 'cache' | 'evolution';
  title: string;
  path?: string;
  snippet: string;
  score: number;
  id?: string;
  gene_id?: string;
  updatedAt?: Date;
  memoryType?: string;
  linkedGenes?: Array<{ geneId: string; title: string; successRate: number; linkType: string; strength: number }>;
}

/**
 * Three-dimensional relevance scoring:
 *   score = recency(0.3) × relevance(0.5) × importance(0.2)
 */
function computeScore(
  query: string,
  title: string,
  snippet: string,
  updatedAt?: Date | null,
  importanceHint: number = 0.5,
  isStale: boolean = false,
  /**
   * Precomputed relevance from upstream (e.g. `memoryService.searchMemoryFiles` which runs
   * FULLTEXT boolean-mode + word-coverage). When provided, skips this function's substring
   * heuristics entirely — upstream ranking wins.
   */
  overrideRelevance?: number,
): number {
  const q = query.toLowerCase().trim();
  const t = title.toLowerCase();
  const s = snippet.toLowerCase();

  let relevance: number;
  if (overrideRelevance !== undefined) {
    relevance = overrideRelevance;
  } else if (t === q) {
    relevance = 1.0;
  } else if (t.includes(q)) {
    relevance = 0.9;
  } else if (s.startsWith(q)) {
    relevance = 0.8;
  } else if (s.includes(q)) {
    relevance = 0.6;
  } else {
    // Multi-word fallback: count per-word coverage across title and snippet.
    // Real agent recall queries are 3-5 keywords (per MCP schema contract); the whole
    // phrase is rarely a literal substring. Before this branch every multi-word query
    // collapsed to relevance=0.1 and ties at ~0.448.
    // Title hits count 2x, snippet hits 1x. Normalize to [0.1, 0.7] so this branch
    // never outscores a direct title/snippet substring match.
    const words = q.split(/\s+/).filter((w) => w.length > 1);
    if (words.length === 0) {
      relevance = 0.1;
    } else {
      let hit = 0;
      const max = words.length * 3;
      for (const w of words) {
        if (t.includes(w)) hit += 2;
        else if (s.includes(w)) hit += 1;
      }
      relevance = 0.1 + (hit / max) * 0.6;
    }
  }

  let recency = 0.5;
  if (updatedAt) {
    const daysSince = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
    recency = 1.0 / (1 + daysSince / 30);
  }

  const importance = importanceHint;
  let score = recency * 0.3 + relevance * 0.5 + importance * 0.2;

  // v1.8.0: Stale memories get a significant downweight
  if (isStale) {
    score *= 0.3;
  }

  return score;
}

/**
 * Release 201 P0-6 — build the Prisma visibility predicate for an
 * IMMemoryPage query from a MemoryAclContext. Mirrors the logic in
 * memory-search.service.ts:visibilityWhere() so the recall path applies the
 * same access rules as the /memory page-read endpoints.
 *
 * Returns `null` when no visibility class is allowed (caller has no ACL
 * context). Caller should treat null as "skip the query entirely" rather
 * than return all rows.
 */
// Exported for regression tests (src/im/tests/recall-acl.test.ts).
export function pageVisibilityPredicate(acl: MemoryAclContext | null): Record<string, unknown> | null {
  if (!acl) return null;
  const clauses: Array<Record<string, unknown>> = [];
  if (acl.allowedVisibilities.length > 0) {
    clauses.push({ visibility: { in: acl.allowedVisibilities } });
  }
  for (const prefix of acl.allowedVisibilityPrefixes) {
    clauses.push({ visibility: { startsWith: prefix } });
  }
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : { OR: clauses };
}

function callerKindFromUser(user: { role?: string } | undefined): 'user' | 'agent' {
  return user?.role === 'agent' ? 'agent' : 'user';
}

export function createRecallRouter(
  memoryService: MemoryService,
  knowledgeLinkService?: KnowledgeLinkService,
  eventBusService?: EventBusService,
) {
  const router = new Hono();
  const resolveWorkspace = async (c: any, explicit?: unknown) => {
    try {
      return { workspaceId: await resolveMemoryWorkspaceIdForRequest(c, explicit) };
    } catch (err) {
      if (err instanceof WorkspaceResolutionError) {
        return { response: memoryWorkspaceErrorResponse(c, err) };
      }
      throw err;
    }
  };

  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /recall in routes.ts; wildcard scoped to that prefix
  router.use('*', authMiddleware);

  /**
   * GET /recall — Unified search across knowledge layers
   *
   * Query params:
   *   q           — search query (required)
   *   scope       — all | memory | cache | evolution (default: all)
   *   limit       — max results per source (default: 10)
   *   memoryScope — evolution/memory scope filter (default: global)
   */
  router.get('/', async (c) => {
    const user = c.get('user');
    const q = c.req.query('q');
    const scope = c.req.query('scope') || 'all';
    const memoryScope = c.req.query('memoryScope') || 'global';
    const limit = Math.min(parseInt(c.req.query('limit') || '10', 10), 50);
    const workspaceIdParam = c.req.query('workspaceId');

    if (!q || !q.trim()) {
      return c.json<ApiResponse>({ ok: false, error: 'q (query) parameter is required' }, 400);
    }

    const validScopes = ['all', 'memory', 'cache', 'evolution'];
    if (!validScopes.includes(scope)) {
      return c.json<ApiResponse>({ ok: false, error: `scope must be one of: ${validScopes.join(', ')}` }, 400);
    }

    const query = q.trim();
    const results: RecallResult[] = [];

    // Run searches in parallel
    const searches: Promise<void>[] = [];
    let workspaceId: string | undefined;

    if (scope === 'all' || scope === 'memory') {
      const resolved = await resolveWorkspace(c, workspaceIdParam);
      if (resolved.response) return resolved.response;
      workspaceId = resolved.workspaceId;
    }

    // ── Memory search (legacy im_memory_files) ────────────────
    if (scope === 'all' || scope === 'memory') {
      searches.push(
        memoryService
          .searchMemoryFiles(workspaceId!, query, limit, memoryScope)
          .then((files) => {
            for (const f of files) {
              const upstreamRelevance = (f as any).relevance as number | undefined;
              results.push({
                source: 'memory',
                title: f.path,
                path: f.path,
                snippet: f.snippet,
                score: computeScore(query, f.path, f.snippet, f.updatedAt, 0.5, f.stale, upstreamRelevance),
                id: f.id,
                updatedAt: f.updatedAt,
              });
            }
          })
          .catch((err) => {
            console.error('[Recall] Memory search error:', err);
          }),
      );

      // Also search workspace memory pages (im_memory_pages) for parity.
      // Release 201 P0-6 — caller's MemoryAclContext gates which visibility
      // classes (`workspace`, `agent:<id>`, `task:*`) the page query may
      // return. Without this filter, /recall leaks any-visibility pages to
      // any workspace member.
      searches.push(
        (async () => {
          try {
            const searchTerm = query.replace(/[+\-<>()~*"@]/g, ' ').trim();
            const words = searchTerm.split(/\s+/).filter(Boolean);
            if (words.length === 0) return;
            const likeClauses = words.map((w) => `%${w}%`);

            const acl = await loadWorkspaceForMemoryAccess(workspaceId!, user.imUserId, callerKindFromUser(user));
            const visFilter = pageVisibilityPredicate(acl);
            if (!visFilter) return; // No visibility allowed → no pages.

            const pages = await prisma.iMMemoryPage.findMany({
              where: {
                workspaceId,
                deletedAt: null,
                AND: [
                  visFilter,
                  {
                    OR: [
                      ...words.map((w) => ({ path: { contains: w } })),
                      ...words.map((w) => ({ content: { contains: w } })),
                    ],
                  },
                ],
              },
              select: {
                id: true,
                path: true,
                content: true,
                stale: true,
                updatedAt: true,
              },
              take: limit,
              orderBy: { updatedAt: 'desc' },
            });

            for (const p of pages) {
              results.push({
                source: 'memory',
                title: p.path,
                path: p.path,
                snippet: (p.content ?? '').slice(0, 300),
                score: computeScore(query, p.path, p.content ?? '', p.updatedAt, 0.5, p.stale),
                id: p.id,
                updatedAt: p.updatedAt,
              });
            }
          } catch (err) {
            console.error('[Recall] Memory pages search error:', err);
          }
        })(),
      );
    }

    // ── Cache search ───────────────────────────────────────
    if (scope === 'all' || scope === 'cache') {
      searches.push(
        (async () => {
          try {
            const entries = await prisma.contextCache.findMany({
              where: {
                OR: [
                  { tags: { contains: query } },
                  { hqccContent: { contains: query } },
                  { rawLink: { contains: query } },
                ],
                AND: {
                  OR: [{ visibility: { in: ['public', 'unlisted'] } }, { userId: user.imUserId }],
                },
              },
              select: {
                id: true,
                rawLink: true,
                hqccContent: true,
                tags: true,
                updatedAt: true,
              },
              take: limit,
              orderBy: { updatedAt: 'desc' },
            });

            for (const e of entries) {
              const snippet = ((e as any).hqccContent || '').slice(0, 300);
              results.push({
                source: 'cache',
                title: (e as any).rawLink,
                snippet,
                score: computeScore(query, (e as any).rawLink, snippet, e.updatedAt, 0.4),
                id: e.id,
                updatedAt: e.updatedAt,
              });
            }
          } catch (err) {
            console.error('[Recall] Cache search error:', err);
          }
        })(),
      );
    }

    // ── Evolution search ───────────────────────────────────
    // v1.8.1: Search published genes by FULLTEXT on title+description instead of capsule
    // substring matching. Capsule signalKey/summary never contains user-facing natural
    // language, so `contains(query)` always returned 0 results → source diversity stuck
    // at 0.6%. Gene title+description DO contain natural language and have a FULLTEXT
    // index (migration 035_fulltext_genes.sql).
    if (scope === 'all' || scope === 'evolution') {
      searches.push(
        (async () => {
          try {
            // Build a FULLTEXT boolean query from the user's keywords.
            // Same "first 2 words MUST, rest optional" strategy as memory search.
            const cleaned = query.replace(/[+\-<>()~*"@]/g, ' ').trim();
            const words = cleaned.split(/\s+/).filter(Boolean);
            if (words.length === 0) return;

            const booleanQuery = words.map((w, i) => (i < 2 ? `+${w}*` : `${w}*`)).join(' ');

            type GeneRow = {
              id: string;
              title: string;
              description: string | null;
              category: string;
              successCount: number;
              updatedAt: Date;
              ft_score: number;
            };

            const genes: GeneRow[] = await prisma.$queryRaw`
              SELECT id, title, description, category, successCount, updatedAt,
                     MATCH(title, description) AGAINST(${booleanQuery} IN BOOLEAN MODE) AS ft_score
              FROM im_genes
              WHERE visibility IN ('published', 'seed')
                AND MATCH(title, description) AGAINST(${booleanQuery} IN BOOLEAN MODE)
              ORDER BY ft_score DESC
              LIMIT ${limit}
            `;

            for (const g of genes) {
              const snippet = ((g.description || '') as string).slice(0, 300);
              results.push({
                source: 'evolution',
                title: g.title,
                snippet,
                score: computeScore(query, g.title, snippet, g.updatedAt, Math.min(g.successCount / 10, 1)),
                id: g.id,
                gene_id: g.id,
                updatedAt: g.updatedAt,
              });
            }
          } catch (err) {
            console.error('[Recall] Evolution search error:', err);
          }
        })(),
      );
    }

    await Promise.all(searches);

    // v1.8.0: Knowledge Link enhancement — attach linked gene info to memory results
    if (knowledgeLinkService) {
      try {
        const memoryIds = results.filter((r) => r.source === 'memory' && r.id).map((r) => r.id!);
        if (memoryIds.length > 0) {
          const linkedGenes = await knowledgeLinkService.getLinkedGenes(memoryIds);
          for (const r of results) {
            if (r.source === 'memory' && r.id && linkedGenes.has(r.id)) {
              r.linkedGenes = linkedGenes.get(r.id);
            }
          }
        }
      } catch (err) {
        console.error('[Recall] Knowledge link enhancement error:', err);
      }
    }

    // Sort by score descending, then by updatedAt descending
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aTime = a.updatedAt?.getTime() || 0;
      const bTime = b.updatedAt?.getTime() || 0;
      return bTime - aTime;
    });

    // Trim to total limit
    const trimmed = results.slice(0, limit);

    // Fire-and-forget: publish memory.recall event for Cross-system Signal Bridge
    // GET /recall is a multi-source search; geneId comes from query param if provided
    void eventBusService
      ?.publish({
        type: 'memory.recall',
        timestamp: Date.now(),
        data: { agentId: user.imUserId, geneId: c.req.query('geneId'), query, resultCount: trimmed.length, scope },
      })
      .catch(() => {});

    return c.json<ApiResponse>({
      ok: true,
      data: trimmed,
    });
  });

  /**
   * POST /recall — LLM-assisted memory recall (v1.8.0 P1)
   *
   * Body:
   *   query      — search query (required)
   *   maxResults — max files to return (default: 5, max: 20)
   *   strategy   — "keyword" | "llm" | "hybrid" (default: keyword)
   *   memoryType — filter by type (optional)
   *   scope      — evolution scope (default: global)
   */
  router.post('/', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    const { query, maxResults = 5, strategy = 'keyword', memoryType, scope = 'global' } = body;

    if (!query || typeof query !== 'string' || !query.trim()) {
      return c.json<ApiResponse>({ ok: false, error: 'query is required' }, 400);
    }

    const validStrategies = ['keyword', 'llm', 'hybrid'];
    if (!validStrategies.includes(strategy)) {
      return c.json<ApiResponse>({ ok: false, error: `strategy must be one of: ${validStrategies.join(', ')}` }, 400);
    }

    const clampedMax = Math.min(Math.max(1, maxResults), 20);

    const resolved = await resolveWorkspace(c, body.workspaceId);
    if (resolved.response) return resolved.response;

    const results = await recallMemory(memoryService, {
      query: query.trim(),
      workspaceId: resolved.workspaceId!,
      agentId: user.imUserId,
      scope,
      maxResults: clampedMax,
      strategy: strategy as RecallStrategy,
      memoryType,
    });

    // Also search workspace memory pages (im_memory_pages) for parity.
    // Release 201 P0-6 — gated by MemoryAclContext, see GET handler comment.
    if (results.length < clampedMax) {
      try {
        const words = query.trim().split(/\s+/).filter(Boolean);
        if (words.length > 0) {
          const acl = await loadWorkspaceForMemoryAccess(
            resolved.workspaceId!,
            user.imUserId,
            callerKindFromUser(user),
          );
          const visFilter = pageVisibilityPredicate(acl);
          if (!visFilter) {
            // No allowed visibilities → skip the page leg entirely. We
            // still return the file results computed above.
          } else {
            const pages = await prisma.iMMemoryPage.findMany({
              where: {
                workspaceId: resolved.workspaceId,
                deletedAt: null,
                AND: [
                  visFilter,
                  {
                    OR: [
                      ...words.slice(0, 3).map((w) => ({ content: { contains: w } })),
                      ...words.slice(0, 3).map((w) => ({ path: { contains: w } })),
                    ],
                  },
                ],
              },
              select: { id: true, path: true, content: true, memoryType: true, description: true, stale: true, updatedAt: true },
              take: clampedMax,
              orderBy: { updatedAt: 'desc' },
            });
            for (const p of pages) {
              if (results.length >= clampedMax) break;
              if (results.some((r: any) => r.id === p.id)) continue;
              results.push({
                id: p.id,
                path: p.path,
                content: p.content ?? '',
                memoryType: p.memoryType ?? 'reference',
                description: p.description ?? '',
                score: 0.5,
                reason: 'keyword match (memory page)',
                updatedAt: p.updatedAt,
              } as any);
            }
          }
        }
      } catch (err) {
        console.error('[Recall] Memory pages search error:', err);
      }
    }

    // Fire-and-forget: publish memory.recall event for Cross-system Signal Bridge
    // geneId is optional — bridge only records evolution signal when present
    void eventBusService
      ?.publish({
        type: 'memory.recall',
        timestamp: Date.now(),
        data: {
          agentId: user.imUserId,
          geneId: body.geneId,
          query: query.trim(),
          resultCount: results.length,
          strategy,
        },
      })
      .catch(() => {});

    return c.json<ApiResponse>({
      ok: true,
      data: results,
      meta: { strategy, count: results.length },
    });
  });

  return router;
}
