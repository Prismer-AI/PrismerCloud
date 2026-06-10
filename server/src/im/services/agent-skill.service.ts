import crypto from 'crypto';
import prisma from '../db';
import type { SkillService } from './skill.service';

const LOG = '[AgentSkillService]';

export interface AgentSkillAckInput {
  skillId?: string;
  slug?: string;
  revision?: string;
  installedRevision?: string;
  status?: string;
  error?: string | null;
  lastSyncError?: string | null;
}

export class AgentSkillService {
  constructor(private skillService: SkillService) {}

  async listAgentSkills(agentId: string, workspaceId?: string, includeInactive = false) {
    const where: any = { agentId };
    if (workspaceId) where.workspaceId = workspaceId;
    if (!includeInactive) where.status = 'active';

    const records = await prisma.iMAgentSkill.findMany({
      where,
      orderBy: { installedAt: 'desc' },
    });
    if (records.length === 0) return [];

    const skillIds = records.map((record: any) => record.skillId);
    const skills = await prisma.iMSkill.findMany({ where: { id: { in: skillIds } } });
    const skillMap = new Map<string, any>(skills.map((skill: any) => [skill.id, skill]));

    return records.map((record: any) => {
      const skill = skillMap.get(record.skillId) ?? null;
      return {
        agentSkill: record,
        skill,
        expectedRevision: skill ? computeSkillRevision(skill) : null,
        syncState: getSyncState(record, skill),
      };
    });
  }

  async installSkillToAgent(
    agentId: string,
    skillIdOrSlug: string,
    options: { workspaceId?: string; config?: Record<string, unknown>; version?: string } = {},
  ) {
    const result = await this.skillService.installSkill(agentId, skillIdOrSlug, 'global', options);
    console.log(`${LOG} Install requested: agent=${agentId} skill=${result.skill.slug}`);
    return result;
  }

  async uninstallSkillFromAgent(agentId: string, skillIdOrSlug: string, workspaceId?: string) {
    const skill = await prisma.iMSkill.findFirst({
      where: { OR: [{ id: skillIdOrSlug }, { slug: skillIdOrSlug }] },
    });
    if (!skill) return { changed: false, status: 'not_found' as const };

    const agentSkill = await prisma.iMAgentSkill.findUnique({
      where: { agentId_skillId: { agentId, skillId: skill.id } },
    });
    if (!agentSkill) return { changed: false, status: 'not_installed' as const };
    if (workspaceId && agentSkill.workspaceId && agentSkill.workspaceId !== workspaceId) {
      return { changed: false, status: 'not_installed' as const };
    }

    if (isBuiltInSkill(skill)) {
      await prisma.iMAgentSkill.update({
        where: { id: agentSkill.id },
        data: { status: 'disabled', updatedAt: new Date(), lastSyncError: null },
      });
      console.log(`${LOG} Disabled built-in skill "${skill.slug}" for agent ${agentId.slice(-8)}`);
      return { changed: true, status: 'disabled' as const, builtIn: true };
    }

    const uninstalled = await this.skillService.uninstallSkill(agentId, skill.id);
    return { changed: uninstalled, status: uninstalled ? ('uninstalled' as const) : ('not_active' as const) };
  }

  async ackAgentSkill(agentId: string, input: AgentSkillAckInput) {
    const skillIdOrSlug = input.skillId ?? input.slug;
    if (!skillIdOrSlug) {
      throw new AgentSkillError('skillId or slug is required', 400);
    }

    const skill = await prisma.iMSkill.findFirst({
      where: { OR: [{ id: skillIdOrSlug }, { slug: skillIdOrSlug }] },
    });
    if (!skill) throw new AgentSkillError('Skill not found', 404);

    const agentSkill = await prisma.iMAgentSkill.findUnique({
      where: { agentId_skillId: { agentId, skillId: skill.id } },
    });
    if (!agentSkill) throw new AgentSkillError('Agent skill not found', 404);

    const error = input.lastSyncError ?? input.error ?? null;
    const expected = computeSkillRevision(skill);
    const installedRevision = input.installedRevision ?? input.revision ?? expected;
    const updated = await prisma.iMAgentSkill.update({
      where: { id: agentSkill.id },
      data: {
        installedRevision,
        lastSyncedAt: new Date(),
        lastSyncError: error,
        ...(input.status ? { status: input.status } : {}),
        updatedAt: new Date(),
      },
    });

    return {
      agentSkill: updated,
      skill,
      expectedRevision: expected,
      synced: !error && updated.installedRevision === expected,
    };
  }

  async listPendingAgentSkills(agentId: string, workspaceId?: string) {
    const items = await this.listAgentSkills(agentId, workspaceId);
    return items.filter((item: any) => item.syncState !== 'synced');
  }

  /**
   * Update an agent's per-skill config (release201/13 §3.4 + §11 13-P2).
   *
   * Validates the supplied config against the skill's `executableJson.configSchema`
   * (release201/07 §2.6 manifest). After the row is updated, the agent-skill is
   * flagged "pending" by clearing `installedRevision`; the daemon picks this up
   * on its next poll via `GET /:agentId/skills/pending` and re-syncs.
   */
  async updateSkillConfig(
    agentId: string,
    skillIdOrSlug: string,
    config: Record<string, unknown>,
    options: { workspaceId?: string } = {},
  ) {
    const skill = await prisma.iMSkill.findFirst({
      where: { OR: [{ id: skillIdOrSlug }, { slug: skillIdOrSlug }] },
    });
    if (!skill) throw new AgentSkillError('Skill not found', 404);

    const agentSkill = await prisma.iMAgentSkill.findUnique({
      where: { agentId_skillId: { agentId, skillId: skill.id } },
    });
    if (!agentSkill) throw new AgentSkillError('Agent skill not found', 404);
    if (options.workspaceId && agentSkill.workspaceId && agentSkill.workspaceId !== options.workspaceId) {
      throw new AgentSkillError('Agent skill not in supplied workspace', 404);
    }

    const validation = validateAgainstConfigSchema(skill, config);
    if (!validation.ok) {
      throw new AgentSkillError(`config validation failed: ${validation.errors.join('; ')}`, 400);
    }

    const updated = await prisma.iMAgentSkill.update({
      where: { id: agentSkill.id },
      data: {
        config: JSON.stringify(config ?? {}),
        // Clear installedRevision so the next pending-poll picks it up; daemon
        // will re-sync the row (including the new config blob) and re-ack.
        installedRevision: null,
        lastSyncError: null,
        updatedAt: new Date(),
      },
    });

    console.log(
      `${LOG} Config updated: agent=${agentId.slice(-8)} skill=${skill.slug} keys=[${Object.keys(config ?? {}).join(',')}]`,
    );

    return {
      agentSkill: updated,
      skill,
      expectedRevision: computeSkillRevision(skill),
      synced: false,
    };
  }
}

export class AgentSkillError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}

/**
 * Compute the "expected revision" the daemon must ack to be considered synced.
 *
 * v2.1 §A.7: prefer the manifest merkle root (`contentManifestRevision`)
 * which covers all files in the skill, not just SKILL.md. Fall back to
 * `sha256(content)` when manifest is missing — covers (a) backfill failures
 * and (b) the dual-write window for v2.0 clients that only wrote `content`.
 *
 * Accepts either a skill object (preferred) or a bare content string
 * (legacy callers; will be removed when the 6-month dual-write window closes).
 */
export function computeSkillRevision(
  skillOrContent: { content?: string | null; contentManifestRevision?: string | null } | string,
): string {
  if (typeof skillOrContent === 'string') {
    return crypto
      .createHash('sha256')
      .update(skillOrContent || '')
      .digest('hex');
  }
  const manifestRev = skillOrContent?.contentManifestRevision;
  if (manifestRev && typeof manifestRev === 'string' && manifestRev.length > 0) {
    return manifestRev;
  }
  return crypto
    .createHash('sha256')
    .update(skillOrContent?.content || '')
    .digest('hex');
}

export function isBuiltInSkill(skill: { metadata?: string | null; source?: string | null }): boolean {
  const metadata = parseJsonObject(skill.metadata);
  return metadata.source === 'built-in' || skill.source === 'built-in';
}

function getSyncState(record: any, skill: any): 'pending' | 'synced' | 'error' {
  if (record.lastSyncError) return 'error';
  if (!skill) return 'pending';
  return record.installedRevision === computeSkillRevision(skill) ? 'synced' : 'pending';
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * release201/13 §3.4 / 07 §2.6 — Lightweight config validator.
 *
 * Reads `IMSkill.executableJson.configSchema` (a JSON-schema-like shape with
 * `type`, optional `required`, `properties`) and verifies the supplied config:
 *   • required keys are present
 *   • property `type` matches (string|number|integer|boolean|array|object)
 *   • enum membership (if declared)
 *
 * No external dependency: a real ajv pass can be added later when 07's full
 * authoring engine ships richer schemas. This is intentionally permissive on
 * unknown properties — skills will accumulate fields between revisions and we
 * don't want stale clients to be locked out.
 */
export function validateAgainstConfigSchema(
  skill: { executableJson?: unknown },
  config: Record<string, unknown>,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const schema = extractConfigSchema(skill.executableJson);
  if (!schema) return { ok: true };

  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (config[key] === undefined) errors.push(`missing required field '${key}'`);
    }
  }

  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
  if (props) {
    for (const [key, descriptor] of Object.entries(props)) {
      const value = config[key];
      if (value === undefined) continue;
      const d = descriptor as { type?: string; enum?: unknown[] };
      if (d.type && !matchesType(value, d.type)) {
        errors.push(`field '${key}' expected ${d.type}, got ${actualType(value)}`);
      }
      if (Array.isArray(d.enum) && !d.enum.includes(value as never)) {
        errors.push(`field '${key}' not in enum (${d.enum.map(String).join(', ')})`);
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function extractConfigSchema(executableJson: unknown): {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
} | null {
  if (executableJson == null) return null;
  let parsed: any = executableJson;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object') return null;
  // Authoring engine often parks the schema under `configSchema` at the top of
  // executableJson, but some adapters use a nested `runtime.configSchema`. Try
  // both forms before giving up.
  const candidate = parsed.configSchema ?? parsed?.runtime?.configSchema ?? null;
  if (!candidate || typeof candidate !== 'object') return null;
  return candidate;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function actualType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
