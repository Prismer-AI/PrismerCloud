/**
 * Prismer Runtime — Dispatch Mux (Sprint A3, D4).
 *
 * Picks an adapter for an incoming task and forwards the dispatch call.
 * Selection policy (in priority order):
 *
 *   1. `preferAdapter` (caller-supplied) wins if registered AND the
 *      adapter can satisfy the requested capability.
 *   2. If exactly one adapter matches the capability, use it.
 *   3. If multiple match, pick deterministically — adapters sorted by
 *      `name` (so the same task always lands on the same adapter when
 *      multiple are eligible). Future: load/latency-aware ranking.
 *   4. None matches → return a structured "no_adapter" failure rather
 *      than throw — the caller (cloud) decides whether to reroute.
 *
 * The mux never throws on adapter errors; it always returns a result
 * with `ok=false` so the cloud-side TaskRouter can report `step_failed`
 * instead of seeing a daemon-side stack trace.
 */

import type { AdapterDispatchInput, AdapterDispatchResult, AdapterRegistry } from './adapter-registry.js';

export interface DispatchMuxRequest extends AdapterDispatchInput {
  /** If set and registered, win selection. */
  preferAdapter?: string;
}

export interface DispatchMuxResult extends AdapterDispatchResult {
  /** Which adapter handled this request. Useful for telemetry +
   *  debugging when the answer "feels wrong". */
  adapter?: string;
}

export class DispatchMux {
  constructor(private readonly registry: AdapterRegistry) {}

  /**
   * Resolve the adapter that would handle a given request without
   * actually dispatching. Returned undefined means "no adapter matches".
   * Useful for cloud-side capability probing.
   */
  resolve(req: { capability: string; preferAdapter?: string }): { adapter: string } | undefined {
    if (req.preferAdapter) {
      const preferred = this.registry.get(req.preferAdapter);
      if (preferred && preferred.capabilityTags.some((tag) => matches(tag, req.capability))) {
        return { adapter: preferred.name };
      }
    }
    const candidates = this.registry.findByCapability(req.capability);
    if (candidates.length === 0) return undefined;
    // findByCapability already returns name-sorted output, so [0] is deterministic.
    return { adapter: candidates[0].name };
  }

  async dispatch(req: DispatchMuxRequest): Promise<DispatchMuxResult> {
    if (!req.capability || typeof req.capability !== 'string') {
      return { ok: false, error: 'capability required' };
    }

    let chosen = req.preferAdapter ? this.registry.get(req.preferAdapter) : undefined;
    if (chosen && !chosen.capabilityTags.some((tag) => matches(tag, req.capability))) {
      // Preferred adapter exists but cannot satisfy capability — fall through.
      chosen = undefined;
    }
    if (!chosen) {
      const matchesList = this.registry.findByCapability(req.capability);
      chosen = matchesList[0];
    }
    if (!chosen) {
      return {
        ok: false,
        error: `no_adapter_for_capability:${req.capability}`,
      };
    }

    try {
      const result = await chosen.dispatch({
        taskId: req.taskId,
        stepIdx: req.stepIdx,
        capability: req.capability,
        prompt: req.prompt,
        metadata: req.metadata,
        deadlineAt: req.deadlineAt,
      });
      return { ...result, adapter: chosen.name };
    } catch (err) {
      // Adapter implementations should not throw, but defend against
      // misbehaving plug-ins so the daemon doesn't crash.
      return {
        ok: false,
        error: `adapter_threw:${(err as Error).message}`,
        adapter: chosen.name,
      };
    }
  }
}

/** Tag matches capability (literal or wildcard prefix `xxx.*`). */
function matches(tag: string, capability: string): boolean {
  if (tag === capability) return true;
  if (tag.endsWith('.*') && capability.startsWith(tag.slice(0, -1))) return true;
  return false;
}
