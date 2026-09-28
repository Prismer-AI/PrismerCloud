import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachAssetRpc } from '../src/daemon/asset/rpc.js';
import type { AssetMetadataIndex, AssetMetadataRow } from '../src/daemon/asset/metadata-index.js';

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item();
});

describe('asset RPC on-demand metadata sync', () => {
  it('syncs the index on first /local/asset/read when the daemon has no local index yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismer-asset-rpc-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const marker = 'asset-rpc-on-demand-sync-marker';
    const filePath = join(dir, 'asset.txt');
    writeFileSync(filePath, marker);
    const row: AssetMetadataRow = {
      assetId: 'asset-1',
      contentHash: 'hash-1',
      filename: 'asset.txt',
      folderPath: null,
      mime: 'text/plain',
      kind: 'file',
      sizeBytes: marker.length,
      description: null,
      assetIndexSeq: 1,
    };
    let index: AssetMetadataIndex | undefined;
    const syncedIndex = fakeIndex(row);
    const ensureIndex = vi.fn(async () => {
      index = syncedIndex;
      return syncedIndex;
    });
    const assetCache = {
      get: vi.fn(),
      getOrFetch: vi.fn(async () => ({
        contentHash: row.contentHash,
        sizeBytes: marker.length,
        mime: 'text/plain',
        localPath: filePath,
        fetchedAt: Date.now(),
        lastUsedAt: Date.now(),
        pin: false,
      })),
    };

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const handled = await attachAssetRpc({
        resolveIndex: () => index,
        ensureIndex,
        assetCache: assetCache as never,
      })(req, res);
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    });
    await listen(server);
    cleanup.push(() => close(server));

    const res = await fetch(`http://127.0.0.1:${addressPort(server)}/local/asset/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1', assetId: row.assetId, length: 1024 }),
    });
    const body = (await res.json()) as { content?: string };

    expect(res.status).toBe(200);
    expect(body.content).toContain(marker);
    expect(ensureIndex).toHaveBeenCalledOnce();
    expect(assetCache.getOrFetch).toHaveBeenCalledWith(row.contentHash, {
      workspaceIdHint: 'ws-1',
      assetId: row.assetId,
    });
  });

  it('force-syncs once when the existing index misses a just-created asset', async () => {
    const staleIndex = fakeIndex();
    const freshRow: AssetMetadataRow = {
      assetId: 'asset-fresh',
      contentHash: 'hash-fresh',
      filename: 'fresh.txt',
      folderPath: null,
      mime: 'text/plain',
      kind: 'file',
      sizeBytes: 12,
      description: null,
      assetIndexSeq: 3,
    };
    const freshIndex = fakeIndex(freshRow);
    const ensureIndex = vi.fn(async () => freshIndex);
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const handled = await attachAssetRpc({
        resolveIndex: () => staleIndex,
        ensureIndex,
      })(req, res);
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    });
    await listen(server);
    cleanup.push(() => close(server));

    const res = await fetch(`http://127.0.0.1:${addressPort(server)}/local/asset/describe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1', assetId: freshRow.assetId }),
    });
    const body = (await res.json()) as { asset?: { assetId?: string } };

    expect(res.status).toBe(200);
    expect(body.asset?.assetId).toBe(freshRow.assetId);
    expect(ensureIndex).toHaveBeenCalledOnce();
  });
});

function fakeIndex(row?: AssetMetadataRow): AssetMetadataIndex {
  return {
    workspaceId: 'ws-1',
    search: vi.fn(() => (row ? [row] : [])),
    resolveByAssetId: vi.fn((assetId: string) => (row?.assetId === assetId ? row : undefined)),
    resolveByContentHash: vi.fn((contentHash: string) => (row?.contentHash === contentHash ? row : undefined)),
    resolveByFilename: vi.fn((filename: string) => (row?.filename === filename ? row : undefined)),
    pullDelta: vi.fn(),
    readCursor: vi.fn(),
    resolveByFilenames: vi.fn(),
  } as unknown as AssetMetadataIndex;
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function close(server: EventEmitter & { close(cb: (err?: Error) => void): void }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err?: Error) => (err ? reject(err) : resolve()));
  });
}

function addressPort(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not expose a port');
  return address.port;
}
