/**
 * Unit tests for `cloud environment ...` + `cloud warm-pool ...`
 * (eaas-gate-b Task 15 — CLI parity for the EaaS tenant surface).
 *
 * Strategy mirrors `commands-approval.test.ts`: register the Commander
 * sub-tree with a real PrismerClient (mocked fetch), then run sub-commands
 * via parseAsync. Asserts the same wire contract the SDK unit tests pin:
 * paths, methods, Idempotency-Key, If-Match bare revision, and the verbatim
 * 503 fail-through (no retry, no cold downgrade).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { PrismerClient } from '../src/index';
import { register as registerEnvironment } from '../src/commands/environment';

// ---------------------------------------------------------------------------
// Shared helpers (mirrors commands-approval.test.ts)
// ---------------------------------------------------------------------------

type FetchCall = { url: string; method: string; body?: unknown; headers: Record<string, string> };

const SAVED_ENV = {
  PRISMER_API_KEY: process.env.PRISMER_API_KEY,
  PRISMER_BASE_URL: process.env.PRISMER_BASE_URL,
};
beforeEach(() => {
  delete process.env.PRISMER_API_KEY;
  delete process.env.PRISMER_BASE_URL;
  if (SAVED_ENV.PRISMER_API_KEY !== undefined) process.env.PRISMER_API_KEY = SAVED_ENV.PRISMER_API_KEY;
  if (SAVED_ENV.PRISMER_BASE_URL !== undefined) process.env.PRISMER_BASE_URL = SAVED_ENV.PRISMER_BASE_URL;
});

function makeFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url, init);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function makeClient(fetchFn: typeof fetch): PrismerClient {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = new PrismerClient({
    apiKey: 'sk-eaas-live-testkey000000000000000000000000000000000000000000',
    baseUrl: 'https://api.test',
    fetch: fetchFn,
  });
  warnSpy.mockRestore();
  return client;
}

function okEnvelope(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data, requestId: 'req-ok' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function failEnvelope(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ success: false, error: { code, message, details: null }, requestId: 'req-fail' }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

const STATUS = {
  environmentId: 'env_testcli0000000001',
  state: 'provisioning',
  revision: 1,
  epoch: 1,
  readiness: { sandbox: false, services: false, agent: null },
  startupPath: 'cold',
  templateVersion: 'ubuntu@sha256:abc',
  expiresAt: '2026-09-10T00:00:00.000Z',
  milestones: [],
};

async function runCli(client: PrismerClient, argv: string[], apiClient = client) {
  const program = new Command();
  program.exitOverride();
  registerEnvironment(program, () => client, () => apiClient);

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

// ---------------------------------------------------------------------------
// environment lifecycle
// ---------------------------------------------------------------------------

describe('cloud environment create', () => {
  it('POSTs the create spec with Idempotency-Key and prints the projection', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(STATUS));
    const { exitCode, stdout } = await runCli(makeClient(fetchFn), [
      'environment', 'create', '--project', 'prj_abc', '--template', 'ubuntu@sha256:abc',
      '--metadata', 'team=core', '--env', 'TOKEN=sekrit', '--on-warm-miss', 'fail',
      '--idempotency-key', 'cli-fixed-key',
    ]);
    expect(exitCode).toBe(0);
    expect(calls[0].url).toBe('https://api.test/api/v1/environments');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['Idempotency-Key']).toBe('cli-fixed-key');
    expect(JSON.parse(calls[0].body as string)).toEqual({
      projectId: 'prj_abc',
      template: 'ubuntu@sha256:abc',
      metadata: { team: 'core' },
      env: { TOKEN: 'sekrit' },
      startup: { onWarmMiss: 'fail' },
    });
    expect(stdout).toContain('Environment created: env_testcli0000000001');
  });

  it('generates an Idempotency-Key when none is passed', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(STATUS));
    await runCli(makeClient(fetchFn), [
      'environment', 'create', '--project', 'prj_abc', '--template', 't',
    ]);
    expect(calls[0].headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('allows single-key create with server-inferred project/template/profile', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(STATUS));
    const { exitCode } = await runCli(makeClient(fetchFn), [
      'environment', 'create', '--idempotency-key', 'cli-single-key', '--json',
    ]);
    expect(exitCode).toBe(0);
    expect(calls[0].url).toBe('https://api.test/api/v1/environments');
    expect(calls[0].headers['Idempotency-Key']).toBe('cli-single-key');
    expect(JSON.parse(calls[0].body as string)).toEqual({});
  });

  it('surfaces the fail envelope message and exits non-zero', async () => {
    const { fetchFn } = makeFetchMock(() => failEnvelope(422, 'template_unavailable', 'unknown template t'));
    const { exitCode, stderr } = await runCli(makeClient(fetchFn), [
      'environment', 'create', '--project', 'prj_abc', '--template', 't',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('template_unavailable');
  });

  it.each(['2c4g', '4c8g', 'future-profile-v2'])('preserves explicit profile %s without inventing other fields', async (profile) => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(STATUS));
    const { exitCode } = await runCli(makeClient(fetchFn), ['environment', 'create', '--profile', profile, '--json']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(calls[0].body as string)).toEqual({ profile });
  });

  it('does not override a selected pool sizing when profile is omitted', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(STATUS));
    const { exitCode } = await runCli(makeClient(fetchFn), ['environment', 'create', '--pool', 'large', '--ttl', '600', '--json']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(calls[0].body as string)).toEqual({ poolId: 'large', ttlSeconds: 600 });
  });

  it('rejects an invalid registry ID without issuing a request', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(STATUS));
    const { exitCode, stderr } = await runCli(makeClient(fetchFn), [
      'environment', 'create', '--project', 'p', '--template', 't', '--profile', 'bad profile',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--profile must be a valid registry ID');
    expect(calls).toHaveLength(0);
  });
});

describe('cloud environment get/list', () => {
  it('get() GETs /api/v1/environments/:id', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(STATUS));
    const { exitCode, stdout } = await runCli(makeClient(fetchFn), [
      'environment', 'get', 'env_testcli0000000001',
    ]);
    expect(exitCode).toBe(0);
    expect(calls[0].url).toBe('https://api.test/api/v1/environments/env_testcli0000000001');
    expect(calls[0].method).toBe('GET');
    expect(stdout).toContain('state       provisioning');
  });

  it('get --json emits the raw envelope data', async () => {
    const { fetchFn } = makeFetchMock(() => okEnvelope(STATUS));
    const { stdout } = await runCli(makeClient(fetchFn), [
      'environment', 'get', 'env_testcli0000000001', '--json',
    ]);
    expect(JSON.parse(stdout).environmentId).toBe('env_testcli0000000001');
  });

  it('list() forwards cursor/limit query params', async () => {
    const { fetchFn, calls } = makeFetchMock(() =>
      okEnvelope({ environments: [STATUS], nextCursor: 'cursor-2' }),
    );
    const { exitCode, stdout } = await runCli(makeClient(fetchFn), [
      'environment', 'list', '--cursor', 'cursor-1', '--limit', '20',
    ]);
    expect(exitCode).toBe(0);
    expect(calls[0].url).toBe('https://api.test/api/v1/environments?cursor=cursor-1&limit=20');
    expect(stdout).toContain('env_testcli0000000001');
    expect(stdout).toContain('Next cursor: cursor-2');
  });
});

describe('cloud environment pause/wake/suspend/delete', () => {
  it('POST/DELETE the lifecycle subpaths with Idempotency-Key', async () => {
    const lifecycle = { environmentId: 'env_1', state: 'paused', epoch: 1, revision: 2, operationId: 'op_1' };
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(lifecycle));
    const client = makeClient(fetchFn);

    const paused = await runCli(client, ['environment', 'pause', 'env_1']);
    expect(paused.exitCode).toBe(0);
    expect(calls[0].url).toBe('https://api.test/api/v1/environments/env_1/pause');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);

    await runCli(client, ['environment', 'wake', 'env_1', '--idempotency-key', 'wake-key']);
    expect(calls[1].url).toBe('https://api.test/api/v1/environments/env_1/wake');
    expect(calls[1].headers['Idempotency-Key']).toBe('wake-key');

    await runCli(client, ['environment', 'suspend', 'env_1']);
    expect(calls[2].url).toBe('https://api.test/api/v1/environments/env_1/suspend');

    const deleted = await runCli(client, ['environment', 'delete', 'env_1']);
    expect(deleted.exitCode).toBe(0);
    expect(calls[3].url).toBe('https://api.test/api/v1/environments/env_1');
    expect(calls[3].method).toBe('DELETE');
    expect(deleted.stdout).toContain('Environment deleted: env_1');
  });
});

describe('cloud environment exec', () => {
  it('POSTs the command with an auto key and prints the exited view', async () => {
    const { fetchFn, calls } = makeFetchMock(() =>
      okEnvelope({
        execId: 'exec_1', status: 'exited', exitCode: 0,
        stdout: 'hello\n', stderr: '', startedAt: 't', finishedAt: 't',
      }),
    );
    const { exitCode, stdout } = await runCli(makeClient(fetchFn), [
      'environment', 'exec', 'env_1', '--timeout-ms', '5000', '--', 'sh', '-c', 'echo hello',
    ]);
    expect(exitCode).toBe(0);
    expect(calls[0].url).toBe('https://api.test/api/v1/environments/env_1/execs');
    expect(JSON.parse(calls[0].body as string)).toEqual({
      command: ['sh', '-c', 'echo hello'],
      timeoutMs: 5000,
    });
    expect(calls[0].headers['Idempotency-Key']).toBeTruthy();
    expect(stdout).toContain('Exec exec_1 exited with code 0');
    expect(stdout).toContain('hello');
  });

  it('a running handle points the operator at exec-get', async () => {
    const { fetchFn } = makeFetchMock(() =>
      okEnvelope({ execId: 'exec_9', status: 'running', command: ['sleep', '5'], startedAt: 't' }),
    );
    const { stdout } = await runCli(makeClient(fetchFn), ['environment', 'exec', 'env_1', 'sleep', '5']);
    expect(stdout).toContain('still running');
    expect(stdout).toContain('cloud environment exec-get <environmentId> exec_9');
  });

  it('exec-get GETs the handle with a cursor', async () => {
    const { fetchFn, calls } = makeFetchMock(() =>
      okEnvelope({
        execId: 'exec_1', command: ['sleep'], status: 'running', exitCode: null,
        stdout: 'partial', stderr: '', error: null, startedAt: 't', finishedAt: null, nextCursor: 7,
      }),
    );
    const { exitCode, stdout } = await runCli(makeClient(fetchFn), [
      'environment', 'exec-get', 'env_1', 'exec_1', '--cursor', '7',
    ]);
    expect(exitCode).toBe(0);
    expect(calls[0].url).toBe('https://api.test/api/v1/environments/env_1/execs/exec_1?cursor=7');
    expect(stdout).toContain('status=running');
    expect(stdout).toContain('partial');
    expect(stdout).toContain('nextCursor 7');
  });
});

// ---------------------------------------------------------------------------
// warm pool
// ---------------------------------------------------------------------------

const POOL = {
  revision: 4,
  observedRevision: 4,
  desired: {
    minReady: 1, maxReady: 2, idleRetentionSeconds: 300,
    dailyBudgetCredits: '10.000', onMiss: 'cold',
  },
  effective: { state: 'ready', ready: 1, provisioning: 0, terminating: 0 },
  cost: {
    rateVersion: 'r1', estimatedHourlyCredits: '0.050', spentTodayCredits: '0.025',
    reservedCredits: '0.000', remainingTodayCredits: '9.975',
    periodStart: '2026-09-10T00:00:00Z', periodEnd: '2026-09-11T00:00:00Z',
  },
};

/** Fetch-mock that answers GET with the current pool and PATCH with the (merged) result. */
function makePoolFetchMock() {
  return makeFetchMock((url, init) => {
    if ((init?.method ?? 'GET').toUpperCase() === 'GET') return okEnvelope(POOL);
    return okEnvelope({ ...POOL, desired: { ...POOL.desired, onMiss: 'fail' } });
  });
}

describe('cloud warm-pool get', () => {
  it('GETs /api/v1/projects/:id/warm-pool', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(POOL));
    const { exitCode, stdout } = await runCli(makeClient(fetchFn), ['warm-pool', 'get', 'prj_1']);
    expect(exitCode).toBe(0);
    expect(calls[0].url).toBe('https://api.test/api/v1/projects/prj_1/warm-pool');
    expect(stdout).toContain('state=ready');
    expect(stdout).toContain('onMiss=cold');
  });
});

describe('cloud warm-pool patch (read-merge-write)', () => {
  it('C1: merges a single flag onto the CURRENT desired policy — a partial flag list must NOT reset the rest', async () => {
    const { fetchFn, calls } = makePoolFetchMock();
    const { exitCode, stdout } = await runCli(makeClient(fetchFn), [
      'warm-pool', 'patch', 'prj_1', '--on-miss', 'fail',
    ]);
    expect(exitCode).toBe(0);
    // 1) read the current desired policy …
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('https://api.test/api/v1/projects/prj_1/warm-pool');
    // 2) … write the FULL merged policy, If-Match = the revision observed at read time.
    expect(calls[1].method).toBe('PATCH');
    // T8-(d): the server parseIfMatch only accepts a bare integer.
    expect(calls[1].headers['If-Match']).toBe('4');
    expect(calls[1].headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(calls[1].body as string)).toEqual({
      policy: {
        minReady: 1, maxReady: 2, idleRetentionSeconds: 300,
        dailyBudgetCredits: '10.000', onMiss: 'fail',
      },
    });
    expect(stdout).toContain('minReady=1');
    expect(stdout).toContain('onMiss=fail');
  });

  it('an explicit --revision is kept as the If-Match CAS pin (merge still comes from the fresh read)', async () => {
    const { fetchFn, calls } = makePoolFetchMock();
    const { exitCode } = await runCli(makeClient(fetchFn), [
      'warm-pool', 'patch', 'prj_1', '--revision', '9', '--min-ready', '2',
    ]);
    expect(exitCode).toBe(0);
    expect(calls[0].method).toBe('GET');
    expect(calls[1].headers['If-Match']).toBe('9');
    expect(JSON.parse(calls[1].body as string).policy).toEqual({
      ...POOL.desired,
      minReady: 2,
    });
  });

  it('PATCHes {policy,dryRun} with Idempotency-Key and prints the replace-semantics hint on --dry-run', async () => {
    const { fetchFn, calls } = makePoolFetchMock();
    const { exitCode, stdout } = await runCli(makeClient(fetchFn), [
      'warm-pool', 'patch', 'prj_1', '--revision', '3', '--min-ready', '1', '--max-ready', '2',
      '--idle-retention-seconds', '300', '--daily-budget-credits', '10.000',
      '--on-miss', 'fail', '--dry-run', '--idempotency-key', 'patch-key',
    ]);
    expect(exitCode).toBe(0);
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].headers['If-Match']).toBe('3');
    expect(calls[1].headers['Idempotency-Key']).toBe('patch-key');
    expect(JSON.parse(calls[1].body as string)).toEqual({
      policy: {
        minReady: 1, maxReady: 2, idleRetentionSeconds: 300,
        dailyBudgetCredits: '10.000', onMiss: 'fail',
      },
      dryRun: true,
    });
    expect(stdout).toContain('Dry run (nothing written)');
    // C1: the wire is replace-semantics — say so, and say what the CLI did about it.
    expect(stdout).toContain('REPLACES the whole policy');
    expect(stdout).toContain('a partial write through the SDK would reset them');
  });

  it('503 warm_capacity_unavailable passes through verbatim — no retry, no cold rewrite', async () => {
    const { fetchFn, calls } = makeFetchMock((url, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'GET') return okEnvelope(POOL);
      return failEnvelope(503, 'warm_capacity_unavailable', 'no warm capacity and onMiss=fail');
    });
    const { exitCode, stderr } = await runCli(makeClient(fetchFn), [
      'warm-pool', 'patch', 'prj_1', '--on-miss', 'fail',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('warm_capacity_unavailable');
    expect(stderr).toContain('onMiss=fail');
    // read + exactly one write attempt: no SDK/CLI-side retry loop,
    // and the merged body still carries onMiss=fail.
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].body as string).policy.onMiss).toBe('fail');
    expect(calls[1].headers['If-Match']).toBe('4');
  });

  it('a failing read aborts the patch before any write', async () => {
    const { fetchFn, calls } = makeFetchMock(() =>
      failEnvelope(404, 'not_owned', 'project not found'),
    );
    const { exitCode, stderr } = await runCli(makeClient(fetchFn), [
      'warm-pool', 'patch', 'prj_missing', '--on-miss', 'fail',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('not_owned');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
  });

  it('rejects a patch with no policy flags and a non-integer revision', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope(POOL));
    const noFlags = await runCli(makeClient(fetchFn), ['warm-pool', 'patch', 'prj_1', '--revision', '3']);
    expect(noFlags.exitCode).toBe(1);
    expect(noFlags.stderr).toContain('Nothing to patch');

    const badRevision = await runCli(makeClient(fetchFn), [
      'warm-pool', 'patch', 'prj_1', '--revision', '3.5', '--on-miss', 'cold',
    ]);
    expect(badRevision.exitCode).toBe(1);
    expect(badRevision.stderr).toContain('--revision must be a non-negative integer');
    // no read, no write
    expect(calls).toHaveLength(0);
  });

  it('warm-pool 404 not_owned surfaces the server code', async () => {
    const { fetchFn } = makeFetchMock(() => failEnvelope(404, 'not_owned', 'project not found'));
    const { stderr } = await runCli(makeClient(fetchFn), ['warm-pool', 'get', 'prj_missing']);
    expect(stderr).toContain('not_owned');
  });
});

describe('cloud environment Gate B message/run/session commands', () => {
  it('wires message-send, run-get/cancel/events, and session management to the new EaaS paths', async () => {
    const { fetchFn, calls } = makeFetchMock((url) => {
      if (url.endsWith('/runs/run_1')) {
        return okEnvelope({
          runId: 'run_1',
          status: 'running',
          recoveryState: 'none',
          message: { conversationId: 'conv_1', messageId: 'msg_1' },
          artifactRefs: [],
          durability: { terminal: false, artifactsConfirmed: false },
          usage: { promptTokens: 1, completionTokens: 2 },
          createdAt: '2026-09-09T00:00:00.000Z',
          startedAt: '2026-09-09T00:00:01.000Z',
          completedAt: null,
        });
      }
      if (url.endsWith('/runs/run_1/cancel')) return okEnvelope({ runId: 'run_1', status: 'canceled' });
      if (url.includes('/runs/run_1/events')) {
        return okEnvelope({ events: [{ id: 'evt_1', type: 'run.started', at: '2026-09-09T00:00:01.000Z', message: 'started', payload: null }], nextCursor: null, truncated: false });
      }
      if (url.endsWith('/sessions/eps_1/revoke')) return okEnvelope({ id: 'eps_1', revokedAt: '2026-09-09T00:00:02.000Z' });
      if (url.includes('/sessions?')) {
        return okEnvelope({ sessions: [{ id: 'eps_1', principalId: 'prn_1', projectId: 'prj_1', environmentId: 'env_1', provider: 'identity', scopes: [], expiresAt: '2026-09-10T00:00:00.000Z', revokedAt: null, createdAt: '2026-09-09T00:00:00.000Z' }] });
      }
      return okEnvelope({ conversationId: 'conv_1', messageId: 'msg_1', runId: 'run_1', deduplicated: false });
    });
    const client = makeClient(fetchFn);

    await runCli(client, ['environment', 'message-send', 'env_1', 'conv_1', 'hello', '--idempotency-key', 'msg-key']);
    await runCli(client, ['environment', 'run-get', 'env_1', 'run_1']);
    await runCli(client, ['environment', 'run-cancel', 'env_1', 'run_1']);
    await runCli(client, ['environment', 'run-events', 'env_1', 'run_1', '--limit', '20']);
    await runCli(client, ['environment', 'session-list', 'env_1', '--limit', '10']);
    await runCli(client, ['environment', 'session-revoke', 'env_1', 'eps_1']);

    expect(calls[0].url).toBe('https://api.test/api/v1/environments/env_1/conversations/conv_1/messages');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['Idempotency-Key']).toBe('msg-key');
    expect(JSON.parse(calls[0].body as string)).toEqual({ content: 'hello' });
    expect(calls[1].url).toBe('https://api.test/api/v1/environments/env_1/runs/run_1');
    expect(calls[2].url).toBe('https://api.test/api/v1/environments/env_1/runs/run_1/cancel');
    expect(calls[3].url).toBe('https://api.test/api/v1/environments/env_1/runs/run_1/events?limit=20');
    expect(calls[4].url).toBe('https://api.test/api/v1/environments/env_1/sessions?limit=10');
    expect(calls[5].url).toBe('https://api.test/api/v1/environments/env_1/sessions/eps_1/revoke');
  });
});



describe('cloud environment project-key access', () => {
  it('reads context with the configured project key', async () => {
    const { fetchFn, calls } = makeFetchMock(() => okEnvelope({ project: { id: 'p' } }));
    const im = makeClient((async () => { throw new Error('Must not use IM credentials'); }) as typeof fetch);
    const result = await runCli(im, ['environment', 'context', '--json'], makeClient(fetchFn));
    expect(JSON.parse(result.stdout)).toEqual({ project: { id: 'p' } });
    expect(calls[0].url).toBe('https://api.test/api/v1/context');
    expect(calls[0].headers.Authorization).toContain('Bearer sk-eaas-');
  });

  it('issues, pages and revokes delegated sessions without leaking tokens by default', async () => {
    const { fetchFn, calls } = makeFetchMock((url, init) => {
      if (url.endsWith('/revoke')) return okEnvelope({ id: 's', revokedAt: 'now' });
      if (init?.method === 'POST') return okEnvelope({ sessionId: 's', token: 'ps-eaas-secret', expiresAt: 'later' });
      return okEnvelope({ sessions: [{ id: 's' }], nextCursor: 'next' });
    });
    const client = makeClient(fetchFn);
    const args = ['environment', 'access-session', 'issue', 'env/a', '--subject', 'user-42', '--scope', 'exec:read', '--ttl', '600', '--idempotency-key', 'issue-1', '--json'];
    const issued = await runCli(client, args);
    expect(JSON.parse(issued.stdout).token).toBeUndefined();
    expect(issued.stdout + issued.stderr).not.toContain('ps-eaas-secret');
    const revealed = await runCli(client, [...args, '--show-token']);
    expect(JSON.parse(revealed.stdout).token).toBe('ps-eaas-secret');
    expect(revealed.stderr).toContain('Sensitive');
    expect(calls[0].url).toBe('https://api.test/api/v1/environments/env%2Fa/access-sessions');
    expect(calls[0].headers['Idempotency-Key']).toBe('issue-1');
    expect(JSON.parse(calls[0].body as string)).toEqual({ subject: 'user-42', scopes: ['exec:read'], ttlSeconds: 600 });
    const listed = await runCli(client, ['environment', 'access-session', 'list', 'env/a', '--limit', '1', '--cursor', 'page/+2', '--json']);
    expect(JSON.parse(listed.stdout).nextCursor).toBe('next');
    expect(calls[2].url).toBe('https://api.test/api/v1/environments/env%2Fa/access-sessions?limit=1&cursor=page%2F%2B2');
    await runCli(client, ['environment', 'access-session', 'revoke', 'env/a', 's/1', '--json']);
    expect(calls[3].url).toBe('https://api.test/api/v1/environments/env%2Fa/access-sessions/s%2F1/revoke');
  });
});

describe('cloud environment billing command', () => {
  it('reads the project billing projection path', async () => {
    const { fetchFn, calls } = makeFetchMock(() =>
      okEnvelope({
        items: [
          {
            usageId: '1',
            settlementKey: 'eaas:usage:1:v1',
            status: 'settled',
            intervalStart: '2026-09-11T00:00:00.000Z',
            dimension: 'warm_compute',
            seconds: 60,
            credits: '0.001000',
            rateVersion: 'v1',
            resourceId: 'win_1',
          },
        ],
        nextCursor: null,
        totals: { credits: '0.001000', warmCredits: '0.001000', activeCredits: '0.000000' },
        settlement: { mode: 'usage_source_id', status: 'credit_ledger_joined' },
      }),
    );
    await runCli(makeClient(fetchFn), ['environment', 'billing', 'prj_1', '--from', '2026-09-11T00:00:00.000Z', '--limit', '5']);
    expect(calls[0].url).toBe('https://api.test/api/v1/projects/prj_1/billing?from=2026-09-11T00%3A00%3A00.000Z&limit=5');
  });
});

describe('cloud publishable-key commands', () => {
  it('list/create/revoke use the project publishable-key management paths', async () => {
    const { fetchFn, calls } = makeFetchMock((url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') return okEnvelope({ keys: [] });
      if (url.endsWith('/revoke')) return okEnvelope({ id: 'eak_1', revokedAt: '2026-09-09T00:00:00.000Z', version: 2 });
      return okEnvelope({ id: 'eak_1', key: 'pk-eaas-full-once', keyPrefix: 'pk-eaas', name: 'browser', version: 1, scopes: ['env:exec'] });
    });
    const client = makeClient(fetchFn);

    await runCli(client, ['publishable-key', 'list', 'prj_1', '--limit', '5']);
    const created = await runCli(client, ['publishable-key', 'create', 'prj_1', '--name', 'browser', '--scope', 'env:exec']);
    await runCli(client, ['publishable-key', 'revoke', 'prj_1', 'eak_1']);

    expect(calls[0].url).toBe('https://api.test/api/v1/projects/prj_1/publishable-keys?limit=5');
    expect(calls[1].url).toBe('https://api.test/api/v1/projects/prj_1/publishable-keys');
    expect(JSON.parse(calls[1].body as string)).toEqual({ name: 'browser', scopes: ['env:exec'] });
    expect(calls[2].url).toBe('https://api.test/api/v1/projects/prj_1/publishable-keys/eak_1/revoke');
    expect(created.stdout).toContain('copy now');
  });
});
