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
}

interface WorkspaceSlot {
  store: MemoryStore;
  search: MemorySearch;
  outbox: MemoryOutbox;
}

export class MemoryRuntime {
  private readonly baseDir: string;
  private readonly deviceId: string;
  private readonly slots = new Map<string, WorkspaceSlot>();

  constructor(opts: MemoryRuntimeOptions) {
    this.baseDir = opts.baseDir ?? path.join(os.homedir(), '.prismer', 'memory');
    this.deviceId = opts.deviceId;
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
    const store = new MemoryStore({ dbPath, workspaceId, deviceId: this.deviceId });
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
