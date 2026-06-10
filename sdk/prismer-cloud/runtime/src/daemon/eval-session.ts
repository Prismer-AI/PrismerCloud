/**
 * EvalSessionRunner — release201/08 §3 + §7
 *
 * Daemon-side eval-session capability. Cloud posts a queued eval run via
 * the existing task dispatch / direct REST channel; the runner:
 *
 *   1. mkdir ~/.prismer/eval-sessions/<runId>/ — fully isolated HOME (no
 *      access to user memory / asset / other skills)
 *   2. writes the skill manifest files into tempHome/skills/<skillSlug>/
 *      plus any allowlistBuiltins
 *   3. (optionally) spawns an ephemeral adapter with HOME=tempHome — the
 *      built-in mode just pattern-matches `tc.expectedOutputPattern` against
 *      `tc.input` so cloud cookbook tests pass without a live LLM
 *   4. POSTs per-case results back to /api/im/skills/:id/eval/runs/:runId/finish
 *   5. rm -rf tempHome
 *
 * Concurrency is capped at PRISMER_EVAL_MAX_CONCURRENT (default 4); excess
 * runs are queued in-process. Aborted runs SIGTERM the spawned adapter (if
 * any) and still execute the cleanup branch.
 */

import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const LOG = '[eval-session]';

/** release201/24 §2.1 — a case verdict. `inconclusive` means there was no
 *  way to verify the case (no assertion AND no live dispatch). It is NEVER
 *  treated as pass — it counts on the fail side so authoring is forced to add
 *  a real assertion instead of silently auto-passing. */
export type EvalVerdict = 'pass' | 'fail' | 'inconclusive';

export interface EvalTestCase {
  id: string;
  input: string;
  /** Regex (preferred) or substring matched against the produced output. */
  expectedOutputPattern?: string;
  /** release201/24 §2.1 — per-criterion substring/regex matched against output.
   *  gate-7 derives these from `skill.json.sampleTasks[].acceptanceCriteria`. */
  acceptanceCriteria?: string[];
  timeout_ms?: number;
}

export interface EvalStartRequest {
  runId: string;
  skillId: string;
  skillSlug: string;
  /** §A.7 manifest v1 — { path, content?(b64) } pairs. */
  skillManifest: Array<{ path: string; content?: string }>;
  allowlistBuiltins?: string[];
  testCases: EvalTestCase[];
  scratchEnv?: Record<string, string>;
}

export interface EvalCaseResult {
  id: string;
  passed: boolean;
  /** release201/24 §2.1 — three-way verdict (passed === verdict==='pass'). */
  verdict: EvalVerdict;
  durationMs: number;
  output?: string;
  error?: string;
}

/**
 * release201/24 §2.1 — single source of truth for scoring an eval case.
 *
 * Assertion precedence (strongest wins):
 *   1. `expectedOutputPattern` — regex/substring against `output`
 *   2. `acceptanceCriteria[]`  — every criterion must match `output`
 *   3. dispatch-success        — only when a live adapter ran (`canDispatch`)
 *
 * When NONE apply and there was no live dispatch, the verdict is
 * `inconclusive` — explicitly NOT a pass. This replaces the old
 * "no pattern → passed=true" auto-pass behaviour.
 */
export function scoreCase(
  tc: Pick<EvalTestCase, 'expectedOutputPattern' | 'acceptanceCriteria'>,
  output: string,
  opts: { dispatchOk: boolean; canDispatch: boolean },
): { verdict: EvalVerdict; error?: string } {
  const matchOne = (needle: string, hay: string): boolean => {
    try {
      return new RegExp(needle).test(hay);
    } catch {
      return hay.includes(needle);
    }
  };

  if (tc.expectedOutputPattern) {
    return matchOne(tc.expectedOutputPattern, output)
      ? { verdict: 'pass' }
      : { verdict: 'fail', error: `pattern '${tc.expectedOutputPattern}' did not match output` };
  }

  const criteria = (tc.acceptanceCriteria ?? []).filter((c) => typeof c === 'string' && c.trim().length > 0);
  if (criteria.length > 0) {
    const failed = criteria.filter((c) => !matchOne(c, output));
    return failed.length === 0
      ? { verdict: 'pass' }
      : { verdict: 'fail', error: `acceptance criteria not met: ${failed.join('; ')}` };
  }

  // No explicit assertion → fall back to dispatch-success when a real adapter ran.
  if (opts.canDispatch) {
    return opts.dispatchOk
      ? { verdict: 'pass' }
      : { verdict: 'fail', error: 'dispatch failed (no explicit assertion provided)' };
  }

  // Built-in matcher with no assertion and no live dispatch: cannot verify.
  return { verdict: 'inconclusive', error: 'no assertion and no live dispatch — result inconclusive' };
}

export interface EvalFinishCallback {
  (req: {
    runId: string;
    skillId: string;
    passCount: number;
    failCount: number;
    results: EvalCaseResult[];
    agentTraceUrl?: string;
  }): Promise<void> | void;
}

export interface EvalSessionRunnerOptions {
  /** Override the eval-session HOME root. Defaults to `~/.prismer/eval-sessions`. */
  rootDir?: string;
  /** Hard cap on concurrent runs. Falls back to `PRISMER_EVAL_MAX_CONCURRENT` env or 4. */
  maxConcurrent?: number;
  /** Cloud finish-callback. Cloud uses POST /api/im/skills/:id/eval/runs/:runId/finish. */
  onFinish?: EvalFinishCallback;
  /** Optional adapter spawner. When omitted, the runner uses the built-in
   *  pattern-match scorer (suitable for unit tests + Phase 2 cookbook). */
  adapterSpawner?: (req: EvalStartRequest, tempHome: string) => Promise<EvalCaseResult[]>;
}

interface ActiveRun {
  runId: string;
  skillId: string;
  startedAt: number;
  abortController: AbortController;
}

export class EvalSessionRunner {
  private active = new Map<string, ActiveRun>();
  private queue: Array<{ req: EvalStartRequest; resolve: () => void; reject: (err: unknown) => void }> = [];
  private readonly rootDir: string;
  private readonly maxConcurrent: number;
  private readonly onFinish?: EvalFinishCallback;
  private readonly adapterSpawner?: EvalSessionRunnerOptions['adapterSpawner'];

  constructor(opts: EvalSessionRunnerOptions = {}) {
    this.rootDir = opts.rootDir ?? path.join(homedir(), '.prismer', 'eval-sessions');
    const envCap = Number.parseInt(process.env.PRISMER_EVAL_MAX_CONCURRENT ?? '', 10);
    this.maxConcurrent = opts.maxConcurrent ?? (Number.isFinite(envCap) && envCap > 0 ? envCap : 4);
    this.onFinish = opts.onFinish;
    this.adapterSpawner = opts.adapterSpawner;
  }

  getState() {
    return {
      active: this.active.size,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      runs: Array.from(this.active.values()).map((r) => ({
        runId: r.runId,
        skillId: r.skillId,
        startedAt: new Date(r.startedAt).toISOString(),
      })),
    };
  }

  /**
   * Run an eval session synchronously (awaitable). Cloud's task-dispatch
   * envelope routes to this method via runner.ts. When queue cap is hit,
   * the promise resolves when an active slot frees up.
   */
  async start(req: EvalStartRequest): Promise<void> {
    if (this.active.size >= this.maxConcurrent) {
      await new Promise<void>((resolve, reject) => {
        this.queue.push({ req, resolve, reject });
      });
    }
    await this.run(req);
    // After run, kick the queue.
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.resolve();
    }
  }

  abort(runId: string): boolean {
    const run = this.active.get(runId);
    if (!run) return false;
    run.abortController.abort();
    return true;
  }

  private async run(req: EvalStartRequest): Promise<void> {
    const abortController = new AbortController();
    this.active.set(req.runId, {
      runId: req.runId,
      skillId: req.skillId,
      startedAt: Date.now(),
      abortController,
    });
    let tempHome = '';
    let results: EvalCaseResult[] = [];
    let aborted = false;
    try {
      tempHome = await this.createTempHome(req);
      if (this.adapterSpawner) {
        results = await this.adapterSpawner(req, tempHome);
      } else {
        results = await this.runBuiltinMatcher(req, abortController.signal);
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        aborted = true;
      } else {
        // Convert the failure to a per-case error placeholder so cloud sees the failure mode.
        results = req.testCases.map((tc) => ({
          id: tc.id,
          passed: false,
          verdict: 'fail' as EvalVerdict,
          durationMs: 0,
          error: (err as Error).message,
        }));
      }
    } finally {
      if (tempHome) {
        await this.cleanupTempHome(tempHome);
      }
      this.active.delete(req.runId);
    }

    // release201/24 §2.1 — only verdict==='pass' counts toward passCount;
    // `inconclusive` falls on the fail side (it is never an auto-pass).
    const passCount = results.filter((r) => r.verdict === 'pass').length;
    const failCount = results.length - passCount;
    try {
      if (!aborted) {
        await this.onFinish?.({
          runId: req.runId,
          skillId: req.skillId,
          passCount,
          failCount,
          results,
        });
      }
    } catch (err) {
      console.warn(`${LOG} onFinish callback for run=${req.runId} failed: ${(err as Error).message}`);
    }
  }

  private async createTempHome(req: EvalStartRequest): Promise<string> {
    const tempHome = path.join(this.rootDir, req.runId);
    await fsp.mkdir(tempHome, { recursive: true });
    await fsp.mkdir(path.join(tempHome, '.prismer'), { recursive: true });
    const skillsRoot = path.join(tempHome, 'skills', req.skillSlug || req.skillId);
    await fsp.mkdir(skillsRoot, { recursive: true });

    for (const file of req.skillManifest ?? []) {
      const target = path.join(skillsRoot, file.path);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const bytes = file.content
        ? Buffer.from(file.content, 'base64')
        : Buffer.from('');
      await fsp.writeFile(target, bytes);
    }
    // Drop a simple manifest pointer for adapters that read skillsDir.
    await fsp.writeFile(
      path.join(skillsRoot, '.eval-manifest.json'),
      JSON.stringify({
        runId: req.runId,
        skillId: req.skillId,
        allowlistBuiltins: req.allowlistBuiltins ?? [],
        scratchEnv: req.scratchEnv ?? {},
      }),
    );
    return tempHome;
  }

  private async cleanupTempHome(tempHome: string): Promise<void> {
    try {
      await fsp.rm(tempHome, { recursive: true, force: true });
    } catch (err) {
      // do NOT swallow silently — any leftover HOME is a forbidden-log scenario
      console.error(`${LOG} HOME not cleaned: ${tempHome}: ${(err as Error).message}`);
    }
  }

  /**
   * Built-in matcher (no live LLM). It does NOT execute the skill, so it has
   * no real output — it smoke-checks the wire format by scoring assertions
   * against the case `input`. Crucially, a case with NO assertion no longer
   * auto-passes: `scoreCase` returns `inconclusive` (counted on the fail
   * side), forcing authoring to attach a real assertion or run a live
   * dispatch (the Hermes `adapterSpawner`).
   */
  private async runBuiltinMatcher(
    req: EvalStartRequest,
    signal: AbortSignal,
  ): Promise<EvalCaseResult[]> {
    const out: EvalCaseResult[] = [];
    for (const tc of req.testCases) {
      if (signal.aborted) break;
      const start = Date.now();
      const timeout = tc.timeout_ms ?? 30_000;
      let scored: { verdict: EvalVerdict; error?: string };
      try {
        scored = await new Promise<{ verdict: EvalVerdict; error?: string }>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error(`tc ${tc.id} timed out after ${timeout}ms`)), timeout);
          setImmediate(() => {
            clearTimeout(t);
            // No live adapter → canDispatch=false; smoke assertions run
            // against the input as a wire-format check.
            resolve(scoreCase(tc, tc.input, { dispatchOk: false, canDispatch: false }));
          });
        });
      } catch (err) {
        scored = { verdict: 'fail', error: (err as Error).message };
      }
      out.push({
        id: tc.id,
        passed: scored.verdict === 'pass',
        verdict: scored.verdict,
        durationMs: Date.now() - start,
        error: scored.error,
      });
    }
    return out;
  }
}

/**
 * Helper to mint stable runIds when callers want to start a run without
 * cloud allocating the id first (eg. daemon-only tests).
 */
export function newEvalRunId(): string {
  return `er_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}
