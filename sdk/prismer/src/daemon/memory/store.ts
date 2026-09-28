// SQLite-backed memory store.
//
// One MemoryStore instance per workspace. Daemon owns the multi-workspace pool
// (rpc.ts resolves a store per request). Schema covers:
//
//   memory_schema_version    — single-row migration ratchet
//   memory_pages             — current state of each page (workspace-scoped UNIQUE on path)
//   memory_page_versions     — immutable version history
//   memory_page_content      — payload (inline plaintext or blobRef URI) per version
//   memory_links             — page→page graph (unique on workspace+source+target+relation)
//   memory_fts               — FTS5 virtual over title/path/description/content
//   memory_outbox            — write-only in phase-0 (worker disabled per dispatcher)
//   memory_outbox_dead_letter
//   memory_inbox_cursor      — phase-1 high-water mark for cloud→daemon sync
//
// File perms enforced on open(): 0o600 db file, 0o700 parent dir. Single
// workspace invariant: writes for a different workspaceId are rejected so a
// misrouted request cannot silently leak data across stores.

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type {
  MemoryPage,
  MemoryPageContent,
  MemoryLink,
  MemoryWriteInput,
  MemoryStats,
  MemoryPageType,
  MemoryVisibility,
  MemorySyncStatus,
} from './types.js';
import { sealPlaintext } from './crypto.js';
import { getMemoryAuthoritySnapshot } from './cap.js';

export interface MemoryStoreOptions {
  /** Absolute path to the SQLite database file. Parent dir created with 0o700 if absent. */
  dbPath: string;
  /** Workspace this store belongs to. Reject ops referencing other workspaces. */
  workspaceId: string;
  /** Device identifier. Stamped onto version + outbox rows at write time. */
  deviceId: string;
  /**
   * memory202 doc 06 (at-rest encryption MVP) — at-rest encryption activation
   * policy for LOCALLY-AUTHORED writes. Consulted only when a write does NOT
   * explicitly set `encrypted` (so cloud→local down-sync, which passes an
   * explicit `encrypted` per page, is never auto-overridden). Returns true to
   * mark the page `encrypted=true` (intent flag → outbox encrypts the
   * cloud-bound copy; local row stays plaintext). The wiring binds this to
   * "FF_MEMORY_ENCRYPTION_ENABLED on AND a durable workspace key exists AND not
   * ephemeral" — fail-safe: omitted ⇒ never auto-encrypt (today's behavior).
   */
  encryptionPolicy?: () => boolean;
}

// V4 (memory211/01 W2 #7) — memory_fts gains the `cjk` bigram column. The FTS
// table is a pure derived index over memory_pages, so the migration is a drop +
// recreate + re-index (no user data touched, and local.db is a rebuildable cache).
//
// V6 (memory211/01 W4 轴F) — `asset_chunks` gains `sid` (the lazy-minted span
// identity). NULL = the chunk was never cited by a distilled page = still T3
// raw; non-NULL = cited + minted = T2 asset (mint IS the promotion). Additive
// column on a rebuildable mirror — same policy as V5.
export const SCHEMA_VERSION = 6;

// ---- path-namespace normalization (memory203/18 W2 P0) ---------------------
//
// Two page-path conventions coexist in live workspaces (`memory/decisions/…`
// vs `decisions/…`). The canonical URI is
// `prismer://workspace/<ws>/memory/<path>` — composing it from a path that
// ALREADY starts with `memory/` doubled the prefix (`…/memory/memory/…`),
// which the cloud link-materializer silently dropped (W1-gate: 3/3 agent
// child-of link.upsert events → 0 rows). ONE shared normalizer, used by every
// URI composition site (rpc.ts handleWrite, hook-server writeExtractedPage)
// and by variant-tolerant local lookups.

/**
 * Canonical plain page path: no leading slashes, no leading `memory/`
 * namespace segment(s). Idempotent.
 */
export function normalizeMemoryPath(pagePath: string): string {
  let out = pagePath.trim().replace(/^\/+/, '');
  while (out.startsWith('memory/')) out = out.slice('memory/'.length);
  return out;
}

/**
 * Canonical memory-page URI for a workspace-relative path. Strips a leading
 * `memory/` before composing so `memory/decisions/x.pkf` and
 * `decisions/x.pkf` yield the SAME resolvable URI (never `…/memory/memory/…`).
 */
export function memoryPathToUri(workspaceId: string, pagePath: string): string {
  return `prismer://workspace/${workspaceId}/memory/${normalizeMemoryPath(pagePath)}`;
}

/**
 * Lookup candidates for a local store read: as-given, then with/without the
 * leading `memory/` prefix, then each ±`.pkf`. Order matters — the verbatim
 * path wins when it exists (no silent re-pointing of an exact hit).
 */
export function memoryPathLookupVariants(pagePath: string): string[] {
  const raw = pagePath.trim().replace(/^\/+/, '');
  const norm = normalizeMemoryPath(raw);
  const bases = raw === norm ? [raw, `memory/${norm}`] : [raw, norm];
  const out: string[] = [];
  for (const b of bases) {
    if (!b) continue;
    out.push(b);
    out.push(b.endsWith('.pkf') ? b.slice(0, -'.pkf'.length) : `${b}.pkf`);
  }
  return [...new Set(out)];
}

// ─── CJK bigram projection (memory211/01 W2 #7) ─────────────────────────────
//
// FTS5's `unicode61` tokenizer has no CJK word boundaries: a contiguous run of
// han/kana/hangul becomes ONE token, so a 2-char Chinese query term can never
// match inside a longer run. Measured on the bundled SQLite (3.49) before this
// change: content `…金门标准…` MATCHes `"金门标准"` (exact run) but NOT
// `"金门"`. The standard remedy without a custom tokenizer is a bigram index:
// store the adjacent-2-gram projection in its own FTS column and let the query
// side OR its bigrams against it. Pure + exported so the search side and the
// tests share ONE definition.

/** Contiguous CJK runs (han + kana + hangul) of a string, in order. */
export function cjkRuns(text: string): string[] {
  return text.match(/[㐀-鿿豈-﫿぀-゠ヿ-鿿가-힯]+/g) ?? [];
}

/**
 * The CJK bigram projection of the given texts, joined with spaces so FTS5 sees
 * each bigram as its own token. ASCII/latin text contributes nothing (the main
 * `content`/`title`/`description` columns already index it word-wise).
 */
export function cjkBigramText(...parts: string[]): string {
  const grams: string[] = [];
  for (const part of parts) {
    for (const run of cjkRuns(part)) {
      if (run.length === 1) {
        grams.push(run);
        continue;
      }
      for (let i = 0; i + 2 <= run.length; i++) grams.push(run.slice(i, i + 2));
    }
  }
  return grams.join(' ');
}

// DDL split per-statement so each can run via prepare().run(); avoids the
// multi-statement batch API and keeps the schema easy to diff per table.
const SCHEMA_V1_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memory_schema_version (
     version INTEGER PRIMARY KEY
   )`,
  `CREATE TABLE IF NOT EXISTS memory_pages (
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
   )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_pages_workspace_type ON memory_pages(workspaceId, pageType)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_pages_workspace_updated ON memory_pages(workspaceId, updatedAt DESC)`,
  `CREATE TABLE IF NOT EXISTS memory_page_versions (
     pageId TEXT NOT NULL,
     version INTEGER NOT NULL,
     contentHash TEXT NOT NULL,
     actorImUserId TEXT NOT NULL,
     actorKind TEXT NOT NULL,
     deviceId TEXT NOT NULL,
     createdAt INTEGER NOT NULL,
     PRIMARY KEY (pageId, version),
     FOREIGN KEY (pageId) REFERENCES memory_pages(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS memory_page_content (
     pageId TEXT NOT NULL,
     version INTEGER NOT NULL,
     payloadKind TEXT NOT NULL,
     payloadValue TEXT NOT NULL,
     PRIMARY KEY (pageId, version),
     FOREIGN KEY (pageId, version) REFERENCES memory_page_versions(pageId, version) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS memory_links (
     workspaceId TEXT NOT NULL,
     sourceUri TEXT NOT NULL,
     targetUri TEXT NOT NULL,
     relation TEXT NOT NULL,
     weight REAL NOT NULL DEFAULT 1.0,
     extractedFromPageId TEXT,
     createdAt INTEGER NOT NULL,
     PRIMARY KEY (workspaceId, sourceUri, targetUri, relation)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(workspaceId, targetUri, relation)`,
  // memory211/01 W2 #7 — the `cjk` column carries the CJK-BIGRAM projection of
  // the row (see cjkBigramText). FTS5's unicode61 tokenizer keeps a whole
  // contiguous CJK run as ONE token, so a 2-char Chinese query term can never
  // match inside a longer run ("金门" ∉ token "金门标准") — measured on the
  // bundled SQLite before this change. Indexing bigrams gives Chinese the same
  // substring recall ASCII gets from word splitting; the column is APPENDED so
  // the existing column indices (search.ts snippets column 5 = content) are
  // unchanged and snippet() output stays the real text, not bigram soup.
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
     pageId UNINDEXED,
     workspaceId UNINDEXED,
     path,
     title,
     description,
     content,
     cjk,
     tokenize = 'porter unicode61 remove_diacritics 1'
   )`,
  `CREATE TABLE IF NOT EXISTS memory_outbox (
     id TEXT PRIMARY KEY,
     eventType TEXT NOT NULL,
     envelopeJson TEXT NOT NULL,
     idempotencyKey TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL DEFAULT 'pending',
     createdAt INTEGER NOT NULL,
     ackedAt INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_outbox_status ON memory_outbox(status, createdAt)`,
  `CREATE TABLE IF NOT EXISTS memory_outbox_dead_letter (
     id TEXT PRIMARY KEY,
     eventType TEXT,
     rawJson TEXT NOT NULL,
     errorJson TEXT NOT NULL,
     createdAt INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS memory_inbox_cursor (
     workspaceId TEXT PRIMARY KEY,
     cursor TEXT NOT NULL,
     updatedAt INTEGER NOT NULL
   )`,
];

const SCHEMA_V2_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memory_post_turn_applies (
     post_turn_key TEXT NOT NULL,
     result_hash TEXT NOT NULL,
     page_index INTEGER NOT NULL,
     path TEXT NOT NULL,
     content_hash TEXT NOT NULL,
     page_id TEXT NOT NULL,
     page_version INTEGER NOT NULL,
     page_outbox_id TEXT NOT NULL,
     link_outbox_id TEXT,
     applied_at INTEGER NOT NULL,
     PRIMARY KEY (post_turn_key, result_hash, page_index)
   )`,
];

// ── product209/16 §9.4 — SCHEMA_V3（MA-2 scoped replica）─────────────────────
//
// memory_replica_state carries the per-workspace replica authority: opaque
// manifest cursor, pinned accessVersion / replicaSubjectHash, the content
// high watermark fixed by the first manifest page, the reconciling|ready|
// suspended|stale state machine and the snapshot lease bound. The OLD
// memory_inbox_cursor table is READ-ONLY from V3 on (migration source for the
// cursor value); it is never an authorization input. memory_pages gains
// sourceKind (pkf | legacy-html | encrypted-pkf) and replicaActorIdsJson
// (sorted exact actor set from the Cloud — NULL only for pre-V3/local-authored
// rows; a strict replicated row is always a non-null JSON array).
const SCHEMA_V3_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memory_replica_state (
     workspaceId TEXT PRIMARY KEY,
     cursor TEXT,
     accessVersion INTEGER NOT NULL,
     replicaSubjectHash TEXT NOT NULL,
     contentHighWatermarkJson TEXT,
     status TEXT NOT NULL,
     leaseExpiresAt INTEGER NOT NULL,
     updatedAt INTEGER NOT NULL
   )`,
  `ALTER TABLE memory_pages ADD COLUMN sourceKind TEXT NOT NULL DEFAULT 'pkf'`,
  `ALTER TABLE memory_pages ADD COLUMN replicaActorIdsJson TEXT`,
];

// V4 is a REBUILD, not an ALTER: SQLite cannot add a column to a virtual table,
// so the FTS index is dropped, recreated at the V4 shape and re-populated from
// the durable rows inside open(). Declared separately so the migration and the
// V1 bootstrap DDL stay literally identical.
const MEMORY_FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
     pageId UNINDEXED,
     workspaceId UNINDEXED,
     path,
     title,
     description,
     content,
     cjk,
     tokenize = 'porter unicode61 remove_diacritics 1'
   )`;

// ── memory211/01 W3 轴D — SCHEMA_V5（T3 raw-asset chunk mirror）──────────────
//
// asset_chunks mirrors the CLOUD authoritative `im_asset_chunks` (migration 567)
// into the daemon-local SQLite so recall stays fully local (F2 裁决: 断云时 T3
// 召回全功能 — the local-first rule at search.ts:3). Rows are addressed by
// (workspaceId, assetId, contentHash, ordinal), the SAME idempotency key the
// cloud upsert uses, so a daemon outbox replay and a cloud re-index converge on
// identical row sets. asset_chunks_fts is a SEPARATE index (not rows inside
// memory_fts) because a chunk has no memory_pages row — the wiki JOIN in
// search.ts would drop it, and a synthetic page id would lie about the corpus.
const SCHEMA_V5_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS asset_chunks (
     workspaceId TEXT NOT NULL,
     assetId TEXT NOT NULL,
     contentHash TEXT NOT NULL,
     ordinal INTEGER NOT NULL,
     text TEXT NOT NULL,
     tokenEstimate INTEGER NOT NULL,
     createdAt INTEGER NOT NULL,
     PRIMARY KEY (workspaceId, assetId, contentHash, ordinal)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_asset_chunks_ws_asset ON asset_chunks(workspaceId, assetId, ordinal)`,
  `CREATE INDEX IF NOT EXISTS idx_asset_chunks_ws_hash ON asset_chunks(workspaceId, contentHash)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS asset_chunks_fts USING fts5(
     assetId UNINDEXED,
     workspaceId UNINDEXED,
     ordinal UNINDEXED,
     path,
     title,
     content,
     cjk,
     tokenize = 'porter unicode61 remove_diacritics 1'
   )`,
];



/** product209/16 §9.2.1 — replica source kinds routed by the manifest. */
export type MemoryReplicaSourceKind = 'pkf' | 'legacy-html' | 'encrypted-pkf';

/** §9.4 replica state machine — the ONLY legal status values. */
export type MemoryReplicaStatus = 'reconciling' | 'ready' | 'suspended' | 'stale';

export interface MemoryReplicaStateRow {
  workspaceId: string;
  cursor: string | null;
  accessVersion: number;
  replicaSubjectHash: string;
  contentHighWatermarkJson: string | null;
  status: MemoryReplicaStatus;
  leaseExpiresAt: number;
  updatedAt: number;
}

/**
 * §9.4 — older runtime opening a newer-schema db must fail closed with a
 * TYPED error; the runtime must never downgrade-write a newer db (rollback =
 * upgrade the runtime, or discard the rebuildable cache).
 */
export class MemorySchemaIncompatibleError extends Error {
  readonly code = 'MEMORY_SCHEMA_INCOMPATIBLE';
  constructor(message: string) {
    super(message);
    this.name = 'MemorySchemaIncompatibleError';
  }
}

/**
 * §9.3/§9.5 — typed fail-closed for agent recall on a replica that is not
 * `ready` (reconciling / suspended / stale), whose lease expired while
 * offline, or whose registered authority snapshot is missing/drifted.
 * The daemon-internal system channel (reconcile, cloud-sync write-down) does
 * NOT pass through the gated read methods, so it is unaffected.
 */
export class MemoryReplicaNotReadyError extends Error {
  readonly code = 'MEMORY_REPLICA_NOT_READY';
  constructor(reason: string) {
    super(`memory replica not ready: ${reason}`);
    this.name = 'MemoryReplicaNotReadyError';
  }
}

/** One replicated head to land in the atomic reconcile commit (§9.3 step 9). */
export interface ReplicaHeadWrite {
  id: string;
  path: string;
  title: string | null;
  description: string | null;
  contentHash: string;
  version: number;
  pageType: string;
  visibilityKind: string;
  visibilityImUserId: string | null;
  stale: boolean;
  sourceRefsJson: string;
  sourceKind: MemoryReplicaSourceKind;
  /** SORTED exact actor set (Cloud-generated; empty array = deny all). */
  replicaActorIdsJson: string;
  /** Plaintext body to land locally (encrypted-pkf decrypted upstream). */
  content: string;
  updatedAtMs: number;
}

/** The ready-state half of the atomic commit (cursor/epoch/hash/lease/status). */
export interface ReplicaCommitState {
  cursor: string | null;
  accessVersion: number;
  replicaSubjectHash: string;
  contentHighWatermarkJson: string | null;
  leaseExpiresAt: number;
  status: 'ready';
}

export interface ReplicaCommitInput {
  heads: ReplicaHeadWrite[];
  /** Local controlled rows (replicaActorIdsJson NOT NULL) absent from the complete set (§9.3 step 7). */
  diffDeletePageIds: string[];
  /** Tombstone page aggregates to delete (§9.6). */
  tombstonePageIds: string[];
  state: ReplicaCommitState;
}

/** One 1-hop neighbor page reached via the link graph (see linkNeighbors). */
export interface MemoryLinkNeighbor {
  pageId: string;
  path: string;
  title: string | null;
  description: string | null;
  stale: boolean;
  updatedAt: number;
  /** Best edge weight on the link reaching this neighbor from a seed. */
  weight: number;
  /**
   * memory202/09 P1b: full page markdown (needed to slice a `#section` when the
   * reaching link addressed this neighbor at a section). Populated by
   * linkNeighbors so MemorySearch.expandViaGraph can produce a `sectionBody`.
   */
  content: string;
  /**
   * memory202/09 P1b: the `#section` anchor the reaching link carried for THIS
   * neighbor's end of the URI (target URI's anchor when seed=source, source
   * URI's anchor when seed=target). Undefined ⇒ page-level link → whole page.
   */
  section?: string;
}

/**
 * memory211/01 §3 轴C W1a — the hop-decision graph context for one page,
 * aggregated from the local `memory_links` mirror (see
 * {@link MemoryStore.pageGraphContext}).
 */
export interface MemoryPageGraphContext {
  pageId: string;
  path: string;
  version: number;
  pageType: string;
  /** Reverse `child-of` placement; null for a root / INDEX / unanchored page. */
  hubPath: string | null;
  inboundLinkCount: number;
  childrenCount: number;
  children: Array<{ path: string; title: string | null }>;
  outboundPreview: Array<{ relation: string; targetPath: string }>;
}

/**
 * memory211/01 §3 轴C W1a — one LOCAL link row in the cloud
 * `GET /memory/pages/:id/links` envelope shape (see
 * {@link MemoryStore.pageLinks}).
 */
export interface MemoryPageLinkRow {
  sourceUri: string;
  targetUri: string;
  sourcePageId: string | null;
  targetPageId: string | null;
  relation: string;
  weight: number;
  sourceSection: string | null;
  targetSection: string | null;
  updatedAt: string;
}

interface PageRow {
  id: string;
  workspaceId: string;
  path: string;
  title: string | null;
  description: string | null;
  contentHash: string;
  version: number;
  pageType: string;
  visibilityKind: string;
  visibilityImUserId: string | null;
  encrypted: number;
  stale: number;
  archivedAt: number | null;
  sourceAssetId: string | null;
  sourceRefsJson: string;
  syncStatus: string;
  createdAt: number;
  updatedAt: number;
  // §9.4 — V3 columns (always present from schema 3 on).
  sourceKind: string;
  replicaActorIdsJson: string | null;
}

/**
 * Page shape the store hands to readers on V3 — carries the replica columns
 * so the boundary predicate (acl-predicate.ts) can run the exact actor-set
 * check BEFORE coarse visibility rules. Structurally a superset of
 * {@link MemoryPage}; pre-V3 rows surface `replicaActorIds = null`.
 */
export type ReplicaAwareMemoryPage = MemoryPage & {
  sourceKind: MemoryReplicaSourceKind;
  replicaActorIds: string[] | null;
};

export class MemoryStore {
  private db: Database.Database | null = null;

  constructor(private readonly opts: MemoryStoreOptions) {}

  open(): void {
    if (this.db) return;

    const dir = path.dirname(this.opts.dbPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // mkdirSync ignores mode if dir already exists; chmod best-effort on
      // non-POSIX filesystems where it may throw.
    }

    const dbExisted = fs.existsSync(this.opts.dbPath);
    const db = new Database(this.opts.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');

    if (!dbExisted) {
      try {
        fs.chmodSync(this.opts.dbPath, 0o600);
      } catch {
        /* non-POSIX */
      }
    }

    for (const ddl of SCHEMA_V1_STATEMENTS) {
      db.prepare(ddl).run();
    }

    let versionRow = db
      .prepare('SELECT version FROM memory_schema_version')
      .get() as { version: number } | undefined;
    if (!versionRow) {
      // SCHEMA_V1_STATEMENTS are the bootstrap baseline. Stamp v1 first, then
      // run the same forward migrations an existing store takes; this prevents
      // a fresh DB being labelled v2 without the v2 apply ledger.
      db.prepare('INSERT INTO memory_schema_version (version) VALUES (1)').run();
      versionRow = { version: 1 };
    }
    if (versionRow.version > SCHEMA_VERSION) {
      db.close();
      // §9.4 — typed incompatible-schema fail closed: an older runtime must
      // NEVER downgrade-write a newer db. Recovery = upgrade the runtime or
      // discard the rebuildable cache.
      throw new MemorySchemaIncompatibleError(
        `MemoryStore: db schema version ${versionRow.version} is newer than runtime ${SCHEMA_VERSION}; refusing to open`,
      );
    }
    if (versionRow.version < 2) {
      const migrate = db.transaction(() => {
        for (const ddl of SCHEMA_V2_STATEMENTS) db.prepare(ddl).run();
        db.prepare('UPDATE memory_schema_version SET version = 2').run();
      });
      migrate();
    }
    if (versionRow.version < 3) {
      // §9.4 — V2 -> V3 in ONE SQLite transaction: state table + the two
      // memory_pages columns + old-cursor migration + schema-version bump.
      // A failing statement rolls back everything (no half-migrated db).
      const migrate = db.transaction(() => {
        for (const ddl of SCHEMA_V3_STATEMENTS) db.prepare(ddl).run();
        // Migrate the old inbox cursor READ-ONLY into the replica state:
        // accessVersion=0, empty subject hash, leaseExpiresAt=0, suspended —
        // the cursor value is preserved but NEVER authorizes anything; a
        // strict workspace must full-reconcile before recall can open.
        const oldCursor = db
          .prepare('SELECT cursor FROM memory_inbox_cursor WHERE workspaceId = ?')
          .get(this.opts.workspaceId) as { cursor: string } | undefined;
        if (oldCursor) {
          db.prepare(
            `INSERT INTO memory_replica_state (
               workspaceId, cursor, accessVersion, replicaSubjectHash,
               contentHighWatermarkJson, status, leaseExpiresAt, updatedAt
             ) VALUES (?, ?, 0, '', NULL, 'suspended', 0, ?)`,
          ).run(this.opts.workspaceId, oldCursor.cursor, Date.now());
        }
        db.prepare('UPDATE memory_schema_version SET version = 3').run();
      });
      migrate();
    }

    if (versionRow.version < 4) {
      // memory211/01 W2 #7 — rebuild the FTS index at the V4 shape (cjk bigram
      // column) and re-index every durable row. Inline payloads only: sealed /
      // encrypted rows never had plaintext in the index anyway, so skipping them
      // changes nothing searchable. The local store is a rebuildable cache
      // (§9.4); a large workspace re-indexes once, on first open after upgrade.
      const migrate = db.transaction(() => {
        db.prepare('DROP TABLE IF EXISTS memory_fts').run();
        db.prepare(MEMORY_FTS_DDL).run();
        const rows = db
          .prepare(
            `SELECT p.id, p.workspaceId, p.path, p.title, p.description, c.payloadValue AS content
             FROM memory_pages p
             JOIN memory_page_content c ON c.pageId = p.id AND c.version = p.version
             WHERE c.payloadKind = 'inline'`,
          )
          .all() as Array<{
          id: string;
          workspaceId: string;
          path: string;
          title: string | null;
          description: string | null;
          content: string;
        }>;
        const insert = db.prepare(
          `INSERT INTO memory_fts (pageId, workspaceId, path, title, description, content, cjk)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const r of rows) {
          insert.run(
            r.id,
            r.workspaceId,
            r.path,
            r.title ?? '',
            r.description ?? '',
            r.content,
            cjkBigramText(r.title ?? '', r.description ?? '', r.content),
          );
        }
        db.prepare('UPDATE memory_schema_version SET version = 4').run();
      });
      migrate();
    }

    if (versionRow.version < 5) {
      // memory211/01 W3 轴D — the T3 chunk mirror is ADDITIVE (new tables only),
      // so the migration is create-if-missing in one transaction. No existing
      // row is rewritten; an empty mirror is a legitimate state (the daemon
      // re-downloads or re-chunks on demand).
      const migrate = db.transaction(() => {
        for (const ddl of SCHEMA_V5_STATEMENTS) db.prepare(ddl).run();
        db.prepare('UPDATE memory_schema_version SET version = 5').run();
      });
      migrate();
    }

    if (versionRow.version < 6) {
      // memory211/01 W4 轴F — the chunk mirror gains the span-sid column
      // (NULL = T3 raw, non-NULL = minted = T2 asset). Purely additive: existing
      // rows keep sid NULL, which is exactly their (unchanged) tier. SQLite has
      // no `ADD COLUMN IF NOT EXISTS`, and a db can legitimately carry the
      // column already (a V6 store whose version stamp was rolled back by a
      // test/recovery path), so the migration guards on the table info.
      const migrate = db.transaction(() => {
        const chunkCols = db
          .prepare(`SELECT name FROM pragma_table_info('asset_chunks') ORDER BY cid`)
          .all() as Array<{ name: string }>;
        if (chunkCols.length > 0 && !chunkCols.some((c) => c.name === 'sid')) {
          db.prepare('ALTER TABLE asset_chunks ADD COLUMN sid TEXT').run();
        }
        db.prepare('UPDATE memory_schema_version SET version = 6').run();
      });
      migrate();
    }

    // §9.4 — a process that died mid-reconcile left `reconciling` on disk.
    // On restart that in-flight marker is reset to `suspended` (the next
    // trusted contact runs a FULL reconcile; a stale marker must never read
    // as "authorized").
    const stuck = db
      .prepare(
        `SELECT status FROM memory_replica_state WHERE workspaceId = ? AND status = 'reconciling'`,
      )
      .get(this.opts.workspaceId);
    if (stuck) {
      db.prepare(
        `UPDATE memory_replica_state SET status = 'suspended', updatedAt = ? WHERE workspaceId = ?`,
      ).run(Date.now(), this.opts.workspaceId);
    }

    this.db = db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  loadByPath(pagePath: string): MemoryPage | null {
    this.assertReplicaRecallOpen();
    const db = this.requireDb();
    const row = db
      .prepare('SELECT * FROM memory_pages WHERE workspaceId = ? AND path = ?')
      .get(this.opts.workspaceId, pagePath) as PageRow | undefined;
    return row ? this.rowToPage(row) : null;
  }

  /**
   * memory203/18 W2 P0 — variant-tolerant path lookup: try the path as given,
   * then with/without the leading `memory/` namespace, then ±`.pkf`
   * (memoryPathLookupVariants). Used by write-path resolution (回源 check,
   * parentHubPath existence, section-op page resolve) so the two live path
   * conventions address the same page instead of forking a duplicate.
   */
  loadByAnyPath(pagePath: string): MemoryPage | null {
    for (const variant of memoryPathLookupVariants(pagePath)) {
      const hit = this.loadByPath(variant);
      if (hit) return hit;
    }
    return null;
  }

  loadById(pageId: string): MemoryPage | null {
    this.assertReplicaRecallOpen();
    return this.loadByIdUnchecked(pageId);
  }

  /** Ungated loader for system paths (write() post-check) — NOT for recall. */
  private loadByIdUnchecked(pageId: string): MemoryPage | null {
    const db = this.requireDb();
    const row = db
      .prepare('SELECT * FROM memory_pages WHERE workspaceId = ? AND id = ?')
      .get(this.opts.workspaceId, pageId) as PageRow | undefined;
    return row ? this.rowToPage(row) : null;
  }

  loadContent(pageId: string, version?: number): MemoryPageContent | null {
    this.assertReplicaRecallOpen();
    const db = this.requireDb();
    const targetVersion =
      version ??
      (
        db
          .prepare('SELECT version FROM memory_pages WHERE workspaceId = ? AND id = ?')
          .get(this.opts.workspaceId, pageId) as { version: number } | undefined
      )?.version;
    if (targetVersion === undefined) return null;
    const row = db
      .prepare(
        `SELECT c.pageId, c.version, c.payloadKind, c.payloadValue
         FROM memory_page_content c
         JOIN memory_pages p ON p.id = c.pageId
         WHERE p.workspaceId = ? AND c.pageId = ? AND c.version = ?`,
      )
      .get(this.opts.workspaceId, pageId, targetVersion) as
      | { pageId: string; version: number; payloadKind: string; payloadValue: string }
      | undefined;
    if (!row) return null;
    if (row.payloadKind !== 'inline') {
      throw new Error(
        `MemoryStore.loadContent: pageId=${pageId} v${row.version} stored as ${row.payloadKind}; M4 encryption not yet implemented`,
      );
    }
    return { pageId: row.pageId, version: row.version, content: row.payloadValue };
  }

  /**
   * memory202 doc 05 §4.2a — load the workspace INDEX page's current content
   * (the curated memory MAP) for the INDEX-TOC core-inject. Queried by the raw
   * `pageType='index'` string: the cloud emits `'index'` and `materialisePage`
   * stores it verbatim, but the daemon's `MemoryPageType` enum does NOT
   * enumerate `'index'` (it's a cloud-side hub type), so `list({ pageType })`
   * can't address it without widening the enum (which would ripple). Returns the
   * most-recently-updated index page's content, or null if the workspace has no
   * INDEX page yet (pre-seed / fresh workspace). Whole-page content only — the
   * TOC builder does the bounding.
   */
  loadIndexPageContent(): string | null {
    const idx = this.loadIndexPage();
    return idx ? this.loadContent(idx.id)?.content ?? null : null;
  }

  /**
   * memory203/13 P1 — load the workspace INDEX page ROW by `pageType='index'`
   * (path-agnostic), NOT by a hardcoded path. The canonical INDEX path is
   * `INDEX.pkf` (cloud seed + lazy-ensure), but identifying the INDEX by
   * pageType is robust to any path drift across layers — this is the single
   * place daemon callers (session-start inject in hooks.ts) resolve the INDEX,
   * so they never re-hardcode a path literal (`INDEX.md` was the stale one).
   * Returns the most-recently-updated index page, or null pre-seed. `rowid DESC`
   * is the tie-break for same-millisecond writes: `updatedAt` is a `Date.now()`
   * int, so two index pages written within one ms (fast CI machines) must resolve
   * to the LATEST write deterministically — bare `updatedAt DESC` falls back to
   * scan order and hands the win to the OLDER row (the memory-w3-upload-pipeline
   * "NO soft cap" case went red on CI exactly this way).
   */
  loadIndexPage(): MemoryPage | null {
    this.assertReplicaRecallOpen();
    const db = this.requireDb();
    const row = db
      .prepare(
        `SELECT * FROM memory_pages
         WHERE workspaceId = ? AND pageType = 'index' AND archivedAt IS NULL
         ORDER BY updatedAt DESC, rowid DESC LIMIT 1`,
      )
      .get(this.opts.workspaceId) as PageRow | undefined;
    return row ? this.rowToPage(row) : null;
  }

  list(options?: { pageType?: MemoryPageType; limit?: number }): MemoryPage[] {
    this.assertReplicaRecallOpen();
    const db = this.requireDb();
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 1000);
    const rows = options?.pageType
      ? (db
          .prepare(
            `SELECT * FROM memory_pages
             WHERE workspaceId = ? AND pageType = ?
             ORDER BY updatedAt DESC LIMIT ?`,
          )
          .all(this.opts.workspaceId, options.pageType, limit) as PageRow[])
      : (db
          .prepare(
            `SELECT * FROM memory_pages
             WHERE workspaceId = ?
             ORDER BY updatedAt DESC LIMIT ?`,
          )
          .all(this.opts.workspaceId, limit) as PageRow[]);
    return rows.map((r) => this.rowToPage(r));
  }

  write(input: MemoryWriteInput): MemoryPage {
    if (input.workspaceId !== this.opts.workspaceId) {
      throw new Error(
        `MemoryStore.write: workspace mismatch (store=${this.opts.workspaceId}, input=${input.workspaceId})`,
      );
    }
    const db = this.requireDb();
    const now = Date.now();
    const contentHash = sha256(input.content);
    const payload = sealPlaintext(input.content);
    if (payload.kind !== 'inline') {
      throw new Error('MemoryStore.write: non-inline payload not yet supported in phase-0');
    }
    const visibility = input.visibility ?? { kind: 'workspace' };
    // The `visibilityImUserId` column carries the visibility SUBJECT for every
    // owner-scoped kind: an im_user id for agent/private, a role slug for role,
    // a council id for council. Workspace pages have no subject (NULL).
    const visibilityImUserId =
      visibility.kind === 'workspace'
        ? null
        : visibility.kind === 'role'
          ? visibility.slug
          : visibility.kind === 'council'
            ? visibility.id
            : visibility.kind === 'task'
              ? visibility.id
              : visibility.imUserId;
    const sourceRefsJson = JSON.stringify(input.sourceRefs ?? []);

    const existing = db
      .prepare(
        'SELECT id, version, createdAt FROM memory_pages WHERE workspaceId = ? AND path = ?',
      )
      .get(this.opts.workspaceId, input.path) as
      | { id: string; version: number; createdAt: number }
      | undefined;

    // Fresh insert: prefer a caller-supplied canonical id (cloud-sync passes the
    // cloud's id so the subset mirrors the superset — see MemoryWriteInput.id).
    // On a path conflict the EXISTING row's id wins (never repointed: content/
    // fts/links FK to it). Daemon-authored writes pass no id → mint a local one.
    const pageId = existing?.id ?? input.id ?? `page_${randomUUID().replace(/-/g, '').slice(0, 22)}`;
    // memory203/18 R1.4 — adopt an authoritative (cloud) version when the
    // caller supplies one: a page materialised from the cloud superset lands at
    // the CLOUD head version (not local v1), so a subsequent local write emits
    // `parentVersion = cloudHead` and the cloud LWW check sees a真 continuation
    // instead of a base-v1 remote-conflict. Monotonic guard: never regress a
    // local version that is already ahead (unsynced local writes win the max).
    const newVersion = Math.max((existing?.version ?? 0) + 1, input.version ?? 0);
    const createdAt = existing?.createdAt ?? now;

    const staleFlag = input.stale ? 1 : 0;
    // memory202 doc 06: mark the page `encrypted` so the outbox flush knows to
    // encrypt the cloud-bound payload. The local SQLite row + FTS still store
    // PLAINTEXT (see insertContent/insertFts below) — this column is an intent
    // marker only. Resolution:
    //   - explicit input.encrypted (true|false)  → honored verbatim. This is the
    //     cloud→local down-sync path (cloud-sync.ts passes an explicit flag per
    //     page: false for plaintext, true for the unreadable-ciphertext
    //     sentinel) — never auto-overridden.
    //   - input.encrypted === undefined          → consult the activation policy
    //     (locally-authored writes). The policy is "flag on AND durable key AND
    //     not ephemeral"; when it (or the absent policy) yields false we mark 0,
    //     preserving today's default-OFF behavior. Fail-safe: a policy that
    //     can't produce a key returns false → plaintext, never ciphertext.
    const encryptedFlag =
      input.encrypted === undefined
        ? this.opts.encryptionPolicy?.()
          ? 1
          : 0
        : input.encrypted
          ? 1
          : 0;
    const insertPage = db.prepare(`
      INSERT INTO memory_pages (
        id, workspaceId, path, title, description, contentHash, version,
        pageType, visibilityKind, visibilityImUserId, encrypted, stale,
        archivedAt, sourceAssetId, sourceRefsJson, syncStatus,
        createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'local-only', ?, ?)
      ON CONFLICT(workspaceId, path) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        contentHash = excluded.contentHash,
        version = excluded.version,
        pageType = excluded.pageType,
        visibilityKind = excluded.visibilityKind,
        visibilityImUserId = excluded.visibilityImUserId,
        encrypted = excluded.encrypted,
        sourceAssetId = excluded.sourceAssetId,
        sourceRefsJson = excluded.sourceRefsJson,
        stale = excluded.stale,
        updatedAt = excluded.updatedAt
    `);

    const insertVersion = db.prepare(`
      INSERT INTO memory_page_versions (pageId, version, contentHash, actorImUserId, actorKind, deviceId, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertContent = db.prepare(`
      INSERT INTO memory_page_content (pageId, version, payloadKind, payloadValue)
      VALUES (?, ?, ?, ?)
    `);

    const deleteFts = db.prepare('DELETE FROM memory_fts WHERE pageId = ?');
    const insertFts = db.prepare(`
      INSERT INTO memory_fts (pageId, workspaceId, path, title, description, content, cjk)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      insertPage.run(
        pageId,
        this.opts.workspaceId,
        input.path,
        input.title ?? null,
        input.description ?? null,
        contentHash,
        newVersion,
        input.pageType ?? 'leaf',
        visibility.kind,
        visibilityImUserId,
        encryptedFlag,
        staleFlag,
        input.sourceAssetId ?? null,
        sourceRefsJson,
        createdAt,
        now,
      );
      insertVersion.run(
        pageId,
        newVersion,
        contentHash,
        input.actorImUserId,
        input.actorKind,
        this.opts.deviceId,
        now,
      );
      insertContent.run(pageId, newVersion, payload.kind, payload.content);
      deleteFts.run(pageId);
      insertFts.run(
        pageId,
        this.opts.workspaceId,
        input.path,
        input.title ?? '',
        input.description ?? '',
        input.content,
        cjkBigramText(input.title ?? '', input.description ?? '', input.content),
      );
    });
    tx();

    const written = this.loadByIdUnchecked(pageId);
    if (!written) throw new Error('MemoryStore.write: post-write loadById returned null');
    return written;
  }

  /**
   * memory203 doc 07 — set a local page's `syncStatus`. Used by the cloud→local
   * down-sync (cloud-sync.ts `materialisePage`) to mark a page
   * `'remote-conflict'` when the cloud signals that THIS device's write lost an
   * LWW conflict (or to clear it back to `'acked'` once the cloud no longer
   * reports a live conflict for the page). The local page row otherwise carries
   * the `'local-only'` default the write path stamps; this is the only writer of
   * the post-sync sync state.
   *
   * No-op (returns false) when no page with `pageId` exists in this store's
   * workspace — a down-sync may reference a page the local subset never
   * materialised (e.g. a write failure on the same pass). Scoped by workspaceId
   * so a misrouted id can never touch another workspace's row.
   */
  setSyncStatus(pageId: string, syncStatus: MemorySyncStatus): boolean {
    const db = this.requireDb();
    const info = db
      .prepare('UPDATE memory_pages SET syncStatus = ? WHERE workspaceId = ? AND id = ?')
      .run(syncStatus, this.opts.workspaceId, pageId);
    return info.changes > 0;
  }

  /**
   * memory203 doc 07 — list the local pages currently in `'remote-conflict'`
   * (this device's writes that lost an LWW conflict the cloud resolved). Backs
   * the daemon RPC `GET /local/memory/conflicts` so the host can surface「我的写
   * 在另一台设备上失败了」without polling the cloud. Workspace-scoped; newest
   * first.
   */
  listRemoteConflicts(limit = 100): MemoryPage[] {
    this.assertReplicaRecallOpen();
    const db = this.requireDb();
    const cap = Math.min(Math.max(limit, 1), 1000);
    const rows = db
      .prepare(
        `SELECT * FROM memory_pages
         WHERE workspaceId = ? AND syncStatus = 'remote-conflict'
         ORDER BY updatedAt DESC LIMIT ?`,
      )
      .all(this.opts.workspaceId, cap) as PageRow[];
    return rows.map((r) => this.rowToPage(r));
  }

  invalidate(pageIds: string[], _reason: string): void {
    if (pageIds.length === 0) return;
    const db = this.requireDb();
    const placeholders = pageIds.map(() => '?').join(',');
    const ownPages = db
      .prepare(
        `SELECT id FROM memory_pages WHERE workspaceId = ? AND id IN (${placeholders})`,
      )
      .all(this.opts.workspaceId, ...pageIds) as { id: string }[];
    if (ownPages.length === 0) return;
    const ownIds = ownPages.map((r) => r.id);
    const ownPlaceholders = ownIds.map(() => '?').join(',');

    const deletePages = db.prepare(`DELETE FROM memory_pages WHERE id IN (${ownPlaceholders})`);
    const deleteFts = db.prepare(`DELETE FROM memory_fts WHERE pageId IN (${ownPlaceholders})`);
    // §9.5 — invalidation suspends the replica FIRST (in the SAME transaction
    // as the page removal): recall stays closed until the next trusted
    // contact completes a fresh snapshot refresh + reconcile.
    const suspendState = db.prepare(
      `UPDATE memory_replica_state SET status = 'suspended', updatedAt = ? WHERE workspaceId = ?`,
    );

    db.transaction(() => {
      deletePages.run(...ownIds); // CASCADE removes versions + content
      deleteFts.run(...ownIds);
      suspendState.run(Date.now(), this.opts.workspaceId);
    })();
  }

  /**
   * 1-hop link-graph neighbor lookup, used by the composite recall path
   * (MemorySearch.expandViaGraph). Mirrors the cloud
   * `memory-search.service.ts#expandViaGraph` neighbor fetch, adapted to the
   * daemon's URI-keyed `memory_links` table.
   *
   * Daemon links are stored as `<scheme>://<path>[#anchor]` URIs (NOT pageIds —
   * the cloud resolves these to `sourcePageId` on sync). To find the pages that
   * are 1 hop from a seed page, we:
   *   1. take each seed page's `path`,
   *   2. match `memory_links` rows whose source OR target URI embeds that path,
   *   3. resolve the OTHER end's URI back to a page `path` and load that page.
   *
   * Both directions are walked (a link a→b makes b a neighbor of a AND a a
   * neighbor of b) so the graph behaves as undirected for recall, matching the
   * cloud's `OR: [{sourcePageId in seeds}, {targetPageId in seeds}]`.
   *
   * Returns one row per distinct neighbor page (best edge weight wins on
   * collision) so the caller can fan-out top-K by weight. Excludes archived /
   * stale-suppressed pages is the caller's job via the returned `stale` flag;
   * here we only drop archived + the seed pages themselves.
   *
   * Scoped by this store's workspaceId — links and pages are both
   * workspace-local, so a single store (bucket) never crosses workspaces.
   */
  linkNeighbors(seedPaths: string[]): MemoryLinkNeighbor[] {
    if (seedPaths.length === 0) return [];
    this.assertReplicaRecallOpen();
    const db = this.requireDb();
    const seedSet = new Set(seedPaths);

    // Build a path → URI-fragment match. `memory_links` keys on URIs, so we
    // pull all workspace links and resolve in code (the table is small in the
    // daemon-local store; a path-indexed link table would require a schema
    // migration which is out of scope for this change).
    const links = db
      .prepare(
        `SELECT sourceUri, targetUri, weight FROM memory_links WHERE workspaceId = ?`,
      )
      .all(this.opts.workspaceId) as {
      sourceUri: string;
      targetUri: string;
      weight: number;
    }[];

    // neighborPath → best edge weight reaching it from a seed.
    const neighborWeights = new Map<string, number>();
    // neighborPath → the `#section` anchor the reaching link carried for THAT
    // neighbor's URI end (P1b). When seed=source the neighbor is the target, so
    // its anchor is the TARGET URI's anchor; when seed=target the neighbor is
    // the source, so its anchor is the SOURCE URI's anchor — exactly parallel to
    // cloud expandViaGraph's targetSection/sourceSection mapping. First non-empty
    // anchor wins (deterministic); page-level links contribute none.
    const neighborSection = new Map<string, string>();
    for (const l of links) {
      const srcParsed = pathFromMemoryUri(l.sourceUri);
      const tgtParsed = pathFromMemoryUri(l.targetUri);
      if (!srcParsed || !tgtParsed) continue;
      const srcPath = srcParsed.path;
      const tgtPath = tgtParsed.path;
      const srcIsSeed = seedSet.has(srcPath);
      const tgtIsSeed = seedSet.has(tgtPath);
      // Undirected: if either endpoint is a seed, the OTHER endpoint is a 1-hop
      // neighbor (provided it isn't itself a seed).
      if (srcIsSeed && !tgtIsSeed) {
        const prev = neighborWeights.get(tgtPath);
        if (prev === undefined || l.weight > prev) neighborWeights.set(tgtPath, l.weight);
        if (tgtParsed.section && !neighborSection.has(tgtPath)) {
          neighborSection.set(tgtPath, tgtParsed.section);
        }
      }
      if (tgtIsSeed && !srcIsSeed) {
        const prev = neighborWeights.get(srcPath);
        if (prev === undefined || l.weight > prev) neighborWeights.set(srcPath, l.weight);
        if (srcParsed.section && !neighborSection.has(srcPath)) {
          neighborSection.set(srcPath, srcParsed.section);
        }
      }
    }
    if (neighborWeights.size === 0) return [];

    // Load the neighbor pages (archived excluded; seeds already excluded above).
    const neighborPaths = [...neighborWeights.keys()];
    const placeholders = neighborPaths.map(() => '?').join(',');
    const rows = db
      .prepare(
        // stale = 0 mirrors the FTS5 path's hard `p.stale = 0` filter so graph
        // expansion can never surface a stale neighbor the lexical path would
        // have suppressed (symmetry guard; the returned `stale` flag stays for
        // callers but is always false here).
        // Page content (current version) is pulled (P1b) so
        // MemorySearch.expandViaGraph can slice the addressed `#section` out of
        // the neighbor when the link carried one. Only `payloadKind='inline'` is
        // plaintext — sealed/blobRef payloads yield no sliceable content (the
        // neighbor degrades to a whole-page hit, matching loadContent's guard).
        `SELECT p.id AS id, p.path AS path, p.title AS title, p.description AS description,
                p.stale AS stale, p.updatedAt AS updatedAt,
                c.payloadKind AS payloadKind, c.payloadValue AS payloadValue
         FROM memory_pages p
         LEFT JOIN memory_page_content c
           ON c.pageId = p.id AND c.version = p.version
         WHERE p.workspaceId = ?
           AND p.archivedAt IS NULL
           AND p.stale = 0
           AND p.path IN (${placeholders})`,
      )
      .all(this.opts.workspaceId, ...neighborPaths) as {
      id: string;
      path: string;
      title: string | null;
      description: string | null;
      stale: number;
      updatedAt: number;
      payloadKind: string | null;
      payloadValue: string | null;
    }[];

    return rows.map((r) => {
      const section = neighborSection.get(r.path);
      const content = r.payloadKind === 'inline' ? (r.payloadValue ?? '') : '';
      return {
        pageId: r.id,
        path: r.path,
        title: r.title,
        description: r.description,
        stale: r.stale === 1,
        updatedAt: r.updatedAt,
        weight: neighborWeights.get(r.path) ?? 1,
        content,
        ...(section ? { section } : {}),
      };
    });
  }

  /**
   * memory203 doc26 Wave 4 — classify which of the given candidate pages sit on
   * the OLDER (demoted) or NEWER (slightly promoted) side of a
   * supersede-or-contradicts edge. Mirrors the cloud
   * `memory-search.service.ts` R4.2 term over the daemon's URI-keyed
   * `memory_links` table:
   *   - `superseded-by`  source=older → target=newer  ⇒ source demoted, target promoted
   *   - `supersedes`     source=newer → target=older  ⇒ target demoted, source promoted
   *   - `contradicts`    source=newer → target=older  ⇒ target demoted, source promoted
   *
   * Links are URI-keyed, so each end's URI is resolved back to a page path via
   * the SAME `pathFromMemoryUri` resolver `linkNeighbors` uses (identical
   * matching semantics — a link that graph-expansion can reach is a link this
   * can classify) and intersected with the candidate path set. ONE query,
   * scoped to the three relations + this workspace; typically a handful of rows.
   * A page touched by neither relation appears in neither set (term 0 upstream).
   */
  supersedeSides(candidatePaths: string[]): { demoted: Set<string>; superseding: Set<string> } {
    const demoted = new Set<string>();
    const superseding = new Set<string>();
    if (candidatePaths.length === 0) return { demoted, superseding };
    const db = this.requireDb();
    const cand = new Set(candidatePaths);
    const links = db
      .prepare(
        `SELECT sourceUri, targetUri, relation FROM memory_links
         WHERE workspaceId = ? AND relation IN ('supersedes', 'superseded-by', 'contradicts')`,
      )
      .all(this.opts.workspaceId) as { sourceUri: string; targetUri: string; relation: string }[];
    for (const l of links) {
      const src = pathFromMemoryUri(l.sourceUri)?.path;
      const tgt = pathFromMemoryUri(l.targetUri)?.path;
      if (l.relation === 'superseded-by') {
        // source is the OLDER side, target is the NEWER replacement.
        if (src && cand.has(src)) demoted.add(src);
        if (tgt && cand.has(tgt)) superseding.add(tgt);
      } else {
        // 'supersedes' | 'contradicts' — older/contradicted side is the TARGET.
        if (tgt && cand.has(tgt)) demoted.add(tgt);
        if (src && cand.has(src)) superseding.add(src);
      }
    }
    return { demoted, superseding };
  }

  /**
   * memory211/01 §3 轴C W1a — per-page graph context for the hop-decision
   * payload, aggregated IN PLACE from the existing `memory_links` table (no new
   * table, no new sync channel — the local edge mirror the daemon already
   * down-syncs is the only source).
   *
   * For each requested page id this returns:
   *   • hubPath          — the TARGET of the page's own `child-of` edge (page
   *                        --child-of--> hub), i.e. reverse tree placement.
   *                        null when the page hangs off nothing (root / INDEX
   *                        / unanchored leaf) or when that hub is not a live
   *                        local page (dangling edge).
   *   • inboundLinkCount — edges whose target resolves to this page (any
   *                        relation): how connected the page is.
   *   • children[]       — distinct sources of `child-of` edges pointing at
   *                        this page (path-sorted, stable) — the browse-tree
   *                        expansion.
   *   • outboundPreview[]— first `outboundPreviewLimit` outbound edges
   *                        (strongest weight first).
   *
   * Gated by the SAME replica-recall predicate as every other recall read
   * (linkNeighbors / supersedeSides): a suspended / stale replica closes this
   * too. Keyed by page id because that is what both callers already hold
   * (search hits carry `pageId`; `store.list` rows carry `.id`).
   */
  pageGraphContext(
    pageIds: string[],
    outboundPreviewLimit = 5,
  ): Map<string, MemoryPageGraphContext> {
    const out = new Map<string, MemoryPageGraphContext>();
    if (pageIds.length === 0) return out;
    this.assertReplicaRecallOpen();
    const db = this.requireDb();
    const idPlaceholders = pageIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id, path, version, pageType FROM memory_pages
         WHERE workspaceId = ? AND id IN (${idPlaceholders})`,
      )
      .all(this.opts.workspaceId, ...pageIds) as Array<{
      id: string;
      path: string;
      version: number;
      pageType: string;
    }>;
    for (const r of rows) {
      out.set(r.id, {
        pageId: r.id,
        path: r.path,
        version: r.version,
        pageType: r.pageType,
        hubPath: null,
        inboundLinkCount: 0,
        childrenCount: 0,
        children: [],
        outboundPreview: [],
      });
    }
    if (out.size === 0) return out;

    // Links are URI-keyed, pages id-keyed: index by NORMALIZED path so a link
    // written in the other path convention (`memory/x` vs `x`) still lands on
    // the same page.
    const byPath = new Map<string, MemoryPageGraphContext>();
    for (const ctx of out.values()) byPath.set(normalizeMemoryPath(ctx.path), ctx);

    // Weighted working state, kept OUT of the returned context (only ordered
    // projections of it are surfaced).
    interface Working {
      ctx: MemoryPageGraphContext;
      hubWeight: number;
      outbound: Array<{ relation: string; targetPath: string; weight: number }>;
    }
    const working = new Map<string, Working>();
    for (const ctx of out.values()) {
      working.set(ctx.pageId, { ctx, hubWeight: Number.NEGATIVE_INFINITY, outbound: [] });
    }

    const links = db
      .prepare(
        `SELECT sourceUri, targetUri, relation, weight FROM memory_links WHERE workspaceId = ?`,
      )
      .all(this.opts.workspaceId) as Array<{
      sourceUri: string;
      targetUri: string;
      relation: string;
      weight: number;
    }>;

    const hubCandidates = new Set<string>();
    for (const l of links) {
      const src = pathFromMemoryUri(l.sourceUri);
      const tgt = pathFromMemoryUri(l.targetUri);
      if (!src || !tgt) continue;
      const srcPath = normalizeMemoryPath(src.path);
      const tgtPath = normalizeMemoryPath(tgt.path);
      const srcWork = working.get(byPath.get(srcPath)?.pageId ?? '');
      const tgtWork = working.get(byPath.get(tgtPath)?.pageId ?? '');
      if (srcWork) {
        if (l.relation === 'child-of' && l.weight > srcWork.hubWeight) {
          // page --child-of--> hub: the hub is the TARGET end.
          srcWork.ctx.hubPath = tgtPath;
          srcWork.hubWeight = l.weight;
          hubCandidates.add(tgtPath);
        }
        srcWork.outbound.push({ relation: l.relation, targetPath: tgtPath, weight: l.weight });
      }
      if (tgtWork) {
        tgtWork.ctx.inboundLinkCount += 1;
        if (l.relation === 'child-of' && !tgtWork.ctx.children.some((c) => c.path === srcPath)) {
          tgtWork.ctx.children.push({ path: srcPath, title: null });
        }
      }
    }

    // Resolve child titles + hub liveness in ONE batched pages query. Both look
    // ups are variant-tolerant (memory/x vs x, ±.pkf) so the other path
    // convention neither blanks a title nor voids a valid hub.
    const titlePaths = new Set<string>(hubCandidates);
    for (const w of working.values()) for (const c of w.ctx.children) titlePaths.add(c.path);
    const variantToKey = new Map<string, string>();
    for (const key of titlePaths) {
      for (const v of memoryPathLookupVariants(key)) {
        const norm = normalizeMemoryPath(v);
        if (!variantToKey.has(norm)) variantToKey.set(norm, key);
      }
    }
    const titles = new Map<string, string | null>();
    const livePaths = new Set<string>();
    const lookupPaths = [...variantToKey.keys()];
    if (lookupPaths.length > 0) {
      const pathPlaceholders = lookupPaths.map(() => '?').join(',');
      const pageRows = db
        .prepare(
          `SELECT path, title, archivedAt FROM memory_pages
           WHERE workspaceId = ? AND path IN (${pathPlaceholders})`,
        )
        .all(this.opts.workspaceId, ...lookupPaths) as Array<{
        path: string;
        title: string | null;
        archivedAt: number | null;
      }>;
      for (const r of pageRows) {
        const key = variantToKey.get(normalizeMemoryPath(r.path));
        if (!key) continue;
        titles.set(key, r.title);
        if (r.archivedAt === null) livePaths.add(key);
      }
    }

    for (const w of working.values()) {
      w.ctx.children.sort((a, b) => a.path.localeCompare(b.path));
      for (const c of w.ctx.children) c.title = titles.get(c.path) ?? null;
      w.ctx.childrenCount = w.ctx.children.length;
      w.outbound.sort(
        (a, b) => b.weight - a.weight || a.targetPath.localeCompare(b.targetPath),
      );
      w.ctx.outboundPreview = w.outbound
        .slice(0, outboundPreviewLimit)
        .map(({ relation, targetPath }) => ({ relation, targetPath }));
      if (w.ctx.hubPath && !livePaths.has(w.ctx.hubPath)) w.ctx.hubPath = null;
    }
    return out;
  }

  /**
   * memory211/01 §3 轴C W1a — LOCAL offline links for one page, shaped after the
   * cloud `GET /memory/pages/:id/links` envelope (`{ outbound, backlinks }`).
   * Serves handleLoad when the cloud transfer fails so 「顺着索引往下看」 keeps
   * working offline (local-first: the daemon link mirror is the offline truth).
   *
   * Row fields are the subset of the cloud `MemoryLinkRow` the local URI-keyed
   * table can honestly produce. Deliberately ABSENT: `broken` (the local subset
   * cannot distinguish a dangling edge from a not-yet-synced page — claiming
   * broken would be a lie) and `extractedFromVersion` (not mirrored). Page ids
   * resolve best-effort so a caller can chase `sourcePageId`/`targetPageId` as
   * it would against the cloud; null = that end is not in the local subset.
   */
  pageLinks(pagePath: string): { outbound: MemoryPageLinkRow[]; backlinks: MemoryPageLinkRow[] } {
    this.assertReplicaRecallOpen();
    const db = this.requireDb();
    const selfVariants = new Set(
      memoryPathLookupVariants(pagePath).map((p) => normalizeMemoryPath(p)),
    );
    const links = db
      .prepare(
        `SELECT sourceUri, targetUri, relation, weight, createdAt FROM memory_links
         WHERE workspaceId = ?`,
      )
      .all(this.opts.workspaceId) as Array<{
      sourceUri: string;
      targetUri: string;
      relation: string;
      weight: number;
      createdAt: number;
    }>;

    // id resolution for both link ends (self + far ends), variant-tolerant.
    const idByPath = new Map<string, string>();
    const referenced = new Set<string>(selfVariants);
    for (const l of links) {
      for (const uri of [l.sourceUri, l.targetUri]) {
        const parsed = pathFromMemoryUri(uri);
        if (parsed) referenced.add(normalizeMemoryPath(parsed.path));
      }
    }
    const variantsToKey = new Map<string, string>();
    for (const key of referenced) {
      for (const v of memoryPathLookupVariants(key)) {
        const norm = normalizeMemoryPath(v);
        if (!variantsToKey.has(norm)) variantsToKey.set(norm, key);
      }
    }
    const lookupPaths = [...variantsToKey.keys()];
    if (lookupPaths.length > 0) {
      const pathPlaceholders = lookupPaths.map(() => '?').join(',');
      const pageRows = db
        .prepare(
          `SELECT id, path FROM memory_pages WHERE workspaceId = ? AND path IN (${pathPlaceholders})`,
        )
        .all(this.opts.workspaceId, ...lookupPaths) as Array<{ id: string; path: string }>;
      for (const r of pageRows) {
        const key = variantsToKey.get(normalizeMemoryPath(r.path));
        if (key && !idByPath.has(key)) idByPath.set(key, r.id);
      }
    }

    const outbound: MemoryPageLinkRow[] = [];
    const backlinks: MemoryPageLinkRow[] = [];
    for (const l of links) {
      const src = pathFromMemoryUri(l.sourceUri);
      const tgt = pathFromMemoryUri(l.targetUri);
      if (!src || !tgt) continue;
      const srcPath = normalizeMemoryPath(src.path);
      const tgtPath = normalizeMemoryPath(tgt.path);
      const row: MemoryPageLinkRow = {
        sourceUri: l.sourceUri,
        targetUri: l.targetUri,
        sourcePageId: idByPath.get(srcPath) ?? null,
        targetPageId: idByPath.get(tgtPath) ?? null,
        relation: l.relation,
        weight: l.weight,
        sourceSection: src.section ?? null,
        targetSection: tgt.section ?? null,
        updatedAt: new Date(l.createdAt).toISOString(),
      };
      if (selfVariants.has(srcPath)) outbound.push(row);
      if (selfVariants.has(tgtPath)) backlinks.push({ ...row });
    }
    return { outbound, backlinks };
  }


  upsertLink(link: MemoryLink): void {
    const db = this.requireDb();
    db.prepare(
      `INSERT INTO memory_links (workspaceId, sourceUri, targetUri, relation, weight, extractedFromPageId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspaceId, sourceUri, targetUri, relation) DO UPDATE SET
         weight = excluded.weight,
         extractedFromPageId = excluded.extractedFromPageId`,
    ).run(
      this.opts.workspaceId,
      link.sourceUri,
      link.targetUri,
      link.relation,
      link.weight,
      link.extractedFromPageId,
      Date.now(),
    );
  }

  // ── memory211/01 W3 轴D — T3 raw-asset chunk mirror (local-first) ─────────

  /**
   * Replace the chunk row set for one asset version and re-index it into the
   * local chunk FTS, in ONE transaction. Keyed on
   * (workspaceId, assetId, contentHash, ordinal) — the cloud's own upsert key —
   * so a cloud re-index and a daemon re-chunk converge on the same rows.
   *
   * Replaces ALL prior rows for (workspaceId, assetId) first, so a new asset
   * revision never leaves stale chunks searchable behind it (same policy the
   * cloud `replaceAssetChunks` applies).
   */
  replaceAssetChunks(input: {
    assetId: string;
    contentHash: string;
    filename: string | null;
    rows: Array<{ ordinal: number; text: string; tokenEstimate: number }>;
  }): number {
    const workspaceId = this.opts.workspaceId;
    const db = this.requireDb();
    const now = Date.now();
    const path = `asset:${input.assetId}#${input.contentHash}`;
    const run = db.transaction(() => {
      db.prepare('DELETE FROM asset_chunks WHERE workspaceId = ? AND assetId = ?').run(
        workspaceId,
        input.assetId,
      );
      db.prepare('DELETE FROM asset_chunks_fts WHERE workspaceId = ? AND assetId = ?').run(
        workspaceId,
        input.assetId,
      );
      const insert = db.prepare(
        `INSERT OR REPLACE INTO asset_chunks
           (workspaceId, assetId, contentHash, ordinal, text, tokenEstimate, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = db.prepare(
        `INSERT INTO asset_chunks_fts (assetId, workspaceId, ordinal, path, title, content, cjk)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of input.rows) {
        insert.run(
          workspaceId,
          input.assetId,
          input.contentHash,
          row.ordinal,
          row.text,
          row.tokenEstimate,
          now,
        );
        insertFts.run(
          input.assetId,
          workspaceId,
          row.ordinal,
          path,
          input.filename ?? '',
          row.text,
          cjkBigramText(input.filename ?? '', row.text),
        );
      }
      return input.rows.length;
    });
    return run();
  }

  /** Local chunk rows for one asset (debug/observability + dedupe checks). */
  listAssetChunks(assetId: string): Array<{
    assetId: string;
    ordinal: number;
    text: string;
    tokenEstimate: number;
    contentHash: string;
    sid: string | null;
  }> {
    const rows = this.requireDb()
      .prepare(
        `SELECT assetId, ordinal, text, tokenEstimate, contentHash, sid
         FROM asset_chunks WHERE workspaceId = ? AND assetId = ? ORDER BY ordinal ASC`,
      )
      .all(this.opts.workspaceId, assetId) as Array<{
      assetId: string;
      ordinal: number;
      text: string;
      tokenEstimate: number;
      contentHash: string;
      sid: string | null;
    }>;
    return rows;
  }

  /**
   * memory211/01 W4 轴F — every chunk row of one asset, resolved against the
   * CURRENT revision (the highest contentHash present locally — the same
   * "latest wins" pick the cloud resolver makes). Empty when the mirror has no
   * row for the asset: an unknown asset can never be minted.
   */
  currentAssetChunks(assetId: string): Array<{
    assetId: string;
    contentHash: string;
    ordinal: number;
    text: string;
    sid: string | null;
  }> {
    const rows = this.requireDb()
      .prepare(
        `SELECT assetId, contentHash, ordinal, text, sid
         FROM asset_chunks WHERE workspaceId = ? AND assetId = ?`,
      )
      .all(this.opts.workspaceId, assetId) as Array<{
      assetId: string;
      contentHash: string;
      ordinal: number;
      text: string;
      sid: string | null;
    }>;
    if (rows.length === 0) return [];
    const latest = rows.reduce((acc, r) => (acc.contentHash > r.contentHash ? acc : r)).contentHash;
    return rows
      .filter((r) => r.contentHash === latest)
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  /** The asset id a scoped contentHash resolves to in the local mirror (or null). */
  assetIdByContentHash(contentHash: string): string | null {
    const row = this.requireDb()
      .prepare(
        'SELECT assetId FROM asset_chunks WHERE workspaceId = ? AND contentHash = ? LIMIT 1',
      )
      .get(this.opts.workspaceId, contentHash.toLowerCase()) as { assetId: string } | undefined;
    return row?.assetId ?? null;
  }

  /**
   * memory211/01 W4 轴F — persist a lazy mint on the mirror row. Idempotent and
   * one-way: an already-minted row keeps its sid (a replay can never un-mint or
   * swap the identity). Returns false when the row is gone (a re-chunk between
   * mint and write) — the caller must treat that as "nothing promoted".
   */
  promoteAssetChunkSid(input: { assetId: string; contentHash: string; ordinal: number; sid: string }): boolean {
    const db = this.requireDb();
    const res = db
      .prepare(
        `UPDATE asset_chunks SET sid = ?
         WHERE workspaceId = ? AND assetId = ? AND contentHash = ? AND ordinal = ? AND sid IS NULL`,
      )
      .run(input.sid, this.opts.workspaceId, input.assetId, input.contentHash, input.ordinal);
    return Number(res.changes) > 0;
  }

  stats(): MemoryStats {
    const db = this.requireDb();
    const pageCount = (
      db
        .prepare('SELECT COUNT(*) AS n FROM memory_pages WHERE workspaceId = ?')
        .get(this.opts.workspaceId) as { n: number }
    ).n;
    const pendingOutbox = (
      db.prepare("SELECT COUNT(*) AS n FROM memory_outbox WHERE status = 'pending'").get() as {
        n: number;
      }
    ).n;
    const deadLetterCount = (
      db.prepare('SELECT COUNT(*) AS n FROM memory_outbox_dead_letter').get() as { n: number }
    ).n;
    const cursorRow = db
      .prepare('SELECT updatedAt FROM memory_inbox_cursor WHERE workspaceId = ?')
      .get(this.opts.workspaceId) as { updatedAt: number } | undefined;
    return {
      workspaceId: this.opts.workspaceId,
      pageCount,
      pendingOutbox,
      deadLetterCount,
      lastSyncAt: cursorRow?.updatedAt ?? null,
      dbPath: this.opts.dbPath,
    };
  }

  /**
   * Record sync cursor for incremental sync. Used by cloud-sync.ts to
   * persist the high-water mark for future cursor-based catch-up.
   */
  recordCursor(workspaceId: string, cursor: string): void {
    const now = Date.now();
    this.requireDb()
      .prepare(
        `INSERT OR REPLACE INTO memory_inbox_cursor (workspaceId, cursor, updatedAt) VALUES (?, ?, ?)`,
      )
      .run(workspaceId, cursor, now);
  }

  /**
   * Read the persisted sync cursor for `workspaceId`, or null if no sync has
   * recorded one yet. Desktop-202 doc 18 §5a — the incremental sync read model
   * stores its high-water mark here (the `boundary_seq` analogue), so the
   * cloud→local catch-up pull can resume from the last seen `updatedAt`
   * instead of re-fetching the whole workspace on every daemon boot.
   */
  getCursor(workspaceId: string): string | null {
    const row = this.requireDb()
      .prepare('SELECT cursor FROM memory_inbox_cursor WHERE workspaceId = ?')
      .get(workspaceId) as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // product209/16 §9.3/§9.4/§9.5 — replica state machine + recall gate
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * The persisted replica authority row, or null (no row = legacy semantics,
   * recall stays open under the old model). This row is NEVER an
   * authorization fact by itself: authorization = accessVersion > 0 + a
   * matching live authority snapshot + unexpired lease (assertReplicaRecallOpen).
   */
  getReplicaState(): MemoryReplicaStateRow | null {
    const row = this.requireDb()
      .prepare(
        `SELECT workspaceId, cursor, accessVersion, replicaSubjectHash,
                contentHighWatermarkJson, status, leaseExpiresAt, updatedAt
         FROM memory_replica_state WHERE workspaceId = ?`,
      )
      .get(this.opts.workspaceId) as MemoryReplicaStateRow | undefined;
    return row ?? null;
  }

  /**
   * Transition the replica state machine (reconciling | ready | suspended |
   * stale). Upserts a row when none exists (epoch fields default to the
   * legacy marker: accessVersion=0). Atomic — a single UPDATE/INSERT.
   */
  setReplicaStatus(status: MemoryReplicaStatus): void {
    const db = this.requireDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO memory_replica_state (
         workspaceId, cursor, accessVersion, replicaSubjectHash,
         contentHighWatermarkJson, status, leaseExpiresAt, updatedAt
       ) VALUES (?, NULL, 0, '', NULL, ?, 0, ?)
       ON CONFLICT(workspaceId) DO UPDATE SET
         status = excluded.status,
         updatedAt = excluded.updatedAt`,
    ).run(this.opts.workspaceId, status, now);
  }

  /**
   * §9.3 step 2 — pin the authority epoch fixed by the FIRST manifest page
   * (accessVersion + subject hash + content high watermark) while the store
   * stays `reconciling`. Any later drift aborts the reconcile.
   */
  pinReconcileEpoch(accessVersion: number, replicaSubjectHash: string, contentHighWatermarkJson: string | null): void {
    this.requireDb()
      .prepare(
        `UPDATE memory_replica_state
         SET accessVersion = ?, replicaSubjectHash = ?, contentHighWatermarkJson = ?, updatedAt = ?
         WHERE workspaceId = ?`,
      )
      .run(accessVersion, replicaSubjectHash, contentHighWatermarkJson, Date.now(), this.opts.workspaceId);
  }

  /**
   * Legacy-sync completion marker: status ready with accessVersion=0 (the
   * OLD model — no bounded-staleness claim, no authorization). NEVER
   * downgrades a strict-authorized state (accessVersion > 0): a legacy path
   * completing after a strict reconcile leaves the strict epoch untouched
   * (fail closed — the strict gate still requires a matching snapshot).
   */
  markLegacyReplicaReady(cursor: string | null): void {
    const db = this.requireDb();
    const existing = this.getReplicaState();
    if (existing && existing.accessVersion > 0) return; // never downgrade authorization
    db.prepare(
      `INSERT INTO memory_replica_state (
         workspaceId, cursor, accessVersion, replicaSubjectHash,
         contentHighWatermarkJson, status, leaseExpiresAt, updatedAt
       ) VALUES (?, ?, 0, '', NULL, 'ready', 0, ?)
       ON CONFLICT(workspaceId) DO UPDATE SET
         cursor = excluded.cursor,
         status = 'ready',
         leaseExpiresAt = 0,
         updatedAt = excluded.updatedAt`,
    ).run(this.opts.workspaceId, cursor, Date.now());
  }

  /**
   * §9.3 step 9 — the ONE atomic commit of a reconcile pass: every page
   * mutation (head upserts incl. sorted actor sets), the ACL-shrink diff
   * deletes and tombstone deletes (page aggregate + version/content/FTS +
   * URI-resolved links), and the cursor/accessVersion/subject-hash/
   * high-watermark/lease/ready state update all land in a single SQLite
   * transaction. Any failure rolls everything back.
   */
  applyReplicaCommit(input: ReplicaCommitInput): void {
    const db = this.requireDb();
    const ws = this.opts.workspaceId;

    const upsertPage = db.prepare(`
      INSERT INTO memory_pages (
        id, workspaceId, path, title, description, contentHash, version,
        pageType, visibilityKind, visibilityImUserId, encrypted, stale,
        archivedAt, sourceAssetId, sourceRefsJson, syncStatus,
        createdAt, updatedAt, sourceKind, replicaActorIdsJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'acked', ?, ?, ?, ?)
      ON CONFLICT(workspaceId, path) DO UPDATE SET
        id = excluded.id,
        title = excluded.title,
        description = excluded.description,
        contentHash = excluded.contentHash,
        version = excluded.version,
        pageType = excluded.pageType,
        visibilityKind = excluded.visibilityKind,
        visibilityImUserId = excluded.visibilityImUserId,
        encrypted = excluded.encrypted,
        stale = excluded.stale,
        sourceRefsJson = excluded.sourceRefsJson,
        syncStatus = 'acked',
        updatedAt = excluded.updatedAt,
        sourceKind = excluded.sourceKind,
        replicaActorIdsJson = excluded.replicaActorIdsJson
    `);
    const upsertVersion = db.prepare(`
      INSERT OR REPLACE INTO memory_page_versions
        (pageId, version, contentHash, actorImUserId, actorKind, deviceId, createdAt)
      VALUES (?, ?, ?, 'cloud-sync', 'agent', ?, ?)
    `);
    const upsertContent = db.prepare(`
      INSERT OR REPLACE INTO memory_page_content (pageId, version, payloadKind, payloadValue)
      VALUES (?, ?, ?, ?)
    `);
    const deleteFts = db.prepare('DELETE FROM memory_fts WHERE pageId = ?');
    const insertFts = db.prepare(`
      INSERT INTO memory_fts (pageId, workspaceId, path, title, description, content, cjk)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const findPageByPath = db.prepare(
      'SELECT id FROM memory_pages WHERE workspaceId = ? AND path = ?',
    );
    const findPageById = db.prepare(
      'SELECT id, path FROM memory_pages WHERE workspaceId = ? AND id = ?',
    );
    const deletePageById = db.prepare('DELETE FROM memory_pages WHERE workspaceId = ? AND id = ?');
    const deleteFtsById = db.prepare('DELETE FROM memory_fts WHERE pageId = ?');
    const deleteLink = db.prepare(
      'DELETE FROM memory_links WHERE workspaceId = ? AND sourceUri = ? AND targetUri = ? AND relation = ?',
    );

    const tx = db.transaction(() => {
      const now = Date.now();
      for (const h of input.heads) {
        // A replicated path is authoritative: if a local-authored row with a
        // DIFFERENT id sits on this path, it is replaced (the cloud id wins on
        // controlled paths — otherwise the diff would see a controlled row
        // outside the complete set and delete it on the next reconcile).
        const existing = findPageByPath.get(ws, h.path) as { id: string } | undefined;
        if (existing && existing.id !== h.id) {
          deletePageById.run(ws, existing.id); // CASCADE removes versions/content
          deleteFtsById.run(existing.id);
        }
        // Symmetric case (reviewer I1): the SAME id re-landed on a CHANGED
        // path. The upsert's (workspaceId,path) conflict target does not match
        // a moved path, so a bare INSERT would hit the id PRIMARY KEY and
        // abort the whole reconcile — permanently, because the id-based diff
        // never removes the stale old-path row. Remove it HERE, in the same
        // transaction, before the upsert lands the head on its new path.
        const existingById = findPageById.get(ws, h.id) as { id: string; path: string } | undefined;
        if (existingById && existingById.path !== h.path) {
          deletePageById.run(ws, existingById.id); // CASCADE removes versions/content
          deleteFtsById.run(existingById.id);
        }

        // reviewer I2 — the landing goes through the SAME seal path as the
        // normal write() (payloadKind/payloadValue from sealPlaintext; a
        // non-inline seal is refused exactly like write()'s phase-0 guard)
        // and the encrypted intent flag follows write()'s policy contract
        // (no explicit per-head flag → the activation policy applies, so a
        // policy-enabled store lands reconciled rows with the same
        // encrypted=1 intent marker a locally-authored write gets; FTS keeps
        // plaintext exactly as write() does).
        const sealed = sealPlaintext(h.content);
        if (sealed.kind !== 'inline') {
          throw new Error(
            'MemoryStore.applyReplicaCommit: non-inline seal payload not supported in phase-0',
          );
        }
        const encryptedFlag = this.opts.encryptionPolicy?.() ? 1 : 0;
        upsertPage.run(
          h.id, ws, h.path, h.title, h.description, h.contentHash, h.version,
          h.pageType, h.visibilityKind, h.visibilityImUserId,
          encryptedFlag,
          h.stale ? 1 : 0,
          h.sourceRefsJson,
          now, h.updatedAtMs, h.sourceKind, h.replicaActorIdsJson,
        );
        upsertVersion.run(h.id, h.version, h.contentHash, this.opts.deviceId, now);
        upsertContent.run(h.id, h.version, sealed.kind, sealed.content);
        deleteFts.run(h.id);
        insertFts.run(
          h.id,
          ws,
          h.path,
          h.title ?? '',
          h.description ?? '',
          h.content,
          cjkBigramText(h.title ?? '', h.description ?? '', h.content),
        );
      }

      // §9.3 step 7 + §9.6 — diff-delete controlled rows no longer visible +
      // tombstone aggregates. Page delete CASCADES version/content; FTS and
      // URI-keyed links have no FK so they are removed explicitly.
      const doomed = new Map<string, string>(); // pageId -> path (for link URI resolution)
      const doomedIds = [...new Set([...input.diffDeletePageIds, ...input.tombstonePageIds])];
      if (doomedIds.length > 0) {
        const placeholders = doomedIds.map(() => '?').join(',');
        const rows = db
          .prepare(`SELECT id, path FROM memory_pages WHERE workspaceId = ? AND id IN (${placeholders})`)
          .all(ws, ...doomedIds) as { id: string; path: string }[];
        for (const r of rows) doomed.set(r.id, r.path);
        if (rows.length > 0) {
          const ids = rows.map((r) => r.id);
          const idPlaceholders = ids.map(() => '?').join(',');
          db.prepare(`DELETE FROM memory_pages WHERE id IN (${idPlaceholders})`).run(...ids);
          db.prepare(`DELETE FROM memory_fts WHERE pageId IN (${idPlaceholders})`).run(...ids);
          const removedPaths = new Set(rows.map((r) => r.path));
          const links = db
            .prepare('SELECT sourceUri, targetUri, relation FROM memory_links WHERE workspaceId = ?')
            .all(ws) as { sourceUri: string; targetUri: string; relation: string }[];
          for (const l of links) {
            const srcPath = pathFromMemoryUri(l.sourceUri)?.path;
            const tgtPath = pathFromMemoryUri(l.targetUri)?.path;
            if ((srcPath && removedPaths.has(srcPath)) || (tgtPath && removedPaths.has(tgtPath))) {
              deleteLink.run(ws, l.sourceUri, l.targetUri, l.relation);
            }
          }
        }
      }

      // §9.3 step 9 — cursor/epoch/hash/watermark/lease/ready in the SAME tx.
      db.prepare(
        `INSERT INTO memory_replica_state (
           workspaceId, cursor, accessVersion, replicaSubjectHash,
           contentHighWatermarkJson, status, leaseExpiresAt, updatedAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspaceId) DO UPDATE SET
           cursor = excluded.cursor,
           accessVersion = excluded.accessVersion,
           replicaSubjectHash = excluded.replicaSubjectHash,
           contentHighWatermarkJson = excluded.contentHighWatermarkJson,
           status = excluded.status,
           leaseExpiresAt = excluded.leaseExpiresAt,
           updatedAt = excluded.updatedAt`,
      ).run(
        ws,
        input.state.cursor,
        input.state.accessVersion,
        input.state.replicaSubjectHash,
        input.state.contentHighWatermarkJson,
        input.state.status,
        input.state.leaseExpiresAt,
        now,
      );
    });
    tx();
  }

  /**
   * §9.3 step 7 — the local CONTROLLED set: rows this store holds as
   * replicated (replicaActorIdsJson NOT NULL). Diffed against the complete
   * manifest set; the remainder is deleted. Local-authored rows (NULL) are
   * never part of this set.
   */
  loadReplicaPageIds(): string[] {
    const rows = this.requireDb()
      .prepare(
        'SELECT id FROM memory_pages WHERE workspaceId = ? AND replicaActorIdsJson IS NOT NULL ORDER BY id',
      )
      .all(this.opts.workspaceId) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /**
   * §9.3 step 1 + §9.5 — the agent-recall gate. Called at the top of every
   * content-serving read (load/list/neighbors/index/content). Fail closed:
   *   - no replica state row → legacy semantics (open);
   *   - status ready with accessVersion=0 → legacy marker (open, old model —
   *     the strict path always commits accessVersion > 0);
   *   - status ready with accessVersion > 0 → authorized ONLY while the
   *     registered Cloud authority snapshot still matches the pinned
   *     epoch/subject hash AND neither the snapshot nor the local lease
   *     expired (offline lease expiry → stale → closed);
   *   - any other status → closed (intermediate states never open recall).
   */
  assertReplicaRecallOpen(): void {
    const state = this.getReplicaState();
    if (!state) return;
    if (state.status === 'ready') {
      if (state.accessVersion === 0) return; // legacy marker — old semantics
      const now = Date.now();
      if (state.leaseExpiresAt > 0 && now >= state.leaseExpiresAt) {
        this.setReplicaStatus('stale');
        throw new MemoryReplicaNotReadyError('replica lease expired (offline)');
      }
      const snapshot = getMemoryAuthoritySnapshot(this.opts.workspaceId);
      if (!snapshot) {
        throw new MemoryReplicaNotReadyError('no registered authority snapshot');
      }
      if (
        snapshot.accessVersion !== state.accessVersion ||
        snapshot.replicaSubjectHash !== state.replicaSubjectHash
      ) {
        throw new MemoryReplicaNotReadyError('authority snapshot epoch/subject drift');
      }
      const validUntil = Date.parse(snapshot.validUntil);
      if (!Number.isFinite(validUntil) || now >= validUntil) {
        this.setReplicaStatus('stale');
        throw new MemoryReplicaNotReadyError('authority snapshot expired');
      }
      return;
    }
    throw new MemoryReplicaNotReadyError(`replica status=${state.status}`);
  }

  /**
   * Internal accessor for outbox.ts — outbox writes its own table within the
   * same DB. Returning the live Database handle keeps outbox transactions
   * shareable with store transactions if ever needed.
   */
  rawDb(): Database.Database {
    return this.requireDb();
  }

  /** Workspace this store is bound to (read-only). */
  workspaceId(): string {
    return this.opts.workspaceId;
  }

  /** Device id stamped onto version + outbox rows. */
  deviceId(): string {
    return this.opts.deviceId;
  }

  private requireDb(): Database.Database {
    if (!this.db) throw new Error('MemoryStore: open() must be called before use');
    return this.db;
  }

  private rowToPage(row: PageRow): ReplicaAwareMemoryPage {
    const visibility: MemoryVisibility =
      row.visibilityKind === 'workspace'
        ? { kind: 'workspace' }
        : row.visibilityKind === 'agent'
          ? { kind: 'agent', imUserId: row.visibilityImUserId ?? '' }
          : row.visibilityKind === 'role'
            ? { kind: 'role', slug: row.visibilityImUserId ?? '' }
            : row.visibilityKind === 'council'
              ? { kind: 'council', id: row.visibilityImUserId ?? '' }
              : row.visibilityKind === 'task'
                ? { kind: 'task', id: row.visibilityImUserId ?? '' }
                : { kind: 'private', imUserId: row.visibilityImUserId ?? '' };
    // §8.3/§9.4 — parse the exact actor set. NULL = pre-V3/local-authored.
    // Tampered JSON fails closed (typed error — never a wider grant).
    let replicaActorIds: string[] | null = null;
    if (row.replicaActorIdsJson !== null && row.replicaActorIdsJson !== undefined) {
      try {
        const parsed = JSON.parse(row.replicaActorIdsJson) as unknown;
        if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
          throw new MemoryReplicaNotReadyError(
            `tampered replicaActorIdsJson for page ${row.id} (not a string array)`,
          );
        }
        replicaActorIds = parsed as string[];
      } catch (err) {
        if (err instanceof MemoryReplicaNotReadyError) throw err;
        throw new MemoryReplicaNotReadyError(
          `tampered replicaActorIdsJson for page ${row.id} (unparseable)`,
        );
      }
    }
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      path: row.path,
      title: row.title,
      description: row.description,
      contentHash: row.contentHash,
      version: row.version,
      pageType: row.pageType as MemoryPageType,
      visibility,
      encrypted: row.encrypted === 1,
      stale: row.stale === 1,
      archivedAt: row.archivedAt,
      sourceAssetId: row.sourceAssetId,
      sourceRefs: JSON.parse(row.sourceRefsJson) as string[],
      syncStatus: row.syncStatus as MemorySyncStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      // §9.4 V3 columns — carried so the boundary predicate can run the exact
      // actor-set check BEFORE coarse visibility (acl-predicate.ts).
      sourceKind: row.sourceKind as MemoryReplicaSourceKind,
      replicaActorIds,
    };
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Extract the relative page path (and optional `#section` anchor) from a daemon
 * memory-link URI.
 *
 * Mirrors the cloud `memory-write.service.ts#hrefToMemoryPath` tolerance: a link
 * URI may be the CANONICAL cloud form `prismer://workspace/<ws>/memory/<path>`
 * (what the cloud write path materialises and the down-sync mirror stores) or
 * the bare daemon form `pkm://<path>`. The `<ws>` segment is tolerated but NOT
 * trusted — resolution always happens inside this store's own workspace — and a
 * leading `memory/` on the remainder is dropped by `normalizeMemoryPath`. The
 * workspace form previously resolved to the literal path `workspace/<ws>/…`,
 * which matched no page row: locally synced links were silently absent from
 * graph expansion and from the hop-decision payload (hubPath / childrenCount /
 * outboundPreview) that the §6.9 裁决 1 navigation orders by. Non-page
 * resources (`session` / `search` / `asset`) return null, as on the cloud.
 *
 * memory202/09 P0: the `#section` anchor is no longer discarded — it is returned
 * separately so `load`/recall can address a sub-section. `path` is still the
 * anchor-stripped page path, so `linkNeighbors` path matching is byte-for-byte
 * unchanged for the bare forms (it reads `.path`).
 */
function pathFromMemoryUri(uri: string): { path: string; section?: string } | null {
  const schemeIdx = uri.indexOf('://');
  if (schemeIdx <= 0) return null;
  const scheme = uri.slice(0, schemeIdx).toLowerCase();
  let rest = uri.slice(schemeIdx + 3);
  let section: string | undefined;
  const anchorIdx = rest.indexOf('#');
  if (anchorIdx >= 0) {
    const anchor = rest.slice(anchorIdx + 1).trim();
    if (anchor) section = anchor;
    rest = rest.slice(0, anchorIdx);
  }
  rest = rest.trim();
  if (!rest || rest.startsWith('/') || rest.includes('..')) return null;
  if (scheme === 'prismer') {
    const segments = rest.split('/').filter((s) => s.length > 0);
    if (segments[0] !== 'workspace' || segments.length < 3) return null;
    rest = segments.slice(2).join('/'); // drop workspace/<ws> — tolerated, never trusted
    if (rest.startsWith('session/') || rest.startsWith('search/') || rest.startsWith('asset/')) return null;
  }
  if (!rest) return null;
  return section ? { path: rest, section } : { path: rest };
}
