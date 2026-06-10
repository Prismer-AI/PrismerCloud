/**
 * release201/13 §3.4 + §11 13-P2 — Agent skill config update unit tests.
 *
 * Covers AgentSkillService.updateSkillConfig:
 *   • happy path: writes config JSON + clears installedRevision (forces resync)
 *   • config schema validation (required + type + enum)
 *   • workspace mismatch returns 404 (no cross-workspace leak)
 *   • not-installed returns 404
 *   • free-form config when skill declares no configSchema
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    iMSkill: {
      findFirst: vi.fn(),
    },
    iMAgentSkill: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../db', () => ({ default: mocks.prisma }));

import { AgentSkillError, AgentSkillService, validateAgainstConfigSchema } from '../services/agent-skill.service';

const skillWithSchema = {
  id: 'skill-1',
  slug: 'echo-skill',
  content: '## echo skill',
  contentManifestRevision: 'abc123',
  metadata: '{}',
  source: 'community',
  executableJson: {
    configSchema: {
      type: 'object',
      required: ['greeting'],
      properties: {
        greeting: { type: 'string' },
        retries: { type: 'integer' },
        mode: { type: 'string', enum: ['echo', 'reverse'] },
      },
    },
  },
};

const skillNoSchema = {
  id: 'skill-2',
  slug: 'plain-skill',
  content: '## plain',
  contentManifestRevision: 'def456',
  metadata: '{}',
  source: 'community',
  executableJson: {},
};

function makeService(): AgentSkillService {
  const fakeSkillService = {} as any;
  return new AgentSkillService(fakeSkillService);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AgentSkillService.updateSkillConfig', () => {
  it('happy path: validates + writes config + clears installedRevision', async () => {
    mocks.prisma.iMSkill.findFirst.mockResolvedValue(skillWithSchema);
    mocks.prisma.iMAgentSkill.findUnique.mockResolvedValue({
      id: 'as-1',
      agentId: 'agent-1',
      skillId: 'skill-1',
      config: '{}',
      installedRevision: 'abc123',
      workspaceId: 'ws-1',
    });
    mocks.prisma.iMAgentSkill.update.mockResolvedValue({
      id: 'as-1',
      installedRevision: null,
    });

    const result = await makeService().updateSkillConfig('agent-1', 'echo-skill', {
      greeting: 'hi',
      retries: 3,
      mode: 'echo',
    });

    expect(mocks.prisma.iMAgentSkill.update).toHaveBeenCalledTimes(1);
    const updateArg = mocks.prisma.iMAgentSkill.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 'as-1' });
    expect(JSON.parse(updateArg.data.config)).toEqual({ greeting: 'hi', retries: 3, mode: 'echo' });
    expect(updateArg.data.installedRevision).toBeNull();
    expect(updateArg.data.lastSyncError).toBeNull();
    expect(result.synced).toBe(false);
  });

  it('rejects missing required field', async () => {
    mocks.prisma.iMSkill.findFirst.mockResolvedValue(skillWithSchema);
    mocks.prisma.iMAgentSkill.findUnique.mockResolvedValue({
      id: 'as-1',
      agentId: 'agent-1',
      skillId: 'skill-1',
      config: '{}',
      workspaceId: null,
    });

    await expect(makeService().updateSkillConfig('agent-1', 'echo-skill', { retries: 5 })).rejects.toMatchObject({
      message: expect.stringContaining("missing required field 'greeting'"),
      statusCode: 400,
    });
    expect(mocks.prisma.iMAgentSkill.update).not.toHaveBeenCalled();
  });

  it('rejects wrong type', async () => {
    mocks.prisma.iMSkill.findFirst.mockResolvedValue(skillWithSchema);
    mocks.prisma.iMAgentSkill.findUnique.mockResolvedValue({
      id: 'as-1',
      agentId: 'agent-1',
      skillId: 'skill-1',
      config: '{}',
      workspaceId: null,
    });

    await expect(
      makeService().updateSkillConfig('agent-1', 'echo-skill', {
        greeting: 'hi',
        retries: 'three',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("field 'retries' expected integer"),
      statusCode: 400,
    });
  });

  it('rejects enum violation', async () => {
    mocks.prisma.iMSkill.findFirst.mockResolvedValue(skillWithSchema);
    mocks.prisma.iMAgentSkill.findUnique.mockResolvedValue({
      id: 'as-1',
      agentId: 'agent-1',
      skillId: 'skill-1',
      config: '{}',
      workspaceId: null,
    });

    await expect(
      makeService().updateSkillConfig('agent-1', 'echo-skill', {
        greeting: 'hi',
        mode: 'shout',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("field 'mode' not in enum"),
      statusCode: 400,
    });
  });

  it('rejects workspace mismatch (no cross-workspace leak)', async () => {
    mocks.prisma.iMSkill.findFirst.mockResolvedValue(skillWithSchema);
    mocks.prisma.iMAgentSkill.findUnique.mockResolvedValue({
      id: 'as-1',
      agentId: 'agent-1',
      skillId: 'skill-1',
      config: '{}',
      workspaceId: 'ws-other',
    });

    await expect(
      makeService().updateSkillConfig(
        'agent-1',
        'echo-skill',
        { greeting: 'hi' },
        {
          workspaceId: 'ws-1',
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('returns 404 when skill missing', async () => {
    mocks.prisma.iMSkill.findFirst.mockResolvedValue(null);
    await expect(makeService().updateSkillConfig('agent-1', 'no-such', {})).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns 404 when skill not installed on agent', async () => {
    mocks.prisma.iMSkill.findFirst.mockResolvedValue(skillWithSchema);
    mocks.prisma.iMAgentSkill.findUnique.mockResolvedValue(null);
    await expect(makeService().updateSkillConfig('agent-1', 'echo-skill', { greeting: 'hi' })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('accepts free-form config when skill has no configSchema', async () => {
    mocks.prisma.iMSkill.findFirst.mockResolvedValue(skillNoSchema);
    mocks.prisma.iMAgentSkill.findUnique.mockResolvedValue({
      id: 'as-2',
      agentId: 'agent-1',
      skillId: 'skill-2',
      config: '{}',
      workspaceId: null,
    });
    mocks.prisma.iMAgentSkill.update.mockResolvedValue({ id: 'as-2' });

    await expect(
      makeService().updateSkillConfig('agent-1', 'plain-skill', {
        anything: 'goes',
        nested: { yes: true },
      }),
    ).resolves.toMatchObject({ synced: false });
  });
});

describe('validateAgainstConfigSchema (pure)', () => {
  it('passes when no schema declared', () => {
    expect(validateAgainstConfigSchema({}, { x: 1 })).toEqual({ ok: true });
    expect(validateAgainstConfigSchema({ executableJson: {} }, { x: 1 })).toEqual({ ok: true });
  });

  it('aggregates multiple validation errors', () => {
    const result = validateAgainstConfigSchema(skillWithSchema, {
      retries: 'no',
      mode: 'invalid',
      // greeting missing
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(3);
      expect(result.errors.some((e) => e.includes('greeting'))).toBe(true);
      expect(result.errors.some((e) => e.includes('retries'))).toBe(true);
      expect(result.errors.some((e) => e.includes('mode'))).toBe(true);
    }
  });

  it('reads runtime.configSchema fallback', () => {
    const skill = {
      executableJson: { runtime: { configSchema: { type: 'object', required: ['url'] } } },
    };
    expect(validateAgainstConfigSchema(skill, {})).toMatchObject({ ok: false });
    expect(validateAgainstConfigSchema(skill, { url: 'x' })).toEqual({ ok: true });
  });
});

// Sanity check: ensure AgentSkillError carries statusCode for the route layer
describe('AgentSkillError', () => {
  it('carries statusCode for HTTP mapping', () => {
    const e = new AgentSkillError('msg', 404);
    expect(e.statusCode).toBe(404);
    expect(e.message).toBe('msg');
  });
});
