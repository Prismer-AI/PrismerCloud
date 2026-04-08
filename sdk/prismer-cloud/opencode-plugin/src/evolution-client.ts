/**
 * Lightweight HTTP client for Prismer Evolution API.
 * All calls are best-effort (never throw, never block the caller).
 */

export interface EvolutionClientConfig {
  /** Prismer API key (sk-prismer-...) */
  apiKey: string;
  /** Base URL, defaults to https://prismer.cloud */
  baseUrl?: string;
  /** Provider identifier, defaults to 'opencode' */
  provider?: string;
  /** Request timeout in ms, defaults to 10000 */
  timeout?: number;
  /** Default evolution scope, defaults to 'global' */
  scope?: string;
}

export interface AnalyzeResult {
  geneId: string | null;
  geneTitle: string | null;
  confidence: number;
  strategies: string[];
}

export interface ReportParams {
  rawContext: string;
  outcome: 'success' | 'failed';
  task: string;
  stage: string;
  severity?: string;
  score?: number;
  scope?: string;
}

export interface SyncOutcome {
  gene_id: string;
  signals: string[];
  outcome: 'success' | 'failed';
  summary: string;
}

export interface SyncResult {
  pushed: { accepted: number; rejected: string[] };
  pulled: { genes: unknown[]; edges: unknown[]; cursor: number };
}

const NO_RESULT: AnalyzeResult = {
  geneId: null,
  geneTitle: null,
  confidence: 0,
  strategies: [],
};

export class EvolutionClient {
  private baseUrl: string;
  private apiKey: string;
  private provider: string;
  private timeout: number;
  private scope: string;

  constructor(config: EvolutionClientConfig) {
    this.baseUrl = (config.baseUrl || 'https://prismer.cloud').replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.provider = config.provider || 'opencode';
    this.timeout = config.timeout || 10_000;
    this.scope = config.scope || 'global';
  }

  private async request(
    method: string,
    endpoint: string,
    body?: Record<string, unknown>,
    queryParams?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      const url = new URL(`${this.baseUrl}/api/im/evolution/${endpoint}`);
      if (queryParams) {
        for (const [k, v] of Object.entries(queryParams)) {
          if (v) url.searchParams.set(k, v);
        }
      }
      const resp = await fetch(url.toString(), {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      clearTimeout(timer);
      return (await resp.json()) as Record<string, unknown>;
    } catch {
      // Evolution calls are best-effort — never block the main task
      return {};
    }
  }

  private async post(endpoint: string, body: Record<string, unknown>, query?: Record<string, string>): Promise<Record<string, unknown>> {
    return this.request('POST', endpoint, body, query);
  }

  private async get(endpoint: string, query?: Record<string, string>): Promise<Record<string, unknown>> {
    return this.request('GET', endpoint, undefined, query);
  }

  async analyze(signals: string[], stage: string, scope?: string): Promise<AnalyzeResult> {
    const result = await this.post('analyze', {
      signals: signals.map(s => typeof s === 'string' ? { type: s } : s),
      task_status: 'pending',
      provider: this.provider,
      stage,
    }, { scope: scope || this.scope });

    const data = (result as any)?.data;
    if (!data?.gene) return NO_RESULT;

    return {
      geneId: data.gene_id || null,
      geneTitle: data.gene?.title || null,
      confidence: data.confidence || 0,
      strategies: data.gene?.strategy || [],
    };
  }

  async report(params: ReportParams): Promise<void> {
    await this.post('report', {
      raw_context: params.rawContext,
      outcome: params.outcome,
      task: params.task,
      provider: this.provider,
      stage: params.stage,
      ...(params.severity ? { severity: params.severity } : {}),
      ...(params.score != null ? { score: params.score } : {}),
    }, { scope: params.scope || this.scope });
  }

  async record(
    geneId: string,
    outcome: 'success' | 'failed',
    summary: string,
    scope?: string,
  ): Promise<void> {
    await this.post('record', {
      gene_id: geneId,
      outcome,
      score: outcome === 'success' ? 0.9 : 0.1,
      summary,
      signals: [{ type: `exec_${outcome}`, provider: this.provider }],
    }, { scope: scope || this.scope });
  }

  async achievements(): Promise<Record<string, unknown>[]> {
    const result = await this.get('achievements');
    const data = (result as any)?.data;
    return Array.isArray(data) ? data : [];
  }

  async memoryWrite(path: string, content: string, scope?: string): Promise<void> {
    await this.request('POST', '../memory/files', {
      path,
      content,
      scope: scope || this.scope,
    });
  }

  async getWorkspace(scope?: string, slots?: string[]): Promise<Record<string, unknown> | null> {
    const s = scope || this.scope;
    const params = new URLSearchParams({ scope: s });
    if (slots?.length) params.set('slots', slots.join(','));
    try {
      const res = await fetch(`${this.baseUrl}/api/im/workspace?${params}`, {
        headers: { Authorization: `Bearer ${this.apiKey}`, 'X-Prismer-Provider': this.provider },
        signal: AbortSignal.timeout(this.timeout),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.data || null;
    } catch {
      return null;
    }
  }

  async sync(outcomes?: SyncOutcome[], pullSince?: number, scope?: string): Promise<SyncResult | null> {
    const body: Record<string, unknown> = {};
    if (outcomes && outcomes.length > 0) {
      body.push = { outcomes };
    }
    body.pull = {
      since: pullSince || 0,
      scope: scope || this.scope,
    };

    const result = await this.post('sync', body, { scope: scope || this.scope });
    const data = (result as any)?.data;
    if (!data) return null;
    return data as SyncResult;
  }
}
