/**
 * Prismer IM — Evolution API
 *
 * Skill Evolution endpoints: analyze signals, record outcomes,
 * manage genes, query memory graph, personality, and reports.
 *
 * @see docs/SKILL-EVOLUTION.md
 */

import { Hono } from 'hono';
import prisma from '../db';
import { authMiddleware } from '../auth/middleware';
import { getPersonAgentIds } from '../utils/person-agent-ids';
import { EvolutionService } from '../services/evolution.service';
import { AchievementService, BADGES } from '../services/achievement.service';
import type { RateLimiterService } from '../services/rate-limiter.service';
import type { MemoryService } from '../services/memory.service';
import { createRateLimitMiddleware } from '../middleware/rate-limit';
import { isValidScope } from '../utils/scope';
import type { ApiResponse } from '../types/index';

/** Extract and validate scope from query, return null on invalid */
function getScope(c: any): string | null {
  const scope = c.req.query('scope') || 'global';
  return isValidScope(scope) ? scope : null;
}

export function createEvolutionRouter(
  evolutionService: EvolutionService,
  achievementService?: AchievementService,
  rateLimiter?: RateLimiterService,
  memoryService?: MemoryService,
) {
  const router = new Hono();

  // ─── Public Endpoints (no auth) ────────────────────────────

  /**
   * GET /api/evolution/stories — Recent evolution events for L1 narrative (no auth, 10s cache)
   * Query: ?limit=3&since=30 (minutes)
   */
  router.get('/stories', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') || '3', 10), 10);
    const since = Math.min(parseInt(c.req.query('since') || '30', 10), 1440);
    const data = await evolutionService.getStories(limit, since);
    c.header('Cache-Control', 'public, max-age=10');
    return c.json<ApiResponse>({ ok: true, data });
  });

  /**
   * GET /api/evolution/metrics — North-star A/B comparison (no auth, 60s cache)
   */
  router.get('/metrics', async (c) => {
    const data = await evolutionService.getMetricsComparison();
    c.header('Cache-Control', 'public, max-age=60');
    return c.json<ApiResponse>({ ok: true, data });
  });

  /**
   * POST /api/evolution/metrics/collect — Trigger metrics snapshot (auth required)
   */
  router.post('/metrics/collect', authMiddleware, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const hours = ((body as Record<string, unknown>).window_hours as number) || 1;
    const [std, hyper] = await Promise.all([
      evolutionService.collectMetrics(hours, 'standard'),
      evolutionService.collectMetrics(hours, 'hypergraph'),
    ]);
    return c.json<ApiResponse>({ ok: true, data: { standard: std, hypergraph: hyper } });
  });

  /**
   * GET /api/evolution/map — Full map visualization data (no auth, 30s cache)
   */
  router.get('/map', async (c) => {
    try {
      const topN = parseInt(c.req.query('topN') || '0', 10) || undefined;
      const includeRaw = c.req.query('includeGeneIds') || '';
      const includeGeneIds = includeRaw ? includeRaw.split(',').filter(Boolean) : undefined;
      const data = await evolutionService.getMapData(topN || includeGeneIds ? { topN, includeGeneIds } : undefined);
      c.header('Cache-Control', 'public, max-age=30');
      return c.json<ApiResponse>({ ok: true, data });
    } catch (err) {
      console.error('[Evolution] Map endpoint error:', (err as Error).message);
      return c.json<ApiResponse>({ ok: false, error: `Map data unavailable: ${(err as Error).message}` }, 500);
    }
  });

  /**
   * GET /api/evolution/public/unmatched — Evolution frontier: unresolved signals (no auth)
   * Query: ?limit=20
   */
  router.get('/public/unmatched', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);
    const data = await evolutionService.getUnmatchedSignals(limit);
    return c.json<ApiResponse>({ ok: true, data });
  });

  /**
   * GET /api/evolution/public/stats — Global evolution statistics (no auth)
   */
  router.get('/public/stats', async (c) => {
    const stats = await evolutionService.getPublicStats();
    return c.json<ApiResponse>({ ok: true, data: stats });
  });

  /**
   * GET /api/evolution/public/metrics — Advanced observability metrics (no auth, 60s cache)
   */
  router.get('/public/metrics', async (c) => {
    const metrics = await evolutionService.getAdvancedMetrics();
    c.header('Cache-Control', 'public, max-age=60');
    return c.json<ApiResponse>({ ok: true, data: metrics });
  });

  /**
   * GET /api/evolution/public/hot — Hot genes list (no auth)
   * Query: ?limit=6
   */
  router.get('/public/hot', async (c) => {
    const limit = parseInt(c.req.query('limit') || '6', 10);
    const genes = await evolutionService.getPublicHotGenes(limit);
    return c.json<ApiResponse>({ ok: true, data: genes });
  });

  /**
   * GET /api/evolution/public/genes — Browse public genes (no auth)
   * Query: ?category=repair&search=timeout&sort=newest&page=1&limit=20
   */
  router.get('/public/genes', async (c) => {
    const category = c.req.query('category') || undefined;
    const search = c.req.query('search') || undefined;
    const sort = (c.req.query('sort') || 'newest') as 'newest' | 'most_used' | 'highest_success' | 'recommended';
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);

    const result = await evolutionService.getPublicGenes({ category, search, sort, page, limit });
    return c.json<ApiResponse>({ ok: true, data: result.genes, meta: { total: result.total, page, limit } });
  });

  /**
   * GET /api/evolution/public/genes/:geneId/capsules — Recent capsules for a gene (no auth)
   */
  router.get('/public/genes/:geneId/capsules', async (c) => {
    const geneId = c.req.param('geneId');
    const limit = Math.min(parseInt(c.req.query('limit') || '10', 10), 50);
    const capsules = await evolutionService.getPublicGeneCapsules(geneId, limit);
    return c.json<ApiResponse>({ ok: true, data: capsules });
  });

  /**
   * GET /api/evolution/public/genes/:geneId/lineage — Gene lineage tree (no auth)
   */
  router.get('/public/genes/:geneId/lineage', async (c) => {
    const geneId = c.req.param('geneId');
    const result = await evolutionService.getGeneLineage(geneId);
    if (!result) {
      return c.json<ApiResponse>({ ok: false, error: 'Gene not found' }, 404);
    }
    return c.json<ApiResponse>({ ok: true, data: result });
  });

  /**
   * GET /api/evolution/public/genes/:geneId — Public gene detail (no auth)
   */
  router.get('/public/genes/:geneId', async (c) => {
    const geneId = c.req.param('geneId');
    const gene = await evolutionService.getPublicGeneDetail(geneId);
    if (!gene) {
      return c.json<ApiResponse>({ ok: false, error: 'Gene not found or not public' }, 404);
    }
    return c.json<ApiResponse>({ ok: true, data: gene });
  });

  /**
   * GET /api/evolution/public/feed — Recent evolution events (no auth)
   * Query: ?limit=20
   */
  router.get('/public/feed', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);
    const feed = await evolutionService.getPublicFeed(limit);
    return c.json<ApiResponse>({ ok: true, data: feed });
  });

  /**
   * GET /api/evolution/public/leaderboard — Achievement leaderboard (no auth)
   */
  router.get('/public/leaderboard', async (c) => {
    if (!achievementService) return c.json<ApiResponse>({ ok: true, data: [] });
    const limit = parseInt(c.req.query('limit') || '20', 10);
    const leaderboard = await achievementService.getLeaderboard(limit);
    return c.json<ApiResponse>({ ok: true, data: leaderboard });
  });

  /**
   * GET /api/evolution/public/badges — All available badge definitions (no auth)
   */
  router.get('/public/badges', (c) => {
    return c.json<ApiResponse>({ ok: true, data: BADGES });
  });

  /**
   * GET /api/evolution/public/metrics-history — Historical metrics (no auth, 300s cache)
   * Query: ?days=14
   */
  router.get('/public/metrics-history', async (c) => {
    try {
      const days = Math.min(parseInt(c.req.query('days') || '14', 10), 90);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const rows = await prisma.iMEvolutionMetrics.findMany({
        where: { mode: 'standard', scope: 'global', ts: { gte: since } },
        orderBy: { ts: 'asc' },
      });
      c.header('Cache-Control', 'public, max-age=300');
      return c.json<ApiResponse>({ ok: true, data: rows });
    } catch (err) {
      return c.json<ApiResponse>({ ok: true, data: [] });
    }
  });

  // ─── Authenticated Endpoints ───────────────────────────────

  /**
   * GET /api/evolution/scopes — List scopes the agent participates in
   */
  router.get('/scopes', authMiddleware, async (c) => {
    const user = c.get('user');
    // Person-level: query scopes from all agent instances of the same person
    const personAgentIds = await getPersonAgentIds(user.imUserId);
    const [geneScopes, edgeScopes] = await Promise.all([
      prisma.iMGene.findMany({
        where: { ownerAgentId: { in: personAgentIds } },
        select: { scope: true },
        distinct: ['scope'],
      }),
      prisma.iMEvolutionEdge.findMany({
        where: { ownerAgentId: { in: personAgentIds } },
        select: { scope: true },
        distinct: ['scope'],
      }),
    ]);
    const scopes = [
      ...new Set([
        ...geneScopes.map((g: any) => g.scope),
        ...edgeScopes.map((e: any) => e.scope),
        'global', // always include global
      ]),
    ];
    return c.json({ ok: true, data: scopes });
  });

  /**
   * GET /api/evolution/report — Evolution report (own agent only)
   * Query: ?scope=global
   */
  router.get('/report', authMiddleware, async (c) => {
    const user = c.get('user');
    const requestedId = c.req.query('agent_id');
    const scope = getScope(c);
    if (!scope) return c.json<ApiResponse>({ ok: false, error: 'Invalid scope format' }, 400);

    // Only allow querying own report
    if (requestedId && requestedId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Can only view your own evolution report' }, 403);
    }

    const report = await evolutionService.generateReport(user.imUserId, scope);
    return c.json<ApiResponse>({ ok: true, data: report });
  });

  // Rate limiting helper — placed after authMiddleware in handler chain
  const rl = rateLimiter
    ? (action: string) => createRateLimitMiddleware(rateLimiter, action)
    : () => async (_c: any, next: any) => next(); // no-op passthrough

  /**
   * POST /api/evolution/report — Submit raw context for async LLM aggregation (auth)
   * Returns immediately with trace_id. LLM processes in background.
   */
  router.post('/report', authMiddleware, rl('tool_call'), async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    if (!body.raw_context || typeof body.raw_context !== 'string') {
      return c.json<ApiResponse>({ ok: false, error: 'raw_context is required (string)' }, 400);
    }
    if (!body.outcome || !['success', 'failed'].includes(body.outcome)) {
      return c.json<ApiResponse>({ ok: false, error: 'outcome is required (success|failed)' }, 400);
    }

    const result = await evolutionService.submitReport(user.imUserId, {
      raw_context: body.raw_context,
      task: body.task,
      outcome: body.outcome,
      score: body.score,
      provider: body.provider,
      stage: body.stage,
      severity: body.severity,
      gene_id: body.gene_id,
    });

    return c.json<ApiResponse>({ ok: true, data: result });
  });

  /**
   * GET /api/evolution/report/:traceId — Check report processing status (auth)
   */
  router.get('/report/:traceId', authMiddleware, async (c) => {
    const user = c.get('user');
    const traceId = c.req.param('traceId');
    const result = await evolutionService.getReportStatus(traceId, user.imUserId);
    if (!result) return c.json<ApiResponse>({ ok: false, error: 'Report not found' }, 404);
    return c.json<ApiResponse>({ ok: true, data: result });
  });

  /**
   * GET /api/evolution/achievements — Own achievements (auth)
   */
  router.get('/achievements', authMiddleware, async (c) => {
    if (!achievementService) return c.json<ApiResponse>({ ok: true, data: [] });
    const user = c.get('user');
    const achievements = await achievementService.getAchievements(user.imUserId);
    return c.json<ApiResponse>({ ok: true, data: achievements });
  });

  /**
   * POST /api/evolution/analyze — Analyze signals and get evolution advice
   *
   * Body: { context?: string,
   *         signals?: string[] | SignalTag[],  ← v0.3.0: accepts both formats
   *         task_status?: string, task_capability?: string, error?: string, tags?: string[],
   *         provider?: string, stage?: string, severity?: string }
   *
   * Returns: EvolutionAdvice
   */
  router.post('/analyze', authMiddleware, rl('tool_call'), async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    // Extract signals from context or use provided signals
    // v0.3.0: signals[] can be string[] (old) or SignalTag[] (new)
    let signals: string[] | object[];
    let rawSignals = body.signals;
    if (typeof rawSignals === 'string') {
      try {
        rawSignals = JSON.parse(rawSignals);
      } catch {
        rawSignals = [rawSignals];
      }
    }
    if (rawSignals && Array.isArray(rawSignals) && rawSignals.length > 0) {
      signals = rawSignals;
    } else {
      signals = evolutionService.extractSignals({
        taskStatus: body.task_status,
        taskCapability: body.task_capability,
        error: body.error,
        tags: body.tags,
        customSignals: body.custom_signals,
        provider: body.provider,
        stage: body.stage,
        severity: body.severity,
      });
    }

    if (signals.length === 0) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'No signals could be extracted. Provide signals[] or context fields (task_status, error, tags).',
        },
        400,
      );
    }

    // Extract scope from query (default: 'global')
    const scope = getScope(c);
    if (!scope) return c.json<ApiResponse>({ ok: false, error: 'Invalid scope format' }, 400);
    const advice = await evolutionService.selectGene(signals as string[], user.imUserId, scope);

    // v1.8.0: search for related memory files using signal key as query
    if (memoryService && advice.signals?.length > 0) {
      try {
        const signalTypes = advice.signals.map((s: any) => (typeof s === 'string' ? s : s.type));
        const searchTerms = signalTypes.map((t: string) =>
          t.replace(/^(error|perf|tag|capability):/, '').replace(/_/g, ' '),
        );
        const uniqueTerms = [...new Set(searchTerms)].slice(0, 3);

        const memoryResults = await Promise.all(
          uniqueTerms.map((term: string) => memoryService.searchMemoryFiles(user.imUserId, term, 3)),
        );

        const seen = new Set<string>();
        const relatedMemories: Array<{ id: string; path: string; snippet: string; relevance: number }> = [];
        for (const results of memoryResults) {
          for (const r of results) {
            if (!seen.has(r.id)) {
              seen.add(r.id);
              relatedMemories.push({
                id: r.id,
                path: r.path,
                snippet: r.snippet,
                relevance: (r as any).relevance ?? 0.5,
              });
            }
          }
        }

        advice.relatedMemories = relatedMemories.sort((a, b) => b.relevance - a.relevance).slice(0, 5);
      } catch (err) {
        console.error('[Evolution] Related memory search error:', err);
        advice.relatedMemories = [];
      }
    } else {
      advice.relatedMemories = [];
    }

    return c.json<ApiResponse>({ ok: true, data: advice });
  });

  /**
   * POST /api/evolution/record — Record a gene execution outcome
   *
   * Body: { gene_id: string, signals: string[], outcome: "success"|"failed",
   *         score?: number, summary: string, cost_credits?: number, metadata?: object }
   */
  router.post('/record', authMiddleware, rl('tool_call'), async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    if (!body.gene_id || !body.signals || !body.outcome || !body.summary) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'gene_id, signals, outcome, and summary are required',
        },
        400,
      );
    }

    if (!Array.isArray(body.signals) || body.signals.length === 0) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'signals must be a non-empty array',
        },
        400,
      );
    }

    if (!['success', 'failed'].includes(body.outcome)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'outcome must be "success" or "failed"',
        },
        400,
      );
    }

    if (body.score !== undefined && (body.score < 0 || body.score > 1)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'score must be between 0 and 1',
        },
        400,
      );
    }

    // Extract scope from query (default: 'global')
    const scope = getScope(c);
    if (!scope) return c.json<ApiResponse>({ ok: false, error: 'Invalid scope format' }, 400);

    try {
      const result = await evolutionService.recordOutcome(
        user.imUserId,
        {
          gene_id: body.gene_id,
          signals: body.signals,
          outcome: body.outcome,
          score: body.score,
          summary: body.summary,
          cost_credits: body.cost_credits,
          metadata: body.metadata,
          transition_reason: body.transition_reason,
          context_snapshot: body.context_snapshot,
        },
        scope,
      );
      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err: any) {
      if (err.code === 'GENE_NOT_FOUND') {
        return c.json<ApiResponse>({ ok: false, error: 'Gene not found' }, 404);
      }
      if (err.code === 'GENE_ACCESS_DENIED') {
        return c.json<ApiResponse>({ ok: false, error: 'Gene not accessible to this agent' }, 403);
      }
      throw err;
    }
  });

  /**
   * POST /api/evolution/distill — Trigger gene distillation
   *
   * Checks readiness, then runs LLM-based distillation to synthesize a new Gene
   * from successful capsules. Requires OPENAI_API_KEY env var for LLM calls.
   *
   * Query: ?dry_run=true  — check readiness without triggering LLM
   */
  router.post('/distill', authMiddleware, rl('tool_call'), async (c) => {
    const user = c.get('user');
    const dryRun = c.req.query('dry_run') === 'true';

    const ready = await evolutionService.shouldDistill(user.imUserId);
    const capsules = await evolutionService.getSuccessCapsules(user.imUserId, 10);

    if (dryRun || !ready) {
      return c.json<ApiResponse>({
        ok: true,
        data: {
          ready,
          success_capsules: capsules.length,
          min_required: 10,
          message: ready
            ? 'Agent is ready for gene distillation. Remove ?dry_run=true to trigger.'
            : `Need ≥10 successful capsules with 70% recent success rate and 24h cooldown. Have ${capsules.length} successful capsules.`,
        },
      });
    }

    // Trigger actual distillation
    const result = await evolutionService.triggerDistillation(user.imUserId);

    return c.json<ApiResponse>({
      ok: true,
      data: result,
    });
  });

  /**
   * GET /api/evolution/genes — List available genes for the agent
   *
   * Query: ?signals=signal1,signal2  (optional: filter by signal match)
   */
  router.get('/genes', authMiddleware, async (c) => {
    const user = c.get('user');
    const signalsParam = c.req.query('signals');
    // Extract scope from query (default: 'global')
    const scope = getScope(c);
    if (!scope) return c.json<ApiResponse>({ ok: false, error: 'Invalid scope format' }, 400);

    let genes = await evolutionService.loadGenes(user.imUserId, scope);

    // Filter by signal match if provided (v0.3.0: match on tag.type)
    if (signalsParam) {
      const filterSignals = signalsParam.split(',').map((s) => s.trim());
      genes = genes.filter((gene) => {
        const overlap = gene.signals_match.filter((tag) => filterSignals.includes(tag.type));
        return overlap.length > 0;
      });
    }

    return c.json<ApiResponse>({
      ok: true,
      data: genes,
      meta: { count: genes.length },
    });
  });

  /**
   * POST /api/evolution/genes — Create a new gene
   *
   * Body: { category: "repair"|"optimize"|"innovate", signals_match: string[],
   *         strategy: string[], preconditions?: string[], constraints?: object,
   *         title?: string, description?: string }
   */
  router.post('/genes', authMiddleware, rl('tool_call'), async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    if (!body.category || !body.signals_match || !body.strategy) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'category, signals_match, and strategy are required',
        },
        400,
      );
    }

    if (!['repair', 'optimize', 'innovate', 'diagnostic'].includes(body.category)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'category must be "repair", "optimize", "innovate", or "diagnostic"',
        },
        400,
      );
    }

    if (!Array.isArray(body.signals_match) || body.signals_match.length === 0) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'signals_match must be a non-empty array',
        },
        400,
      );
    }

    if (!Array.isArray(body.strategy) || body.strategy.length === 0) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: 'strategy must be a non-empty array',
        },
        400,
      );
    }

    // Extract scope from query (default: 'global')
    const scope = getScope(c);
    if (!scope) return c.json<ApiResponse>({ ok: false, error: 'Invalid scope format' }, 400);

    const gene = evolutionService.createGene({
      category: body.category,
      signals_match: body.signals_match,
      strategy: body.strategy,
      preconditions: body.preconditions,
      constraints: body.constraints,
      created_by: user.imUserId,
      title: body.title,
      description: body.description,
    });

    await evolutionService.saveGene(user.imUserId, gene, scope);

    // Resolve any unmatched signals that this gene now covers
    const signalKey = evolutionService.computeSignalKey(body.signals_match);
    await evolutionService.resolveUnmatchedSignal(signalKey, gene.id).catch(() => {});

    return c.json<ApiResponse>({ ok: true, data: gene }, 201);
  });

  /**
   * GET /api/evolution/genes/:geneId — Get gene detail (owner can see private genes)
   */
  router.get('/genes/:geneId', authMiddleware, async (c) => {
    const user = c.get('user');
    const geneId = c.req.param('geneId');
    const scope = getScope(c) || 'global';

    try {
      const gene = await prisma.iMGene.findFirst({
        where: { id: geneId, ownerAgentId: user.imUserId, scope },
      });
      if (!gene) {
        // Fallback: try public gene (not owner but published)
        const publicGene = await prisma.iMGene.findFirst({
          where: { id: geneId, visibility: 'published', scope },
        });
        if (!publicGene) {
          return c.json<ApiResponse>({ ok: false, error: 'Gene not found' }, 404);
        }
        return c.json<ApiResponse>({ ok: true, data: publicGene });
      }
      return c.json<ApiResponse>({ ok: true, data: gene });
    } catch (err) {
      console.error('[Evolution] Get gene detail error:', err);
      return c.json<ApiResponse>({ ok: false, error: 'Failed to load gene' }, 500);
    }
  });

  /**
   * DELETE /api/evolution/genes/:geneId — Delete a gene
   */
  router.delete('/genes/:geneId', authMiddleware, async (c) => {
    const user = c.get('user');
    const geneId = c.req.param('geneId');

    const deleted = await evolutionService.deleteGene(user.imUserId, geneId);
    if (!deleted) {
      return c.json<ApiResponse>({ ok: false, error: 'Gene not found' }, 404);
    }

    return c.json<ApiResponse>({ ok: true });
  });

  /**
   * GET /api/evolution/edges — Query memory graph edges
   *
   * Query: ?signal_key=...&gene_id=...&limit=100
   */
  router.get('/edges', authMiddleware, async (c) => {
    const user = c.get('user');
    const signalKey = c.req.query('signal_key');
    const geneId = c.req.query('gene_id');
    const limit = parseInt(c.req.query('limit') || '100', 10);
    // Extract scope from query (default: 'global')
    const scope = getScope(c);
    if (!scope) return c.json<ApiResponse>({ ok: false, error: 'Invalid scope format' }, 400);

    const edges = await evolutionService.getEdges(user.imUserId, {
      signalKey: signalKey || undefined,
      geneId: geneId || undefined,
      limit,
      scope,
    });

    return c.json<ApiResponse>({
      ok: true,
      data: edges,
      meta: { count: edges.length },
    });
  });

  /**
   * GET /api/evolution/personality/:agentId — Get agent personality (own agent only)
   */
  router.get('/personality/:agentId', authMiddleware, async (c) => {
    const user = c.get('user');
    const agentId = c.req.param('agentId');

    // Only allow querying own personality
    if (agentId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Can only view your own agent personality' }, 403);
    }

    const [personality, stats] = await Promise.all([
      evolutionService.getPersonality(agentId),
      evolutionService.getPersonalityStats(agentId),
    ]);

    return c.json<ApiResponse>({
      ok: true,
      data: { personality, stats },
    });
  });

  /**
   * POST /api/evolution/genes/:geneId/publish — Publish a gene to public market
   */
  router.post('/genes/:geneId/publish', authMiddleware, rl('tool_call'), async (c) => {
    const user = c.get('user');
    const geneId = c.req.param('geneId');
    const body = await c.req.json().catch(() => ({}));
    const skipCanary = body?.skipCanary === true;

    const result = skipCanary
      ? await evolutionService.publishGeneDirect(user.imUserId, geneId)
      : await evolutionService.publishGene(user.imUserId, geneId);
    if (!result) {
      return c.json<ApiResponse>({ ok: false, error: 'Gene not found or already published' }, 404);
    }
    return c.json<ApiResponse>({ ok: true, data: result });
  });

  /**
   * POST /api/evolution/genes/import — Import a public gene to own agent
   */
  router.post('/genes/import', authMiddleware, rl('tool_call'), async (c) => {
    try {
      const user = c.get('user');
      const body = await c.req.json();

      if (!body.gene_id) {
        return c.json<ApiResponse>({ ok: false, error: 'gene_id is required' }, 400);
      }

      const gene = await evolutionService.importPublicGene(user.imUserId, body.gene_id);
      if (!gene) {
        return c.json<ApiResponse>({ ok: false, error: 'Gene not found or not public' }, 404);
      }
      return c.json<ApiResponse>({ ok: true, data: gene }, 201);
    } catch (err) {
      console.error('[Evolution] Import gene error:', err);
      return c.json<ApiResponse>({ ok: false, error: `Import failed: ${(err as Error).message}` }, 500);
    }
  });

  /**
   * POST /api/evolution/genes/fork — Fork a public gene with optional modifications
   */
  router.post('/genes/fork', authMiddleware, rl('tool_call'), async (c) => {
    const user = c.get('user');
    const body = await c.req.json();

    if (!body.gene_id) {
      return c.json<ApiResponse>({ ok: false, error: 'gene_id required' }, 400);
    }

    const result = await evolutionService.forkGene(user.imUserId, body.gene_id, body.modifications);
    if (!result) {
      return c.json<ApiResponse>({ ok: false, error: 'Source gene not found' }, 404);
    }

    return c.json<ApiResponse>({ ok: true, data: result });
  });

  /**
   * GET /api/evolution/capsules — List own capsules (paginated)
   * Query: ?page=1&limit=20
   */
  router.get('/capsules', authMiddleware, async (c) => {
    const user = c.get('user');
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);
    // Extract scope from query (default: 'global')
    const scope = getScope(c);
    if (!scope) return c.json<ApiResponse>({ ok: false, error: 'Invalid scope format' }, 400);

    const result = await evolutionService.getCapsules(user.imUserId, page, limit, scope);
    return c.json<ApiResponse>({ ok: true, data: result.capsules, meta: { total: result.total, page, limit } });
  });

  // ─── Sync Endpoints (SDK Local Runtime) ─────────

  /**
   * GET /api/evolution/sync/snapshot — Full sync snapshot for SDK cache init
   */
  router.get('/sync/snapshot', authMiddleware, async (c) => {
    const user = c.get('user');
    const since = parseInt(c.req.query('since') || '0', 10);
    const scope = getScope(c);
    if (!scope) return c.json<ApiResponse>({ ok: false, error: 'Invalid scope format' }, 400);

    try {
      // Person-level sync: pull genes from all agent instances of the same person
      const personAgentIds = await getPersonAgentIds(user.imUserId);
      const scopeFilter = scope !== 'global' ? { scope: { in: [scope, 'global'] } } : {};
      const genes = await prisma.iMGene.findMany({
        where: {
          OR: [{ ownerAgentId: { in: personAgentIds } }, { visibility: { in: ['seed', 'published'] } }],
          ...(since > 0 ? { updatedAt: { gt: new Date(since) } } : {}),
          ...scopeFilter,
        },
        take: 500,
        orderBy: { updatedAt: 'desc' },
      });

      // Get edges for this agent
      const edges = await prisma.iMEvolutionEdge.findMany({
        where: {
          ownerAgentId: user.imUserId,
          ...(since > 0 ? { updatedAt: { gt: new Date(since) } } : {}),
        },
      });

      // Global prior
      const priorAgg = await prisma.iMEvolutionEdge.groupBy({
        by: ['signalType'],
        where: { signalType: { not: null } },
        _sum: { successCount: true, failureCount: true },
      });
      const globalPrior: Record<string, { alpha: number; beta: number }> = {};
      for (const agg of priorAgg) {
        if (agg.signalType) {
          globalPrior[agg.signalType] = {
            alpha: (agg._sum?.successCount || 0) + 1,
            beta: (agg._sum?.failureCount || 0) + 1,
          };
        }
      }

      // Cursor
      let cursor = since;
      for (const g of genes) {
        const t = (g as any).updatedAt?.getTime() || 0;
        if (t > cursor) cursor = t;
      }
      for (const e of edges) {
        const t = (e as any).updatedAt?.getTime() || 0;
        if (t > cursor) cursor = t;
      }

      return c.json<ApiResponse>({ ok: true, data: { genes, edges, globalPrior, cursor } });
    } catch (err: any) {
      return c.json<ApiResponse>({ ok: false, error: err.message }, 500);
    }
  });

  /**
   * POST /api/evolution/sync — Bidirectional sync: push outcomes + pull delta
   */
  router.post('/sync', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = await c.req.json();
    const pushOutcomes = body?.push?.outcomes ?? [];
    const pullSince = body?.pull?.since ?? 0;

    // Push: process outcomes
    let accepted = 0;
    const rejected: string[] = [];
    for (let i = 0; i < pushOutcomes.length; i++) {
      const o = pushOutcomes[i];
      try {
        if (o.gene_id && o.signals && o.outcome && o.summary) {
          const pushScope = c.req.query('scope') || body?.push?.scope || 'global';
          await evolutionService.recordOutcome(user.imUserId, o, pushScope);
          accepted++;
        } else {
          rejected.push(`outcome[${i}]: missing fields`);
        }
      } catch (err: any) {
        rejected.push(`outcome[${i}]: ${err.message}`);
      }
    }

    // Pull: person-level delta (all agent instances of the same person)
    const rawSyncScope = c.req.query('scope') || body?.pull?.scope || 'global';
    const syncScope = isValidScope(rawSyncScope) ? rawSyncScope : 'global';
    const syncScopeFilter = syncScope !== 'global' ? { scope: { in: [syncScope, 'global'] } } : {};
    const personAgentIds = await getPersonAgentIds(user.imUserId);
    const genes = await prisma.iMGene.findMany({
      where: {
        OR: [{ ownerAgentId: { in: personAgentIds } }, { visibility: { in: ['seed', 'published'] } }],
        updatedAt: { gt: new Date(pullSince) },
        ...syncScopeFilter,
      },
      take: 200,
    });
    const edges = await prisma.iMEvolutionEdge.findMany({
      where: { ownerAgentId: user.imUserId, updatedAt: { gt: new Date(pullSince) }, ...syncScopeFilter },
    });

    let cursor = pullSince;
    for (const g of genes) {
      const t = (g as any).updatedAt?.getTime() || 0;
      if (t > cursor) cursor = t;
    }
    for (const e of edges) {
      const t = (e as any).updatedAt?.getTime() || 0;
      if (t > cursor) cursor = t;
    }

    const promotions = genes.filter((g: any) => g.visibility === 'published').map((g: any) => g.id);
    const quarantines = genes.filter((g: any) => g.visibility === 'quarantined').map((g: any) => g.id);

    // Global prior: aggregated success/failure by signalType (client can cache for cold-start)
    const priorAgg = await prisma.iMEvolutionEdge.groupBy({
      by: ['signalType'],
      where: { signalType: { not: null } },
      _sum: { successCount: true, failureCount: true },
    });
    const globalPrior: Record<string, { alpha: number; beta: number }> = {};
    for (const agg of priorAgg) {
      if (agg.signalType) {
        globalPrior[agg.signalType] = {
          alpha: (agg._sum?.successCount || 0) + 1,
          beta: (agg._sum?.failureCount || 0) + 1,
        };
      }
    }

    return c.json<ApiResponse>({
      ok: true,
      data: {
        pushed: { accepted, rejected },
        pulled: { genes, edges, globalPrior, promotions, quarantines, cursor },
      },
    });
  });

  // ─── Gene Export (Gene → Skill) ─────────────────────────

  /**
   * POST /api/evolution/genes/:geneId/export-skill — Export a gene as a Skill in the catalog
   *
   * Body: { slug?: string, displayName?: string, changelog?: string }
   */
  router.post('/genes/:geneId/export-skill', authMiddleware, async (c) => {
    const user = c.get('user');
    const geneId = c.req.param('geneId');
    const body = await c.req.json().catch(() => ({}));

    // Find the gene and verify ownership
    const gene = await prisma.iMGene.findUnique({ where: { id: geneId } });
    if (!gene || gene.ownerAgentId !== user.imUserId) {
      return c.json<ApiResponse>({ ok: false, error: 'Gene not found or not owned' }, 404);
    }

    // Generate slug from body or gene ID
    const slug = (body as any).slug || geneId.replace(/[^a-z0-9-]/gi, '-').toLowerCase();

    // Check slug uniqueness
    const existingSlug = await prisma.iMSkill.findUnique({ where: { slug } });
    if (existingSlug) {
      return c.json<ApiResponse>({ ok: false, error: `Slug "${slug}" already taken` }, 409);
    }

    // Fetch gene signals
    const signals = await prisma.iMGeneSignal.findMany({ where: { geneId } });
    const strategy: string[] = JSON.parse(gene.strategySteps || '[]');
    const preconditions: string[] = JSON.parse(gene.preconditions || '[]');

    // Generate SKILL.md with proper YAML serialization (handles special chars)
    const yaml = await import('yaml');
    const frontmatter: Record<string, any> = {
      name: slug,
      description: gene.description || gene.title || '',
      metadata: {
        prismer: {
          category: gene.category,
          signals: signals.map((s: any) => ({ type: s.signalId })),
          gene: {
            strategy,
            ...(preconditions.length > 0 ? { preconditions } : {}),
          },
        },
      },
    };
    const yamlStr = yaml.stringify(frontmatter).trimEnd();

    const content = `---
${yamlStr}
---

# ${gene.title || slug}

${gene.description || ''}

## Strategy
${strategy.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}
`;

    // Create the skill in the catalog
    const skill = await prisma.iMSkill.create({
      data: {
        slug,
        name: (body as any).displayName || gene.title || slug,
        description: gene.description || '',
        category: gene.category,
        content,
        source: 'prismer',
        ownerAgentId: user.imUserId,
        geneId: gene.id,
        signals: JSON.stringify(signals.map((s: any) => ({ type: s.signalId }))),
        version: '1.0.0',
        changelog: (body as any).changelog || 'Auto-generated from evolution gene',
      },
    });

    return c.json<ApiResponse>({ ok: true, data: { skill, content } }, 201);
  });

  // ─── Leaderboard Endpoints (public, no auth) ──────────────

  const VALID_PERIODS = ['weekly', 'monthly', 'alltime'];

  /**
   * GET /api/evolution/leaderboard/agents/me — Current user's agent row (auth).
   * Avoids list limit/offset; includes value_metrics fallback when not in snapshot.
   */
  router.get('/leaderboard/agents/me', authMiddleware, async (c) => {
    try {
      const user = c.get('user');
      const period = VALID_PERIODS.includes(c.req.query('period') || '') ? c.req.query('period')! : 'alltime';
      const domain = c.req.query('domain') || undefined;
      const { getAgentLeaderboardEntry } = await import('../services/leaderboard.service');
      const entry = await getAgentLeaderboardEntry(user.imUserId, { period, domain });
      return c.json<ApiResponse>({ ok: true, data: entry });
    } catch (err) {
      console.error('[Evolution] Leaderboard agents/me error:', err);
      return c.json<ApiResponse>({ ok: false, error: 'Failed to load your leaderboard entry' }, 500);
    }
  });

  /**
   * GET /api/evolution/leaderboard/agents — Agent Improvement Board
   * Query: ?period=weekly&domain=coding&limit=50&offset=0
   */
  router.get('/leaderboard/agents', async (c) => {
    try {
      const { getAgentLeaderboard, getLeaderboardStats } = await import('../services/leaderboard.service');
      const period = VALID_PERIODS.includes(c.req.query('period') || '') ? c.req.query('period')! : 'weekly';
      const domain = c.req.query('domain') || undefined;
      const limit = Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 100);
      const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0);

      const sort = c.req.query('sort') || undefined;
      const [agents, stats] = await Promise.all([
        getAgentLeaderboard({ period, domain, limit, offset, sort }),
        getLeaderboardStats(),
      ]);

      return c.json<ApiResponse>({ ok: true, data: { agents, stats, period, domain } });
    } catch (err) {
      console.error('[Evolution] Leaderboard agents error:', err);
      return c.json<ApiResponse>({ ok: false, error: 'Failed to load agent leaderboard' }, 500);
    }
  });

  /**
   * GET /api/evolution/leaderboard/genes — Gene Impact Board
   * Query: ?period=weekly&domain=coding&limit=50&sort=impact
   */
  router.get('/leaderboard/genes', async (c) => {
    try {
      const { getGeneLeaderboard } = await import('../services/leaderboard.service');
      const period = VALID_PERIODS.includes(c.req.query('period') || '') ? c.req.query('period')! : 'weekly';
      const domain = c.req.query('domain') || undefined;
      const limit = Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 100);
      const sort = (c.req.query('sort') === 'adopters' ? 'adopters' : 'impact') as 'impact' | 'adopters';

      const genes = await getGeneLeaderboard({ period, domain, limit, sort });
      return c.json<ApiResponse>({ ok: true, data: { genes, period, domain } });
    } catch (err) {
      console.error('[Evolution] Leaderboard genes error:', err);
      return c.json<ApiResponse>({ ok: false, error: 'Failed to load gene leaderboard' }, 500);
    }
  });

  /**
   * GET /api/evolution/leaderboard/contributors — Contributor Board
   * Query: ?period=weekly&limit=50
   */
  router.get('/leaderboard/contributors', async (c) => {
    try {
      const { getContributorLeaderboard } = await import('../services/leaderboard.service');
      const period = VALID_PERIODS.includes(c.req.query('period') || '') ? c.req.query('period')! : 'weekly';
      const limit = Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 100);

      const sort = c.req.query('sort') || undefined;
      const contributors = await getContributorLeaderboard({ period, limit, sort });
      return c.json<ApiResponse>({ ok: true, data: { contributors, period } });
    } catch (err) {
      console.error('[Evolution] Leaderboard contributors error:', err);
      return c.json<ApiResponse>({ ok: false, error: 'Failed to load contributor leaderboard' }, 500);
    }
  });

  /**
   * GET /api/evolution/leaderboard/stats — Summary stats for hero section
   */
  router.get('/leaderboard/stats', async (c) => {
    try {
      const { getLeaderboardStats } = await import('../services/leaderboard.service');
      const stats = await getLeaderboardStats();
      return c.json<ApiResponse>({ ok: true, data: stats });
    } catch (err) {
      console.error('[Evolution] Leaderboard stats error:', err);
      return c.json<ApiResponse>({ ok: false, error: 'Failed to load leaderboard stats' }, 500);
    }
  });

  /**
   * POST /api/evolution/leaderboard/snapshot — Trigger manual snapshot computation
   * Normally called by IM TaskScheduler cron, but exposed for admin/testing.
   */
  router.post('/leaderboard/snapshot', authMiddleware, async (c) => {
    try {
      // Admin-only: snapshot computation is expensive
      const user = c.get('user') as { role?: string } | undefined;
      if (!user || user.role !== 'admin') {
        return c.json<ApiResponse>({ ok: false, error: 'Admin access required' }, 403);
      }
      const { computeLeaderboardSnapshot } = await import('../services/leaderboard.service');
      const { computeTokenBaselines, computeValueMetrics } = await import('../services/value-metrics.service');
      const body = await c.req.json().catch(() => ({}));
      const period = (body as any).period || 'weekly';

      // Full pipeline: baselines → value metrics → snapshot (same as daily cron)
      const baselines = await computeTokenBaselines().catch(() => 0);
      const metrics = await computeValueMetrics(period).catch(() => ({ agents: 0, creators: 0 }));
      const result = await computeLeaderboardSnapshot(period);
      return c.json<ApiResponse>({ ok: true, data: { ...result, baselines, metrics } });
    } catch (err: any) {
      console.error('[Evolution] Leaderboard snapshot error:', err);
      return c.json<ApiResponse>({ ok: false, error: `Snapshot failed: ${err?.message || err}` }, 500);
    }
  });

  /**
   * GET /api/evolution/leaderboard/comparison — A/B comparison for admin
   * Returns standard vs hypergraph mode metrics for the A/B chart.
   */
  router.get('/leaderboard/comparison', async (c) => {
    try {
      const comparison = await evolutionService.getMetricsComparison();
      return c.json<ApiResponse>({ ok: true, data: comparison });
    } catch (err) {
      console.error('[Evolution] Leaderboard comparison error:', err);
      return c.json<ApiResponse>({ ok: false, error: 'Failed to load comparison' }, 500);
    }
  });

  // ─── Leaderboard V2 Endpoints ────────────────────────────────

  /**
   * GET /api/evolution/leaderboard/hero — Hero section global stats (no auth)
   */
  router.get('/leaderboard/hero', async (c) => {
    try {
      const { getLeaderboardHero } = await import('../services/leaderboard.service');
      const data = await getLeaderboardHero();
      return c.json({ ok: true, data });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /**
   * GET /api/evolution/leaderboard/rising — Rising stars leaderboard (no auth)
   * Query: ?limit=20 (max 50)
   */
  router.get('/leaderboard/rising', async (c) => {
    try {
      const limit = parseInt(c.req.query('limit') || '20');
      const { getRisingLeaderboard } = await import('../services/leaderboard.service');
      const entries = await getRisingLeaderboard(Math.min(limit, 50));
      return c.json({ ok: true, data: { entries } });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /**
   * GET /api/evolution/profile/:id — Public profile landing page data (no auth)
   * Returns value metrics, badges, top gene, highlight capsule, trend snapshots.
   */
  router.get('/profile/:id', async (c) => {
    try {
      const slug = c.req.param('id');

      let user = await prisma.iMUser.findFirst({
        where: { id: slug },
        select: {
          id: true,
          username: true,
          role: true,
          displayName: true,
          userId: true,
          avatarUrl: true,
          createdAt: true,
        },
      });
      if (!user) {
        user = await prisma.iMUser.findFirst({
          where: { username: slug },
          select: {
            id: true,
            username: true,
            role: true,
            displayName: true,
            userId: true,
            avatarUrl: true,
            createdAt: true,
          },
        });
      }
      if (!user) {
        return c.json({ ok: false, error: 'Profile not found' }, 404);
      }

      const isHuman = user.role === 'human';

      // ── Human Owner Profile: aggregate across all owned agents ──
      if (isHuman && user.userId) {
        const ownedAgents = await prisma.iMUser.findMany({
          where: { userId: user.userId, role: 'agent' },
          select: { id: true, username: true, displayName: true, createdAt: true },
        });
        const agentIds = ownedAgents.map((a: any) => a.id);

        // Aggregate value across all agents
        const allCapsules =
          agentIds.length > 0
            ? await prisma.iMEvolutionCapsule.findMany({
                where: { ownerAgentId: { in: agentIds }, outcome: 'success' },
                select: { ownerAgentId: true, costCredits: true, signalKey: true },
              })
            : [];

        const baselines = allCapsules.length > 0 ? await prisma.iMTokenBaseline.findMany() : [];
        const baselineMap = new Map<string, number>(baselines.map((b: any) => [b.signalKey, b.avgTokensNoGene]));
        const baselineValues = baselines.map((b: any) => b.avgTokensNoGene as number).filter((v: number) => v > 0);
        const globalAvgBaseline =
          baselineValues.length > 0
            ? baselineValues.reduce((a: number, b: number) => a + b, 0) / baselineValues.length
            : 500; // cold-start default

        let totalTokenSaved = 0;
        const perAgentCapsules = new Map<string, number>();
        for (const cap of allCapsules) {
          const baseline = baselineMap.get(cap.signalKey) || globalAvgBaseline;
          totalTokenSaved += Math.max(0, baseline - cap.costCredits);
          perAgentCapsules.set(cap.ownerAgentId, (perAgentCapsules.get(cap.ownerAgentId) || 0) + 1);
        }

        const totalValue = {
          tokenSaved: totalTokenSaved,
          moneySaved: (totalTokenSaved / 1000) * 0.009,
          co2Reduced: (totalTokenSaved / 1000) * 0.0003,
          devHoursSaved: (allCapsules.length * 8) / 60,
        };

        // Per-agent stats
        const agentCards =
          agentIds.length > 0
            ? await prisma.iMAgentCard.findMany({
                where: { imUserId: { in: agentIds } },
                select: { imUserId: true, name: true },
              })
            : [];
        const cardLookup = new Map<string, string>((agentCards as any[]).map((c: any) => [c.imUserId, c.name]));

        // Per-agent leaderboard rank (latest snapshot)
        const agentSnaps =
          agentIds.length > 0
            ? await prisma.iMLeaderboardSnapshot.findMany({
                where: { agentId: { in: agentIds }, boardType: 'agent' },
                orderBy: { snapshotDate: 'desc' },
                distinct: ['agentId'] as any,
                select: { agentId: true, rank: true, err: true },
              })
            : [];
        const snapLookup = new Map((agentSnaps as any[]).map((s: any) => [s.agentId, s]));

        const fleet = ownedAgents.map((a: any) => {
          const snap = snapLookup.get(a.id);
          return {
            id: a.id,
            slug: a.username,
            name: cardLookup.get(a.id) || a.displayName || a.username,
            capsules: perAgentCapsules.get(a.id) || 0,
            rank: snap?.rank ?? null,
            err: snap?.err ?? null,
            createdAt: a.createdAt,
          };
        });
        fleet.sort((a: any, b: any) => b.capsules - a.capsules);

        // Aggregate badges across all agents
        const allBadges =
          agentIds.length > 0
            ? await prisma.iMEvolutionAchievement.findMany({
                where: { agentId: { in: agentIds } },
                select: { badgeKey: true },
                distinct: ['badgeKey'] as any,
              })
            : [];

        // Total genes published by all agents
        const genesPublished =
          agentIds.length > 0 ? await prisma.iMGene.count({ where: { ownerAgentId: { in: agentIds } } }) : 0;

        return c.json({
          ok: true,
          data: {
            profileType: 'owner',
            slug: user.username,
            id: user.id,
            name: user.displayName || user.username,
            avatarUrl: user.avatarUrl,
            joinedAt: user.createdAt,
            value: totalValue,
            badges: allBadges.map((a: any) => a.badgeKey),
            genesPublished,
            fleet,
          },
        });
      }

      // ── Agent Profile (single agent) ──
      const agentId = user.id;
      const card = await prisma.iMAgentCard.findFirst({ where: { imUserId: agentId }, select: { name: true } });

      const agentData = await prisma.iMValueMetrics.findFirst({
        where: { entityId: agentId, period: 'weekly' },
        orderBy: { snapshotDate: 'desc' },
      });

      let value = {
        tokenSaved: agentData?.tokenSaved ?? 0,
        moneySaved: agentData?.moneySaved ?? 0,
        co2Reduced: agentData?.co2Reduced ?? 0,
        devHoursSaved: agentData?.devHoursSaved ?? 0,
      };

      if (!agentData) {
        const capsules = await prisma.iMEvolutionCapsule.findMany({
          where: { ownerAgentId: agentId, outcome: 'success' },
          select: { costCredits: true, signalKey: true },
        });
        if (capsules.length > 0) {
          const baselines = await prisma.iMTokenBaseline.findMany();
          const baselineMap = new Map<string, number>(baselines.map((b: any) => [b.signalKey, b.avgTokensNoGene]));
          const bVals = baselines.map((b: any) => b.avgTokensNoGene as number).filter((v: number) => v > 0);
          const gAvg = bVals.length > 0 ? bVals.reduce((a: number, b: number) => a + b, 0) / bVals.length : 500;
          let totalSaved = 0;
          for (const cap of capsules) {
            const baseline = baselineMap.get(cap.signalKey) || gAvg;
            totalSaved += Math.max(0, baseline - cap.costCredits);
          }
          value = {
            tokenSaved: totalSaved,
            moneySaved: (totalSaved / 1000) * 0.009,
            co2Reduced: (totalSaved / 1000) * 0.0003,
            devHoursSaved: (capsules.length * 8) / 60,
          };
        }
      }

      // Find owner info + sibling agents
      let ownerSlug: string | null = null;
      let siblings: any[] = [];
      if (user.userId) {
        const owner = await prisma.iMUser.findFirst({
          where: { userId: user.userId, role: 'human' },
          select: { username: true, displayName: true },
        });
        if (owner) ownerSlug = owner.username;
        const siblingAgents = await prisma.iMUser.findMany({
          where: { userId: user.userId, role: 'agent', id: { not: agentId } },
          select: { id: true, username: true, displayName: true },
          take: 10,
        });
        const sibCards =
          siblingAgents.length > 0
            ? await prisma.iMAgentCard.findMany({
                where: { imUserId: { in: siblingAgents.map((s: any) => s.id) } },
                select: { imUserId: true, name: true },
              })
            : [];
        const sibCardMap = new Map((sibCards as any[]).map((c: any) => [c.imUserId, c.name]));
        siblings = siblingAgents.map((s: any) => ({
          id: s.id,
          slug: s.username,
          name: sibCardMap.get(s.id) || s.displayName || s.username,
        }));
      }

      const [achievements, topGeneResult, highlight, snapshots] = await Promise.all([
        prisma.iMEvolutionAchievement.findMany({ where: { agentId }, select: { badgeKey: true } }),
        (async () => {
          const bestEdge = await prisma.iMEvolutionEdge.findFirst({
            where: { ownerAgentId: agentId, scope: 'global', successCount: { gte: 1 } },
            orderBy: { successCount: 'desc' },
            select: { geneId: true, successCount: true, failureCount: true },
          });
          if (!bestEdge) return null;
          const gene = await prisma.iMGene.findFirst({
            where: { id: bestEdge.geneId, visibility: { not: 'private' } },
            select: { id: true, title: true, description: true },
          });
          if (!gene) return null;
          const total = bestEdge.successCount + bestEdge.failureCount;
          const adopterCount = await prisma.iMEvolutionCapsule
            .groupBy({
              by: ['ownerAgentId'],
              where: { geneId: gene.id, ownerAgentId: { not: agentId } },
            })
            .then((r: any[]) => r.length)
            .catch(() => 0);
          return {
            id: gene.id,
            title: gene.title,
            description: gene.description || '',
            successRate: total > 0 ? bestEdge.successCount / total : 0,
            adopters: adopterCount,
          };
        })(),
        prisma.iMEvolutionCapsule.findFirst({
          where: { ownerAgentId: agentId, outcome: 'success', score: { gte: 0.5 } },
          orderBy: { score: 'desc' },
          select: {
            id: true,
            signalKey: true,
            outcome: true,
            score: true,
            summary: true,
            costCredits: true,
            createdAt: true,
          },
        }),
        prisma.iMLeaderboardSnapshot.findMany({
          where: { agentId, boardType: 'agent' },
          orderBy: { snapshotDate: 'desc' },
          take: 5,
          select: { err: true },
        }),
      ]);

      const trend = (snapshots as any[])
        .map((s) => s.err)
        .filter((e) => e !== null)
        .reverse();

      let liveErr = null;
      if (trend.length === 0) {
        const edges = await prisma.iMEvolutionEdge.findMany({
          where: { ownerAgentId: agentId, scope: 'global' },
          select: { successCount: true, failureCount: true },
        });
        const totalS = edges.reduce((s: number, e: any) => s + e.successCount, 0);
        const totalF = edges.reduce((s: number, e: any) => s + e.failureCount, 0);
        if (totalS + totalF > 0) liveErr = totalS / (totalS + totalF);
      }

      return c.json({
        ok: true,
        data: {
          profileType: 'agent',
          slug: user.username,
          id: agentId,
          name: user.displayName || card?.name || user.username || agentId,
          ownerSlug: ownerSlug,
          value,
          rank: agentData
            ? {
                current: agentData.rankByValue || agentData.rankByImpact,
                percentile: agentData.percentile,
                period: 'weekly',
              }
            : { current: null, percentile: null, period: 'weekly' },
          badges: achievements.map((a: any) => a.badgeKey),
          trend: trend.length > 0 ? trend : liveErr !== null ? [liveErr] : [],
          topGene: topGeneResult,
          highlight: highlight
            ? {
                capsuleId: highlight.id,
                signalKey: highlight.signalKey,
                outcome: highlight.outcome,
                score: highlight.score,
                summary: highlight.summary,
                tokenSaved: highlight.costCredits,
                createdAt: highlight.createdAt,
              }
            : null,
          siblings,
          liveStats: !agentData
            ? {
                capsuleCount: await prisma.iMEvolutionCapsule.count({ where: { ownerAgentId: agentId } }),
                geneCount: await prisma.iMGene.count({ where: { ownerAgentId: agentId } }),
                edgeCount: await prisma.iMEvolutionEdge.count({ where: { ownerAgentId: agentId } }),
              }
            : undefined,
        },
      });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /**
   * GET /api/evolution/benchmark — Benchmark data for FOMO section (no auth)
   * Query: ?agentId=xxx (optional, for personalized comparison)
   */
  router.get('/benchmark', async (c) => {
    try {
      const agentId = c.req.query('agentId');
      const { getBenchmarkData } = await import('../services/value-metrics.service');
      const data = await getBenchmarkData(agentId || undefined);
      return c.json({ ok: true, data });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /**
   * GET /api/evolution/highlights/:geneId — Top success capsules for a gene (no auth)
   * Query: ?limit=3 (max 10)
   */
  router.get('/highlights/:geneId', async (c) => {
    try {
      const geneId = c.req.param('geneId');
      const limit = parseInt(c.req.query('limit') || '3');

      const capsules = await prisma.iMEvolutionCapsule.findMany({
        where: { geneId, outcome: 'success', score: { gte: 0.8 } },
        orderBy: { score: 'desc' },
        take: Math.min(limit, 10),
        select: {
          id: true,
          ownerAgentId: true,
          signalKey: true,
          score: true,
          summary: true,
          costCredits: true,
          createdAt: true,
        },
      });

      // Resolve agent names
      const agentIds = capsules.map((cap: any) => cap.ownerAgentId);
      const cards = await prisma.iMAgentCard.findMany({
        where: { imUserId: { in: agentIds } },
        select: { imUserId: true, name: true },
      });
      const cardMap = new Map((cards as any[]).map((card: any) => [card.imUserId, card.name]));

      return c.json({
        ok: true,
        data: capsules.map((cap: any) => ({
          capsuleId: cap.id,
          agentName: cardMap.get(cap.ownerAgentId) || cap.ownerAgentId,
          signalKey: cap.signalKey,
          score: cap.score,
          summary: cap.summary,
          tokenSaved: cap.costCredits,
          createdAt: cap.createdAt,
        })),
      });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /**
   * POST /api/evolution/card/render — Render exportable agent/creator card as PNG (no auth)
   * Body: { type: 'agent'|'creator', id: string }
   */
  router.post('/card/render', async (c) => {
    try {
      const body = await c.req.json();
      const { type, id } = body;
      if (!type || !id) return c.json({ ok: false, error: 'type and id required' }, 400);
      const { renderAgentCard, renderCreatorCard } = await import('../services/card-render.service');
      const png = type === 'creator' ? await renderCreatorCard(id) : await renderAgentCard(id);
      return new Response(png as unknown as BodyInit, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
      });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ─── Admin: Anti-Cheat ────────────────────────────────────────

  /**
   * GET /api/evolution/admin/anti-cheat — View anti-cheat detection log (admin only)
   * Query: ?ruleKey=xxx&limit=50
   */
  router.get('/admin/anti-cheat', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      if (user?.role !== 'admin') return c.json({ ok: false, error: 'Admin only' }, 403);
      const { getAntiCheatLog } = await import('../services/anti-cheat.service');
      const data = await getAntiCheatLog({
        ruleKey: c.req.query('ruleKey') || undefined,
        limit: parseInt(c.req.query('limit') || '50'),
      });
      return c.json({ ok: true, data });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  /**
   * POST /api/evolution/admin/anti-cheat/:id/clear — Clear anti-cheat flag (admin only)
   */
  router.post('/admin/anti-cheat/:id/clear', authMiddleware, async (c) => {
    try {
      const user = c.get('user') as any;
      if (user?.role !== 'admin') return c.json({ ok: false, error: 'Admin only' }, 403);
      const id = parseInt(c.req.param('id'));
      const { clearAntiCheatFlag } = await import('../services/anti-cheat.service');
      await clearAntiCheatFlag(id, user.imUserId || 'admin');
      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  return router;
}
