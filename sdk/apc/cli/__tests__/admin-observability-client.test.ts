import { describe, expect, it, vi } from 'vitest';

import type { EnvContext } from '../../../../scripts/debug/lib/env';
import {
  ADMIN_CAPABILITIES_PATH,
  ADMIN_LOG_QUERY_PATH,
  AdminV1ClientError,
  AdminV1ReadClient,
  exitCodeForEvidence,
  PARTIAL_RESULT_EXIT_CODE,
} from '../../../../scripts/debug/lib/admin-v1-client';
import {
  AdminObservabilityUsageError,
  parseAdminLogCommand,
  runAdminObservability,
} from '../../../../scripts/debug/admin-observability';

const SECRET = 'sk-prismer-live-this-must-never-leak';

const context: EnvContext = {
  env: 'test',
  baseUrl: 'https://cloud.example.test',
  authMode: 'platform-held test credential',
  async getAuthHeader() {
    return `Bearer ${SECRET}`;
  },
};

function success<T>(data: T, requestId: string): Response {
  return Response.json(
    {
      success: true,
      data,
      meta: { requestId, apiVersion: 'admin.v1', generatedAt: '2026-08-29T00:00:00.000Z' },
    },
    { status: 200 },
  );
}

function capabilities(
  capabilityList = ['admin.capabilities.read', 'admin.logs.read', 'admin.inventory.read'],
  environment = 'test',
) {
  return {
    apiVersion: 'admin.v1' as const,
    principal: { type: 'human' as const, id: 'user-1', authMode: 'api-key' as const, apiKeyId: 'key-1' },
    capabilities: capabilityList,
    environments: [environment],
    limits: {
      requestsPerMinute: 30,
      defaultLogRangeSeconds: 900,
      maxLogRangeSeconds: 86_400,
      maxLogSources: 100,
      maxLogEntries: 10_000,
      maxResponseBytes: 5 * 1024 * 1024,
    },
    contract: {
      openapiUrl: '/api/admin/v1/openapi.json',
      openapiDigest: `sha256:${'a'.repeat(64)}`,
      schemaVersion: 'admin.v1.0',
    },
    actions: [],
    serverTime: '2026-08-29T00:00:00.000Z',
  };
}

function logs(partial: boolean, body: string = 'safe log body') {
  return {
    items: [
      {
        timestamp: '2026-08-29T00:00:00.000Z',
        observedTimestamp: '2026-08-29T00:00:00.001Z',
        severityText: 'info',
        severityNumber: 9,
        body,
        resource: {
          'service.name': 'prismer-cloud',
          'deployment.environment.name': 'test',
          'k8s.pod.name': 'prismer-cloud-abc',
          'k8s.container.name': 'prismer-cloud',
        },
        attributes: {
          'prismer.target.kind': 'service' as const,
          'prismer.target.id': 'prismer-cloud',
          'prismer.log.stream': 'stdout' as const,
          'prismer.timestamp.quality': 'source' as const,
        },
        schemaUrl: 'https://prismer.cloud/schemas/admin/log-record/v1',
        redaction: { status: 'applied' as const, rulesetVersion: '2026-08-29.1' },
      },
    ],
    nextCursor: null,
    partial,
    truncated: false,
    ordering: 'stable-best-effort',
    continuity: 'best-effort',
    mayDuplicate: true,
    sources: [
      {
        sourceId: 'process:cloud-1',
        sourceTier: 'live-direct' as const,
        kind: 'process-buffer',
        status: partial ? ('unavailable' as const) : ('available' as const),
        retention: { kind: 'ephemeral', seconds: null },
        continuity: 'best-effort',
        coverage: {
          since: '2026-08-28T23:45:00.000Z',
          until: '2026-08-29T00:00:00.000Z',
          complete: !partial,
        },
        dropped: 0,
        truncated: false,
      },
    ],
    coverage: {
      requestedSince: '2026-08-28T23:45:00.000Z',
      requestedUntil: '2026-08-29T00:00:00.000Z',
      oldestAvailableAt: '2026-08-29T00:00:00.000Z',
      newestAvailableAt: '2026-08-29T00:00:00.000Z',
      complete: !partial,
    },
    bytesReturned: 13,
    linesScanned: 1,
    queryCost: { sourcesAttempted: 1, sourcesSucceeded: partial ? 0 : 1 },
    redactionRulesetVersion: '2026-08-29.1',
  };
}

const query = {
  target: { kind: 'service' as const, id: 'prismer-cloud' as const },
  environment: 'test',
  timeRange: {
    since: '2026-08-28T23:45:00.000Z',
    until: '2026-08-29T00:00:00.000Z',
  },
  purpose: 'investigate APC runtime regression',
};

function stableRetainedLogs() {
  return {
    ...logs(false),
    ordering: 'stable' as const,
    continuity: 'stable' as const,
    mayDuplicate: false,
    sources: [
      {
        sourceId: 'sls:prismer-cloud',
        sourceTier: 'retained' as const,
        kind: 'sls' as const,
        status: 'available' as const,
        retention: { kind: 'bounded' as const, seconds: 30 * 24 * 60 * 60 },
        continuity: 'stable' as const,
        coverage: {
          since: '2026-08-28T23:45:00.000Z',
          until: '2026-08-29T00:00:00.000Z',
          complete: true,
        },
        dropped: 0,
        truncated: false,
      },
    ],
  };
}

describe('Admin v1 APC read client', () => {
  it('discovers the contract before using the one canonical logs endpoint', async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(String(input));
      requests.push({ url, init });
      return requests.length === 1 ? success(capabilities(), 'req-cap') : success(logs(false), 'req-logs');
    }) as typeof fetch;

    const evidence = await new AdminV1ReadClient(context, { fetchImpl }).queryLogs(query);

    expect(requests.map(({ url }) => url.pathname)).toEqual([ADMIN_CAPABILITIES_PATH, ADMIN_LOG_QUERY_PATH]);
    expect(requests[1]?.init?.method).toBe('POST');
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual(query);
    expect(requests[0]?.init?.headers).toMatchObject({ Authorization: `Bearer ${SECRET}` });
    expect(evidence.contractDigest).toBe(`sha256:${'a'.repeat(64)}`);
    expect(evidence.principal).toMatchObject({ id: 'user-1', apiKeyId: 'key-1' });
    expect(evidence.attemptedSourceTiers).toEqual(['live-direct']);
    expect(evidence.availableSourceTiers).toEqual(['live-direct']);
    expect(evidence.evidenceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(exitCodeForEvidence(evidence)).toBe(0);
  });

  it('defaults to require-complete and maps a partial result to a stable non-zero exit', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(success(capabilities(), 'req-cap'))
      .mockResolvedValueOnce(success(logs(true), 'req-logs')) as typeof fetch;

    const evidence = await new AdminV1ReadClient(context, { fetchImpl }).queryLogs(query);

    expect(evidence.confidenceBoundary).toMatchObject({
      completeness: 'require-complete',
      partial: true,
    });
    expect(exitCodeForEvidence(evidence)).toBe(PARTIAL_RESULT_EXIT_CODE);
    expect(evidence.response.data.sources).toHaveLength(1);
  });

  it('allows an explicit exploratory partial result without hiding source outcomes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(success(capabilities(), 'req-cap'))
      .mockResolvedValueOnce(success(logs(true), 'req-logs')) as typeof fetch;
    const evidence = await new AdminV1ReadClient(context, { fetchImpl }).queryLogs(query, 'allow-partial');

    expect(exitCodeForEvidence(evidence)).toBe(0);
    expect(evidence.response.data.partial).toBe(true);
    expect(evidence.response.data.sources[0]?.status).toBe('unavailable');
  });

  it('does not present an unavailable retained source as available evidence', async () => {
    const response = {
      ...logs(true),
      sources: [
        { ...logs(false).sources[0], status: 'available' as const },
        {
          ...stableRetainedLogs().sources[0],
          status: 'unavailable' as const,
          coverage: { since: null, until: null, complete: false },
        },
      ],
      queryCost: { sourcesAttempted: 2, sourcesSucceeded: 1 },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(success(capabilities(), 'req-cap'))
      .mockResolvedValueOnce(success(response, 'req-logs')) as typeof fetch;

    const evidence = await new AdminV1ReadClient(context, { fetchImpl }).queryLogs(query);

    expect(evidence.attemptedSourceTiers).toEqual(['live-direct', 'retained']);
    expect(evidence.availableSourceTiers).toEqual(['live-direct']);
    expect(evidence.confidenceBoundary.productionRetainedRequirement.available).toBe(false);
  });

  it('requires stable, complete, available retained evidence for production require-complete', async () => {
    const productionQuery = { ...query, environment: 'prod' as const };
    const liveOnlyFetch = vi
      .fn()
      .mockResolvedValueOnce(success(capabilities(undefined, 'prod'), 'req-cap'))
      .mockResolvedValueOnce(success(logs(false), 'req-logs')) as typeof fetch;
    const weakEvidence = await new AdminV1ReadClient(context, { fetchImpl: liveOnlyFetch }).queryLogs(
      productionQuery,
    );
    expect(weakEvidence.confidenceBoundary).toMatchObject({
      partial: true,
      serverPartial: false,
      productionRetainedRequirement: { required: true, satisfied: false, available: false },
    });
    expect(exitCodeForEvidence(weakEvidence)).toBe(PARTIAL_RESULT_EXIT_CODE);

    const retainedFetch = vi
      .fn()
      .mockResolvedValueOnce(success(capabilities(undefined, 'prod'), 'req-cap'))
      .mockResolvedValueOnce(success(stableRetainedLogs(), 'req-logs')) as typeof fetch;
    const strongEvidence = await new AdminV1ReadClient(context, { fetchImpl: retainedFetch }).queryLogs(
      productionQuery,
    );
    expect(strongEvidence.availableSourceTiers).toEqual(['retained']);
    expect(strongEvidence.confidenceBoundary.productionRetainedRequirement).toEqual({
      required: true,
      satisfied: true,
      available: true,
      stable: true,
      complete: true,
    });
    expect(exitCodeForEvidence(strongEvidence)).toBe(0);
  });

  it('accepts retained pagination and stable response contract values', async () => {
    const retainedPage = { ...stableRetainedLogs(), nextCursor: 'sls:v1:opaque' };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(success(capabilities(), 'req-cap'))
      .mockResolvedValueOnce(success(retainedPage, 'req-logs')) as typeof fetch;
    const evidence = await new AdminV1ReadClient(context, { fetchImpl }).queryLogs({
      ...query,
      page: { limit: 100, cursor: 'sls:v1:previous' },
    });

    expect(evidence.response.data.nextCursor).toBe('sls:v1:opaque');
    expect(evidence.response.data.ordering).toBe('stable');
    expect(evidence.response.data.mayDuplicate).toBe(false);
  });

  it('fails closed when capability discovery does not grant logs read', async () => {
    const fetchImpl = vi.fn(async () => success(capabilities(['admin.inventory.read']), 'req-cap')) as typeof fetch;
    await expect(new AdminV1ReadClient(context, { fetchImpl }).queryLogs(query)).rejects.toMatchObject({
      code: 'CAPABILITY_REQUIRED',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('accepts the declared inventory capability without weakening logs authorization', async () => {
    const fetchImpl = vi.fn(async () =>
      success(capabilities(['admin.capabilities.read', 'admin.logs.read', 'admin.inventory.read']), 'req-cap'),
    ) as typeof fetch;

    const response = await new AdminV1ReadClient(context, { fetchImpl }).capabilities();
    expect(response.data.capabilities).toContain('admin.inventory.read');
  });

  it('rejects a missing audit purpose before making a request', async () => {
    const fetchImpl = vi.fn() as typeof fetch;
    await expect(
      new AdminV1ReadClient(context, { fetchImpl }).queryLogs({ ...query, purpose: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when the requested environment is not advertised', async () => {
    const fetchImpl = vi.fn(async () => success(capabilities(), 'req-cap')) as typeof fetch;
    await expect(
      new AdminV1ReadClient(context, { fetchImpl }).queryLogs({ ...query, environment: 'prod' }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_UNAVAILABLE' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('redacts the exact platform credential from successful evidence and HTTP failures', async () => {
    const echoFetch = vi
      .fn()
      .mockResolvedValueOnce(success(capabilities(), 'req-cap'))
      .mockResolvedValueOnce(success(logs(false, `accidental ${SECRET}`), 'req-logs')) as typeof fetch;
    const evidence = await new AdminV1ReadClient(context, { fetchImpl: echoFetch }).queryLogs(query);
    expect(JSON.stringify(evidence)).not.toContain(SECRET);
    expect(JSON.stringify(evidence)).toContain('[REDACTED]');

    const failedFetch = vi.fn(async () =>
      Response.json(
        {
          success: false,
          error: { code: 'SOURCE_UNAVAILABLE', detail: `upstream echoed ${SECRET}` },
          meta: { requestId: 'req-failed', apiVersion: 'admin.v1' },
        },
        { status: 503 },
      ),
    ) as typeof fetch;
    const failure = await new AdminV1ReadClient(context, { fetchImpl: failedFetch })
      .queryLogs(query)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdminV1ClientError);
    expect(String(failure)).not.toContain(SECRET);
    expect(failure).toMatchObject({ code: 'SOURCE_UNAVAILABLE', requestId: 'req-failed' });
  });

  it('does not guess a digest algorithm and enforces an exact expected digest when supplied', async () => {
    const fetchImpl = vi.fn(async () => success(capabilities(), 'req-cap')) as typeof fetch;
    await expect(
      new AdminV1ReadClient(context, {
        fetchImpl,
        expectedContractDigest: 'release-pinned-digest',
      }).capabilities(),
    ).rejects.toMatchObject({ code: 'CONTRACT_DIGEST_MISMATCH' });
  });

  it.each([
    ['missing actions', () => ({ ...capabilities(), actions: undefined })],
    [
      'unknown auth mode',
      () => ({ ...capabilities(), principal: { ...capabilities().principal, authMode: 'shared-secret' } }),
    ],
    [
      'non-canonical contract digest',
      () => ({ ...capabilities(), contract: { ...capabilities().contract, openapiDigest: 'opaque' } }),
    ],
    [
      'incoherent limits',
      () => ({
        ...capabilities(),
        limits: { ...capabilities().limits, defaultLogRangeSeconds: 90_000 },
      }),
    ],
    [
      'unknown capability',
      () => ({ ...capabilities(), capabilities: ['admin.capabilities.read', 'admin.future.read'] }),
    ],
  ])('fails closed on an incompatible capabilities payload: %s', async (_name, fixture) => {
    const fetchImpl = vi.fn(async () => success(fixture(), 'req-cap')) as typeof fetch;
    await expect(new AdminV1ReadClient(context, { fetchImpl }).capabilities()).rejects.toMatchObject({
      code: 'INCOMPATIBLE_CONTRACT',
    });
  });

  it.each([
    [
      'entry required field',
      () => ({ ...logs(false), items: [{ ...logs(false).items[0], resource: undefined }] }),
    ],
    [
      'entry enum',
      () => ({
        ...logs(false),
        items: [
          {
            ...logs(false).items[0],
            attributes: { ...logs(false).items[0]?.attributes, 'prismer.log.stream': 'console' },
          },
        ],
      }),
    ],
    [
      'source enum',
      () => ({
        ...logs(false),
        sources: [{ ...logs(false).sources[0], sourceTier: 'archive' }],
      }),
    ],
    [
      'coverage required field',
      () => ({
        ...logs(false),
        coverage: { ...logs(false).coverage, oldestAvailableAt: undefined },
      }),
    ],
    [
      'query cost required field',
      () => ({ ...logs(false), queryCost: { sourcesAttempted: 1 } }),
    ],
    ['bytes type', () => ({ ...logs(false), bytesReturned: '13' })],
    [
      'query cost coherence',
      () => ({ ...logs(false), queryCost: { sourcesAttempted: 1, sourcesSucceeded: 2 } }),
    ],
  ])('fails closed on an incompatible log payload: %s', async (_name, fixture) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(success(capabilities(), 'req-cap'))
      .mockResolvedValueOnce(success(fixture(), 'req-logs')) as typeof fetch;
    await expect(new AdminV1ReadClient(context, { fetchImpl }).queryLogs(query)).rejects.toMatchObject({
      code: 'INCOMPATIBLE_CONTRACT',
    });
  });

  it('rejects a payload that exceeds the server-advertised byte budget', async () => {
    const overBudget = { ...logs(false), bytesReturned: 5 * 1024 * 1024 + 1 };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(success(capabilities(), 'req-cap'))
      .mockResolvedValueOnce(success(overBudget, 'req-logs')) as typeof fetch;

    await expect(new AdminV1ReadClient(context, { fetchImpl }).queryLogs(query)).rejects.toMatchObject({
      code: 'INCOMPATIBLE_CONTRACT',
    });
  });

  it('requires generatedAt in a successful response envelope', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        success: true,
        data: capabilities(),
        meta: { requestId: 'req-cap', apiVersion: 'admin.v1' },
      }),
    ) as typeof fetch;

    await expect(new AdminV1ReadClient(context, { fetchImpl }).capabilities()).rejects.toMatchObject({
      code: 'INCOMPATIBLE_CONTRACT',
    });
  });
});

describe('Admin observability CLI contract', () => {
  const cliArgs = [
    'logs',
    '--target-kind=service',
    '--target-id=prismer-cloud',
    '--purpose=investigate runtime wake failure',
  ];

  it('parses purpose and opaque cursor into the canonical request', () => {
    const parsed = parseAdminLogCommand(
      [...cliArgs, '--cursor=sls:v1:opaque', '--completeness=allow-partial'],
      'test',
      new Date('2026-08-29T00:00:00.000Z'),
    );

    expect(parsed.input).toMatchObject({
      environment: 'test',
      purpose: 'investigate runtime wake failure',
      page: { cursor: 'sls:v1:opaque' },
    });
    expect(parsed.completeness).toBe('allow-partial');
  });

  it('requires an explicit audit purpose', () => {
    expect(() =>
      parseAdminLogCommand(
        ['logs', '--target-kind=service', '--target-id=prismer-cloud'],
        'test',
        new Date('2026-08-29T00:00:00.000Z'),
      ),
    ).toThrow(AdminObservabilityUsageError);
  });

  it('rejects --api-key before environment or credential resolution and never echoes it', async () => {
    const loadEnvironment = vi.fn();
    const suppliedSecret = 'sk-prismer-inline-forbidden';
    const failure = await runAdminObservability([...cliArgs, `--api-key=${suppliedSecret}`], {
      loadEnvironment,
    }).catch((error: unknown) => error);

    expect(loadEnvironment).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(AdminObservabilityUsageError);
    expect(String(failure)).not.toContain(suppliedSecret);
  });

  it('returns exit 3 for require-complete partial evidence without leaking resolved credentials', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(success(capabilities(), 'req-cap'))
      .mockResolvedValueOnce(success(logs(true, `accidental ${SECRET}`), 'req-logs')) as typeof fetch;
    const result = await runAdminObservability(cliArgs, {
      loadEnvironment: (argv) => ({ ctx: context, rest: argv }),
      createClient: (ctx) => new AdminV1ReadClient(ctx, { fetchImpl }),
      now: new Date('2026-08-29T00:00:00.000Z'),
    });

    expect(result.exitCode).toBe(PARTIAL_RESULT_EXIT_CODE);
    expect(JSON.stringify(result.output)).not.toContain(SECRET);
    expect(JSON.stringify(result.output)).toContain('[REDACTED]');
  });
});
