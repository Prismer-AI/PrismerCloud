/**
 * Prismer Evolution Harness for OpenCode / Codex
 *
 * Wraps any task execution with pre-flight analysis and post-flight reporting
 * to the Prismer Evolution network. Enables cross-agent learning: strategies
 * discovered by one agent become recommendations for all future agents.
 *
 * @example
 * ```ts
 * import { executeWithEvolution, createEvolutionHarness } from './evolution-harness';
 *
 * // One-shot usage
 * const result = await executeWithEvolution('Fix the login timeout', {
 *   provider: 'opencode',
 *   execute: async (advice) => {
 *     // Your task logic here — advice.strategies available if a gene matched
 *     return { output: 'Fixed by increasing pool size', exitCode: 0 };
 *   },
 * });
 *
 * // Reusable harness
 * const harness = createEvolutionHarness({
 *   apiKey: process.env.PRISMER_API_KEY!,
 *   baseUrl: 'https://prismer.cloud',
 *   provider: 'opencode',
 * });
 * const result2 = await harness.run('Refactor auth module', async (advice) => {
 *   // ...
 *   return { output: 'Done', exitCode: 0 };
 * });
 * ```
 */

import { exec as execCb } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(execCb);

// ── Types ─────────────────────────────────────────────────────────────

export interface EvolutionConfig {
  /** Prismer API key (sk-prismer-...) */
  apiKey: string;
  /** Base URL, defaults to https://prismer.cloud */
  baseUrl?: string;
  /** Provider identifier, defaults to 'opencode' */
  provider?: string;
  /** Request timeout in ms, defaults to 10000 */
  timeout?: number;
  /** Set to true to disable all evolution calls (dry run) */
  disabled?: boolean;
}

export interface AnalyzeAdvice {
  geneId: string | null;
  geneTitle: string | null;
  confidence: number;
  strategies: string[];
  raw: Record<string, unknown>;
}

export interface TaskResult {
  output: string;
  exitCode: number;
}

export interface ExecuteOptions {
  /** Provider name for evolution tracking */
  provider?: string;
  /** Stage name for evolution tracking */
  stage?: string;
  /** The function that performs the actual work */
  execute: (advice: AnalyzeAdvice) => Promise<TaskResult>;
}

export interface EvolutionOutcome {
  task: string;
  result: TaskResult;
  advice: AnalyzeAdvice;
  reportedToEvolution: boolean;
}

// ── Internal helpers ──────────────────────────────────────────────────

const NO_ADVICE: AnalyzeAdvice = {
  geneId: null,
  geneTitle: null,
  confidence: 0,
  strategies: [],
  raw: {},
};

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Core Evolution Client ─────────────────────────────────────────────

class EvolutionClient {
  private baseUrl: string;
  private apiKey: string;
  private provider: string;
  private timeout: number;
  private disabled: boolean;

  constructor(config: EvolutionConfig) {
    this.baseUrl = (config.baseUrl || 'https://prismer.cloud').replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.provider = config.provider || 'opencode';
    this.timeout = config.timeout || 10_000;
    this.disabled = config.disabled || false;
  }

  private async post(endpoint: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.disabled) return {};
    try {
      const resp = await fetchWithTimeout(
        `${this.baseUrl}/api/im/evolution/${endpoint}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        },
        this.timeout,
      );
      return (await resp.json()) as Record<string, unknown>;
    } catch {
      // Evolution calls are best-effort — never block the main task
      return {};
    }
  }

  async analyze(task: string, stage: string): Promise<AnalyzeAdvice> {
    const result = await this.post('analyze', {
      error: task,
      task_status: 'pending',
      provider: this.provider,
      stage,
    });

    const data = (result as any)?.data;
    if (!data?.gene) return NO_ADVICE;

    return {
      geneId: data.gene_id || null,
      geneTitle: data.gene?.title || null,
      confidence: data.confidence || 0,
      strategies: data.strategy || [],
      raw: data,
    };
  }

  async report(
    task: string,
    output: string,
    outcome: 'success' | 'failed',
    stage: string,
    severity?: string,
  ): Promise<void> {
    await this.post('report', {
      raw_context: output.slice(-4000),
      outcome,
      task,
      provider: this.provider,
      stage,
      ...(severity ? { severity } : {}),
      ...(outcome === 'success' ? { score: 0.9 } : {}),
    });
  }

  async record(
    geneId: string,
    outcome: 'success' | 'failed',
    stage: string,
    summary: string,
  ): Promise<void> {
    await this.post('record', {
      gene_id: geneId,
      signals: [
        {
          type: `codex_exec_${outcome}`,
          provider: this.provider,
          stage,
        },
      ],
      outcome,
      score: outcome === 'success' ? 0.9 : 0.1,
      summary,
    });
  }
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Execute a task with evolution hooks (analyze before, report after).
 *
 * If PRISMER_API_KEY is not set and no apiKey is provided, evolution
 * hooks are silently skipped — the task still executes normally.
 */
export async function executeWithEvolution(
  task: string,
  options: ExecuteOptions & Partial<EvolutionConfig>,
): Promise<EvolutionOutcome> {
  const apiKey = options.apiKey || process.env.PRISMER_API_KEY || '';
  const stage = options.stage || 'codex-exec';
  const disabled = options.disabled || !apiKey;

  const client = new EvolutionClient({
    apiKey,
    baseUrl: options.baseUrl || process.env.PRISMER_BASE_URL,
    provider: options.provider || 'opencode',
    timeout: options.timeout,
    disabled,
  });

  // 1. Pre-flight: analyze
  const advice = await client.analyze(task, stage);

  if (advice.geneTitle) {
    console.log(`[Evolution] Gene: ${advice.geneTitle} (confidence: ${advice.confidence})`);
    advice.strategies.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  }

  // 2. Execute
  let result: TaskResult;
  try {
    result = await options.execute(advice);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    result = { output: errMsg, exitCode: 1 };
  }

  // 3. Post-flight: report
  const outcome = result.exitCode === 0 ? 'success' : 'failed';
  await client.report(
    task,
    result.output,
    outcome,
    stage,
    outcome === 'failed' ? 'high' : undefined,
  );

  // 4. Record against matched gene if any
  if (advice.geneId) {
    await client.record(
      advice.geneId,
      outcome,
      stage,
      `${task} → ${outcome} (exit ${result.exitCode})`,
    );
  }

  return {
    task,
    result,
    advice,
    reportedToEvolution: !disabled,
  };
}

/**
 * Create a reusable harness instance with fixed configuration.
 */
export function createEvolutionHarness(config: EvolutionConfig) {
  return {
    /**
     * Run a task through the evolution harness.
     */
    async run(
      task: string,
      execute: (advice: AnalyzeAdvice) => Promise<TaskResult>,
      options?: { stage?: string },
    ): Promise<EvolutionOutcome> {
      return executeWithEvolution(task, {
        ...config,
        stage: options?.stage,
        execute,
      });
    },
  };
}

/**
 * Convenience: run a shell command through evolution harness.
 */
export async function execCommandWithEvolution(
  task: string,
  command: string,
  config?: Partial<EvolutionConfig>,
): Promise<EvolutionOutcome> {
  return executeWithEvolution(task, {
    ...config,
    execute: async () => {
      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { output: stdout + stderr, exitCode: 0 };
      } catch (err: any) {
        return {
          output: (err.stdout || '') + (err.stderr || '') + (err.message || ''),
          exitCode: err.code ?? 1,
        };
      }
    },
  });
}
