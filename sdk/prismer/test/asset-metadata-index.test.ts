import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetMetadataIndex } from '../src/daemon/asset/metadata-index.js';
import type { CloudClient } from '../src/auth.js';
import { currentSchemaVersion, openLocalDb, type LocalDb } from '../src/sync/store.js';

describe('AssetMetadataIndex', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('accepts the server index DTO id field as the local asset id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismer-asset-index-'));
    cleanup.push(dir);
    const db: LocalDb = openLocalDb(join(dir, 'local.db'));
    try {
      const cloud = {
        get: async () => ({
          items: [
            {
              id: 'asset_1',
              contentHash: 'hash_1',
              filename: 'hello.md',
              folderPath: '/docs',
              mime: 'text/markdown',
              kind: 'document',
              sizeBytes: 12,
              description: null,
              assetIndexSeq: 7,
            },
          ],
          cursor: 7,
        }),
      } as unknown as CloudClient;

      const index = new AssetMetadataIndex({
        db,
        cloud,
        workspaceId: 'ws_1',
        workspaceStateDir: dir,
      });

      await expect(index.pullDelta()).resolves.toEqual({ applied: 1, cursor: 7 });
      expect(index.resolveByFilename('hello.md')).toMatchObject({
        assetId: 'asset_1',
        contentHash: 'hash_1',
        filename: 'hello.md',
      });
    } finally {
      db.close();
    }
  });

  it('force pull bypasses throttle for push-triggered sync', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismer-asset-index-'));
    cleanup.push(dir);
    const db: LocalDb = openLocalDb(join(dir, 'local.db'));
    const calls: string[] = [];
    try {
      const cloud = {
        get: async (path: string) => {
          calls.push(path);
          if (calls.length === 1) {
            return {
              items: [
                {
                  id: 'asset_1',
                  contentHash: 'hash_1',
                  filename: 'first.txt',
                  folderPath: null,
                  mime: 'text/plain',
                  kind: 'file',
                  sizeBytes: 5,
                  description: null,
                  assetIndexSeq: 7,
                },
              ],
              cursor: 7,
            };
          }
          return {
            items: [
              {
                id: 'asset_2',
                contentHash: 'hash_2',
                filename: 'second.txt',
                folderPath: null,
                mime: 'text/plain',
                kind: 'file',
                sizeBytes: 6,
                description: null,
                assetIndexSeq: 8,
              },
            ],
            cursor: 8,
          };
        },
      } as unknown as CloudClient;

      const index = new AssetMetadataIndex({
        db,
        cloud,
        workspaceId: 'ws_1',
        workspaceStateDir: dir,
      });

      await expect(index.pullDelta()).resolves.toEqual({ applied: 1, cursor: 7 });
      await expect(index.pullDelta()).resolves.toEqual({ applied: 0, cursor: 7 });
      expect(calls).toHaveLength(1);

      await expect(index.pullDelta({ force: true })).resolves.toEqual({ applied: 1, cursor: 8 });
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain('since=7');
      expect(index.resolveByAssetId('asset_2')).toMatchObject({
        contentHash: 'hash_2',
        filename: 'second.txt',
      });
    } finally {
      db.close();
    }
  });
  // memory211 fix round (external review P1) — the row now also mirrors the two
  // Asset-ACL fields the memory boundary predicate judges. They ride the SAME
  // cloud DTO; an item without them lands as NULL and `canCapReadAsset` reads
  // that as "unverifiable" (DENY).
  it('mirrors asset visibility + owner and round-trips them through an update', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismer-asset-index-acl-'));
    cleanup.push(dir);
    const db: LocalDb = openLocalDb(join(dir, 'local.db'));
    try {
      let items: Array<Record<string, unknown>> = [
        {
          assetId: 'asset_shared',
          contentHash: 'hash_shared',
          filename: 'shared.md',
          folderPath: null,
          mime: 'text/markdown',
          kind: 'document',
          sizeBytes: 10,
          description: null,
          assetIndexSeq: 1,
          visibility: 'workspace',
          ownerImUserId: 'im_owner',
        },
        {
          assetId: 'asset_private',
          contentHash: 'hash_private',
          filename: 'private.md',
          folderPath: null,
          mime: 'text/markdown',
          kind: 'document',
          sizeBytes: 10,
          description: null,
          assetIndexSeq: 2,
          visibility: 'user',
          ownerImUserId: 'im_other',
        },
      ];
      let cursor = 2;
      const cloud = {
        get: async () => ({ items, cursor }),
      } as unknown as CloudClient;
      const index = new AssetMetadataIndex({ db, cloud, workspaceId: 'ws_1', workspaceStateDir: dir });

      await index.pullDelta({ force: true });
      expect(index.resolveByAssetId('asset_shared')).toMatchObject({
        visibility: 'workspace',
        ownerImUserId: 'im_owner',
      });
      expect(index.resolveByAssetId('asset_private')).toMatchObject({
        visibility: 'user',
        ownerImUserId: 'im_other',
      });

      // A later pull (e.g. an ACL change cloud-side) refreshes the projection.
      items = [
        {
          assetId: 'asset_private',
          contentHash: 'hash_private',
          filename: 'private.md',
          folderPath: null,
          mime: 'text/markdown',
          kind: 'document',
          sizeBytes: 10,
          description: null,
          assetIndexSeq: 3,
          visibility: 'workspace',
          ownerImUserId: 'im_other',
        },
      ];
      cursor = 3;
      await index.pullDelta({ force: true });
      expect(index.resolveByAssetId('asset_private')).toMatchObject({ visibility: 'workspace' });
    } finally {
      db.close();
    }
  });

  it('an item from an older cloud (no ACL fields) lands as NULL — unverifiable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismer-asset-index-legacy-'));
    cleanup.push(dir);
    const db: LocalDb = openLocalDb(join(dir, 'local.db'));
    try {
      const cloud = {
        get: async () => ({
          items: [
            {
              assetId: 'asset_legacy',
              contentHash: 'hash_legacy',
              filename: 'legacy.md',
              folderPath: null,
              mime: 'text/markdown',
              kind: 'document',
              sizeBytes: 10,
              description: null,
              assetIndexSeq: 1,
            },
          ],
          cursor: 1,
        }),
      } as unknown as CloudClient;
      const index = new AssetMetadataIndex({ db, cloud, workspaceId: 'ws_1', workspaceStateDir: dir });
      await index.pullDelta({ force: true });
      expect(index.resolveByAssetId('asset_legacy')?.visibility).toBeNull();
      expect(index.resolveByAssetId('asset_legacy')?.ownerImUserId).toBeNull();
    } finally {
      db.close();
    }
  });
  // memory211 fix round 2 (external review follow-up) — the pull is
  // cursor-incremental, so a cursor that survived the v16→v17 upgrade would
  // keep pre-v17 mirror rows (no visibility/owner) stale forever. A cursor
  // stamped with a different local-db schema version is discarded once; the
  // pull that follows rewrites it stamped and incrementality resumes.
  it('discards a cursor written under a different local-db schema version, then re-stamps it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismer-asset-index-stamp-'));
    cleanup.push(dir);
    const db: LocalDb = openLocalDb(join(dir, 'local.db'));
    try {
      // Honours `since` like the real endpoint, so the post-stamp pull proves
      // incrementality resumed (nothing re-delivered at since=4).
      const cloud = {
        get: async (path: string) => {
          const since = Number(new URL(path, 'http://x').searchParams.get('since') ?? 0);
          const item = {
            assetId: 'asset_stamped',
            contentHash: 'hash_stamped',
            filename: 'stamped.md',
            folderPath: null,
            mime: 'text/markdown',
            kind: 'document',
            sizeBytes: 5,
            description: null,
            assetIndexSeq: 4,
            visibility: 'workspace',
            ownerImUserId: 'im_owner',
          };
          return { items: since < 4 ? [item] : [], cursor: 4 };
        },
      } as unknown as CloudClient;
      const index = new AssetMetadataIndex({ db, cloud, workspaceId: 'ws_1', workspaceStateDir: dir });

      // Pre-upgrade shape: the old build wrote no stamp at all.
      writeFileSync(
        join(dir, 'asset-metadata-cursor.json'),
        JSON.stringify({ workspaceId: 'ws_1', cursor: 999, writtenAt: Date.now() }),
      );
      expect(index.readCursor()).toBe(0); // discarded ⇒ next pull is a FULL re-pull

      await expect(index.pullDelta({ force: true })).resolves.toEqual({ applied: 1, cursor: 4 });
      expect(index.resolveByAssetId('asset_stamped')?.visibility).toBe('workspace');
      // Rewritten stamped ⇒ incrementality resumes (since=4 on the next pull).
      const stamped = JSON.parse(readFileSync(join(dir, 'asset-metadata-cursor.json'), 'utf8')) as {
        localDbSchema?: number;
      };
      expect(stamped.localDbSchema).toBe(currentSchemaVersion(db));
      await expect(index.pullDelta({ force: true })).resolves.toEqual({ applied: 0, cursor: 4 });
    } finally {
      db.close();
    }
  });
});
