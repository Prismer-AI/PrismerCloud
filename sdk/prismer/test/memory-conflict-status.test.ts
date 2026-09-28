/**
 * memory203 doc 07 — daemon-local conflict-status leg (companion to the cloud
 * test src/im/integration-tests/memory-multidevice/conflict-status.test.ts).
 *
 * Proves the daemon LEARNS its write lost: on a down-sync re-pull, when the
 * cloud page row reports `syncStatus:'remote-conflict'`, the daemon stamps its
 * LOCAL page `'remote-conflict'` and exposes it via `store.listRemoteConflicts`
 * (the backing for `GET /local/memory/conflicts`). A non-conflicting page lands
 * `'acked'` and is NOT listed.
 *
 * Real path: drives `initialSyncFromCloud(runtime, cloud, ws)` with a FAKE
 * CloudClient that returns real cloud-shaped rows. The fake is a wire-level stub
 * (it only implements `request`), NOT a mock of the unit under test —
 * `initialSyncFromCloud → materialisePage → store.write + store.setSyncStatus`
 * runs in full against a real on-disk SQLite store.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { initialSyncFromCloud } from '../src/daemon/memory/cloud-sync.js';
import type { CloudClient } from '../src/auth.js';

const WS = 'ws_conflict_test';

interface CloudPageRow {
  id: string;
  path: string;
  content?: string | null;
  pageType?: string;
  visibility?: string;
  encrypted?: boolean | null;
  updatedAt?: number | null;
  syncStatus?: string | null;
}

/**
 * Minimal wire-level fake: returns a fixed `/memory/pages` result and an empty
 * `/memory/links/sync`. Only `request` is exercised by initialSyncFromCloud.
 */
function fakeCloud(pages: CloudPageRow[]): CloudClient {
  return {
    request: async (_method: string, path: string) => {
      if (path.startsWith('/api/im/memory/pages?')) {
        return { ok: true, status: 200, data: { ok: true, data: pages } };
      }
      if (path.startsWith('/api/im/memory/links/sync')) {
        return { ok: true, status: 200, data: { ok: true, data: [] } };
      }
      // Any per-page detail回源 (only hit when a list row omits content; our rows
      // carry content, so this should not fire) → empty.
      return { ok: true, status: 200, data: { ok: true, data: { content: '' } } };
    },
  } as unknown as CloudClient;
}

function tmpRuntime(): { runtime: MemoryRuntime; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-conflict-status-'));
  const runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'device-phone' });
  return { runtime, dir };
}

describe('memory203 doc 07 — daemon learns it lost a remote conflict', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('down-sync stamps local page remote-conflict when cloud signals it; lists it', async () => {
    const { runtime, dir } = tmpRuntime();
    cleanup.push(dir);
    // The store must exist before initialSyncFromCloud (it peeks, not resolves).
    const slot = runtime.resolve(WS);

    const loser: CloudPageRow = {
      id: 'page_loser',
      path: 'memory/shared.md',
      content: '# shared\n\nv1 (device-1 won)\n',
      pageType: 'leaf',
      visibility: 'workspace',
      updatedAt: 1000,
      syncStatus: 'remote-conflict', // cloud says THIS device's write lost
    };
    const clean: CloudPageRow = {
      id: 'page_clean',
      path: 'memory/other.md',
      content: '# other\n\nno conflict\n',
      pageType: 'leaf',
      visibility: 'workspace',
      updatedAt: 1001,
      syncStatus: 'synced',
    };

    const result = await initialSyncFromCloud(runtime, fakeCloud([loser, clean]), WS);
    expect(result.pulled).toBe(2);

    const loserPage = slot.store.loadById('page_loser');
    expect(loserPage).not.toBeNull();
    expect(loserPage!.syncStatus).toBe('remote-conflict');

    const cleanPage = slot.store.loadById('page_clean');
    expect(cleanPage).not.toBeNull();
    // A non-conflict down-synced page lands acked (mirrors the cloud truth source).
    expect(cleanPage!.syncStatus).toBe('acked');

    // listRemoteConflicts (backs GET /local/memory/conflicts) lists ONLY the loser.
    const conflicts = slot.store.listRemoteConflicts();
    expect(conflicts.map((p) => p.id)).toEqual(['page_loser']);

    runtime.closeAll();
  });

  it('NEGATIVE control: cloud signals no conflict → no local page is remote-conflict', async () => {
    const { runtime, dir } = tmpRuntime();
    cleanup.push(dir);
    const slot = runtime.resolve(WS);

    // Two clean pages, neither flagged (one explicit 'synced', one omitted).
    const a: CloudPageRow = {
      id: 'page_a',
      path: 'memory/a.md',
      content: '# a\n',
      pageType: 'leaf',
      visibility: 'workspace',
      updatedAt: 2000,
      syncStatus: 'synced',
    };
    const b: CloudPageRow = {
      id: 'page_b',
      path: 'memory/b.md',
      content: '# b\n',
      pageType: 'leaf',
      visibility: 'workspace',
      updatedAt: 2001,
      // syncStatus omitted entirely → must NOT be treated as a conflict.
    };

    const result = await initialSyncFromCloud(runtime, fakeCloud([a, b]), WS);
    expect(result.pulled).toBe(2);

    expect(slot.store.loadById('page_a')!.syncStatus).toBe('acked');
    expect(slot.store.loadById('page_b')!.syncStatus).toBe('acked');
    expect(slot.store.listRemoteConflicts()).toEqual([]);

    runtime.closeAll();
  });

  it('setSyncStatus is a no-op for an unknown pageId (returns false)', () => {
    const { runtime, dir } = tmpRuntime();
    cleanup.push(dir);
    const slot = runtime.resolve(WS);
    expect(slot.store.setSyncStatus('does_not_exist', 'remote-conflict')).toBe(false);
    runtime.closeAll();
  });
});
