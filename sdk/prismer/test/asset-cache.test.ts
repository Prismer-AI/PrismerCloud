import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetCache } from '../src/asset-cache.js';
import type { CloudClient } from '../src/auth.js';
import { openLocalDb } from '../src/sync/store.js';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

describe('AssetCache', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects downloaded bytes whose sha256 does not match the requested content hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismer-asset-cache-'));
    cleanup.push(dir);
    const db = openLocalDb(':memory:');
    const cloud = {
      async fetchRaw(path: string) {
        if (path.startsWith('/api/im/assets/by-hash/')) {
          return new Response(JSON.stringify({ ok: true, data: { id: 'asset_1' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('wrong bytes', { status: 200, headers: { 'Content-Type': 'text/plain' } });
      },
    } as unknown as CloudClient;
    const cache = new AssetCache({ db, cloud, cacheDir: join(dir, 'cache') });
    const expectedHash = sha256('right bytes');

    await expect(cache.getOrFetch(expectedHash, { workspaceIdHint: 'ws_1' })).rejects.toThrow(
      /Asset hash mismatch/,
    );
    expect(existsSync(cache.pathFor(expectedHash))).toBe(false);
    expect(cache.get(expectedHash)).toBeUndefined();
  });
});
