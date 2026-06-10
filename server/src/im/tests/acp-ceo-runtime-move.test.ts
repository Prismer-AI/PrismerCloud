import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  installAgent: vi.fn(),
  podStatusVerdict: vi.fn(),
  stampAgentCardDaemonBinding: vi.fn(),
}));

vi.mock('../db', () => ({ default: {} }));
vi.mock('@/lib/k8s-sandbox', () => ({
  k8sSandbox: { installAgent: mocks.installAgent, podStatusVerdict: mocks.podStatusVerdict },
}));
vi.mock('@/lib/sandbox/agent-card-daemon-binding', () => ({
  stampAgentCardDaemonBinding: mocks.stampAgentCardDaemonBinding,
}));

import { CeoRuntimeMoveError, CeoRuntimeMoveService } from '../services/ceo-runtime-move.service';

const now = new Date('2026-05-22T00:00:00.000Z');
type ServicePrisma = ConstructorParameters<typeof CeoRuntimeMoveService>[0];
type ServiceSync = ConstructorParameters<typeof CeoRuntimeMoveService>[1];
type UserFindUniqueArgs = { where: { id: string } };
type BindingUpdateArgs = {
  data: Partial<Omit<BindingRow, 'contestCount'>> & {
    contestCount?: number | { increment: number };
  };
};

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

function baseBinding(): BindingRow {
  return {
    id: 'binding-1',
    agentImUserId: 'agent-ceo',
    boundDaemonId: 'daemon-local',
    boundDaemonKind: 'local',
    boundDaemonLabel: 'Local daemon',
    boundAt: new Date('2026-05-21T00:00:00.000Z'),
    boundBy: 'auto-first-declare',
    lastHostDeclareAt: new Date('2026-05-21T00:00:00.000Z'),
    lastDispatchAt: null,
    contestedSince: now,
    contestCount: 1,
  };
}

function makePrisma(
  overrides: {
    workspace?: Record<string, unknown> | null;
    container?: Record<string, unknown> | null;
    profileConfig?: Record<string, unknown>;
    binding?: BindingRow | null;
    inFlightTaskCount?: number;
    conversationCount?: number;
    messageCount?: number;
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
    agent: {
      id: 'agent-ceo',
      role: 'agent',
      username: 'ceo',
      displayName: 'CEO',
    },
    card: {
      imUserId: 'agent-ceo',
      name: 'CEO',
      capabilities: JSON.stringify(['orchestrate']),
    },
    profile: {
      id: 'profile-ceo',
      workspaceId: 'workspace-1',
      agentImUserId: 'agent-ceo',
      adapterName: 'hermes',
      name: 'CEO',
      config: JSON.stringify(
        overrides.profileConfig ?? {
          roleTemplate: { slug: 'ceo' },
          taskAuthority: 'orchestrator',
        },
      ),
      version: 7,
    },
    container:
      overrides.container === undefined
        ? {
            id: 'container-k8s',
            workspaceId: 'workspace-1',
            podName: 'prismer-agent-ceo',
            namespace: 'prismer-sandbox',
            agentImUserId: 'runtime-ceo',
            daemonId: 'daemon-k8s',
            status: 'running',
            stoppedAt: null,
            deviceType: 'k8s',
            runtimeKind: 'k8s',
            providerKind: 'k8s',
          }
        : overrides.container,
    binding: overrides.binding === undefined ? baseBinding() : overrides.binding,
  };

  const prisma = {
    iMWorkspace: {
      findFirst: vi.fn(async () => state.workspace),
    },
    iMUser: {
      findUnique: vi.fn(async ({ where }: UserFindUniqueArgs) => (where.id === state.agent.id ? state.agent : null)),
    },
    iMAgentCard: {
      findFirst: vi.fn(async () => state.card),
      findMany: vi.fn(async () => []),
    },
    iMAgentProfile: {
      findFirst: vi.fn(async () => state.profile),
    },
    iMContainer: {
      findFirst: vi.fn(async () => state.container),
    },
    iMAgentBinding: {
      findUnique: vi.fn(async () => (state.binding ? { ...state.binding } : null)),
      findMany: vi.fn(async () => (state.binding ? [{ ...state.binding }] : [])),
      create: vi.fn(),
      update: vi.fn(async ({ data }: BindingUpdateArgs) => {
        if (!state.binding) throw new Error('binding missing');
        state.binding = {
          ...state.binding,
          ...data,
          contestCount:
            data.contestCount && typeof data.contestCount === 'object' && 'increment' in data.contestCount
              ? state.binding.contestCount + data.contestCount.increment
              : (data.contestCount ?? state.binding.contestCount),
        };
        return { ...state.binding };
      }),
    },
    iMTask: {
      count: vi.fn(async () => overrides.inFlightTaskCount ?? 2),
    },
    iMParticipant: {
      count: vi.fn(async () => overrides.conversationCount ?? 3),
    },
    iMMessage: {
      count: vi.fn(async () => overrides.messageCount ?? 12),
    },
  };

  return { prisma, state };
}

function newService(prisma: unknown, syncService?: unknown): CeoRuntimeMoveService {
  return new CeoRuntimeMoveService(prisma as ServicePrisma, syncService as ServiceSync);
}

describe('CeoRuntimeMoveService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.installAgent.mockResolvedValue({
      ok: true,
      daemonId: 'daemon-k8s',
      installedAgent: {
        imUserId: 'agent-ceo',
        name: 'CEO',
        adapterName: 'hermes',
        profileId: 'profile-ceo',
      },
      hostedAgents: [],
    });
    mocks.podStatusVerdict.mockResolvedValue({
      podName: 'prismer-agent-ceo',
      namespace: 'prismer-sandbox',
      exists: true,
      phase: 'Running',
      reason: null,
      message: null,
      containerStarted: true,
      podIP: '10.244.0.10',
      startedAt: '2026-05-22T00:00:00Z',
      apiError: null,
    });
    mocks.stampAgentCardDaemonBinding.mockResolvedValue(true);
  });

  it('dry-runs the unique workspace CEO move without installing or rebinding', async () => {
    const { prisma } = makePrisma();
    const service = newService(prisma);

    const result = await service.move({
      workspaceId: 'workspace-1',
      actorImUserId: 'owner-1',
      targetRuntimeInstallationId: 'container-k8s',
      dryRun: true,
    });

    expect(result).toMatchObject({
      dryRun: true,
      moved: false,
      workspaceId: 'workspace-1',
      ceoAgentImUserId: 'agent-ceo',
      previousDaemonId: 'daemon-local',
      targetDaemonId: 'daemon-k8s',
      roleModel: {
        retained: true,
        profileId: 'profile-ceo',
        adapterName: 'hermes',
        roleTemplateSlug: 'ceo',
        taskAuthority: 'orchestrator',
      },
      history: {
        retained: true,
        sessionRetained: true,
        conversationRetained: true,
        workspaceSessionModel: 'conversation',
        conversationCount: 3,
        messageCount: 12,
      },
      localSessionState: {
        migrated: false,
        status: 'not_migrated',
      },
    });
    expect(mocks.installAgent).not.toHaveBeenCalled();
    expect(prisma.iMAgentBinding.update).not.toHaveBeenCalled();
    expect(mocks.stampAgentCardDaemonBinding).not.toHaveBeenCalled();
    expect(prisma.iMMessage.count).toHaveBeenCalledWith({
      where: {
        conversation: {
          workspaceId: 'workspace-1',
          participants: { some: { imUserId: 'agent-ceo' } },
        },
      },
    });
  });

  it('installs the same CEO identity onto k8s, rebinds ownership, and stamps the projection metadata', async () => {
    const { prisma, state } = makePrisma();
    const syncService = { writeEvent: vi.fn(async () => {}) };
    const service = newService(prisma, syncService);

    const result = await service.move({
      workspaceId: 'workspace-1',
      actorImUserId: 'owner-1',
      targetRuntimeInstallationId: 'container-k8s',
      reason: 'test-move',
    });

    expect(result.moved).toBe(true);
    expect(result.ceoAgentImUserId).toBe('agent-ceo');
    expect(result.previousDaemonId).toBe('daemon-local');
    expect(result.binding?.boundDaemonId).toBe('daemon-k8s');
    expect(result.roleModel).toMatchObject({
      retained: true,
      profileId: 'profile-ceo',
      profileVersion: 7,
      roleTemplateSlug: 'ceo',
      taskAuthority: 'orchestrator',
    });
    expect(state.binding?.boundDaemonId).toBe('daemon-k8s');
    expect(mocks.installAgent).toHaveBeenCalledWith(
      'prismer-agent-ceo',
      expect.objectContaining({
        workspaceId: 'workspace-1',
        imUserId: 'agent-ceo',
        adapterName: 'hermes',
        profile: expect.objectContaining({ id: 'profile-ceo', version: 7 }),
      }),
    );
    expect(mocks.stampAgentCardDaemonBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        agentImUserId: 'agent-ceo',
        daemonId: 'daemon-k8s',
        runtimeInstallationId: 'container-k8s',
      }),
    );
    expect(syncService.writeEvent).toHaveBeenCalledWith(
      'agent.binding.rebound',
      expect.objectContaining({
        agentImUserId: 'agent-ceo',
        previousDaemonId: 'daemon-local',
        newDaemonId: 'daemon-k8s',
        reason: 'test-move',
      }),
      null,
      'owner-1',
    );
  });

  it('rejects non-owner attempts because workspace CEO is special', async () => {
    const { prisma } = makePrisma();
    const service = newService(prisma);

    await expect(
      service.move({
        workspaceId: 'workspace-1',
        actorImUserId: 'other-user',
        targetRuntimeInstallationId: 'container-k8s',
      }),
    ).rejects.toMatchObject({ code: 'NOT_WORKSPACE_OWNER', status: 403 });
    expect(mocks.installAgent).not.toHaveBeenCalled();
    expect(prisma.iMAgentBinding.update).not.toHaveBeenCalled();
  });

  it('rejects workspaces without an active CEO appointment', async () => {
    const { prisma } = makePrisma({
      workspace: {
        id: 'workspace-1',
        ownerImUserId: 'owner-1',
        orchestratorAgentId: null,
        orchestratorRevokedAt: null,
      },
    });
    const service = newService(prisma);

    await expect(
      service.move({
        workspaceId: 'workspace-1',
        actorImUserId: 'owner-1',
        targetRuntimeInstallationId: 'container-k8s',
      }),
    ).rejects.toMatchObject({ code: 'CEO_NOT_APPOINTED', status: 409 });
  });

  it('rejects stopped or failed target runtimes before install/rebind', async () => {
    const { prisma } = makePrisma({
      container: {
        id: 'container-k8s',
        workspaceId: 'workspace-1',
        podName: 'prismer-agent-ceo',
        namespace: 'prismer-sandbox',
        agentImUserId: 'runtime-ceo',
        daemonId: 'daemon-k8s',
        status: 'stopping',
        stoppedAt: null,
        deviceType: 'k8s',
        runtimeKind: 'k8s',
        providerKind: 'k8s',
      },
    });
    const service = newService(prisma);

    await expect(
      service.move({
        workspaceId: 'workspace-1',
        actorImUserId: 'owner-1',
        targetRuntimeInstallationId: 'container-k8s',
      }),
    ).rejects.toMatchObject({ code: 'TARGET_RUNTIME_NOT_RUNNING', status: 409 });
    expect(mocks.installAgent).not.toHaveBeenCalled();
    expect(prisma.iMAgentBinding.update).not.toHaveBeenCalled();
  });

  it('rejects stale k8s target rows when the pod no longer exists', async () => {
    const { prisma } = makePrisma();
    mocks.podStatusVerdict.mockResolvedValueOnce({
      podName: 'prismer-agent-ceo',
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
        targetRuntimeInstallationId: 'container-k8s',
      }),
    ).rejects.toMatchObject({ code: 'TARGET_RUNTIME_POD_UNAVAILABLE', status: 409 });
    expect(mocks.installAgent).not.toHaveBeenCalled();
    expect(prisma.iMAgentBinding.update).not.toHaveBeenCalled();
  });

  it('rejects non-k8s targets for this CEO move path', async () => {
    const { prisma } = makePrisma({
      container: {
        id: 'container-local',
        workspaceId: 'workspace-1',
        podName: 'local-daemon',
        agentImUserId: 'runtime-local',
        daemonId: 'daemon-local-2',
        status: 'running',
        stoppedAt: null,
        deviceType: 'local',
        runtimeKind: 'docker',
        providerKind: 'docker-host',
      },
    });
    const service = newService(prisma);

    await expect(
      service.move({
        workspaceId: 'workspace-1',
        actorImUserId: 'owner-1',
        targetRuntimeInstallationId: 'container-local',
      }),
    ).rejects.toMatchObject({ code: 'TARGET_RUNTIME_NOT_K8S', status: 409 });
  });

  it('supports legacy targetDaemonId lookup while preserving the CEO agent id', async () => {
    const { prisma } = makePrisma({
      container: {
        id: 'container-k8s',
        workspaceId: 'workspace-1',
        podName: 'prismer-agent-ceo',
        agentImUserId: 'runtime-ceo',
        daemonId: null,
        status: 'running',
        stoppedAt: null,
        deviceType: 'k8s',
        runtimeKind: 'k8s',
        providerKind: 'k8s',
      },
    });
    const service = newService(prisma);

    const result = await service.move({
      workspaceId: 'workspace-1',
      actorImUserId: 'owner-1',
      targetDaemonId: 'container:runtime-ceo',
      install: false,
    });

    expect(result.ceoAgentImUserId).toBe('agent-ceo');
    expect(result.targetDaemonId).toBe('container:runtime-ceo');
    expect(result.binding?.boundDaemonId).toBe('container:runtime-ceo');
    expect(mocks.installAgent).not.toHaveBeenCalled();
  });

  it('exposes a typed error for non-CEO profiles', async () => {
    const { prisma } = makePrisma({
      profileConfig: { roleTemplate: { slug: 'engineer' }, taskAuthority: 'worker' },
    });
    const service = newService(prisma);

    await expect(
      service.move({
        workspaceId: 'workspace-1',
        actorImUserId: 'owner-1',
        targetRuntimeInstallationId: 'container-k8s',
      }),
    ).rejects.toBeInstanceOf(CeoRuntimeMoveError);
    await expect(
      service.move({
        workspaceId: 'workspace-1',
        actorImUserId: 'owner-1',
        targetRuntimeInstallationId: 'container-k8s',
      }),
    ).rejects.toMatchObject({ code: 'CEO_PROFILE_NOT_ORCHESTRATOR', status: 409 });
  });
});
