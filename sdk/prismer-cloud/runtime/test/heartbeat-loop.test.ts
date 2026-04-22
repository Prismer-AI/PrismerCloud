/**
 * Heartbeat loop tests (Sprint A2.3).
 *
 * Verifies tick semantics — POST shape, retry-on-failure, success counter,
 * empty-registry behavior — without spinning up a real daemon.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startHeartbeatLoop } from '../src/agents/heartbeat-loop';
import { savePublishedRegistry } from '../src/agents/published-registry';

let tmpDir: string;
let regFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-hb-'));
  regFile = path.join(tmpDir, 'published-agents.toml');
});

function fetchOk() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => '{"ok":true}',
    json: async () => ({ ok: true, data: { updated: [], skipped: [] } }),
  }) as any);
}

function fetchFailing(status = 500) {
  return vi.fn(async () => ({
    ok: false,
    status,
    text: async () => `error ${status}`,
    json: async () => ({ ok: false }),
  }) as any);
}

describe('startHeartbeatLoop', () => {
  it('skips POST when registry is empty', async () => {
    const fetchImpl = fetchOk();
    const loop = startHeartbeatLoop({
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl,
      registryFile: regFile,
      intervalMs: 1_000_000,
      fireImmediately: false,
    });
    await loop.tick();
    loop.stop();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs bulk body with all published agents', async () => {
    savePublishedRegistry(
      [
        { name: 'a', cloudAgentId: 'c1', publishedAt: '2026-04-20T10:00:00.000Z' },
        { name: 'b', cloudAgentId: 'c2', publishedAt: '2026-04-20T10:00:00.000Z' },
      ],
      regFile,
    );
    const fetchImpl = fetchOk();
    const loop = startHeartbeatLoop({
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl,
      registryFile: regFile,
      intervalMs: 1_000_000,
      fireImmediately: false,
    });
    await loop.tick();
    loop.stop();

    expect(fetchImpl).toHaveBeenCalled();
    const [url, init] = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1];
    expect(url).toBe('https://example/api/im/me/agents/heartbeat');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.daemonId).toBe('d1');
    expect(body.agents).toHaveLength(2);
    expect(body.agents.map((a: any) => a.cloudAgentId).sort()).toEqual(['c1', 'c2']);
    expect(body.agents.every((a: any) => a.status === 'online')).toBe(true);
  });

  it('uses statusFor to override per-agent status', async () => {
    savePublishedRegistry(
      [
        { name: 'a', cloudAgentId: 'c1', publishedAt: '2026-04-20T10:00:00.000Z' },
        { name: 'b', cloudAgentId: 'c2', publishedAt: '2026-04-20T10:00:00.000Z' },
      ],
      regFile,
    );
    const fetchImpl = fetchOk();
    const loop = startHeartbeatLoop({
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl,
      registryFile: regFile,
      intervalMs: 1_000_000,
      statusFor: (agent) => (agent.name === 'a' ? 'crashed' : 'online'),
    });
    await loop.tick();
    loop.stop();

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    const aRow = body.agents.find((x: any) => x.cloudAgentId === 'c1');
    const bRow = body.agents.find((x: any) => x.cloudAgentId === 'c2');
    expect(aRow.status).toBe('crashed');
    expect(bRow.status).toBe('online');
  });

  it('counts consecutive failures on HTTP error', async () => {
    savePublishedRegistry(
      [{ name: 'a', cloudAgentId: 'c1', publishedAt: '2026-04-20T10:00:00.000Z' }],
      regFile,
    );
    const fetchImpl = fetchFailing(503);
    const loop = startHeartbeatLoop({
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl,
      registryFile: regFile,
      intervalMs: 1_000_000,
      fireImmediately: false,
    });
    await loop.tick();
    await loop.tick();
    await loop.tick();
    loop.stop();
    expect(loop.consecutiveFailures()).toBe(3);
    expect(loop.lastSuccessAt()).toBe(0);
  });

  it('counts consecutive failures on network error', async () => {
    savePublishedRegistry(
      [{ name: 'a', cloudAgentId: 'c1', publishedAt: '2026-04-20T10:00:00.000Z' }],
      regFile,
    );
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as any;
    const loop = startHeartbeatLoop({
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl,
      registryFile: regFile,
      intervalMs: 1_000_000,
      fireImmediately: false,
    });
    await loop.tick();
    await loop.tick();
    loop.stop();
    expect(loop.consecutiveFailures()).toBe(2);
  });

  it('resets failure counter on successful tick', async () => {
    savePublishedRegistry(
      [{ name: 'a', cloudAgentId: 'c1', publishedAt: '2026-04-20T10:00:00.000Z' }],
      regFile,
    );
    let failNext = 2;
    const fetchImpl = vi.fn(async () => {
      if (failNext-- > 0) {
        return { ok: false, status: 500, text: async () => 'fail', json: async () => ({}) } as any;
      }
      return { ok: true, status: 200, text: async () => 'ok', json: async () => ({}) } as any;
    });
    const loop = startHeartbeatLoop({
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl,
      registryFile: regFile,
      intervalMs: 1_000_000,
      fireImmediately: false,
    });
    await loop.tick();
    await loop.tick();
    expect(loop.consecutiveFailures()).toBe(2);
    await loop.tick();
    expect(loop.consecutiveFailures()).toBe(0);
    expect(loop.lastSuccessAt()).toBeGreaterThan(0);
    loop.stop();
  });

  it('stop() prevents subsequent ticks from doing work', async () => {
    savePublishedRegistry(
      [{ name: 'a', cloudAgentId: 'c1', publishedAt: '2026-04-20T10:00:00.000Z' }],
      regFile,
    );
    const fetchImpl = fetchOk();
    const loop = startHeartbeatLoop({
      apiKey: 'sk-x',
      daemonId: 'd1',
      cloudApiBase: 'https://example',
      fetchImpl,
      registryFile: regFile,
      intervalMs: 1_000_000,
      fireImmediately: false,
    });
    loop.stop();
    fetchImpl.mockClear();
    await loop.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
