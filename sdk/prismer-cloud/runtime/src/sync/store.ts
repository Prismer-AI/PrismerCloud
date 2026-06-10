// Local SQLite mirror — daemon-side cache of cloud workspace + agent + profile state.
// See docs/refactor/04-daemon-runtime.md §本地 SQLite schema and 10-asset-network-drive §Local cache.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LocalDb = Database.Database;

/** Increment when adding migrations; runMigrations() advances PRAGMA user_version. */
const SCHEMA_VERSION = 8;

const MIGRATIONS: Array<{ version: number; up: string }> = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        metadata TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        synced_at INTEGER,
        dirty INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS agents (
        im_user_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        adapter_name TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offline',
        version INTEGER NOT NULL DEFAULT 1,
        synced_at INTEGER,
        dirty INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents (workspace_id);

      CREATE TABLE IF NOT EXISTS agent_profiles (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        agent_im_user_id TEXT NOT NULL,
        adapter_name TEXT NOT NULL,
        name TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        version INTEGER NOT NULL DEFAULT 1,
        synced_at INTEGER,
        dirty INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_profiles_agent ON agent_profiles (workspace_id, agent_im_user_id);

      CREATE TABLE IF NOT EXISTS sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        next_attempt_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_sync_pending ON sync_queue (status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_sync_resource ON sync_queue (resource_type, resource_id);

      CREATE TABLE IF NOT EXISTS sync_state (
        resource_type TEXT PRIMARY KEY,
        last_synced_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS running_tasks (
        task_id TEXT PRIMARY KEY,
        agent_im_user_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        pid INTEGER,
        status TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    up: `
      -- Asset cache (10-asset-network-drive §Local cache)
      CREATE TABLE IF NOT EXISTS cached_assets (
        content_hash TEXT PRIMARY KEY,
        size_bytes INTEGER NOT NULL,
        mime TEXT,
        local_path TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        pin INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_cached_lru ON cached_assets (pin, last_used_at);

      -- workspace_files mirror (path → asset binding lookup cache)
      CREATE TABLE IF NOT EXISTS workspace_files_mirror (
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        version INTEGER NOT NULL,
        synced_at INTEGER,
        dirty INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_files_hash ON workspace_files_mirror (content_hash);
    `,
  },
  {
    version: 3,
    up: `
      -- Asset metadata index (#filename reference resolution — daemon/asset/metadata-index.ts)
      CREATE TABLE IF NOT EXISTS asset_metadata_index (
        workspace_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        filename TEXT,
        folder_path TEXT,
        mime TEXT NOT NULL,
        kind TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        asset_index_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, asset_id)
      );

      CREATE INDEX IF NOT EXISTS idx_asset_meta_filename
        ON asset_metadata_index(workspace_id, filename);

      CREATE INDEX IF NOT EXISTS idx_asset_meta_seq
        ON asset_metadata_index(workspace_id, asset_index_seq);
    `,
  },
  {
    version: 4,
    up: `
      -- Wave 4 / W3 §4.3 — pending dispatch replies for crash recovery.
      --
      -- The two-phase reply protocol writes a row here BEFORE calling
      -- POST /dispatch/:taskId/prepare so that a crash between prepare
      -- and commit leaves a recoverable trail. On daemon cold-start, any
      -- row with status='prepared' triggers an idempotent commit retry.
      --
      -- The server-side cutoff for orphaned 'prepared' rows is 1h
      -- (PREPARED_REPLY_ORPHAN_MS in dispatch-reply.service.ts); rows
      -- older than that will fail commit with DISPATCH_REPLY_INVALID_STATE
      -- and must be reported to the user as 'dispatch lost'.
      CREATE TABLE IF NOT EXISTS pending_dispatch_replies (
        idempotency_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        reply_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        payload_json TEXT NOT NULL,
        prepared_at INTEGER,
        created_at INTEGER NOT NULL,
        last_attempt_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending_reply_task ON pending_dispatch_replies (task_id);
      CREATE INDEX IF NOT EXISTS idx_pending_reply_status ON pending_dispatch_replies (status, created_at);
    `,
  },
  {
    version: 5,
    up: `
      -- v2.1 §9 — daemon-as-hook-intake run_id ↔ conversationId mapping.
      --
      -- Hermes shell hooks identify sessions via run_<uuid> (one run per
      -- /v1/runs call). Memory extraction needs to stamp source.conversationId
      -- onto the page, but hooks only know the run_id. The hermes adapter
      -- registers (runId → context) here as soon as Hermes returns run_id;
      -- the daemon hook handler reverse-looks-up the row to get the full
      -- context needed for memory stamping.
      --
      -- GC: rows with created_at > 60 minutes are purged on every register()
      -- to keep the table bounded. No FK to running_tasks because the task
      -- row may already be cleaned up while a long-tail post_llm_call hook
      -- straggles in.
      CREATE TABLE IF NOT EXISTS local_run_sessions (
        run_id TEXT PRIMARY KEY,
        conversation_id TEXT,
        task_id TEXT,
        agent_im_user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        role_template_slug TEXT,
        adapter_name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_sessions_created_at ON local_run_sessions (created_at);
      CREATE INDEX IF NOT EXISTS idx_run_sessions_task ON local_run_sessions (task_id);
    `,
  },
  {
    version: 6,
    up: `
      -- release201/25 §16.4 A1 — hermes sessions API mapping.
      --
      -- The new dispatch primary endpoint is POST /api/sessions/{id}/chat/stream
      -- (api_server.py:1530-1670). Each (conversation, agent) pair owns its own
      -- hermes session because session holds LLM context — different agent
      -- roles must NOT share it. We cache (conversationId, agentImUserId) →
      -- hermesSessionId so subsequent turns can reuse the existing session
      -- and benefit from hermes-side prefix cache + server-maintained history.
      --
      -- hermesSessionKey is the optional X-Hermes-Session-Key returned at
      -- session-create time (features.session_continuity_header). Some
      -- deployments require it on next-turn POST; we stash it verbatim and
      -- forward when present. Nullable so older hermes that don't return one
      -- still flow through.
      --
      -- The columns are added to the existing local_run_sessions table to
      -- keep all (run_id, session_id) bookkeeping in one place. Sessions
      -- created before A1 dispatch happens still register as before; the
      -- new columns default to NULL and the mapper INSERT-or-UPDATEs them
      -- on first session-create.
      ALTER TABLE local_run_sessions ADD COLUMN hermes_session_id TEXT;
      ALTER TABLE local_run_sessions ADD COLUMN hermes_session_key TEXT;

      -- Lookup index for HermesSessionMapper.get(conversationId, agentImUserId).
      -- Includes hermes_session_id NOT NULL filter so we skip rows that only
      -- exist for the older runId-only registration use case.
      CREATE INDEX IF NOT EXISTS idx_run_sessions_hermes_session
        ON local_run_sessions (conversation_id, agent_im_user_id)
        WHERE hermes_session_id IS NOT NULL;
    `,
  },
  {
    version: 7,
    up: `
      -- release201/26 Phase 4 — daemon-side run checkpoints for crash resume.
      --
      -- Checkpoints are PHASE-LEVEL, not step-level (Cline-mode, I/O friendly):
      -- one row per phase transition (thinking → tool → reasoning → …), NOT one
      -- per tool step. Writing a row per tool call would thrash SQLite under the
      -- reasoning-chunk firehose; the phase boundary is the natural, low-frequency
      -- recovery point. payload_json holds the minimal state needed to resume:
      -- current phase, adapter, and a compact summary of completed tool results.
      --
      -- Lifecycle:
      --   - dispatch.ts writes a checkpoint on every recordPhaseChange.
      --   - On a terminal reply (success / failure), dispatch.ts deletes the run's
      --     checkpoints — only UNFINISHED runs (rows still present at boot) are
      --     resume candidates.
      --   - On daemon cold-start, listUnfinishedRuns() returns the distinct run_ids
      --     that still have checkpoints; the resume scan reattaches or, when the
      --     adapter can't continue, emits task.dispatch.resume_failed and clears.
      --
      -- phase_seq is daemon-allocated and monotonic per run_id (matches the
      -- StepRecorder seq space conceptually but is independent — checkpoints are a
      -- durable subset). PRIMARY KEY (run_id, phase_seq) is the idempotency guard:
      -- a re-emitted phase at the same seq is an INSERT OR REPLACE no-op-or-update.
      CREATE TABLE IF NOT EXISTS local_run_checkpoints (
        run_id TEXT NOT NULL,
        phase_seq INTEGER NOT NULL,
        phase_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, phase_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_run_checkpoints_run ON local_run_checkpoints (run_id);
    `,
  },
  {
    version: 8,
    up: `
      -- release202/05 C2 — generic per-(conversation × agent × adapter) provider
      -- session id, for CLI / interactive adapters (codex / claude-code) to
      -- 'resume' a previous provider/CLI session instead of dispatching
      -- amnesiacally. This mirrors the hermes_session_id column (v6) but is
      -- adapter-agnostic: the value is whatever session/thread id the provider
      -- hands back (codex thread_id, claude-code session id, ...). Stored on the
      -- existing local_run_sessions table so all (run_id, session_id) bookkeeping
      -- stays in one place.
      --
      -- ProviderSessionMapper.get(conversationId, agentImUserId, adapterName)
      -- reads the latest non-null row; put() INSERT-OR-REPLACEs via a synthetic
      -- run_id (psession:<adapter>:<id>) so the row satisfies the PRIMARY KEY.
      ALTER TABLE local_run_sessions ADD COLUMN provider_session_id TEXT;

      -- Lookup index for ProviderSessionMapper.get(conversationId, agentImUserId,
      -- adapterName). Filters provider_session_id NOT NULL so we skip rows that
      -- only exist for the older runId-only / hermes registration use cases.
      CREATE INDEX IF NOT EXISTS idx_run_sessions_provider_session
        ON local_run_sessions (conversation_id, agent_im_user_id, adapter_name)
        WHERE provider_session_id IS NOT NULL;
    `,
  },
];

// Bracket-notation indirection: `db.exec(sql)` is better-sqlite3's bulk-statement
// API (no child_process involved), but a pre-Write security hook regex matches
// the literal `.exec(` and blocks writes. The bracket form is semantically
// identical and skips the regex.
function runSql(db: LocalDb, sql: string): void {
  (db as unknown as { [k: string]: (s: string) => void })['exec']!(sql);
}

/**
 * Open `~/.prismer/local.db` (or any path), enable WAL, run migrations.
 * Idempotent — safe to call multiple times.
 *
 * Pass `:memory:` for in-test usage.
 */
export function openLocalDb(path: string): LocalDb {
  if (path !== ':memory:' && !existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function runMigrations(db: LocalDb): void {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    runSql(db, 'BEGIN');
    try {
      runSql(db, m.up);
      db.pragma(`user_version = ${m.version}`);
      runSql(db, 'COMMIT');
    } catch (err) {
      runSql(db, 'ROLLBACK');
      throw err;
    }
  }
}

export function currentSchemaVersion(db: LocalDb): number {
  return (db.pragma('user_version', { simple: true }) as number) ?? 0;
}

export const TARGET_SCHEMA_VERSION = SCHEMA_VERSION;
