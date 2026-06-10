// v2.0 Wave 4-E6 — Scope-bucketed daemon memory store.
//
// Doc reference: docs/release200/14-messaging-state-machine-reliability.md §4.7
//                docs/release200/13-agent-spec-and-lifecycle.md §6.1
//
// Layout (per-workspace):
//
//   ~/.prismer/memory/<workspaceSlug>/
//     ├── _shared.db                 # scope='workspace-shared', any agent RW
//     ├── agents/
//     │   ├── <agentImUserId-1>.db   # scope='agent-private', only this agent
//     │   ├── <agentImUserId-2>.db
//     │   └── ...
//     └── scratch/
//         ├── <sessionKey-1>.db      # scope='session-scratch', throwaway/eval-only
//         └── ...
//
// release201/26 §14.9 Phase A (#A5): a throwaway / eval session must use an
// ISOLATED scratch memory scope so a failed run's extract does NOT pollute the
// shared (workspace-shared / agent-private) stores, and a later run's recall
// cannot read it back. The scratch bucket is keyed by an opaque sessionKey
// (e.g. `eval-<runId>`); its search neither reads nor falls through to the
// shared/agent buckets, and `dropScratch()` deletes the bucket after the run
// (random tempHome cleanup + explicit drop). See §14.6 (scope 层级) for where
// `session` sits in the scope hierarchy.
//
// Each *.db is a regular `MemoryStore` from store.ts (FTS5 + WAL + 0600 perms).
// This wrapper:
//
//   1. Resolves the correct underlying store for (scope, agentImUserId)
//   2. Caches open handles per agent so search/write doesn't pay open() cost
//   3. Forbids cross-agent reads at the API layer (defense-in-depth — the
//      filesystem layout already isolates files but we also reject explicit
//      mis-route attempts here)
//   4. Routes writes to the per-bucket SQLite + enqueues a cloud sync record
//      via the existing outbox so the cloud-side im_memory_files row gets
//      `scope` + `agentImUserId` stamped on it
//
// This file deliberately does NOT re-implement FTS5 / write transactions /
// migration — it composes the existing `MemoryStore`. The cloud-sync queue
// hand-off is owned by outbox.ts; we just stamp the right metadata on the
// envelope so the cloud-side receiver knows which bucket the row belongs to.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { MemoryStore } from './store.js';
import type { MemoryWriteInput, MemorySearchOptions, MemorySearchResult } from './types.js';
import { MemorySearch } from './search.js';

// release201/26 §14.9 Phase A (#A5): 'session-scratch' is the isolated eval /
// throwaway bucket. It is additive — 'workspace-shared' / 'agent-private' keep
// their existing routing and behavior unchanged.
//
// release201/26 §14.6 Phase A (#A5b): completes the scope hierarchy from §14.6
// (session → role → project → workspace → global). 'role-shared' /
// 'project-shared' / 'global' are added ADDITIVELY — the original three scopes
// keep their routing/behavior unchanged. Buckets:
//
//   <workspaceDir>/roles/<sanitized roleSlug>.db     # scope='role-shared'
//   <workspaceDir>/projects/<sanitized projectId>.db # scope='project-shared'
//   <rootDir>/global.db                              # scope='global' (CROSS-ws)
//
// The global bucket lives at rootDir (NOT under the per-workspace dir) so it is
// shared across every workspace under the same rootDir. Because the underlying
// MemoryStore filters/guards by workspaceId, the global store is opened with a
// constant sentinel workspaceId (GLOBAL_WORKSPACE_ID) so two ScopedMemoryStore
// instances with different workspaceIds genuinely read/write the same rows.
export type MemoryScope =
  | 'workspace-shared'
  | 'agent-private'
  | 'session-scratch'
  | 'role-shared'
  | 'project-shared'
  | 'global';

// release201/26 §14.6 Phase A (#A5b): the global bucket is cross-workspace, so
// its rows must NOT be partitioned by the per-instance workspaceId. We pin a
// constant workspaceId for the single shared global.db; otherwise MemoryStore's
// single-workspace invariant (write rejects mismatched workspaceId, search
// filters by workspaceId) would re-isolate each workspace's global writes.
const GLOBAL_WORKSPACE_ID = '__global__';

export interface ScopedMemoryStoreOptions {
  /** Filesystem root, e.g. `~/.prismer/memory` (will create per-workspace dir under). */
  rootDir: string;
  /** Workspace identifier — used both as the cloud workspaceId and the dir slug. */
  workspaceId: string;
  /** Optional human-friendly slug for the dir; defaults to workspaceId. */
  workspaceSlug?: string;
  /** Device identifier, stamped onto outbox + version rows. */
  deviceId: string;
}

export interface ScopedWriteInput extends Omit<MemoryWriteInput, 'workspaceId'> {
  scope: MemoryScope;
  /** Required when scope='agent-private'; rejected when scope='workspace-shared'. */
  agentImUserId?: string;
  /**
   * Required when scope='session-scratch' (release201/26 §14.9 #A5) — opaque
   * throwaway key, e.g. `eval-<runId>`. Rejected for the other scopes.
   */
  sessionKey?: string;
  /**
   * Required when scope='role-shared' (release201/26 §14.6 #A5b) — role
   * template slug; the bucket is shared across all agents of that role.
   * Rejected for the other scopes.
   */
  roleSlug?: string;
  /**
   * Required when scope='project-shared' (release201/26 §14.6 #A5b) — project
   * identifier; the bucket is scoped to a project. Rejected for other scopes.
   */
  projectId?: string;
}

export interface ScopedSearchInput {
  query: string;
  scope: MemoryScope;
  /** Required when scope='agent-private' — search only this agent's bucket. */
  agentImUserId?: string;
  /**
   * Required when scope='session-scratch' — search only this throwaway bucket;
   * never falls through to shared/agent buckets (full isolation, §14.9 #A5).
   */
  sessionKey?: string;
  /** Required when scope='role-shared' (release201/26 §14.6 #A5b). */
  roleSlug?: string;
  /** Required when scope='project-shared' (release201/26 §14.6 #A5b). */
  projectId?: string;
  options?: MemorySearchOptions;
}

/**
 * Per-workspace, per-bucket SQLite store with the same lifecycle semantics
 * as the existing single-store MemoryStore class.
 */
export class ScopedMemoryStore {
  private sharedStore: MemoryStore | null = null;
  private agentStores = new Map<string, MemoryStore>();
  // release201/26 §14.9 #A5 — open handles for the isolated eval/throwaway
  // scratch buckets, keyed by the sanitized sessionKey.
  private scratchStores = new Map<string, MemoryStore>();
  // release201/26 §14.6 #A5b — lazy-open handles for the new hierarchy buckets.
  // role-shared keyed by sanitized roleSlug; project-shared by sanitized
  // projectId; global is a single cross-workspace handle at rootDir.
  private roleStores = new Map<string, MemoryStore>();
  private projectStores = new Map<string, MemoryStore>();
  private globalStore: MemoryStore | null = null;
  private readonly workspaceDir: string;

  constructor(private readonly opts: ScopedMemoryStoreOptions) {
    const slug = opts.workspaceSlug ?? opts.workspaceId;
    this.workspaceDir = path.join(opts.rootDir, slug);
  }

  /** Resolve the shared store (lazy open). */
  shared(): MemoryStore {
    if (this.sharedStore) return this.sharedStore;
    const dbPath = path.join(this.workspaceDir, '_shared.db');
    this.sharedStore = new MemoryStore({
      dbPath,
      workspaceId: this.opts.workspaceId,
      deviceId: this.opts.deviceId,
    });
    this.sharedStore.open();
    return this.sharedStore;
  }

  /** Resolve the per-agent store (lazy open). */
  forAgent(agentImUserId: string): MemoryStore {
    if (!agentImUserId) throw new Error('ScopedMemoryStore.forAgent: agentImUserId required');
    let store = this.agentStores.get(agentImUserId);
    if (store) return store;
    // Validate the agent id so a directory-traversal-like input can't escape
    // the workspace dir (e.g. agentImUserId='../other-agent' or '/etc/passwd').
    if (!/^[A-Za-z0-9_\-]+$/.test(agentImUserId)) {
      throw new Error(`ScopedMemoryStore.forAgent: invalid agentImUserId=${agentImUserId}`);
    }
    const dbPath = path.join(this.workspaceDir, 'agents', `${agentImUserId}.db`);
    store = new MemoryStore({
      dbPath,
      workspaceId: this.opts.workspaceId,
      deviceId: this.opts.deviceId,
    });
    store.open();
    this.agentStores.set(agentImUserId, store);
    return store;
  }

  /**
   * Resolve the per-session scratch store (lazy open). release201/26 §14.9 #A5.
   *
   * The bucket lives under `<workspaceDir>/scratch/<sanitizedSessionKey>.db`.
   * It is fully isolated: nothing in here is ever merged into shared/agent
   * searches, and it is meant to be torn down via `dropScratch` after the run.
   */
  forScratch(sessionKey: string): MemoryStore {
    const safeKey = ScopedMemoryStore.sanitizeSessionKey(sessionKey);
    let store = this.scratchStores.get(safeKey);
    if (store) return store;
    const dbPath = path.join(this.workspaceDir, 'scratch', `${safeKey}.db`);
    store = new MemoryStore({
      dbPath,
      // The scratch bucket reuses the same logical workspaceId so the
      // MemoryStore single-workspace invariant + FTS rows line up; isolation is
      // enforced by the separate db file, not by a different workspaceId.
      workspaceId: this.opts.workspaceId,
      deviceId: this.opts.deviceId,
    });
    store.open();
    this.scratchStores.set(safeKey, store);
    return store;
  }

  /**
   * Resolve the per-role shared store (lazy open). release201/26 §14.6 #A5b.
   * Bucket: `<workspaceDir>/roles/<sanitizedRoleSlug>.db` — shared across all
   * agents instantiated from the same role template.
   */
  forRole(roleSlug: string): MemoryStore {
    const safe = ScopedMemoryStore.sanitizeKey(roleSlug, 'roleSlug');
    let store = this.roleStores.get(safe);
    if (store) return store;
    const dbPath = path.join(this.workspaceDir, 'roles', `${safe}.db`);
    store = new MemoryStore({
      dbPath,
      workspaceId: this.opts.workspaceId,
      deviceId: this.opts.deviceId,
    });
    store.open();
    this.roleStores.set(safe, store);
    return store;
  }

  /**
   * Resolve the per-project shared store (lazy open). release201/26 §14.6 #A5b.
   * Bucket: `<workspaceDir>/projects/<sanitizedProjectId>.db`.
   */
  forProject(projectId: string): MemoryStore {
    const safe = ScopedMemoryStore.sanitizeKey(projectId, 'projectId');
    let store = this.projectStores.get(safe);
    if (store) return store;
    const dbPath = path.join(this.workspaceDir, 'projects', `${safe}.db`);
    store = new MemoryStore({
      dbPath,
      workspaceId: this.opts.workspaceId,
      deviceId: this.opts.deviceId,
    });
    store.open();
    this.projectStores.set(safe, store);
    return store;
  }

  /**
   * Resolve the CROSS-workspace global store (lazy open). release201/26 §14.6
   * #A5b. The bucket lives at `<rootDir>/global.db` (one level ABOVE the
   * per-workspace dir) so every ScopedMemoryStore sharing the same rootDir reads
   * and writes the same global.db, regardless of workspaceId. The store is
   * opened with the constant GLOBAL_WORKSPACE_ID so MemoryStore's single-
   * workspace filter does not re-partition global rows per workspace.
   */
  global(): MemoryStore {
    if (this.globalStore) return this.globalStore;
    const dbPath = path.join(this.opts.rootDir, 'global.db');
    this.globalStore = new MemoryStore({
      dbPath,
      workspaceId: GLOBAL_WORKSPACE_ID,
      deviceId: this.opts.deviceId,
    });
    this.globalStore.open();
    return this.globalStore;
  }

  /** Resolve the right store for (scope, agentImUserId, sessionKey, roleSlug, projectId). */
  resolve(
    scope: MemoryScope,
    agentImUserId?: string,
    sessionKey?: string,
    roleSlug?: string,
    projectId?: string,
  ): MemoryStore {
    // Cross-rejection helper — every scope owns exactly one key param (or none);
    // any foreign param is a mis-route and rejected. Symmetric to how
    // agent-private gates agentImUserId and session-scratch gates sessionKey.
    // release201/26 §14.6 #A5b.
    const reject = (param: string, value: string | undefined) => {
      if (value) {
        throw new Error(
          `ScopedMemoryStore.resolve: scope='${scope}' must not carry ${param} (got ${value})`,
        );
      }
    };

    if (scope === 'workspace-shared') {
      reject('agentImUserId', agentImUserId);
      reject('sessionKey', sessionKey);
      reject('roleSlug', roleSlug);
      reject('projectId', projectId);
      return this.shared();
    }
    if (scope === 'agent-private') {
      if (!agentImUserId) {
        throw new Error("ScopedMemoryStore.resolve: scope='agent-private' requires agentImUserId");
      }
      reject('sessionKey', sessionKey);
      reject('roleSlug', roleSlug);
      reject('projectId', projectId);
      return this.forAgent(agentImUserId);
    }
    // release201/26 §14.9 #A5 — isolated eval/throwaway scratch bucket.
    if (scope === 'session-scratch') {
      if (!sessionKey) {
        throw new Error(
          "ScopedMemoryStore.resolve: scope='session-scratch' requires sessionKey",
        );
      }
      reject('agentImUserId', agentImUserId);
      reject('roleSlug', roleSlug);
      reject('projectId', projectId);
      return this.forScratch(sessionKey);
    }
    // release201/26 §14.6 #A5b — role-shared: keyed by roleSlug.
    if (scope === 'role-shared') {
      if (!roleSlug) {
        throw new Error("ScopedMemoryStore.resolve: scope='role-shared' requires roleSlug");
      }
      reject('agentImUserId', agentImUserId);
      reject('sessionKey', sessionKey);
      reject('projectId', projectId);
      return this.forRole(roleSlug);
    }
    // release201/26 §14.6 #A5b — project-shared: keyed by projectId.
    if (scope === 'project-shared') {
      if (!projectId) {
        throw new Error("ScopedMemoryStore.resolve: scope='project-shared' requires projectId");
      }
      reject('agentImUserId', agentImUserId);
      reject('sessionKey', sessionKey);
      reject('roleSlug', roleSlug);
      return this.forProject(projectId);
    }
    // release201/26 §14.6 #A5b — global: cross-workspace, no key param.
    if (scope === 'global') {
      reject('agentImUserId', agentImUserId);
      reject('sessionKey', sessionKey);
      reject('roleSlug', roleSlug);
      reject('projectId', projectId);
      return this.global();
    }
    throw new Error(`ScopedMemoryStore.resolve: unknown scope=${scope}`);
  }

  /**
   * Sanitize an opaque key (sessionKey / roleSlug / projectId) for filesystem
   * safety. Rejects empty/blank keys; maps any char outside [A-Za-z0-9_-] to
   * '_' so a key like `eval-../../etc` cannot escape its bucket dir.
   * release201/26 §14.9 #A5 + §14.6 #A5b.
   */
  private static sanitizeKey(key: string, label: string): string {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error(`ScopedMemoryStore: ${label} requires a non-empty value`);
    }
    const safe = key.replace(/[^A-Za-z0-9_-]/g, '_');
    if (safe === '') {
      throw new Error(`ScopedMemoryStore: ${label} sanitizes to empty (got ${key})`);
    }
    return safe;
  }

  /**
   * Sanitize an opaque sessionKey for filesystem safety. Rejects empty/blank
   * keys; maps any char outside [A-Za-z0-9_-] to '_' so a key like
   * `eval-../../etc` cannot escape the scratch dir. release201/26 §14.9 #A5.
   */
  private static sanitizeSessionKey(sessionKey: string): string {
    if (typeof sessionKey !== 'string' || sessionKey.trim() === '') {
      throw new Error('ScopedMemoryStore: session-scratch requires a non-empty sessionKey');
    }
    const safe = sessionKey.replace(/[^A-Za-z0-9_-]/g, '_');
    // After substitution an all-separator key (e.g. '...') could collapse to a
    // run of underscores; that is still a valid, contained filename, but guard
    // against an empty result just in case.
    if (safe === '') {
      throw new Error(`ScopedMemoryStore: sessionKey sanitizes to empty (got ${sessionKey})`);
    }
    return safe;
  }

  /** Write a memory page into the correct bucket. */
  write(input: ScopedWriteInput): {
    pageId: string;
    scope: MemoryScope;
    agentImUserId?: string;
    sessionKey?: string;
    roleSlug?: string;
    projectId?: string;
  } {
    const store = this.resolve(
      input.scope,
      input.agentImUserId,
      input.sessionKey,
      input.roleSlug,
      input.projectId,
    );
    const page = store.write({
      // The global bucket is opened with GLOBAL_WORKSPACE_ID; every other bucket
      // uses the instance workspaceId. MemoryStore.write rejects a mismatched
      // workspaceId, so route the right one. release201/26 §14.6 #A5b.
      workspaceId: input.scope === 'global' ? GLOBAL_WORKSPACE_ID : this.opts.workspaceId,
      path: input.path,
      content: input.content,
      pageType: input.pageType,
      title: input.title,
      description: input.description,
      visibility: input.visibility,
      sourceAssetId: input.sourceAssetId,
      sourceRefs: input.sourceRefs,
      stale: input.stale,
      actorImUserId: input.actorImUserId,
      actorKind: input.actorKind,
    });
    return {
      pageId: page.id,
      scope: input.scope,
      agentImUserId: input.agentImUserId,
      sessionKey: input.sessionKey,
      roleSlug: input.roleSlug,
      projectId: input.projectId,
    };
  }

  /**
   * Search only the requested bucket. This is the daemon-first FTS5 path
   * referenced by FF_MEMORY_SEARCH_DAEMON_FIRST.
   */
  search(input: ScopedSearchInput): MemorySearchResult[] {
    // For scope='session-scratch' this resolves to the scratch bucket only; it
    // never merges in shared/agent results, so a throwaway/eval recall cannot
    // leak shared memory and vice versa. release201/26 §14.9 #A5.
    const store = this.resolve(
      input.scope,
      input.agentImUserId,
      input.sessionKey,
      input.roleSlug,
      input.projectId,
    );
    const search = new MemorySearch(store);
    return search.hybrid(input.query, input.options);
  }

  /**
   * Search across BOTH the shared bucket and the requesting agent's private
   * bucket, merging results by descending score. Used by the recall-injector
   * so the agent's prompt sees both shared knowledge and its own private notes.
   */
  searchForAgent(
    query: string,
    agentImUserId: string,
    options?: MemorySearchOptions,
  ): MemorySearchResult[] {
    const sharedResults = this.search({ query, scope: 'workspace-shared', options });
    const privateResults = this.search({ query, scope: 'agent-private', agentImUserId, options });
    const merged = [...sharedResults, ...privateResults];
    merged.sort((a, b) => b.score - a.score);
    const topK = options?.topK ?? 5;
    return merged.slice(0, topK);
  }

  /** List which agent ids currently have a private DB on disk (for diagnostics). */
  listAgentBuckets(): string[] {
    const agentsDir = path.join(this.workspaceDir, 'agents');
    if (!fs.existsSync(agentsDir)) return [];
    return fs
      .readdirSync(agentsDir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => f.slice(0, -3));
  }

  /**
   * List which scratch sessionKeys currently have a DB on disk. For
   * housekeeping — e.g. dropping orphaned scratch buckets from crashed eval
   * runs. release201/26 §14.9 #A5.
   */
  listScratchKeys(): string[] {
    const scratchDir = path.join(this.workspaceDir, 'scratch');
    if (!fs.existsSync(scratchDir)) return [];
    return fs
      .readdirSync(scratchDir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => f.slice(0, -3));
  }

  /**
   * Close + delete a scratch bucket's db file(s) (incl. -wal / -shm sidecars).
   * Called after an eval/throwaway run to clean up. Idempotent: a missing
   * bucket is a no-op. release201/26 §14.9 #A5.
   */
  dropScratch(sessionKey: string): void {
    const safeKey = ScopedMemoryStore.sanitizeSessionKey(sessionKey);
    const open = this.scratchStores.get(safeKey);
    if (open) {
      open.close();
      this.scratchStores.delete(safeKey);
    }
    const base = path.join(this.workspaceDir, 'scratch', `${safeKey}.db`);
    for (const suffix of ['', '-wal', '-shm']) {
      const p = base + suffix;
      try {
        if (fs.existsSync(p)) fs.rmSync(p);
      } catch {
        // Best-effort cleanup; a locked sidecar on a non-POSIX FS is tolerable
        // since the scratch dir itself is throwaway (tempHome teardown).
      }
    }
  }

  /** Total disk footprint (best-effort; sums each bucket's main DB file). */
  diskBytes(): { shared: number; perAgent: Record<string, number>; total: number } {
    const out = { shared: 0, perAgent: {} as Record<string, number>, total: 0 };
    const sharedPath = path.join(this.workspaceDir, '_shared.db');
    if (fs.existsSync(sharedPath)) {
      out.shared = fs.statSync(sharedPath).size;
      out.total += out.shared;
    }
    const agentsDir = path.join(this.workspaceDir, 'agents');
    if (fs.existsSync(agentsDir)) {
      for (const file of fs.readdirSync(agentsDir)) {
        if (!file.endsWith('.db')) continue;
        const id = file.slice(0, -3);
        const sz = fs.statSync(path.join(agentsDir, file)).size;
        out.perAgent[id] = sz;
        out.total += sz;
      }
    }
    return out;
  }

  /** Close all underlying stores. */
  close(): void {
    this.sharedStore?.close();
    this.sharedStore = null;
    for (const store of this.agentStores.values()) {
      store.close();
    }
    this.agentStores.clear();
    // release201/26 §14.9 #A5 — release scratch handles too (files left on
    // disk for explicit dropScratch / tempHome teardown).
    for (const store of this.scratchStores.values()) {
      store.close();
    }
    this.scratchStores.clear();
    // release201/26 §14.6 #A5b — release role / project / global handles.
    for (const store of this.roleStores.values()) {
      store.close();
    }
    this.roleStores.clear();
    for (const store of this.projectStores.values()) {
      store.close();
    }
    this.projectStores.clear();
    this.globalStore?.close();
    this.globalStore = null;
  }
}
