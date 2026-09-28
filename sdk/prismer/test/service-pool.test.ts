import { describe, expect, it, vi } from 'vitest';

import type { AdapterDef, AdapterService, AgentProfile } from '../src/adapters/contract.js';
import { ServicePool } from '../src/daemon/service-pool.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function profile(id: string): AgentProfile {
  return {
    id,
    workspaceId: 'ws-service-pool',
    agentImUserId: `agent-${id}`,
    agentUsername: `agent-${id}`,
    adapterName: 'hermes',
    name: 'default',
    config: {},
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

type TestService = AdapterService & {
  crash(error?: Error): void;
  healthyMock: ReturnType<typeof vi.fn>;
  shutdownMock: ReturnType<typeof vi.fn>;
};

function service(id: string, healthy = true): TestService {
  const crashListeners: Array<(error: Error) => void> = [];
  const healthyMock = vi.fn(async () => healthy);
  const shutdownMock = vi.fn(async () => undefined);
  return {
    id,
    dispatch: vi.fn(async () => ({ ok: true, output: id })),
    healthy: healthyMock,
    shutdown: shutdownMock,
    on: (event, callback) => {
      if (event === 'crash') crashListeners.push(callback);
    },
    crash: (error = new Error(`${id} crashed`)) => {
      for (const listener of crashListeners) listener(error);
    },
    healthyMock,
    shutdownMock,
  };
}

function adapter(creator: (agentProfile: AgentProfile) => Promise<AdapterService>): AdapterDef {
  return {
    name: 'hermes',
    kind: 'long-running',
    capabilities: [],
    workspaceSchema: {} as AdapterDef['workspaceSchema'],
    validate: () => ({ ok: true }),
    health: async () => ({ available: true }),
    ensureService: vi.fn(creator),
  };
}

function trackedProfileCount(pool: ServicePool): number {
  return (pool as unknown as { states: Map<string, unknown> }).states.size;
}

describe('ServicePool lifecycle fencing', () => {
  it('single-flights concurrent ensureService calls for one profile', async () => {
    const pool = new ServicePool();
    const created = deferred<AdapterService>();
    const svc = service('single-flight');
    const def = adapter(async () => created.promise);

    const first = pool.ensureService(profile('same'), def);
    const second = pool.ensureService(profile('same'), def);
    await Promise.resolve();

    expect(def.ensureService).toHaveBeenCalledTimes(1);
    created.resolve(svc);
    await expect(first).resolves.toBe(svc);
    await expect(second).resolves.toBe(svc);
  });

  it('drop fences a pending creator so its handle cannot publish', async () => {
    const pool = new ServicePool();
    const created = deferred<AdapterService>();
    const svc = service('late-after-drop');
    const def = adapter(async () => created.promise);

    const pendingEnsure = pool.ensureService(profile('drop-pending'), def);
    await Promise.resolve();
    const dropping = pool.drop('drop-pending');
    created.resolve(svc);

    await expect(pendingEnsure).rejects.toThrow(/invalidated/i);
    await dropping;
    expect(pool.peek('drop-pending')).toBeUndefined();
    expect(svc.shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('prevents ABA overwrite when A resolves after invalidate and B ensure begins', async () => {
    const pool = new ServicePool();
    const createdA = deferred<AdapterService>();
    const svcA = service('A');
    const svcB = service('B');
    let calls = 0;
    const def = adapter(async () => {
      calls += 1;
      return calls === 1 ? createdA.promise : svcB;
    });

    const pendingA = pool.ensureService(profile('aba'), def);
    await Promise.resolve();
    const invalidating = pool.drop('aba');
    const pendingB = pool.ensureService(profile('aba'), def);
    await Promise.resolve();

    expect(def.ensureService).toHaveBeenCalledTimes(1);
    createdA.resolve(svcA);
    await expect(pendingA).rejects.toThrow(/invalidated/i);
    await invalidating;
    await expect(pendingB).resolves.toBe(svcB);
    expect(pool.peek('aba')).toBe(svcB);
    expect(svcA.shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a stale service crash evict its replacement', async () => {
    const pool = new ServicePool();
    const svcA = service('stale-A');
    const svcB = service('current-B');
    const handles = [svcA, svcB];
    const def = adapter(async () => handles.shift()!);

    await pool.ensureService(profile('crash-identity'), def);
    await pool.drop('crash-identity');
    await pool.ensureService(profile('crash-identity'), def);
    svcA.crash();

    expect(pool.peek('crash-identity')).toBe(svcB);
  });

  it('keeps the profile fenced until cached disposal and the external disposer finish', async () => {
    const pool = new ServicePool();
    const stale = service('atomic-stale');
    const replacement = service('atomic-replacement');
    const disposerRelease = deferred<void>();
    const order: string[] = [];
    stale.shutdownMock.mockImplementationOnce(async () => {
      order.push('shutdown-handle');
    });
    const handles = [stale, replacement];
    const def = adapter(async () => handles.shift()!);

    await pool.ensureService(profile('atomic'), def);
    const invalidating = pool.invalidate('atomic', async () => {
      order.push('external-disposer-start');
      await disposerRelease.promise;
      order.push('external-disposer-end');
    });
    const nextEnsure = pool.ensureService(profile('atomic'), def);
    for (let tick = 0; tick < 10 && order.length < 2; tick += 1) await Promise.resolve();

    expect(order).toEqual(['shutdown-handle', 'external-disposer-start']);
    expect(def.ensureService).toHaveBeenCalledTimes(1);
    disposerRelease.resolve();
    await invalidating;
    await expect(nextEnsure).resolves.toBe(replacement);
    expect(def.ensureService).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['shutdown-handle', 'external-disposer-start', 'external-disposer-end']);
  });

  it('quiesces and shuts down a pending old creator before entering the external disposer', async () => {
    const pool = new ServicePool();
    const createdA = deferred<AdapterService>();
    const staleA = service('atomic-pending-A');
    const replacementB = service('atomic-pending-B');
    const disposerRelease = deferred<void>();
    const order: string[] = [];
    staleA.shutdownMock.mockImplementationOnce(async () => {
      order.push('shutdown-pending-A');
    });
    let calls = 0;
    const def = adapter(async () => {
      calls += 1;
      return calls === 1 ? createdA.promise : replacementB;
    });

    const pendingA = pool.ensureService(profile('atomic-pending'), def);
    await Promise.resolve();
    const invalidating = pool.invalidate('atomic-pending', async () => {
      order.push('external-disposer-start');
      await disposerRelease.promise;
      order.push('external-disposer-end');
    });
    const pendingB = pool.ensureService(profile('atomic-pending'), def);
    createdA.resolve(staleA);

    await expect(pendingA).rejects.toThrow(/invalidated/i);
    for (let tick = 0; tick < 10 && order.length < 2; tick += 1) await Promise.resolve();
    expect(order).toEqual(['shutdown-pending-A', 'external-disposer-start']);
    expect(def.ensureService).toHaveBeenCalledTimes(1);
    expect(pool.peek('atomic-pending')).toBeUndefined();

    disposerRelease.resolve();
    await invalidating;
    await expect(pendingB).resolves.toBe(replacementB);
    expect(def.ensureService).toHaveBeenCalledTimes(2);
    expect(pool.peek('atomic-pending')).toBe(replacementB);
  });

  it('clears a rejected single-flight so the next ensure retries', async () => {
    const pool = new ServicePool();
    const recovered = service('recovered');
    let calls = 0;
    const def = adapter(async () => {
      calls += 1;
      if (calls === 1) throw new Error('creator failed');
      return recovered;
    });

    const first = pool.ensureService(profile('retry'), def);
    const joined = pool.ensureService(profile('retry'), def);
    await expect(first).rejects.toThrow('creator failed');
    await expect(joined).rejects.toThrow('creator failed');
    await expect(pool.ensureService(profile('retry'), def)).resolves.toBe(recovered);
    expect(def.ensureService).toHaveBeenCalledTimes(2);
  });

  it('reclaims idle profile state after drop, creator rejection, and crash', async () => {
    const pool = new ServicePool();
    const dropped = service('dropped');
    await pool.ensureService(profile('dropped-profile'), adapter(async () => dropped));
    await pool.drop('dropped-profile');
    expect(trackedProfileCount(pool)).toBe(0);

    await expect(
      pool.ensureService(
        profile('rejected-profile'),
        adapter(async () => {
          throw new Error('rejected creator');
        }),
      ),
    ).rejects.toThrow('rejected creator');
    expect(trackedProfileCount(pool)).toBe(0);

    const crashed = service('crashed');
    await pool.ensureService(profile('crashed-profile'), adapter(async () => crashed));
    crashed.crash();
    expect(trackedProfileCount(pool)).toBe(0);
  });

  it('single-flights concurrent replacement of an unhealthy cached service', async () => {
    const pool = new ServicePool();
    const stale = service('unhealthy');
    const replacement = service('replacement');
    const replacementCreated = deferred<AdapterService>();
    let calls = 0;
    const def = adapter(async () => {
      calls += 1;
      return calls === 1 ? stale : replacementCreated.promise;
    });

    await pool.ensureService(profile('unhealthy-profile'), def);
    stale.healthyMock.mockResolvedValue(false);
    const first = pool.ensureService(profile('unhealthy-profile'), def);
    const second = pool.ensureService(profile('unhealthy-profile'), def);
    for (let tick = 0; tick < 10 && vi.mocked(def.ensureService!).mock.calls.length < 2; tick += 1) {
      await Promise.resolve();
    }

    expect(def.ensureService).toHaveBeenCalledTimes(2);
    replacementCreated.resolve(replacement);
    await expect(first).resolves.toBe(replacement);
    await expect(second).resolves.toBe(replacement);
    expect(stale.shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('does not return a cached handle that crashes while its health probe is pending', async () => {
    const pool = new ServicePool();
    const stale = service('health-race-stale');
    const replacement = service('health-race-replacement');
    const healthResult = deferred<boolean>();
    const handles = [stale, replacement];
    const def = adapter(async () => handles.shift()!);

    await pool.ensureService(profile('health-race'), def);
    stale.healthyMock.mockImplementationOnce(async () => healthResult.promise);
    const ensuring = pool.ensureService(profile('health-race'), def);
    await Promise.resolve();
    stale.crash();
    healthResult.resolve(true);

    await expect(ensuring).resolves.toBe(replacement);
    expect(pool.peek('health-race')).toBe(replacement);
    expect(def.ensureService).toHaveBeenCalledTimes(2);
    expect(stale.shutdownMock).not.toHaveBeenCalled();
  });

  it('allows different profiles to create in parallel', async () => {
    const pool = new ServicePool();
    const createdA = deferred<AdapterService>();
    const createdB = deferred<AdapterService>();
    const svcA = service('parallel-A');
    const svcB = service('parallel-B');
    const def = adapter(async (agentProfile) =>
      agentProfile.id === 'parallel-A' ? createdA.promise : createdB.promise,
    );

    const pendingA = pool.ensureService(profile('parallel-A'), def);
    const pendingB = pool.ensureService(profile('parallel-B'), def);
    await Promise.resolve();

    expect(def.ensureService).toHaveBeenCalledTimes(2);
    createdB.resolve(svcB);
    await expect(pendingB).resolves.toBe(svcB);
    createdA.resolve(svcA);
    await expect(pendingA).resolves.toBe(svcA);
  });

  it('shutdown fences late publishers and shuts each handle down exactly once', async () => {
    const pool = new ServicePool();
    const createdA = deferred<AdapterService>();
    const createdB = deferred<AdapterService>();
    const shared = service('shared-handle');
    const def = adapter(async (agentProfile) =>
      agentProfile.id === 'shutdown-A' ? createdA.promise : createdB.promise,
    );

    const pendingA = pool.ensureService(profile('shutdown-A'), def);
    const pendingB = pool.ensureService(profile('shutdown-B'), def);
    await Promise.resolve();
    const shuttingDown = pool.shutdown();
    createdA.resolve(shared);
    createdB.resolve(shared);

    await expect(pendingA).rejects.toThrow(/invalidated|shutting down/i);
    await expect(pendingB).rejects.toThrow(/invalidated|shutting down/i);
    await shuttingDown;
    expect(pool.size()).toBe(0);
    expect(shared.shutdownMock).toHaveBeenCalledTimes(1);
    await pool.drop('shutdown-A');
    expect(shared.shutdownMock).toHaveBeenCalledTimes(1);
    await expect(pool.ensureService(profile('after-shutdown'), def)).rejects.toThrow(/shut down/i);
  });
});
