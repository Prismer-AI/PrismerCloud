// Desktop-202 doc 18 §5a — incremental cloud→local memory sync.
//
// Verifies the daemon-side sync (cloud-sync.ts) after removing the 300-page
// cap: it pages the cloud list, materialises everything visible, persists a
// watermark, re-syncs only newer rows, and surfaces the C7 200-page cloud cap.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudClient, CloudResponse } from '../src/auth.js';
import { MemoryRuntime } from '../src/daemon/memory/runtime.js';
import { initialSyncFromCloud } from '../src/daemon/memory/cloud-sync.js';
import { MIN_STRICT_RUNTIME_VERSION, MEMORY_RUNTIME_CAPABILITIES_V1, __resetCapKeyForTest } from '../src/daemon/memory/cap.js';

const WS = 'ws_incremental';

let dir = '';
let runtime: MemoryRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prismer-csync-'));
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

interface CloudPage {
  id: string;
  path: string;
  title?: string | null;
  content?: string | null;
  pageType?: string;
  visibility?: string;
  updatedAt?: number;
}

/** Build a stub CloudClient over an in-memory page table, recording requests. */
function makeCloud(
  pagesByCall: (calls: string[]) => CloudPage[],
): { cloud: CloudClient; calls: string[] } {
  const calls: string[] = [];
  const cloud = {
    async request<T = unknown>(
      _method: string,
      path: string,
    ): Promise<CloudResponse<T>> {
      calls.push(path);
      // Detail fetch — never needed here (list always carries content).
      if (path.includes('/memory/pages/')) {
        return { ok: true, status: 200, data: { ok: true, data: { content: '' } } as unknown as T };
      }
      const data = pagesByCall(calls);
      return { ok: true, status: 200, data: { ok: true, data } as unknown as T };
    },
  } as unknown as CloudClient;
  return { cloud, calls };
}

describe('incremental cloud sync (doc 18 §5a)', () => {
  it('removes the 300-page cap — materialises a >300-page workspace (within the cloud 200 cap per pass)', async () => {
    runtime.resolve(WS);
    // 200 pages = the cloud per-page cap (C7). The old code capped at 300 and
    // only ran once; we assert all 200 returned in one pass are written.
    const pages: CloudPage[] = Array.from({ length: 200 }, (_v, i) => ({
      id: `p${i}`,
      path: `note/${i}.md`,
      content: `content ${i}`,
      pageType: 'leaf',
      updatedAt: 1000 + i,
    }));
    const { cloud } = makeCloud(() => pages);
    const res = await initialSyncFromCloud(runtime, cloud, WS);
    expect(res.pulled).toBe(200);
    expect(runtime.resolve(WS).store.stats().pageCount).toBe(200);
  });

  it('persists a watermark and re-syncs only newer rows', async () => {
    runtime.resolve(WS);
    const first: CloudPage[] = [
      { id: 'a', path: 'a.md', content: 'A', updatedAt: 100 },
      { id: 'b', path: 'b.md', content: 'B', updatedAt: 200 },
    ];
    const { cloud: cloud1 } = makeCloud(() => first);
    const r1 = await initialSyncFromCloud(runtime, cloud1, WS);
    expect(r1.pulled).toBe(2);

    // Watermark should be the max updatedAt (200).
    const cursor = runtime.resolve(WS).store.getCursor(WS);
    expect(cursor).toBe('wm:200');

    // Second sync: the same two old rows + one new row at 300. Only the new
    // row should materialise (watermark filter), and the watermark advances.
    const second: CloudPage[] = [
      ...first,
      { id: 'c', path: 'c.md', content: 'C', updatedAt: 300 },
    ];
    const { cloud: cloud2 } = makeCloud(() => second);
    const r2 = await initialSyncFromCloud(runtime, cloud2, WS);
    expect(r2.pulled).toBe(1);
    expect(runtime.resolve(WS).store.getCursor(WS)).toBe('wm:300');
    expect(runtime.resolve(WS).store.stats().pageCount).toBe(3);
  });

  it('is a no-op (upToDate) when nothing is newer than the watermark', async () => {
    runtime.resolve(WS);
    const pages: CloudPage[] = [{ id: 'a', path: 'a.md', content: 'A', updatedAt: 100 }];
    const { cloud } = makeCloud(() => pages);
    await initialSyncFromCloud(runtime, cloud, WS);
    const again = await initialSyncFromCloud(runtime, cloud, WS);
    expect(again.pulled).toBe(0);
    expect(again.upToDate).toBe(true);
  });

  it('sends a since param once a watermark exists (forward-compatible; C7 cloud ignores it)', async () => {
    runtime.resolve(WS);
    const pages: CloudPage[] = [{ id: 'a', path: 'a.md', content: 'A', updatedAt: 500 }];
    const { cloud, calls } = makeCloud(() => pages);
    await initialSyncFromCloud(runtime, cloud, WS); // establishes wm:500
    calls.length = 0;
    await initialSyncFromCloud(runtime, cloud, WS); // second pass should carry since=500
    const listCall = calls.find((c) => c.includes('/memory/pages?'));
    expect(listCall).toBeDefined();
    expect(listCall).toContain('since=500');
  });

  it('skips when no store exists for the workspace (peek miss)', async () => {
    const { cloud, calls } = makeCloud(() => []);
    const res = await initialSyncFromCloud(runtime, cloud, 'never_resolved');
    expect(res).toEqual({ pulled: 0, skipped: 0, upToDate: true });
    expect(calls).toHaveLength(0);
  });

  // ── product209/16 §15.2 — strict workspace: legacy daemon sync gets 426 ──
  it('426 on legacy /memory/pages is a typed stop: upgradeRequired surfaced, no fallback retry, nothing materialised, no ready marker', async () => {
    runtime.resolve(WS);
    const calls: string[] = [];
    const cloud = {
      async request<T = unknown>(_method: string, path: string): Promise<CloudResponse<T>> {
        calls.push(path);
        if (path.includes('/memory/pages')) {
          return {
            ok: false,
            status: 426,
            error: { code: 'MEMORY_RUNTIME_UPGRADE_REQUIRED', message: 'runtime upgrade required' },
          } as CloudResponse<T>;
        }
        return { ok: true, status: 200, data: { ok: true, data: [] } as unknown as T } as CloudResponse<T>;
      },
    } as unknown as CloudClient;

    const res = await initialSyncFromCloud(runtime, cloud, WS);

    expect(res.pulled).toBe(0);
    expect(res.upToDate).toBe(false);
    expect(res.upgradeRequired).toEqual({
      minRuntimeVersion: MIN_STRICT_RUNTIME_VERSION,
      requiredRuntimeCapabilities: [...MEMORY_RUNTIME_CAPABILITIES_V1],
    });
    // Typed stop: exactly ONE pages attempt, no link-sync fallback, no loop.
    expect(calls.filter((c) => c.includes('/memory/pages'))).toHaveLength(1);
    expect(calls.some((c) => c.includes('/memory/links/sync'))).toBe(false);
    // No ready marker: the replica state must not be touched by a refused sync.
    const state = runtime.resolve(WS).store.getReplicaState();
    expect(state?.accessVersion ?? 0).toBe(0);
    if (state) expect(state.status).not.toBe('ready');
  });

  it('legacy sync completion marks the replica state ready with accessVersion=0 (old semantics, never strict authorization)', async () => {
    runtime.resolve(WS);
    const pages: CloudPage[] = [{ id: 'a', path: 'a.md', content: 'A', updatedAt: 100 }];
    const { cloud } = makeCloud(() => pages);
    const res = await initialSyncFromCloud(runtime, cloud, WS);
    expect(res.pulled).toBe(1);
    const state = runtime.resolve(WS).store.getReplicaState();
    expect(state?.status).toBe('ready');
    expect(state?.accessVersion).toBe(0);
    expect(state?.replicaSubjectHash).toBe('');
    expect(state?.leaseExpiresAt).toBe(0);
  });

  it('legacy completion never downgrades a strict-authorized replica state', async () => {
    runtime.resolve(WS);
    // Simulate a prior strict reconcile result (authorized epoch).
    runtime.resolve(WS).store.applyReplicaCommit({
      heads: [],
      diffDeletePageIds: [],
      tombstonePageIds: [],
      state: {
        cursor: null,
        accessVersion: 7,
        replicaSubjectHash: 'sha256:subject-e1',
        contentHighWatermarkJson: JSON.stringify({ updatedAt: new Date(0).toISOString(), id: 'z' }),
        leaseExpiresAt: Date.now() + 60_000,
        status: 'ready',
      },
    });
    // A legacy-path sync completes (no strict snapshot registered).
    const pages: CloudPage[] = [{ id: 'a', path: 'a.md', content: 'A', updatedAt: 100 }];
    const { cloud } = makeCloud(() => pages);
    await initialSyncFromCloud(runtime, cloud, WS);
    const state = runtime.resolve(WS).store.getReplicaState();
    expect(state?.accessVersion).toBe(7); // authorization NOT downgraded
    expect(state?.replicaSubjectHash).toBe('sha256:subject-e1');
    expect(state?.leaseExpiresAt).toBeGreaterThan(Date.now());
  });
});
