/**
 * Unit tests for `cloud asset (list|get|by-hash|upload|download|read|sync)`.
 *
 * Strategy: register the asset Commander sub-tree against a real PrismerClient
 * whose `fetch` is mocked, then drive each sub-command via `commander.parseAsync`.
 *
 * This covers C2 of the v2.0 joint review (asset CLI coverage). The SDK-level
 * upload pipeline is already exercised by `tests/unit/assets-upload.test.ts`
 * — these tests focus on the *CLI* contract: argv parsing, --json behavior,
 * error exits, Range header threading for `read`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PrismerClient } from '../src/index';
import { register as registerAsset } from '../src/commands/asset';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchCall = { url: string; method: string; headers?: Record<string, string>; body?: unknown };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function bytesResponse(bytes: Uint8Array, status = 200, headers?: Record<string, string>): Response {
  return new Response(bytes, { status, headers: { 'Content-Type': 'text/plain', ...(headers ?? {}) } });
}

function makeFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetchFn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) h.forEach((v, k) => { headers[k] = v; });
      else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
      else Object.assign(headers, h as Record<string, string>);
    }
    calls.push({ url, method, headers, body: init?.body });
    return handler(url, init);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function makeClient(fetchFn: typeof fetch): PrismerClient {
  return new PrismerClient({
    apiKey: 'sk-prismer-live-testkey00000000000000000000000000000000000000000000000000',
    baseUrl: 'https://api.test',
    fetch: fetchFn,
  });
}

/**
 * Run `cloud asset <verb> [args]`. Wraps Commander's parseAsync + traps
 * `process.exit` so failing CLI verbs surface as a thrown Error.
 */
async function runAssetCli(
  client: PrismerClient,
  argv: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const program = new Command();
  program.exitOverride(); // throw CommanderError instead of process.exit on parse errors
  registerAsset(program, () => client, () => client);

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  process.stdout.write = ((s: string | Uint8Array) => {
    stdoutChunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    stderrChunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;

  let exitCode = 0;
  const origExit = process.exit;
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`__exit_${exitCode}`); }) as typeof process.exit;

  try {
    await program.parseAsync(['node', 'cloud', 'asset', ...argv]);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('__exit_')) {
      // captured exit — exitCode already set
    } else {
      throw err;
    }
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  }
  return { exitCode, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

// ---------------------------------------------------------------------------
// asset list
// ---------------------------------------------------------------------------

describe('cloud asset list', () => {
  it('returns rows from /api/im/assets and renders --json', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url.startsWith('https://api.test/api/im/assets')) {
        return jsonResponse({
          ok: true,
          data: [
            { id: 'a-1', workspaceId: 'ws-1', contentHash: 'hash1', mime: 'text/plain', kind: 'file', sizeBytes: 11, createdAt: '2026-05-01T00:00:00Z' },
          ],
        });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);

    const res = await runAssetCli(client, ['list', '--workspace-id', 'ws-1', '--json']);
    expect(res.exitCode).toBe(0);
    expect(calls[0]?.url).toContain('/api/im/assets');
    expect(calls[0]?.url).toContain('workspaceId=ws-1');
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].id).toBe('a-1');
  });

  it('exits non-zero when --workspace-id is missing and env is unset', async () => {
    delete process.env.PRISMER_WORKSPACE_ID;
    const { fetchFn } = makeFetchMock(() => jsonResponse({ ok: true, data: [] }));
    const client = makeClient(fetchFn);
    const res = await runAssetCli(client, ['list']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('--workspace-id is required');
  });

  it('exits non-zero on cloud error', async () => {
    const { fetchFn } = makeFetchMock(() => jsonResponse({ ok: false, error: { code: 'forbidden', message: 'nope' } }, 403));
    const client = makeClient(fetchFn);
    const res = await runAssetCli(client, ['list', '--workspace-id', 'ws-1']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toLowerCase()).toContain('nope');
  });
});

// ---------------------------------------------------------------------------
// asset get
// ---------------------------------------------------------------------------

describe('cloud asset get', () => {
  it('fetches /api/im/assets/:id/detail and renders --json', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url === 'https://api.test/api/im/assets/a-1/detail') {
        return jsonResponse({
          ok: true,
          data: {
            id: 'a-1', workspaceId: 'ws-1', contentHash: 'hash1', mime: 'text/plain',
            kind: 'file', sizeBytes: 11, storageUri: 's3://b/a-1', createdAt: '2026-05-01T00:00:00Z',
          },
        });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);
    const res = await runAssetCli(client, ['get', 'a-1', '--json']);
    expect(res.exitCode).toBe(0);
    expect(calls[0]?.url).toBe('https://api.test/api/im/assets/a-1/detail');
    const parsed = JSON.parse(res.stdout);
    expect(parsed.data.id).toBe('a-1');
  });

  it('exits non-zero on 404', async () => {
    const { fetchFn } = makeFetchMock(() => jsonResponse({ ok: false, error: { code: 'not_found', message: 'gone' } }, 404));
    const client = makeClient(fetchFn);
    const res = await runAssetCli(client, ['get', 'a-1']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toLowerCase()).toContain('gone');
  });
});

// ---------------------------------------------------------------------------
// asset by-hash
// ---------------------------------------------------------------------------

describe('cloud asset by-hash', () => {
  it('GETs /api/im/assets/by-hash/:hash with wsId param', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url.startsWith('https://api.test/api/im/assets/by-hash/')) {
        return jsonResponse({
          ok: true,
          data: { id: 'a-1', contentHash: 'abc123', mime: 'text/plain', kind: 'file', sizeBytes: 11 },
        });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);
    const res = await runAssetCli(client, ['by-hash', 'abc123', '--workspace-id', 'ws-1', '--json']);
    expect(res.exitCode).toBe(0);
    expect(calls[0]?.url).toContain('/api/im/assets/by-hash/abc123');
    expect(calls[0]?.url).toContain('wsId=ws-1');
  });
});

// ---------------------------------------------------------------------------
// asset upload
// ---------------------------------------------------------------------------

describe('cloud asset upload', () => {
  let tmpFile: string;
  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `prismer-asset-upload-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'hello upload');
  });
  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it('falls through direct-upload init → POST /api/im/assets and reports success', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url === 'https://api.test/api/im/assets/direct-upload/init') {
        // Force the client to fall back to multipart POST /api/im/assets
        return jsonResponse({ ok: false, error: { code: 'asset_direct_upload_unavailable', message: 'local fs' } }, 503);
      }
      if (url === 'https://api.test/api/im/assets') {
        return jsonResponse({
          ok: true,
          data: { id: 'asset-up', workspaceId: 'ws-1', contentHash: 'h', mime: 'text/plain', kind: 'user-upload', sizeBytes: 12 },
        }, 201);
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);
    const res = await runAssetCli(client, ['upload', tmpFile, '--workspace-id', 'ws-1', '--json']);
    expect(res.exitCode).toBe(0);
    // Both the init probe and the multipart POST should have happened.
    expect(calls.map((c) => c.url)).toContain('https://api.test/api/im/assets');
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.id).toBe('asset-up');
  });

  it('exits non-zero when file is missing', async () => {
    const { fetchFn } = makeFetchMock(() => jsonResponse({ ok: true, data: {} }));
    const client = makeClient(fetchFn);
    const res = await runAssetCli(client, ['upload', '/nope/does-not-exist', '--workspace-id', 'ws-1']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('file not found');
  });
});

// ---------------------------------------------------------------------------
// asset download
// ---------------------------------------------------------------------------

describe('cloud asset download', () => {
  it('writes bytes to --out and emits a summary line on stderr', async () => {
    const payload = new TextEncoder().encode('binary-stream');
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url === 'https://api.test/api/im/assets/a-1') {
        return bytesResponse(payload, 200, { 'content-length': String(payload.byteLength) });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);
    const outFile = path.join(os.tmpdir(), `prismer-asset-dl-${Date.now()}.bin`);
    try {
      const res = await runAssetCli(client, ['download', 'a-1', '--out', outFile]);
      expect(res.exitCode).toBe(0);
      expect(calls[0]?.url).toBe('https://api.test/api/im/assets/a-1');
      expect(calls[0]?.method).toBe('GET');
      // Auth header was forwarded
      expect(calls[0]?.headers?.['Authorization']).toMatch(/^Bearer /);
      const bytes = fs.readFileSync(outFile);
      expect(bytes.equals(Buffer.from(payload))).toBe(true);
      expect(res.stderr).toContain('Downloaded a-1');
    } finally {
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    }
  });
});

// ---------------------------------------------------------------------------
// asset read (Range header)
// ---------------------------------------------------------------------------

describe('cloud asset read', () => {
  it('threads --offset/--length into a Range header', async () => {
    const detail = {
      id: 'a-text', workspaceId: 'ws-1', contentHash: 'h-text', mime: 'text/plain',
      kind: 'file', sizeBytes: 26, storageUri: 's3://b/a-text', createdAt: '2026-05-01T00:00:00Z',
    };
    const fullText = 'abcdefghijklmnopqrstuvwxyz';
    const { fetchFn, calls } = makeFetchMock((url, init) => {
      if (url === 'https://api.test/api/im/assets/a-text/detail') {
        return jsonResponse({ ok: true, data: detail });
      }
      if (url === 'https://api.test/api/im/assets/a-text') {
        const range = (init?.headers as Record<string, string> | undefined)?.['Range'];
        // Echo back the requested slice (or all if no Range).
        if (range) {
          const m = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (m) {
            const start = Number(m[1]);
            const end = m[2] ? Number(m[2]) + 1 : fullText.length;
            const slice = fullText.slice(start, end);
            return new Response(slice, {
              status: 206,
              headers: {
                'Content-Type': 'text/plain',
                'Content-Range': `bytes ${start}-${end - 1}/${fullText.length}`,
              },
            });
          }
        }
        return new Response(fullText, { status: 200, headers: { 'Content-Type': 'text/plain', 'content-length': String(fullText.length) } });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);
    const res = await runAssetCli(client, ['read', 'a-text', '--offset', '5', '--length', '10']);
    expect(res.exitCode).toBe(0);
    // 2 fetches: detail + the ranged GET.
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.test/api/im/assets/a-text/detail',
      'https://api.test/api/im/assets/a-text',
    ]);
    expect(calls[1]?.headers?.['Range']).toBe('bytes=5-14');
    expect(res.stdout).toContain('fghijklmno'); // 5..15 of fullText
    expect(res.stderr).toMatch(/asset=a-text/);
    expect(res.stderr).toMatch(/range=5\.\.15/);
  });

  it('refuses to read a non-text mime without --force', async () => {
    const detail = {
      id: 'a-bin', workspaceId: 'ws-1', contentHash: 'h', mime: 'application/octet-stream',
      kind: 'file', sizeBytes: 4, storageUri: 's3://b/a-bin', createdAt: '2026-05-01T00:00:00Z',
    };
    const { fetchFn } = makeFetchMock((url) => {
      if (url === 'https://api.test/api/im/assets/a-bin/detail') return jsonResponse({ ok: true, data: detail });
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);
    const res = await runAssetCli(client, ['read', 'a-bin']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('Refusing to read non-text asset');
  });
});

// ---------------------------------------------------------------------------
// asset sync
// ---------------------------------------------------------------------------

describe('cloud asset sync', () => {
  it('re-lists the workspace and prints a count', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url.startsWith('https://api.test/api/im/assets')) {
        return jsonResponse({
          ok: true,
          data: [
            { id: 'a-1', contentHash: 'h1', mime: 'text/plain', kind: 'file', sizeBytes: 1 },
            { id: 'a-2', contentHash: 'h2', mime: 'text/plain', kind: 'file', sizeBytes: 2 },
          ],
        });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);
    const res = await runAssetCli(client, ['sync', '--workspace-id', 'ws-1', '--json']);
    expect(res.exitCode).toBe(0);
    expect(calls[0]?.url).toContain('/api/im/assets');
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.count).toBe(2);
  });
});
