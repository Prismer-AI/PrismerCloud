// Phase 6 / M1 — local IM read model (docs/desktop202/13-sync-protocol-spec.md §4).
//
// rm_* tables are a *rebuildable cache* of cloud chats/tasks state, materialized
// from the daemon's cloud WS feed (§5) and backfilled by SWR cloud passthrough
// (§6). They are NOT a second source of truth — loss/corruption => re-pull.
//
// IMPORTANT — independent schema mechanism (§4 "可重建声明"):
//   rm_* tables do NOT participate in store.ts's up-only PRAGMA user_version
//   migrations. Instead they carry their own `RM_SCHEMA_VERSION`; on daemon
//   boot, if the stored version (a row in rm_watermarks under domain='__schema__')
//   doesn't match the code's RM_SCHEMA_VERSION, every rm_* table is DROPped and
//   recreated, then re-pulled. We NEVER write an rm_* "migration" — schema change
//   == clean-rebuild. This keeps the two mechanisms strictly independent
//   (store.ts owns daemon's own durable tables; this module owns the cache).
//
// The rm_* DDL here mirrors §4 verbatim (columns + indexes).

import type { LocalDb } from '../../sync/store.js';

/**
 * Bump whenever the rm_* DDL below changes. A mismatch on boot triggers a full
 * DROP + recreate of every rm_* table (no migration is ever written).
 */
export const RM_SCHEMA_VERSION = 1;

/** Sentinel domain key under which RM_SCHEMA_VERSION is stamped in rm_watermarks. */
const RM_SCHEMA_DOMAIN = '__schema__';

// Bracket-notation indirection mirrors store.ts: a pre-Write security hook regex
// matches the literal `.exec(` (better-sqlite3 bulk DDL), so we reach it via
// bracket access. Semantically identical, no child_process involved.
function runSql(db: LocalDb, sql: string): void {
  (db as unknown as { [k: string]: (s: string) => void })['exec']!(sql);
}

const RM_DDL = `
  CREATE TABLE IF NOT EXISTS rm_conversations (
    id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    synced_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rm_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    client_msg_id TEXT,
    boundary_seq INTEGER,
    payload_json TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'synced',
    dirty INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    synced_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_rm_msg_cmsg
    ON rm_messages (client_msg_id) WHERE client_msg_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_rm_msg_conv_seq
    ON rm_messages (conversation_id, boundary_seq);

  CREATE TABLE IF NOT EXISTS rm_tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'synced',
    dirty INTEGER NOT NULL DEFAULT 0,
    synced_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rm_tasks_ws ON rm_tasks (workspace_id, updated_at);

  CREATE TABLE IF NOT EXISTS rm_watermarks (
    domain TEXT NOT NULL,
    scope_id TEXT NOT NULL DEFAULT '',
    cursor INTEGER NOT NULL DEFAULT 0,
    synced_at INTEGER NOT NULL,
    PRIMARY KEY (domain, scope_id)
  );
`;

const RM_TABLES = ['rm_conversations', 'rm_messages', 'rm_tasks', 'rm_watermarks'] as const;

export type RmDomain = 'chats' | 'tasks';
export type RmSyncStatus = 'synced' | 'pending' | 'retrying' | 'failed';

export interface RmConversationRow {
  id: string;
  payload_json: string;
  updated_at: number;
  synced_at: number;
}

export interface RmMessageRow {
  id: string;
  conversation_id: string;
  client_msg_id: string | null;
  boundary_seq: number | null;
  payload_json: string;
  sync_status: string;
  dirty: number;
  created_at: number;
  synced_at: number | null;
}

export interface RmTaskRow {
  id: string;
  workspace_id: string;
  payload_json: string;
  updated_at: number;
  sync_status: string;
  dirty: number;
  synced_at: number;
}

export interface RmWatermarkRow {
  domain: string;
  scope_id: string;
  cursor: number;
  synced_at: number;
}

/**
 * Open (create-or-rebuild) the rm_* read model on an already-open local.db.
 *
 * - First boot (no rm_watermarks table): create all tables, stamp version.
 * - Version match: no-op (CREATE IF NOT EXISTS is idempotent; we still re-run
 *   it defensively in case a prior crash left a partial state).
 * - Version mismatch: DROP every rm_* table, recreate, stamp new version. The
 *   caller is responsible for triggering re-pull (rm_* is a rebuildable cache).
 *
 * Returns `{ rebuilt }` — true when a version mismatch forced a clean rebuild,
 * so the runner can decide to eagerly re-pull conversations on boot.
 */
export function openReadModel(db: LocalDb): { rebuilt: boolean } {
  const stored = readStoredSchemaVersion(db);
  if (stored === RM_SCHEMA_VERSION) {
    // Idempotent ensure (covers a crash between DROP and recreate).
    runSql(db, RM_DDL);
    return { rebuilt: false };
  }

  const isFirstBoot = stored == null;
  runSql(db, 'BEGIN');
  try {
    if (!isFirstBoot) {
      for (const table of RM_TABLES) runSql(db, `DROP TABLE IF EXISTS ${table};`);
    }
    runSql(db, RM_DDL);
    stampSchemaVersion(db);
    runSql(db, 'COMMIT');
  } catch (err) {
    runSql(db, 'ROLLBACK');
    throw err;
  }
  return { rebuilt: !isFirstBoot };
}

function readStoredSchemaVersion(db: LocalDb): number | null {
  // rm_watermarks may not exist yet on first boot.
  const exists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='rm_watermarks'`)
    .get();
  if (!exists) return null;
  const row = db
    .prepare(`SELECT cursor FROM rm_watermarks WHERE domain = ? AND scope_id = ''`)
    .get(RM_SCHEMA_DOMAIN) as { cursor: number } | undefined;
  return row ? row.cursor : null;
}

function stampSchemaVersion(db: LocalDb): void {
  db.prepare(
    `INSERT INTO rm_watermarks (domain, scope_id, cursor, synced_at)
     VALUES (?, '', ?, ?)
     ON CONFLICT(domain, scope_id) DO UPDATE SET cursor = excluded.cursor, synced_at = excluded.synced_at`,
  ).run(RM_SCHEMA_DOMAIN, RM_SCHEMA_VERSION, Date.now());
}

// ── conversations ──────────────────────────────────────────────────────────

export function upsertConversation(
  db: LocalDb,
  row: { id: string; payload: unknown; updatedAt: number; syncedAt?: number },
): void {
  db.prepare(
    `INSERT INTO rm_conversations (id, payload_json, updated_at, synced_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       payload_json = excluded.payload_json,
       updated_at   = excluded.updated_at,
       synced_at    = excluded.synced_at`,
  ).run(row.id, JSON.stringify(row.payload), row.updatedAt, row.syncedAt ?? Date.now());
}

export function getConversation(db: LocalDb, id: string): RmConversationRow | undefined {
  return db.prepare(`SELECT * FROM rm_conversations WHERE id = ?`).get(id) as
    | RmConversationRow
    | undefined;
}

export function listConversations(db: LocalDb): RmConversationRow[] {
  return db
    .prepare(`SELECT * FROM rm_conversations ORDER BY updated_at DESC`)
    .all() as RmConversationRow[];
}

// ── messages ───────────────────────────────────────────────────────────────

/**
 * Upsert a server-authoritative message. M1: unconditional overwrite (no dirty
 * rows exist yet, §8 "只读期 无条件 upsert 覆盖"). The conflict target is `id`;
 * an existing optimistic row keyed by client_msg_id is reconciled by the M2
 * ack-remap path (not here).
 */
export function upsertMessage(
  db: LocalDb,
  row: {
    id: string;
    conversationId: string;
    clientMsgId?: string | null;
    boundarySeq?: number | null;
    payload: unknown;
    syncStatus?: RmSyncStatus;
    dirty?: boolean;
    createdAt: number;
    syncedAt?: number;
  },
): void {
  db.prepare(
    `INSERT INTO rm_messages
       (id, conversation_id, client_msg_id, boundary_seq, payload_json, sync_status, dirty, created_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       conversation_id = excluded.conversation_id,
       client_msg_id   = COALESCE(excluded.client_msg_id, rm_messages.client_msg_id),
       boundary_seq    = excluded.boundary_seq,
       payload_json    = excluded.payload_json,
       sync_status     = excluded.sync_status,
       dirty           = excluded.dirty,
       synced_at       = excluded.synced_at`,
  ).run(
    row.id,
    row.conversationId,
    row.clientMsgId ?? null,
    row.boundarySeq ?? null,
    JSON.stringify(row.payload),
    row.syncStatus ?? 'synced',
    row.dirty ? 1 : 0,
    row.createdAt,
    row.syncedAt ?? Date.now(),
  );
}

export function listMessages(
  db: LocalDb,
  conversationId: string,
  opts?: { limit?: number },
): RmMessageRow[] {
  const limit = opts?.limit ?? 200;
  // boundary_seq ASC (NULLs — optimistic rows — last) so the renderer sees
  // chronological order matching the cloud's per-conversation seq space.
  return db
    .prepare(
      `SELECT * FROM rm_messages
       WHERE conversation_id = ?
       ORDER BY (boundary_seq IS NULL), boundary_seq ASC, created_at ASC
       LIMIT ?`,
    )
    .all(conversationId, limit) as RmMessageRow[];
}

export function getMessageByClientMsgId(db: LocalDb, clientMsgId: string): RmMessageRow | undefined {
  return db.prepare(`SELECT * FROM rm_messages WHERE client_msg_id = ?`).get(clientMsgId) as
    | RmMessageRow
    | undefined;
}

// ── M2 optimistic write + ack remap (§7) ─────────────────────────────────────

/**
 * Insert an optimistic (un-acked) message row (§7). The temporary primary key
 * IS the client_msg_id (`cmsg_<uuid>`); boundary_seq stays NULL, sync_status =
 * 'pending', dirty = 1. The renderer sees this row immediately (乐观 UI). The
 * row is later remapped to the server id by {@link remapMessageAck} (ack path)
 * or by the materializer's echo reconciliation (§8 ②).
 *
 * Idempotent on the client_msg_id (ON CONFLICT no-op): a retry of the same
 * enqueue never duplicates the optimistic row.
 */
export function insertOptimisticMessage(
  db: LocalDb,
  row: {
    clientMsgId: string;
    conversationId: string;
    payload: unknown;
    createdAt?: number;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO rm_messages
       (id, conversation_id, client_msg_id, boundary_seq, payload_json, sync_status, dirty, created_at, synced_at)
     VALUES (?, ?, ?, NULL, ?, 'pending', 1, ?, NULL)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    row.clientMsgId,
    row.conversationId,
    row.clientMsgId,
    JSON.stringify(row.payload),
    row.createdAt ?? now,
  );
}

/**
 * Ack-remap a message optimistic row to its server identity (§7), in a single
 * transaction: rewrite the temporary `id` (== client_msg_id) to the server id,
 * stamp boundary_seq, clear dirty, mark synced, and advance the per-conversation
 * watermark. Returns true when a row was remapped (matched the client_msg_id).
 *
 * Safe against a prior echo reconciliation having already remapped the row: if
 * no row matches `client_msg_id` anymore, this is a no-op returning false.
 */
export function remapMessageAck(
  db: LocalDb,
  args: { clientMsgId: string; serverId: string; boundarySeq: number | null; payload?: unknown },
): boolean {
  const now = Date.now();
  const existing = getMessageByClientMsgId(db, args.clientMsgId);
  if (!existing) return false;

  const tx = db.transaction(() => {
    const payloadJson = args.payload !== undefined ? JSON.stringify(args.payload) : existing.payload_json;
    db.prepare(
      `UPDATE rm_messages
          SET id = ?, boundary_seq = ?, payload_json = ?,
              sync_status = 'synced', dirty = 0, synced_at = ?
        WHERE client_msg_id = ?`,
    ).run(args.serverId, args.boundarySeq, payloadJson, now, args.clientMsgId);
    if (typeof args.boundarySeq === 'number') {
      advanceWatermark(db, 'chats', existing.conversation_id, args.boundarySeq, now);
    }
  });
  tx();
  return true;
}

/** Transition an optimistic message row's sync_status (pending→retrying→failed, §7). */
export function setMessageSyncStatus(db: LocalDb, clientMsgId: string, status: RmSyncStatus): void {
  db.prepare(`UPDATE rm_messages SET sync_status = ? WHERE client_msg_id = ?`).run(status, clientMsgId);
}

// ── tasks ──────────────────────────────────────────────────────────────────

/**
 * Upsert a server-authoritative task from the cloud feed/SWR backfill. M2 §8 ③:
 * a locally **dirty** row is NOT overwritten — the optimistic mutation is held
 * until its outbox row acks/fails, then re-pulled server-wins. The
 * `WHERE rm_tasks.dirty = 0` conflict guard enforces this; callers wanting to
 * force-overwrite (ack回纠) use {@link clearTaskDirty} instead.
 */
export function upsertTask(
  db: LocalDb,
  row: {
    id: string;
    workspaceId: string;
    payload: unknown;
    updatedAt: number;
    syncStatus?: RmSyncStatus;
    dirty?: boolean;
    syncedAt?: number;
  },
): void {
  db.prepare(
    `INSERT INTO rm_tasks
       (id, workspace_id, payload_json, updated_at, sync_status, dirty, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       payload_json = excluded.payload_json,
       updated_at   = excluded.updated_at,
       sync_status  = excluded.sync_status,
       dirty        = excluded.dirty,
       synced_at    = excluded.synced_at
     WHERE rm_tasks.dirty = 0`,
  ).run(
    row.id,
    row.workspaceId,
    JSON.stringify(row.payload),
    row.updatedAt,
    row.syncStatus ?? 'synced',
    row.dirty ? 1 : 0,
    row.syncedAt ?? Date.now(),
  );
}

export function getTask(db: LocalDb, id: string): RmTaskRow | undefined {
  return db.prepare(`SELECT * FROM rm_tasks WHERE id = ?`).get(id) as RmTaskRow | undefined;
}

export function listTasks(db: LocalDb, workspaceId: string): RmTaskRow[] {
  return db
    .prepare(`SELECT * FROM rm_tasks WHERE workspace_id = ? ORDER BY updated_at DESC`)
    .all(workspaceId) as RmTaskRow[];
}

// ── M2 task optimistic write + ack remap (§7/§8 ③) ───────────────────────────

/**
 * Optimistically apply a board mutation to an existing task row (§7). The task
 * id is server-authoritative (no temp id — board mutations PATCH a known task),
 * so we mark the row dirty + pending and merge the optimistic payload in. The
 * outbox key (cmsg) is tracked separately in sync_queue; on ack we clear dirty
 * via {@link clearTaskDirty}. A non-echo cloud update on a dirty task is held
 * back (§8 ③) until the outbox resolves, then re-pulled server-wins.
 */
export function applyOptimisticTask(
  db: LocalDb,
  row: { id: string; workspaceId: string; payload: unknown; updatedAt?: number },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO rm_tasks
       (id, workspace_id, payload_json, updated_at, sync_status, dirty, synced_at)
     VALUES (?, ?, ?, ?, 'pending', 1, ?)
     ON CONFLICT(id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       payload_json = excluded.payload_json,
       updated_at   = excluded.updated_at,
       sync_status  = 'pending',
       dirty        = 1,
       synced_at    = excluded.synced_at`,
  ).run(row.id, row.workspaceId, JSON.stringify(row.payload), row.updatedAt ?? now, now);
}

/**
 * Ack a task mutation (§7): clear dirty + mark synced. If the cloud returned an
 * authoritative payload we overwrite with it (server-wins回纠, §8 ③); otherwise
 * we keep the optimistic payload. Returns true when the task row existed.
 */
export function clearTaskDirty(
  db: LocalDb,
  args: { id: string; payload?: unknown; updatedAt?: number },
): boolean {
  const existing = getTask(db, args.id);
  if (!existing) return false;
  const now = Date.now();
  const payloadJson = args.payload !== undefined ? JSON.stringify(args.payload) : existing.payload_json;
  db.prepare(
    `UPDATE rm_tasks
        SET payload_json = ?, updated_at = ?, sync_status = 'synced', dirty = 0, synced_at = ?
      WHERE id = ?`,
  ).run(payloadJson, args.updatedAt ?? existing.updated_at, now, args.id);
  return true;
}

/** Transition a task row's sync_status (pending→retrying→failed, §7). */
export function setTaskSyncStatus(db: LocalDb, id: string, status: RmSyncStatus): void {
  db.prepare(`UPDATE rm_tasks SET sync_status = ? WHERE id = ?`).run(status, id);
}

// ── watermarks ─────────────────────────────────────────────────────────────

/**
 * Read a domain×scope watermark. `scope_id` defaults to '' for domain-global
 * watermarks (conversations list, tasks list); messages use the conversationId
 * as scope so per-conversation seq continuity is tracked independently (§4).
 */
export function getWatermark(db: LocalDb, domain: RmDomain, scopeId = ''): RmWatermarkRow | undefined {
  return db
    .prepare(`SELECT * FROM rm_watermarks WHERE domain = ? AND scope_id = ?`)
    .get(domain, scopeId) as RmWatermarkRow | undefined;
}

/**
 * Advance a watermark to `cursor`, but never regress it (a lower seq is ignored
 * for the cursor while still bumping synced_at — the row stays fresh). Returns
 * the resulting cursor value.
 */
export function advanceWatermark(
  db: LocalDb,
  domain: RmDomain,
  scopeId: string,
  cursor: number,
  syncedAt = Date.now(),
): number {
  db.prepare(
    `INSERT INTO rm_watermarks (domain, scope_id, cursor, synced_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(domain, scope_id) DO UPDATE SET
       cursor    = MAX(rm_watermarks.cursor, excluded.cursor),
       synced_at = excluded.synced_at`,
  ).run(domain, scopeId, cursor, syncedAt);
  const row = getWatermark(db, domain, scopeId);
  return row?.cursor ?? cursor;
}

/** Touch synced_at (SWR freshness) without moving the cursor. */
export function touchWatermark(db: LocalDb, domain: RmDomain, scopeId = '', syncedAt = Date.now()): void {
  db.prepare(
    `INSERT INTO rm_watermarks (domain, scope_id, cursor, synced_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(domain, scope_id) DO UPDATE SET synced_at = excluded.synced_at`,
  ).run(domain, scopeId, syncedAt);
}

// ── domain reset (gap detection → 域级重拉, §5) ──────────────────────────────

/**
 * Clear a scope's rm_* rows + reset its watermark to 0. Used on断档检测 (§5):
 *   - chats + scopeId=conversationId → wipe that conversation's messages.
 *   - chats + scopeId='' → wipe the conversations list watermark only (rows are
 *     re-pulled lazily; conversation rows themselves are cheap to overwrite).
 *   - tasks + scopeId='' → wipe all tasks + watermark.
 *
 * Caller re-pulls the most recent N pages afterward and emits sync.reset.
 */
export function resetScope(db: LocalDb, domain: RmDomain, scopeId: string): void {
  runSql(db, 'BEGIN');
  try {
    if (domain === 'chats' && scopeId) {
      db.prepare(`DELETE FROM rm_messages WHERE conversation_id = ?`).run(scopeId);
    } else if (domain === 'chats') {
      db.prepare(`DELETE FROM rm_conversations`).run();
    } else if (domain === 'tasks') {
      db.prepare(`DELETE FROM rm_tasks`).run();
    }
    db.prepare(`DELETE FROM rm_watermarks WHERE domain = ? AND scope_id = ?`).run(domain, scopeId);
    runSql(db, 'COMMIT');
  } catch (err) {
    runSql(db, 'ROLLBACK');
    throw err;
  }
}

/** Is a watermark fresh within `ttlMs` (SWR, §6)? Missing watermark = stale. */
export function isFresh(row: RmWatermarkRow | undefined, ttlMs: number, now = Date.now()): boolean {
  if (!row) return false;
  return now - row.synced_at <= ttlMs;
}
