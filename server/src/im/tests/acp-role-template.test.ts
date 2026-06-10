import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { imUserId: 'owner-1', role: 'admin' as string },
  prisma: {
    iMRoleTemplate: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    iMAgentProfile: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    iMWorkspace: {
      findFirst: vi.fn(),
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

import { createRoleTemplatesRouter } from '../api/role-templates';
import { createSkillsRouter } from '../api/skills';
import { RoleTemplateService } from '../services/role-template.service';

const templateRow = {
  id: 'rt-1',
  slug: 'release-manager',
  version: '1.0.0',
  name: JSON.stringify({ en: 'Release Manager' }),
  description: JSON.stringify({ en: 'Coordinates release work' }),
  agentType: 'orchestrator',
  category: 'delivery',
  tags: JSON.stringify(['release']),
  baseSkillSet: 'prismer-base',
  requiredSkills: JSON.stringify([
    { skillSlug: 'task-review', version: '1.2.0', required: true, config: { lane: 'review' } },
    { skillSlug: 'optional-reporting', required: false },
  ]),
  mcpServers: JSON.stringify([
    {
      name: 'prismer-tasks',
      package: '@prismer/mcp-server',
      transport: 'stdio',
      toolsAllowlist: ['prismer.task.create', 'prismer.task.approve'],
    },
  ]),
  hermesConfig: JSON.stringify({ model: 'release-model' }),
  openclawConfig: null,
  operatingPrinciples: JSON.stringify({ en: 'Keep releases boring.' }),
  taskAuthority: 'orchestrator',
  approvalPolicy: 'strict',
  status: 'active',
  source: 'agency-agents',
  sourceSlug: 'project-management/release-manager',
  sourceCommit: 'abc123',
  importedAt: new Date('2026-01-01T00:00:00Z'),
  curatedQuality: 'gold',
  metadata: { license: 'MIT', curation: { tier: 'gold' }, source: 'agency-agents' },
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
};

describe('ACP role templates service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { imUserId: 'owner-1', role: 'admin' };
  });

  it('creates, lists, gets, and updates role templates with ACP fields', async () => {
    mocks.prisma.iMRoleTemplate.findMany.mockResolvedValue([templateRow]);
    mocks.prisma.iMRoleTemplate.findFirst.mockResolvedValue(templateRow);
    mocks.prisma.iMRoleTemplate.create.mockResolvedValue(templateRow);
    mocks.prisma.iMRoleTemplate.update.mockResolvedValue({ ...templateRow, approvalPolicy: 'autonomous' });

    const service = new RoleTemplateService({ installSkill: vi.fn() } as any);

    await expect(
      service.create({
        slug: 'release-manager',
        name: { en: 'Release Manager' },
        agentType: 'orchestrator',
        operatingPrinciples: { en: 'Keep releases boring.' },
        taskAuthority: 'orchestrator',
        approvalPolicy: 'strict',
      }),
    ).resolves.toMatchObject({
      slug: 'release-manager',
      operatingPrinciples: { en: 'Keep releases boring.' },
      taskAuthority: 'orchestrator',
      approvalPolicy: 'strict',
    });
    expect(mocks.prisma.iMRoleTemplate.create.mock.calls[0][0].data).toMatchObject({
      slug: 'release-manager',
      taskAuthority: 'orchestrator',
      approvalPolicy: 'strict',
    });

    await expect(service.list({ category: 'delivery' })).resolves.toHaveLength(1);
    await expect(service.get('release-manager')).resolves.toMatchObject({
      mcpServers: expect.any(Array),
      source: 'agency-agents',
      sourceSlug: 'project-management/release-manager',
      curatedQuality: 'gold',
      license: 'MIT',
      metadata: { license: 'MIT' },
    });
    await expect(service.update('release-manager', { approvalPolicy: 'autonomous' })).resolves.toMatchObject({
      approvalPolicy: 'autonomous',
    });
  });

  it('applies a profile snapshot and remains compatible with profiles missing ACP fields', async () => {
    const installSkill = vi.fn().mockResolvedValue({ agentSkill: { id: 'as-1' }, skill: { slug: 'task-review' } });
    mocks.prisma.iMRoleTemplate.findFirst.mockResolvedValue({
      ...templateRow,
      hermesConfig: JSON.stringify({ soul: 'Hermes SOUL persona.', agents: 'Hermes AGENTS playbook.' }),
      openclawConfig: JSON.stringify({ soul: 'OpenClaw SOUL persona.', agents: 'OpenClaw AGENTS playbook.' }),
    });
    mocks.prisma.iMAgentProfile.findFirst.mockResolvedValue({
      id: 'profile-1',
      adapterName: 'hermes',
      config: JSON.stringify({ legacyOnly: true }),
      workspaceId: 'ws-1',
    });
    mocks.prisma.iMAgentProfile.update.mockImplementation(async (args: any) => ({
      id: args.where.id,
      version: 2,
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
    }));

    const service = new RoleTemplateService({ installSkill } as any);
    const result = await service.applyToAgent('agent-1', 'release-manager', 'ws-1');

    expect(installSkill).toHaveBeenCalledWith('agent-1', 'task-review', 'global', {
      workspaceId: 'ws-1',
      config: { lane: 'review' },
      version: '1.2.0',
    });
    expect(result.skippedOptional).toEqual([{ skillSlug: 'optional-reporting', required: false }]);

    const written = JSON.parse(mocks.prisma.iMAgentProfile.update.mock.calls[0][0].data.config);
    expect(written).toMatchObject({
      legacyOnly: true,
      mcpAllowlist: ['prismer.task.create', 'prismer.task.approve'],
      taskAuthority: 'orchestrator',
      approvalPolicy: 'strict',
      operatingPrinciples: { en: 'Keep releases boring.' },
      systemPrompt: 'Hermes SOUL persona.',
    });
    expect(written.roleTemplate).toMatchObject({
      slug: 'release-manager',
      hermesConfig: { soul: 'Hermes SOUL persona.', agents: 'Hermes AGENTS playbook.' },
      operatingPrinciples: { en: 'Keep releases boring.' },
      taskAuthority: 'orchestrator',
      approvalPolicy: 'strict',
    });
  });

  it('preinstall delegates to apply behavior', async () => {
    const service = new RoleTemplateService({ installSkill: vi.fn() } as any);
    const spy = vi.spyOn(service, 'applyToAgent').mockResolvedValue({ ok: true } as any);

    await expect(service.preinstallRoleTemplateSkills('agent-1', 'release-manager', 'ws-1')).resolves.toEqual({
      ok: true,
    });
    expect(spy).toHaveBeenCalledWith('agent-1', 'release-manager', 'ws-1');
  });
});

describe('ACP role templates API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { imUserId: 'owner-1', role: 'admin' };
  });

  it('supports list/get/create/update/apply routes', async () => {
    const roleTemplateService = {
      list: vi.fn().mockResolvedValue([{ slug: 'release-manager' }]),
      get: vi.fn().mockResolvedValue({ slug: 'release-manager' }),
      create: vi.fn().mockResolvedValue({ slug: 'release-manager' }),
      update: vi.fn().mockResolvedValue({ slug: 'release-manager', approvalPolicy: 'autonomous' }),
      applyToAgent: vi.fn().mockResolvedValue({ profile: { id: 'profile-1' } }),
    };
    const app = new Hono().route('/role-templates', createRoleTemplatesRouter(roleTemplateService as any));

    await expect((await app.request('/role-templates')).json()).resolves.toMatchObject({ ok: true });
    await expect((await app.request('/role-templates/release-manager')).json()).resolves.toMatchObject({ ok: true });

    const created = await app.request('/role-templates', {
      method: 'POST',
      body: JSON.stringify({ slug: 'release-manager', name: { en: 'Release Manager' } }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(created.status).toBe(201);

    await expect(
      (
        await app.request('/role-templates/release-manager', {
          method: 'PATCH',
          body: JSON.stringify({ approvalPolicy: 'autonomous' }),
          headers: { 'Content-Type': 'application/json' },
        })
      ).json(),
    ).resolves.toMatchObject({ ok: true, data: { approvalPolicy: 'autonomous' } });

    await expect(
      (
        await app.request('/role-templates/release-manager/apply', {
          method: 'POST',
          body: JSON.stringify({ agentId: 'agent-1', workspaceId: 'ws-1' }),
          headers: { 'Content-Type': 'application/json' },
        })
      ).json(),
    ).resolves.toMatchObject({ ok: true, data: { profile: { id: 'profile-1' } } });
    expect(roleTemplateService.applyToAgent).toHaveBeenCalledWith('agent-1', 'release-manager', 'ws-1');
  });

  it('supports skills preinstall route through role template apply', async () => {
    mocks.prisma.iMRoleTemplate.findFirst.mockResolvedValue({ ...templateRow, requiredSkills: '[]' });
    mocks.prisma.iMAgentProfile.findFirst.mockResolvedValue({
      id: 'profile-1',
      config: '{}',
      workspaceId: 'ws-1',
    });
    mocks.prisma.iMAgentProfile.update.mockImplementation(async (args: any) => ({
      id: args.where.id,
      version: 2,
      workspaceId: 'ws-1',
      agentImUserId: 'agent-1',
    }));

    const app = new Hono().route('/skills', createSkillsRouter({} as any));
    const res = await app.request('/skills/preinstall', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'agent-1', roleTemplateSlugOrId: 'release-manager', workspaceId: 'ws-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const json = await res.json();

    expect(json).toMatchObject({
      ok: true,
      data: {
        installed: [],
        profile: { id: 'profile-1' },
      },
    });
    const written = JSON.parse(mocks.prisma.iMAgentProfile.update.mock.calls[0][0].data.config);
    expect(written).toMatchObject({
      roleTemplate: { slug: 'release-manager' },
      taskAuthority: 'orchestrator',
      approvalPolicy: 'strict',
      operatingPrinciples: { en: 'Keep releases boring.' },
    });
  });
});
