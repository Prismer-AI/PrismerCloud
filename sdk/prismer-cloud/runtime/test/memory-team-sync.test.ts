import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  syncTeamMemory,
  listMarkdownFiles,
  LAST_SYNC_FILE,
} from '../src/memory-team-sync.js';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function makeTempDir(): string {
  const d = join(tmpdir(), `prismer-team-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

interface FakeServerCall {
  body: any;
  url: string;
}

function makeFakeFetch(response: any) {
  const calls: FakeServerCall[] = [];
  const fake: typeof fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ body, url });
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
    } as unknown as Response;
  }) as any;
  return { fake, calls };
}

describe('listMarkdownFiles', () => {
  let root: string;
  beforeEach(() => {
    root = makeTempDir();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns .md files recursively, relative paths, posix separators', () => {
    writeFileSync(join(root, 'a.md'), '# A');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'b.md'), '# B');
    writeFileSync(join(root, 'ignore.txt'), 'not md');

    const files = listMarkdownFiles(root);
    expect(files.sort()).toEqual(['a.md', 'sub/b.md']);
  });

  it('skips .git, node_modules, and the sidecar', () => {
    writeFileSync(join(root, 'a.md'), '# A');
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'ignored.md'), '# Ignored');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'also.md'), '# Also Ignored');
    writeFileSync(join(root, LAST_SYNC_FILE), '{}');

    const files = listMarkdownFiles(root);
    expect(files).toEqual(['a.md']);
  });
});

describe('syncTeamMemory — delta push', () => {
  let root: string;
  beforeEach(() => {
    root = makeTempDir();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('pushes all files on first sync (no sidecar)', async () => {
    writeFileSync(join(root, 'a.md'), '# A');
    writeFileSync(join(root, 'b.md'), '# B');
    const { fake, calls } = makeFakeFetch({
      ok: true,
      data: {
        pulled: [],
        pushed: { accepted: 2, rejected: [] },
        serverTime: '2026-04-18T10:00:00.000Z',
      },
    });
    const result = await syncTeamMemory({
      team: 'acme/widgets',
      rootDir: root,
      apiKey: 'sk-test',
      baseUrl: 'https://example.com/api/im',
      fetchImpl: fake,
    });
    expect(result.pushed).toBe(2);
    expect(calls.length).toBe(1);
    const paths = calls[0].body.push.map((e: any) => e.path).sort();
    expect(paths).toEqual(['a.md', 'b.md']);
    // Sidecar written
    expect(existsSync(join(root, LAST_SYNC_FILE))).toBe(true);
  });

  it('pushes only changed files on second sync', async () => {
    writeFileSync(join(root, 'a.md'), '# A');
    writeFileSync(join(root, 'b.md'), '# B');
    const first = makeFakeFetch({
      ok: true,
      data: {
        pulled: [],
        pushed: { accepted: 2, rejected: [] },
        serverTime: '2026-04-18T10:00:00.000Z',
      },
    });
    await syncTeamMemory({
      team: 'acme/widgets',
      rootDir: root,
      apiKey: 'k',
      baseUrl: 'https://x/api/im',
      fetchImpl: first.fake,
    });

    // Modify only b.md
    writeFileSync(join(root, 'b.md'), '# B v2');

    const second = makeFakeFetch({
      ok: true,
      data: {
        pulled: [],
        pushed: { accepted: 1, rejected: [] },
        serverTime: '2026-04-18T10:05:00.000Z',
      },
    });
    const result = await syncTeamMemory({
      team: 'acme/widgets',
      rootDir: root,
      apiKey: 'k',
      baseUrl: 'https://x/api/im',
      fetchImpl: second.fake,
    });
    expect(result.pushed).toBe(1);
    expect(second.calls[0].body.push.length).toBe(1);
    expect(second.calls[0].body.push[0].path).toBe('b.md');
    // since param threads through
    expect(second.calls[0].body.since).toBe('2026-04-18T10:00:00.000Z');
  });

  it('skips files containing blocking secrets before POST', async () => {
    writeFileSync(join(root, 'clean.md'), '# Clean');
    writeFileSync(join(root, 'leaky.md'), '# secret\nAKIAABCDEFGHIJKLMNOP\n');
    const { fake, calls } = makeFakeFetch({
      ok: true,
      data: {
        pulled: [],
        pushed: { accepted: 1, rejected: [] },
        serverTime: '2026-04-18T10:00:00.000Z',
      },
    });
    const result = await syncTeamMemory({
      team: 'acme/widgets',
      rootDir: root,
      apiKey: 'k',
      baseUrl: 'https://x/api/im',
      fetchImpl: fake,
    });
    expect(result.skippedLocalSecrets.length).toBe(1);
    expect(result.skippedLocalSecrets[0].path).toBe('leaky.md');
    expect(result.skippedLocalSecrets[0].pattern).toBe('aws-access-key');
    // Only the clean file went over the wire
    const paths = calls[0].body.push.map((e: any) => e.path);
    expect(paths).toEqual(['clean.md']);
  });

  it('writes pulled files to disk (server wins)', async () => {
    writeFileSync(join(root, 'local.md'), '# Local');
    const serverContent = '# From server\n\nnewer content';
    const { fake } = makeFakeFetch({
      ok: true,
      data: {
        pulled: [
          {
            path: 'shared/team-doc.md',
            content: serverContent,
            contentHash: sha256(serverContent),
            memoryType: 'reference',
            description: null,
            updatedAt: '2026-04-18T10:00:00.000Z',
          },
        ],
        pushed: { accepted: 1, rejected: [] },
        serverTime: '2026-04-18T10:00:00.000Z',
      },
    });
    const result = await syncTeamMemory({
      team: 'acme/widgets',
      rootDir: root,
      apiKey: 'k',
      baseUrl: 'https://x/api/im',
      fetchImpl: fake,
    });
    expect(result.pulled).toBe(1);
    const wrote = readFileSync(join(root, 'shared', 'team-doc.md'), 'utf8');
    expect(wrote).toBe(serverContent);
  });

  it('updates last-sync.json with new serverTime and hashes', async () => {
    writeFileSync(join(root, 'a.md'), '# A');
    const serverTime = '2026-04-18T10:00:00.000Z';
    const { fake } = makeFakeFetch({
      ok: true,
      data: {
        pulled: [],
        pushed: { accepted: 1, rejected: [] },
        serverTime,
      },
    });
    await syncTeamMemory({
      team: 'acme/widgets',
      rootDir: root,
      apiKey: 'k',
      baseUrl: 'https://x/api/im',
      fetchImpl: fake,
    });
    const state = JSON.parse(readFileSync(join(root, LAST_SYNC_FILE), 'utf8'));
    expect(state.team).toBe('acme/widgets');
    expect(state.serverTime).toBe(serverTime);
    expect(state.hashes['a.md']).toBe(sha256('# A'));
  });

  it('propagates server rejections (e.g. secret_detected from server-side scan)', async () => {
    writeFileSync(join(root, 'a.md'), '# A');
    const { fake } = makeFakeFetch({
      ok: true,
      data: {
        pulled: [],
        pushed: {
          accepted: 0,
          rejected: [{ path: 'a.md', reason: 'secret_detected', detail: 'simulated' }],
        },
        serverTime: '2026-04-18T10:00:00.000Z',
      },
    });
    const result = await syncTeamMemory({
      team: 'acme/widgets',
      rootDir: root,
      apiKey: 'k',
      baseUrl: 'https://x/api/im',
      fetchImpl: fake,
    });
    expect(result.pushed).toBe(0);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0].reason).toBe('secret_detected');
  });

  it('dryRun: does not write disk files and does not update sidecar', async () => {
    writeFileSync(join(root, 'a.md'), '# A');
    const serverContent = '# server';
    const { fake } = makeFakeFetch({
      ok: true,
      data: {
        pulled: [
          {
            path: 'pulled.md',
            content: serverContent,
            contentHash: sha256(serverContent),
            memoryType: null,
            description: null,
            updatedAt: '2026-04-18T10:00:00.000Z',
          },
        ],
        pushed: { accepted: 1, rejected: [] },
        serverTime: '2026-04-18T10:00:00.000Z',
      },
    });
    await syncTeamMemory({
      team: 'acme/widgets',
      rootDir: root,
      apiKey: 'k',
      baseUrl: 'https://x/api/im',
      fetchImpl: fake,
      dryRun: true,
    });
    expect(existsSync(join(root, 'pulled.md'))).toBe(false);
    expect(existsSync(join(root, LAST_SYNC_FILE))).toBe(false);
  });

  it('throws if server returns non-2xx', async () => {
    writeFileSync(join(root, 'a.md'), '# A');
    const fake: any = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'boom',
    });
    await expect(
      syncTeamMemory({
        team: 'acme/widgets',
        rootDir: root,
        apiKey: 'k',
        baseUrl: 'https://x/api/im',
        fetchImpl: fake,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('skips oversized files locally (does not push them)', async () => {
    const big = 'x'.repeat(260 * 1024);
    writeFileSync(join(root, 'big.md'), big);
    writeFileSync(join(root, 'ok.md'), '# ok');
    const { fake, calls } = makeFakeFetch({
      ok: true,
      data: {
        pulled: [],
        pushed: { accepted: 1, rejected: [] },
        serverTime: 'x',
      },
    });
    await syncTeamMemory({
      team: 'acme/widgets',
      rootDir: root,
      apiKey: 'k',
      baseUrl: 'https://x/api/im',
      fetchImpl: fake,
    });
    const paths = calls[0].body.push.map((e: any) => e.path);
    expect(paths).toEqual(['ok.md']);
  });

  it('rejects pulled paths with traversal in the response (surfaces as rejected[])', async () => {
    writeFileSync(join(root, 'a.md'), '# A');
    const { fake } = makeFakeFetch({
      ok: true,
      data: {
        pulled: [
          {
            path: '../escape.md',
            content: 'evil',
            contentHash: sha256('evil'),
            memoryType: null,
            description: null,
            updatedAt: '2026-04-18T10:00:00.000Z',
          },
        ],
        pushed: { accepted: 0, rejected: [] },
        serverTime: '2026-04-18T10:00:00.000Z',
      },
    });
    const res = await syncTeamMemory({
      team: 'acme/widgets',
      rootDir: root,
      apiKey: 'k',
      baseUrl: 'https://x/api/im',
      fetchImpl: fake,
    });
    expect(res.rejected.some((r) => r.reason === 'write_failed')).toBe(true);
  });
});
