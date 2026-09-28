// @ts-nocheck -- exercises shipped zero-dependency .mjs harness modules directly.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HarnessError,
  loadHarnessConfig,
  taskIdempotencyKey,
} from '../catalog/skills/role-builder/scripts/operation-harness.mjs';
import { runRoleWorkflow } from '../catalog/skills/role-builder/scripts/instantiate-and-run.mjs';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function response(data, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(code, message, status) {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('role-builder operation harness', () => {
  it('negative control: rejects secret flags locally with zero network calls', () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    expect(() => loadHarnessConfig(['--api-key', 'secret'])).toThrowError(HarnessError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['--api-key', '--token', '--jwt', '--secret', '--password'])(
    'negative control: redacts %s=value credentials from diagnostics',
    (option) => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;
      const sentinel = 'must-never-appear';
      let caught;
      try {
        loadHarnessConfig([`${option}=${sentinel}`]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(HarnessError);
      expect(String(caught?.message)).not.toContain(sentinel);
      expect(caught).toMatchObject({ code: 'SECRET_ARGUMENT_FORBIDDEN' });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('negative control: blocks an unconfirmed remote mutation before fetch', () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    expect(() =>
      loadHarnessConfig([], {
        PRISMER_API_KEY: 'secret-from-env',
        PRISMER_CLOUD_BASE: 'https://example.invalid',
        PRISMER_ROLE_SLUG: 'legal-expert',
        PRISMER_WORKSPACE_ID: 'ws-1',
        PRISMER_TASK: 'review contract',
      }),
    ).toThrowError(/remote mutation is blocked/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('negative control: a CLI flag cannot self-authorize remote mutation', () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    expect(() =>
      loadHarnessConfig(['--allow-remote'], {
        PRISMER_API_KEY: 'secret-from-env',
        PRISMER_CLOUD_BASE: 'https://example.invalid',
        PRISMER_ROLE_SLUG: 'legal-expert',
        PRISMER_WORKSPACE_ID: 'ws-1',
        PRISMER_TASK: 'review contract',
      }),
    ).toThrowError(/unknown argument/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creates a fresh run identity unless the trusted environment supplies one', () => {
    const env = {
      PRISMER_API_KEY: 'secret-from-env',
      PRISMER_ROLE_SLUG: 'legal-expert',
      PRISMER_WORKSPACE_ID: 'ws-1',
      PRISMER_TASK: 'review contract',
    };
    const first = loadHarnessConfig([], env);
    const second = loadHarnessConfig([], env);
    expect(first.requestId).not.toBe(second.requestId);
    expect(loadHarnessConfig([], { ...env, PRISMER_REQUEST_ID: first.requestId }).requestId).toBe(first.requestId);
  });

  it('derives a bounded task key even from the longest accepted instance request id', () => {
    const requestId = 'r'.repeat(191);
    expect(taskIdempotencyKey(requestId)).toHaveLength(74);
  });

  it('preflights before mutation, uses idempotency, and never writes credentials to the ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'role-harness-'));
    const ledger = join(dir, 'ledger.json');
    const config = loadHarnessConfig(['--no-wait', '--json'], {
      PRISMER_API_KEY: 'secret-from-env',
      PRISMER_CLOUD_BASE: 'http://127.0.0.1:3000',
      PRISMER_ROLE_SLUG: 'legal-expert',
      PRISMER_WORKSPACE_ID: 'ws-1',
      PRISMER_TASK: 'review contract',
      PRISMER_OPERATION_LEDGER: ledger,
    });
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(errorResponse('ROLE_INSTANCE_NOT_FOUND', 'not found', 404))
      .mockResolvedValueOnce(response({ ok: true, runtime: { daemonId: 'd-1' } }))
      .mockResolvedValueOnce(
        response(
          {
            status: 'ready',
            stage: 'ready',
            agent: { id: 'agent-1', profileId: 'profile-1' },
            execution: { state: 'ready' },
          },
          201,
        ),
      )
      .mockResolvedValueOnce(response({ id: 'task-1', status: 'assigned' }, 201));
    globalThis.fetch = fetchSpy;

    const result = await runRoleWorkflow(config);

    expect(result.stage).toBe('dispatched');
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(fetchSpy.mock.calls[0][0]).toContain(`/instances/${config.requestId}`);
    expect(fetchSpy.mock.calls[1][0]).toContain('/instances/preflight');
    expect(fetchSpy.mock.calls[2][0]).toMatch(/\/instances$/);
    expect(fetchSpy.mock.calls[3][0]).toContain('/api/im/tasks');
    const taskInit = fetchSpy.mock.calls[3][1];
    const taskBody = JSON.parse(taskInit.body);
    expect(taskBody.idempotencyKey).toBe(taskIdempotencyKey(config.requestId));
    expect(taskInit.headers['x-idempotency-key']).toBe(taskIdempotencyKey(config.requestId));
    expect(taskBody.idempotencyKey.length).toBeLessThanOrEqual(191);
    expect(readFileSync(ledger, 'utf8')).not.toContain('secret-from-env');
  });

  it('recovers a ready durable instance without re-running current-state preflight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'role-harness-replay-'));
    const config = loadHarnessConfig(['--no-wait', '--json'], {
      PRISMER_API_KEY: 'secret-from-env',
      PRISMER_CLOUD_BASE: 'http://127.0.0.1:3000',
      PRISMER_ROLE_SLUG: 'legal-expert',
      PRISMER_WORKSPACE_ID: 'ws-1',
      PRISMER_TASK: 'review contract',
      PRISMER_OPERATION_LEDGER: join(dir, 'ledger.json'),
    });
    const ready = {
      status: 'ready',
      stage: 'ready',
      agent: { id: 'agent-1', profileId: 'profile-1' },
      execution: { state: 'ready' },
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(response(ready))
      .mockResolvedValueOnce(response({ id: 'task-1', status: 'assigned' }, 201));
    globalThis.fetch = fetchSpy;

    const result = await runRoleWorkflow(config);

    expect(result.stage).toBe('dispatched');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/instances/preflight'))).toBe(false);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).match(/\/instances$/))).toBe(false);
  });

  it('negative control: refuses to reuse a ledger path for changed workflow input before fetch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'role-harness-ledger-conflict-'));
    const ledger = join(dir, 'ledger.json');
    writeFileSync(
      ledger,
      JSON.stringify({ requestId: 'request-1', role: 'other-role', workspaceId: 'ws-1', invocationHash: 'old' }),
    );
    const config = loadHarnessConfig(['--no-wait'], {
      PRISMER_API_KEY: 'secret-from-env',
      PRISMER_CLOUD_BASE: 'http://127.0.0.1:3000',
      PRISMER_ROLE_SLUG: 'legal-expert',
      PRISMER_WORKSPACE_ID: 'ws-1',
      PRISMER_TASK: 'review contract',
      PRISMER_REQUEST_ID: 'request-1',
      PRISMER_OPERATION_LEDGER: ledger,
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    await expect(runRoleWorkflow(config)).rejects.toMatchObject({ code: 'OPERATION_LEDGER_CONFLICT' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('negative control: a binding on the wrong daemon never creates a task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'role-harness-wrong-daemon-'));
    const config = loadHarnessConfig(['--no-wait'], {
      PRISMER_API_KEY: 'secret-from-env',
      PRISMER_CLOUD_BASE: 'http://127.0.0.1:3000',
      PRISMER_ROLE_SLUG: 'legal-expert',
      PRISMER_WORKSPACE_ID: 'ws-1',
      PRISMER_TASK: 'review contract',
      PRISMER_OPERATION_LEDGER: join(dir, 'ledger.json'),
    });
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      response({
        status: 'ready',
        agent: { id: 'agent-1' },
        execution: { state: 'wrong_daemon', targetDaemonId: 'daemon-1', boundDaemonId: 'daemon-2' },
      }),
    );
    globalThis.fetch = fetchSpy;

    await expect(runRoleWorkflow(config)).rejects.toMatchObject({ code: 'ROLE_INSTANCE_WRONG_DAEMON' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/api/im/tasks'))).toBe(false);
  });
});
