import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { imUserId: 'owner-1', role: 'human' },
  prisma: {
    iMWorkspace: { findFirst: vi.fn() },
    iMUser: { findMany: vi.fn(), findUnique: vi.fn() },
    iMAgentProfile: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('../db', () => ({ default: mocks.prisma }));
vi.mock('../auth/middleware', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', mocks.user);
    await next();
  },
}));

import { buildDefaultAcpProfileConfig, mergeMissingAcpProfileDefaults } from '../acp/profile-defaults';
import { createAgentProfilesRouter } from '../api/agent-profiles';

describe('ACP profile defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds orchestrator defaults with approval tools', () => {
    const config = buildDefaultAcpProfileConfig({
      username: 'ceo',
      displayName: 'CEO',
      agentType: 'orchestrator',
    });

    expect(config).toMatchObject({
      taskAuthority: 'orchestrator',
      approvalPolicy: 'auto-low-risk',
      roleTemplate: {
        slug: 'ceo',
        taskAuthority: 'orchestrator',
      },
    });
    expect(config.mcpAllowlist).toEqual(
      expect.arrayContaining([
        'prismer.task.create',
        'prismer.task.approve',
        'prismer.task.reject',
        'prismer.approval.request_human_approval',
        'prismer.message.sendFile',
        'prismer.asset.search',
        'prismer.asset.describe',
        'prismer.asset.read',
      ]),
    );
  });

  it('merges only missing ACP fields and preserves explicit overrides', () => {
    const defaults = buildDefaultAcpProfileConfig({ username: 'support', agentType: 'assistant' });
    const merged = mergeMissingAcpProfileDefaults(
      {
        legacyOnly: true,
        taskAuthority: 'orchestrator',
        mcpAllowlist: ['prismer.task.list'],
      },
      defaults,
    );

    expect(merged).toMatchObject({
      legacyOnly: true,
      taskAuthority: 'orchestrator',
      mcpAllowlist: ['prismer.task.list'],
      approvalPolicy: 'auto-low-risk',
      roleTemplate: expect.any(Object),
      operatingPrinciples: expect.any(Object),
    });
  });

  it('agent profile creation applies server-side ACP defaults when caller omits them', async () => {
    mocks.prisma.iMWorkspace.findFirst.mockResolvedValue({ id: 'ws-1', ownerImUserId: 'owner-1' });
    mocks.prisma.iMUser.findUnique.mockResolvedValue({
      id: 'agent-1',
      username: 'ceo',
      displayName: 'CEO',
      agentType: 'orchestrator',
      agentCard: { agentType: 'orchestrator', capabilities: '["strategy"]' },
    });
    mocks.prisma.iMAgentProfile.create.mockImplementation(async (args: any) => ({
      id: 'profile-1',
      workspaceId: args.data.workspaceId,
      agentImUserId: args.data.agentImUserId,
      adapterName: args.data.adapterName,
      name: args.data.name,
      config: args.data.config,
      version: 1,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    }));

    const app = new Hono().route('/agent_profiles', createAgentProfilesRouter());
    const res = await app.request('/agent_profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        agentImUserId: 'agent-1',
        adapterName: 'hermes',
        name: 'default',
        config: { apiKey: 'key', model: 'us-kimi-k2.6' },
      }),
    });

    expect(res.status).toBe(201);
    const written = JSON.parse(mocks.prisma.iMAgentProfile.create.mock.calls[0][0].data.config);
    expect(written).toMatchObject({
      apiKey: 'key',
      model: 'us-kimi-k2.6',
      hermesProfileName: 'ceo',
      taskAuthority: 'orchestrator',
      approvalPolicy: 'auto-low-risk',
      roleTemplate: { slug: 'ceo', taskAuthority: 'orchestrator' },
      operatingPrinciples: expect.any(Object),
    });
    expect(written.mcpAllowlist).toEqual(
      expect.arrayContaining([
        'prismer.task.approve',
        'prismer.asset.search',
        'prismer.asset.describe',
        'prismer.asset.read',
      ]),
    );
  });
});
