import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAssetCommand } from '../src/cli/commands/asset.js';
import { resolvePaths, saveConfig } from '../src/config.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'prismer-asset-test-'));
}

function mkResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('asset command', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of cleanup.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('builds list/get/by-hash commands', () => {
    const cmd = buildAssetCommand();
    expect(cmd.commands.map((c) => c.name())).toEqual(['sync', 'list', 'upload', 'download', 'get', 'by-hash']);
  });

  it('sync --bytes mirrors remote asset indexes and prefetches bytes into the local cache', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    saveConfig(
      { api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'daemon-1' },
      resolvePaths(home),
    );
    const bytes = 'remote asset bytes';
    const hash = createHash('sha256').update(bytes).digest('hex');
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        if (url.startsWith('http://cloud.test/api/im/assets/index')) {
          return mkResponse({
            ok: true,
            data: {
              items: [
                {
                  id: 'asset-1',
                  contentHash: hash,
                  filename: 'remote.txt',
                  folderPath: null,
                  mime: 'text/plain',
                  kind: 'file',
                  sizeBytes: bytes.length,
                  description: null,
                  assetIndexSeq: 1,
                },
              ],
              cursor: 1,
            },
          });
        }
        if (url.startsWith('http://cloud.test/api/im/workspaces/ws-1/files/sync')) {
          return mkResponse({
            ok: true,
            data: {
              items: [
                {
                  id: 'wf-1',
                  workspaceId: 'ws-1',
                  path: 'remote.txt',
                  assetId: 'asset-1',
                  contentHash: hash,
                  version: 1,
                  parentVersionId: null,
                  modifierImUserId: 'usr-1',
                  createdAt: '2026-05-13T00:00:00.000Z',
                  updatedAt: '2026-05-13T00:00:00.000Z',
                  deletedAt: null,
                },
              ],
              cursor: '2026-05-13T00:00:00.000Z',
            },
          });
        }
        if (url === 'http://cloud.test/api/im/assets/asset-1') {
          return new Response(bytes, { status: 200, headers: { 'Content-Type': 'text/plain' } });
        }
        return mkResponse({ ok: false, error: { message: `unexpected ${url}` } }, 500);
      }) as unknown as typeof fetch,
    );

    await buildAssetCommand().parseAsync(['sync', '--workspace-id', 'ws-1', '--bytes', '--json'], {
      from: 'user',
    });

    expect(calls.map((c) => c.url)).toContain('http://cloud.test/api/im/assets/asset-1');
    expect(readFileSync(join(home, 'cache', hash.slice(0, 2), hash), 'utf8')).toBe(bytes);
  });

  it('list builds workspace/task query and prints json', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    saveConfig(
      { api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'daemon-1' },
      resolvePaths(home),
    );

    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
        return mkResponse({
          ok: true,
          data: [
            {
              id: 'asset-1',
              workspaceId: 'ws-1',
              taskId: 'task-9',
              mimeType: 'text/plain',
              size: 12,
              meta: { kind: 'sandbox-output' },
            },
          ],
          nextCursor: null,
        });
      }) as unknown as typeof fetch,
    );

    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      await buildAssetCommand().parseAsync(['list', '--workspace-id', 'ws-1', '--task-id', 'task-9', '--json'], {
        from: 'user',
      });
    } finally {
      spy.mockRestore();
    }

    expect(calls).toEqual([
      { url: 'http://cloud.test/api/im/assets?workspaceId=ws-1&taskId=task-9', method: 'GET' },
    ]);
    expect(out.join('')).toContain('"workspaceId": "ws-1"');
    expect(out.join('')).toContain('"nextCursor": null');
  });

  it('get encodes the asset id and prints human output', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    saveConfig(
      { api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'daemon-1' },
      resolvePaths(home),
    );

    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
        return mkResponse({
          ok: true,
          data: {
            id: 'asset/1',
            workspaceId: 'ws-1',
            taskId: 'task-9',
            mimeType: 'application/pdf',
            size: 99,
            s3Url: 'https://s3.example/asset/1',
          },
        });
      }) as unknown as typeof fetch,
    );

    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      await buildAssetCommand().parseAsync(['get', 'asset/1'], { from: 'user' });
    } finally {
      spy.mockRestore();
    }

    expect(calls[0]?.url).toBe('http://cloud.test/api/im/assets/asset%2F1/detail');
    expect(out.join('')).toContain('Asset asset/1');
    expect(out.join('')).toContain('workspace: ws-1');
  });

  it('by-hash forwards wsId query when present', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    saveConfig(
      { api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'daemon-1' },
      resolvePaths(home),
    );

    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
        return mkResponse({
          ok: true,
          data: { id: 'asset-2', contentHash: 'a'.repeat(64), workspaceId: 'ws-2' },
        });
      }) as unknown as typeof fetch,
    );

    await buildAssetCommand().parseAsync(['by-hash', 'a'.repeat(64), '--workspace-id', 'ws-2', '--json'], {
      from: 'user',
    });

    expect(calls[0]?.url).toBe(`http://cloud.test/api/im/assets/by-hash/${'a'.repeat(64)}?wsId=ws-2`);
  });

  it('upload sends multipart form data with sandbox metadata', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    saveConfig(
      { api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'daemon-1' },
      resolvePaths(home),
    );
    const file = join(home, 'result.txt');
    writeFileSync(file, 'hello');

    const calls: Array<{ url: string; method: string; auth?: string; hash?: string; body?: FormData }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        const url = input.toString();
        if (url.endsWith('/api/im/assets/direct-upload/init')) {
          calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), auth: headers.Authorization });
          return mkResponse({ ok: false, error: { code: 'asset_direct_upload_unavailable', message: 'local fs' } }, 503);
        }
        calls.push({
          url,
          method: (init?.method ?? 'GET').toUpperCase(),
          auth: headers.Authorization,
          hash: headers['X-Content-Sha256'],
          body: init?.body as FormData,
        });
        return mkResponse({ ok: true, data: { id: 'asset-up', workspaceId: 'ws-1', kind: 'sandbox-output' } }, 201);
      }) as unknown as typeof fetch,
    );

    await buildAssetCommand().parseAsync([
      'upload',
      file,
      '--workspace-id',
      'ws-1',
      '--kind',
      'sandbox-output',
      '--task-id',
      'task-1',
      '--container-id',
      'sb-1',
      '--json',
    ], { from: 'user' });

    expect(calls.map((call) => call.url)).toEqual([
      'http://cloud.test/api/im/assets/direct-upload/init',
      'http://cloud.test/api/im/assets',
    ]);
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.auth).toBe('Bearer sk-test');
    expect(calls[1]?.hash).toBe(createHash('sha256').update('hello').digest('hex'));
    expect(calls[1]?.body?.get('workspaceId')).toBe('ws-1');
    expect(calls[1]?.body?.get('kind')).toBe('sandbox-output');
    expect(calls[1]?.body?.get('sourceTaskId')).toBe('task-1');
    expect(calls[1]?.body?.get('contentSha256')).toBe(createHash('sha256').update('hello').digest('hex'));
    expect(JSON.parse(String(calls[1]?.body?.get('metadata')))).toEqual({ taskId: 'task-1', containerId: 'sb-1' });
  });

  it('upload uses direct upload when the cloud returns a signed PUT plan', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    saveConfig(
      { api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'daemon-1' },
      resolvePaths(home),
    );
    const file = join(home, 'direct.txt');
    writeFileSync(file, 'direct');
    const hash = createHash('sha256').update('direct').digest('hex');
    const calls: Array<{ url: string; method: string; body?: BodyInit | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body as BodyInit | null });
        if (url.endsWith('/api/im/assets/direct-upload/init')) {
          return mkResponse({
            ok: true,
            data: {
              mode: 'single',
              bucket: 'bucket',
              key: `assets/${hash}`,
              uploadUrl: 'http://s3.test/direct',
              method: 'PUT',
              headers: { 'Content-Type': 'text/plain' },
            },
          });
        }
        if (url === 'http://s3.test/direct') {
          return new Response('', { status: 200 });
        }
        if (url.endsWith('/api/im/assets/direct-upload/complete')) {
          return mkResponse({ ok: true, data: { id: 'asset-direct', workspaceId: 'ws-1', contentHash: hash } }, 201);
        }
        return mkResponse({ ok: false, error: { message: `unexpected ${url}` } }, 500);
      }) as unknown as typeof fetch,
    );

    await buildAssetCommand().parseAsync([
      'upload',
      file,
      '--workspace-id',
      'ws-1',
      '--kind',
      'file',
      '--mime',
      'text/plain',
      '--json',
    ], { from: 'user' });

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', 'http://cloud.test/api/im/assets/direct-upload/init'],
      ['PUT', 'http://s3.test/direct'],
      ['POST', 'http://cloud.test/api/im/assets/direct-upload/complete'],
    ]);
    const initBody = JSON.parse(String(calls[0]?.body));
    expect(initBody).toMatchObject({ workspaceId: 'ws-1', filename: 'direct.txt', contentHash: hash });
    const completeBody = JSON.parse(String(calls[2]?.body));
    expect(completeBody).toMatchObject({
      workspaceId: 'ws-1',
      filename: 'direct.txt',
      contentHash: hash,
      bucket: 'bucket',
      key: `assets/${hash}`,
    });
  });

  it('upload recursively sends directory files with folderPath', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    saveConfig(
      { api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'daemon-1' },
      resolvePaths(home),
    );
    const root = join(home, 'upload-root');
    mkdirSync(join(root, 'docs', 'nested'), { recursive: true });
    writeFileSync(join(root, 'root.txt'), 'root');
    writeFileSync(join(root, 'docs', 'nested', 'note.md'), '# note');

    const calls: Array<{ url: string; body?: FormData }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.endsWith('/api/im/assets/direct-upload/init')) {
          calls.push({ url });
          return mkResponse({ ok: false, error: { code: 'asset_direct_upload_unavailable', message: 'local fs' } }, 503);
        }
        calls.push({ url, body: init?.body as FormData });
        return mkResponse({
          ok: true,
          data: { id: `asset-${calls.length}`, contentHash: `hash-${calls.length}`, workspaceId: 'ws-1' },
        }, 201);
      }) as unknown as typeof fetch,
    );

    await buildAssetCommand().parseAsync([
      'upload',
      root,
      '--workspace-id',
      'ws-1',
      '--folder-path',
      'local-import',
      '--json',
    ], { from: 'user' });

    const multipartCalls = calls.filter((call) => call.url === 'http://cloud.test/api/im/assets');
    expect(multipartCalls).toHaveLength(2);
    const folderPaths = multipartCalls.map((call) => call.body?.get('folderPath')).sort();
    expect(folderPaths).toEqual(['local-import', 'local-import/docs/nested']);
  });

  it('download writes asset bytes to disk', async () => {
    const home = tmpHome();
    cleanup.push(home);
    vi.stubEnv('PRISMER_HOME', home);
    saveConfig(
      { api_key: 'sk-test', cloud_api_base: 'http://cloud.test', daemon_id: 'daemon-1' },
      resolvePaths(home),
    );
    const out = join(home, 'download.bin');
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: input.toString(), method: (init?.method ?? 'GET').toUpperCase() });
        return new Response('bytes', { status: 200 });
      }) as unknown as typeof fetch,
    );

    await buildAssetCommand().parseAsync(['download', 'asset/1', '--out', out], { from: 'user' });

    expect(calls[0]?.url).toBe('http://cloud.test/api/im/assets/asset%2F1');
    expect(readFileSync(out, 'utf8')).toBe('bytes');
  });
});
