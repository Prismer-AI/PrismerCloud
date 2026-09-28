import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import type { SkillResolutionHealth } from '../src/daemon/skill-source-resolution.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';

let server: LocalServer | undefined;

function state(skillResolution?: SkillResolutionHealth): LocalServerState {
  return {
    daemonId: 'skill-health-test',
    daemonVersion: '2.2.5-test',
    pid: 42,
    startedAt: Date.now(),
    wsConnected: false,
    hostedAgents: [],
    runningTaskIds: [],
    ...(skillResolution ? { skillResolution } : {}),
  };
}

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('GET /healthz skillResolution contract', () => {
  it('projects the sampled counters and last source verbatim with one state read', async () => {
    const snapshot = {
      counts: { remote: 4, lkg: 2, bundledFallback: 1, failed: 3 },
      last: {
        slug: 'memory',
        source: 'lkg' as const,
        revision: 'rev-1',
        contentHash: 'hash-1',
        staleReason: 'remote unavailable',
      },
      sampledAt: 123456,
    } satisfies SkillResolutionHealth;
    const getState = vi.fn(() => state(snapshot));
    server = new LocalServer({ port: 0, getState });
    await server.start();

    const response = await fetch(`${boundBaseUrl(server)}/healthz`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.skillResolution).toEqual(snapshot);
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it('omits the field for legacy embedders and preserves unknown future subfields', async () => {
    server = new LocalServer({ port: 0, getState: () => state() });
    await server.start();
    const legacy = (await (await fetch(`${boundBaseUrl(server)}/healthz`)).json()) as Record<string, unknown>;
    expect(legacy).not.toHaveProperty('skillResolution');
    await server.stop();

    const futureSnapshot = {
      counts: { remote: 0, lkg: 0, bundledFallback: 0, failed: 0 },
      sampledAt: 654321,
      futureField: { mode: 'future-compatible' },
    } as SkillResolutionHealth & { futureField: { mode: string } };
    server = new LocalServer({ port: 0, getState: () => state(futureSnapshot) });
    await server.start();
    const future = (await (await fetch(`${boundBaseUrl(server)}/healthz`)).json()) as {
      skillResolution: Record<string, unknown>;
    };
    expect(future.skillResolution.futureField).toEqual({ mode: 'future-compatible' });
  });
});
