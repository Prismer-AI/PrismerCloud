import { describe, expect, it, vi } from 'vitest';
import { resolveMcpAllowlist } from '../src/adapters/persistence/hermes/index.js';
import { Runner } from '../src/daemon/runner.js';
import { ServicePool } from '../src/daemon/service-pool.js';
import type { AdapterDef, AdapterService, AgentProfile } from '../src/adapters/contract.js';

describe('ACP L2 runtime profile handling', () => {
  it('resolves MCP allowlist with agent config taking priority over role template', () => {
    expect(
      resolveMcpAllowlist({
        mcpAllowlist: [' prismer.task.create ', ''],
        roleTemplate: {
          mcpServers: [{ package: '@prismer/mcp-server', toolsAllowlist: ['prismer.task.approve'] }],
        },
      }),
    ).toEqual(['prismer.task.create']);
  });

  it('falls back to @prismer/mcp-server role-template allowlist only', () => {
    expect(
      resolveMcpAllowlist({
        roleTemplate: {
          mcpServers: [
            { package: '@other/server', toolsAllowlist: ['other.tool'] },
            { package: '@prismer/mcp-server', toolsAllowlist: ['prismer.task.*'] },
          ],
        },
      }),
    ).toEqual(['prismer.task.*']);
  });

  it('returns null when no allowlist exists for backward compatibility', () => {
    expect(resolveMcpAllowlist({ roleTemplate: { mcpServers: [] } })).toBeNull();
  });

  it('drops stale long-running service state before syncing changed profiles', async () => {
    const runner = new Runner({ startLocalServer: false }) as unknown as {
      declareGuard: { onAccepted: ReturnType<typeof vi.fn> };
      servicePool: { drop: ReturnType<typeof vi.fn> };
      syncProfileFromCloud: ReturnType<typeof vi.fn>;
      syncAssetMetadata: ReturnType<typeof vi.fn>;
      wsConnected: boolean;
      onHostAcked(payload: { workspaceId: string; profilesToSync: string[] }): Promise<void>;
    };
    runner.declareGuard = { onAccepted: vi.fn() };
    runner.servicePool = { drop: vi.fn().mockResolvedValue(undefined) };
    runner.syncProfileFromCloud = vi.fn().mockResolvedValue(undefined);
    runner.syncAssetMetadata = vi.fn().mockResolvedValue(undefined);
    runner.wsConnected = false;

    await runner.onHostAcked({ workspaceId: 'ws_1', profilesToSync: ['profile_1'] });

    expect(runner.servicePool.drop).toHaveBeenCalledWith('profile_1');
    expect(runner.syncProfileFromCloud).toHaveBeenCalledWith('profile_1', 'startup');
    expect(runner.servicePool.drop.mock.invocationCallOrder[0]).toBeLessThan(
      runner.syncProfileFromCloud.mock.invocationCallOrder[0],
    );
  });

  it('overlaps independent host.acked adoptions with a bounded fan-out', async () => {
    const runner = new Runner({ startLocalServer: false }) as unknown as {
      servicePool: { drop: ReturnType<typeof vi.fn> };
      syncProfileFromCloud: ReturnType<typeof vi.fn>;
      loadAgentsFromDb: ReturnType<typeof vi.fn>;
      syncHostAckAdoptions(
        reclaimed: Array<{ imUserId: string; profileIds: string[] }>,
        adopted: Array<{ imUserId: string; profileIds: string[] }>,
      ): Promise<boolean>;
    };
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    runner.servicePool = { drop: vi.fn().mockResolvedValue(undefined) };
    runner.syncProfileFromCloud = vi.fn(async (profileId: string) => {
      started.push(profileId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.set(profileId, resolve));
      active -= 1;
    });
    runner.loadAgentsFromDb = vi.fn();

    const adoption = runner.syncHostAckAdoptions([], [
      { imUserId: 'agent_a', profileIds: ['profile_a'] },
      { imUserId: 'agent_b', profileIds: ['profile_b'] },
      { imUserId: 'agent_c', profileIds: ['profile_c'] },
      { imUserId: 'agent_d', profileIds: ['profile_d'] },
    ]);

    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(started).toEqual(['profile_a', 'profile_b', 'profile_c']);
    expect(maxActive).toBe(3);
    expect(started).not.toContain('profile_d');

    releases.get('profile_a')?.();
    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(active).toBe(3);
    for (const profileId of ['profile_b', 'profile_c']) releases.get(profileId)?.();
    releases.get('profile_d')?.();

    await expect(adoption).resolves.toBe(true);
    expect(maxActive).toBe(3);
    expect(runner.loadAgentsFromDb).toHaveBeenCalledTimes(1);
  });

  it('stops declaring agents rejected by host.acked ownership lock', async () => {
    const runner = new Runner({ startLocalServer: false }) as unknown as {
      hostedAgents: Map<string, unknown>;
      servicePool: { drop: ReturnType<typeof vi.fn> };
      db: {
        prepare: ReturnType<typeof vi.fn>;
      };
      applyHostAckOwnershipLock(payload: {
        rejectedAgents: Array<{ imUserId: string; reason: 'bound-to-other-daemon'; ownerDaemonId: string }>;
      }): Promise<boolean>;
    };
    runner.hostedAgents.set('agent_rejected', {
      imUserId: 'agent_rejected',
      name: 'Team Manager',
      adapterName: 'hermes',
      capabilities: [],
      profiles: new Map([['profile_rejected', 1]]),
    });
    runner.servicePool = { drop: vi.fn().mockResolvedValue(undefined) };
    const deletedAgents: string[] = [];
    runner.db = {
      prepare: vi.fn((sql: string) => {
        if (sql.startsWith('SELECT id FROM agent_profiles')) {
          return { all: vi.fn(() => [{ id: 'profile_rejected' }]) };
        }
        if (sql.startsWith('DELETE FROM agents')) {
          return {
            run: vi.fn((agentImUserId: string) => {
              deletedAgents.push(agentImUserId);
              return { changes: 1 };
            }),
          };
        }
        throw new Error(`unexpected sql: ${sql}`);
      }),
    };

    const changed = await runner.applyHostAckOwnershipLock({
      rejectedAgents: [
        {
          imUserId: 'agent_rejected',
          reason: 'bound-to-other-daemon',
          ownerDaemonId: 'daemon_owner',
        },
      ],
    });

    expect(changed).toBe(true);
    expect(runner.hostedAgents.has('agent_rejected')).toBe(false);
    expect(deletedAgents).toEqual(['agent_rejected']);
    expect(runner.servicePool.drop).toHaveBeenCalledWith('profile_rejected');
  });

  it('isolates long-running services per agent profile on the same daemon', async () => {
    const pool = new ServicePool();
    const services: AdapterService[] = [
      { healthy: vi.fn().mockResolvedValue(true), dispatch: vi.fn() },
      { healthy: vi.fn().mockResolvedValue(true), dispatch: vi.fn() },
    ];
    const adapter: AdapterDef = {
      name: 'hermes',
      kind: 'long-running',
      capabilities: ['mcp'],
      validate: () => ({ ok: true }),
      ensureService: vi.fn(async () => services.shift()!),
    };
    const profileA = profileFor('profile_a', ['prismer.task.create']);
    const profileB = profileFor('profile_b', ['prismer.task.approve']);

    const serviceA = await pool.ensureService(profileA, adapter);
    const serviceB = await pool.ensureService(profileB, adapter);
    const serviceAAgain = await pool.ensureService(profileA, adapter);

    expect(serviceA).not.toBe(serviceB);
    expect(serviceAAgain).toBe(serviceA);
    expect(adapter.ensureService).toHaveBeenCalledTimes(2);
    expect(adapter.ensureService).toHaveBeenNthCalledWith(1, profileA);
    expect(adapter.ensureService).toHaveBeenNthCalledWith(2, profileB);
    expect(pool.size()).toBe(2);
  });
});

function profileFor(id: string, mcpAllowlist: string[]): AgentProfile {
  return {
    id,
    workspaceId: 'ws_1',
    agentImUserId: `agent_${id}`,
    agentUsername: id,
    adapterName: 'hermes',
    name: 'default',
    config: {
      apiKey: 'hermes-key',
      hermesProfileName: id,
      mcpAllowlist,
    },
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
