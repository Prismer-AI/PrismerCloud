// product209/16 §9.4 — Runtime SQLite V3 (MA-2 scoped replica).
//
// Verifies the SCHEMA_V3 migration semantics of the daemon memory store (the
// version assertions pin the RUNTIME ratchet, so a later derived-index migration
// — V4's FTS bigram column, memory211/01 W2 #7 — does not re-edit this file):
//   - fresh V3: state table + two memory_pages columns exist, no replica
//     state row (legacy semantics — recall stays open);
//   - V2 -> V3 with an old `memory_inbox_cursor` row: the cursor is migrated
//     INTO `memory_replica_state` (accessVersion=0, empty subject hash,
//     leaseExpiresAt=0, status='suspended') in ONE transaction with the
//     schema-version bump; the old cursor table stays (read-only, migration
//     source only — never an authorization input);
//   - V2 -> V3 without an old cursor: no state row (legacy open);
//   - migration atomicity (negative control): a V2 db whose memory_pages
//     already carries the `sourceKind` column makes the ALTER fail → the
//     WHOLE migration rolls back (version stays 2, no state table);
//   - restart during `reconciling`: open() flips the status to `suspended`
//     (full reconcile required, never a stale in-flight marker);
//   - newer schema: typed `MemorySchemaIncompatibleError` (code
//     MEMORY_SCHEMA_INCOMPATIBLE) — fail closed, never a downgrade write.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  MemoryStore,
  MemorySchemaIncompatibleError,
  MemoryReplicaNotReadyError,
  SCHEMA_VERSION,
} from '../src/daemon/memory/store.js';

const WS = 'ws_v3';

// The V2-era memory_pages DDL (SCHEMA_V1 as of schema version 2 — the ALTER
// targets exactly this table). Historical fixture: kept byte-for-byte so the
// V2->V3 migration test is honest about what a real v2 db looked like.
const V2_MEMORY_PAGES_DDL = `
  CREATE TABLE memory_pages (
    id TEXT PRIMARY KEY,
    workspaceId TEXT NOT NULL,
    path TEXT NOT NULL,
    title TEXT,
    description TEXT,
    contentHash TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    pageType TEXT NOT NULL DEFAULT 'leaf',
    visibilityKind TEXT NOT NULL DEFAULT 'workspace',
    visibilityImUserId TEXT,
    encrypted INTEGER NOT NULL DEFAULT 0,
    stale INTEGER NOT NULL DEFAULT 0,
    archivedAt INTEGER,
    sourceAssetId TEXT,
    sourceRefsJson TEXT NOT NULL DEFAULT '[]',
    syncStatus TEXT NOT NULL DEFAULT 'local-only',
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    UNIQUE(workspaceId, path)
  )
`;

interface FabricateOptions {
  /** schema version to stamp (default 2). */
  version?: number;
  /** old memory_inbox_cursor row for the test workspace. */
  cursor?: string;
  /** pre-add the `sourceKind` column (migration-atomicity negative control). */
  withSourceKindColumn?: boolean;
}

/** Fabricate a V2-era db on disk the way a pre-V3 runtime would have left it. */
function fabricateV2Db(dbPath: string, opts: FabricateOptions = {}): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE memory_schema_version (version INTEGER PRIMARY KEY)');
  db.prepare('INSERT INTO memory_schema_version (version) VALUES (?)').run(opts.version ?? 2);
  db.exec(V2_MEMORY_PAGES_DDL);
  if (opts.withSourceKindColumn) {
    db.exec(`ALTER TABLE memory_pages ADD COLUMN sourceKind TEXT NOT NULL DEFAULT 'pkf'`);
  }
  db.exec(`CREATE TABLE memory_inbox_cursor (
    workspaceId TEXT PRIMARY KEY,
    cursor TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  )`);
  if (opts.cursor !== undefined) {
    db.prepare('INSERT INTO memory_inbox_cursor (workspaceId, cursor, updatedAt) VALUES (?, ?, ?)').run(
      WS,
      opts.cursor,
      1700000000000,
    );
  }
  db.close();
}

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prismer-v3-mig-'));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function openStore(): MemoryStore {
  const store = new MemoryStore({ dbPath: join(dir, 'memory.db'), workspaceId: WS, deviceId: 'dev_x' });
  store.open();
  return store;
}

function schemaVersion(store: MemoryStore): number {
  const row = store
    .rawDb()
    .prepare('SELECT version FROM memory_schema_version')
    .get() as { version: number };
  return row.version;
}

function tableExists(store: MemoryStore, name: string): boolean {
  const row = store
    .rawDb()
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name);
  return !!row;
}

describe('MemoryStore SCHEMA_V3 migration (§9.4)', () => {
  it('fresh V3: creates memory_replica_state + the two memory_pages columns; no state row → legacy recall stays open', () => {
    const store = openStore();
    try {
      expect(schemaVersion(store)).toBe(SCHEMA_VERSION);
      expect(tableExists(store, 'memory_replica_state')).toBe(true);
      const cols = store
        .rawDb()
        .prepare(`PRAGMA table_info(memory_pages)`)
        .all() as { name: string }[];
      expect(cols.map((c) => c.name)).toEqual(
        expect.arrayContaining(['sourceKind', 'replicaActorIdsJson']),
      );
      expect(store.getReplicaState()).toBeNull();
      // Legacy semantics: no state row → recall open.
      const page = store.write({
        workspaceId: WS,
        path: 'a.md',
        content: 'hello',
        actorImUserId: 'im_a',
        actorKind: 'agent',
      });
      expect(store.loadByPath('a.md')?.id).toBe(page.id);
    } finally {
      store.close();
    }
  });

  it('V2 -> V3 with old inbox cursor: single transaction migrates the cursor into memory_replica_state as suspended (never authorized)', () => {
    fabricateV2Db(join(dir, 'memory.db'), { cursor: 'wm:123456789' });
    const store = openStore();
    try {
      expect(schemaVersion(store)).toBe(SCHEMA_VERSION);
      const state = store.getReplicaState();
      expect(state).not.toBeNull();
      expect(state!.cursor).toBe('wm:123456789');
      expect(state!.accessVersion).toBe(0);
      expect(state!.replicaSubjectHash).toBe('');
      expect(state!.leaseExpiresAt).toBe(0);
      expect(state!.status).toBe('suspended');
      // Old cursor row survives (read-only migration source; never authorization).
      const oldRow = store
        .rawDb()
        .prepare('SELECT cursor FROM memory_inbox_cursor WHERE workspaceId = ?')
        .get(WS) as { cursor: string } | undefined;
      expect(oldRow?.cursor).toBe('wm:123456789');
      // Migrated-but-not-authorized: agent recall FAILS CLOSED until a
      // strict reconcile completes (accessVersion stays 0 until then).
      store.write({
        workspaceId: WS,
        path: 'a.md',
        content: 'hello',
        actorImUserId: 'im_a',
        actorKind: 'agent',
      });
      expect(() => store.loadByPath('a.md')).toThrow(MemoryReplicaNotReadyError);
    } finally {
      store.close();
    }
  });

  it('V2 -> V3 without old cursor: no state row is created (legacy workspaces stay ungated)', () => {
    fabricateV2Db(join(dir, 'memory.db'));
    const store = openStore();
    try {
      expect(schemaVersion(store)).toBe(SCHEMA_VERSION);
      expect(store.getReplicaState()).toBeNull();
      store.write({
        workspaceId: WS,
        path: 'a.md',
        content: 'hello',
        actorImUserId: 'im_a',
        actorKind: 'agent',
      });
      expect(store.loadByPath('a.md')).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it('migration atomicity (negative control): ALTER failure rolls back the WHOLE V2->V3 transaction (version stays 2, no state table)', () => {
    fabricateV2Db(join(dir, 'memory.db'), { withSourceKindColumn: true });
    const store = new MemoryStore({ dbPath: join(dir, 'memory.db'), workspaceId: WS, deviceId: 'dev_x' });
    expect(() => store.open()).toThrow(/duplicate column|sourceKind/);
    store.close();
    // The db is still the fabricated v2 shape: version 2 and NO
    // memory_replica_state — the create-table ran inside the same
    // transaction as the failing ALTER and must not survive.
    const db = new Database(join(dir, 'memory.db'));
    try {
      const v = db.prepare('SELECT version FROM memory_schema_version').get() as { version: number };
      expect(v.version).toBe(2);
      const state = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'memory_replica_state'`)
        .get();
      expect(state).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('restart during reconciling: open() flips the in-flight marker to suspended (full reconcile required)', () => {
    const store = openStore();
    store.setReplicaStatus('reconciling');
    // Simulate a crash mid-reconcile: close without any further state write.
    store.close();

    const reopened = openStore();
    try {
      expect(reopened.getReplicaState()?.status).toBe('suspended');
    } finally {
      reopened.close();
    }
  });

  it('newer schema fail closed: typed MemorySchemaIncompatibleError, never a downgrade write', () => {
    // The runtime SCHEMA_VERSION has moved on since this test was written; the
    // invariant under test is "a db NEWER than the runtime is refused", so the
    // fabricated future version must be one PAST the current ratchet.
    const futureVersion = SCHEMA_VERSION + 1;
    fabricateV2Db(join(dir, 'memory.db'), { version: futureVersion });
    const store = new MemoryStore({ dbPath: join(dir, 'memory.db'), workspaceId: WS, deviceId: 'dev_x' });
    expect(() => store.open()).toThrow(MemorySchemaIncompatibleError);
    expect(() => store.open()).toThrow(/newer than runtime/);
    store.close();
    // Version untouched — the runtime must never downgrade-write a newer db.
    const db = new Database(join(dir, 'memory.db'));
    try {
      const v = db.prepare('SELECT version FROM memory_schema_version').get() as { version: number };
      expect(v.version).toBe(futureVersion);
    } finally {
      db.close();
    }
  });

  it('legacy completion marker (accessVersion=0 ready) opens recall but is NOT strict authorization', () => {
    const store = openStore();
    try {
      store.markLegacyReplicaReady('wm:42');
      const state = store.getReplicaState();
      expect(state?.status).toBe('ready');
      expect(state?.accessVersion).toBe(0);
      expect(state?.replicaSubjectHash).toBe('');
      expect(state?.leaseExpiresAt).toBe(0);
      store.write({
        workspaceId: WS,
        path: 'a.md',
        content: 'hello',
        actorImUserId: 'im_a',
        actorKind: 'agent',
      });
      // Legacy marker: recall open (old semantics preserved).
      expect(store.loadByPath('a.md')).not.toBeNull();
      // But it never upgrades a strict-authorized state: a second call with a
      // strict epoch in place must not downgrade it (checked in the reconcile
      // test file via applyReplicaCommit).
    } finally {
      store.close();
    }
  });
});
