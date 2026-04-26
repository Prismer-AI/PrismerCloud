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

export function createRecallRouter(
  memoryService: MemoryService,
  knowledgeLinkService?: KnowledgeLinkService,
  eventBusService?: EventBusService,
) {
  const router = new Hono();

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

    // ── Memory search ──────────────────────────────────────
    if (scope === 'all' || scope === 'memory') {
      searches.push(
        memoryService
          .searchMemoryFiles(user.imUserId, query, limit, memoryScope)
          .then((files) => {
            for (const f of files) {
              // Pass through upstream relevance: memory.service already ran FULLTEXT +
              // word-coverage, so its ranking is authoritative — don't recompute here.
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
              WHERE scope = ${memoryScope}
                AND visibility IN ('published', 'seed')
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

    const results = await recallMemory(memoryService, {
      query: query.trim(),
      agentId: user.imUserId,
      scope,
      maxResults: clampedMax,
      strategy: strategy as RecallStrategy,
      memoryType,
    });

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
