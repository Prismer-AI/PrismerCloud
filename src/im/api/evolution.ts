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
import { EvolutionService } from '../services/evolution.service';
import { AchievementService, BADGES } from '../services/achievement.service';
import type { RateLimiterService } from '../services/rate-limiter.service';
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
    const sort = (c.req.query('sort') || 'newest') as 'newest' | 'most_used' | 'highest_success';
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

  // ─── Authenticated Endpoints ───────────────────────────────

  /**
   * GET /api/evolution/scopes — List scopes the agent participates in
   */
  router.get('/scopes', authMiddleware, async (c) => {
    const user = c.get('user');
    // Query distinct scopes from agent's genes + edges
    const [geneScopes, edgeScopes] = await Promise.all([
      prisma.iMGene.findMany({
        where: { ownerAgentId: user.imUserId },
        select: { scope: true },
        distinct: ['scope'],
      }),
      prisma.iMEvolutionEdge.findMany({
        where: { ownerAgentId: user.imUserId },
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
    if (body.signals && Array.isArray(body.signals) && body.signals.length > 0) {
      signals = body.signals;
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
      // Get genes visible to this agent (scope-filtered)
      const scopeFilter = scope !== 'global' ? { scope: { in: [scope, 'global'] } } : {};
      const genes = await prisma.iMGene.findMany({
        where: {
          OR: [{ ownerAgentId: user.imUserId }, { visibility: { in: ['seed', 'published'] } }],
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
          await evolutionService.recordOutcome(user.imUserId, o);
          accepted++;
        } else {
          rejected.push(`outcome[${i}]: missing fields`);
        }
      } catch (err: any) {
        rejected.push(`outcome[${i}]: ${err.message}`);
      }
    }

    // Pull: get delta (reuse snapshot logic with since filter, scope-filtered)
    const rawSyncScope = c.req.query('scope') || body?.pull?.scope || 'global';
    const syncScope = isValidScope(rawSyncScope) ? rawSyncScope : 'global';
    const syncScopeFilter = syncScope !== 'global' ? { scope: { in: [syncScope, 'global'] } } : {};
    const genes = await prisma.iMGene.findMany({
      where: {
        OR: [{ ownerAgentId: user.imUserId }, { visibility: { in: ['seed', 'published'] } }],
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

    return c.json<ApiResponse>({
      ok: true,
      data: {
        pushed: { accepted, rejected },
        pulled: { genes, edges, globalPrior: {}, promotions, quarantines, cursor },
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

  return router;
}
