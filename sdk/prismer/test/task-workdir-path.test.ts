// release201/09 Phase 2 unit tests — daemon path resolver + checkpoint
// diff logic + once-off migration helper.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolvePaths,
  resolveTaskWorkdir,
  resolveDeviceAgentDir,
  deriveSessionId,
  resolveSessionDir,
  resolveSessionTaskWorkdir,
  UNSCOPED_PROJECT_SENTINEL,
} from '../src/config.js';
import { enumerateArtifactFiles, fetchAttachedHashes } from '../src/daemon/checkpoint-server.js';
import { migrateLegacyTaskWorkdirs } from '../src/daemon/task-workdir-migration.js';
import type { CloudClient } from '../src/auth.js';

function makeTempPaths(prefix = 'prismer-09-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return resolvePaths(root);
}

describe('resolveTaskWorkdir (release201/09 §9.1)', () => {
  it('composes workspaces/<wid>/projects/<pid>/tasks/<tid>/ when projectId is concrete', () => {
    const paths = makeTempPaths();
    const dir = resolveTaskWorkdir(paths, 'ws-1', 'proj-A', 'task-99');
    expect(dir).toContain('/workspaces/ws-1/projects/proj-A/tasks/task-99');
    rmSync(paths.root, { recursive: true, force: true });
  });

  it('folds null / undefined projectId into _unscoped sentinel', () => {
    const paths = makeTempPaths();
    expect(resolveTaskWorkdir(paths, 'ws-1', null, 'task-99')).toContain(
      `/projects/${UNSCOPED_PROJECT_SENTINEL}/tasks/task-99`,
    );
    expect(resolveTaskWorkdir(paths, 'ws-1', undefined, 'task-99')).toContain(
      `/projects/${UNSCOPED_PROJECT_SENTINEL}/tasks/task-99`,
    );
    expect(resolveTaskWorkdir(paths, 'ws-1', '', 'task-99')).toContain(
      `/projects/${UNSCOPED_PROJECT_SENTINEL}/tasks/task-99`,
    );
    rmSync(paths.root, { recursive: true, force: true });
  });

  it('throws when workspaceId or taskId is empty', () => {
    const paths = makeTempPaths();
    expect(() => resolveTaskWorkdir(paths, '', 'p', 't')).toThrow();
    expect(() => resolveTaskWorkdir(paths, 'ws', 'p', '')).toThrow();
    rmSync(paths.root, { recursive: true, force: true });
  });
});

describe('session scope (release202/04 §3.1 P1)', () => {
  it('deriveSessionId returns the conversationId verbatim when present', () => {
    expect(deriveSessionId('cmp-conv-1')).toBe('cmp-conv-1');
  });

  it('deriveSessionId returns null for absent / empty conversationId', () => {
    expect(deriveSessionId(null)).toBeNull();
    expect(deriveSessionId(undefined)).toBeNull();
    expect(deriveSessionId('')).toBeNull();
  });

  it('resolveSessionDir composes sessions/<sid>/ under projects/<pid>', () => {
    const paths = makeTempPaths();
    const dir = resolveSessionDir(paths, 'ws-1', 'proj-A', 'cmp-conv-1');
    expect(dir).toContain('/workspaces/ws-1/projects/proj-A/sessions/cmp-conv-1');
    expect(dir).not.toContain('/tasks/');
    rmSync(paths.root, { recursive: true, force: true });
  });

  it('resolveSessionDir folds null projectId into _unscoped', () => {
    const paths = makeTempPaths();
    expect(resolveSessionDir(paths, 'ws-1', null, 'cmp-conv-1')).toContain(
      `/projects/${UNSCOPED_PROJECT_SENTINEL}/sessions/cmp-conv-1`,
    );
    rmSync(paths.root, { recursive: true, force: true });
  });

  it('resolveSessionTaskWorkdir nests the task under the session when conversationId present', () => {
    const paths = makeTempPaths();
    const sid = deriveSessionId('cmp-conv-1')!;
    const dir = resolveSessionTaskWorkdir(paths, 'ws-1', 'proj-A', sid, 'task-99');
    expect(dir).toContain(
      '/workspaces/ws-1/projects/proj-A/sessions/cmp-conv-1/tasks/task-99',
    );
    rmSync(paths.root, { recursive: true, force: true });
  });

  it('falls back to the plain tasks/<tid>/ layout when conversationId absent', () => {
    const paths = makeTempPaths();
    const sid = deriveSessionId(null);
    expect(sid).toBeNull();
    // No session → caller uses resolveTaskWorkdir (plain layout, no session).
    const plain = resolveTaskWorkdir(paths, 'ws-1', 'proj-A', 'task-99');
    expect(plain).toContain('/workspaces/ws-1/projects/proj-A/tasks/task-99');
    expect(plain).not.toContain('/sessions/');
    rmSync(paths.root, { recursive: true, force: true });
  });

  it('throws when sessionId or taskId is empty', () => {
    const paths = makeTempPaths();
    expect(() => resolveSessionDir(paths, 'ws-1', 'p', '')).toThrow();
    expect(() => resolveSessionTaskWorkdir(paths, 'ws-1', 'p', 's', '')).toThrow();
    rmSync(paths.root, { recursive: true, force: true });
  });
});

describe('resolveDeviceAgentDir (release201/09 §9.1)', () => {
  it('composes devices/<did>/agents/<aid>/', () => {
    const paths = makeTempPaths();
    expect(resolveDeviceAgentDir(paths, 'dmn-1', 'agent-X')).toContain(
      '/devices/dmn-1/agents/agent-X',
    );
    rmSync(paths.root, { recursive: true, force: true });
  });
  it('throws on missing daemonId or agentId', () => {
    const paths = makeTempPaths();
    expect(() => resolveDeviceAgentDir(paths, '', 'a')).toThrow();
    expect(() => resolveDeviceAgentDir(paths, 'd', '')).toThrow();
    rmSync(paths.root, { recursive: true, force: true });
  });
});

describe('enumerateArtifactFiles (release201/09 §9.4a.7)', () => {
  let paths: ReturnType<typeof makeTempPaths>;
  let resultDir: string;
  beforeEach(() => {
    paths = makeTempPaths();
    const taskRoot = resolveTaskWorkdir(paths, 'ws-1', 'proj-A', 'task-99');
    resultDir = join(taskRoot, 'result');
    mkdirSync(resultDir, { recursive: true });
  });
  afterEach(() => rmSync(paths.root, { recursive: true, force: true }));

  it('returns [] when result/ is missing', async () => {
    const taskRoot = resolveTaskWorkdir(paths, 'ws-1', 'proj-A', 'never-existed');
    const out = await enumerateArtifactFiles(join(taskRoot, 'result'));
    expect(out).toEqual([]);
  });

  it('hashes a single file (and reports relative path + size)', async () => {
    writeFileSync(join(resultDir, 'report.pdf'), 'pdf-payload');
    // Make mtime older than the 5s partial-write guard.
    const past = new Date(Date.now() - 10_000);
    const { utimesSync } = await import('node:fs');
    utimesSync(join(resultDir, 'report.pdf'), past, past);
    const out = await enumerateArtifactFiles(resultDir);
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe('report.pdf');
    expect(out[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(out[0]!.sizeBytes).toBe('pdf-payload'.length);
  });

  it('skips dotfiles, partial markers, zero-byte files, and recently-written files', async () => {
    writeFileSync(join(resultDir, '.DS_Store'), 'junk');
    writeFileSync(join(resultDir, 'foo.swp'), 'editor');
    writeFileSync(join(resultDir, 'bar.partial'), 'inflight');
    writeFileSync(join(resultDir, 'baz~'), 'editor-bak');
    writeFileSync(join(resultDir, 'big.bin.crdownload'), 'chrome-dl');
    writeFileSync(join(resultDir, 'empty.txt'), '');
    writeFileSync(join(resultDir, 'just-written.txt'), 'too fresh');
    // older file (eligible)
    writeFileSync(join(resultDir, 'old.txt'), 'content');
    const { utimesSync } = await import('node:fs');
    const past = new Date(Date.now() - 10_000);
    utimesSync(join(resultDir, 'old.txt'), past, past);
    const out = await enumerateArtifactFiles(resultDir);
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe('old.txt');
  });

  it('walks nested subdirectories but skips _uploaded and _rejected', async () => {
    mkdirSync(join(resultDir, 'subdir'));
    writeFileSync(join(resultDir, 'subdir', 'nested.txt'), 'nested');
    mkdirSync(join(resultDir, '_uploaded'));
    writeFileSync(join(resultDir, '_uploaded', 'history.txt'), 'history');
    mkdirSync(join(resultDir, '_rejected'));
    writeFileSync(join(resultDir, '_rejected', 'bad.txt'), 'bad');
    const { utimesSync } = await import('node:fs');
    const past = new Date(Date.now() - 10_000);
    utimesSync(join(resultDir, 'subdir', 'nested.txt'), past, past);
    const out = await enumerateArtifactFiles(resultDir);
    expect(out.map((f) => f.path)).toEqual(['subdir/nested.txt']);
  });
});

describe('fetchAttachedHashes', () => {
  it('extracts contentHash values from the cloud response', async () => {
    const cloud = {
      get: async () => [
        { contentHash: 'a'.repeat(64) },
        { contentHash: 'b'.repeat(64) },
        { contentHash: 'too-short' }, // ignored
        { /* missing */ },
      ],
    } as unknown as CloudClient;
    const set = await fetchAttachedHashes(cloud, 'task-99');
    expect(set.has('a'.repeat(64))).toBe(true);
    expect(set.has('b'.repeat(64))).toBe(true);
    expect(set.size).toBe(2);
  });

  it('throws on cloud failure (caller maps to 503)', async () => {
    const cloud = {
      get: async () => {
        throw new Error('unreachable');
      },
    } as unknown as CloudClient;
    await expect(fetchAttachedHashes(cloud, 'task-99')).rejects.toThrow('unreachable');
  });
});

describe('migrateLegacyTaskWorkdirs (release201/09 §9.3.1)', () => {
  let paths: ReturnType<typeof makeTempPaths>;
  beforeEach(() => {
    paths = makeTempPaths();
  });
  afterEach(() => rmSync(paths.root, { recursive: true, force: true }));

  it('moves _outbox → artifacts/ and workdir → scratch/, writes watermark, drops symlink', async () => {
    // Lay down a legacy task dir.
    const legacy = join(paths.runsDir, 'task-99');
    mkdirSync(join(legacy, '_outbox'), { recursive: true });
    mkdirSync(join(legacy, 'workdir'), { recursive: true });
    writeFileSync(join(legacy, '_outbox', 'r.txt'), 'r');
    writeFileSync(join(legacy, 'workdir', 'w.txt'), 'w');

    const cloud = {
      get: async () => ({ workspaceId: 'ws-1', projectId: 'proj-A' }),
    } as unknown as CloudClient;
    const mig = await migrateLegacyTaskWorkdirs(paths, cloud);
    expect(mig.migrated).toBe(1);
    expect(mig.skipped).toBe(0);

    const newDir = resolveTaskWorkdir(paths, 'ws-1', 'proj-A', 'task-99');
    expect(existsSync(join(newDir, 'artifacts', 'r.txt'))).toBe(true);
    expect(existsSync(join(newDir, 'scratch', 'w.txt'))).toBe(true);
    expect(existsSync(join(paths.root, 'migrations/task-workdir-v207', 'task-99'))).toBe(true);
  });

  it('also migrates a legacy result/ dir → artifacts/ (release201/09 intermediate name)', async () => {
    const legacy = join(paths.runsDir, 'task-77');
    mkdirSync(join(legacy, 'result'), { recursive: true });
    writeFileSync(join(legacy, 'result', 'r.txt'), 'r');

    const cloud = {
      get: async () => ({ workspaceId: 'ws-1', projectId: 'proj-A' }),
    } as unknown as CloudClient;
    const mig = await migrateLegacyTaskWorkdirs(paths, cloud);
    expect(mig.migrated).toBe(1);

    const newDir = resolveTaskWorkdir(paths, 'ws-1', 'proj-A', 'task-77');
    expect(existsSync(join(newDir, 'artifacts', 'r.txt'))).toBe(true);
  });

  it('is idempotent — second pass finds watermark and skips', async () => {
    const legacy = join(paths.runsDir, 'task-99');
    mkdirSync(join(legacy, '_outbox'), { recursive: true });
    writeFileSync(join(legacy, '_outbox', 'r.txt'), 'r');
    const cloud = {
      get: async () => ({ workspaceId: 'ws-1', projectId: null }),
    } as unknown as CloudClient;
    await migrateLegacyTaskWorkdirs(paths, cloud);
    const second = await migrateLegacyTaskWorkdirs(paths, cloud);
    // After first pass the legacy dir is replaced with a symlink — but
    // lstat skips symlinks, so this scan reports 0 in `scanned`. (skipped
    // counter would bump only if a real dir survived without watermark.)
    expect(second.migrated).toBe(0);
  });

  it('records failure when cloud cannot resolve workspaceId', async () => {
    const legacy = join(paths.runsDir, 'task-99');
    mkdirSync(legacy, { recursive: true });
    const cloud = {
      get: async () => ({ workspaceId: null, projectId: null }),
    } as unknown as CloudClient;
    const mig = await migrateLegacyTaskWorkdirs(paths, cloud);
    expect(mig.failed).toBe(1);
    expect(mig.errors[0]!.reason).toBe('no_workspace_id');
  });
});
