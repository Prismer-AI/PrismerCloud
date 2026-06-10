import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalDb } from '../src/sync/store.js';
import { WorkspaceMirror } from '../src/daemon/asset/mirror.js';
import type { CloudClient } from '../src/auth.js';

interface FilesSyncItem {
  id: string;
  workspaceId: string;
  path: string;
  assetId: string;
  contentHash?: string;
  version: number;
  parentVersionId: string | null;
  modifierImUserId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

function fakeCloud(handler: (path: string) => Promise<unknown>): CloudClient {
  return {
    async get<T>(path: string): Promise<T> {
      return (await handler(path)) as T;
    },
  } as unknown as CloudClient;
}

function makeItem(over: Partial<FilesSyncItem>): FilesSyncItem {
  return {
    id: 'wf_' + Math.random().toString(36).slice(2, 8),
    workspaceId: 'ws_A',
    path: 'notes/a.md',
    assetId: 'asset_1',
    contentHash: 'a'.repeat(64),
    version: 1,
    parentVersionId: null,
    modifierImUserId: 'usr_o',
    createdAt: new Date(0).toISOString(),
    updatedAt: '2026-05-10T00:00:00.000Z',
    deletedAt: null,
    ...over,
  };
}

describe('WorkspaceMirror', () => {
  it('first pull writes cursor + populates lookup tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirror-'));
    try {
      const db = openLocalDb(':memory:');
      const cloud = fakeCloud(async (path) => {
        expect(path).toBe('/api/im/workspaces/ws_A/files/sync');
        return {
          items: [
            makeItem({ path: 'a.md', assetId: 'asset_1', contentHash: 'h1' + 'a'.repeat(62) }),
            makeItem({ path: 'b.md', assetId: 'asset_2', contentHash: 'h2' + 'a'.repeat(62) }),
          ],
          cursor: '2026-05-10T00:00:00.000Z',
        };
      });
      const mirror = new WorkspaceMirror({ db, cloud, workspaceId: 'ws_A', workspaceStateDir: dir });
      expect(mirror.readCursor()).toBeNull();

      const result = await mirror.pullDelta();
      expect(result.applied).toBe(2);
      expect(result.cursor).toBe('2026-05-10T00:00:00.000Z');
      expect(mirror.readCursor()).toBe('2026-05-10T00:00:00.000Z');
      expect(mirror.lookupByPath('a.md')?.assetId).toBe('asset_1');
      expect(mirror.lookupByPath('b.md')?.contentHash.startsWith('h2')).toBe(true);
      expect(mirror.hashForAssetId('asset_1')?.startsWith('h1')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('subsequent pull sends ?since= and merges incrementally', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirror-'));
    try {
      const db = openLocalDb(':memory:');
      const calls: string[] = [];
      const cloud = fakeCloud(async (path) => {
        calls.push(path);
        if (calls.length === 1) {
          return {
            items: [makeItem({ path: 'a.md', contentHash: 'h1' + 'a'.repeat(62) })],
            cursor: 't1',
          };
        }
        // second call expected to carry ?since=t1
        return {
          items: [makeItem({ path: 'a.md', version: 2, contentHash: 'h2' + 'a'.repeat(62) })],
          cursor: 't2',
        };
      });
      const mirror = new WorkspaceMirror({ db, cloud, workspaceId: 'ws_A', workspaceStateDir: dir });

      await mirror.pullDelta();
      expect(calls[0]).toBe('/api/im/workspaces/ws_A/files/sync');
      const before = mirror.lookupByPath('a.md');
      expect(before?.version).toBe(1);
      expect(before?.contentHash.startsWith('h1')).toBe(true);

      await mirror.pullDelta();
      expect(calls[1]).toBe('/api/im/workspaces/ws_A/files/sync?since=t1');
      const after = mirror.lookupByPath('a.md');
      expect(after?.version).toBe(2);
      expect(after?.contentHash.startsWith('h2')).toBe(true);
      expect(mirror.readCursor()).toBe('t2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('soft-deleted rows are removed from mirror', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirror-'));
    try {
      const db = openLocalDb(':memory:');
      const cloud = fakeCloud(async () => ({
        items: [
          makeItem({ path: 'live.md', contentHash: 'h1' + 'a'.repeat(62) }),
          makeItem({
            path: 'gone.md',
            contentHash: 'h2' + 'a'.repeat(62),
            deletedAt: '2026-05-10T01:00:00Z',
          }),
        ],
        cursor: 't',
      }));
      const mirror = new WorkspaceMirror({ db, cloud, workspaceId: 'ws_A', workspaceStateDir: dir });

      await mirror.pullDelta();
      expect(mirror.lookupByPath('live.md')).toBeDefined();
      expect(mirror.lookupByPath('gone.md')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cursor survives restart: a fresh mirror instance over the same dir picks up the persisted cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirror-'));
    try {
      const db = openLocalDb(':memory:');
      const cloud = fakeCloud(async () => ({ items: [], cursor: 'cursor-persisted' }));
      const first = new WorkspaceMirror({ db, cloud, workspaceId: 'ws_A', workspaceStateDir: dir });
      await first.pullDelta();
      expect(first.readCursor()).toBe('cursor-persisted');

      // Fresh instance, same state dir → cursor file picked up.
      const cloud2 = fakeCloud(async (path) => {
        // Restart should resume with the persisted cursor, not from scratch.
        expect(path).toBe('/api/im/workspaces/ws_A/files/sync?since=cursor-persisted');
        return { items: [], cursor: 'cursor-persisted-2' };
      });
      const second = new WorkspaceMirror({ db, cloud: cloud2, workspaceId: 'ws_A', workspaceStateDir: dir });
      expect(second.readCursor()).toBe('cursor-persisted');
      await second.pullDelta();
      expect(second.readCursor()).toBe('cursor-persisted-2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('corrupted cursor file behaves like missing cursor (cold start)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirror-'));
    try {
      writeFileSync(join(dir, 'asset-cursor.json'), 'not-json-at-all');
      const db = openLocalDb(':memory:');
      const cloud = fakeCloud(async (path) => {
        expect(path).toBe('/api/im/workspaces/ws_A/files/sync');
        return { items: [], cursor: 'recovered' };
      });
      const mirror = new WorkspaceMirror({ db, cloud, workspaceId: 'ws_A', workspaceStateDir: dir });
      expect(mirror.readCursor()).toBeNull();
      await mirror.pullDelta();
      expect(JSON.parse(readFileSync(join(dir, 'asset-cursor.json'), 'utf8')).cursor).toBe('recovered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
