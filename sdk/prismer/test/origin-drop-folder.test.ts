// Drop-folder adapter tests.
//
// Acceptance: doc 26 §5 L2-T1 (100 files all uploaded, dead-letter=0)
//             doc 26 §5 A-S2 (drop folder visible to mobile within 30s)
//
// The polling-based watcher is verified end-to-end with a fake CloudClient
// (no actual HTTP) to keep the test deterministic and avoid coupling to the
// cloud test stack.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { DropFolderAdapter } from '../src/daemon/asset/origin/drop-folder.js';
import { OriginOutbox } from '../src/daemon/asset/origin/outbox.js';
import { UploadRunner } from '../src/daemon/asset/origin/upload-runner.js';
import type { OriginAdapter } from '../src/daemon/asset/origin/spi.js';
import type { CloudUploadClient } from '../src/daemon/asset/origin/upload-runner.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'prismer-drop-home-'));
}

interface FakeCloudCall {
  workspaceId: string;
  filename: string;
  sourceRef: string;
  sourceKind: string;
  folderPath: string | null;
  bytes: Buffer;
}

function fakeCloud(opts: { failFirst?: number } = {}): {
  client: CloudUploadClient;
  calls: FakeCloudCall[];
} {
  const calls: FakeCloudCall[] = [];
  let failsRemaining = opts.failFirst ?? 0;
  const client: CloudUploadClient = {
    async uploadAsset(req) {
      if (failsRemaining > 0) {
        failsRemaining -= 1;
        throw new Error('synthetic upload failure');
      }
      calls.push({
        workspaceId: req.workspaceId,
        filename: req.filename,
        sourceRef: req.metadata.sourceRef as string,
        sourceKind: req.metadata.sourceKind as string,
        folderPath: req.folderPath ?? null,
        bytes: Buffer.from(req.bytes),
      });
      return {
        assetId: `as_${calls.length}`,
        contentHash: 'sha256-fake',
      };
    },
  };
  return { client, calls };
}

async function ensureWorkspaceLayout(home: string, wid: string): Promise<{
  drop: string;
  uploaded: string;
  failed: string;
}> {
  const drop = join(home, '.prismer', 'workspaces', wid, 'drop');
  const uploaded = join(home, '.prismer', 'workspaces', wid, 'uploaded');
  const failed = join(home, '.prismer', 'workspaces', wid, 'upload-failed');
  await fs.mkdir(drop, { recursive: true });
  await fs.mkdir(uploaded, { recursive: true });
  await fs.mkdir(failed, { recursive: true });
  return { drop, uploaded, failed };
}

describe('DropFolderAdapter', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  it('produces sourceRef = folder://<wid>/<relpath>', async () => {
    const home = tmpHome();
    cleanup.push(home);
    const { drop } = await ensureWorkspaceLayout(home, 'ws_a');
    const adapter = new DropFolderAdapter({ homeDir: home });
    const filePath = join(drop, 'sample.csv');
    writeFileSync(filePath, 'a,b\n1,2\n');
    const stat = await fs.stat(filePath);
    const obs = {
      workspaceId: 'ws_a',
      detail: { path: filePath, watchDir: drop, size: stat.size, mtime: Math.floor(stat.mtimeMs) },
      observedAt: Math.floor(stat.mtimeMs),
    };
    const id = await adapter.identifySource(obs);
    expect(id.sourceRef).toBe('folder://ws_a/sample.csv');
    expect(id.hints?.filename).toBe('sample.csv');
    expect(id.hints?.folderPath).toBe('');
    const bytes = await adapter.fetch(obs);
    expect(bytes.size).toBe(stat.size);
    expect(bytes.bytes.toString()).toBe('a,b\n1,2\n');
  });

  it('preserves nested folderPath relative to drop/', async () => {
    const home = tmpHome();
    cleanup.push(home);
    const { drop, uploaded } = await ensureWorkspaceLayout(home, 'ws_a');
    const sub = join(drop, 'sub', 'dir');
    await fs.mkdir(sub, { recursive: true });
    const filePath = join(sub, 'note.md');
    writeFileSync(filePath, '# hi');
    const adapter = new DropFolderAdapter({ homeDir: home });
    const id = await adapter.identifySource({
      workspaceId: 'ws_a',
      detail: { path: filePath, watchDir: drop, size: 4, mtime: 1 },
      observedAt: 1,
    });
    expect(id.sourceRef).toBe('folder://ws_a/sub/dir/note.md');
    expect(id.hints?.folderPath).toBe('sub/dir');

    await adapter.onUploadSuccess({
      workspaceId: 'ws_a',
      detail: { path: filePath, watchDir: drop, size: 4, mtime: 1 },
      observedAt: 1,
    });
    expect(existsSync(join(uploaded, 'sub', 'dir', 'note.md'))).toBe(true);
  });

  it('end-to-end: 100 files burst → 100 cloud calls, dead-letter=0 (L2-T1)', async () => {
    const home = tmpHome();
    cleanup.push(home);
    const { drop, uploaded } = await ensureWorkspaceLayout(home, 'ws_a');

    for (let i = 0; i < 100; i += 1) {
      writeFileSync(join(drop, `file-${i}.txt`), `payload ${i}`);
    }

    const outbox = new OriginOutbox({ dbPath: join(home, 'asset-origin.db') });
    cleanup.push(home);
    const adapter = new DropFolderAdapter({ homeDir: home });
    const { client, calls } = fakeCloud();
    const runner = new UploadRunner({
      outbox,
      cloud: client,
      adapters: { 'drop-folder': adapter as OriginAdapter },
      maxAttempts: 3,
    });

    // Manually scan + enqueue (simulating one polling tick).
    const scanned = await adapter.scanOnce('ws_a');
    for (const obs of scanned) {
      const id = await adapter.identifySource(obs);
      const bytes = await adapter.fetch(obs);
      outbox.enqueue({
        workspaceId: obs.workspaceId,
        originKind: 'drop-folder',
        sourceRef: id.sourceRef,
        payloadJson: JSON.stringify(obs.detail),
        hintsJson: JSON.stringify({ ...id.hints, mime: bytes.mime, size: bytes.size }),
        observedAt: obs.observedAt,
      });
    }
    expect(outbox.pendingCount()).toBe(100);

    await runner.drainOnce();

    expect(outbox.pendingCount()).toBe(0);
    expect(outbox.uploadedCount()).toBe(100);
    expect(outbox.deadLetterCount()).toBe(0);
    expect(calls).toHaveLength(100);
    // All files moved to uploaded/.
    const remainingInDrop = await fs.readdir(drop);
    expect(remainingInDrop).toHaveLength(0);
    const inUploaded = await fs.readdir(uploaded);
    expect(inUploaded).toHaveLength(100);
  });

  it('L2-T2: pending rows survive a runner restart and finish on next drain', async () => {
    const home = tmpHome();
    cleanup.push(home);
    const { drop, uploaded } = await ensureWorkspaceLayout(home, 'ws_a');
    writeFileSync(join(drop, 'persistent.txt'), 'x');

    const dbPath = join(home, 'asset-origin.db');
    const adapter = new DropFolderAdapter({ homeDir: home });

    // Round 1: enqueue, do NOT run uploader.
    {
      const outbox = new OriginOutbox({ dbPath });
      const obs = (await adapter.scanOnce('ws_a'))[0];
      const id = await adapter.identifySource(obs);
      outbox.enqueue({
        workspaceId: 'ws_a',
        originKind: 'drop-folder',
        sourceRef: id.sourceRef,
        payloadJson: JSON.stringify(obs.detail),
        hintsJson: JSON.stringify(id.hints),
        observedAt: obs.observedAt,
      });
      expect(outbox.pendingCount()).toBe(1);
      outbox.close();
    }

    // Round 2: simulate restart — fresh outbox + runner over the same db.
    {
      const outbox = new OriginOutbox({ dbPath });
      expect(outbox.pendingCount()).toBe(1);
      const { client, calls } = fakeCloud();
      const runner = new UploadRunner({
        outbox,
        cloud: client,
        adapters: { 'drop-folder': adapter as OriginAdapter },
        maxAttempts: 3,
      });
      await runner.drainOnce();
      expect(calls).toHaveLength(1);
      expect(outbox.pendingCount()).toBe(0);
      expect(outbox.uploadedCount()).toBe(1);
      expect(existsSync(join(uploaded, 'persistent.txt'))).toBe(true);
      outbox.close();
    }
  });

  it('moves a permanently-failing file to upload-failed/ + dead-letter', async () => {
    const home = tmpHome();
    cleanup.push(home);
    const { drop, failed } = await ensureWorkspaceLayout(home, 'ws_a');
    writeFileSync(join(drop, 'broken.bin'), 'x');

    const outbox = new OriginOutbox({ dbPath: join(home, 'asset-origin.db') });
    const adapter = new DropFolderAdapter({ homeDir: home });
    const { client } = fakeCloud({ failFirst: 100 });
    const runner = new UploadRunner({
      outbox,
      cloud: client,
      adapters: { 'drop-folder': adapter as OriginAdapter },
      maxAttempts: 3,
    });

    const obs = (await adapter.scanOnce('ws_a'))[0];
    const id = await adapter.identifySource(obs);
    outbox.enqueue({
      workspaceId: 'ws_a',
      originKind: 'drop-folder',
      sourceRef: id.sourceRef,
      payloadJson: JSON.stringify(obs.detail),
      hintsJson: JSON.stringify(id.hints),
      observedAt: obs.observedAt,
    });

    await runner.drainOnce();
    // First attempt failed, recorded back to pending; drainOnce processes once per call.
    await runner.drainOnce();
    await runner.drainOnce();

    expect(outbox.pendingCount()).toBe(0);
    expect(outbox.deadLetterCount()).toBe(1);
    expect(existsSync(join(failed, 'broken.bin'))).toBe(true);
    expect(readFileSync(join(failed, 'broken.bin')).toString()).toBe('x');
  });

  it('skips symbolic links — no infinite recursion on a self-referencing loop', async () => {
    const home = tmpHome();
    cleanup.push(home);
    const { drop } = await ensureWorkspaceLayout(home, 'ws_a');
    writeFileSync(join(drop, 'real.txt'), 'real content');
    // ln -s . loop — symlink that points back to its parent. Without the
    // lstat-and-skip-symlink guard, walk() would recurse forever.
    symlinkSync('.', join(drop, 'loop'));
    // Symlinked file pointing outside drop/ — must NOT be uploaded.
    writeFileSync(join(home, 'outside.secret'), 'secrets');
    symlinkSync(join(home, 'outside.secret'), join(drop, 'pointer-out'));

    const adapter = new DropFolderAdapter({ homeDir: home });
    const observations = await adapter.scanOnce('ws_a');
    const refs = observations.map((o) => (o.detail as { path: string }).path).map((p) => p.split('/').pop());
    expect(refs).toContain('real.txt');
    expect(refs).not.toContain('loop');
    expect(refs).not.toContain('pointer-out');
    expect(refs).not.toContain('outside.secret');
  });

  it('idempotent re-scan: same file unchanged → outbox row count stays at 1', async () => {
    const home = tmpHome();
    cleanup.push(home);
    const { drop } = await ensureWorkspaceLayout(home, 'ws_a');
    writeFileSync(join(drop, 'static.txt'), 'x');

    const outbox = new OriginOutbox({ dbPath: join(home, 'asset-origin.db') });
    const adapter = new DropFolderAdapter({ homeDir: home });

    const enqueueScan = async () => {
      for (const obs of await adapter.scanOnce('ws_a')) {
        const id = await adapter.identifySource(obs);
        outbox.enqueue({
          workspaceId: 'ws_a',
          originKind: 'drop-folder',
          sourceRef: id.sourceRef,
          payloadJson: JSON.stringify(obs.detail),
          hintsJson: JSON.stringify(id.hints),
          observedAt: obs.observedAt,
        });
      }
    };

    await enqueueScan();
    await enqueueScan();
    await enqueueScan();
    expect(outbox.pendingCount()).toBe(1);
  });
});
