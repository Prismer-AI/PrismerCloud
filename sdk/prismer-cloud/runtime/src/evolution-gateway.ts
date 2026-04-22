/**
 * Prismer Runtime — Evolution Gateway HTTP API
 *
 * Exposes evolution gateway operations via HTTP for daemon process.
 * Integrates with LLM Dispatcher for distillation triggers.
 *
 * Endpoints:
 * - POST /evolution/signal — Extract signals from tool output / log
 * - POST /evolution/record — Record gene execution outcome
 * - POST /evolution/analyze — Analyze signals and recommend gene
 * - POST /evolution/genes — Create new gene
 * - GET /evolution/genes — Query available genes
 * - GET /evolution/personality — Get agent personality
 * - POST /evolution/distill — Trigger distillation
 *
 * @see docs/version190/IMPLEMENTATION-PLAN-RUNTIME-GAP.md
 */

import type { EventBus } from './event-bus.js';
import type { LLMDispatcher } from './llm-dispatcher.js';
import type { AgentSupervisor } from './agent-supervisor.js';
import type { RouteHandler, AuthenticatedIdentity } from './daemon-http.js';
import { readBody, sendJson, extractBearer } from './http/helpers.js';

// ============================================================
// Public Types
// ============================================================

export interface EvolutionGatewayOptions {
  eventBus: EventBus;
  supervisor: AgentSupervisor;
  llmDispatcher?: LLMDispatcher;
  /** Cloud API base URL (default: https://prismer.cloud) */
  cloudApiBase?: string;
  /** Authenticated identity (from Bearer token or API key) */
  authenticate?: (bearerToken: string | undefined) => AuthenticatedIdentity | null;
  /**
   * v1.9.0 B.7.a — API key used as the Bearer token when forwarding daemon
   * requests to the cloud Evolution API. When undefined, outbound requests
   * omit the Authorization header (callers get 401 from cloud until the
   * daemon is started with `apiKey`).
   */
  cloudApiKey?: string;
}

export interface SignalExtractionRequest {
  toolOutput?: {
    toolName?: string;
    output?: string;
    exitCode?: number;
    error?: string;
    durationMs?: number;
  };
  logFile?: {
    logPath?: string;
    logContent?: string;
    timestamp?: string;
  };
  provider?: string;
  stage?: string;
  severity?: string;
  tags?: string[];
}

export interface AnalyzeRequest {
  signals: string[];
  taskCapability?: string;
  provider?: string;
  stage?: string;
  severity?: string;
}

export interface RecordRequest {
  geneId: string;
  signals: string[];
  outcome: 'success' | 'failed';
  score?: number;
  summary?: string;
  costCredits?: number;
  transitionReason?: 'gene_applied' | 'fallback_relaxed' | 'fallback_neighbor' | 'baseline';
}

export interface CreateGeneRequest {
  category: 'repair' | 'optimize' | 'innovate' | 'diagnostic';
  signalsMatch: string[];
  strategy: string[];
  preconditions?: string[];
  constraints?: {
    maxCredits?: number;
    maxRetries?: number;
    maxExecutionTime?: number;
  };
}

export interface DistillationRequest {
  /** Skip LLM verification and trigger immediately */
  dryRun?: boolean;
}

// ============================================================
// Evolution Gateway HTTP Handler
// ============================================================

export class EvolutionGatewayHttpHandler {
  private readonly eventBus: EventBus;
  private readonly supervisor: AgentSupervisor;
  private readonly llmDispatcher: LLMDispatcher | undefined;
  private readonly cloudApiBase: string;
  private readonly authenticate: EvolutionGatewayOptions['authenticate'];
  private readonly cloudApiKey: string | undefined;

  // Route registry
  private readonly routes = new Map<string, RouteHandler>();

  constructor(opts: EvolutionGatewayOptions) {
    this.eventBus = opts.eventBus;
    this.supervisor = opts.supervisor;
    this.llmDispatcher = opts.llmDispatcher;
    this.cloudApiBase = (opts.cloudApiBase || 'https://prismer.cloud').replace(/\/api\/?$/, '');
    this.authenticate = opts.authenticate;
    this.cloudApiKey = opts.cloudApiKey;

    this.registerRoutes();
  }

  private cloudAuthHeaders(agentId: string, extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Prismer-AgentId': agentId,
      ...extra,
    };
    if (this.cloudApiKey !== undefined && this.cloudApiKey.length > 0) {
      headers['Authorization'] = `Bearer ${this.cloudApiKey}`;
    }
    return headers;
  }

  // ============================================================
  // Route Registration
  // ============================================================

  private registerRoutes(): void {
    // POST /evolution/signal — Extract signals
    this.routes.set('POST:/evolution/signal', this.handleExtractSignal.bind(this));

    // POST /evolution/analyze — Analyze signals and recommend gene
    this.routes.set('POST:/evolution/analyze', this.handleAnalyze.bind(this));

    // POST /evolution/record — Record gene execution outcome
    this.routes.set('POST:/evolution/record', this.handleRecord.bind(this));

    // POST /evolution/genes — Create new gene
    this.routes.set('POST:/evolution/genes', this.handleCreateGene.bind(this));

    // GET /evolution/genes — Query available genes
    this.routes.set('GET:/evolution/genes', this.handleQueryGenes.bind(this));

    // GET /evolution/personality — Get agent personality
    this.routes.set('GET:/evolution/personality', this.handleGetPersonality.bind(this));

    // POST /evolution/distill — Trigger distillation
    this.routes.set('POST:/evolution/distill', this.handleDistill.bind(this));

    // GET /evolution/unmatched — Get unmatched signals
    this.routes.set('GET:/evolution/unmatched', this.handleGetUnmatched.bind(this));
  }

  // ============================================================
  // Public API
  // ============================================================

  /** Get all registered routes */
  getRoutes(): Map<string, RouteHandler> {
    return new Map(this.routes);
  }

  /** Get a specific route handler */
  getRoute(method: string, path: string): RouteHandler | undefined {
    return this.routes.get(`${method}:${path}`);
  }

  // ============================================================
  // Route Handlers
  // ============================================================

  /**
   * POST /evolution/signal
   * Extract signals from tool output or log file.
   */
  private async handleExtractSignal(
    _req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    ctx: { authed: AuthenticatedIdentity | null; body: Buffer },
  ): Promise<void> {
    try {
      // Parse request body
      const body = JSON.parse(ctx.body.toString()) as SignalExtractionRequest;

      // Validate request
      if (!body.toolOutput && !body.logFile) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Either toolOutput or logFile must be provided',
        });
      }

      // Extract signals locally (no cloud call needed)
      const signals = this.extractSignalsLocal(body);

      // Publish event to event bus
      await this.eventBus.publish('evolution:signal_extracted', {
        agentId: ctx.authed?.agentId,
        signals,
        source: body.toolOutput ? 'tool_output' : 'log_file',
        extractedAt: new Date().toISOString(),
      });

      sendJson(res, 200, {
        ok: true,
        data: signals,
        processedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[EvolutionGateway] Signal extraction error:', (err as Error).message);
      sendJson(res, 500, {
        ok: false,
        error: `Signal extraction failed: ${(err as Error).message}`,
      });
    }
  }

  /**
   * POST /evolution/analyze
   * Analyze signals and recommend the best gene.
   */
  private async handleAnalyze(
    _req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    ctx: { authed: AuthenticatedIdentity | null; body: Buffer },
  ): Promise<void> {
    if (!ctx.authed) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    try {
      const body = JSON.parse(ctx.body.toString()) as AnalyzeRequest;

      // Validate request
      if (!body.signals || !Array.isArray(body.signals)) {
        return sendJson(res, 400, {
          ok: false,
          error: 'signals array is required',
        });
      }

      // Call Cloud IM API
      const advice = await this.callCloudAnalyze(body, ctx.authed.agentId);

      sendJson(res, 200, {
        ok: true,
        data: advice,
        processedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[EvolutionGateway] Analyze error:', (err as Error).message);
      sendJson(res, 500, {
        ok: false,
        error: `Analysis failed: ${(err as Error).message}`,
      });
    }
  }

  /**
   * POST /evolution/record
   * Record gene execution outcome.
   */
  private async handleRecord(
    _req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    ctx: { authed: AuthenticatedIdentity | null; body: Buffer },
  ): Promise<void> {
    if (!ctx.authed) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    try {
      const body = JSON.parse(ctx.body.toString()) as RecordRequest;

      // Validate request
      if (!body.geneId || !body.outcome) {
        return sendJson(res, 400, {
          ok: false,
          error: 'geneId and outcome are required',
        });
      }

      // Call Cloud IM API
      const result = await this.callCloudRecord(body, ctx.authed.agentId);

      // Publish event to event bus
      await this.eventBus.publish('evolution:outcome_recorded', {
        agentId: ctx.authed.agentId,
        geneId: body.geneId,
        outcome: body.outcome,
        recordedAt: new Date().toISOString(),
      });

      sendJson(res, 200, {
        ok: true,
        data: result,
        recordedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[EvolutionGateway] Record error:', (err as Error).message);
      sendJson(res, 500, {
        ok: false,
        error: `Recording failed: ${(err as Error).message}`,
      });
    }
  }

  /**
   * POST /evolution/genes
   * Create a new gene.
   */
  private async handleCreateGene(
    _req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    ctx: { authed: AuthenticatedIdentity | null; body: Buffer },
  ): Promise<void> {
    if (!ctx.authed) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    try {
      const body = JSON.parse(ctx.body.toString()) as CreateGeneRequest;

      // Validate request
      if (!body.category || !body.signalsMatch || !body.strategy) {
        return sendJson(res, 400, {
          ok: false,
          error: 'category, signalsMatch, and strategy are required',
        });
      }

      // Call Cloud IM API
      const gene = await this.callCloudCreateGene(body, ctx.authed.agentId);

      // Publish event to event bus
      await this.eventBus.publish('evolution:gene_created', {
        agentId: ctx.authed.agentId,
        geneId: (gene as { id?: string }).id,
        category: body.category,
        createdAt: new Date().toISOString(),
      });

      sendJson(res, 200, {
        ok: true,
        data: gene,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[EvolutionGateway] Create gene error:', (err as Error).message);
      sendJson(res, 500, {
        ok: false,
        error: `Gene creation failed: ${(err as Error).message}`,
      });
    }
  }

  /**
   * GET /evolution/genes
   * Query available genes.
   */
  private async handleQueryGenes(
    _req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    ctx: { authed: AuthenticatedIdentity | null; body: Buffer },
  ): Promise<void> {
    if (!ctx.authed) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    try {
      // Call Cloud IM API
      const genes = await this.callCloudQueryGenes(ctx.authed.agentId);

      sendJson(res, 200, {
        ok: true,
        data: genes,
        queriedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[EvolutionGateway] Query genes error:', (err as Error).message);
      sendJson(res, 500, {
        ok: false,
        error: `Query failed: ${(err as Error).message}`,
      });
    }
  }

  /**
   * GET /evolution/personality
   * Get agent personality.
   */
  private async handleGetPersonality(
    _req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    ctx: { authed: AuthenticatedIdentity | null; body: Buffer },
  ): Promise<void> {
    if (!ctx.authed) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    try {
      // Call Cloud IM API
      const personality = await this.callCloudGetPersonality(ctx.authed.agentId);

      sendJson(res, 200, {
        ok: true,
        data: personality,
        retrievedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[EvolutionGateway] Get personality error:', (err as Error).message);
      sendJson(res, 500, {
        ok: false,
        error: `Failed to get personality: ${(err as Error).message}`,
      });
    }
  }

  /**
   * POST /evolution/distill
   * Trigger gene distillation.
   */
  private async handleDistill(
    _req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    ctx: { authed: AuthenticatedIdentity | null; body: Buffer },
  ): Promise<void> {
    if (!ctx.authed) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    try {
      const body = JSON.parse(ctx.body.toString()) as DistillationRequest;

      // Call Cloud IM API (or local distillation if LLM dispatcher available)
      const triggered = this.llmDispatcher
        ? await this.triggerLocalDistillation(ctx.authed.agentId, body.dryRun)
        : await this.callCloudDistill(ctx.authed.agentId);

      // Publish event to event bus
      await this.eventBus.publish('evolution:distillation_triggered', {
        agentId: ctx.authed.agentId,
        triggered,
        triggeredAt: new Date().toISOString(),
      });

      sendJson(res, 200, {
        ok: true,
        data: { triggered },
        triggeredAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[EvolutionGateway] Distillation error:', (err as Error).message);
      sendJson(res, 500, {
        ok: false,
        error: `Distillation failed: ${(err as Error).message}`,
      });
    }
  }

  /**
   * GET /evolution/unmatched
   * Get unmatched signals (evolution frontier).
   */
  private async handleGetUnmatched(
    _req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    ctx: { authed: AuthenticatedIdentity | null; body: Buffer },
  ): Promise<void> {
    if (!ctx.authed) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    try {
      // Call Cloud IM API
      const unmatched = await this.callCloudGetUnmatched();

      sendJson(res, 200, {
        ok: true,
        data: unmatched,
        retrievedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[EvolutionGateway] Get unmatched error:', (err as Error).message);
      sendJson(res, 500, {
        ok: false,
        error: `Failed to get unmatched signals: ${(err as Error).message}`,
      });
    }
  }

  // ============================================================
  // Cloud API Integration
  // ============================================================

  private async parseCloudResponse(response: Response): Promise<unknown> {
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Cloud API error (${response.status}): ${text}`);
    }

    const json = text ? JSON.parse(text) : {};
    if (json?.ok === false) {
      throw new Error(typeof json.error === 'string' ? json.error : JSON.stringify(json.error));
    }
    return json?.data ?? json;
  }

  private async callCloudAnalyze(body: AnalyzeRequest, agentId: string): Promise<unknown> {
    const url = `${this.cloudApiBase}/api/im/evolution/analyze`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.cloudAuthHeaders(agentId),
      body: JSON.stringify({
        signals: body.signals,
        task_capability: body.taskCapability,
        tags: [],
        provider: body.provider,
        stage: body.stage,
        severity: body.severity,
      }),
    });

    return await this.parseCloudResponse(response);
  }

  private async callCloudRecord(body: RecordRequest, agentId: string): Promise<unknown> {
    const url = `${this.cloudApiBase}/api/im/evolution/record`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.cloudAuthHeaders(agentId),
      body: JSON.stringify({
        gene_id: body.geneId,
        signals: body.signals,
        outcome: body.outcome,
        score: body.score,
        summary: body.summary,
        cost_credits: body.costCredits,
        transition_reason: body.transitionReason,
      }),
    });

    return await this.parseCloudResponse(response);
  }

  private async callCloudCreateGene(body: CreateGeneRequest, agentId: string): Promise<unknown> {
    const url = `${this.cloudApiBase}/api/im/evolution/genes`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.cloudAuthHeaders(agentId),
      body: JSON.stringify({
        category: body.category,
        signals_match: body.signalsMatch,
        strategy: body.strategy,
        preconditions: body.preconditions || [],
        constraints: body.constraints,
      }),
    });

    return await this.parseCloudResponse(response);
  }

  private async callCloudQueryGenes(agentId: string): Promise<unknown> {
    const url = `${this.cloudApiBase}/api/im/evolution/genes`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.cloudAuthHeaders(agentId),
    });

    return await this.parseCloudResponse(response);
  }

  private async callCloudGetPersonality(agentId: string): Promise<unknown> {
    const url = `${this.cloudApiBase}/api/im/evolution/personality/${encodeURIComponent(agentId)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.cloudAuthHeaders(agentId),
    });

    const data = await this.parseCloudResponse(response);
    return (data as { personality?: unknown }).personality ?? data;
  }

  private async callCloudDistill(agentId: string): Promise<boolean> {
    const url = `${this.cloudApiBase}/api/im/evolution/distill`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.cloudAuthHeaders(agentId),
    });

    const data = await this.parseCloudResponse(response);
    if (typeof data === 'boolean') return data;
    return Boolean((data as { triggered?: boolean }).triggered);
  }

  private async callCloudGetUnmatched(): Promise<unknown> {
    // Public endpoint — no AgentId, but Bearer still forwarded when available
    // so rate limits are tracked per-installation rather than per-IP.
    const url = `${this.cloudApiBase}/api/im/evolution/public/unmatched?limit=20`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cloudApiKey !== undefined && this.cloudApiKey.length > 0) {
      headers['Authorization'] = `Bearer ${this.cloudApiKey}`;
    }
    const response = await fetch(url, { method: 'GET', headers });

    return await this.parseCloudResponse(response);
  }

  // ============================================================
  // Local Distillation (with LLM Dispatcher)
  // ============================================================

  private async triggerLocalDistillation(agentId: string, dryRun = false): Promise<boolean> {
    if (!this.llmDispatcher) {
      throw new Error('LLM Dispatcher not available for local distillation');
    }

    console.log(`[EvolutionGateway] Triggering local distillation for agent ${agentId} (dryRun=${dryRun})`);

    if (dryRun) {
      // Just check readiness
      return await this.callCloudDistill(agentId);
    }

    // TODO: Implement full local distillation pipeline
    // 1. Fetch success capsules
    // 2. Prepare LLM prompt
    // 3. Call LLM Dispatcher
    // 4. Parse and create new genes
    console.warn('[EvolutionGateway] Local distillation not yet implemented, falling back to cloud');
    return await this.callCloudDistill(agentId);
  }

  // ============================================================
  // Local Signal Extraction (no cloud call)
  // ============================================================

  private extractSignalsLocal(req: SignalExtractionRequest): string[] {
    const signals: string[] = [];

    // Extract from tool output
    if (req.toolOutput) {
      const output = req.toolOutput.output || '';
      const error = req.toolOutput.error || '';

      // Simple regex patterns (16 patterns from signal-extract.ts)
      const patterns: Array<[RegExp, string]> = [
        [/timeout|timed out/i, 'error:timeout'],
        [/econnrefused|connection refused/i, 'error:connection_refused'],
        [/enotfound|dns/i, 'error:dns_error'],
        [/rate.?limit|429/i, 'error:rate_limit'],
        [/unauthorized|401/i, 'error:auth_error'],
        [/forbidden|403/i, 'error:forbidden'],
        [/not.?found|404/i, 'error:not_found'],
        [/500|internal server/i, 'error:server_error'],
        [/typeerror/i, 'error:type_error'],
        [/syntaxerror/i, 'error:syntax_error'],
        [/referenceerror/i, 'error:reference_error'],
        [/out of memory|oom/i, 'error:oom'],
        [/crashloopbackoff|crash.?loop/i, 'error:crash_loop'],
        [/evicted|quota/i, 'error:resource_quota'],
        [/certificate|ssl|tls/i, 'error:tls_error'],
        [/deadlock/i, 'error:deadlock'],
      ];

      const text = `${output} ${error}`;
      for (const [pattern, signalType] of patterns) {
        if (pattern.test(text)) {
          const signal = req.provider ? `${signalType}|provider=${req.provider}` : signalType;
          if (!signals.includes(signal)) {
            signals.push(signal);
          }
        }
      }

      // Exit code signal
      if (req.toolOutput.exitCode && req.toolOutput.exitCode !== 0) {
        signals.push(`exit_error|exitCode=${req.toolOutput.exitCode}`);
      }

      // Duration signal (slow operation)
      if (req.toolOutput.durationMs && req.toolOutput.durationMs > 10_000) {
        signals.push(`perf:slow_operation|duration=${req.toolOutput.durationMs}ms`);
      }
    }

    // Add custom tags
    if (req.tags) {
      for (const tag of req.tags) {
        signals.push(`tag:${tag}`);
      }
    }

    return signals;
  }
}
