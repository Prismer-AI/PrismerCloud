// See docs/refactor/05-adapter-contract.md and 08-cherry-pick-index.md (CP-3).

import type { AdapterDef } from './contract.js';

/**
 * Process-wide adapter registry.
 *
 * Maps `adapter.name` → {@link AdapterDef}. Selection policy lives in
 * `daemon/dispatch.ts`; the registry is just a typed Map.
 *
 * Shell cherry-picked (conceptually, not via cp) from
 * `feat/release190-milestone:sdk/prismer-cloud/runtime/src/adapter-registry.ts`.
 * The registered type was swapped `AdapterImpl` → `AdapterDef` per the
 * 1.9.x adapter contract; `tiersSupported` (PARA tier) is dropped — 1.9.x
 * uses capability tags only.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, AdapterDef>();

  register(adapter: AdapterDef): void {
    if (!adapter.name || typeof adapter.name !== 'string') {
      throw new Error('AdapterRegistry.register: adapter.name required');
    }
    const hasDispatch = typeof adapter.dispatch === 'function';
    const hasEnsureService = typeof adapter.ensureService === 'function';
    if (!hasDispatch && !hasEnsureService) {
      throw new Error(
        `AdapterRegistry.register: adapter "${adapter.name}" must implement dispatch() (interactive) or ensureService() (long-running)`,
      );
    }
    this.adapters.set(adapter.name, adapter);
  }

  unregister(name: string): boolean {
    return this.adapters.delete(name);
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  get(name: string): AdapterDef | undefined {
    return this.adapters.get(name);
  }

  list(): AdapterDef[] {
    return Array.from(this.adapters.values());
  }

  size(): number {
    return this.adapters.size;
  }

  /**
   * Find adapters that satisfy a capability tag.
   *
   * Match rules (deterministic, sorted by name):
   * - exact: adapter declared the tag verbatim
   * - wildcard: adapter declared `code.*` → matches `code.write`
   *
   * @internal — v2.0: no caller in tree uses capability-based selection;
   * dispatch routes by `profile.adapterName` directly. Kept for tests +
   * future use (e.g. mobile capability negotiation), but not part of the
   * stable adapter contract surface.
   */
  findByCapability(capability: string): AdapterDef[] {
    const matches: AdapterDef[] = [];
    for (const adapter of this.adapters.values()) {
      if (adapter.capabilities.includes(capability)) {
        matches.push(adapter);
        continue;
      }
      if (
        adapter.capabilities.some(
          (tag) => tag.endsWith('.*') && capability.startsWith(tag.slice(0, -1)),
        )
      ) {
        matches.push(adapter);
      }
    }
    matches.sort((a, b) => a.name.localeCompare(b.name));
    return matches;
  }
}
