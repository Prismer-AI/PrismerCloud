import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    iMWorkspace: { findFirst: vi.fn() },
    iMAgentCard: { findMany: vi.fn() },
    iMAgentBinding: { findMany: vi.fn() },
    iMContainer: { findMany: vi.fn() },
  },
}));

vi.mock('../db', () => ({ default: prismaMock }));

import { buildSnapshot } from '../api/workspace-runtime';

interface RedisFixture {
  smembers: ReturnType<typeof vi.fn>;
  pipeline: ReturnType<typeof vi.fn>;
  srem: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
}

function makeRedis(agentPresenceById: Record<string, unknown> = {}): RedisFixture {
  return {
    smembers: vi.fn(async () => []),
    srem: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
    pipeline: vi.fn(() => {
      const keys: string[] = [];
      return {
        get: vi.fn((key: string) => {
          keys.push(key);
          return undefined;
        }),
        exec: vi.fn(async () =>
          keys.map((key) => {
            const agentImUserId = key.replace('presence:agent:', '');
            const value = agentPresenceById[agentImUserId];
            return [null, value ? JSON.stringify(value) : null];
          }),
        ),
      };
    }),
  };
}

function agentCard(input: { imUserId: string; metadataDaemonId?: string | null; name?: string }) {
  return {
    imUserId: input.imUserId,
    name: input.name ?? input.imUserId,
    metadata:
      input.metadataDaemonId === undefined
        ? '{}'
        : JSON.stringify({ daemonId: input.metadataDaemonId }),
    status: 'offline',
    lastHeartbeat: null,
    imUser: { displayName: input.name ?? input.imUserId, username: input.imUserId },
  };
}

describe('workspace runtime snapshot agent binding authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.iMWorkspace.findFirst.mockResolvedValue({ metadata: '{}' });
    prismaMock.iMAgentCard.findMany.mockResolvedValue([]);
    prismaMock.iMAgentBinding.findMany.mockResolvedValue([]);
    prismaMock.iMContainer.findMany.mockResolvedValue([]);
  });

  it('groups agents by im_agent_bindings.boundDaemonId instead of stale metadata/presence projection', async () => {
    prismaMock.iMAgentCard.findMany.mockResolvedValue([
      agentCard({ imUserId: 'agent-CEO', metadataDaemonId: 'daemon-stale', name: 'CEO' }),
    ]);
    prismaMock.iMAgentBinding.findMany.mockResolvedValue([
      { agentImUserId: 'agent-CEO', boundDaemonId: 'daemon-authority' },
    ]);
    prismaMock.iMContainer.findMany.mockResolvedValue([
      {
        daemonId: 'daemon-authority',
        transport: 'both',
        gatewayIsPrivate: false,
        lastProbeAt: new Date('2026-05-22T00:00:00.000Z'),
      },
    ]);

    const snapshot = await buildSnapshot(
      'ws-1',
      makeRedis({
        'agent-CEO': {
          status: 'online',
          deviceId: 'daemon-stale',
          lastHeartbeat: Date.parse('2026-05-22T00:01:00.000Z'),
        },
      }) as unknown as Redis,
    );

    expect(snapshot.devices.map((device) => device.deviceId)).toContain('daemon-authority');
    expect(snapshot.devices.map((device) => device.deviceId)).not.toContain('daemon-stale');
    const device = snapshot.devices.find((row) => row.deviceId === 'daemon-authority');
    expect(device?.transport).toBe('both');
    expect(device?.agents[0]).toMatchObject({
      id: 'agent-CEO',
      authoritativeDaemonId: 'daemon-authority',
      projectedDaemonId: 'daemon-stale',
      bindingMismatch: true,
    });
  });

  it('filters forgotten daemons by authoritative binding daemonId, not legacy metadata daemonId', async () => {
    prismaMock.iMWorkspace.findFirst.mockResolvedValue({
      metadata: JSON.stringify({ runtimeBindings: { forgottenDaemonIds: ['daemon-authority'] } }),
    });
    prismaMock.iMAgentCard.findMany.mockResolvedValue([
      agentCard({ imUserId: 'agent-CEO', metadataDaemonId: 'daemon-visible', name: 'CEO' }),
    ]);
    prismaMock.iMAgentBinding.findMany.mockResolvedValue([
      { agentImUserId: 'agent-CEO', boundDaemonId: 'daemon-authority' },
    ]);

    const snapshot = await buildSnapshot('ws-1', makeRedis() as unknown as Redis);

    expect(snapshot.devices).toEqual([]);
  });

  it('falls back to metadata.daemonId for legacy agents without a binding row', async () => {
    prismaMock.iMAgentCard.findMany.mockResolvedValue([
      agentCard({ imUserId: 'agent-Legacy', metadataDaemonId: 'daemon-legacy', name: 'Legacy' }),
    ]);
    prismaMock.iMAgentBinding.findMany.mockResolvedValue([]);

    const snapshot = await buildSnapshot('ws-1', makeRedis() as unknown as Redis);

    expect(snapshot.devices).toHaveLength(1);
    expect(snapshot.devices[0].deviceId).toBe('daemon-legacy');
    expect(snapshot.devices[0].agents[0]).toMatchObject({
      id: 'agent-Legacy',
      authoritativeDaemonId: 'daemon-legacy',
      projectedDaemonId: 'daemon-legacy',
    });
  });
});
