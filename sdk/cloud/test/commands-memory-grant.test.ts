/**
 * Unit tests for `cloud memory-grant ...` (memory211/05 W3 Task 5 — CLI
 * diagnostics for the cross-workspace memory grant ledger).
 *
 * Strategy mirrors `commands-environment.test.ts`: register the Commander
 * sub-tree with a real PrismerClient (mocked fetch), run sub-commands via
 * parseAsync, and pin the wire contract (paths/methods/bodies) plus the human
 * vs `--json` output faces and the verbatim `<code>: <message>` fail-through.
 */

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { PrismerClient, type IMMemoryGrant } from '../src/index';
import { register as registerMemoryGrant } from '../src/commands/memory-grant';

type FetchCall = { url: string; method: string; body?: unknown };

function makeFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body });
    return handler(url, init);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function makeClient(fetchFn: typeof fetch): PrismerClient {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = new PrismerClient({
    apiKey: 'sk-prismer-live-testkey0000000000000000000000000000000000000000',
    baseUrl: 'https://api.test',
    fetch: fetchFn,
  });
  warnSpy.mockRestore();
  return client;
}

function okEnvelope(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
}

function failEnvelope(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), { status });
}

const GRANT: IMMemoryGrant = {
  id: 'mgr_01CLI',
  sourceWorkspaceId: 'ws_src',
  targetWorkspaceId: 'ws_tgt',
  subjectAgentId: null,
  selectorJson: null,
  status: 'active',
  grantedByImUserId: 'usr_owner',
  approvalId: 'apr_9',
  expiresAt: '2026-10-10T00:00:00.000Z',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
};

async function runCli(client: PrismerClient, argv: string[]) {
  const program = new Command();
  program.exitOverride();
  registerMemoryGrant(program, () => client, () => client);

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
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit_${exitCode}`);
  }) as typeof process.exit;

  try {
    await program.parseAsync(['node', 'cloud', ...argv]);
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith('__exit_'))) throw err;
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  }
  return { exitCode, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

describe('cloud memory-grant create', () => {
  it('posts to /api/im/memory/grants and renders the human face', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(GRANT));
    const { exitCode, stdout } = await runCli(makeClient(fetchFn), [
      'memory-grant', 'create', '--target', 'ws_tgt', '--expires-in-days', '14', '--workspace', 'ws_src',
    ]);

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/im/memory/grants');
    expect(url.searchParams.get('workspaceId')).toBe('ws_src');
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ targetWorkspaceId: 'ws_tgt', expiresInDays: 14 });
    expect(stdout).toContain('Grant created: mgr_01CLI');
    expect(stdout).toContain('ws_src -> ws_tgt');
    expect(stdout).toContain('active');
    expect(stdout).toContain('approval  apr_9');
  });

  it('rejects a bad --expires-in-days with zero requests', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(GRANT));
    const { exitCode, stderr } = await runCli(makeClient(fetchFn), [
      'memory-grant', 'create', '--target', 'ws_tgt', '--expires-in-days', '400',
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('--expires-in-days');
    expect(calls).toHaveLength(0);
  });

  it('prints the structured error verbatim and exits 1', async () => {
    const { fetchFn, calls } = makeFetchMock(() => failEnvelope(409, 'MEMORY_GRANT_PAIR_RACE', 'pair raced'));
    const { exitCode, stderr } = await runCli(makeClient(fetchFn), ['memory-grant', 'create', '--target', 'ws_tgt']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('MEMORY_GRANT_PAIR_RACE: pair raced');
    expect(calls).toHaveLength(1);
  });
});

describe('cloud memory-grant list / incoming', () => {
  it('list renders the table face; --json emits the raw envelope data', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope([GRANT]));
    const client = makeClient(fetchFn);

    const human = await runCli(client, ['memory-grant', 'list', '--workspace', 'ws_src']);
    expect(human.exitCode).toBe(0);
    expect(new URL(calls[0]!.url).searchParams.get('workspaceId')).toBe('ws_src');
    expect(human.stdout).toContain('ID');
    expect(human.stdout).toContain('mgr_01CLI');
    expect(human.stdout).toContain('ws_src');

    const json = await runCli(client, ['memory-grant', 'list', '--json']);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual([GRANT]);
  });

  it('incoming hits the incoming view and prints the empty-state line', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope([]));
    const { exitCode, stdout } = await runCli(makeClient(fetchFn), ['memory-grant', 'incoming']);

    expect(exitCode).toBe(0);
    expect(new URL(calls[0]!.url).pathname).toBe('/api/im/memory/grants/incoming');
    expect(stdout).toContain('No incoming grants.');
  });
});

describe('cloud memory-grant external recall', () => {
  it('search posts through the grant recall endpoint and renders hit provenance', async () => {
    const { fetchFn, calls } = makeFetchMock(() =>
      okEnvelope({
        sourceWorkspaceId: 'ws_src',
        grantId: 'mgr_01CLI',
        resultsByQuery: [],
        results: [
          {
            pageId: 'page_1',
            sourceWorkspaceId: 'ws_src',
            path: 'INDEX.pkf',
            title: 'Index',
            pageType: 'index',
            visibility: 'workspace',
            stale: false,
            tier: 'grant',
            via: 'grant:mgr_01CLI',
            lane: 'fts',
            inboundLinkCount: 0,
            version: 1,
            hubPath: null,
            childrenCount: 0,
            outboundPreview: [],
            updatedAt: '2026-09-10T00:00:00.000Z',
            snippet: 'OAuth migration decision',
            score: 0.91,
            components: { matchScore: 0.91, linkBoost: 0, recencyDecay: 1, stalePenalty: 0, validityTerm: 1 },
          },
        ],
        took_ms: 3,
      }),
    );
    const { exitCode, stdout } = await runCli(makeClient(fetchFn), [
      'memory-grant',
      'search',
      '--source',
      'ws_src',
      '--query',
      'OAuth migration',
      '--workspace',
      'ws_tgt',
      '--limit',
      '5',
    ]);

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/im/memory/external/search');
    expect(url.searchParams.get('workspaceId')).toBe('ws_tgt');
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      sourceWorkspaceId: 'ws_src',
      queries: ['OAuth migration'],
      limit: 5,
    });
    expect(stdout).toContain('grant:mgr_01CLI');
    expect(stdout).toContain('INDEX.pkf');
  });

  it('load posts source/path and emits JSON when requested', async () => {
    const loaded = {
      sourceWorkspaceId: 'ws_src',
      grantId: 'mgr_01CLI',
      tier: 'grant',
      via: 'grant:mgr_01CLI',
      page: {
        pageId: 'page_1',
        sourceWorkspaceId: 'ws_src',
        path: 'INDEX.pkf',
        title: 'Index',
        description: null,
        pageType: 'index',
        visibility: 'workspace',
        stale: false,
        version: 1,
        createdAt: '2026-09-10T00:00:00.000Z',
        updatedAt: '2026-09-10T00:00:00.000Z',
        content: '# Index',
        contentHtml: null,
        tier: 'grant',
        via: 'grant:mgr_01CLI',
      },
    };
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(loaded));
    const { exitCode, stdout } = await runCli(makeClient(fetchFn), [
      'memory-grant',
      'load',
      '--source',
      'ws_src',
      '--path',
      'INDEX.pkf',
      '--format',
      'both',
      '--json',
    ]);

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/im/memory/external/load');
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      sourceWorkspaceId: 'ws_src',
      path: 'INDEX.pkf',
      format: 'both',
    });
    expect(JSON.parse(stdout)).toEqual(loaded);
  });
});

describe('cloud memory-grant revoke', () => {
  it('deletes by id and renders the revoked projection', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope({ ...GRANT, status: 'revoked' }));
    const { exitCode, stdout } = await runCli(makeClient(fetchFn), ['memory-grant', 'revoke', 'mgr_01CLI', '--json']);

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(new URL(calls[0]!.url).pathname).toBe('/api/im/memory/grants/mgr_01CLI');
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe('revoked');
  });

  it('passes a 404 grant-not-found through verbatim', async () => {
    const { fetchFn } = makeFetchMock(() => failEnvelope(404, 'MEMORY_GRANT_NOT_FOUND', 'grant not found'));
    const { exitCode, stderr } = await runCli(makeClient(fetchFn), ['memory-grant', 'revoke', 'mgr_missing']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('MEMORY_GRANT_NOT_FOUND: grant not found');
  });
});
