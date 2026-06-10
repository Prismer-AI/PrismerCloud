import { describe, expect, it, vi } from 'vitest';
import {
  stampAgentCardDaemonBinding,
  type AgentCardDaemonBindingPrisma,
} from '@/lib/sandbox/agent-card-daemon-binding';

type FindFirstArgs = Parameters<AgentCardDaemonBindingPrisma['iMAgentCard']['findFirst']>[0];
type UpdateArgs = Parameters<AgentCardDaemonBindingPrisma['iMAgentCard']['update']>[0];

function makePrisma(card: { imUserId: string; metadata: string | null } | null) {
  const updates: UpdateArgs[] = [];
  const prisma: AgentCardDaemonBindingPrisma = {
    iMAgentCard: {
      findFirst: vi.fn(async (_args: FindFirstArgs) => card),
      update: vi.fn(async (args: UpdateArgs) => {
        updates.push(args);
        return {};
      }),
    },
  };
  return { prisma, updates };
}

describe('stampAgentCardDaemonBinding', () => {
  it('preserves metadata and stamps the exact persisted daemonId', async () => {
    const { prisma, updates } = makePrisma({
      imUserId: 'agent-1',
      metadata: JSON.stringify({ daemonId: 'container:old', theme: 'blue' }),
    });

    const changed = await stampAgentCardDaemonBinding({
      prisma,
      workspaceId: 'workspace-1',
      agentImUserId: 'agent-1',
      daemonId: 'daemon-actual-uuid',
      runtimeInstallationId: 'container-row-1',
      runtimeInstalledAt: '2026-05-19T00:00:00.000Z',
    });

    expect(changed).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].where).toEqual({ imUserId: 'agent-1' });
    expect(JSON.parse(updates[0].data.metadata)).toEqual({
      daemonId: 'daemon-actual-uuid',
      theme: 'blue',
      runtimeInstallationId: 'container-row-1',
      runtimeInstalledAt: '2026-05-19T00:00:00.000Z',
    });
  });

  it('does not update when the card is absent', async () => {
    const { prisma, updates } = makePrisma(null);

    const changed = await stampAgentCardDaemonBinding({
      prisma,
      workspaceId: 'workspace-1',
      agentImUserId: 'missing-agent',
      daemonId: 'daemon-actual-uuid',
    });

    expect(changed).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('replaces malformed metadata and logs the repair', async () => {
    const logger = { warn: vi.fn() };
    const { prisma, updates } = makePrisma({
      imUserId: 'agent-1',
      metadata: '{not-json',
    });

    const changed = await stampAgentCardDaemonBinding({
      prisma,
      logger,
      workspaceId: 'workspace-1',
      agentImUserId: 'agent-1',
      daemonId: 'daemon-actual-uuid',
    });

    expect(changed).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(updates[0].data.metadata)).toEqual({ daemonId: 'daemon-actual-uuid' });
  });
});
