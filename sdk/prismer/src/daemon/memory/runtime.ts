// Daemon-level multi-workspace memory pool.
//
// Lazy-creates one MemoryStore + MemorySearch + MemoryOutbox per workspaceId
// on first request. Caches the trio so subsequent requests reuse the same
// SQLite handle (better-sqlite3 connections are not concurrent-safe across
// threads, but the local HTTP server is single-process single-thread node so
// reuse is fine).
//
// File-system layout: `<baseDir>/<workspaceSlug>/memory.db` where
// workspaceSlug is a sanitized workspaceId (alphanumeric + dash/underscore
// only). Default baseDir is `<homedir>/.prismer/memory/`.

import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore } from './store.js';
import { MemorySearch } from './search.js';
import { MemoryOutbox } from './outbox.js';

export interface MemoryRuntimeOptions {
  /** Root dir for per-workspace SQLite files. Default: ~/.prismer/memory */
  baseDir?: string;
  /** Device identifier stamped on outbox + version rows. */
  deviceId: string;
  /**
   * memory202 doc 06 — at-rest encryption activation policy, per workspace.
   * Forwarded into each MemoryStore as `encryptionPolicy: () => fn(workspaceId)`
   * so a locally-authored write with no explicit `encrypted` flag is marked
   * encrypted when this returns true. Bound by the runner wiring to the
   * keyManager + FF gate (see runner-wiring.ts). Omitted ⇒ encryption stays OFF
   * (today's behavior); cloud→local down-sync passes an explicit flag and is
   * unaffected either way.
   */
  encryptionPolicy?: (workspaceId: string) => boolean;
}

export interface WorkspaceSlot {
  store: MemoryStore;
  search: MemorySearch;
  outbox: MemoryOutbox;
}

export class MemoryRuntime {
  private readonly baseDir: string;
  private readonly deviceId: string;
  private readonly slots = new Map<string, WorkspaceSlot>();
  // memory202 doc 06 — late-bound (the wiring constructs the runtime BEFORE the
  // keyManager, then installs the policy). Read live per write so stores opened
  // before the policy was set still pick it up.
  private encryptionPolicy?: (workspaceId: string) => boolean;

  constructor(opts: MemoryRuntimeOptions) {
    this.baseDir = opts.baseDir ?? path.join(os.homedir(), '.prismer', 'memory');
    this.deviceId = opts.deviceId;
    this.encryptionPolicy = opts.encryptionPolicy;
  }

  /**
   * memory202 doc 06 — install/replace the at-rest encryption activation policy
   * after construction (the runner wiring builds the keyManager AFTER the
   * runtime). Applies to all stores: each store's policy thunk delegates here
   * live, so already-open stores honor a later-installed policy.
   */
  setEncryptionPolicy(policy: (workspaceId: string) => boolean): void {
    this.encryptionPolicy = policy;
  }

  /**
   * Resolve the (store, search, outbox) trio for `workspaceId`. Opens the
   * SQLite file on first access; subsequent calls return the cached slot.
   */
  resolve(workspaceId: string): WorkspaceSlot {
    if (!isValidWorkspaceId(workspaceId)) {
      throw new Error(`MemoryRuntime: invalid workspaceId ${JSON.stringify(workspaceId)}`);
    }
    const cached = this.slots.get(workspaceId);
    if (cached) return cached;

    const slug = workspaceSlug(workspaceId);
    const dbPath = path.join(this.baseDir, slug, 'memory.db');
    const store = new MemoryStore({
      dbPath,
      workspaceId,
      deviceId: this.deviceId,
      // Delegate live to the runtime-level policy so a policy installed after
      // this store was opened still applies (late-bound keyManager).
      encryptionPolicy: () => this.encryptionPolicy?.(workspaceId) ?? false,
    });
    store.open();
    const slot: WorkspaceSlot = {
      store,
      search: new MemorySearch(store),
      outbox: new MemoryOutbox({ store }),
    };
    this.slots.set(workspaceId, slot);
    return slot;
  }

  /**
   * Get the slot if already resolved; null if no store was ever opened for
   * this workspace. Used by stats/list endpoints that should not implicitly
   * create a workspace store on a stranger query.
   */
  peek(workspaceId: string): WorkspaceSlot | null {
    return this.slots.get(workspaceId) ?? null;
  }

  /**
   * product209/16 §9.4 — the persisted replica state-machine status for a
   * workspace (null = no replica state row = legacy semantics).
   */
  getReplicaStatus(
    workspaceId: string,
  ): import('./store.js').MemoryReplicaStatus | null {
    return this.peek(workspaceId)?.store.getReplicaState()?.status ?? null;
  }

  /**
   * §9.5 — suspend the workspace replica (WS invalidation / authority drift
   * / lease-refresh failure). Recall stays closed until a full reconcile
   * commits `ready`. No-op when the workspace has no open store.
   */
  suspendReplica(workspaceId: string): void {
    this.peek(workspaceId)?.store.setReplicaStatus('suspended');
  }

  /** All workspaceIds currently in the pool (for /stats global view). */
  workspaceIds(): string[] {
    return Array.from(this.slots.keys());
  }

  /** Close every cached store. Daemon shutdown calls this. */
  closeAll(): void {
    for (const slot of this.slots.values()) {
      try {
        slot.store.close();
      } catch {
        /* best effort */
      }
    }
    this.slots.clear();
  }
}

const WORKSPACE_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;
function isValidWorkspaceId(id: string): boolean {
  return typeof id === 'string' && WORKSPACE_ID_RE.test(id);
}

function workspaceSlug(workspaceId: string): string {
  // The id regex already restricts the input set — slug just replaces ':'
  // (legal in workspaceId but not safe for some FS layouts) with '_'.
  return workspaceId.replace(/:/g, '_');
}
