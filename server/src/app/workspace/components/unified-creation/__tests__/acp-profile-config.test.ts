import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildRoleTemplateSnapshot, ROLE_TEMPLATES } from '../../../lib/templates';
import type { RenderedRole } from '../../../lib/templates/types';
import type { RegisterAgentResult } from '../../../lib/mutations';
import { buildSimpleProfileConfig, registerOrReuseSimpleProvisioningAgent } from '../use-simple-provisioning';
import { buildLongRunningProfileConfig, createLongRunningAgent } from '../pro/create-long-running-agent';
import { buildProfileConfig } from '../pro/profile-config';

const mutationMocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  createAgentProfile: vi.fn(),
  createDirectConversation: vi.fn(),
  preinstallRoleTemplateSkills: vi.fn(),
}));

vi.mock('../../../lib/mutations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/mutations')>()),
  createAgent: mutationMocks.createAgent,
  createAgentProfile: mutationMocks.createAgentProfile,
  createDirectConversation: mutationMocks.createDirectConversation,
  preinstallRoleTemplateSkills: mutationMocks.preinstallRoleTemplateSkills,
}));

const agent: RegisterAgentResult = {
  imUserId: 'agent_1',
  username: 'ceo',
  displayName: 'CEO',
  role: 'agent',
  token: 'token',
  expiresIn: '1h',
  isNew: true,
};

describe('ACP creation profile config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationMocks.preinstallRoleTemplateSkills.mockResolvedValue({ ok: true, data: {} });
  });

  it('simple creation defaults each agent profile to ACP config', () => {
    const role: RenderedRole = {
      slug: 'ceo',
      displayName: 'CEO',
      agentType: 'orchestrator',
      primary: true,
      rationale: 'Owns direction and delegation.',
      capabilities: ['strategy'],
      defaultIcon: 'crown',
    };

    const config = buildSimpleProfileConfig(role, 'ceo', 'Acme Research');

    expect(config).toMatchObject({
      hermesProfileName: 'ceo',
      autoStart: true,
      organizationName: 'Acme Research',
      systemPrompt: expect.stringContaining('组织名称: Acme Research'),
      roleTemplate: {
        slug: 'ceo',
        templateParams: {
          organizationName: 'Acme Research',
        },
        taskAuthority: 'orchestrator',
        approvalPolicy: 'auto-low-risk',
        operatingPrinciples: expect.any(Object),
      },
      taskAuthority: 'orchestrator',
      approvalPolicy: 'auto-low-risk',
      operatingPrinciples: expect.any(Object),
    });
    expect(config.mcpAllowlist).toEqual(
      expect.arrayContaining([
        'prismer.task.create',
        'prismer.task.approve',
        'prismer.approval.request_human_approval',
        'prismer.asset.search',
        'prismer.asset.describe',
        'prismer.asset.read',
      ]),
    );
  });

  it('simple specialists default to executor authority', () => {
    const role: RenderedRole = {
      slug: 'engineer',
      displayName: 'Engineer',
      agentType: 'specialist',
      primary: false,
      rationale: 'Ships implementation work.',
      capabilities: ['code'],
      defaultIcon: 'wrench',
    };

    const config = buildSimpleProfileConfig(role, 'engineer', 'Acme Research');

    expect(config.taskAuthority).toBe('executor');
    expect(config.roleTemplate).toMatchObject({ slug: 'engineer', taskAuthority: 'executor' });
    expect(config.mcpAllowlist).not.toContain('prismer.task.approve');
    expect(config.mcpAllowlist).toEqual(
      expect.arrayContaining(['prismer.asset.search', 'prismer.asset.describe', 'prismer.asset.read']),
    );
  });

  it('simple creation accepts an explicit model override', () => {
    const role: RenderedRole = {
      slug: 'ceo',
      displayName: 'CEO',
      agentType: 'orchestrator',
      primary: true,
      rationale: 'Owns direction and delegation.',
      capabilities: ['strategy'],
      defaultIcon: 'crown',
    };

    const config = buildSimpleProfileConfig(role, 'ceo', 'Acme Research', 'gemini-3.1-pro-preview');

    expect(config.model).toBe('gemini-3.1-pro-preview');
  });

  it('pro long-running creation writes ACP config from role templates', () => {
    const template = ROLE_TEMPLATES.find((item) => item.id === 'ceo');
    expect(template).toBeDefined();

    const config = buildLongRunningProfileConfig({
      adapter: 'hermes',
      template,
      hermesPort: '8642',
      hermesApiKey: 'secret',
      openclawBaseUrl: '',
      model: 'us-kimi-k2.6',
    });

    expect(config).toMatchObject({
      roleTemplate: buildRoleTemplateSnapshot(template),
      taskAuthority: 'orchestrator',
      approvalPolicy: 'auto-low-risk',
      operatingPrinciples: { en: template?.systemPrompt },
    });
    expect(config.mcpAllowlist).toEqual(
      expect.arrayContaining([
        'prismer.task.approve',
        'prismer.asset.search',
        'prismer.asset.describe',
        'prismer.asset.read',
      ]),
    );
  });

  it('simple retry reuses an agent whose profile setup failed after register', async () => {
    const role: RenderedRole = {
      slug: 'engineer',
      displayName: 'Engineer',
      agentType: 'specialist',
      primary: false,
      rationale: 'Ships implementation work.',
      capabilities: ['code'],
      defaultIcon: 'wrench',
    };
    const pendingAgent = {
      imUserId: 'agent_pending',
      username: 'engineer',
      displayName: 'Engineer',
      role: 'agent' as const,
      token: 'token',
      expiresIn: '7d',
      capabilities: ['code'],
      isNew: true,
    };
    const create = vi.fn(async () => ({ ok: true as const, data: pendingAgent }));

    const result = await registerOrReuseSimpleProvisioningAgent(
      {
        role,
        username: 'engineer',
        workspaceId: 'ws_1',
        daemonId: 'container:rt_1',
        pendingAgent,
      },
      create,
    );

    expect(result).toEqual({ agent: pendingAgent, reusedPending: true });
    expect(create).not.toHaveBeenCalled();
  });

  it('pro long-running creation returns retry recovery after profile failure', async () => {
    mutationMocks.createAgent.mockResolvedValue({ ok: true, data: agent });
    mutationMocks.createAgentProfile.mockResolvedValue({ ok: false, message: 'profile db down' });

    const result = await createLongRunningAgent({
      workspaceId: 'ws_1',
      displayName: 'CEO',
      username: 'ceo',
      agentType: 'orchestrator',
      adapter: 'hermes',
      target: {
        source: 'local-host',
        daemonId: 'daemon_1',
        label: 'Local daemon (daemon_1)',
        workspaceId: 'ws_1',
        bindable: true,
      },
      config: {},
    });

    expect(result).toMatchObject({
      ok: false,
      stage: 'profile',
      imUserId: 'agent_1',
      recovery: { agent, profileCreated: false },
    });
    expect(result.ok ? '' : result.message).toContain('Retry will resume profile setup');
  });

  it('pro long-running retry resumes from recovered agent without registering another one', async () => {
    mutationMocks.createAgentProfile.mockResolvedValue({ ok: true, data: { id: 'profile_1' } });
    mutationMocks.createDirectConversation.mockResolvedValue({ ok: true, data: { id: 'conv_1' } });

    const result = await createLongRunningAgent({
      workspaceId: 'ws_1',
      displayName: 'CEO',
      username: 'ceo',
      agentType: 'orchestrator',
      adapter: 'hermes',
      target: {
        source: 'local-host',
        daemonId: 'daemon_1',
        label: 'Local daemon (daemon_1)',
        workspaceId: 'ws_1',
        bindable: true,
      },
      config: {},
      recovery: { agent, profileCreated: false },
    });

    expect(result).toEqual({ ok: true, imUserId: 'agent_1', conversationId: 'conv_1' });
    expect(mutationMocks.createAgent).not.toHaveBeenCalled();
    expect(mutationMocks.createAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({ agentImUserId: 'agent_1' }),
    );
  });

  // ────────────────────── 2026-05-30 proxyProvider ──────────────────────
  //
  // Per-agent LLM proxy selector. Default is `newapi`; the cloud-side
  // `/api/v1/proxy/[provider]/chat/completions` alias relies on this field
  // being present so the hermes adapter can rewrite its custom_providers
  // base_url per profile.

  it('hermes long-running config defaults proxyProvider to "newapi"', () => {
    const config = buildLongRunningProfileConfig({
      adapter: 'hermes',
      hermesPort: '8642',
      hermesApiKey: 'secret',
      openclawBaseUrl: '',
      model: 'us-kimi-k2.6',
    });
    expect(config.proxyProvider).toBe('newapi');
  });

  it('hermes long-running config carries an explicit "deepseek" choice', () => {
    const config = buildLongRunningProfileConfig({
      adapter: 'hermes',
      hermesPort: '8642',
      hermesApiKey: 'secret',
      openclawBaseUrl: '',
      model: 'us-kimi-k2.6',
      proxyProvider: 'deepseek',
    });
    expect(config.proxyProvider).toBe('deepseek');
  });

  // ────────────────────── doc 06 codex executor ──────────────────────
  //
  // Pro mode Executor (CLI) tile builds a real codex config (proxyProvider +
  // sessionContinuity + sandbox), matching the daemon-side CodexConfigSchema.

  it('codex executor config carries proxyProvider + sessionContinuity + sandbox', () => {
    const config = buildProfileConfig('codex', {
      hermesPort: '',
      hermesApiKey: '',
      openclawBaseUrl: '',
      systemPrompt: '',
      model: 'us-kimi-k2.6',
    });
    expect(config).toMatchObject({
      cwd: '/tmp/prismer-codex',
      model: 'us-kimi-k2.6',
      sandbox: 'workspace-write',
      proxyProvider: 'newapi',
      prismerApiKeyEnv: 'PRISMER_API_KEY',
      sessionContinuity: true,
    });
  });

  it('codex executor honours an explicit sandbox + proxyProvider override', () => {
    const config = buildProfileConfig('codex', {
      hermesPort: '',
      hermesApiKey: '',
      openclawBaseUrl: '',
      systemPrompt: '',
      model: 'us-kimi-k2.6',
      proxyProvider: 'deepseek',
      sandbox: 'read-only',
    });
    expect(config.sandbox).toBe('read-only');
    expect(config.proxyProvider).toBe('deepseek');
  });

  it('openclaw adapter ignores proxyProvider (its gateway is daemon-side)', () => {
    const config = buildLongRunningProfileConfig({
      adapter: 'openclaw',
      hermesPort: '8642',
      hermesApiKey: '',
      openclawBaseUrl: 'http://127.0.0.1:3000',
      model: 'default',
      proxyProvider: 'deepseek',
    });
    expect(config).not.toHaveProperty('proxyProvider');
  });

  // 2026-05-30 — Simple wizard 一侧的 proxyProvider 补丁 (8d914c41 漏点).
  // Simple wizard 的 Step 1 Industry 屏在 ModelPicker 下加了
  // AdvancedProxyAccordion, 透传到 simplePlan.proxyProvider, 由
  // buildSimpleProfileConfig 写进每条 AgentProfile.config —— 跟 Pro 模式
  // 对称.
  it('simple config defaults proxyProvider to "newapi" when none supplied', () => {
    const role: RenderedRole = {
      slug: 'ceo',
      displayName: 'CEO',
      agentType: 'orchestrator',
      primary: true,
      rationale: 'Owns direction and delegation.',
      capabilities: ['strategy'],
      defaultIcon: 'crown',
    };
    const config = buildSimpleProfileConfig(role, 'ceo', 'Acme Research');
    expect(config.proxyProvider).toBe('newapi');
  });

  it('simple config carries an explicit "deepseek" choice from the Step 1 accordion', () => {
    const role: RenderedRole = {
      slug: 'ceo',
      displayName: 'CEO',
      agentType: 'orchestrator',
      primary: true,
      rationale: 'Owns direction and delegation.',
      capabilities: ['strategy'],
      defaultIcon: 'crown',
    };
    const config = buildSimpleProfileConfig(role, 'ceo', 'Acme Research', 'us-kimi-k2.6', 'deepseek');
    expect(config.proxyProvider).toBe('deepseek');
  });
});
