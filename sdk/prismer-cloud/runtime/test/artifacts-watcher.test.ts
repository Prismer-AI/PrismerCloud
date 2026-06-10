import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactsWatcher } from '../src/daemon/artifacts-watcher.js';

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `prismer-outbox-${prefix}-`));
}

function mockCloud(opts: { apiKey?: string; baseUrl?: string } = {}) {
  const apiKey = opts.apiKey ?? 'sk-test';
  const baseUrl = opts.baseUrl ?? 'http://cloud.test';
  // v2.0: CloudClient exposes apiKey/baseUrl as readonly getters (was private
  // `opts.*` in v1.x). Mock both surfaces so legacy assertions + new consumers
  // (outbox-watcher uses the public getters now) see the same values.
  return {
    apiKey,
    baseUrl,
    opts: { apiKey, baseUrl },
    urlFor(p: string) {
      return `${this.baseUrl}${p}`;
    },
  } as const;
}

function mkResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ArtifactsWatcher (Wave-9 per-task)', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const dir of cleanup.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('uploads files from per-task outbox + accumulates assetIds keyed by taskId', async () => {
    const taskA = tmpDir('taskA');
    cleanup.push(taskA);
    writeFileSync(join(taskA, 'poem.md'), '# Hi\n');
    writeFileSync(join(taskA, 'data.json'), '{"x":1}');

    const calls: Array<{ url: string; bodyKind: string | null }> = [];
    let assetUploads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/im/assets/direct-upload/init')) {
          return mkResponse({ ok: false, error: 'direct unavailable' }, 503);
        }
        const form = init?.body as FormData;
        const kind = form instanceof FormData ? (form.get('kind') as string | null) : null;
        calls.push({ url, bodyKind: kind });
        // Cloud responds with a unique asset id per call.
        assetUploads += 1;
        const id = `asset-${assetUploads}`;
        return mkResponse({ ok: true, data: { id, contentHash: `sha256-${id}`, workspaceId: 'ws-1', kind } }, 201);
      }) as unknown as typeof fetch,
    );

    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'container-x',
      workspaceId: () => 'ws-1',
      pollIntervalMs: 60_000, // we drive ticks manually via scanNow
      autoScan: true, // these tests exercise the retained legacy directory scan
    });
    watcher.setActiveTask({ taskId: 'task-A', artifactsDir: taskA });
    await watcher.scanNow();

    expect(calls.length).toBe(2);
    expect(calls[0]!.bodyKind).toBe('agent-output');
    expect(calls[1]!.bodyKind).toBe('agent-output');
    const flushed = watcher.flushPending('task-A');
    expect(flushed).toEqual(['asset-1', 'asset-2']);
    // Second flush is empty — drained.
    expect(watcher.flushPending('task-A')).toEqual([]);
  });

  it('keeps assetIds isolated across two concurrent tasks', async () => {
    const taskA = tmpDir('taskA');
    const taskB = tmpDir('taskB');
    cleanup.push(taskA, taskB);
    writeFileSync(join(taskA, 'a.txt'), 'A content');
    writeFileSync(join(taskB, 'b.txt'), 'B content');

    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/im/assets/direct-upload/init')) {
          return mkResponse({ ok: false, error: 'direct unavailable' }, 503);
        }
        n += 1;
        return mkResponse({ ok: true, data: { id: `asset-${n}`, contentHash: `sha256-${n}`, workspaceId: 'ws-1', kind: 'agent-output' } }, 201);
      }) as unknown as typeof fetch,
    );

    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'container-x',
      workspaceId: () => 'ws-1',
      pollIntervalMs: 60_000,
      autoScan: true, // these tests exercise the retained legacy directory scan
    });

    // Switch active task between scans — this is the dispatch.ts pattern,
    // setActiveTask is called per-dispatch and the watcher tags uploads
    // with whichever task is active at upload time.
    watcher.setActiveTask({ taskId: 'task-A', artifactsDir: taskA });
    await watcher.scanNow();
    watcher.setActiveTask({ taskId: 'task-B', artifactsDir: taskB });
    await watcher.scanNow();

    expect(watcher.flushPending('task-A')).toEqual(['asset-1']);
    expect(watcher.flushPending('task-B')).toEqual(['asset-2']);
  });

  it('skips upload when no active task is set', async () => {
    const dir = tmpDir('orphan');
    cleanup.push(dir);
    writeFileSync(join(dir, 'a.txt'), 'orphan');

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const watcher = new ArtifactsWatcher({
      artifactsDir: dir,
      cloud: mockCloud() as any,
      containerId: 'container-x',
      workspaceId: () => 'ws-1',
      pollIntervalMs: 60_000,
      autoScan: true, // these tests exercise the retained legacy directory scan
      log: { info: () => {}, warn: () => {} },
    });
    // No setActiveTask call — uploads should be skipped.
    await watcher.scanNow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('concurrent A+B: A finishing first does not clobber B\'s tracking (Wave-9 race fix)', async () => {
    // Reproduces the production race that motivated the per-task map:
    //   1. CEO orchestrator dispatched (taskA), addActiveTask(A)
    //   2. CEO calls create_task → cloud dispatches Engineer (taskB), addActiveTask(B)
    //   3. CEO finishes (no file output) → flushPending(A) + removeActiveTask(A)
    //   4. Engineer writes poem.md → must still be uploaded with taskId=B
    //   5. flushPending(B) returns Engineer's assetId
    //
    // Pre-fix: step 3 called setActiveTask(null), zeroing the global
    // activeTask. Step 4's tick had no active task → file uploaded with
    // taskId=undefined (skipped) → test would fail.
    const taskA = tmpDir('concurrentA');
    const taskB = tmpDir('concurrentB');
    cleanup.push(taskA, taskB);

    let n = 0;
    const calls: Array<{ taskId: string | undefined; fileName: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/im/assets/direct-upload/init')) {
          return mkResponse({ ok: false, error: 'direct unavailable' }, 503);
        }
        const form = init?.body as FormData;
        const meta = JSON.parse(form.get('metadata') as string) as { taskId?: string };
        // Recover the filename from the multipart Blob's filename field.
        // FormData's `getAll('file')` would let us inspect, but Blob name
        // is enough — we approximate by counting calls.
        n += 1;
        calls.push({ taskId: meta.taskId, fileName: `f${n}` });
        return mkResponse({ ok: true, data: { id: `asset-${n}`, contentHash: `sha256-${n}`, workspaceId: 'ws-1', kind: 'agent-output' } }, 201);
      }) as unknown as typeof fetch,
    );

    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'container-x',
      workspaceId: () => 'ws-1',
      pollIntervalMs: 60_000,
      autoScan: true, // these tests exercise the retained legacy directory scan
      log: { info: () => {}, warn: () => {} },
    });

    // Step 1+2: both dispatches register concurrently.
    watcher.addActiveTask({ taskId: 'task-A', artifactsDir: taskA });
    watcher.addActiveTask({ taskId: 'task-B', artifactsDir: taskB });

    // Step 3: Task A finishes with no output written. Drain its
    // (empty) pending list and remove its slot. Pre-fix: dispatch.ts
    // called `setActiveTask(null)` here which clobbered B as well.
    expect(watcher.flushPending('task-A')).toEqual([]);
    watcher.removeActiveTask('task-A');

    // Step 4: Engineer writes a file to taskB's outbox AFTER A's removal.
    writeFileSync(join(taskB, 'poem.md'), '# Code & Verse\n');
    await watcher.scanNow();

    // Step 5: B's flush must surface the assetId. The watcher's per-task
    // map kept B alive even after A's removal.
    const flushedB = watcher.flushPending('task-B');
    expect(flushedB).toEqual(['asset-1']);
    expect(calls.length).toBe(1);
    expect(calls[0]!.taskId).toBe('task-B');

    // Cleanup: remove B too.
    watcher.removeActiveTask('task-B');

    // After both removed, a stray file in taskA's dir should NOT upload
    // (no active task tagging that path).
    writeFileSync(join(taskA, 'stray.txt'), 'orphan');
    await watcher.scanNow();
    expect(calls.length).toBe(1); // unchanged
  });

  it('setActiveTask(null) does not clobber concurrently-added host-mode tasks', async () => {
    // Belt-and-braces: even if some legacy code path still calls
    // setActiveTask(null), it must only clear the legacy container slot,
    // never the host-mode active-tasks map.
    const taskB = tmpDir('legacySafeB');
    cleanup.push(taskB);
    writeFileSync(join(taskB, 'out.txt'), 'B');

    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/im/assets/direct-upload/init')) {
          return mkResponse({ ok: false, error: 'direct unavailable' }, 503);
        }
        n += 1;
        return mkResponse({ ok: true, data: { id: `asset-${n}`, contentHash: `sha256-${n}`, workspaceId: 'ws-1', kind: 'agent-output' } }, 201);
      }) as unknown as typeof fetch,
    );

    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'container-x',
      workspaceId: () => 'ws-1',
      pollIntervalMs: 60_000,
      autoScan: true, // these tests exercise the retained legacy directory scan
      log: { info: () => {}, warn: () => {} },
    });
    watcher.addActiveTask({ taskId: 'task-B', artifactsDir: taskB });
    // Simulate a stale call from old code path.
    watcher.setActiveTask(null);
    await watcher.scanNow();
    expect(watcher.flushPending('task-B')).toEqual(['asset-1']);
  });

  it('container mode default outbox path uploads with kind=sandbox-output + containerId', async () => {
    const dir = tmpDir('container');
    cleanup.push(dir);
    writeFileSync(join(dir, 'output.txt'), 'ok');

    let kindSeen: string | null = null;
    let metaSeen: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof _input === 'string' ? _input : _input.toString();
        if (url.endsWith('/api/im/assets/direct-upload/init')) {
          return mkResponse({ ok: false, error: 'direct unavailable' }, 503);
        }
        const form = init?.body as FormData;
        kindSeen = form.get('kind') as string;
        metaSeen = form.get('metadata') as string;
        return mkResponse({ ok: true, data: { id: 'asset-c', contentHash: 'sha256-c', workspaceId: 'ws-1', kind: kindSeen } }, 201);
      }) as unknown as typeof fetch,
    );

    const watcher = new ArtifactsWatcher({
      artifactsDir: dir, // simulates container mode's fixed /workspace/_outbox
      cloud: mockCloud() as any,
      containerId: 'container-xyz',
      workspaceId: () => 'ws-1',
      pollIntervalMs: 60_000,
      autoScan: true, // these tests exercise the retained legacy directory scan
    });
    watcher.setActiveTask({ taskId: 'task-c' });
    await watcher.scanNow();

    expect(kindSeen).toBe('sandbox-output');
    const meta = JSON.parse(metaSeen ?? '{}') as { taskId?: string; containerId?: string };
    expect(meta.taskId).toBe('task-c');
    expect(meta.containerId).toBe('container-xyz');
  });

  // ── release201/26 Phase 0 §8 — host vs container mode must not cross ──
  // Regression guard for 6be6e727's side-effect (release201/26 §2): the
  // watcher must keep the legacy container default-dir scan (kind=
  // sandbox-output, carries containerId) and the host per-task-dir scan
  // (kind=agent-output, no containerId) on separate code paths — files in
  // one dir must never be tagged with the other mode's kind/metadata, and
  // assetIds must accumulate under the correct task.
  //
  // NB: this watcher does NOT (and must not) monitor any hermes profile
  // dir — that auto-upload path (A2) was reverted in commit 54eab93a in
  // favour of declare-first (release201/09 §9.4a). The only scan targets
  // are `opts.artifactsDir` (container) and each task's `artifactsDir` (host).
  it('container default dir + host per-task dir scanned concurrently without crossing', async () => {
    const containerDir = tmpDir('mixedContainer');
    const hostTaskDir = tmpDir('mixedHost');
    cleanup.push(containerDir, hostTaskDir);
    writeFileSync(join(containerDir, 'sandbox-out.txt'), 'C');
    writeFileSync(join(hostTaskDir, 'host-out.txt'), 'H');

    let n = 0;
    const calls: Array<{ kind: string | null; taskId?: string; containerId?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/im/assets/direct-upload/init')) {
          return mkResponse({ ok: false, error: 'direct unavailable' }, 503);
        }
        const form = init?.body as FormData;
        const kind = form instanceof FormData ? (form.get('kind') as string | null) : null;
        const meta = JSON.parse((form.get('metadata') as string) ?? '{}') as {
          taskId?: string;
          containerId?: string;
        };
        n += 1;
        calls.push({ kind, taskId: meta.taskId, containerId: meta.containerId });
        return mkResponse(
          { ok: true, data: { id: `asset-${n}`, contentHash: `sha256-${n}`, workspaceId: 'ws-1', kind } },
          201,
        );
      }) as unknown as typeof fetch,
    );

    const watcher = new ArtifactsWatcher({
      artifactsDir: containerDir, // container mode default scan target
      cloud: mockCloud() as any,
      containerId: 'container-abc',
      workspaceId: () => 'ws-1',
      pollIntervalMs: 60_000,
      autoScan: true, // these tests exercise the retained legacy directory scan
      log: { info: () => {}, warn: () => {} },
    });
    // Legacy container slot (no artifactsDir) tags the default-dir scan.
    watcher.setActiveTask({ taskId: 'container-task' });
    // Host-mode per-task dir registered alongside — different path, kind.
    watcher.addActiveTask({ taskId: 'host-task', artifactsDir: hostTaskDir });
    await watcher.scanNow();

    expect(calls.length).toBe(2);
    const containerCall = calls.find((c) => c.kind === 'sandbox-output');
    const hostCall = calls.find((c) => c.kind === 'agent-output');
    expect(containerCall).toBeDefined();
    expect(hostCall).toBeDefined();
    // Container upload carries containerId + the legacy container task id.
    expect(containerCall!.taskId).toBe('container-task');
    expect(containerCall!.containerId).toBe('container-abc');
    // Host upload is tagged with the host task id and carries NO containerId.
    expect(hostCall!.taskId).toBe('host-task');
    expect(hostCall!.containerId).toBeUndefined();
    // assetIds accumulate under the right task — paths did not cross.
    expect(watcher.flushPending('container-task').length).toBe(1);
    expect(watcher.flushPending('host-task').length).toBe(1);
  });
});

describe('ArtifactsWatcher (release202/09 P2 — explicit delivery + autoScan gate)', () => {
  it('recordDeliveredAsset accumulates into pendingByTask and flushPending drains it', () => {
    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'container-x',
      workspaceId: () => 'ws-1',
      autoScan: false,
      log: { info: () => {}, warn: () => {} },
    });

    watcher.recordDeliveredAsset('task-A', 'asset-1');
    watcher.recordDeliveredAsset('task-A', 'asset-2');
    watcher.recordDeliveredAsset('task-B', 'asset-3');

    // Drains per-task, in insertion order — exactly the channel dispatch.ts
    // reads at reply-build time (reply.assetIds).
    expect(watcher.flushPending('task-A')).toEqual(['asset-1', 'asset-2']);
    expect(watcher.flushPending('task-B')).toEqual(['asset-3']);
    // Idempotent drain — second flush is empty.
    expect(watcher.flushPending('task-A')).toEqual([]);
  });

  it('recordDeliveredAsset de-dups a double-delivered assetId', () => {
    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'container-x',
      workspaceId: () => 'ws-1',
      autoScan: false,
      log: { info: () => {}, warn: () => {} },
    });
    watcher.recordDeliveredAsset('task-A', 'asset-1');
    watcher.recordDeliveredAsset('task-A', 'asset-1');
    expect(watcher.flushPending('task-A')).toEqual(['asset-1']);
  });

  it('ignores empty taskId / assetId', () => {
    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'container-x',
      workspaceId: () => 'ws-1',
      autoScan: false,
      log: { info: () => {}, warn: () => {} },
    });
    watcher.recordDeliveredAsset('', 'asset-1');
    watcher.recordDeliveredAsset('task-A', '');
    expect(watcher.flushPending('task-A')).toEqual([]);
  });

  it('autoScan:false — scanNow() never reads the directory or uploads', async () => {
    const taskDir = mkdtempSync(join(tmpdir(), 'prismer-outbox-noscan-'));
    writeFileSync(join(taskDir, 'report.pdf'), '%PDF-1.4\n');
    const fetchSpy = vi.fn(async () => mkResponse({ ok: true, data: { id: 'x', contentHash: 'h' } }, 201));
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'container-x',
      workspaceId: () => 'ws-1',
      autoScan: false,
      log: { info: () => {}, warn: () => {} },
    });
    watcher.setActiveTask({ taskId: 'task-A', artifactsDir: taskDir });
    // With auto-scan gated off, the dispatch-end scanNow() drain is a no-op:
    // no fetch fired, nothing accumulated. (Explicit delivery is the only path.)
    await watcher.scanNow();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(watcher.flushPending('task-A')).toEqual([]);

    vi.unstubAllGlobals();
    rmSync(taskDir, { recursive: true, force: true });
  });

  it('autoScan default is OFF (omitting the flag disables the scan)', async () => {
    const taskDir = mkdtempSync(join(tmpdir(), 'prismer-outbox-default-'));
    writeFileSync(join(taskDir, 'a.txt'), 'hello');
    const fetchSpy = vi.fn(async () => mkResponse({ ok: true, data: { id: 'x', contentHash: 'h' } }, 201));
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

    const watcher = new ArtifactsWatcher({
      cloud: mockCloud() as any,
      containerId: 'container-x',
      workspaceId: () => 'ws-1',
      // autoScan intentionally omitted → defaults to OFF
      log: { info: () => {}, warn: () => {} },
    });
    watcher.setActiveTask({ taskId: 'task-A', artifactsDir: taskDir });
    await watcher.scanNow();
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    rmSync(taskDir, { recursive: true, force: true });
  });
});
