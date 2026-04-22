/**
 * Prismer Runtime — Adapter Registry (Sprint A3, D4 dispatch mux).
 *
 * One process-wide registry maps adapter `name` → `AdapterImpl`. The
 * registry is the data store; selection policy lives in DispatchMux
 * (dispatch-mux.ts) so the same registry can drive multiple selectors
 * (capability-based, name-based, weighted load, etc.) without coupling.
 *
 * An adapter advertises:
 *   - `name`            : stable identifier (matches catalog name).
 *   - `tiersSupported`  : PARA Tier numbers it can host (e.g. [1..7]).
 *   - `capabilityTags`  : tags from the task's `requiresCapability`
 *                         vocabulary that this adapter can satisfy.
 *
 * On register conflict, replace — adapter modules are expected to be
 * the only source of truth for their own descriptor.
 *
 * Adapters typically run as out-of-process workers (Claude Code CLI,
 * OpenClaw daemon plug-in, Hermes Python). The `dispatch` boundary
 * here is the *runtime side* of that bridge — it returns a Promise
 * whose resolution corresponds to the adapter's reported completion.
 */

export interface AdapterDescriptor {
  /** Stable identifier — must match the catalog entry. */
  name: string;
  /** PARA Tier numbers (L1–L10). */
  tiersSupported: number[];
  /** Capability tag vocabulary (e.g. ["code.write", "code.review"]). */
  capabilityTags: string[];
  /** Free-form for telemetry — version, build, etc. */
  metadata?: Record<string, unknown>;
}

export interface AdapterDispatchInput {
  /** Cloud task ID (im_tasks.id). */
  taskId: string;
  /** Step index when the task is multi-step (route step). */
  stepIdx?: number;
  /** Capability the cloud asked for — drives adapter selection. */
  capability: string;
  /** User-facing prompt / instruction. */
  prompt: string;
  /** Free-form metadata passed through to the adapter. */
  metadata?: Record<string, unknown>;
  /** Optional deadline (ms epoch). Adapters should respect it best-effort. */
  deadlineAt?: number;
}

export interface AdapterDispatchResult {
  ok: boolean;
  /** Output text (stdout, summary, etc.). */
  output?: string;
  /** Files produced by the adapter (paths are relative to the agent
   *  workspace; cloud uploads them via the artifact stream). */
  artifacts?: Array<{ path: string; bytes: number; mime?: string }>;
  /** Failure reason — must be set when ok=false. */
  error?: string;
  /** Free-form telemetry — token counts, latency, model, etc. */
  metadata?: Record<string, unknown>;
}

export interface AdapterImpl extends AdapterDescriptor {
  /** Dispatch a task step to this adapter. Should not throw — errors
   *  belong in the result. */
  dispatch(input: AdapterDispatchInput): Promise<AdapterDispatchResult>;
  /** Optional: per-adapter health probe. Defaults to "healthy". */
  health?(): Promise<{ healthy: boolean; reason?: string }>;
  /**
   * Reset adapter state for a specific agent (or all agents if undefined).
   *
   * v1.9.x remote-command `agent_restart` semantic: abort/clear whatever
   * per-agent context the adapter holds. For stateless adapters (CLI shim),
   * this is a no-op; for Mode B adapters, it's typically a POST /reset to
   * the loopback so the adapter host clears its own session state.
   *
   * NOT a process restart — the adapter is not expected to own a PID.
   *
   * @param agentName  Optional agent name to scope the reset. Undefined = reset all.
   * @returns Arbitrary result; ok:true for success, ok:false+reason otherwise.
   */
  reset?(agentName?: string): Promise<{ ok: boolean; state?: string; reason?: string; [k: string]: unknown }>;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, AdapterImpl>();

  register(adapter: AdapterImpl): void {
    if (!adapter.name || typeof adapter.name !== 'string') {
      throw new Error('AdapterRegistry.register: adapter.name required');
    }
    if (typeof adapter.dispatch !== 'function') {
      throw new Error(`AdapterRegistry.register: adapter "${adapter.name}" missing dispatch()`);
    }
    this.adapters.set(adapter.name, adapter);
  }

  unregister(name: string): boolean {
    return this.adapters.delete(name);
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  get(name: string): AdapterImpl | undefined {
    return this.adapters.get(name);
  }

  list(): AdapterDescriptor[] {
    // Return only descriptor fields — callers shouldn't be poking at dispatch
    // implementations through the registry.
    return Array.from(this.adapters.values()).map(({ dispatch: _dispatch, health: _health, ...descriptor }) => descriptor);
  }

  size(): number {
    return this.adapters.size;
  }

  /**
   * Find adapters that can satisfy the given capability tag.
   *
   * An adapter matches if `capabilityTags` includes the tag verbatim or
   * if the adapter declared a wildcard prefix match (e.g. `code.*` matches
   * `code.write`). Returns deterministic ordering — adapters are sorted by
   * name so callers see the same result for the same registry state.
   */
  findByCapability(capability: string): AdapterImpl[] {
    const matches: AdapterImpl[] = [];
    for (const adapter of this.adapters.values()) {
      if (adapter.capabilityTags.includes(capability)) {
        matches.push(adapter);
        continue;
      }
      // Wildcard match: tag ends with ".*" — e.g. "code.*" matches "code.review".
      if (
        adapter.capabilityTags.some(
          (tag) => tag.endsWith('.*') && capability.startsWith(tag.slice(0, -1)),
        )
      ) {
        matches.push(adapter);
      }
    }
    matches.sort((a, b) => a.name.localeCompare(b.name));
    return matches;
  }

  /**
   * Find adapters that can host a given PARA tier.
   */
  findByTier(tier: number): AdapterImpl[] {
    const matches: AdapterImpl[] = [];
    for (const adapter of this.adapters.values()) {
      if (adapter.tiersSupported.includes(tier)) matches.push(adapter);
    }
    matches.sort((a, b) => a.name.localeCompare(b.name));
    return matches;
  }
}
