/**
 * Hermes eval spawner — release201/24 §3 (维 4).
 *
 * Produces an `adapterSpawner` for {@link EvalSessionRunner} that runs each
 * eval test case through a REAL Hermes dispatch in the isolated eval HOME.
 *
 * Isolation: the eval skill manifest has already been written by
 * `EvalSessionRunner.createTempHome` into `<tempHome>/skills/<slug>/`. We
 * derive an eval-scoped profile (distinct `id` so the ServicePool does NOT
 * clobber the real agent's cached gateway) whose `skillsDir` points at the
 * isolated `<tempHome>/skills` — so the spawned Hermes only sees the skill
 * under test plus the allowlisted built-ins.
 *
 * Honesty contract (release201/24 §2.1): this NEVER auto-passes. If a live
 * Hermes service cannot be obtained (binary missing, no provider, etc.) the
 * spawner returns `inconclusive` results — the run is recorded as not-passed
 * rather than silently green.
 */

import * as path from 'node:path';
import type { AdapterDef, AdapterService, AgentProfile } from '../adapters/contract.js';
import {
  scoreCase,
  type EvalCaseResult,
  type EvalStartRequest,
  type EvalVerdict,
} from './eval-session.js';

const LOG = '[eval-hermes]';

export interface HermesEvalSpawnerDeps {
  /** Resolve the Hermes adapter definition (registry.get('hermes')). */
  getHermesAdapter: () => AdapterDef | undefined;
  /** Find a base Hermes AgentProfile to clone for the eval session. */
  findHermesProfile: () => AgentProfile | undefined;
  /** ensureService — typically `servicePool.ensureService`. */
  ensureService: (profile: AgentProfile, adapter: AdapterDef) => Promise<AdapterService>;
}

export type EvalAdapterSpawner = (
  req: EvalStartRequest,
  tempHome: string,
) => Promise<EvalCaseResult[]>;

/** Build per-case `inconclusive` results with a shared reason. */
function inconclusiveAll(req: EvalStartRequest, reason: string): EvalCaseResult[] {
  return req.testCases.map((tc) => ({
    id: tc.id,
    passed: false,
    verdict: 'inconclusive' as EvalVerdict,
    durationMs: 0,
    error: `${reason}`,
  }));
}

export function createHermesEvalSpawner(deps: HermesEvalSpawnerDeps): EvalAdapterSpawner {
  return async (req: EvalStartRequest, tempHome: string): Promise<EvalCaseResult[]> => {
    const adapter = deps.getHermesAdapter();
    const base = deps.findHermesProfile();
    if (!adapter || typeof adapter.ensureService !== 'function') {
      console.warn(`${LOG} no hermes adapter available — eval inconclusive run=${req.runId}`);
      return inconclusiveAll(req, 'no live hermes adapter — result inconclusive (release201/24 §2.1)');
    }
    if (!base) {
      console.warn(`${LOG} no hermes profile to clone — eval inconclusive run=${req.runId}`);
      return inconclusiveAll(req, 'no hermes profile available — result inconclusive');
    }

    // Eval-scoped profile: distinct id (so ServicePool spins a separate
    // gateway and never clobbers the real agent's cached service) +
    // skillsDir pinned to the isolated eval HOME.
    const skillsDir = path.join(tempHome, 'skills');
    // release201/24 §Phase2 — UNIQUE per-run profile name. A per-slug name gets
    // reused across runs, but each run's skill lives under a runId-specific
    // tempHome (cleaned afterwards), so a reused gateway holds a stale
    // skills.external_dirs path in memory and finds no skill. Keying the
    // profile on runId guarantees a fresh gateway + fresh config with exactly
    // this run's external_dir, and no cross-run accumulation.
    const evalProfileName = `eval-${req.runId}`;
    const evalProfile: AgentProfile = {
      ...base,
      id: `eval__${req.runId}`,
      name: evalProfileName,
      config: {
        ...(base.config as Record<string, unknown>),
        skillsDir,
        // release201/24 §Phase2 (F1/F2/F3) — make the skill-under-test a REAL
        // Hermes skill the agent can list + invoke:
        //   • skillsExternalDirs → registered into the eval gateway's
        //     config.yaml `skills.external_dirs`, so `skills_list` + skill
        //     tools surface the skill written to tempHome/skills/<slug>/
        //     (incl. its scripts → F2). The daemon's system-prompt injection
        //     alone never reaches the agent's skill tools.
        //   • distinct hermesProfileName → distinct port + throwaway profile
        //     dir; never reuse the real agent's cached gateway / identity.
        //   • skip the MCP server install — eval doesn't need workspace tools
        //     and it only adds startup latency + side effects.
        // NOTE: the ~90 bundled skills ship with the hermes package and cannot
        // be removed via env, so this is skill-DISCOVERY, not full isolation;
        // the eval prompt names the skill so the agent invokes the right one.
        skillsExternalDirs: [skillsDir],
        hermesProfileName: evalProfileName,
        installPrismerMcpServer: false,
        // release201/24 §Phase2 — memory hooks stay ON: disabling them entirely
        // breaks the Hermes session (empty output / no stream). Memory
        // isolation for eval needs a SCOPED-memory approach (scratch scope per
        // eval-<runId>), not hook removal — tracked as a follow-up. The unique
        // per-run profile already avoids most cross-run contamination.
        installMemoryHooks: true,
        autoStart: true,
        // Eval session is throwaway; do not auto-start a persistent gateway
        // beyond what ensureService needs.
        ...(req.scratchEnv ? { evalScratchEnv: req.scratchEnv } : {}),
      },
    };

    let service: AdapterService;
    try {
      service = await deps.ensureService(evalProfile, adapter);
    } catch (err) {
      console.warn(`${LOG} ensureService failed run=${req.runId}: ${(err as Error).message}`);
      return inconclusiveAll(req, `hermes ensureService failed: ${(err as Error).message}`);
    }

    const results: EvalCaseResult[] = [];
    for (const tc of req.testCases) {
      const start = Date.now();
      try {
        const res = await service.dispatch({
          taskId: `${req.runId}:${tc.id}`,
          prompt: tc.input,
          timeoutMs: tc.timeout_ms ?? 30_000,
          // release201/26 §16.4 A3 removed the legacy /v1/runs fallback, so the
          // hermes sessions path now REQUIRES conversationId + agentImUserId in
          // metadata — without them dispatchViaSessions throws "falling back"
          // to a removed endpoint and returns empty (the eval's LLM call never
          // fires). A synthetic per-run conversationId gives each eval test
          // case a fresh, isolated hermes session (aligns with §14.9 eval
          // scratch scope). (release201/24 Phase 2 eval-env / release201/26.)
          metadata: {
            conversationId: `eval-${req.runId}-${tc.id}`,
            agentImUserId: base.agentImUserId,
            workspaceId: base.workspaceId,
          },
        });
        const output = res.output ?? '';
        const scored = scoreCase(tc, output, { dispatchOk: res.ok === true, canDispatch: true });
        results.push({
          id: tc.id,
          passed: scored.verdict === 'pass',
          verdict: scored.verdict,
          durationMs: Date.now() - start,
          output: output.slice(0, 4000),
          error: scored.error ?? (res.ok ? undefined : res.error?.message),
        });
      } catch (err) {
        // A dispatch throw is a real failure (not inconclusive) — the skill
        // could not be exercised at all.
        results.push({
          id: tc.id,
          passed: false,
          verdict: 'fail',
          durationMs: Date.now() - start,
          error: `dispatch threw: ${(err as Error).message}`,
        });
      }
    }

    // Best-effort: stop the throwaway eval gateway so it does not linger.
    try {
      await service.shutdown?.();
    } catch {
      /* shutdown is best-effort */
    }
    return results;
  };
}
