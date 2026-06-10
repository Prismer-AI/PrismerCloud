/**
 * Prismer IM — TaskCriteriaTemplateService (release201/10 §5.2)
 *
 * CRUD + lookup for `im_task_criteria_templates`. Two scopes co-exist:
 *
 *   - workspaceId IS NULL  → global (Prismer built-in, seeded once at cloud boot)
 *   - workspaceId IS 具体   → workspace-level (owner-defined)
 *
 * Lookup precedence (`getDefault`):
 *   1. workspace-scoped template with isDefault=true matching capability
 *   2. global template with isDefault=true matching capability
 *   3. NULL
 *
 * §3.3 seed list (4 global templates):
 *   - general       — 1 manual entry "task completed as described"
 *   - skill-tryout  — 3 entries (08 doc §8.3)
 *   - skill-review  — 3 entries
 *   - skill-publish — 2 entries
 */

import { prisma } from '@/lib/prisma';
import { createModuleLogger } from '@/lib/logger';

const log = createModuleLogger('TaskCriteriaTemplateService');

/**
 * Shape of a single criterion inside criteriaJson — minus runtime state.
 *
 * rev 2 (release201/10 §3.3 + §0.2.1) — DROP `kind`, `verifierConfig`.
 * REPLACE `verifierKind` → `verifyMode` (4-class abstract layer, not
 * implementation method). REPLACE `description` → `expectation`. ADD
 * `verifierAgentId` (NULL allowed — defaults to task.creatorId at apply
 * time; manual mode can be NULL entirely).
 */
export interface TemplateCriterion {
  verifyMode: 'qualitative' | 'quantitative' | 'agent-self-check' | 'manual';
  expectation: string;
  verifierAgentId?: string | null;
  required?: boolean;
  weight?: number;
}

export interface CriteriaTemplate {
  id: string;
  workspaceId: string | null;
  capability: string;
  name: string;
  description: string | null;
  criteria: TemplateCriterion[];
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTemplateInput {
  workspaceId?: string | null;
  capability: string;
  name: string;
  description?: string;
  criteria: TemplateCriterion[];
  isDefault?: boolean;
}

export interface UpdateTemplateInput {
  capability?: string;
  name?: string;
  description?: string;
  criteria?: TemplateCriterion[];
  isDefault?: boolean;
}

function toDTO(row: {
  id: string;
  workspaceId: string | null;
  capability: string;
  name: string;
  description: string | null;
  criteriaJson: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}): CriteriaTemplate {
  let criteria: TemplateCriterion[] = [];
  try {
    const parsed = JSON.parse(row.criteriaJson) as unknown;
    if (Array.isArray(parsed))
      criteria = parsed.map(rev1OrRev2ToTemplateCriterion).filter(Boolean) as TemplateCriterion[];
  } catch (err) {
    log.warn({ id: row.id, err }, 'template criteriaJson parse failed — returning empty');
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    capability: row.capability,
    name: row.name,
    description: row.description,
    criteria,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * rev 2 backfill helper — read existing rev 1 rows defensively. Maps
 * `kind` + `verifierKind` (rev 1) → `verifyMode` (rev 2). Drops
 * verifierConfig. Renames description → expectation.
 */
function rev1OrRev2ToTemplateCriterion(raw: unknown): TemplateCriterion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const mode =
    typeof r.verifyMode === 'string'
      ? (r.verifyMode as TemplateCriterion['verifyMode'])
      : typeof r.verifierKind === 'string'
        ? r.verifierKind === 'automated'
          ? ('quantitative' as const)
          : (r.verifierKind as TemplateCriterion['verifyMode'])
        : ('manual' as const);
  const expectation =
    typeof r.expectation === 'string' && r.expectation
      ? r.expectation
      : typeof r.description === 'string'
        ? (r.description as string)
        : '';
  if (!expectation) return null;
  return {
    verifyMode: mode,
    expectation,
    verifierAgentId: typeof r.verifierAgentId === 'string' ? (r.verifierAgentId as string) : null,
    required: r.required === false ? false : true,
    weight: typeof r.weight === 'number' ? r.weight : 1,
  };
}

export class TaskCriteriaTemplateService {
  /** List all global templates (workspaceId IS NULL). */
  async listGlobal(): Promise<CriteriaTemplate[]> {
    const rows = await (prisma as any).iMTaskCriteriaTemplate.findMany({
      where: { workspaceId: null },
      orderBy: [{ capability: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toDTO);
  }

  /** List templates for a workspace + global ones (workspace shadows global). */
  async listForWorkspace(workspaceId: string): Promise<CriteriaTemplate[]> {
    const rows = await (prisma as any).iMTaskCriteriaTemplate.findMany({
      where: {
        OR: [{ workspaceId }, { workspaceId: null }],
      },
      orderBy: [{ capability: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toDTO);
  }

  async getById(id: string): Promise<CriteriaTemplate | null> {
    const row = await (prisma as any).iMTaskCriteriaTemplate.findUnique({ where: { id } });
    return row ? toDTO(row) : null;
  }

  /**
   * §5.2 — pick the best matching template for a (capability, workspaceId)
   * pair. Workspace-scoped default beats global default; isDefault=true
   * is required.
   */
  async getDefault(capability: string, workspaceId?: string | null): Promise<CriteriaTemplate | null> {
    if (workspaceId) {
      const wsScoped = await (prisma as any).iMTaskCriteriaTemplate.findFirst({
        where: { capability, workspaceId, isDefault: true },
      });
      if (wsScoped) return toDTO(wsScoped);
    }
    const global = await (prisma as any).iMTaskCriteriaTemplate.findFirst({
      where: { capability, workspaceId: null, isDefault: true },
    });
    return global ? toDTO(global) : null;
  }

  async list(query: { capability?: string; workspaceId?: string | null }): Promise<CriteriaTemplate[]> {
    const where: Record<string, unknown> = {};
    if (query.capability) where.capability = query.capability;
    if (query.workspaceId !== undefined) where.workspaceId = query.workspaceId;
    const rows = await (prisma as any).iMTaskCriteriaTemplate.findMany({
      where,
      orderBy: [{ capability: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toDTO);
  }

  async create(input: CreateTemplateInput): Promise<CriteriaTemplate> {
    if (!input.capability) throw new Error('capability is required');
    if (!input.name) throw new Error('name is required');
    if (!Array.isArray(input.criteria) || input.criteria.length === 0) {
      throw new Error('criteria[] must be non-empty');
    }
    const row = await (prisma as any).iMTaskCriteriaTemplate.create({
      data: {
        workspaceId: input.workspaceId ?? null,
        capability: input.capability,
        name: input.name,
        description: input.description ?? null,
        criteriaJson: JSON.stringify(input.criteria),
        isDefault: input.isDefault ?? false,
      },
    });
    return toDTO(row);
  }

  async update(id: string, patch: UpdateTemplateInput): Promise<CriteriaTemplate | null> {
    const data: Record<string, unknown> = {};
    if (patch.capability !== undefined) data.capability = patch.capability;
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.criteria !== undefined) data.criteriaJson = JSON.stringify(patch.criteria);
    if (patch.isDefault !== undefined) data.isDefault = patch.isDefault;
    if (Object.keys(data).length === 0) return this.getById(id);
    const row = await (prisma as any).iMTaskCriteriaTemplate.update({ where: { id }, data }).catch(() => null);
    return row ? toDTO(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    try {
      await (prisma as any).iMTaskCriteriaTemplate.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Idempotent — only inserts a template if no row with the same
   * (workspaceId=null, capability, name) already exists. Safe to call on
   * every cloud boot.
   */
  async seedDefaults(): Promise<{ inserted: number; skipped: number }> {
    // rev 2 — verifyMode 4-class abstract, no implementation method. Each
    // expectation is markdown-free-form so verifier agent reads + decides
    // at runtime. NO verifierConfig.
    const seeds: CreateTemplateInput[] = [
      {
        capability: 'general',
        name: 'general (1 manual)',
        description: 'Minimum acceptance for ad-hoc tasks — reviewer manually confirms completion.',
        isDefault: true,
        criteria: [
          {
            verifyMode: 'manual',
            expectation: 'task completed as described in the SPEC',
            required: true,
            weight: 1,
          },
        ],
      },
      {
        capability: 'skill-tryout',
        name: 'skill tryout (3)',
        description:
          'After installing a skill, verify it loads, can be triggered once, and produces the expected output.',
        isDefault: true,
        criteria: [
          {
            verifyMode: 'quantitative',
            expectation:
              'a sample task using the new skill passes acceptance (verifier agent runs the sample and confirms outcome)',
            required: true,
            weight: 1,
          },
          {
            verifyMode: 'qualitative',
            expectation:
              'skill artifacts have acceptable quality (verifier agent inspects outputs against the SPEC objective)',
            required: true,
            weight: 1,
          },
          {
            verifyMode: 'agent-self-check',
            expectation:
              'assignee confirms: manifest valid, SKILL.md frontmatter complete (name / description / allowed-tools), bundle scaffolded with sample task included',
            required: true,
            weight: 1,
          },
        ],
      },
      {
        capability: 'skill-review',
        name: 'skill review (3)',
        description:
          'Reviewer-side checks for skill manifest, frontmatter, and security warnings — assignee self-confirms.',
        isDefault: true,
        criteria: [
          {
            verifyMode: 'agent-self-check',
            expectation: 'skill manifest is valid (parses; required fields present)',
            required: true,
            weight: 1,
          },
          {
            verifyMode: 'agent-self-check',
            expectation: 'SKILL.md frontmatter complete: name, description, allowed-tools fields all populated',
            required: true,
            weight: 1,
          },
          {
            verifyMode: 'agent-self-check',
            expectation: 'no security warnings raised during static validation',
            required: true,
            weight: 1,
          },
        ],
      },
      {
        capability: 'skill-publish',
        name: 'skill publish (2)',
        description: 'Pre-publish gate — license confirmed and sample task pass rate ≥ 80%.',
        isDefault: true,
        criteria: [
          {
            verifyMode: 'agent-self-check',
            expectation: 'license confirmed and declared in skill metadata (default MIT acceptable)',
            required: true,
            weight: 1,
          },
          {
            verifyMode: 'quantitative',
            expectation:
              'sample task pass rate ≥ 80% across last N runs (verifier agent runs the sample suite and reports pass-rate)',
            required: true,
            weight: 1,
          },
        ],
      },
    ];
    let inserted = 0;
    let skipped = 0;
    for (const seed of seeds) {
      const existing = await (prisma as any).iMTaskCriteriaTemplate.findFirst({
        where: { workspaceId: null, capability: seed.capability, name: seed.name },
      });
      if (existing) {
        skipped++;
        continue;
      }
      await this.create({ ...seed, workspaceId: null });
      inserted++;
    }
    log.info({ inserted, skipped }, 'seed default criteria templates complete');
    return { inserted, skipped };
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let _singleton: TaskCriteriaTemplateService | null = null;
export function getTaskCriteriaTemplateService(): TaskCriteriaTemplateService {
  if (!_singleton) _singleton = new TaskCriteriaTemplateService();
  return _singleton;
}
