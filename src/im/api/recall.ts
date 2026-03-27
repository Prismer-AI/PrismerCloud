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
import type { ApiResponse } from '../types/index';

interface RecallResult {
  source: 'memory' | 'cache' | 'evolution';
  title: string;
  path?: string;
  snippet: string;
  score: number;
  id?: string;
  updatedAt?: Date;
}

/**
 * Simple relevance scoring:
 * - Exact match in title/path → 1.0
 * - Exact match in content/snippet → 0.8
 * - Partial match → 0.5
 */
function computeScore(query: string, title: string, snippet: string): number {
  const q = query.toLowerCase();
  const t = title.toLowerCase();
  const s = snippet.toLowerCase();

  if (t === q) return 1.0;
  if (t.includes(q)) return 0.9;
  if (s.startsWith(q)) return 0.8;
  if (s.includes(q)) return 0.6;
  return 0.5;
}

export function createRecallRouter(memoryService: MemoryService) {
  const router = new Hono();

  router.use('*', authMiddleware);

  /**
   * GET /recall — Unified search across knowledge layers
   *
   * Query params:
   *   q      — search query (required)
   *   scope  — all | memory | cache | evolution (default: all)
   *   limit  — max results per source (default: 10)
   */
  router.get('/', async (c) => {
    const user = c.get('user');
    const q = c.req.query('q');
    const scope = c.req.query('scope') || 'all';
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
        memoryService.searchMemoryFiles(user.imUserId, query, limit).then((files) => {
          for (const f of files) {
            results.push({
              source: 'memory',
              title: f.path,
              path: f.path,
              snippet: f.snippet,
              score: computeScore(query, f.path, f.snippet),
              id: f.id,
              updatedAt: f.updatedAt,
            });
          }
        }).catch((err) => {
          console.error('[Recall] Memory search error:', err);
        })
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
                  OR: [
                    { visibility: { in: ['public', 'unlisted'] } },
                    { userId: user.imUserId },
                  ],
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
                score: computeScore(query, (e as any).rawLink, snippet),
                id: e.id,
                updatedAt: e.updatedAt,
              });
            }
          } catch (err) {
            console.error('[Recall] Cache search error:', err);
          }
        })()
      );
    }

    // ── Evolution search ───────────────────────────────────
    if (scope === 'all' || scope === 'evolution') {
      searches.push(
        (async () => {
          try {
            const capsules = await prisma.iMEvolutionCapsule.findMany({
              where: {
                ownerAgentId: user.imUserId,
                OR: [
                  { signalKey: { contains: query } },
                  { geneId: { contains: query } },
                  { summary: { contains: query } },
                ],
              },
              select: {
                id: true,
                geneId: true,
                signalKey: true,
                summary: true,
                outcome: true,
                score: true,
                createdAt: true,
              },
              take: limit,
              orderBy: { createdAt: 'desc' },
            });

            for (const cap of capsules) {
              const title = `${(cap as any).geneId} [${(cap as any).outcome}]`;
              const snippet = (cap as any).summary || `Signal: ${(cap as any).signalKey}`;
              results.push({
                source: 'evolution',
                title,
                snippet: snippet.slice(0, 300),
                score: computeScore(query, title, snippet),
                id: cap.id,
                updatedAt: (cap as any).createdAt,
              });
            }
          } catch (err) {
            console.error('[Recall] Evolution search error:', err);
          }
        })()
      );
    }

    await Promise.all(searches);

    // Sort by score descending, then by updatedAt descending
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aTime = a.updatedAt?.getTime() || 0;
      const bTime = b.updatedAt?.getTime() || 0;
      return bTime - aTime;
    });

    // Trim to total limit
    const trimmed = results.slice(0, limit);

    return c.json<ApiResponse>({
      ok: true,
      data: trimmed,
    });
  });

  return router;
}
