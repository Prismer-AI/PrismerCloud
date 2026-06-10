import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMcpAllowlist, isToolAllowed } from '../src/lib/client.js';
import { selectAllowedToolRegistrations, toolRegistrations, type ToolRegistration } from '../src/index.js';

describe('ACP L2 MCP allowlist', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.PRISMER_API_KEY;
    delete process.env.PRISMER_BASE_URL;
    delete process.env.PRISMER_MCP_ALLOWLIST;
    delete process.env.PRISMER_DAEMON_URL;
    delete process.env.PRISMER_LOCAL_DAEMON_URL;
    delete process.env.PRISMER_DAEMON_PORT;
    delete process.env.PRISMER_RUNTIME_PORT;
    delete process.env.PRISMER_LOCAL_PORT;
  });

  it('filters registered tools when an allowlist exists', () => {
    const registrations = [
      { name: 'prismer.task.create', register: vi.fn() },
      { name: 'prismer.task.approve', register: vi.fn() },
      { name: 'prismer.memory.read', register: vi.fn() },
    ] satisfies ToolRegistration[];

    const allowed = selectAllowedToolRegistrations(
      registrations,
      parseMcpAllowlist('prismer.task.create,prismer.memory.*'),
    );

    expect(allowed.map((entry) => entry.name)).toEqual(['prismer.task.create', 'prismer.memory.read']);
  });

  it('exposes explicit skill_sync as a first-class MCP tool name', () => {
    const names = toolRegistrations.map((entry) => entry.name);

    expect(names).toContain('prismer.skill.sync');
    expect(names).toContain('skill_sync');
    expect(
      selectAllowedToolRegistrations(toolRegistrations, parseMcpAllowlist('skill_sync')).map((entry) => entry.name),
    ).toEqual(['skill_sync']);
  });

  it('keeps the dotted skill sync compatibility name allowlisted independently', () => {
    expect(
      selectAllowedToolRegistrations(toolRegistrations, parseMcpAllowlist('prismer.skill.sync')).map(
        (entry) => entry.name,
      ),
    ).toEqual(['prismer.skill.sync']);
  });

  it('registers bounded local asset tools for workspace file access', () => {
    const names = toolRegistrations.map((entry) => entry.name);

    expect(names).toContain('prismer.asset.search');
    expect(names).toContain('prismer.asset.describe');
    expect(names).toContain('prismer.asset.read');
    expect(
      selectAllowedToolRegistrations(toolRegistrations, parseMcpAllowlist('prismer.asset.*')).map(
        (entry) => entry.name,
      ),
    ).toEqual(['prismer.asset.search', 'prismer.asset.describe', 'prismer.asset.read']);
  });

  it('allows exact and prefix matches, and denies non-matches', () => {
    const rules = parseMcpAllowlist('prismer.task.create, prismer.memory.*');

    expect(isToolAllowed('prismer.task.create', rules)).toBe(true);
    expect(isToolAllowed('prismer.memory.read', rules)).toBe(true);
    expect(isToolAllowed('prismer.task.approve', rules)).toBe(false);
  });

  it('asset tools call the local daemon instead of the cloud API', async () => {
    process.env.PRISMER_API_KEY = 'sk-prismer-test';
    process.env.PRISMER_BASE_URL = 'https://cloud.example.test';
    process.env.PRISMER_WORKSPACE_ID = 'ws_1';
    process.env.PRISMER_DAEMON_URL = 'http://127.0.0.1:3999';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          asset: { assetId: 'asset_1', filename: 'report.md', contentHash: 'hash_1' },
          cache: { status: 'miss' },
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { registerAssetDescribe } = await import('../src/tools/asset-describe.js');
    let handler: ((args: any) => Promise<any>) | null = null;
    const server = {
      tool: (_name: string, _description: string, _schema: unknown, cb: typeof handler) => {
        handler = cb;
      },
    };
    registerAssetDescribe(server as any);

    const result = await handler?.({ assetId: 'asset_1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3999/local/asset/describe');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      workspaceId: 'ws_1',
      assetId: 'asset_1',
    });
    expect(result.content[0].text).toContain('report.md');
  });

  it('guards each API call before direct cloud fetch', async () => {
    process.env.PRISMER_API_KEY = 'sk-prismer-test';
    process.env.PRISMER_BASE_URL = 'https://example.test';
    process.env.PRISMER_MCP_ALLOWLIST = 'prismer.task.create';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { prismerFetch } = await import('../src/lib/client.js');

    await expect(prismerFetch('/api/im/tasks/123/approve', { method: 'POST' })).rejects.toThrow(
      'tool_not_allowed_for_agent: prismer.task.approve',
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(prismerFetch('/api/im/tasks', { method: 'POST', body: { title: 'ok' } })).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces task permission failures as actionable MCP text', async () => {
    process.env.PRISMER_API_KEY = 'sk-prismer-test';
    process.env.PRISMER_BASE_URL = 'https://example.test';
    process.env.PRISMER_MCP_ALLOWLIST = 'prismer.task.create';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { prismerFetch, formatMcpToolError } = await import('../src/lib/client.js');

    await expect(prismerFetch('/api/im/tasks/123/approve', { method: 'POST' })).rejects.toThrow(
      'tool_not_allowed_for_agent: prismer.task.approve',
    );
    try {
      await prismerFetch('/api/im/tasks/123/approve', { method: 'POST' });
    } catch (error) {
      expect(formatMcpToolError(error)).toContain('Permission denied');
      expect(formatMcpToolError(error)).toContain('prismer.task.approve');
      expect(formatMcpToolError(error)).toContain('MCP allowlist');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves cloud-side allowlist denial code for MCP task tools', async () => {
    process.env.PRISMER_API_KEY = 'sk-prismer-test';
    process.env.PRISMER_BASE_URL = 'https://example.test';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({
          ok: false,
          error: {
            code: 'TOOL_NOT_ALLOWED_FOR_AGENT',
            message: 'Tool prismer.task.approve is not allowed for this agent profile',
          },
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { prismerFetch, formatMcpToolError } = await import('../src/lib/client.js');

    try {
      await prismerFetch('/api/im/tasks/123/approve', { method: 'POST' });
      throw new Error('expected denial');
    } catch (error) {
      expect(formatMcpToolError(error)).toContain('Permission denied');
      expect(formatMcpToolError(error)).toContain('prismer.task.approve');
      expect(formatMcpToolError(error)).toContain('authorized agent');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('create task resolves @username assignees and defaults workspace from daemon env', async () => {
    process.env.PRISMER_API_KEY = 'sk-prismer-test';
    process.env.PRISMER_BASE_URL = 'https://example.test';
    process.env.PRISMER_WORKSPACE_ID = 'ws_1';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: [{ userId: 'agent_support', username: 'mvp_support_urtsw', name: '客服' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: 'task_1', status: 'assigned' } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { registerCreateTask } = await import('../src/tools/create-task.js');
    let handler: ((args: any) => Promise<unknown>) | null = null;
    const server = {
      tool: (_name: string, _description: string, _schema: unknown, cb: typeof handler) => {
        handler = cb;
      },
    };
    registerCreateTask(server as any);

    await handler?.({
      title: 'Hello World',
      assignee_name: '@mvp_support_urtsw',
      kind: 'work_item',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const createCall = fetchMock.mock.calls[1];
    expect(JSON.parse(createCall[1].body)).toMatchObject({
      title: 'Hello World',
      assigneeId: 'agent_support',
      workspaceId: 'ws_1',
      metadata: { kind: 'work_item' },
    });
  });

  it('create task refuses unresolved assignee names instead of creating unassigned cards', async () => {
    process.env.PRISMER_API_KEY = 'sk-prismer-test';
    process.env.PRISMER_BASE_URL = 'https://example.test';
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, data: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { registerCreateTask } = await import('../src/tools/create-task.js');
    let handler: ((args: any) => Promise<any>) | null = null;
    const server = {
      tool: (_name: string, _description: string, _schema: unknown, cb: typeof handler) => {
        handler = cb;
      },
    };
    registerCreateTask(server as any);

    const result = await handler?.({ title: 'Hello World', assignee_name: '@missing_agent' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('did not resolve');
  });

  it('approval requests default workspace from daemon env', async () => {
    process.env.PRISMER_API_KEY = 'sk-prismer-test';
    process.env.PRISMER_BASE_URL = 'https://example.test';
    process.env.PRISMER_WORKSPACE_ID = 'ws_1';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { id: 'approval_1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { registerRequestHumanApproval } = await import('../src/tools/request-human-approval.js');
    let handler: ((args: any) => Promise<unknown>) | null = null;
    const server = {
      tool: (_name: string, _description: string, _schema: unknown, cb: typeof handler) => {
        handler = cb;
      },
    };
    registerRequestHumanApproval(server as any);

    await handler?.({ title: 'Approve delivery', category: 'general' });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      workspaceId: 'ws_1',
      title: 'Approve delivery',
    });
  });
});
