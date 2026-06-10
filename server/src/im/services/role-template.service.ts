/**
 * Prismer IM — ACP Role Template Service
 *
 * Cloud-side role templates are executable agent blueprints. They carry the
 * skills and MCP server config that daemon/runtime code can sync later.
 */

import prisma from '../db';
import { SkillService } from './skill.service';

const LOG = '[RoleTemplateService]';

export interface I18nString {
  zh?: string;
  en?: string;
  [locale: string]: string | undefined;
}

export interface SkillRequirement {
  skillSlug: string;
  version?: string;
  config?: Record<string, unknown>;
  required?: boolean;
}

export interface McpServerConfig {
  name: string;
  package: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  env?: Record<string, string>;
  args?: string[];
  toolsAllowlist?: string[];
}

export interface RoleTemplateInput {
  slug?: string;
  version?: string;
  name?: I18nString | string;
  displayName?: I18nString | string;
  description?: I18nString | string;
  agentType?: string;
  category?: string;
  tags?: string[];
  baseSkillSet?: string;
  requiredSkills?: SkillRequirement[];
  mcpServers?: McpServerConfig[];
  hermesConfig?: Record<string, unknown> | null;
  openclawConfig?: Record<string, unknown> | null;
  adapters?: {
    hermes?: Record<string, unknown>;
    openclaw?: Record<string, unknown>;
  };
  operatingPrinciples?: I18nString | string | Record<string, unknown> | null;
  taskAuthority?: 'executor' | 'orchestrator';
  approvalPolicy?: 'strict' | 'auto-low-risk' | 'autonomous';
  status?: string;
  source?: string;
  sourceSlug?: string | null;
  sourceCommit?: string | null;
  importedAt?: Date | string | null;
  curatedQuality?: 'gold' | 'silver' | 'bronze' | 'review' | string;
  metadata?: Record<string, unknown> | null;
}

export interface RoleTemplateListOptions {
  category?: string;
  agentType?: string;
  status?: string;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringifyJson(value: unknown, fallback: unknown): string {
  if (value === undefined) return JSON.stringify(fallback);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return JSON.stringify(fallback);
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return JSON.stringify({ en: value });
    }
  }
  return JSON.stringify(value ?? fallback);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function coerceDate(value: Date | string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

export class RoleTemplateService {
  constructor(private skillService = new SkillService()) {}

  async list(opts: RoleTemplateListOptions = {}) {
    const where: Record<string, unknown> = {};
    where.status = opts.status || 'active';
    if (opts.category) where.category = opts.category;
    if (opts.agentType) where.agentType = opts.agentType;

    const rows = await (prisma as any).iMRoleTemplate.findMany({
      where,
      orderBy: [{ category: 'asc' }, { slug: 'asc' }],
    });
    return rows.map((row: any) => this.toDto(row));
  }

  async get(slugOrId: string) {
    const row = await (prisma as any).iMRoleTemplate.findFirst({
      where: { OR: [{ id: slugOrId }, { slug: slugOrId }] },
    });
    return row ? this.toDto(row) : null;
  }

  async create(input: RoleTemplateInput) {
    const name = input.displayName ?? input.name ?? {};
    const slug = input.slug || slugify(typeof name === 'string' ? name : name.en || name.zh || 'role-template');
    if (!slug) throw new Error('slug is required');

    const row = await (prisma as any).iMRoleTemplate.create({
      data: {
        slug,
        version: input.version || '1.0.0',
        name: stringifyJson(name, {}),
        description: stringifyJson(input.description ?? {}, {}),
        agentType: input.agentType || 'specialist',
        category: input.category || 'general',
        tags: stringifyJson(input.tags || [], []),
        baseSkillSet: input.baseSkillSet || 'prismer-base',
        requiredSkills: stringifyJson(input.requiredSkills || [], []),
        mcpServers: stringifyJson(input.mcpServers || [], []),
        hermesConfig: input.adapters?.hermes
          ? stringifyJson(input.adapters.hermes, {})
          : stringifyJson(input.hermesConfig, {}),
        openclawConfig: input.adapters?.openclaw
          ? stringifyJson(input.adapters.openclaw, {})
          : stringifyJson(input.openclawConfig, {}),
        operatingPrinciples:
          input.operatingPrinciples === undefined ? null : stringifyJson(input.operatingPrinciples, {}),
        taskAuthority: input.taskAuthority || (input.agentType === 'orchestrator' ? 'orchestrator' : 'executor'),
        approvalPolicy: input.approvalPolicy || 'auto-low-risk',
        status: input.status || 'active',
        source: input.source || 'prismer-native',
        sourceSlug: input.sourceSlug ?? null,
        sourceCommit: input.sourceCommit ?? null,
        importedAt: coerceDate(input.importedAt) ?? null,
        curatedQuality: input.curatedQuality || 'review',
        metadata: input.metadata ?? null,
      },
    });
    console.log(`${LOG} Created role template ${row.slug}`);
    return this.toDto(row);
  }

  async update(slugOrId: string, input: RoleTemplateInput) {
    const existing = await (prisma as any).iMRoleTemplate.findFirst({
      where: { OR: [{ id: slugOrId }, { slug: slugOrId }] },
    });
    if (!existing) return null;

    const data: Record<string, unknown> = {};
    if (input.slug !== undefined) data.slug = input.slug;
    if (input.version !== undefined) data.version = input.version;
    if (input.name !== undefined || input.displayName !== undefined)
      data.name = stringifyJson(input.displayName ?? input.name, {});
    if (input.description !== undefined) data.description = stringifyJson(input.description, {});
    if (input.agentType !== undefined) data.agentType = input.agentType;
    if (input.category !== undefined) data.category = input.category;
    if (input.tags !== undefined) data.tags = stringifyJson(input.tags, []);
    if (input.baseSkillSet !== undefined) data.baseSkillSet = input.baseSkillSet;
    if (input.requiredSkills !== undefined) data.requiredSkills = stringifyJson(input.requiredSkills, []);
    if (input.mcpServers !== undefined) data.mcpServers = stringifyJson(input.mcpServers, []);
    if (input.adapters?.hermes !== undefined) data.hermesConfig = stringifyJson(input.adapters.hermes, {});
    if (input.adapters?.openclaw !== undefined) data.openclawConfig = stringifyJson(input.adapters.openclaw, {});
    if (input.hermesConfig !== undefined) data.hermesConfig = stringifyJson(input.hermesConfig, {});
    if (input.openclawConfig !== undefined) data.openclawConfig = stringifyJson(input.openclawConfig, {});
    if (input.operatingPrinciples !== undefined) {
      data.operatingPrinciples =
        input.operatingPrinciples === null ? null : stringifyJson(input.operatingPrinciples, {});
    }
    if (input.taskAuthority !== undefined) data.taskAuthority = input.taskAuthority;
    if (input.approvalPolicy !== undefined) data.approvalPolicy = input.approvalPolicy;
    if (input.status !== undefined) data.status = input.status;
    if (input.source !== undefined) data.source = input.source;
    if (input.sourceSlug !== undefined) data.sourceSlug = input.sourceSlug;
    if (input.sourceCommit !== undefined) data.sourceCommit = input.sourceCommit;
    if (input.importedAt !== undefined) data.importedAt = coerceDate(input.importedAt);
    if (input.curatedQuality !== undefined) data.curatedQuality = input.curatedQuality;
    if (input.metadata !== undefined) data.metadata = input.metadata;

    const row = await (prisma as any).iMRoleTemplate.update({ where: { id: existing.id }, data });
    console.log(`${LOG} Updated role template ${row.slug}`);
    return this.toDto(row);
  }

  async applyToAgent(agentImUserId: string, slugOrId: string, workspaceId?: string) {
    const template = await this.get(slugOrId);
    if (!template) throw new Error('Role template not found');

    const requiredSkills = (template.requiredSkills || []).filter((req: SkillRequirement) => req.required !== false);
    const installed = [];
    const errors = [];

    for (const requirement of requiredSkills) {
      if (!requirement.skillSlug) continue;
      try {
        const result = await this.skillService.installSkill(agentImUserId, requirement.skillSlug, 'global', {
          workspaceId,
          config: requirement.config,
          version: requirement.version,
        });
        installed.push({ skillSlug: requirement.skillSlug, agentSkill: result.agentSkill, skill: result.skill });
      } catch (err) {
        errors.push({ skillSlug: requirement.skillSlug, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      roleTemplate: template,
      installed,
      errors,
      skippedOptional: (template.requiredSkills || []).filter((req: SkillRequirement) => req.required === false),
      profile: await this.applyProfileSnapshot(agentImUserId, template, workspaceId),
    };
  }

  async preinstallRoleTemplateSkills(agentImUserId: string, roleTemplateSlugOrId: string, workspaceId?: string) {
    return this.applyToAgent(agentImUserId, roleTemplateSlugOrId, workspaceId);
  }

  private toDto(row: any) {
    const name = parseJson<I18nString>(row.name, {});
    const hermesConfig = parseJson<Record<string, unknown> | null>(row.hermesConfig, null);
    const openclawConfig = parseJson<Record<string, unknown> | null>(row.openclawConfig, null);
    const metadata = parseMetadata(row.metadata);
    return {
      id: row.id,
      slug: row.slug,
      version: row.version,
      name,
      displayName: name,
      description: parseJson<I18nString>(row.description, {}),
      agentType: row.agentType,
      category: row.category,
      tags: parseJson<string[]>(row.tags, []),
      baseSkillSet: row.baseSkillSet,
      requiredSkills: parseJson<SkillRequirement[]>(row.requiredSkills, []),
      mcpServers: parseJson<McpServerConfig[]>(row.mcpServers, []),
      hermesConfig,
      openclawConfig,
      adapters: { hermes: hermesConfig, openclaw: openclawConfig },
      operatingPrinciples: parseJson(row.operatingPrinciples, null),
      taskAuthority: row.taskAuthority ?? (row.agentType === 'orchestrator' ? 'orchestrator' : 'executor'),
      approvalPolicy: row.approvalPolicy ?? 'auto-low-risk',
      status: row.status,
      source: row.source ?? metadata?.source ?? 'prismer-native',
      sourceSlug: row.sourceSlug ?? metadata?.sourceSlug ?? null,
      sourceCommit: row.sourceCommit ?? null,
      importedAt: row.importedAt ?? null,
      curatedQuality: row.curatedQuality ?? metadata?.curatedQuality ?? 'review',
      metadata,
      license: typeof metadata?.license === 'string' ? metadata.license : undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async applyProfileSnapshot(agentImUserId: string, template: any, workspaceId?: string) {
    const where: Record<string, unknown> = { agentImUserId, deletedAt: null };
    if (workspaceId) where.workspaceId = workspaceId;
    const profile = await prisma.iMAgentProfile.findFirst({ where, orderBy: { updatedAt: 'desc' } });
    if (!profile) return null;

    const existing = parseJson<Record<string, unknown>>(profile.config, {});
    const mcpAllowlist = this.resolvePrismerAllowlist(template);
    const systemPrompt = this.resolveSystemPrompt(template, profile.adapterName);
    const nextConfig = {
      ...existing,
      roleTemplate: this.profileSnapshot(template),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(mcpAllowlist ? { mcpAllowlist } : {}),
      taskAuthority: template.taskAuthority ?? (template.agentType === 'orchestrator' ? 'orchestrator' : 'executor'),
      approvalPolicy: template.approvalPolicy ?? 'auto-low-risk',
      ...(template.operatingPrinciples ? { operatingPrinciples: template.operatingPrinciples } : {}),
    };
    return prisma.iMAgentProfile.update({
      where: { id: profile.id },
      data: { config: JSON.stringify(nextConfig), version: { increment: 1 } },
      select: { id: true, version: true, workspaceId: true, agentImUserId: true },
    });
  }

  private resolvePrismerAllowlist(template: any): string[] | null {
    const server = (template.mcpServers || []).find(
      (item: McpServerConfig) => item.package === '@prismer/mcp-server' || item.name === 'prismer-tasks',
    );
    return Array.isArray(server?.toolsAllowlist) ? server.toolsAllowlist : null;
  }

  private resolveSystemPrompt(template: any, adapterName?: string | null): string | null {
    const hermes = readRecord(template.hermesConfig);
    const openclaw = readRecord(template.openclawConfig);
    const preferred =
      adapterName === 'openclaw'
        ? readString(openclaw?.soul) ?? readString(hermes?.soul)
        : readString(hermes?.soul) ?? readString(openclaw?.soul);
    return preferred ?? readString(readRecord(template.metadata)?.systemPrompt);
  }

  private profileSnapshot(template: any) {
    return {
      id: template.id,
      slug: template.slug,
      version: template.version,
      requiredSkills: template.requiredSkills,
      mcpServers: template.mcpServers,
      hermesConfig: template.hermesConfig,
      openclawConfig: template.openclawConfig,
      operatingPrinciples: template.operatingPrinciples,
      taskAuthority: template.taskAuthority,
      approvalPolicy: template.approvalPolicy,
    };
  }
}

const defaultRoleTemplateService = new RoleTemplateService();

export async function preinstallRoleTemplateSkills(
  agentImUserId: string,
  roleTemplateSlugOrId: string,
  workspaceId?: string,
) {
  return defaultRoleTemplateService.preinstallRoleTemplateSkills(agentImUserId, roleTemplateSlugOrId, workspaceId);
}
