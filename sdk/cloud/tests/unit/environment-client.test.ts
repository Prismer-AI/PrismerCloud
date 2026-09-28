/**
 * Unit tests for the EaaS clients (`client.environments`, `client.projects.warmPool`).
 *
 * Mocks fetch via vi.fn() and asserts request paths / methods / headers
 * (Authorization Bearer, Idempotency-Key, If-Match) plus envelope parsing.
 * Pins the fail-through contract: a 503 `warm_capacity_unavailable` is
 * surfaced verbatim — no retry, no automatic cold downgrade.
 *
 * Usage:
 *   cd sdk/cloud && npx vitest run tests/unit/environment-client.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrismerClient } from '../../src/index';
import type {
  EnvironmentStatus,
  EaasApiEnvelope,
  EaasUsagePage,
  WarmPoolStatus,
} from '../../src/environment-contract';

const SAVED_ENV = {
  PRISMER_API_KEY: process.env.PRISMER_API_KEY,
  PRISMER_BASE_URL: process.env.PRISMER_BASE_URL,
};
beforeEach(() => {
  delete process.env.PRISMER_API_KEY;
  delete process.env.PRISMER_BASE_URL;
});
afterEach(() => {
  if (SAVED_ENV.PRISMER_API_KEY !== undefined) process.env.PRISMER_API_KEY = SAVED_ENV.PRISMER_API_KEY;
  if (SAVED_ENV.PRISMER_BASE_URL !== undefined) process.env.PRISMER_BASE_URL = SAVED_ENV.PRISMER_BASE_URL;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okEnvelope(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.resolve({ success: true, data, requestId: 'req-ok' }),
    text: () => Promise.resolve(JSON.stringify({ success: true, data, requestId: 'req-ok' })),
  } as unknown as Response;
}

function failEnvelope(status: number, code: string, message: string, details: unknown = null): Response {
  const body = { success: false, error: { code, message, details }, requestId: 'req-fail' };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function rawBytesResponse(bytes: Uint8Array, sha256: string, hashHeader = 'x-eaas-file-sha256'): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ [hashHeader]: sha256 }),
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    json: () => Promise.reject(new Error('not json')),
  } as unknown as Response;
}

/** Non-JSON / empty error body — FF-off bare 404, gateway HTML error pages. */
function emptyBodyResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
  } as unknown as Response;
}

function makeClient(fetchMock: typeof fetch): PrismerClient {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = new PrismerClient({
    apiKey: 'sk-eaas-live-testtoken',
    baseUrl: 'https://eaas.example.com',
    fetch: fetchMock,
  });
  warnSpy.mockRestore();
  return client;
}

function statusPreset(over: Partial<EnvironmentStatus> = {}): EnvironmentStatus {
  return {
    environmentId: 'env_testenvstatus000001',
    state: 'provisioning',
    revision: 1,
    epoch: 1,
    readiness: { sandbox: false, services: false, agent: null },
    startupPath: 'cold',
    templateVersion: 'ubuntu@sha256:abc',
    expiresAt: '2026-09-09T00:00:00.000Z',
    milestones: [],
    ...over,
  };
}

function headersOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, string> {
  return (fetchMock.mock.calls[call][1] as RequestInit).headers as Record<string, string>;
}

function urlOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): string {
  return fetchMock.mock.calls[call][0] as string;
}

// ---------------------------------------------------------------------------
// EnvironmentsClient — paths / methods / headers
// ---------------------------------------------------------------------------

describe('EaaS machine key memory API', () => {
  it('writes through the source environment without accepting a caller workspace', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope({ acked: ['one'], conflicts: [] }));
    const client = makeClient(fetchMock);
    await client.eaasMemories.write({ path: 'a.md', content: 'source A' }, {
      environmentId: 'env/a', idempotencyKey: 'from-a',
    });
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/environments/env%2Fa/memories');
    expect(headersOf(fetchMock)['Idempotency-Key']).toBe('from-a');
  });
  it.each(['sk-eaas-', 'pk-eaas-', 'ps-eaas-'])('recognizes the %s credential family', (prefix) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      new PrismerClient({ apiKey: `${prefix}test-token`, baseUrl: 'https://eaas.example.com' });
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
  it('uses tenant endpoints and keeps the machine bearer and write idempotency key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope({ workspaceId: 'west_a', acked: ['one'], conflicts: [] }));
    const client = makeClient(fetchMock);
    await client.eaasMemories.write({ path: 'notes/a.md', content: 'hello' }, { idempotencyKey: 'memory-one' });
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/memories');
    expect(headersOf(fetchMock)['Authorization']).toBe('Bearer sk-eaas-live-testtoken');
    expect(headersOf(fetchMock)['Idempotency-Key']).toBe('memory-one');
    await client.eaasMemories.search({ query: 'hello world', limit: 3 });
    const url = new URL(urlOf(fetchMock, 1));
    expect(url.searchParams.get('q')).toBe('hello world');
    expect(url.searchParams.get('limit')).toBe('3');
  });
  it('grants and revokes recall through the environment-scoped route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope({ status: 'active' }));
    const client = makeClient(fetchMock);
    await client.eaasMemories.grantEnvironment('env/a');
    await client.eaasMemories.revokeEnvironment('env/a');
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/environments/env%2Fa/memories/grants');
    expect(fetchMock.mock.calls.map((call) => call[1].method)).toEqual(['POST', 'DELETE']);
  });
});

describe('client.environments — write surface idempotency headers', () => {
  it('creates a fresh conversation without changing ensure semantics', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope({ conversationId: 'c' }));
    const client = makeClient(fetchMock);
    await client.environments.createConversation('env/a');
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/environments/env%2Fa/conversations');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ newConversation: true });
  });
  it('create() POSTs /api/v1/environments with an auto-generated Idempotency-Key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(statusPreset()));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.environments.create({
      projectId: 'prj_abc',
      template: 'ubuntu@sha256:abc',
      profile: '2c4g',
    });
    expect(res.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/environments');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-eaas-live-testtoken');
    expect(headers['Idempotency-Key']).toBeTruthy();
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ projectId: 'prj_abc', template: 'ubuntu@sha256:abc', profile: '2c4g' });
  });

  it('create({}) lets the server infer project/template/profile defaults', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(statusPreset()));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.environments.create({});
    expect(res.success).toBe(true);
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/environments');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({});
    expect(headersOf(fetchMock)['Idempotency-Key']).toBeTruthy();
  });

  it('issueAccessSession() POSTs an environment-bound delegated session with Idempotency-Key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({
        token: 'ps-eaas-session',
        sessionId: 'psess_1',
        environmentId: 'env/a',
        subject: 'end-user-42',
        principalId: 'prn_1',
        expiresAt: '2026-09-24T00:00:00.000Z',
        effectiveScopes: ['exec:read'],
        effectiveBudget: {
          periodStart: '2026-09-24T00:00:00.000Z',
          periodEnd: '2026-09-25T00:00:00.000Z',
          limitCredits: null,
          spentCredits: '0.000000',
          remainingCredits: null,
        },
      }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.environments.issueAccessSession(
      'env/a',
      { subject: 'end-user-42', scopes: ['exec:read'], ttlSeconds: 600 },
      { idempotencyKey: 'delegate-key-1' },
    );
    expect(res.success).toBe(true);
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/environments/env%2Fa/access-sessions');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
      subject: 'end-user-42',
      scopes: ['exec:read'],
      ttlSeconds: 600,
    });
    expect(headersOf(fetchMock)['Authorization']).toBe('Bearer sk-eaas-live-testtoken');
    expect(headersOf(fetchMock)['Idempotency-Key']).toBe('delegate-key-1');
  });

  it('listAccessSessions() and revokeAccessSession() use project-key delegated management endpoints', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okEnvelope({ sessions: [{ id: 'psess_1', provider: 'delegated' }] }))
      .mockResolvedValueOnce(okEnvelope({ id: 'psess_1', revokedAt: '2026-09-24T00:00:00.000Z' }));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const listed = await client.environments.listAccessSessions('env/a', { limit: 5, cursor: 'page/+2' });
    expect(listed.success).toBe(true);
    expect(urlOf(fetchMock, 0)).toBe('https://eaas.example.com/api/v1/environments/env%2Fa/access-sessions?limit=5&cursor=page%2F%2B2');

    const revoked = await client.environments.revokeAccessSession('env/a', 'psess/1');
    expect(revoked.success).toBe(true);
    expect(urlOf(fetchMock, 1)).toBe(
      'https://eaas.example.com/api/v1/environments/env%2Fa/access-sessions/psess%2F1/revoke',
    );
  });

  it('create() reuses a caller-supplied Idempotency-Key (retry-safety contract)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(statusPreset()));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const opts = { idempotencyKey: 'caller-fixed-key' };

    // This SDK performs no auto-retry: caller retries by re-invoking with the
    // SAME key. Both attempts must carry the identical header value.
    await client.environments.create(
      { projectId: 'prj_abc', template: 't', profile: '2c4g' },
      opts,
    );
    await client.environments.create(
      { projectId: 'prj_abc', template: 't', profile: '2c4g' },
      opts,
    );
    expect(headersOf(fetchMock, 0)['Idempotency-Key']).toBe('caller-fixed-key');
    expect(headersOf(fetchMock, 1)['Idempotency-Key']).toBe('caller-fixed-key');
  });

  it('pause/wake/suspend POST the lifecycle subpaths with Idempotency-Key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(statusPreset({ state: 'paused' })));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const envId = 'env_testlifecycle000001';

    await client.environments.pause(envId);
    expect(urlOf(fetchMock, 0)).toBe(`https://eaas.example.com/api/v1/environments/${envId}/pause`);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
    expect(headersOf(fetchMock, 0)['Idempotency-Key']).toBeTruthy();

    await client.environments.wake(envId, { idempotencyKey: 'wake-key-1' });
    expect(urlOf(fetchMock, 1)).toBe(`https://eaas.example.com/api/v1/environments/${envId}/wake`);
    expect(headersOf(fetchMock, 1)['Idempotency-Key']).toBe('wake-key-1');

    await client.environments.suspend(envId);
    expect(urlOf(fetchMock, 2)).toBe(`https://eaas.example.com/api/v1/environments/${envId}/suspend`);
    expect(headersOf(fetchMock, 2)['Idempotency-Key']).toBeTruthy();
  });

  it('update() PATCHes with If-Match as the bare revision number', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(statusPreset({ revision: 8 })));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await client.environments.update(
      'env_testupdaterev0000001',
      { expiresAt: '2026-09-10T00:00:00.000Z', metadata: { k: 'v' } },
      { revision: 7 },
    );
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/environments/env_testupdaterev0000001');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PATCH');
    // Server parseIfMatch only accepts a bare non-negative integer — no W/"…".
    expect(headersOf(fetchMock, 0)['If-Match']).toBe('7');
    expect(JSON.parse(init.body as string)).toEqual({
      expiresAt: '2026-09-10T00:00:00.000Z',
      metadata: { k: 'v' },
    });
  });

  it('delete() DELETEs with Idempotency-Key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(statusPreset({ state: 'stopped' })));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await client.environments.delete('env_testdeleterow000001');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('DELETE');
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/environments/env_testdeleterow000001');
    expect(headersOf(fetchMock, 0)['Idempotency-Key']).toBeTruthy();
  });
});

describe('client.environments — read surface', () => {
  it('client.eaas.context() GETs /api/v1/context', async () => {
    const context = {
      credential: { kind: 'machine', keyId: 'eak_1', scopes: ['environments:read', 'environments:write'], expiresAt: null },
      tenant: { id: 'tnt_1', name: 'Tenant' },
      project: { id: 'prj_1', name: 'default' },
      defaults: {
        template: 'node20-web',
        profile: '2c4g',
        ttlSeconds: 3600,
        poolId: 'default-kind-local',
        placementId: 'kind-local',
      },
      capabilities: {
        templates: ['node20-web'],
        profiles: ['2c4g'],
        lifecycleActions: ['delete'],
        delegation: false,
        placements: [{ id: 'kind-local', providerKind: 'k8s', region: 'local', revision: 1 }],
        pools: [
          {
            id: 'default-kind-local',
            placementId: 'kind-local',
            template: 'node20-web',
            profile: '2c4g',
            mode: 'warm',
            default: true,
          },
        ],
      },
      limits: { maxTtlSeconds: 86400, observedAt: '2026-09-24T00:00:00.000Z' },
    };
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(context));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.eaas.context();
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.capabilities.placements[0].providerKind).toBe('k8s');
      expect(res.data.capabilities.lifecycleActions).toEqual(['delete']);
    }
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/context');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('GET');
  });

  it('get() GETs /api/v1/environments/:id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(statusPreset()));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await client.environments.get('env_testreadsingle00001');
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/environments/env_testreadsingle00001');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('GET');
  });

  it('list() forwards cursor/limit query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope({ environments: [], nextCursor: null }));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await client.environments.list({ cursor: 'abc', limit: 20 });
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/environments?cursor=abc&limit=20');
  });
});

describe('client.environments.usage — project metering ledger (Gate B T19)', () => {
  const usagePage = {
    items: [
      {
        intervalStart: '2026-09-10T00:00:00.000Z',
        dimension: 'warm_compute',
        seconds: 60,
        credits: '0.025000',
        rateVersion: 'r1',
        resourceId: 'inv_1',
        environmentId: 'env_1',
      },
      {
        intervalStart: '2026-09-10T00:01:00.000Z',
        dimension: 'environment_compute',
        seconds: 30,
        credits: '0.010000',
        rateVersion: 'r1',
        resourceId: 'env_1',
      },
    ],
    nextCursor: 'aW52XzE6NjA=',
    rateVersion: 'r1',
    periodSpent: { warmCredits: '0.025000', activeCredits: '0.010000' },
  };

  it('GETs /api/v1/projects/:id/usage forwarding from/to/cursor/limit as query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(usagePage));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.environments.usage('prj_usageface0000001', {
      from: '2026-09-10T00:00:00.000Z',
      to: '2026-09-11T00:00:00.000Z',
      cursor: 'aW52XzE6NjA=',
      limit: 25,
    });
    expect(res.success).toBe(true);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('GET');
    expect(urlOf(fetchMock)).toBe(
      'https://eaas.example.com/api/v1/projects/prj_usageface0000001/usage' +
        '?from=2026-09-10T00%3A00%3A00.000Z&to=2026-09-11T00%3A00%3A00.000Z' +
        '&cursor=aW52XzE6NjA%3D&limit=25',
    );
  });

  it('omits every unset window/cursor param (no empty query suffix)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(usagePage));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await client.environments.usage('prj_usagedefaultwin01');
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/projects/prj_usagedefaultwin01/usage');
  });

  it('returns the usage page data verbatim (items/nextCursor/rateVersion/periodSpent)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(usagePage));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res: EaasApiEnvelope<EaasUsagePage> = await client.environments.usage('prj_usageshapedata001');
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.items).toHaveLength(2);
      expect(res.data.nextCursor).toBe('aW52XzE6NjA=');
      expect(res.data.rateVersion).toBe('r1');
      expect(res.data.periodSpent).toEqual({ warmCredits: '0.025000', activeCredits: '0.010000' });
    }
  });

  it('passes server denials through verbatim — 404 not_owned and 403 project-pinned scope_denied', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failEnvelope(404, 'not_owned', 'project not found'))
      .mockResolvedValueOnce(failEnvelope(403, 'scope_denied', 'key is pinned to project prj_other'));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const notOwned = await client.environments.usage('prj_usagenotowned0001');
    expect(notOwned.success).toBe(false);
    if (!notOwned.success) expect(notOwned.error.code).toBe('not_owned');

    const pinned = await client.environments.usage('prj_usagepinned00001');
    expect(pinned.success).toBe(false);
    if (!pinned.success) expect(pinned.error.code).toBe('scope_denied');
  });

  it('400 invalid_request (window > 31 days / bad limit) passes through verbatim', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      failEnvelope(400, 'invalid_request', 'query window must not exceed 31 days', {
        field: 'to',
      }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.environments.usage('prj_usagewindow0001', {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-09-11T00:00:00.000Z',
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe('invalid_request');
  });
});

describe('client.environments — exec / files / snapshots / services', () => {
  it('exec() POSTs :id/execs with command body and Idempotency-Key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({ execId: 'exec_1', status: 'exited', exitCode: 0, stdout: 'ok', stderr: '', startedAt: 't', finishedAt: 't' }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await client.environments.exec('env_testexecsurface0001', { command: ['echo', 'hi'], timeoutMs: 5000 });
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/environments/env_testexecsurface0001/execs');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ command: ['echo', 'hi'], timeoutMs: 5000 });
    expect(headersOf(fetchMock, 0)['Idempotency-Key']).toBeTruthy();
  });

  it('getExec() GETs :id/execs/:execId with cursor query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope({ execId: 'exec_1', status: 'running' }));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await client.environments.getExec('env_testexecsurface0001', 'exec_1', { cursor: 1024 });
    expect(urlOf(fetchMock)).toBe(
      'https://eaas.example.com/api/v1/environments/env_testexecsurface0001/execs/exec_1?cursor=1024',
    );
  });

  it('putFile() PUTs raw octet-stream bytes via the raw-fetch seam', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({ environmentId: 'env_1', path: 'a/b.txt', size: 5, sha256: 'deadbeef' }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const bytes = new TextEncoder().encode('hello');

    await client.environments.putFile('env_testfileputcase0001', 'a/b.txt', bytes);
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/environments/env_testfileputcase0001/files/a/b.txt');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe('hello');
  });

  it('getFile() returns { bytes, sha256 } from the raw bytes + X-Eaas-File-Sha256 header', async () => {
    const payload = new TextEncoder().encode('file-bytes');
    const fetchMock = vi.fn().mockResolvedValue(rawBytesResponse(payload, 'cafebabe'));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.environments.getFile('env_testfilegetcase0001', 'a/b.txt');
    expect(res.success).toBe(true);
    if (res.success) {
      expect(new TextDecoder().decode(res.bytes)).toBe('file-bytes');
      expect(res.sha256).toBe('cafebabe');
    }
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/environments/env_testfilegetcase0001/files/a/b.txt');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('GET');
  });

  it('putFile() with a bare 404 (empty body, FF off) returns a synthesized fail envelope instead of throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyBodyResponse(404));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.environments.putFile(
      'env_testfileputffoff0001',
      'a.txt',
      new TextEncoder().encode('x'),
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('http_error');
      expect(res.error.message).toContain('404');
    }
  });

  it('putFile() with a gateway HTML error body also lands on the synthesized fail envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Headers(),
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    } as unknown as Response);
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.environments.putFile(
      'env_testfileputhtml0001',
      'a.txt',
      new TextEncoder().encode('x'),
    );
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe('http_error');
  });

  it('putFile() with a server error envelope body passes the envelope through verbatim', async () => {
    const fetchMock = vi.fn().mockResolvedValue(failEnvelope(409, 'state_conflict', 'environment not running'));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.environments.putFile(
      'env_testfileputconflict01',
      'a.txt',
      new TextEncoder().encode('x'),
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('state_conflict');
      expect(res.error.message).toBe('environment not running');
    }
  });

  it('createSnapshot()/listSnapshots()/restore() hit the snapshot subpaths', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({ environmentId: 'env_1', snapshotId: 'snap_1', state: 'pending', operationId: 'op_1' }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const envId = 'env_testsnapshotface001';

    await client.environments.createSnapshot(envId);
    expect(urlOf(fetchMock, 0)).toBe(`https://eaas.example.com/api/v1/environments/${envId}/snapshots`);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
    expect(headersOf(fetchMock, 0)['Idempotency-Key']).toBeTruthy();

    await client.environments.listSnapshots(envId);
    expect(urlOf(fetchMock, 1)).toBe(`https://eaas.example.com/api/v1/environments/${envId}/snapshots`);
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('GET');

    await client.environments.restore(envId, 'snap_9', { idempotencyKey: 'restore-key-1' });
    expect(urlOf(fetchMock, 2)).toBe(`https://eaas.example.com/api/v1/environments/${envId}/snapshots/snap_9/restore`);
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe('POST');
    expect(headersOf(fetchMock, 2)['Idempotency-Key']).toBe('restore-key-1');
  });

  it('listServices() GETs :id/services', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({ environmentId: 'env_1', services: [], gatewayUrl: null }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await client.environments.listServices('env_testservicesproj001');
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/environments/env_testservicesproj001/services');
  });
});

// ---------------------------------------------------------------------------
// issueSession wire body / artifacts + events replay / eaasSkills faces
// ---------------------------------------------------------------------------

describe('client.environments — issueSession wire body (server truth: no `kind` field)', () => {
  // Server truth: src/tenant/sessions.ts parseIssueBody — allowed fields are
  // exactly {identityToken, anonymous, ttlSeconds, environmentId}; anything
  // else (including a `kind` discriminator) → 400 invalid_request. The wire
  // discriminator IS the field: `anonymous: true` (literal) or `identityToken`.
  const issued = {
    token: 'ps-eaas-testtoken',
    expiresAt: '2026-09-10T00:00:00.000Z',
    principalId: 'prn_1',
    effectiveScopes: ['environments:read'],
    effectiveBudget: {
      periodStart: '2026-09-09T00:00:00.000Z',
      periodEnd: '2026-09-10T00:00:00.000Z',
      limitCredits: null,
      spentCredits: '0.000000',
      remainingCredits: null,
    },
  };

  it('anonymous session posts {anonymous: true} — no `kind` discriminator on the wire', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(issued));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.environments.issueSession({ anonymous: true, environmentId: 'env_1' });
    expect(res.success).toBe(true);
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/sessions');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ anonymous: true, environmentId: 'env_1' });
  });

  it('identity session posts {identityToken, ttlSeconds} verbatim', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(issued));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await client.environments.issueSession({ identityToken: 'eyJhbGciOi...', ttlSeconds: 3600 });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      identityToken: 'eyJhbGciOi...',
      ttlSeconds: 3600,
    });
  });
});

describe('client.environments — artifacts + events replay faces', () => {
  it('listArtifacts() GETs :id/artifacts with the limit query', async () => {
    const page = {
      environmentId: 'env_1',
      artifacts: [
        {
          artifactId: 'eart_1',
          filename: 'report.md',
          mime: 'text/markdown',
          contentHash: 'deadbeef',
          sizeBytes: 12,
          conversationId: 'conv_1',
          messageId: 'msg_1',
          createdAt: '2026-09-09T00:00:00.000Z',
        },
      ],
      truncated: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(page));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.environments.listArtifacts('env_testartifactlist1', { limit: 25 });
    expect(res.success).toBe(true);
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/environments/env_testartifactlist1/artifacts?limit=25');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('GET');
  });

  it('getArtifact() returns { bytes, sha256 } via the raw seam + X-Eaas-Artifact-Sha256', async () => {
    const payload = new TextEncoder().encode('artifact-bytes');
    const fetchMock = vi.fn().mockResolvedValue(rawBytesResponse(payload, 'cafebabe', 'x-eaas-artifact-sha256'));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.environments.getArtifact('env_testartifactget001', 'eart_1');
    expect(res.success).toBe(true);
    if (res.success) {
      expect(new TextDecoder().decode(res.bytes)).toBe('artifact-bytes');
      expect(res.sha256).toBe('cafebabe');
    }
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/environments/env_testartifactget001/artifacts/eart_1');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('GET');
  });

  it('getArtifact() with a bare 404 (FF off) returns the synthesized fail envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyBodyResponse(404));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.environments.getArtifact('env_testartifactmiss01', 'eart_x');
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('http_error');
      expect(res.error.message).toContain('404');
    }
  });

  it('listEvents() GETs /api/v1/events joining cursor/limit/CSV filters', async () => {
    const page = { events: [], nextCursor: '42', truncated: false };
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(page));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.environments.listEvents({
      cursor: '7',
      limit: 100,
      environmentIds: ['env_1', 'env_2'],
      projectIds: ['prj_1'],
    });
    expect(res.success).toBe(true);
    expect(urlOf(fetchMock)).toBe(
      'https://eaas.example.com/api/v1/events?cursor=7&limit=100&environmentIds=env_1%2Cenv_2&projectIds=prj_1',
    );
  });

  it('listEvents() without options hits the bare path (JSON accept default)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope({ events: [], nextCursor: '0', truncated: false }));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await client.environments.listEvents();
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/events');
  });

  it('listEvents() surfaces the 409 state_conflict resync envelope verbatim', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      failEnvelope(409, 'state_conflict', 'event cursor is no longer serviceable — resync from an authorized snapshot', {
        resync: 'eaas.resync',
        lastSeq: '128',
      }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.environments.listEvents({ cursor: '1' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('state_conflict');
      expect(res.error.details).toEqual({ resync: 'eaas.resync', lastSeq: '128' });
    }
  });
});

describe('client.eaasSkills — tenant-private skill catalog (operator-only face)', () => {
  const skillView = {
    skillId: 'eskl_1',
    tenantId: 'tnt_1',
    slug: 'report-writer',
    name: 'Report Writer',
    description: '',
    license: '',
    status: 'private',
    contentManifest: null,
    approvalId: null,
    publishedAt: null,
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  };

  it('list() GETs /api/v1/skills with the status filter (tenant-scoped root path)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope({ skills: [skillView] }));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.eaasSkills.list({ status: 'private' });
    expect(res.success).toBe(true);
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/skills?status=private');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('GET');
  });

  it('create()/get()/update()/delete()/publish() hit the skill subpaths', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(skillView));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await client.eaasSkills.create({ slug: 'report-writer', name: 'Report Writer', content: '---\nname: x\n---\nbody' });
    expect(urlOf(fetchMock, 0)).toBe('https://eaas.example.com/api/v1/skills');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      slug: 'report-writer',
      name: 'Report Writer',
      content: '---\nname: x\n---\nbody',
    });
    // The face is NOT idempotency-keyed (publish dedup rides the approval
    // operationKey; CRUD is a direct state flip — server route declaration).
    expect(headersOf(fetchMock, 0)['Idempotency-Key']).toBeUndefined();

    await client.eaasSkills.get('eskl_1');
    expect(urlOf(fetchMock, 1)).toBe('https://eaas.example.com/api/v1/skills/eskl_1');

    await client.eaasSkills.update('eskl_1', { description: 'updated' });
    expect(urlOf(fetchMock, 2)).toBe('https://eaas.example.com/api/v1/skills/eskl_1');
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)).toEqual({ description: 'updated' });

    await client.eaasSkills.delete('eskl_1');
    expect((fetchMock.mock.calls[3][1] as RequestInit).method).toBe('DELETE');
    expect(urlOf(fetchMock, 3)).toBe('https://eaas.example.com/api/v1/skills/eskl_1');

    await client.eaasSkills.publish('eskl_1');
    expect((fetchMock.mock.calls[4][1] as RequestInit).method).toBe('POST');
    expect(urlOf(fetchMock, 4)).toBe('https://eaas.example.com/api/v1/skills/eskl_1/publish');
  });

  it('publish() surfaces the 202 pending_approval payload verbatim', async () => {
    const pending = { status: 'pending_approval', approvalId: 'apr_1', skillStatus: 'private' };
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(pending));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.eaasSkills.publish('eskl_1');
    expect(res.success).toBe(true);
    if (res.success) expect(res.data).toEqual(pending);
  });
});

// ---------------------------------------------------------------------------
// waitUntilReady — readiness-driven polling
// ---------------------------------------------------------------------------

describe('client.environments.waitUntilReady', () => {
  it('polls GET until readiness.services flips true, then resolves the status', async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      calls++;
      const ready = calls >= 3;
      return Promise.resolve(okEnvelope(statusPreset({ readiness: { sandbox: true, services: ready, agent: null } })));
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const status = await client.environments.waitUntilReady('env_testwaitready00001', {
      capability: 'services',
      timeoutMs: 2000,
      pollMs: 5,
    });
    expect(status.readiness.services).toBe(true);
    expect(calls).toBe(3);
  });

  it("rejects immediately with capability_unavailable for capability 'agent' (no polling)", async () => {
    const fetchMock = vi.fn();
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await expect(
      client.environments.waitUntilReady('env_testwaitagent000001', { capability: 'agent' }),
    ).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects with code timeout when readiness never flips within timeoutMs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope(statusPreset({ readiness: { sandbox: true, services: false, agent: null } })),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await expect(
      client.environments.waitUntilReady('env_testwaittimeout0001', { timeoutMs: 40, pollMs: 10 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('propagates the server error code when a poll returns a fail envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(failEnvelope(404, 'not_owned', 'no such environment'));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await expect(
      client.environments.waitUntilReady('env_testwaitnotowned01', { timeoutMs: 500, pollMs: 10 }),
    ).rejects.toMatchObject({ code: 'not_owned' });
  });
});

// ---------------------------------------------------------------------------
// WarmPoolClient — If-Match bare revision + 503 fail-through
// ---------------------------------------------------------------------------

describe('client.projects.warmPool', () => {
  it('get() GETs /api/v1/projects/:id/warm-pool', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope({ revision: 1 } as WarmPoolStatus));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await client.projects.warmPool.get('prj_warmpoolget00001');
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/projects/prj_warmpoolget00001/warm-pool');
  });

  it('patch() sends If-Match as the bare revision number + Idempotency-Key + {policy,dryRun} body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope({ revision: 4 } as WarmPoolStatus));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const policy = {
      minReady: 1,
      maxReady: 2,
      idleRetentionSeconds: 300,
      dailyBudgetCredits: '10.000',
      onMiss: 'fail' as const,
    };

    await client.projects.warmPool.patch('prj_warmpoolpatch0001', { policy, dryRun: true }, { revision: 3 });
    expect(urlOf(fetchMock)).toBe('https://eaas.example.com/api/v1/projects/prj_warmpoolpatch0001/warm-pool');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PATCH');
    // T8-(d) contract: the server parseIfMatch only accepts a bare integer —
    // no weak-validator quoting, no etag quotes.
    expect(headersOf(fetchMock, 0)['If-Match']).toBe('3');
    expect(headersOf(fetchMock, 0)['Idempotency-Key']).toBeTruthy();
    expect(JSON.parse(init.body as string)).toEqual({ policy, dryRun: true });
  });

  it('503 warm_capacity_unavailable passes through verbatim — no retry, no cold downgrade', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      failEnvelope(503, 'warm_capacity_unavailable', 'no warm capacity and onMiss=fail'),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const policy = {
      minReady: 1,
      maxReady: 2,
      idleRetentionSeconds: 300,
      dailyBudgetCredits: '10.000',
      onMiss: 'fail' as const,
    };

    const res: EaasApiEnvelope<WarmPoolStatus> = await client.projects.warmPool.patch(
      'prj_warmpool503case0001',
      { policy },
      { revision: 3, idempotencyKey: 'fixed-key' },
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('warm_capacity_unavailable');
      expect(res.error.message).toContain('onMiss=fail');
    }
    // Exactly one HTTP attempt: no SDK-side retry loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The request body was NOT rewritten to degrade onMiss fail → cold.
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).policy.onMiss).toBe('fail');
  });

  it('exposes the same fail-envelope shape for warm-pool GET 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue(failEnvelope(404, 'not_owned', 'project not found'));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const res = await client.projects.warmPool.get('prj_notownedcase0001');
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe('not_owned');
  });
});
