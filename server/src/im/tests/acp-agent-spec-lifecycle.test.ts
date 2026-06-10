import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { imUserId: 'owner-1', role: 'admin' as string },
  prisma: {
    iMUser: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    iMAgentCard: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    iMAgentProfile: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    iMAgentSkill: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    iMSkill: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    iMContainer: {
      findFirst: vi.fn(),
    },
    iMContainerSnapshot: {
      findFirst: vi.fn(),
    },
    iMAgentBinding: {
      findUnique: vi.fn(),
    },
    iMAgentSnapshot: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    iMAgentPackage: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    iMWorkspace: {
      findFirst: vi.fn(),
    },
    iMWorkspaceMember: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../db', () => ({ default: mocks.prisma }));
vi.mock('../auth/middleware', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', mocks.user);
    await next();
  },
}));
vi.mock('../utils/id-gen', () => ({
  generateIMUserId: vi.fn(() => 'agent-new'),
}));

import { createAgentPacksRouter } from '../api/agent-packs';
import { AgentSpecService } from '../services/agent-spec.service';

const now = new Date('2026-05-21T00:00:00.000Z');

function setupBuildSpecMocks(agentId = 'agent-1', workspaceId = 'ws-1') {
  mocks.prisma.iMUser.findUnique.mockImplementation(async (args: any) => {
    if (args.where.id === agentId) {
      return {
        id: agentId,
        username: 'release-manager',
        displayName: 'Release Manager',
        avatarUrl: null,
        role: 'agent',
        primaryDid: 'did:prismer:agent-1',
        userId: 'cloud-user-1',
      };
    }
    if (args.where.id === 'owner-1') return { primaryDid: 'did:prismer:owner-1', userId: 'cloud-user-1' };
    return null;
  });
  mocks.prisma.iMAgentCard.findUnique.mockResolvedValue({
    id: 'card-1',
    imUserId: agentId,
    workspaceId,
    did: 'did:prismer:card-1',
    name: 'Release Manager',
    description: 'Coordinates releases',
    agentType: 'orchestrator',
    capabilities: JSON.stringify(['release']),
    status: 'online',
  });
  mocks.prisma.iMAgentProfile.findFirst.mockResolvedValue({
    id: 'profile-1',
    workspaceId,
    agentImUserId: agentId,
    adapterName: 'hermes',
    config: JSON.stringify({
      roleTemplate: {
        slug: 'release-manager',
        hermesConfig: { soul: 'SOUL', agents: 'AGENTS' },
        openclawConfig: { soul: 'OPENCLAW SOUL', agents: 'OPENCLAW AGENTS' },
      },
      taskAuthority: 'orchestrator',
      approvalPolicy: 'strict',
      env: { RELEASE_CHANNEL: 'stable' },
    }),
  });
  mocks.prisma.iMAgentSkill.findMany.mockResolvedValue([
    {
      id: 'as-1',
      agentId,
      skillId: 'skill-1',
      workspaceId,
      version: '1.2.0',
      config: JSON.stringify({ lane: 'review' }),
      status: 'active',
      installedAt: now,
    },
  ]);
  mocks.prisma.iMSkill.findMany.mockResolvedValue([
    {
      id: 'skill-1',
      slug: 'task-review',
      version: '1.2.0',
      source: 'built-in',
      metadata: JSON.stringify({ source: 'prismer' }),
      requires: JSON.stringify({ node: '>=20' }),
      executableJson: { kind: 'mcp-tool', name: 'prismer.task.update' },
    },
  ]);
  mocks.prisma.iMContainer.findFirst.mockResolvedValue({
    id: 'container-1',
    workspaceId,
    agentImUserId: agentId,
    podName: 'pod-agent-1',
    gatewayUrl: null,
    daemonId: 'daemon-1',
    providerKind: 'docker-host',
    runtimeKind: 'docker',
    status: 'running',
    image: 'dockerhub.services/prismer/sandbox',
    imageTag: 'daemon-v2.0.0',
    cpuLimit: '2',
    memoryLimit: '4Gi',
  });
  mocks.prisma.iMContainerSnapshot.findFirst.mockResolvedValue({
    id: 'container-snap-1',
    containerId: 'container-1',
    createdAt: now,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agent spec lifecycle service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { imUserId: 'owner-1', role: 'admin' };
    mocks.prisma.iMAgentBinding.findUnique.mockResolvedValue(null);
    mocks.prisma.$transaction.mockImplementation(async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations),
    );
  });

  it('builds a 4-tuple spec from profile, installed skills, memory, and environment state', async () => {
    setupBuildSpecMocks();

    const spec = await new AgentSpecService().buildSpec('agent-1', 'ws-1');

    expect(spec.identity).toMatchObject({
      did: 'did:prismer:agent-1',
      imUserId: 'agent-1',
      displayName: 'Release Manager',
    });
    expect(spec.definition).toMatchObject({
      roleTemplateSlug: 'release-manager',
      taskAuthority: 'orchestrator',
      approvalPolicy: 'strict',
    });
    expect(spec.skills).toEqual([
      expect.objectContaining({
        skillSlug: 'task-review',
        version: '1.2.0',
        source: 'built-in',
        config: { lane: 'review' },
        envDeps: { node: '>=20' },
        executable: { kind: 'mcp-tool', name: 'prismer.task.update' },
      }),
    ]);
    expect(spec.memory).toMatchObject({ scope: 'agent-private', storeRef: 'workspace:ws-1:agent:agent-1:memory' });
    expect(spec.environment).toMatchObject({
      containerSnapshot: 'container-snap-1',
      envVars: { RELEASE_CHANNEL: 'stable' },
    });
  });

  it('creates private snapshots and publishes memory-stripped agent packages', async () => {
    setupBuildSpecMocks();
    mocks.prisma.iMAgentSnapshot.create.mockImplementation(async (args: any) => ({
      id: 'snap-1',
      ...args.data,
      createdAt: now,
    }));
    mocks.prisma.iMAgentPackage.create.mockImplementation(async (args: any) => ({
      id: 'pack-1',
      ...args.data,
      createdAt: now,
    }));

    const service = new AgentSpecService();
    const snapshot = await service.snapshot('agent-1', mocks.user, { includeMemory: true, label: 'before publish' });
    const published = await service.publish('agent-1', mocks.user, {
      slug: 'release-manager-pack',
      version: '1.0.0',
      stripMemory: true,
    });

    expect(snapshot).toMatchObject({
      id: 'snap-1',
      agentImUserId: 'agent-1',
      includeMemory: true,
      memoryDumpRef: 'workspace:ws-1:agent:agent-1:memory',
    });
    expect(mocks.prisma.iMAgentSnapshot.create.mock.calls[0][0].data).toMatchObject({
      containerSnapshotId: 'container-snap-1',
      includeMemory: true,
      createdBy: 'owner-1',
    });
    expect(published).toMatchObject({
      id: 'pack-1',
      slug: 'release-manager-pack',
      publisherDid: 'did:prismer:owner-1',
      license: 'proprietary',
      curatedQuality: 'review',
    });
    expect(published.environment).not.toHaveProperty('memory');
  });

  it('enriches agent snapshots with daemon dump-state when a gateway is reachable', async () => {
    setupBuildSpecMocks();
    mocks.prisma.iMContainer.findFirst.mockResolvedValue({
      id: 'container-1',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
      podName: 'pod-agent-1',
      gatewayUrl: 'http://daemon.local:7878',
      daemonId: 'daemon-1',
      providerKind: 'docker-host',
      runtimeKind: 'docker',
      status: 'running',
      image: 'dockerhub.services/prismer/sandbox',
      imageTag: 'daemon-v2.0.0',
      cpuLimit: '2',
      memoryLimit: '4Gi',
    });
    mocks.prisma.iMAgentSnapshot.create.mockImplementation(async (args: any) => ({
      id: 'snap-1',
      ...args.data,
      createdAt: now,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            agentId: 'agent-1',
            adapterName: 'hermes',
            dumpedAt: now.toISOString(),
            roots: [{ kind: 'hermes-profile', rootPath: '/tmp/profile', exists: true, files: [] }],
            files: [{ path: 'hermes-profile/SOUL.md', sha256: 'abc', sizeBytes: 12, rootKind: 'hermes-profile' }],
          }),
      }),
    );

    const snapshot = await new AgentSpecService().snapshot('agent-1', mocks.user, { includeMemory: false });

    expect(snapshot.perAgentDirManifest.daemonState).toMatchObject({
      status: 'captured',
      source: 'gateway',
      manifest: {
        agentId: 'agent-1',
        files: [{ path: 'hermes-profile/SOUL.md', sha256: 'abc', sizeBytes: 12, rootKind: 'hermes-profile' }],
      },
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://daemon.local:7878/v1/agents/agent-1/dump-state',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('agent pack registry API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { imUserId: 'owner-1', role: 'admin' };
  });

  it('lists and forks agent packs through the lifecycle service contract', async () => {
    const service = {
      listPackages: vi.fn().mockResolvedValue({ items: [{ id: 'pack-1', slug: 'release-manager-pack' }] }),
      canUseWorkspace: vi.fn().mockResolvedValue(true),
      forkPackage: vi.fn().mockResolvedValue({ newImUserId: 'agent-new', agentSpec: { workspaceId: 'ws-2' } }),
    };
    const app = new Hono().route('/agent-packs', createAgentPacksRouter(service as any));

    await expect((await app.request('/agent-packs?q=release')).json()).resolves.toMatchObject({
      ok: true,
      data: { items: [{ slug: 'release-manager-pack' }] },
    });
    expect(service.listPackages).toHaveBeenCalledWith(expect.objectContaining({ q: 'release', limit: 50 }));

    const forked = await app.request('/agent-packs/pack-1/fork', {
      method: 'POST',
      body: JSON.stringify({ targetWorkspaceId: 'ws-2', displayName: 'Forked Release Manager' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(forked.status).toBe(201);
    await expect(forked.json()).resolves.toMatchObject({
      ok: true,
      data: { newImUserId: 'agent-new', agentSpec: { workspaceId: 'ws-2' } },
    });
    expect(service.forkPackage).toHaveBeenCalledWith(
      'pack-1',
      mocks.user,
      expect.objectContaining({ targetWorkspaceId: 'ws-2', displayName: 'Forked Release Manager' }),
    );
  });
});
