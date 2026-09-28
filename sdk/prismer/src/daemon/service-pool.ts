// Caches long-running adapter services keyed by AgentProfile.id, so the daemon
// reuses the same Hermes / OpenClaw connection across tasks within the same
// profile. See docs/refactor/05-adapter-contract.md §Long-running vs Interactive.

import type { AdapterDef, AdapterService, AgentProfile } from '../adapters/contract.js';

type ServiceInvalidationDisposer = () => void | Promise<void>;

type InFlightService = {
  generation: number;
  promise: Promise<AdapterService>;
};

type ProfileServiceState = {
  generation: number;
  service?: AdapterService;
  inFlight?: InFlightService;
  invalidation?: Promise<void>;
};

/** Raised when a creator loses the generation race to drop/invalidate/shutdown. */
export class ServicePoolInvalidatedError extends Error {
  constructor(profileId: string) {
    super(`ServicePool: service creation invalidated for profile ${profileId}`);
    this.name = 'ServicePoolInvalidatedError';
  }
}

export class ServicePool {
  private readonly states = new Map<string, ProfileServiceState>();
  private readonly shutdownHandles = new WeakSet<AdapterService>();
  private closed = false;

  /**
   * Returns a service handle for the profile, lazily calling `adapter.ensureService`
   * on first use or after a crash. Creation and unhealthy replacement are
   * single-flight per profile; unrelated profiles remain fully parallel.
   */
  async ensureService(profile: AgentProfile, adapter: AdapterDef): Promise<AdapterService> {
    const createService = adapter.ensureService;
    if (adapter.kind !== 'long-running' || !createService) {
      throw new Error(`ServicePool: adapter ${adapter.name} is not long-running`);
    }
    if (this.closed) {
      throw new Error('ServicePool: pool has been shut down');
    }

    const state = this.stateFor(profile.id);
    if (state.invalidation) {
      await state.invalidation;
      return this.ensureService(profile, adapter);
    }

    if (state.inFlight) return state.inFlight.promise;

    const generation = state.generation;
    const promise = this.ensureGeneration(profile, createService, state, generation);
    const inFlight: InFlightService = { generation, promise };
    state.inFlight = inFlight;

    try {
      return await promise;
    } finally {
      // A rejection or invalidation must not poison the next ensure. Identity
      // comparison avoids an old finally deleting a newer generation's flight.
      if (state.inFlight === inFlight) {
        state.inFlight = undefined;
        this.deleteStateIfIdle(profile.id, state);
      }
    }
  }

  /**
   * Best-effort read of a cached service by profileId. Does NOT trigger
   * ensureService / health probe (use ensureService for that). Returns
   * `undefined` when the pool has never seen the profile or it crashed.
   *
   * Added for release201/25 §16.4 A6 — runner needs to reach a live
   * HermesService instance to call native `resolveApproval` without
   * paying ensureService's spawn cost (the service is already alive for
   * the in-flight task).
   */
  peek(profileId: string): AdapterService | undefined {
    return this.states.get(profileId)?.service;
  }

  /**
   * Atomically invalidate one profile's lifecycle.
   *
   * The generation fence is raised synchronously, so pending creators cannot
   * publish and later ensure calls wait behind this operation. Once every old
   * creator is quiescent, the cached handle is shut down, then `disposer` runs
   * inside the same critical section. Hermes uses the disposer to stop the
   * exact profile gateway before a new ensure is allowed to enter.
   */
  async invalidate(profileId: string, disposer?: ServiceInvalidationDisposer): Promise<void> {
    const state = this.stateFor(profileId);
    state.generation += 1;
    const previousInvalidation = state.invalidation;

    const invalidation = (async () => {
      if (previousInvalidation) {
        try {
          await previousInvalidation;
        } catch {
          // A prior disposer failure must not bypass this generation's fence.
        }
      }

      const pending = state.inFlight;
      if (pending) {
        try {
          await pending.promise;
        } catch {
          // Expected when the generation fence rejects a stale creator.
        }
      }

      const stale = state.service;
      if (stale) {
        state.service = undefined;
        await this.shutdownOnce(stale);
      }

      await disposer?.();
    })();

    state.invalidation = invalidation;
    try {
      await invalidation;
    } finally {
      if (state.invalidation === invalidation) {
        state.invalidation = undefined;
        this.deleteStateIfIdle(profileId, state);
      }
    }
  }

  /** Drop a service handle (e.g. on profile delete). */
  async drop(profileId: string): Promise<void> {
    await this.invalidate(profileId);
  }

  /** Drop all handles and fence all pending creators on graceful shutdown. */
  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(Array.from(this.states.keys(), (profileId) => this.invalidate(profileId)));
  }

  size(): number {
    let count = 0;
    for (const state of this.states.values()) {
      if (state.service) count += 1;
    }
    return count;
  }

  private stateFor(profileId: string): ProfileServiceState {
    let state = this.states.get(profileId);
    if (!state) {
      state = { generation: 0 };
      this.states.set(profileId, state);
    }
    return state;
  }

  private async ensureGeneration(
    profile: AgentProfile,
    createService: NonNullable<AdapterDef['ensureService']>,
    state: ProfileServiceState,
    generation: number,
  ): Promise<AdapterService> {
    const cached = state.service;
    if (cached) {
      let healthy = false;
      try {
        healthy = await cached.healthy();
      } catch {
        // Fall through to replacement.
      }
      this.assertCurrent(profile.id, state, generation);
      // A crash event may evict the handle while healthy() is pending. Its
      // eventual `true` result is stale evidence and must not resurrect that
      // handle for the current dispatch.
      if (healthy && state.service === cached) return cached;

      // Remove by identity before awaiting shutdown. An invalidator that starts
      // during shutdown will wait on this in-flight operation, not dispose the
      // same handle a second time.
      if (state.service === cached) {
        state.service = undefined;
        await this.shutdownOnce(cached);
        this.assertCurrent(profile.id, state, generation);
      }
    }

    const created = await createService(profile);
    if (!this.isCurrent(state, generation)) {
      await this.shutdownOnce(created);
      throw new ServicePoolInvalidatedError(profile.id);
    }

    // Generation + identity CAS: only this flight can publish into the slot.
    state.service = created;
    created.on?.('crash', () => {
      if (state.generation === generation && state.service === created) {
        state.service = undefined;
        this.deleteStateIfIdle(profile.id, state);
      }
    });
    return created;
  }

  private isCurrent(state: ProfileServiceState, generation: number): boolean {
    return !this.closed && state.generation === generation && !state.invalidation;
  }

  private assertCurrent(profileId: string, state: ProfileServiceState, generation: number): void {
    if (!this.isCurrent(state, generation)) throw new ServicePoolInvalidatedError(profileId);
  }

  private async shutdownOnce(service: AdapterService): Promise<void> {
    if (!service.shutdown || this.shutdownHandles.has(service)) return;
    this.shutdownHandles.add(service);
    try {
      await service.shutdown();
    } catch {
      // Lifecycle invalidation remains best-effort for adapter-owned handles.
    }
  }

  private deleteStateIfIdle(profileId: string, state: ProfileServiceState): void {
    if (
      this.states.get(profileId) === state &&
      !state.service &&
      !state.inFlight &&
      !state.invalidation
    ) {
      this.states.delete(profileId);
    }
  }
}
