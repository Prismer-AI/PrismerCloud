import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachAdminObservabilityEvidence,
  buildAdminLogEvidenceManifest,
  collectAdminLogPages,
  outputAdminObservability,
  requestAdminObservability,
} from '../src/commands/admin-observability';

afterEach(() => {
  delete process.env.PRISMER_AGENT_IM_USER_ID;
  process.exitCode = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('credentialless Admin observability CLI transport', () => {
  it('calls only the loopback broker and never supplies Authorization', async () => {
    process.env.PRISMER_AGENT_IM_USER_ID = 'agent-42';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const result = await requestAdminObservability('capabilities', { purpose: 'discover' }, {
      daemonPort: '7878',
      fetchImpl,
    });
    expect(result.status).toBe(200);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7878/local/admin-observability/capabilities');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-Prismer-Agent']).toBe('agent-42');
  });

  it('rejects a non-numeric/out-of-range daemon port instead of accepting a URL', async () => {
    await expect(requestAdminObservability('capabilities', { purpose: 'x' }, {
      daemonPort: 'attacker.invalid/path',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })).rejects.toThrow('port number');
    await expect(requestAdminObservability('capabilities', { purpose: 'x' }, {
      daemonPort: '65536',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })).rejects.toThrow('out of range');
  });

  it('rejects an operation outside the fixed read-only allowlist', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(requestAdminObservability('delete' as never, { purpose: 'x' }, { fetchImpl }))
      .rejects.toThrow('unsupported');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('supports logical target discovery through the fixed loopback operation', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { items: [] } }))) as typeof fetch;
    const result = await requestAdminObservability(
      'log-targets',
      { purpose: 'discover', kind: 'daemon' },
      { daemonPort: '7878', fetchImpl },
    );
    expect(result.status).toBe(200);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:7878/local/admin-observability/log-targets',
    );
  });

  it('returns a distinct nonzero exit code for successful partial evidence', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    outputAdminObservability({ status: 200, body: { success: true, data: { partial: true } } });
    expect(process.exitCode).toBe(2);
    expect(write).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('provider-native snapshot/keyset'));
  });

  it('allows an explicit human partial policy while preserving the warning', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    outputAdminObservability(
      { status: 200, body: { success: true, data: { partial: true } } },
      { allowPartial: true, jsonl: true },
    );
    expect(process.exitCode).toBeUndefined();
    expect(String(write.mock.calls[0]?.[0])).not.toContain('\n  ');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('explicitly allowed'));
  });

  it('auto-pages logs within item bounds and marks a bounded result partial', async () => {
    const request = vi.fn(async (_operation, body: Record<string, unknown>) => {
      const cursor = (body.page as { cursor: string | null }).cursor;
      const second = cursor === 'next-1';
      return {
        status: 200,
        body: {
          success: true,
          data: {
            items: second ? [{ id: 2 }, { id: 3 }] : [{ id: 1 }],
            sources: [{ sourceId: 'sls:test', status: 'available' }],
            nextCursor: second ? 'next-2' : 'next-1',
            partial: false,
            truncated: false,
            coverage: { complete: true },
            bytesReturned: 10,
            linesScanned: 1,
            queryCost: { sourcesAttempted: 1, sourcesSucceeded: 1 },
          },
          meta: { requestId: second ? 'req-2' : 'req-1' },
        },
      };
    });
    const result = await collectAdminLogPages(
      { page: { limit: 2, cursor: null }, purpose: 'triage' },
      { maxItems: 3, maxBytes: 4096, request: request as never },
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.body).toMatchObject({
      data: {
        items: [{ id: 1 }, { id: 2 }, { id: 3 }],
        nextCursor: 'next-2',
        partial: true,
        truncated: true,
        coverage: { complete: false },
      },
      meta: { warnings: [{ code: 'CLIENT_OUTPUT_BOUNDED' }] },
    });
  });

  it('persists and attaches evidence through the existing daemon task-attach channel', async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), 'admin-observability-'));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ mode: 'task-attach', taskId: 'task-1' });
      return new Response(JSON.stringify({ ok: true, assetId: 'asset-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const attached = await attachAdminObservabilityEvidence(
      {
        status: 200,
        body: {
          success: true,
          data: {
            partial: true,
            truncated: false,
            ordering: 'stable-best-effort',
            continuity: 'best-effort',
            mayDuplicate: true,
            sources: [{ sourceId: 'retained:test', sourceTier: 'retained', status: 'available' }],
            coverage: { complete: false, requestedSince: '2026-08-29T00:00:00.000Z' },
            redactionRulesetVersion: 'admin-log-redaction/v1',
          },
          meta: { requestId: 'req-1' },
        },
      },
      {
        taskId: 'task-1',
        daemonPort: '7878',
        artifactsDir,
        now: () => 42,
        contractDigest: `sha256:${'a'.repeat(64)}`,
        principal: {
          type: 'human',
          id: 'owner@example.com',
          authMode: 'api-key',
          apiKeyId: 'key-admin-1',
          credential: 'raw-secret-must-not-be-copied',
        },
        query: { target: { kind: 'sandbox', id: 'runtime-1' }, environment: 'test', purpose: 'triage' },
      },
    );
    expect(attached).toMatchObject({ assetId: 'asset-1', queued: false });
    const manifest = JSON.parse(await readFile(attached.path, 'utf8'));
    expect(manifest).toMatchObject({
      schema: 'apc.admin-log-evidence/v1',
      trusted: false,
      contractDigest: `sha256:${'a'.repeat(64)}`,
      principal: {
        type: 'human',
        id: 'owner@example.com',
        authMode: 'api-key',
        apiKeyId: 'key-admin-1',
      },
      requestId: 'req-1',
      query: { target: { kind: 'sandbox', id: 'runtime-1' }, environment: 'test' },
      confidence: { partial: true, continuity: 'best-effort' },
      redactionRulesetVersion: 'admin-log-redaction/v1',
    });
    expect(manifest.source.outcomes).toHaveLength(1);
    expect(manifest.responseContentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const bytes = await readFile(attached.path, 'utf8');
    expect(bytes).not.toContain('ADMIN_API_KEY');
    expect(bytes).not.toContain('raw-secret-must-not-be-copied');
  });

  it('never upgrades partial log content to trusted evidence and requires canonical fields', () => {
    const body = {
      success: true,
      data: {
        partial: true,
        sources: [],
        coverage: { complete: false },
        redactionRulesetVersion: 'admin-log-redaction/v1',
      },
    };
    const manifest = buildAdminLogEvidenceManifest(
      { status: 200, body },
      {
        contractDigest: `sha256:${'b'.repeat(64)}`,
        principal: { type: 'human', id: 'owner@example.com', authMode: 'session' },
        query: { target: { kind: 'service', id: 'prismer-cloud' } },
        generatedAt: '2026-08-29T00:00:00.000Z',
      },
    );
    expect(manifest.trusted).toBe(false);
    expect(manifest.confidence).toMatchObject({ partial: true });
    expect(() =>
      buildAdminLogEvidenceManifest(
        { status: 200, body: { success: true, data: { partial: false } } },
        {
          contractDigest: `sha256:${'b'.repeat(64)}`,
          principal: { type: 'human', id: 'owner@example.com', authMode: 'session' },
          query: {},
          generatedAt: '2026-08-29T00:00:00.000Z',
        },
      ),
    ).toThrow('canonical source, coverage, or redaction');
  });

  it('fails closed on an oversized response', async () => {
    const fetchImpl = vi.fn(async () => new Response('x', {
      headers: { 'content-length': String(7 * 1024 * 1024) },
    })) as typeof fetch;
    await expect(requestAdminObservability('capabilities', { purpose: 'x' }, { fetchImpl }))
      .rejects.toThrow('exceeded 6 MiB');
  });
});
