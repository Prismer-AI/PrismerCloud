import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  installAgent: vi.fn(),
  podStatusVerdict: vi.fn(),
  stampAgentCardDaemonBinding: vi.fn(),
  order: [] as string[],
}));

vi.mock('../db', () => ({ default: {} }));
vi.mock('@/lib/k8s-sandbox', () => ({
  k8sSandbox: { installAgent: mocks.installAgent, podStatusVerdict: mocks.podStatusVerdict },
}));
vi.mock('@/lib/sandbox/agent-card-daemon-binding', () => ({
  stampAgentCardDaemonBinding: mocks.stampAgentCardDaemonBinding,
}));

import { AgentDeviceMoveService } from '../services/agent-device-move.service';

type ServicePrisma = ConstructorParameters<typeof AgentDeviceMoveService>[0];
type ServiceSync = ConstructorParameters<typeof AgentDeviceMoveService>[1];

type BindingRow = {
  id: string;
  agentImUserId: string;
  boundDaemonId: string;
  boundDaemonKind: string;
  boundDaemonLabel: string;
  boundAt: Date;
  boundBy: string;
  lastHostDeclareAt: Date;
  lastDispatchAt: Date | null;
  contestedSince: Date | null;
  contestCount: number;
};

type BindingFindManyArgs = {
  where: {
    agentImUserId?: { in?: string[] };
    boundDaemonId?: { in?: string[] };
  };
};

type BindingFindUniqueArgs = { where: { agentImUserId: string } };
type BindingUpdateArgs = {
  where: { agentImUserId: string };
  data: Partial<Omit<BindingRow, 'contestCount'>> & {
    contestCount?: number | { increment: number };
  };
};

const now = new Date('2026-05-22T00:00:00.000Z');

function binding(agentImUserId: string, boundDaemonId = 'daemon-local'): BindingRow {
  return {
    id: `binding-${agentImUserId}`,
    agentImUserId,
    boundDaemonId,
    boundDaemonKind: boundDaemonId === 'daemon-local' ? 'local' : 'k8s',
    boundDaemonLabel: boundDaemonId,
    boundAt: now,
    boundBy: 'auto-first-declare',
    lastHostDeclareAt: now,
    lastDispatchAt: null,
    contestedSince: null,
    contestCount: 0,
  };
}

function makePrisma(
  overrides: {
    workspace?: Record<string, unknown> | null;
    target?: Record<string, unknown> | null;
    missingProfileAgentId?: string;
  } = {},
) {
  const state = {
    workspace:
      overrides.workspace === undefined
        ? {
            id: 'workspace-1',
            ownerImUserId: 'owner-1',
            orchestratorAgentId: 'agent-ceo',
            orchestratorRevokedAt: null,
          }
        : overrides.workspace,
    cards: [
      { imUserId: 'agent-ceo', name: 'CEO', capabilities: JSON.stringify(['orchestrate']) },
      { imUserId: 'agent-cfo', name: 'CFO', capabilities: JSON.stringify(['finance']) },
      { imUserId: 'agent-cto', name: 'CTO', capabilities: JSON.stringify(['build']) },
    ],
    users: [
      { id: 'agent-ceo', role: 'agent', username: 'ceo', displayName: 'CEO' },
      { id: 'agent-cfo', role: 'agent', username: 'cfo', displayName: 'CFO' },
      { id: 'agent-cto', role: 'agent', username: 'cto', displayName: 'CTO' },
    ],
    profiles: [
      {
        id: 'profile-ceo',
        workspaceId: 'workspace-1',
        agentImUserId: 'agent-ceo',
        adapterName: 'hermes',
        name: 'CEO',
        config: JSON.stringify({ roleTemplate: { slug: 'ceo' }, taskAuthority: 'orchestrator' }),
        version: 4,
      },
      {
        id: 'profile-cfo',
        workspaceId: 'workspace-1',
        agentImUserId: 'agent-cfo',
        adapterName: 'hermes',
        name: 'CFO',
        config: JSON.stringify({ roleTemplate: { slug: 'cfo' }, taskAuthority: 'executor' }),
        version: 2,
      },
      {
        id: 'profile-cto',
        workspaceId: 'workspace-1',
        agentImUserId: 'agent-cto',
        adapterName: 'hermes',
        name: 'CTO',
        config: JSON.stringify({ roleTemplate: { slug: 'cto' }, taskAuthority: 'executor' }),
        version: 2,
      },
    ].filter((profile) => profile.agentImUserId !== overrides.missingProfileAgentId),
    bindings: [binding('agent-ceo'), binding('agent-cfo'), binding('agent-cto', 'daemon-other')],
    target:
      overrides.target === undefined
        ? {
            id: 'container-k8s',
            workspaceId: 'workspace-1',
            podName: 'prismer-agent-target',
            namespace: 'prismer-sandbox',
            agentImUserId: 'runtime-k8s',
            daemonId: 'daemon-k8s',
            status: 'running',
            stoppedAt: null,
            deviceType: 'k8s',
            runtimeKind: 'k8s',
            providerKind: 'k8s',
            maxAgents: 10,
          }
        : overrides.target,
  };

  const prisma = {
    iMWorkspace: {
      findFirst: vi.fn(async () => state.workspace),
    },
    iMAgentCard: {
      findMany: vi.fn(async () => state.cards),
    },
    iMUser: {
      findMany: vi.fn(async (args: { where: { id?: { in?: string[] } } }) => {
        const ids = new Set(args.where.id?.in ?? []);
        return state.users.filter((user) => ids.has(user.id));
      }),
    },
    iMAgentProfile: {
      findMany: vi.fn(async (args: { where: { agentImUserId?: { in?: string[] } } }) => {
        const ids = new Set(args.where.agentImUserId?.in ?? []);
        return state.profiles.filter((profile) => ids.has(profile.agentImUserId));
      }),
    },
    iMContainer: {
      findFirst: vi.fn(async () => state.target),
    },
    iMAgentBinding: {
      findMany: vi.fn(async (args: BindingFindManyArgs) => {
        const ids = new Set(args.where.agentImUserId?.in ?? []);
        const daemons = new Set(args.where.boundDaemonId?.in ?? []);
        return state.bindings.filter((row) => ids.has(row.agentImUserId) && daemons.has(row.boundDaemonId));
      }),
      findUnique: vi.fn(async (args: BindingFindUniqueArgs) => {
        const row = state.bindings.find((candidate) => candidate.agentImUserId === args.where.agentImUserId);
        return row ? { ...row } : null;
      }),
      create: vi.fn(),
      update: vi.fn(async (args: BindingUpdateArgs) => {
        const row = state.bindings.find((candidate) => candidate.agentImUserId === args.where.agentImUserId);
        if (!row) throw new Error('binding not found');
        mocks.order.push(`rebind:${args.where.agentImUserId}`);
        Object.assign(row, args.data, {
          contestCount:
            args.data.contestCount && typeof args.data.contestCount === 'object'
              ? row.contestCount + args.data.contestCount.increment
              : (args.data.contestCount ?? row.contestCount),
        });
        return { ...row };
      }),
    },
    iMAgentSkill: {
      count: vi.fn(async () => 2),
    },
    iMTask: {
      count: vi.fn(async () => 1),
    },
    iMParticipant: {
      count: vi.fn(async () => 3),
    },
    iMMessage: {
      count: vi.fn(async () => 11),
    },
    iMMemoryFile: {
      count: vi.fn(async (args: { where: { scope?: string } }) => (args.where.scope === 'agent-private' ? 1 : 5)),
    },
  };

  return { prisma, state };
}

function newService(prisma: unknown, syncService?: unknown): AgentDeviceMoveService {
  return new AgentDeviceMoveService(prisma as ServicePrisma, syncService as ServiceSync);
}

describe('AgentDeviceMoveService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.installAgent.mockImplementation(async (_podName: string, payload: { imUserId: string }) => {
      mocks.order.push(`install:${payload.imUserId}`);
      return {
        ok: true,
        daemonId: 'daemon-k8s',
        installedAgent: { imUserId: payload.imUserId, name: payload.imUserId, adapterName: 'hermes', profileId: 'p' },
        hostedAgents: [],
      };
    });
    mocks.podStatusVerdict.mockResolvedValue({
      podName: 'prismer-agent-target',
      namespace: 'prismer-sandbox',
      exists: true,
      phase: 'Running',
      reason: null,
      message: null,
      containerStarted: true,
      podIP: '10.244.0.9',
      startedAt: '2026-05-22T00:00:00Z',
      apiError: null,
    });
    mocks.stampAgentCardDaemonBinding.mockImplementation(async (input: { agentImUserId: string }) => {
      mocks.order.push(`stamp:${input.agentImUserId}`);
      return true;
    });
  });

  it('dry-runs all agents bound to the source daemon and reports role/history/memory retention', async () => {
    const { prisma } = makePrisma();
    const service = newService(prisma);

    const result = await service.move({
      workspaceId: 'workspace-1',
      actorImUserId: 'owner-1',
      sourceDaemonId: 'daemon-local',
      targetRuntimeInstallationId: 'container-k8s',
      dryRun: true,
    });

    expect(result).toMatchObject({
      dryRun: true,
      movedCount: 0,
      failedCount: 0,
      plannedCount: 2,
      targetDaemonId: 'daemon-k8s',
    });
    expect(result.agents.map((agent) => agent.agentImUserId)).toEqual(['agent-ceo', 'agent-cfo']);
    expect(result.agents[0]).toMatchObject({
      status: 'planned',
      isCeo: true,
      roleModel: { retained: true, profileId: 'profile-ceo', skillCount: 2 },
      history: { retained: true, conversationCount: 3, messageCount: 11 },
      memory: { retained: true, workspaceSharedCount: 5, agentPrivateCount: 1 },
      localSessionState: { status: 'not_migrated' },
    });
    expect(prisma.iMMessage.count).toHaveBeenCalledWith({
      where: {
        conversation: {
          workspaceId: 'workspace-1',
          participants: { some: { imUserId: 'agent-ceo' } },
        },
      },
    });
    expect(mocks.installAgent).not.toHaveBeenCalled();
    expect(mocks.stampAgentCardDaemonBinding).not.toHaveBeenCalled();
  });

  it('installs each agent before rebinding ownership to the target k8s daemon', async () => {
    const { prisma, state } = makePrisma();
    const syncService = { writeEvent: vi.fn(async () => {}) };
    const service = newService(prisma, syncService);

    const result = await service.move({
      workspaceId: 'workspace-1',
      actorImUserId: 'owner-1',
      sourceDaemonId: 'daemon-local',
      targetRuntimeInstallationId: 'container-k8s',
      reason: 'bulk-local-to-k8s',
    });

    expect(result.movedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(state.bindings.find((row) => row.agentImUserId === 'agent-ceo')?.boundDaemonId).toBe('daemon-k8s');
    expect(state.bindings.find((row) => row.agentImUserId === 'agent-cfo')?.boundDaemonId).toBe('daemon-k8s');
    expect(mocks.order).toEqual([
      'install:agent-ceo',
      'rebind:agent-ceo',
      'stamp:agent-ceo',
      'install:agent-cfo',
      'rebind:agent-cfo',
      'stamp:agent-cfo',
    ]);
    expect(syncService.writeEvent).toHaveBeenCalledWith(
      'agent.binding.rebound',
      expect.objectContaining({ agentImUserId: 'agent-ceo', newDaemonId: 'daemon-k8s' }),
      null,
      'owner-1',
    );
  });

  it('can exclude the unique workspace CEO from a bulk move', async () => {
    const { prisma } = makePrisma();
    const service = newService(prisma);

    const result = await service.move({
      workspaceId: 'workspace-1',
      actorImUserId: 'owner-1',
      sourceDaemonId: 'daemon-local',
      targetRuntimeInstallationId: 'container-k8s',
      dryRun: true,
      includeCeo: false,
    });

    expect(result.agents.map((agent) => agent.agentImUserId)).toEqual(['agent-cfo']);
    expect(result.agents[0].isCeo).toBe(false);
  });

  it('rejects non-owner attempts', async () => {
    const { prisma } = makePrisma();
    const service = newService(prisma);

    await expect(
      service.move({
        workspaceId: 'workspace-1',
        actorImUserId: 'other-user',
        sourceDaemonId: 'daemon-local',
        targetRuntimeInstallationId: 'container-k8s',
      }),
    ).rejects.toMatchObject({ code: 'NOT_WORKSPACE_OWNER', status: 403 });
  });

  it('rejects stopped or non-k8s targets before installing anything', async () => {
    const { prisma } = makePrisma({
      target: {
        id: 'container-local',
        workspaceId: 'workspace-1',
        podName: 'local-daemon',
        namespace: 'local',
        agentImUserId: 'runtime-local',
        daemonId: 'daemon-local-2',
        status: 'running',
        stoppedAt: null,
        deviceType: 'local',
        runtimeKind: 'docker',
        providerKind: 'docker-host',
        maxAgents: 10,
      },
    });
    const service = newService(prisma);

    await expect(
      service.move({
        workspaceId: 'workspace-1',
        actorImUserId: 'owner-1',
        sourceDaemonId: 'daemon-local',
        targetRuntimeInstallationId: 'container-local',
      }),
    ).rejects.toMatchObject({ code: 'TARGET_RUNTIME_NOT_K8S', status: 409 });
    expect(mocks.installAgent).not.toHaveBeenCalled();
  });

  it('rejects stale target runtime rows whose k8s pod no longer exists', async () => {
    const { prisma } = makePrisma();
    mocks.podStatusVerdict.mockResolvedValueOnce({
      podName: 'prismer-agent-target',
      namespace: 'prismer-sandbox',
      exists: false,
      phase: null,
      reason: null,
      message: null,
      containerStarted: false,
      podIP: null,
      startedAt: null,
      apiError: null,
    });
    const service = newService(prisma);

    await expect(
      service.move({
        workspaceId: 'workspace-1',
        actorImUserId: 'owner-1',
        sourceDaemonId: 'daemon-local',
        targetRuntimeInstallationId: 'container-k8s',
      }),
    ).rejects.toMatchObject({ code: 'TARGET_RUNTIME_POD_UNAVAILABLE', status: 409 });
    expect(mocks.installAgent).not.toHaveBeenCalled();
  });

  it('marks an individual agent failed when profile is missing and keeps moving other agents', async () => {
    const { prisma, state } = makePrisma({ missingProfileAgentId: 'agent-cfo' });
    const service = newService(prisma);

    const result = await service.move({
      workspaceId: 'workspace-1',
      actorImUserId: 'owner-1',
      sourceDaemonId: 'daemon-local',
      targetRuntimeInstallationId: 'container-k8s',
    });

    expect(result.movedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.agents.find((agent) => agent.agentImUserId === 'agent-cfo')).toMatchObject({
      status: 'failed',
      error: { code: 'AGENT_PROFILE_MISSING' },
    });
    expect(state.bindings.find((row) => row.agentImUserId === 'agent-cfo')?.boundDaemonId).toBe('daemon-local');
  });
});
