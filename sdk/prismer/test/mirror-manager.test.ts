// desktop202/17 Phase 9 — MirrorManager unit tests.
//
// Covers: mirror index + hardlink placement, stat-compare edit detection,
// conflict rename (零丢失), multi-device revision refresh, subscription refresh
// (asset.changed-driven), pin/unpin, delete→.trash, budget reclaim, and the
// path-escape / sanitize guards. AssetCache is real (in-memory sqlite) with a
// stubbed cloud fetch so getOrFetch resolves bytes from a fake "cloud".

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetCache } from '../src/asset-cache.js';
import { CloudClient } from '../src/auth.js';
import { MirrorManager, sanitizeSegment } from '../src/daemon/asset/mirror-manager.js';
import { openLocalDb, type LocalDb } from '../src/sync/store.js';

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** A fake cloud serving asset bytes by id. id → bytes. */
function makeCloud(blobs: Map<string, Buffer>): CloudClient {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = input.toString();
    // GET /api/im/assets/by-hash/:hash → { ok, data: { id } }
    const byHash = url.match(/\/api\/im\/assets\/by-hash\/([0-9a-f]+)/);
    if (byHash) {
      const hash = byHash[1]!;
      // find an id whose bytes hash to this
      for (const [id, bytes] of blobs) {
        if (sha256(bytes) === hash) {
          return new Response(JSON.stringify({ ok: true, data: { id } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    }
    // GET /api/im/assets/:id → raw bytes
    const byId = url.match(/\/api\/im\/assets\/([^/?]+)$/);
    if (byId) {
      const bytes = blobs.get(decodeURIComponent(byId[1]!));
      if (bytes) return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
      return new Response('', { status: 404 });
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  return new CloudClient({ baseUrl: 'http://cloud.test', apiKey: 'sk-test', fetchImpl });
}

interface Harness {
  db: LocalDb;
  cache: AssetCache;
  mirror: MirrorManager;
  blobs: Map<string, Buffer>;
  root: string;
  cacheDir: string;
}

function setup(opts?: { wsName?: string; reveal?: (p: string) => void }): Harness {
  const home = mkdtempSync(join(tmpdir(), 'mirror-test-'));
  const cacheDir = join(home, 'cache');
  const root = join(home, 'Prismer');
  const db = openLocalDb(join(home, 'local.db'));
  // seed a workspace name so resolveWorkspaceName has something
  db.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run('ws-1', opts?.wsName ?? 'My Workspace');
  const blobs = new Map<string, Buffer>();
  const cache = new AssetCache({ db, cloud: makeCloud(blobs), cacheDir });
  const mirror = new MirrorManager({
    db,
    assetCache: cache,
    mirrorRoot: root,
    resolveWorkspaceName: (wsId) => {
      const r = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(wsId) as { name?: string } | undefined;
      return r?.name;
    },
    ...(opts?.reveal ? { revealInFinder: opts.reveal } : {}),
  });
  return { db, cache, mirror, blobs, root, cacheDir };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function track(h: Harness): Harness {
  // track the home (parent of cacheDir/root)
  dirs.push(join(h.cacheDir, '..'));
  return h;
}

describe('MirrorManager — materialize (云→本地)', () => {
  it('hardlinks bytes from cache into the named mirror path + writes a clean index row', async () => {
    const h = track(setup());
    const bytes = Buffer.from('hello world');
    const hash = sha256(bytes);
    h.blobs.set('asset-1', bytes);

    const result = await h.mirror.materialize(
      { assetId: 'asset-1', contentHash: hash, filename: 'report.txt', folderPath: 'docs' },
      { workspaceId: 'ws-1' },
    );

    expect(existsSync(result.localPath)).toBe(true);
    expect(result.localPath).toContain(join('My Workspace', 'docs', 'report.txt'));
    expect(readFileSync(result.localPath, 'utf8')).toBe('hello world');
    expect(result.linked).toBe(true); // same volume → hardlink

    const entry = h.mirror.getEntry('asset-1');
    expect(entry?.dirtyState).toBe('clean');
    expect(entry?.contentHash).toBe(hash);
    expect(entry?.localPath).toBe(result.localPath);
  });

  it('shares disk bytes via hardlink: two assets with identical content link to one cache inode', async () => {
    const h = track(setup());
    const bytes = Buffer.from('shared content');
    const hash = sha256(bytes);
    h.blobs.set('asset-a', bytes);

    const a = await h.mirror.materialize(
      { assetId: 'asset-a', contentHash: hash, filename: 'a.txt', folderPath: null },
      { workspaceId: 'ws-1' },
    );
    // second asset, same content hash → cache hit, hardlink again
    const b = await h.mirror.materialize(
      { assetId: 'asset-b', contentHash: hash, filename: 'b.txt', folderPath: null },
      { workspaceId: 'ws-1' },
    );

    const inoA = statSync(a.localPath).ino;
    const inoB = statSync(b.localPath).ino;
    const inoCache = statSync(h.cache.pathFor(hash)).ino;
    expect(inoA).toBe(inoCache);
    expect(inoB).toBe(inoCache);
  });

  it('reveal calls the showItemInFolder hook with the mirror path', async () => {
    const revealed: string[] = [];
    const h = track(setup({ reveal: (p) => revealed.push(p) }));
    const bytes = Buffer.from('x');
    h.blobs.set('a1', bytes);
    const r = await h.mirror.materialize(
      { assetId: 'a1', contentHash: sha256(bytes), filename: 'x.txt', folderPath: null },
      { workspaceId: 'ws-1', reveal: true },
    );
    expect(revealed).toEqual([r.localPath]);
  });

  it('pin marks the entry pinned + pins the cache hash', async () => {
    const h = track(setup());
    const bytes = Buffer.from('pinme');
    const hash = sha256(bytes);
    h.blobs.set('a1', bytes);
    await h.mirror.materialize(
      { assetId: 'a1', contentHash: hash, filename: 'p.txt', folderPath: null },
      { workspaceId: 'ws-1', pin: true },
    );
    expect(h.mirror.getEntry('a1')?.pinned).toBe(true);
    const cached = h.cache.get(hash);
    expect(cached?.pin).toBe(true);
  });
});

describe('MirrorManager — edit-roundtrip (本地编辑→显式回写)', () => {
  it('stat-compare flips clean→localEdit only when bytes actually change', async () => {
    const h = track(setup());
    const bytes = Buffer.from('original');
    const hash = sha256(bytes);
    h.blobs.set('a1', bytes);
    const r = await h.mirror.materialize(
      { assetId: 'a1', contentHash: hash, filename: 'edit.txt', folderPath: null },
      { workspaceId: 'ws-1' },
    );

    // No change → no dirty.
    expect(h.mirror.checkLocalEdits('ws-1')).toEqual([]);

    // `touch` (mtime bump, same bytes) → NOT dirty (hash guard).
    const future = new Date(Date.now() + 5000);
    utimesSync(r.localPath, future, future);
    expect(h.mirror.checkLocalEdits('ws-1')).toEqual([]);
    expect(h.mirror.getEntry('a1')?.dirtyState).toBe('clean');

    // Real edit → localEdit.
    writeFileSync(r.localPath, 'edited bytes');
    const edits = h.mirror.checkLocalEdits('ws-1');
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ assetId: 'a1', dirtyState: 'localEdit', changed: true });
    expect(h.mirror.getEntry('a1')?.dirtyState).toBe('localEdit');
  });

  it('readLocalEdit returns the edited bytes + hash for upload; markUploaded settles to clean', async () => {
    const h = track(setup());
    const bytes = Buffer.from('v1');
    h.blobs.set('a1', bytes);
    const r = await h.mirror.materialize(
      { assetId: 'a1', contentHash: sha256(bytes), filename: 'e.txt', folderPath: null },
      { workspaceId: 'ws-1' },
    );
    writeFileSync(r.localPath, 'v2 edited');
    h.mirror.checkLocalEdits('ws-1');

    const edit = h.mirror.readLocalEdit('a1');
    expect(edit.bytes.toString('utf8')).toBe('v2 edited');
    expect(edit.contentHash).toBe(sha256('v2 edited'));

    h.mirror.markUploaded('a1', 2, edit.contentHash);
    const entry = h.mirror.getEntry('a1');
    expect(entry?.dirtyState).toBe('clean');
    expect(entry?.revision).toBe(2);
    expect(entry?.contentHash).toBe(edit.contentHash);
  });

  it('readLocalEdit refuses a non-dirty entry (guards accidental upload)', async () => {
    const h = track(setup());
    const bytes = Buffer.from('clean');
    h.blobs.set('a1', bytes);
    await h.mirror.materialize(
      { assetId: 'a1', contentHash: sha256(bytes), filename: 'c.txt', folderPath: null },
      { workspaceId: 'ws-1' },
    );
    expect(() => h.mirror.readLocalEdit('a1')).toThrow(/not localEdit/);
  });
});

describe('MirrorManager — multi-device refresh (§4)', () => {
  it('clean + newer revision → atomic replace of mirror bytes', async () => {
    const h = track(setup());
    const v1 = Buffer.from('rev-1');
    h.blobs.set('a1', v1);
    const r = await h.mirror.materialize(
      { assetId: 'a1', contentHash: sha256(v1), filename: 'sync.txt', folderPath: null, revision: 1 },
      { workspaceId: 'ws-1', pin: true },
    );
    expect(readFileSync(r.localPath, 'utf8')).toBe('rev-1');

    // Device A bumped to rev 2 with new bytes.
    const v2 = Buffer.from('rev-2 updated');
    h.blobs.set('a1', v2);
    const action = await h.mirror.refreshFromCloud(
      { assetId: 'a1', contentHash: sha256(v2), filename: null, folderPath: null, revision: 2 },
      { workspaceId: 'ws-1', operation: 'update' },
    );
    expect(action).toBe('refreshed');
    expect(readFileSync(r.localPath, 'utf8')).toBe('rev-2 updated');
    expect(h.mirror.getEntry('a1')?.revision).toBe(2);
  });

  it('not-materialized asset → no-op (未材化 → metadata-only)', async () => {
    const h = track(setup());
    const action = await h.mirror.refreshFromCloud(
      { assetId: 'ghost', contentHash: sha256('x'), filename: null, folderPath: null, revision: 5 },
      { workspaceId: 'ws-1', operation: 'update' },
    );
    expect(action).toBe('not-materialized');
  });

  it('stale/duplicate revision is dropped (idempotent monotonic compare)', async () => {
    const h = track(setup());
    const v2 = Buffer.from('rev-2');
    h.blobs.set('a1', v2);
    const r = await h.mirror.materialize(
      { assetId: 'a1', contentHash: sha256(v2), filename: 's.txt', folderPath: null, revision: 2 },
      { workspaceId: 'ws-1', pin: true },
    );
    // An out-of-order rev 1 event arrives → dropped.
    const action = await h.mirror.refreshFromCloud(
      { assetId: 'a1', contentHash: sha256('rev-1-old'), filename: null, folderPath: null, revision: 1 },
      { workspaceId: 'ws-1', operation: 'update' },
    );
    expect(action).toBe('skipped');
    expect(readFileSync(r.localPath, 'utf8')).toBe('rev-2');
    expect(h.mirror.getEntry('a1')?.revision).toBe(2);
  });

  it('delete operation → mirror file moves to .trash, row removed', async () => {
    const h = track(setup());
    const bytes = Buffer.from('doomed');
    h.blobs.set('a1', bytes);
    const r = await h.mirror.materialize(
      { assetId: 'a1', contentHash: sha256(bytes), filename: 'del.txt', folderPath: null },
      { workspaceId: 'ws-1' },
    );
    const action = await h.mirror.refreshFromCloud(
      { assetId: 'a1', contentHash: sha256(bytes), filename: null, folderPath: null },
      { workspaceId: 'ws-1', operation: 'delete' },
    );
    expect(action).toBe('deleted');
    expect(existsSync(r.localPath)).toBe(false);
    expect(h.mirror.getEntry('a1')).toBeUndefined();
    const trashDir = join(h.root, 'My Workspace', '.trash');
    expect(readdirSync(trashDir).length).toBe(1);
  });
});

describe('MirrorManager — conflict (§5, 零丢失)', () => {
  it('localEdit + newer cloud revision → local saved aside, cloud rev becomes main, state=conflict', async () => {
    const h = track(setup());
    const v1 = Buffer.from('base');
    h.blobs.set('a1', v1);
    const r = await h.mirror.materialize(
      { assetId: 'a1', contentHash: sha256(v1), filename: 'doc.txt', folderPath: null, revision: 1 },
      { workspaceId: 'ws-1', pin: true },
    );

    // User edits locally → localEdit.
    writeFileSync(r.localPath, 'my local changes');
    h.mirror.checkLocalEdits('ws-1');
    expect(h.mirror.getEntry('a1')?.dirtyState).toBe('localEdit');

    // Cloud rev 2 arrives concurrently.
    const v2 = Buffer.from('cloud rev 2');
    h.blobs.set('a1', v2);
    const action = await h.mirror.refreshFromCloud(
      { assetId: 'a1', contentHash: sha256(v2), filename: null, folderPath: null, revision: 2 },
      { workspaceId: 'ws-1', operation: 'update' },
    );
    expect(action).toBe('conflict');

    // Main name now holds the cloud rev; local copy saved aside (zero loss).
    expect(readFileSync(r.localPath, 'utf8')).toBe('cloud rev 2');
    const dir = join(h.root, 'My Workspace');
    const aside = readdirSync(dir).find((f) => f.includes('本机修改'));
    expect(aside).toBeTruthy();
    expect(readFileSync(join(dir, aside!), 'utf8')).toBe('my local changes');
    expect(h.mirror.getEntry('a1')?.dirtyState).toBe('conflict');

    h.mirror.clearConflict('a1');
    expect(h.mirror.getEntry('a1')?.dirtyState).toBe('clean');
  });
});

describe('MirrorManager — pin / unpin / reclaim / import', () => {
  it('unpin keeps the mirror file (never silently deletes user-visible files)', async () => {
    const h = track(setup());
    const bytes = Buffer.from('keep me');
    const hash = sha256(bytes);
    h.blobs.set('a1', bytes);
    const r = await h.mirror.materialize(
      { assetId: 'a1', contentHash: hash, filename: 'k.txt', folderPath: null },
      { workspaceId: 'ws-1', pin: true },
    );
    h.mirror.unpin('a1');
    expect(h.mirror.getEntry('a1')?.pinned).toBe(false);
    expect(existsSync(r.localPath)).toBe(true);
    expect(h.cache.get(hash)?.pin).toBe(false);
  });

  it('reclaim removes non-pinned clean files until under budget; never touches pinned/dirty', async () => {
    const h = track(setup());
    // pinned entry
    const p = Buffer.from('pinned-bytes-aaaa');
    h.blobs.set('pin', p);
    const pinned = await h.mirror.materialize(
      { assetId: 'pin', contentHash: sha256(p), filename: 'pin.bin', folderPath: null },
      { workspaceId: 'ws-1', pin: true },
    );
    // dirty entry
    const d = Buffer.from('dirty-bytes-bbbb');
    h.blobs.set('dirty', d);
    const dirty = await h.mirror.materialize(
      { assetId: 'dirty', contentHash: sha256(d), filename: 'dirty.bin', folderPath: null },
      { workspaceId: 'ws-1' },
    );
    writeFileSync(dirty.localPath, 'now edited locally');
    h.mirror.checkLocalEdits('ws-1');
    // reclaimable clean entry
    const c = Buffer.from('clean-reclaimable-cccc');
    h.blobs.set('clean', c);
    const clean = await h.mirror.materialize(
      { assetId: 'clean', contentHash: sha256(c), filename: 'clean.bin', folderPath: null },
      { workspaceId: 'ws-1' },
    );

    const { removed } = h.mirror.reclaim(0); // budget 0 → drop all reclaimable
    expect(removed).toBe(1);
    expect(existsSync(clean.localPath)).toBe(false);
    expect(existsSync(pinned.localPath)).toBe(true);
    expect(existsSync(dirty.localPath)).toBe(true);
    expect(h.mirror.getEntry('pin')).toBeTruthy();
    expect(h.mirror.getEntry('dirty')).toBeTruthy();
    expect(h.mirror.getEntry('clean')).toBeUndefined();
  });

  it('registerImported only tracks sources inside the mirror dir', async () => {
    const h = track(setup());
    // outside the mirror root → not registered
    const outside = join(h.cacheDir, '..', 'outside.txt');
    writeFileSync(outside, 'external');
    const reg1 = h.mirror.registerImported({
      workspaceId: 'ws-1',
      assetId: 'ext',
      contentHash: sha256('external'),
      filename: 'outside.txt',
      folderPath: null,
      sourcePath: outside,
    });
    expect(reg1).toBe(false);
    expect(h.mirror.getEntry('ext')).toBeUndefined();

    // inside the mirror root → registered (source already lives in mirror dir)
    const insideDir = join(h.root, 'My Workspace');
    mkdirSync(insideDir, { recursive: true });
    const inside = join(insideDir, 'imported.txt');
    writeFileSync(inside, 'local origin');
    const reg2 = h.mirror.registerImported({
      workspaceId: 'ws-1',
      assetId: 'imp',
      contentHash: sha256('local origin'),
      filename: 'imported.txt',
      folderPath: null,
      sourcePath: inside,
    });
    expect(reg2).toBe(true);
    expect(h.mirror.getEntry('imp')?.localPath).toBe(inside);
  });
});

describe('sanitizeSegment + path confinement', () => {
  it('strips path separators, control chars, and `..` traversal', () => {
    expect(sanitizeSegment('../../etc/passwd')).not.toContain('..');
    expect(sanitizeSegment('a/b\\c')).toBe('a-b-c');
    expect(sanitizeSegment('  spaced  name  ')).toBe('spaced name');
    expect(sanitizeSegment('.hidden')).toBe('hidden');
    expect(sanitizeSegment('valid-name_123.txt')).toBe('valid-name_123.txt');
  });

  it('mirrorPathFor confines folderPath that tries to escape the root', () => {
    const h = track(setup());
    // `../../../etc` is sanitized per-segment (each `..` → `.` → dropped) so the
    // composed path stays UNDER the mirror root rather than escaping it.
    const p = h.mirror.mirrorPathFor('My Workspace', '../../../etc', 'x.txt');
    expect(p.startsWith(h.root)).toBe(true);
    expect(p).toContain(join('My Workspace', 'etc', 'x.txt'));
  });

  it('workspaceName with illegal chars gets the <name>-<wsId前6> suffix', () => {
    const h = track(setup({ wsName: 'bad/name:here' }));
    const seg = h.mirror.workspaceDirName('ws-1');
    expect(seg).toMatch(/-ws-1$|-/); // disambiguated
    expect(seg).not.toContain('/');
    expect(seg).not.toContain(':');
  });
});
