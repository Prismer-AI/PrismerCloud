// product209/16 §9.3 — MA-2 snapshot-fenced full reconcile (Runtime side).
//
// Verifies the ten-step reconcile against a stubbed Cloud (manifest + content
// wire shapes fixed by Task 11), the §9.4 replica state machine, and the
// §8.3 exact-actor-set predicate:
//   - reconciling suspends agent recall; ready re-opens it;
//   - the first manifest page pins epoch/subject/content high watermark; any
//     later drift (or a Cloud 409) aborts the reconcile and leaves the store
//     suspended — never ready, never half-applied;
//   - content comes ONLY from POST /memory/sync/content; encrypted-pkf
//     verifies transportHash → decrypts → verifies plaintext contentHash;
//     legacy-html lands via the compat text path (never canonical PKF);
//   - each replicated row carries sorted replicaActorIdsJson + sourceKind;
//   - the local controlled set is diffed against the complete set: removed
//     pages lose page/version/content/link/FTS in the SAME transaction as
//     the cursor/epoch/hash/lease/ready commit;
//   - tombstones delete the page aggregate;
//   - lease expiry (offline) and snapshot invalidation both close agent
//     recall even when the persisted status is still ready (fail closed);
//   - the §8.3 predicate checks the exact actor set BEFORE coarse
//     visibility/principal rules: A/B swap, empty set, non-member principal
//     all denied; NULL = local-authored row → normal rules; system bypasses.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CloudClient, CloudResponse } from '../src/auth.js';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { MemoryStore, MemoryReplicaNotReadyError } from '../src/daemon/memory/store.js';
import {
  registerMemoryAuthoritySnapshot,
  invalidateMemoryAuthoritySnapshot,
  __resetCapKeyForTest,
  computeMemoryAuthoritySnapshotHash,
  type MemoryAuthoritySnapshotBundleV1,
  type MemoryCap,
} from '../src/daemon/memory/cap.js';
import { reconcileReplicaFromCloud, initialSyncFromCloud } from '../src/daemon/memory/cloud-sync.js';
import { canCapReadPage } from '../src/daemon/memory/acl-predicate.js';
import { encrypt as gcmEncrypt } from '../src/daemon/memory/crypto-cipher.js';
import type { MemoryKeyManager } from '../src/daemon/memory/key-manager.js';

const WS = 'ws_replica';
const DAEMON_ID = 'daemon-replica-test';

let dir = '';
let runtime: MemoryRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prismer-replica-'));
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
});

afterEach(() => {
  runtime.closeAll();
  __resetCapKeyForTest();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ─── snapshot fixture ───────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<MemoryAuthoritySnapshotBundleV1> = {}): MemoryAuthoritySnapshotBundleV1 {
  const validUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const base: Omit<MemoryAuthoritySnapshotBundleV1, 'snapshotHash'> = {
    schemaVersion: 1,
    workspaceId: WS,
    daemonId: DAEMON_ID,
    replicaMode: 'strict',
    minRuntimeVersion: '2.2.12',
    requiredRuntimeCapabilities: [
      'memory-authority-snapshot-v1',
      'memory-replica-manifest-v1',
      'memory-replica-content-v1',
    ],
    accessVersion: 7,
    replicaSubjectHash: 'sha256:subject-e1',
    issuedAt,
    validUntil,
    actors: [
      {
        actorId: 'im_agent_a',
        actorKind: 'agent',
        principalKind: 'human',
        principalId: 'im_member_1',
        authority: 'deputy',
        roleSlugs: [],
        taskIds: [],
        councilIds: [],
        canCurate: false,
        canReplicate: true,
      },
      {
        actorId: 'im_agent_b',
        actorKind: 'agent',
        principalKind: 'human',
        principalId: 'im_member_2',
        authority: 'deputy',
        roleSlugs: [],
        taskIds: [],
        councilIds: [],
        canCurate: false,
        canReplicate: true,
      },
    ],
    ...overrides,
  };
  return { ...base, snapshotHash: computeMemoryAuthoritySnapshotHash(base) };
}

function registerSnapshot(): MemoryAuthoritySnapshotBundleV1 {
  const snapshot = makeSnapshot();
  expect(registerMemoryAuthoritySnapshot(snapshot, DAEMON_ID)).toBe(true);
  return snapshot;
}

// ─── cloud stub (Task 11 wire shapes) ───────────────────────────────────────

interface ManifestHead {
  pageId: string;
  uri: string;
  path: string;
  title: string | null;
  description: string | null;
  pageType: string;
  version: number;
  sourceKind: 'pkf' | 'legacy-html' | 'encrypted-pkf';
  sourceRevisionId: string;
  contentEncoding: 'utf-8' | 'prismer-gcm-packed-v1';
  contentHash: string;
  transportHash: string;
  visibility: { kind: string; subjectId?: string };
  replicaActorIds: string[];
  encrypted: boolean;
  stale: boolean;
  sourceRefs: string[];
  updatedAt: string;
}

function sha256(s: string): string {
  return `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;
}

interface ManifestPage {
  heads: ManifestHead[];
  tombstones?: { pageId: string; uri: string; path: string; deletedAt: string }[];
  hasMore?: boolean;
  nextCursor?: string | null;
  snapshotAccessVersion?: number;
  replicaSubjectHash?: string;
}

interface StubOptions {
  /** per-call manifest pages (first call → index 0). */
  manifests: ManifestPage[];
  /** content lookup by pageId. */
  contents: Map<string, { content: string; contentEncoding?: 'utf-8' | 'prismer-gcm-packed-v1' }>;
  /** force a specific HTTP status on manifest/content calls. */
  manifestStatus?: number;
  contentStatus?: number;
  manifestErrorCode?: string;
}

function makeCloud(opts: StubOptions): { cloud: CloudClient; calls: string[] } {
  const calls: string[] = [];
  let manifestIdx = 0;
  const cloud = {
    async request<T = unknown>(method: string, path: string, init?: { body?: unknown }): Promise<CloudResponse<T>> {
      calls.push(`${method} ${path}`);
      if (path.includes('/memory/sync/manifest')) {
        if (opts.manifestStatus && opts.manifestStatus !== 200) {
          return {
            ok: false,
            status: opts.manifestStatus,
            error: { code: opts.manifestErrorCode ?? 'MEMORY_REPLICA_RECONCILE_REQUIRED', message: 'stub' },
          } as CloudResponse<T>;
        }
        const page = opts.manifests[Math.min(manifestIdx, opts.manifests.length - 1)];
        manifestIdx++;
        const data = {
          ok: true,
          data: {
            schemaVersion: 1,
            mode: 'strict',
            snapshotAccessVersion: page?.snapshotAccessVersion ?? 7,
            replicaSubjectHash: page?.replicaSubjectHash ?? 'sha256:subject-e1',
            snapshotToken: `v1.1.${Buffer.from('tok').toString('base64url')}.sig`,
            contentHighWatermark: { updatedAt: new Date(Date.now()).toISOString(), id: 'zzzz' },
            nextCursor: page?.hasMore ? (page.nextCursor ?? 'cursor-next') : null,
            hasMore: page?.hasMore ?? false,
            heads: page?.heads ?? [],
            tombstones: page?.tombstones ?? [],
          },
        } as unknown as T;
        return { ok: true, status: 200, data } as CloudResponse<T>;
      }
      if (path.includes('/memory/sync/content')) {
        if (opts.contentStatus && opts.contentStatus !== 200) {
          return {
            ok: false,
            status: opts.contentStatus,
            error: { code: 'MEMORY_REPLICA_RECONCILE_REQUIRED', message: 'stub' },
          } as CloudResponse<T>;
        }
        const body = init?.body as { pageId: string; transportHash: string };
        const found = opts.contents.get(body.pageId);
        if (!found) {
          return {
            ok: false,
            status: 410,
            error: { code: 'MEMORY_REPLICA_REVISION_GONE', message: 'stub' },
          } as CloudResponse<T>;
        }
        const contentEncoding = found.contentEncoding ?? 'utf-8';
        const data = {
          ok: true,
          data: {
            schemaVersion: 1,
            pageId: body.pageId,
            sourceKind: 'pkf',
            sourceRevisionId: 'rev',
            contentHash: sha256(contentEncoding === 'prismer-gcm-packed-v1' ? 'PLAINTEXT' : found.content),
            transportHash: sha256(found.content),
            contentEncoding,
            content: found.content,
          },
        } as unknown as T;
        return { ok: true, status: 200, data } as CloudResponse<T>;
      }
      // legacy pages path — the reconcile must NEVER reach it.
      return {
        ok: false,
        status: 426,
        error: { code: 'MEMORY_RUNTIME_UPGRADE_REQUIRED', message: 'stub' },
      } as CloudResponse<T>;
    },
  } as unknown as CloudClient;
  return { cloud, calls };
}

function head(overrides: Partial<ManifestHead> = {}): ManifestHead {
  return {
    pageId: 'p1',
    uri: `prismer://workspace/${WS}/memory/note/a.md`,
    path: 'note/a.md',
    title: 'A',
    description: null,
    pageType: 'leaf',
    version: 3,
    sourceKind: 'pkf',
    sourceRevisionId: 'rev-p1',
    contentEncoding: 'utf-8',
    contentHash: sha256('content-A'),
    transportHash: sha256('content-A'),
    visibility: { kind: 'workspace' },
    replicaActorIds: ['im_agent_a'],
    encrypted: false,
    stale: false,
    sourceRefs: [],
    updatedAt: new Date(Date.now()).toISOString(),
    ...overrides,
  };
}

/** No-op key manager for encrypted fixtures. */
function keyManagerWith(key: Buffer): MemoryKeyManager {
  return {
    getKey: (_ws: string) => key,
  } as unknown as MemoryKeyManager;
}

function store(): MemoryStore {
  return runtime.resolve(WS).store;
}

// ─── reconcile (ten steps) ──────────────────────────────────────────────────

describe('replica reconcile (§9.3)', () => {
  it('reconciles heads, commits ready atomically, and re-opens recall', async () => {
    registerSnapshot();
    const h = head();
    const contents = new Map([['p1', { content: 'content-A' }]]);
    const { cloud, calls } = makeCloud({ manifests: [{ heads: [h] }], contents });

    const result = await reconcileReplicaFromCloud(runtime, cloud, WS);

    expect(result.status).toBe('ready');
    expect(result.pagesApplied).toBe(1);
    const st = store().getReplicaState();
    expect(st?.status).toBe('ready');
    expect(st?.accessVersion).toBe(7);
    expect(st?.replicaSubjectHash).toBe('sha256:subject-e1');
    expect(st?.leaseExpiresAt).toBeGreaterThan(Date.now());

    const row = store()
      .rawDb()
      .prepare('SELECT sourceKind, replicaActorIdsJson FROM memory_pages WHERE id = ?')
      .get('p1') as { sourceKind: string; replicaActorIdsJson: string };
    expect(row.sourceKind).toBe('pkf');
    expect(JSON.parse(row.replicaActorIdsJson)).toEqual(['im_agent_a']);

    // recall re-opens after ready.
    expect(store().loadByPath('note/a.md')?.contentHash).toBe(sha256('content-A'));
    // content came exclusively from POST content (never the legacy pages list).
    expect(calls.some((c) => c.includes('/memory/sync/manifest'))).toBe(true);
    expect(calls.some((c) => c.includes('/memory/sync/content'))).toBe(true);
    expect(calls.some((c) => c.includes('/memory/pages?'))).toBe(false);
  });

  it('pins the first page epoch and aborts on mid-pagination drift (409 → suspended, nothing applied)', async () => {
    registerSnapshot();
    const h = head();
    const contents = new Map([['p1', { content: 'content-A' }]]);
    // Page 1 fine; page 2 (cursor continuation) drifts the subject hash.
    const { cloud } = makeCloud({
      manifests: [
        { heads: [h], hasMore: true, nextCursor: 'cursor-1' },
        { heads: [], replicaSubjectHash: 'sha256:subject-e2' },
      ],
      contents,
    });

    const result = await reconcileReplicaFromCloud(runtime, cloud, WS);

    expect(result.status).toBe('suspended');
    expect(store().getReplicaState()?.status).toBe('suspended');
    // nothing applied: the local write happens only in the atomic commit.
    expect(store().loadReplicaPageIds()).toHaveLength(0);
  });

  it('Cloud 409 on manifest aborts: status suspended, recall stays closed, no state advance', async () => {
    registerSnapshot();
    const { cloud } = makeCloud({
      manifests: [],
      contents: new Map(),
      manifestStatus: 409,
      manifestErrorCode: 'MEMORY_REPLICA_RECONCILE_REQUIRED',
    });
    store().markLegacyReplicaReady('wm:1'); // prior legacy marker — reconcile must not build on it
    const result = await reconcileReplicaFromCloud(runtime, cloud, WS);
    expect(result.status).toBe('suspended');
    const st = store().getReplicaState();
    expect(st?.status).toBe('suspended');
    expect(st?.accessVersion).toBe(0); // legacy epoch NOT treated as authorization
    expect(() => store().loadByPath('note/a.md')).toThrow(MemoryReplicaNotReadyError);
  });

  it('recall is closed while reconciling and after a failed reconcile (intermediate state never opens recall)', async () => {
    registerSnapshot();
    const h = head();
    const contents = new Map([['p1', { content: 'content-A' }]]);
    const { cloud } = makeCloud({ manifests: [{ heads: [h] }], contents });

    store().setReplicaStatus('reconciling');
    expect(() => store().loadByPath('note/a.md')).toThrow(MemoryReplicaNotReadyError);
    expect(() => store().loadById('p1')).toThrow(MemoryReplicaNotReadyError);
    expect(() => store().list()).toThrow(MemoryReplicaNotReadyError);

    await reconcileReplicaFromCloud(runtime, cloud, WS);
    expect(store().loadByPath('note/a.md')).not.toBeNull();
  });

  it('encrypted-pkf: transport hash → decrypt → plaintext hash verified before landing', async () => {
    registerSnapshot();
    const key = Buffer.alloc(32, 7);
    const plaintext = 'PLAINTEXT';
    const packed = gcmEncrypt(plaintext, key);
    const h = head({
      sourceKind: 'encrypted-pkf',
      encrypted: true,
      contentEncoding: 'prismer-gcm-packed-v1',
      contentHash: sha256(plaintext),
      transportHash: sha256(packed),
    });
    const { cloud } = makeCloud({
      manifests: [{ heads: [h] }],
      contents: new Map([['p1', { content: packed, contentEncoding: 'prismer-gcm-packed-v1' }]]),
    });

    const result = await reconcileReplicaFromCloud(runtime, cloud, WS, keyManagerWith(key));
    expect(result.status).toBe('ready');
    // local store holds PLAINTEXT (the local-first model), sourceKind preserved.
    const row = store()
      .rawDb()
      .prepare('SELECT sourceKind FROM memory_pages WHERE id = ?')
      .get('p1') as { sourceKind: string };
    expect(row.sourceKind).toBe('encrypted-pkf');
    const content = store()
      .rawDb()
      .prepare('SELECT payloadValue FROM memory_page_content WHERE pageId = ? AND version = 3')
      .get('p1') as { payloadValue: string };
    expect(content.payloadValue).toBe(plaintext);
  });

  it('tampered ciphertext fails transport hash verification → reconcile aborts (nothing applied)', async () => {
    registerSnapshot();
    const key = Buffer.alloc(32, 7);
    const plaintext = 'PLAINTEXT';
    const packed = gcmEncrypt(plaintext, key);
    const h = head({
      sourceKind: 'encrypted-pkf',
      encrypted: true,
      contentEncoding: 'prismer-gcm-packed-v1',
      contentHash: sha256(plaintext),
      transportHash: sha256(packed),
    });
    const { cloud } = makeCloud({
      manifests: [{ heads: [h] }],
      // stub returns ciphertext for a DIFFERENT plaintext — transport hash won't match.
      contents: new Map([['p1', { content: gcmEncrypt('TAMPERED', key), contentEncoding: 'prismer-gcm-packed-v1' }]]),
    });
    const result = await reconcileReplicaFromCloud(runtime, cloud, WS, keyManagerWith(key));
    expect(result.status).toBe('suspended');
    expect(store().loadReplicaPageIds()).toHaveLength(0);
  });

  it('legacy-html lands via the compat text path (sourceKind preserved; never canonical PKF)', async () => {
    registerSnapshot();
    const html = '<h1>Legacy</h1><p>body</p>';
    const h = head({
      sourceKind: 'legacy-html',
      contentHash: sha256(html),
      transportHash: sha256(html),
      contentEncoding: 'utf-8',
    });
    const { cloud } = makeCloud({
      manifests: [{ heads: [h] }],
      contents: new Map([['p1', { content: html }]]),
    });
    const result = await reconcileReplicaFromCloud(runtime, cloud, WS);
    expect(result.status).toBe('ready');
    const row = store()
      .rawDb()
      .prepare('SELECT sourceKind, replicaActorIdsJson FROM memory_pages WHERE id = ?')
      .get('p1') as { sourceKind: string; replicaActorIdsJson: string };
    expect(row.sourceKind).toBe('legacy-html');
    expect(JSON.parse(row.replicaActorIdsJson)).toEqual(['im_agent_a']);
    const content = store()
      .rawDb()
      .prepare('SELECT payloadValue FROM memory_page_content WHERE pageId = ?')
      .get('p1') as { payloadValue: string };
    expect(content.payloadValue).toBe(html);
  });

  it('ACL shrink: diff deletes controlled rows absent from the complete set — page/version/content/link/FTS all cleared', async () => {
    registerSnapshot();
    // Seed a previously-replicated row (page+version+content+FTS+link) the new
    // manifest no longer contains.
    const db = store().rawDb();
    db.prepare(
      `INSERT INTO memory_pages (id, workspaceId, path, title, contentHash, version, pageType, visibilityKind, stale, sourceRefsJson, syncStatus, createdAt, updatedAt, sourceKind, replicaActorIdsJson)
       VALUES ('gone', ?, 'note/gone.md', 'Gone', ?, 1, 'leaf', 'workspace', 0, '[]', 'acked', 1, 1, 'pkf', ?)`,
    ).run(WS, sha256('gone'), JSON.stringify(['im_agent_a']));
    db.prepare(
      `INSERT INTO memory_page_versions (pageId, version, contentHash, actorImUserId, actorKind, deviceId, createdAt)
       VALUES ('gone', 1, ?, 'cloud-sync', 'agent', 'dev_x', 1)`,
    ).run(sha256('gone'));
    db.prepare(
      `INSERT INTO memory_page_content (pageId, version, payloadKind, payloadValue) VALUES ('gone', 1, 'inline', 'gone')`,
    ).run();
    db.prepare(
      `INSERT INTO memory_fts (pageId, workspaceId, path, title, description, content) VALUES ('gone', ?, 'note/gone.md', 'Gone', '', 'gone')`,
    ).run(WS);
    db.prepare(
      `INSERT INTO memory_links (workspaceId, sourceUri, targetUri, relation, weight, createdAt)
       VALUES (?, 'pkm://note/gone.md', 'pkm://note/other.md', 'child-of', 1.0, 1)`,
    ).run(WS);
    expect(store().loadReplicaPageIds()).toEqual(['gone']);

    const h = head();
    const { cloud } = makeCloud({
      manifests: [{ heads: [h] }],
      contents: new Map([['p1', { content: 'content-A' }]]),
    });
    const result = await reconcileReplicaFromCloud(runtime, cloud, WS);
    expect(result.status).toBe('ready');
    expect(result.pagesDeleted).toBe(1);

    expect(store().loadById('gone')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_page_versions WHERE pageId = ?').get('gone')).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_page_content WHERE pageId = ?').get('gone')).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_fts WHERE pageId = ?').get('gone')).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_links WHERE sourceUri LIKE ?').get('%gone.md')).toMatchObject({ n: 0 });
  });

  it('locally-authored rows (replicaActorIdsJson NULL) survive the diff', async () => {
    registerSnapshot();
    store().write({
      workspaceId: WS,
      path: 'local/keep.md',
      content: 'local',
      actorImUserId: 'im_agent_a',
      actorKind: 'agent',
    });
    const h = head();
    const { cloud } = makeCloud({
      manifests: [{ heads: [h] }],
      contents: new Map([['p1', { content: 'content-A' }]]),
    });
    const result = await reconcileReplicaFromCloud(runtime, cloud, WS);
    expect(result.status).toBe('ready');
    expect(result.pagesDeleted).toBe(0);
    expect(store().loadByPath('local/keep.md')).not.toBeNull();
  });

  it('tombstones delete the page aggregate', async () => {
    registerSnapshot();
    // A controlled row exists locally; the manifest only returns its tombstone.
    const db = store().rawDb();
    db.prepare(
      `INSERT INTO memory_pages (id, workspaceId, path, title, contentHash, version, pageType, visibilityKind, stale, sourceRefsJson, syncStatus, createdAt, updatedAt, sourceKind, replicaActorIdsJson)
       VALUES ('dead', ?, 'note/dead.md', 'Dead', ?, 1, 'leaf', 'workspace', 0, '[]', 'acked', 1, 1, 'pkf', ?)`,
    ).run(WS, sha256('dead'), JSON.stringify(['im_agent_a']));
    db.prepare(
      `INSERT INTO memory_page_versions (pageId, version, contentHash, actorImUserId, actorKind, deviceId, createdAt)
       VALUES ('dead', 1, ?, 'cloud-sync', 'agent', 'dev_x', 1)`,
    ).run(sha256('dead'));
    db.prepare(
      `INSERT INTO memory_page_content (pageId, version, payloadKind, payloadValue) VALUES ('dead', 1, 'inline', 'dead')`,
    ).run();

    const { cloud } = makeCloud({
      manifests: [
        {
          heads: [],
          tombstones: [{ pageId: 'dead', uri: 'pkm://note/dead.md', path: 'note/dead.md', deletedAt: new Date().toISOString() }],
        },
      ],
      contents: new Map(),
    });
    const result = await reconcileReplicaFromCloud(runtime, cloud, WS);
    expect(result.status).toBe('ready');
    expect(store().loadById('dead')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_page_versions WHERE pageId = ?').get('dead')).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_page_content WHERE pageId = ?').get('dead')).toMatchObject({ n: 0 });
  });

  it('catch-up pass (step 10): content created during reconcile is picked up after the atomic commit', async () => {
    registerSnapshot();
    const h1 = head();
    const h2 = head({ pageId: 'p2', path: 'note/b.md', contentHash: sha256('content-B'), transportHash: sha256('content-B') });
    const { cloud } = makeCloud({
      manifests: [{ heads: [h1] }, { heads: [h1, h2] }],
      contents: new Map([
        ['p1', { content: 'content-A' }],
        ['p2', { content: 'content-B' }],
      ]),
    });
    const result = await reconcileReplicaFromCloud(runtime, cloud, WS);
    expect(result.status).toBe('ready');
    expect(store().loadByPath('note/b.md')?.contentHash).toBe(sha256('content-B'));
  });

  it('reconcile without a registered snapshot fails closed (stays suspended, no mint, no ready)', async () => {
    // No registerSnapshot() — the registry is empty.
    const h = head();
    const { cloud } = makeCloud({ manifests: [{ heads: [h] }], contents: new Map([['p1', { content: 'content-A' }]]) });
    const result = await reconcileReplicaFromCloud(runtime, cloud, WS);
    expect(result.status).toBe('suspended');
    expect(store().getReplicaState()?.status).toBe('suspended');
  });

  it('initialSyncFromCloud routes strict workspaces to the V3 port (never the legacy pages list)', async () => {
    registerSnapshot();
    runtime.resolve(WS); // initialSyncFromCloud skips workspaces without an open store (peek)
    const h = head();
    const { cloud, calls } = makeCloud({
      manifests: [{ heads: [h] }],
      contents: new Map([['p1', { content: 'content-A' }]]),
    });
    const result = await initialSyncFromCloud(runtime, cloud, WS);
    expect(result.pulled).toBe(1);
    expect(calls.some((c) => c.includes('/memory/sync/manifest'))).toBe(true);
    expect(calls.some((c) => c.includes('/memory/pages?'))).toBe(false);
    expect(store().getReplicaState()?.status).toBe('ready');
  });

  // ── Fix round 1 (reviewer I1) — same pageId re-landed on a different path ──
  it('same pageId on a changed path reconciles cleanly: old-path row removed in the same transaction (no PK abort)', async () => {
    registerSnapshot();
    // Seed a previously-replicated row carrying the SAME id the head will
    // carry, but on a DIFFERENT path (a cloud-side path rename).
    const db = store().rawDb();
    db.prepare(
      `INSERT INTO memory_pages (id, workspaceId, path, title, contentHash, version, pageType, visibilityKind, stale, sourceRefsJson, syncStatus, createdAt, updatedAt, sourceKind, replicaActorIdsJson)
       VALUES ('p1', ?, 'note/old.md', 'Old', ?, 3, 'leaf', 'workspace', 0, '[]', 'acked', 1, 1, 'pkf', ?)`,
    ).run(WS, sha256('old'), JSON.stringify(['im_agent_a']));
    db.prepare(
      `INSERT INTO memory_page_versions (pageId, version, contentHash, actorImUserId, actorKind, deviceId, createdAt)
       VALUES ('p1', 3, ?, 'cloud-sync', 'agent', 'dev_x', 1)`,
    ).run(sha256('old'));
    db.prepare(
      `INSERT INTO memory_page_content (pageId, version, payloadKind, payloadValue) VALUES ('p1', 3, 'inline', 'old')`,
    ).run();

    const h = head(); // id 'p1', path 'note/a.md' — same id, NEW path
    const { cloud } = makeCloud({
      manifests: [{ heads: [h] }],
      contents: new Map([['p1', { content: 'content-A' }]]),
    });
    // Pre-fix this aborted PERMANENTLY (bare INSERT hits the id PK — the
    // (workspaceId,path) conflict target does not match a changed path —
    // transaction rolls back → suspended, every retry identical).
    const result = await reconcileReplicaFromCloud(runtime, cloud, WS);
    expect(result.status).toBe('ready');
    // Head landed on the new path with the new content…
    expect(store().loadByPath('note/a.md')?.contentHash).toBe(sha256('content-A'));
    // …and the stale old-path row is gone (raw check — id-based diff would
    // never have removed it).
    expect(db.prepare('SELECT id FROM memory_pages WHERE path = ?').get('note/old.md')).toBeUndefined();
    expect(store().getReplicaState()?.status).toBe('ready');
  });

  // ── Fix round 1 (reviewer I2) — reconcile landing honors the at-rest policy ──
  it('policy-enabled reconcile lands content in the same shape as the normal write path (seal + encrypted intent)', async () => {
    const policyDir = mkdtempSync(join(tmpdir(), 'prismer-replica-policy-'));
    const policyRuntime = new MemoryRuntime({
      baseDir: policyDir,
      deviceId: 'dev_x',
      encryptionPolicy: () => true,
    });
    try {
      registerSnapshot();
      const h = head();
      const { cloud } = makeCloud({
        manifests: [{ heads: [h] }],
        contents: new Map([['p1', { content: 'content-A' }]]),
      });
      const result = await reconcileReplicaFromCloud(policyRuntime, cloud, WS);
      expect(result.status).toBe('ready');
      const pstore = policyRuntime.resolve(WS).store;
      const db = pstore.rawDb();

      // Same-store baseline: a locally-authored write under the same policy.
      pstore.write({
        workspaceId: WS,
        path: 'local/note.md',
        content: 'local-content',
        actorImUserId: 'im_agent_a',
        actorKind: 'agent',
      });

      const reconciled = db
        .prepare('SELECT encrypted, sourceKind FROM memory_pages WHERE id = ?')
        .get('p1') as { encrypted: number; sourceKind: string };
      const localWrite = db
        .prepare('SELECT encrypted FROM memory_pages WHERE path = ?')
        .get('local/note.md') as { encrypted: number };
      // Pre-fix the reconcile hardcoded encrypted=0 — the intent flag must
      // match the normal write path under the SAME policy (1).
      expect(reconciled.encrypted).toBe(1);
      expect(localWrite.encrypted).toBe(1);
      // Content lands through the same seal path: inline payload with the
      // plaintext value (FTS keeps plaintext, identical to write()).
      const contentRow = db
        .prepare('SELECT payloadKind, payloadValue FROM memory_page_content WHERE pageId = ? AND version = 3')
        .get('p1') as { payloadKind: string; payloadValue: string };
      expect(contentRow.payloadKind).toBe('inline');
      expect(contentRow.payloadValue).toBe('content-A');
    } finally {
      policyRuntime.closeAll();
      try {
        rmSync(policyDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

// ─── suspend / lease / snapshot-invalidated recall gates ────────────────────

describe('replica recall gate (§9.5)', () => {
  it('offline lease expiry: ready + expired lease closes recall and flips status to stale', async () => {
    registerSnapshot();
    const h = head();
    const { cloud } = makeCloud({
      manifests: [{ heads: [h] }],
      contents: new Map([['p1', { content: 'content-A' }]]),
    });
    await reconcileReplicaFromCloud(runtime, cloud, WS);
    expect(store().loadByPath('note/a.md')).not.toBeNull();

    // Lease expires (offline — no snapshot refresh possible).
    const db = store().rawDb();
    db.prepare('UPDATE memory_replica_state SET leaseExpiresAt = ? WHERE workspaceId = ?').run(
      Date.now() - 1000,
      WS,
    );
    expect(() => store().loadByPath('note/a.md')).toThrow(MemoryReplicaNotReadyError);
    expect(store().getReplicaState()?.status).toBe('stale');
  });

  it('snapshot invalidation (WS authority invalidate) closes recall even while status is still ready', async () => {
    registerSnapshot();
    const h = head();
    const { cloud } = makeCloud({
      manifests: [{ heads: [h] }],
      contents: new Map([['p1', { content: 'content-A' }]]),
    });
    await reconcileReplicaFromCloud(runtime, cloud, WS);
    expect(store().loadByPath('note/a.md')).not.toBeNull();

    // The runner drops the snapshot on memory.authority.invalidate — the gate
    // must close immediately (fail closed) without waiting for the next write.
    invalidateMemoryAuthoritySnapshot(WS);
    expect(() => store().loadByPath('note/a.md')).toThrow(MemoryReplicaNotReadyError);
  });

  it('epoch drift between the committed state and the live snapshot closes recall', async () => {
    registerSnapshot();
    const h = head();
    const { cloud } = makeCloud({
      manifests: [{ heads: [h] }],
      contents: new Map([['p1', { content: 'content-A' }]]),
    });
    await reconcileReplicaFromCloud(runtime, cloud, WS);
    expect(store().loadByPath('note/a.md')).not.toBeNull();

    // Cloud bumped the epoch → new snapshot arrives with accessVersion 8.
    const next = makeSnapshot({ accessVersion: 8, replicaSubjectHash: 'sha256:subject-e2' });
    expect(registerMemoryAuthoritySnapshot(next, DAEMON_ID)).toBe(true);
    expect(() => store().loadByPath('note/a.md')).toThrow(MemoryReplicaNotReadyError);
  });
});

// ─── §8.3 exact-actor-set predicate (checked BEFORE visibility/principal) ───

describe('replicaActorIds pre-check (§8.3)', () => {
  function agentCap(sub: string, overrides: Partial<MemoryCap> = {}): MemoryCap {
    return {
      sub,
      ws: WS,
      scope: [`ws:${WS}`],
      ver: 2,
      verbs: ['read'],
      principalKind: 'human',
      principalId: 'im_member_1',
      roleSlugs: [],
      taskIds: [],
      councilIds: [],
      accessVersion: 7,
      replicaSubjectHash: 'sha256:subject-e1',
      snapshotHash: 'snap',
      iat: Date.now(),
      exp: Date.now() + 600_000,
      ...overrides,
    };
  }

  function page(overrides: {
    visibility?: { kind: string; imUserId?: string } | { kind: string; slug?: string } | { kind: string; id?: string };
    replicaActorIds?: string[] | null;
  } = {}): Parameters<typeof canCapReadPage>[1] {
    const vis = (overrides.visibility ?? { kind: 'workspace' }) as {
      kind: string;
      imUserId?: string;
      slug?: string;
      id?: string;
    };
    const mapped =
      vis.kind === 'workspace'
        ? { kind: 'workspace' as const }
        : vis.kind === 'agent'
          ? { kind: 'agent' as const, imUserId: vis.imUserId ?? '' }
          : vis.kind === 'role'
            ? { kind: 'role' as const, slug: vis.slug ?? '' }
            : vis.kind === 'council'
              ? { kind: 'council' as const, id: vis.id ?? '' }
              : { kind: 'private' as const, imUserId: vis.imUserId ?? '' };
    return {
      workspaceId: WS,
      visibility: mapped,
      ...(overrides.replicaActorIds !== undefined
        ? { replicaActorIds: overrides.replicaActorIds as unknown as string[] }
        : {}),
    };
  }

  it('member of the exact actor set reads a workspace-visible replicated row', () => {
    expect(canCapReadPage(agentCap('im_agent_a'), page({ replicaActorIds: ['im_agent_a'] }))).toBe(true);
  });

  it('A/B swap: actor B reading a row replicated for actor A only is denied (before visibility)', () => {
    expect(canCapReadPage(agentCap('im_agent_b'), page({ replicaActorIds: ['im_agent_a'] }))).toBe(false);
  });

  it('empty actor set denies everyone (workspace-visible or not)', () => {
    expect(canCapReadPage(agentCap('im_agent_a'), page({ replicaActorIds: [] }))).toBe(false);
  });

  it('principal can never satisfy the actor set (human:<principal> visibility does not widen the exact set)', () => {
    // Row replicated for agent B only, but visibility is human:<member1> —
    // agent A's principal claim must NOT open it.
    expect(
      canCapReadPage(
        agentCap('im_agent_a'),
        page({
          visibility: { kind: 'private', imUserId: 'im_member_1' },
          replicaActorIds: ['im_agent_b'],
        }),
      ),
    ).toBe(false);
  });

  it('NULL actor set = local-authored row → normal visibility rules apply', () => {
    expect(canCapReadPage(agentCap('im_agent_a'), page({ replicaActorIds: null }))).toBe(true);
    expect(
      canCapReadPage(
        agentCap('im_agent_a'),
        page({
          visibility: { kind: 'private', imUserId: 'im_member_1' },
          replicaActorIds: null,
        }),
      ),
    ).toBe(true); // principal read via private:<principalId>
    expect(
      canCapReadPage(
        agentCap('im_agent_a'),
        page({
          visibility: { kind: 'private', imUserId: 'im_member_2' },
          replicaActorIds: null,
        }),
      ),
    ).toBe(false);
  });

  it('system maintenance channel bypasses actor membership; agent RPC never can', () => {
    const system: MemoryCap = { sub: 'daemon-system', ws: '*', scope: ['ws:*'] };
    expect(canCapReadPage(system, page({ replicaActorIds: ['im_agent_a'] }))).toBe(true);
    expect(canCapReadPage(system, page({ replicaActorIds: [] }))).toBe(true);
    expect(canCapReadPage(agentCap('im_agent_a'), page({ replicaActorIds: ['im_agent_a'] }))).toBe(true);
  });

  it('tampered replicaActorIdsJson fails closed at the store boundary (typed error, no page leak)', async () => {
    registerSnapshot();
    const h = head();
    const { cloud } = makeCloud({
      manifests: [{ heads: [h] }],
      contents: new Map([['p1', { content: 'content-A' }]]),
    });
    await reconcileReplicaFromCloud(runtime, cloud, WS);
    // Tamper the persisted JSON column directly (as a disk/DB tamper would).
    store()
      .rawDb()
      .prepare('UPDATE memory_pages SET replicaActorIdsJson = ? WHERE id = ?')
      .run('{not-json', 'p1');
    expect(() => store().loadByPath('note/a.md')).toThrow(/replicaActorIdsJson/i);
    expect(() => store().loadById('p1')).toThrow(/replicaActorIdsJson/i);
  });
});
