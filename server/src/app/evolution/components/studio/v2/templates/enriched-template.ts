'use client';

/**
 * Templates — enriched role-template read model (local to the templates面).
 *
 * ─── Why this lives here and not in `../data/role-templates.ts` ──────────────
 * The shared `RoleTemplate` (v2/types.ts) is a *thin card* shape — name, type,
 * tier, skill/MCP slugs and a one-line principles **summary**. The new
 * "公共浏览 → 详情 → 收藏到私有 → 私有编辑" system needs the **full** blueprint:
 * `category`, the complete `description`, and the *full* operating-principles
 * list (not just the summary) so the detail panel + the private editor have
 * real content to show and fork. The live `GET /role_templates` DTO already
 * carries all of this (`toDto` returns `description` / `category` /
 * `operatingPrinciples` in full — verified in role-template.service.ts), so we
 * do NOT need a separate detail endpoint: the list response is the detail.
 *
 * We flatten the i18n DTO into a plain-string `EnrichedTemplate` at this client
 * boundary, keeping the surface code locale-agnostic. Real-first: mock fallback
 * only when STUDIO_MOCK_ENABLED and the live list is empty/failed.
 */

import { getJson } from '../../types';
import { STUDIO_MOCK_ENABLED } from '../flags';
import { MOCK_TEMPLATES } from '../mock';
import type { CuratedQuality } from '../types';

/** The full blueprint shape the public-browse + private-library system needs. */
export interface EnrichedTemplate {
  slug: string;
  name: string;
  agentType: string;
  category: string;
  curatedQuality: CuratedQuality | null;
  /** Full description (flattened from i18n). May be empty. */
  description: string;
  requiredSkills: string[];
  mcpServers: string[];
  /** Full operating-principles list. May be empty. */
  operatingPrinciples: string[];
  /** One-line summary derived from principles (card display). */
  operatingPrinciplesSummary: string;
}

/** i18n string field → display string (prefers en, then zh, then first value). */
function i18nToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const pick = obj.en ?? obj.zh ?? Object.values(obj)[0];
    if (typeof pick === 'string') return pick;
  }
  return '';
}

function normalizeQuality(raw: unknown): CuratedQuality | null {
  return raw === 'gold' || raw === 'silver' || raw === 'bronze' ? raw : null;
}

/** Flatten an `operatingPrinciples` DTO (string | array | i18n object) → list. */
function toPrinciplesList(principles: unknown): string[] {
  if (typeof principles === 'string') {
    return principles
      .split(/\n|·/)
      .map((p) => p.trim())
      .filter(Boolean);
  }
  if (Array.isArray(principles)) {
    return principles.map((p) => (typeof p === 'string' ? p : i18nToString(p))).filter(Boolean);
  }
  if (principles && typeof principles === 'object') {
    // i18n object whose chosen-locale value may itself be a list or a string.
    const obj = principles as Record<string, unknown>;
    const pick = obj.en ?? obj.zh ?? Object.values(obj)[0];
    return toPrinciplesList(pick);
  }
  return [];
}

/** Flatten one live role-template DTO into the enriched read shape. */
export function toEnrichedTemplate(row: Record<string, unknown>): EnrichedTemplate {
  const principlesList = toPrinciplesList(row.operatingPrinciples);

  const requiredSkills = Array.isArray(row.requiredSkills)
    ? (row.requiredSkills as Array<Record<string, unknown> | string>)
        .map((skill) => (typeof skill === 'string' ? skill : String(skill.skillSlug ?? '')))
        .filter(Boolean)
    : [];

  const mcpServers = Array.isArray(row.mcpServers)
    ? (row.mcpServers as Array<Record<string, unknown> | string>)
        .map((m) => (typeof m === 'string' ? m : String(m.name ?? m.package ?? '')))
        .filter(Boolean)
    : [];

  return {
    slug: String(row.slug ?? ''),
    name: i18nToString(row.displayName ?? row.name) || String(row.slug ?? ''),
    agentType: String(row.agentType ?? 'agent'),
    category: String(row.category ?? '') || 'general',
    curatedQuality: normalizeQuality(row.curatedQuality),
    description: i18nToString(row.description),
    requiredSkills,
    mcpServers,
    operatingPrinciples: principlesList,
    operatingPrinciplesSummary: principlesList.join(' · '),
  };
}

/** Mock rows lack the enriched fields; adapt them so the面 still renders. */
function mockToEnriched(): EnrichedTemplate[] {
  return MOCK_TEMPLATES.map((tpl) => {
    const list = tpl.operatingPrinciplesSummary
      ? tpl.operatingPrinciplesSummary.split('·').map((p) => p.trim()).filter(Boolean)
      : [];
    return {
      slug: tpl.slug,
      name: tpl.name,
      agentType: tpl.agentType,
      category: tpl.agentType === 'orchestrator' ? 'leadership' : 'general',
      curatedQuality: tpl.curatedQuality,
      description: tpl.operatingPrinciplesSummary,
      requiredSkills: tpl.requiredSkills,
      mcpServers: tpl.mcpServers,
      operatingPrinciples: list,
      operatingPrinciplesSummary: tpl.operatingPrinciplesSummary,
    };
  });
}

/**
 * List public (curated) role templates with full detail (real-first). Falls
 * back to the mock catalogue ONLY when `STUDIO_MOCK_ENABLED` and the live fetch
 * returns nothing / fails.
 */
export async function fetchEnrichedRoleTemplates(): Promise<EnrichedTemplate[]> {
  const rows = await getJson<Array<Record<string, unknown>>>('/api/im/role_templates');
  if (rows && rows.length > 0) {
    return rows.map(toEnrichedTemplate);
  }
  if (STUDIO_MOCK_ENABLED) return mockToEnriched();
  return [];
}
