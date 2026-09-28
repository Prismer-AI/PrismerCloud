// APC Root B (2026-07-25) — syncMemoryFromCloud is debounced.
//
// A churning `ownership rejected → adopt → re-declare` loop fires `host.acked`
// several times in a short window; each used to trigger a full per-workspace
// re-sync. This proves the production wrapper coalesces those rapid triggers
// into a SINGLE per-workspace fan-out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the actual cloud→local per-workspace sync so we can count fan-out calls
// without a real cloud / SQLite store.
vi.mock('../src/daemon/memory/cloud-sync.js', () => ({
  initialSyncFromCloud: vi.fn(async () => ({ pulled: 0, skipped: 0, upToDate: true })),
}));

import { initialSyncFromCloud } from '../src/daemon/memory/cloud-sync.js';
import { syncMemoryFromCloud } from '../src/daemon/memory/runner-wiring.js';
import type { MemoryRunnerWiring } from '../src/daemon/memory/runner-wiring.js';

function mkWiring(): MemoryRunnerWiring {
  return {
    runtime: { resolve: vi.fn(), peek: vi.fn(() => null) },
    keyManager: {},
  } as unknown as MemoryRunnerWiring;
}

describe('syncMemoryFromCloud debounce (APC Root B)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(initialSyncFromCloud).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces N rapid host.acked triggers into a single fan-out', async () => {
    const wiring = mkWiring();
    const cloud = {} as never;

    // Simulate 5 host.acked in the same churn window, same workspace.
    syncMemoryFromCloud(wiring, cloud, ['ws-1']);
    syncMemoryFromCloud(wiring, cloud, ['ws-1']);
    syncMemoryFromCloud(wiring, cloud, ['ws-1']);
    syncMemoryFromCloud(wiring, cloud, ['ws-1']);
    syncMemoryFromCloud(wiring, cloud, ['ws-1']);

    expect(initialSyncFromCloud).not.toHaveBeenCalled(); // nothing synchronous

    await vi.advanceTimersByTimeAsync(1_000); // default debounce window
    // MUTATION GUARD: strip the debounce and this is 5, not 1.
    expect(initialSyncFromCloud).toHaveBeenCalledTimes(1);
  });

  it('unions the workspaces seen within the window into one run', async () => {
    const wiring = mkWiring();
    const cloud = {} as never;

    syncMemoryFromCloud(wiring, cloud, ['ws-1']);
    syncMemoryFromCloud(wiring, cloud, ['ws-2']);
    syncMemoryFromCloud(wiring, cloud, ['ws-1']); // dup collapses

    await vi.advanceTimersByTimeAsync(1_000);
    // Two unique workspaces ⇒ two per-workspace calls, but only in ONE run.
    expect(initialSyncFromCloud).toHaveBeenCalledTimes(2);
    const syncedWs = vi.mocked(initialSyncFromCloud).mock.calls.map((c) => c[2]).sort();
    expect(syncedWs).toEqual(['ws-1', 'ws-2']);
  });

  it('runs again for a trigger after the window has drained', async () => {
    const wiring = mkWiring();
    const cloud = {} as never;

    syncMemoryFromCloud(wiring, cloud, ['ws-1']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(initialSyncFromCloud).toHaveBeenCalledTimes(1);

    syncMemoryFromCloud(wiring, cloud, ['ws-1']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(initialSyncFromCloud).toHaveBeenCalledTimes(2);
  });
});
