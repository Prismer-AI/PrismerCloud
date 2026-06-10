import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetMetadataIndex } from '../src/daemon/asset/metadata-index.js';
import type { CloudClient } from '../src/auth.js';
import { openLocalDb, type LocalDb } from '../src/sync/store.js';

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
});
