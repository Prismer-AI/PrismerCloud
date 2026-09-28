/**
 * B-P1d — `cloud metric events` / `cloud metric turns` and the MetricsClient
 * methods behind them.
 *
 * Strategy: same Commander + mocked-fetch pattern as `commands-task.test.ts`,
 * so each case exercises the real URL assembly (`RequestFn` → query string)
 * and the real response parsing — no mock of the client itself.
 *
 * The `turns` summary field names are a FROZEN contract pinned here against
 * src/im/services/metric-turns.service.ts (TurnMetricsSummary).
 */

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { PrismerClient } from '../src/index';
import { register as registerMetric } from '../src/commands/metric';

// ---------------------------------------------------------------------------
// Helpers (mirrors commands-task.test.ts)
// ---------------------------------------------------------------------------

type FetchCall = { url: string; method: string };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetchFn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
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

async function runMetricCli(
  client: PrismerClient,
  argv: string[],
): Promise<{ out: string; err: string; exitCode: number }> {
  const program = new Command();
  program.exitOverride();
  registerMetric(program, () => client, () => client);

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
    await program.parseAsync(['node', 'cloud', 'metric', ...argv]);
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith('__exit_'))) throw err;
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  }
  return { out: stdoutChunks.join(''), err: stderrChunks.join(''), exitCode };
}

const SUMMARY = {
  turnCount: 12,
  turnCountByStatus: { ok: 10, error: 2 },
  avgTokensPerTurn: { input: 812.4, output: 233.1, cacheRead: null, cacheWrite: 12.5 },
  cacheHitRatio: 0.31,
  p95FirstEventMs: 412,
  avgDurationMs: 3120.5,
  toolCallsPerTurn: 1.43,
  models: [{ model: 'gpt-x', turns: 8 }, { model: 'claude-y', turns: 4 }],
};

// ---------------------------------------------------------------------------
// MetricsClient URL assembly
// ---------------------------------------------------------------------------

describe('MetricsClient.events / turnSummary (B-P1d)', () => {
  it('events() assembles namespace/name/limit plus the filter csv', async () => {
    const { fetchFn, calls } = makeFetchMock(() =>
      jsonResponse({
        ok: true,
        data: {
          namespace: 'turn',
          name: 'count',
          range: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
          events: [
            {
              id: '42',
              ts: '2026-09-01T12:00:00.000Z',
              valueNumeric: 1,
              valueString: null,
              dims: { workspaceId: 'ws1', agentId: 'ag1' },
              source: 'daemon',
              sourceId: 'im-user-7',
            },
          ],
        },
      }),
    );
    const res = await makeClient(fetchFn).im.metrics.events({
      namespace: 'turn',
      name: 'count',
      filter: { workspaceId: 'ws1', agentId: 'ag1' },
      range: '24h',
      limit: 25,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/im/metrics/events');
    expect(url.searchParams.get('namespace')).toBe('turn');
    expect(url.searchParams.get('name')).toBe('count');
    expect(url.searchParams.get('range')).toBe('24h');
    expect(url.searchParams.get('limit')).toBe('25');
    // csv order follows Object.entries; assert as a set to stay order-agnostic
    expect(new Set((url.searchParams.get('filter') ?? '').split(','))).toEqual(
      new Set(['workspaceId:ws1', 'agentId:ag1']),
    );
    // response parses into the typed row shape
    expect(res.ok).toBe(true);
    expect(res.data?.events[0].id).toBe('42');
    expect(res.data?.events[0].valueNumeric).toBe(1);
    expect(res.data?.events[0].dims).toEqual({ workspaceId: 'ws1', agentId: 'ag1' });
    expect(res.data?.events[0].sourceId).toBe('im-user-7');
  });

  it('turnSummary() sends scope/id/workspaceId as plain query params and parses the frozen contract', async () => {
    const { fetchFn, calls } = makeFetchMock(() => jsonResponse({ ok: true, data: SUMMARY }));
    const res = await makeClient(fetchFn).im.metrics.turnSummary({
      scope: 'conversation',
      id: 'cnv_123',
      workspaceId: 'ws1',
      range: '7d',
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/im/metrics/turns');
    expect(url.searchParams.get('scope')).toBe('conversation');
    expect(url.searchParams.get('id')).toBe('cnv_123');
    expect(url.searchParams.get('workspaceId')).toBe('ws1');
    expect(url.searchParams.get('range')).toBe('7d');
    expect(url.searchParams.get('filter')).toBeNull();

    // frozen contract field names, verbatim
    const data = res.data!;
    expect(Object.keys(data).sort()).toEqual(
      [
        'avgDurationMs',
        'avgTokensPerTurn',
        'cacheHitRatio',
        'models',
        'p95FirstEventMs',
        'toolCallsPerTurn',
        'turnCount',
        'turnCountByStatus',
      ].sort(),
    );
    expect(data.turnCountByStatus).toEqual({ ok: 10, error: 2 });
    expect(data.avgTokensPerTurn).toEqual({
      input: 812.4,
      output: 233.1,
      cacheRead: null,
      cacheWrite: 12.5,
    });
    expect(data.models).toEqual([{ model: 'gpt-x', turns: 8 }, { model: 'claude-y', turns: 4 }]);
  });

  it('turnSummary() omits the window params when only the default 24h is wanted', async () => {
    const { fetchFn, calls } = makeFetchMock(() => jsonResponse({ ok: true, data: SUMMARY }));
    await makeClient(fetchFn).im.metrics.turnSummary({ scope: 'agent', id: 'ag_9', workspaceId: 'ws1' });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('range')).toBeNull();
    expect(url.searchParams.get('from')).toBeNull();
    expect(url.searchParams.get('to')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe('cloud metric events', () => {
  it('renders rows in human form and honours --json', async () => {
    const handler = () =>
      jsonResponse({
        ok: true,
        data: {
          namespace: 'turn',
          name: 'count',
          range: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
          events: [
            {
              id: '7',
              ts: '2026-09-01T12:00:00.000Z',
              valueNumeric: 1,
              valueString: null,
              dims: { workspaceId: 'ws1', model: 'gpt-x' },
              source: 'daemon',
              sourceId: null,
            },
          ],
        },
      });

    const humanMock = makeFetchMock(handler);
    const human = await runMetricCli(makeClient(humanMock.fetchFn), [
      'events',
      'turn.count',
      '--filter',
      'workspaceId:ws1',
      '--range',
      '24h',
    ]);
    expect(human.exitCode).toBe(0);
    expect(human.out).toContain('turn.count [2026-09-01T00:00:00.000Z → 2026-09-02T00:00:00.000Z]');
    expect(human.out).toContain('2026-09-01T12:00:00.000Z');
    expect(human.out).toContain('daemon');
    expect(human.out).toContain('model=gpt-x');

    const { fetchFn } = makeFetchMock(handler);
    const json = await runMetricCli(makeClient(fetchFn), [
      'events',
      'turn.count',
      '--filter',
      'workspaceId:ws1',
      '--json',
    ]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.out).data.events[0].id).toBe('7');
  });

  it('refuses to run without workspaceId in the filter', async () => {
    const { fetchFn, calls } = makeFetchMock(() => jsonResponse({ ok: true, data: {} }));
    const r = await runMetricCli(makeClient(fetchFn), ['events', 'turn.count', '--filter', 'agentId:ag1']);
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain('workspaceId');
    expect(calls).toHaveLength(0);
  });

  it('surfaces the server error message and exits nonzero', async () => {
    const { fetchFn } = makeFetchMock(() =>
      jsonResponse({ ok: false, error: { code: 'WORKSPACE_REQUIRED', message: 'filter must include workspaceId' } }),
    );
    const r = await runMetricCli(makeClient(fetchFn), [
      'events',
      'turn.count',
      '--filter',
      'workspaceId:ws1',
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain('filter must include workspaceId');
  });
});

describe('cloud metric turns', () => {
  it('renders the summary as kv lines, ∅ for nulls', async () => {
    const { fetchFn, calls } = makeFetchMock(() => jsonResponse({ ok: true, data: SUMMARY }));
    const r = await runMetricCli(makeClient(fetchFn), [
      'turns',
      '--scope',
      'task',
      '--id',
      'task_5',
      '--filter',
      'workspaceId:ws1',
      '--range',
      '7d',
    ]);

    expect(r.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/im/metrics/turns');
    expect(url.searchParams.get('scope')).toBe('task');
    expect(url.searchParams.get('id')).toBe('task_5');
    expect(url.searchParams.get('workspaceId')).toBe('ws1');
    expect(url.searchParams.get('range')).toBe('7d');

    expect(r.out).toContain('turn summary scope=task id=task_5 range=7d');
    expect(r.out).toContain('turns');
    expect(r.out).toContain('12');
    expect(r.out).toContain('ok=10 error=2');
    expect(r.out).toContain('cacheRead=∅');
    expect(r.out).toContain('gpt-x=8');
  });

  it('rejects an unknown --scope and extra --filter keys without calling the wire', async () => {
    const { fetchFn, calls } = makeFetchMock(() => jsonResponse({ ok: true, data: SUMMARY }));

    const badScope = await runMetricCli(makeClient(fetchFn), [
      'turns',
      '--scope',
      'workspace',
      '--id',
      'x',
      '--filter',
      'workspaceId:ws1',
    ]);
    expect(badScope.exitCode).toBe(1);
    expect(badScope.err).toContain('conversation|task|agent');

    const extraFilter = await runMetricCli(makeClient(fetchFn), [
      'turns',
      '--scope',
      'task',
      '--id',
      'task_5',
      '--filter',
      'workspaceId:ws1,agentId:ag1',
    ]);
    expect(extraFilter.exitCode).toBe(1);
    expect(extraFilter.err).toContain('only accepts workspaceId');

    expect(calls).toHaveLength(0);
  });

  it('refuses to run without workspaceId', async () => {
    const { fetchFn, calls } = makeFetchMock(() => jsonResponse({ ok: true, data: SUMMARY }));
    const r = await runMetricCli(makeClient(fetchFn), [
      'turns',
      '--scope',
      'agent',
      '--id',
      'ag_1',
      '--filter',
      '',
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain('workspaceId');
    expect(calls).toHaveLength(0);
  });
});
