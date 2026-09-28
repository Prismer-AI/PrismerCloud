/**
 * `cloud task test-feedback` — apc/05 §1 C2 (whole-run rollup → cockpit).
 *
 * Consumer this exists to feed: `src/im/services/insights-cockpit.service.ts`
 * (`getAcceptanceFeedback`) reads `im_task_logs` rows with
 * `action='test_result_feedback'` and requires `metadata.status ∈
 * {'passed','failed','env_blocked'}`, `metadata.tiers[]` items each carrying a
 * string `.tier`, and `metadata.failureCount: number`.
 *
 * Strategy:
 *  1. Pure-function tests for `mapTestRunReportToFeedback` — no I/O, so the
 *     mapping rule (the load-bearing part) is directly assertable. Covers all
 *     three `status` outcomes + the `tiers` shape.
 *  2. One Commander-driven end-to-end test (same harness as
 *     commands-task.test.ts) proving the CLI wires the mapping into a real
 *     `POST /tasks/:id/event` body.
 */

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismerClient } from '../src/index';
import { register as registerTask, mapTestRunReportToFeedback, type ApcTestRunReport } from '../src/commands/task';

// ---------------------------------------------------------------------------
// 1. Pure mapping function
// ---------------------------------------------------------------------------

describe('mapTestRunReportToFeedback — status mapping', () => {
  it('exitCode=0, envStatus=ok → passed', () => {
    const report: ApcTestRunReport = {
      envStatus: 'ok',
      exitCode: 0,
      tiers: [{ tier: 'T0', passed: 12, failed: 0, skipped: 0, total: 12 }],
      regressions: [],
    };
    const payload = mapTestRunReportToFeedback(report);
    expect(payload.status).toBe('passed');
    expect(payload.failureCount).toBe(0);
  });

  it('exitCode=1, envStatus=ok → failed', () => {
    const report: ApcTestRunReport = {
      envStatus: 'ok',
      exitCode: 1,
      tiers: [{ tier: 'T0', passed: 10, failed: 2, skipped: 0, total: 12 }],
      regressions: ['some.test.ts :: broke'],
    };
    const payload = mapTestRunReportToFeedback(report);
    expect(payload.status).toBe('failed');
    expect(payload.failureCount).toBe(2);
    expect(payload.regressions).toEqual(['some.test.ts :: broke']);
  });

  it('exitCode=78 (or envStatus=env_blocked) → env_blocked, NEVER failed', () => {
    const byExitCode: ApcTestRunReport = { envStatus: 'ok', exitCode: 78, tiers: [] };
    const byEnvStatus: ApcTestRunReport = { envStatus: 'env_blocked', exitCode: 1, tiers: [] };
    expect(mapTestRunReportToFeedback(byExitCode).status).toBe('env_blocked');
    expect(mapTestRunReportToFeedback(byEnvStatus).status).toBe('env_blocked');
  });

  it('carries a well-formed tiers[] shape ({tier,passed,failed,skipped,total})', () => {
    const report: ApcTestRunReport = {
      envStatus: 'ok',
      exitCode: 1,
      tiers: [
        { tier: 'T0', passed: 12, failed: 0, skipped: 1, total: 13, extraneous: 'ignored' },
        { tier: 'T1', passed: 5, failed: 3, skipped: 0, total: 8 },
      ],
    };
    const payload = mapTestRunReportToFeedback(report);
    expect(payload.tiers).toEqual([
      { tier: 'T0', passed: 12, failed: 0, skipped: 1, total: 13 },
      { tier: 'T1', passed: 5, failed: 3, skipped: 0, total: 8 },
    ]);
    // failureCount = sum of every tier's `failed`
    expect(payload.failureCount).toBe(3);
  });

  it('missing tiers[] → empty tiers + failureCount 0 (never throws)', () => {
    const payload = mapTestRunReportToFeedback({ exitCode: 0 });
    expect(payload.tiers).toEqual([]);
    expect(payload.failureCount).toBe(0);
    expect(payload.regressions).toEqual([]);
  });

  it('passes exitCode through verbatim on the payload', () => {
    expect(mapTestRunReportToFeedback({ exitCode: 1, tiers: [] }).exitCode).toBe(1);
    expect(mapTestRunReportToFeedback({ exitCode: 78, tiers: [] }).exitCode).toBe(78);
  });
});

// ---------------------------------------------------------------------------
// 2. CLI end-to-end (Commander harness, same pattern as commands-task.test.ts)
// ---------------------------------------------------------------------------

type FetchCall = { url: string; method: string; body?: unknown };

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
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body });
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

async function runTaskCli(client: PrismerClient, argv: string[]) {
  const program = new Command();
  program.exitOverride();
  registerTask(program, () => client, () => client);

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  process.stdout.write = ((s: string | Uint8Array) => { stdoutChunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8')); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => { stderrChunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8')); return true; }) as typeof process.stderr.write;

  let exitCode = 0;
  const origExit = process.exit;
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`__exit_${exitCode}`); }) as typeof process.exit;

  try {
    await program.parseAsync(['node', 'cloud', 'task', ...argv]);
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith('__exit_'))) throw err;
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  }
  return { exitCode, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

describe('cloud task test-feedback — CLI wiring', () => {
  it('reads a TierResult file, maps it, and POSTs /tasks/:id/event with matching payload', async () => {
    const tmpFile = path.join(os.tmpdir(), `apc-test-report-${Date.now()}.json`);
    const report: ApcTestRunReport = {
      schema: 'test203.run/v1',
      envStatus: 'ok',
      exitCode: 1,
      tiers: [
        { tier: 'T0', passed: 20, failed: 0, skipped: 0, total: 20 },
        { tier: 'T1', passed: 6, failed: 2, skipped: 0, total: 8 },
      ],
      regressions: ['foo.test.ts :: bar'],
      fixed: [],
    } as unknown as ApcTestRunReport;
    await fs.writeFile(tmpFile, JSON.stringify(report));

    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url === 'https://api.test/api/im/tasks/t-1/event') {
        return jsonResponse({ ok: true, data: { taskId: 't-1', action: 'test_result_feedback' } });
      }
      return jsonResponse({ ok: false, error: { code: 'x', message: url } }, 500);
    });
    const client = makeClient(fetchFn);

    try {
      const res = await runTaskCli(client, ['test-feedback', 't-1', tmpFile, '--json']);
      expect(res.exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe('https://api.test/api/im/tasks/t-1/event');
      expect(calls[0]?.method).toBe('POST');

      const body = JSON.parse(String(calls[0]?.body));
      expect(body.code).toBe('TEST_RESULT_FEEDBACK');
      expect(body.payload.status).toBe('failed');
      expect(body.payload.failureCount).toBe(2);
      expect(body.payload.tiers).toEqual([
        { tier: 'T0', passed: 20, failed: 0, skipped: 0, total: 20 },
        { tier: 'T1', passed: 6, failed: 2, skipped: 0, total: 8 },
      ]);
      expect(body.payload.regressions).toEqual(['foo.test.ts :: bar']);
    } finally {
      await fs.rm(tmpFile, { force: true });
    }
  });

  it('exit 4 when the server rejects a non-assignee caller', async () => {
    const tmpFile = path.join(os.tmpdir(), `apc-test-report-${Date.now()}-forbidden.json`);
    await fs.writeFile(tmpFile, JSON.stringify({ exitCode: 0, tiers: [] }));
    const { fetchFn } = makeFetchMock(() =>
      jsonResponse({ ok: false, error: { code: 'TASK_ACCESS_DENIED', message: 'only the task assignee can post task events' } }, 403),
    );
    const client = makeClient(fetchFn);
    try {
      const res = await runTaskCli(client, ['test-feedback', 't-1', tmpFile]);
      expect(res.exitCode).toBe(4);
    } finally {
      await fs.rm(tmpFile, { force: true });
    }
  });
});
