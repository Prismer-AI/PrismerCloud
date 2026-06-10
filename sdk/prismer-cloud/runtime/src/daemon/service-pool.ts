// Caches long-running adapter services keyed by AgentProfile.id, so the daemon
// reuses the same Hermes / OpenClaw connection across tasks within the same
// profile. See docs/refactor/05-adapter-contract.md §Long-running vs Interactive.

import type { AdapterDef, AdapterService, AgentProfile } from '../adapters/contract.js';

export class ServicePool {
  private readonly services = new Map<string, AdapterService>();

  /**
   * Returns a service handle for the profile, lazily calling `adapter.ensureService`
   * on first use or after a crash. Re-checks `healthy()` before returning a cached entry.
   */
  async ensureService(profile: AgentProfile, adapter: AdapterDef): Promise<AdapterService> {
    if (adapter.kind !== 'long-running' || !adapter.ensureService) {
      throw new Error(`ServicePool: adapter ${adapter.name} is not long-running`);
    }
    let svc = this.services.get(profile.id);
    if (svc) {
      try {
        if (await svc.healthy()) return svc;
      } catch {
        /* fall through and re-create */
      }
    }
    svc = await adapter.ensureService(profile);
    this.services.set(profile.id, svc);
    svc.on?.('crash', () => {
      this.services.delete(profile.id);
    });
    return svc;
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
    return this.services.get(profileId);
  }

  /** Drop a service handle (e.g. on profile delete or daemon shutdown). */
  async drop(profileId: string): Promise<void> {
    const svc = this.services.get(profileId);
    if (!svc) return;
    this.services.delete(profileId);
    try {
      await svc.shutdown?.();
    } catch {
      /* best effort */
    }
  }

  /** Drop all handles, e.g. on graceful shutdown. */
  async shutdown(): Promise<void> {
    const handles = Array.from(this.services.values());
    this.services.clear();
    await Promise.allSettled(handles.map((s) => s.shutdown?.()));
  }

  size(): number {
    return this.services.size;
  }
}
