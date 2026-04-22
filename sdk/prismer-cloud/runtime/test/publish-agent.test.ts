/**
 * publishAgent / unpublishAgent tests (Sprint A2.2).
 *
 * Mocks the cloud HTTP boundary so the test runs offline; the on-disk
 * registry round-trip is exercised against a temp file.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { publishAgent, unpublishAgent } from '../src/agents/publish-agent';
import { loadPublishedRegistry, findPublished } from '../src/agents/published-registry';

let tmpDir: string;
let regFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-pub-'));
  regFile = path.join(tmpDir, 'published-agents.toml');
});

function makeFetchMock(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as any);
}

describe('publishAgent', () => {
  it('rejects when API key missing', async () => {
    const result = await publishAgent('claude-code', {
      apiKey: undefined,
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      registryFile: regFile,
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/PRISMER_API_KEY/);
  });

  it('rejects when daemonId missing', async () => {
    const result = await publishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: undefined,
      cloudApiBase: 'https://example',
      registryFile: regFile,
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/daemonId/);
  });

  it('rejects unknown agent name (not in catalog)', async () => {
    const fetchImpl = makeFetchMock(200, {});
    const result = await publishAgent('not-a-real-agent', {
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl,
      registryFile: regFile,
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/unknown agent/);
    // We must not have called the cloud for an unknown name.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('happy path: registers, persists to local registry, returns ids', async () => {
    const fetchImpl = makeFetchMock(201, {
      ok: true,
      data: {
        agentId: 'cmoCLOUD123',
        userId: 'imUser456',
        protocolVersion: '1.0',
        card: { id: 'cmoCLOUD123', imUserId: 'imUser456' },
      },
    });
    const result = await publishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl,
      hostname: 'TEST-HOST',
      registryFile: regFile,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cloudAgentId).toBe('cmoCLOUD123');
    expect(result.imUserId).toBe('imUser456');
    expect(result.alreadyPublished).toBe(false);

    // v1.9.16 publish is now two-step: (1) /api/im/register ensures
    // role=agent IMUser exists under username=<name>, (2) /api/im/agents/
    // register writes the agent card with device-scoped fields. Both calls
    // share the same fetch mock, so expect 2 invocations.
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // v1.9.16: username is scoped to daemonId to avoid global-uniqueness
    // collisions (two users publishing `openclaw` on their own boxes).
    // Format: `<agent-name>-<8-hex of daemonId after 'daemon:' prefix>`.
    // Test ctx passes daemonId='d1', so suffix = 'd1' (<=8 chars).
    const expectedScopedUsername = 'claude-code-d1';

    // Call 0: identity bootstrap
    const [url0, init0] = fetchImpl.mock.calls[0];
    expect(url0).toBe('https://example/api/im/register');
    expect((init0 as RequestInit).method).toBe('POST');
    const body0 = JSON.parse((init0 as RequestInit).body as string);
    expect(body0.type).toBe('agent');
    expect(body0.username).toBe(expectedScopedUsername);

    // Call 1: device-scoped agent card — header carries scoped username so
    // middleware.ensureIMUser picks the agent IMUser, but body.name is the
    // bare agent name (what lands on IMAgentCard.name).
    const [url1, init1] = fetchImpl.mock.calls[1];
    expect(url1).toBe('https://example/api/im/agents/register');
    expect((init1 as RequestInit).method).toBe('POST');
    expect((init1 as RequestInit).headers).toMatchObject({ 'X-IM-Agent': expectedScopedUsername });
    const body = JSON.parse((init1 as RequestInit).body as string);
    expect(body.daemonId).toBe('d1');
    expect(body.localAgentId).toBe('claude-code@TEST-HOST');
    expect(body.adapter).toBe('claude-code');
    expect(body.name).toBe('claude-code');

    // Local registry persisted.
    const stored = findPublished('claude-code', regFile);
    expect(stored).toBeDefined();
    expect(stored!.cloudAgentId).toBe('cmoCLOUD123');
  });

  it('re-publish flips alreadyPublished=true', async () => {
    const fetchImpl = makeFetchMock(201, {
      ok: true,
      data: { agentId: 'a', userId: 'u', card: { id: 'a', imUserId: 'u' } },
    });
    await publishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl,
      registryFile: regFile,
    });
    const second = await publishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl,
      registryFile: regFile,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.alreadyPublished).toBe(true);
  });

  it('cloud 4xx → returns error with status, no registry write', async () => {
    const fetchImpl = makeFetchMock(403, { error: 'forbidden' });
    const result = await publishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl,
      registryFile: regFile,
    });
    expect(result.ok).toBe(false);
    expect((result as any).status).toBe(403);
    // Registry must NOT have anything stored on failure.
    expect(loadPublishedRegistry(regFile)).toEqual([]);
  });

  it('network error → returns error with no status', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as any;
    const result = await publishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl,
      registryFile: regFile,
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/network/);
    expect(loadPublishedRegistry(regFile)).toEqual([]);
  });
});

describe('unpublishAgent', () => {
  it('no-op when never published — ok:true', async () => {
    const fetchImpl = makeFetchMock(200, {});
    const result = await unpublishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl,
      registryFile: regFile,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cloudAgentId).toBeNull();
    expect(result.cloudDeleteAttempted).toBe(false);
    // Cloud must NOT have been called when nothing to delete.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('happy path: removes from local registry + calls cloud DELETE', async () => {
    const publishFetch = makeFetchMock(201, {
      ok: true,
      data: { agentId: 'cmoX', userId: 'uX' },
    });
    await publishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl: publishFetch,
      registryFile: regFile,
    });

    const deleteFetch = makeFetchMock(200, { ok: true });
    const result = await unpublishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl: deleteFetch,
      registryFile: regFile,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cloudAgentId).toBe('cmoX');
    expect(result.cloudDeleteOk).toBe(true);
    expect(loadPublishedRegistry(regFile)).toEqual([]);
    // DELETE called with the right URL.
    // v1.9.15 Bug 2 fix — switched from `/api/im/agents/:imUserId`
    // (always 403 for runtime: param expected IMUser id but runtime
    // always passed IMAgentCard id) to `/api/im/me/agents/:cloudAgentId`
    // (owner-scoped, joins IMAgentCard.imUser.userId against caller).
    const [url, init] = deleteFetch.mock.calls[0];
    expect(url).toBe('https://example/api/im/me/agents/cmoX');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('cloud DELETE fails → still removes from local registry (ok:true, deleteOk:false)', async () => {
    const publishFetch = makeFetchMock(201, {
      ok: true,
      data: { agentId: 'cmoX', userId: 'uX' },
    });
    await publishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl: publishFetch,
      registryFile: regFile,
    });

    const deleteFetch = makeFetchMock(500, { error: 'server error' });
    const result = await unpublishAgent('claude-code', {
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl: deleteFetch,
      registryFile: regFile,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cloudDeleteOk).toBe(false);
    // Local registry is the source of truth for what the daemon will
    // heartbeat — wipe it even when cloud DELETE fails so heartbeats stop.
    expect(loadPublishedRegistry(regFile)).toEqual([]);
  });
});
