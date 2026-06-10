'use client';

/**
 * Evolution Studio v2 — role-template client (release201/28).
 *
 * Wraps `GET /api/im/role_templates` (IM router, mounted at `/role_templates`
 * AND `/role-templates`). The legacy `../../types.ts` has no role-template
 * client, so this is the new home for it; it reuses the shared `authHeader` +
 * `getJson` helpers from there rather than re-rolling Bearer-token handling.
 *
 * ─── Honesty note (READ before consuming) ────────────────────────────────────
 * • LIST is open (no admin gate on GET). WRITES are admin-only: the backend
 *   POST/PATCH `/role_templates` routes are `adminOnly()`. So the Templates
 *   surface may render the catalogue for everyone, but "create / edit template"
 *   actions must be gated to admins (a non-admin write returns 403). This client
 *   intentionally exposes ONLY the read path; writes stay server-gated and are
 *   not surfaced here.
 * • The live DTO carries i18n `name`/`description` objects + structured
 *   `requiredSkills` / `mcpServers`. We flatten them into the v2 `RoleTemplate`
 *   read shape (plain strings) at the client boundary so surfaces stay simple.
 */

import { getJson } from '../../types';
import { STUDIO_MOCK_ENABLED } from '../flags';
import { MOCK_TEMPLATES } from '../mock';
import type { CuratedQuality, RoleTemplate } from '../types';

export interface RoleTemplateFilters {
  category?: string;
  agentType?: string;
  status?: string;
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

/** Flatten one live role-template DTO into the v2 read shape. */
function toRoleTemplate(row: Record<string, unknown>): RoleTemplate {
  const principles = row.operatingPrinciples;
  let principlesSummary = '';
  if (typeof principles === 'string') {
    principlesSummary = principles;
  } else if (Array.isArray(principles)) {
    principlesSummary = principles.map((p) => (typeof p === 'string' ? p : '')).filter(Boolean).join(' · ');
  } else if (principles && typeof principles === 'object') {
    principlesSummary = i18nToString(principles);
  }

  const requiredSkills = Array.isArray(row.requiredSkills)
    ? (row.requiredSkills as Array<Record<string, unknown>>)
        .map((s) => (typeof s === 'string' ? s : String(s.skillSlug ?? '')))
        .filter(Boolean)
    : [];

  const mcpServers = Array.isArray(row.mcpServers)
    ? (row.mcpServers as Array<Record<string, unknown>>)
        .map((m) => (typeof m === 'string' ? m : String(m.name ?? m.package ?? '')))
        .filter(Boolean)
    : [];

  return {
    slug: String(row.slug ?? ''),
    name: i18nToString(row.displayName ?? row.name) || String(row.slug ?? ''),
    agentType: String(row.agentType ?? 'agent'),
    curatedQuality: normalizeQuality(row.curatedQuality),
    requiredSkills,
    mcpServers,
    operatingPrinciplesSummary: principlesSummary,
  };
}

/**
 * List role templates (real-first). Falls back to the mock catalogue ONLY when
 * `STUDIO_MOCK_ENABLED` is on and the live fetch returns nothing / fails.
 */
export async function fetchRoleTemplates(filters?: RoleTemplateFilters): Promise<RoleTemplate[]> {
  const params = new URLSearchParams();
  if (filters?.category) params.set('category', filters.category);
  if (filters?.agentType) params.set('agentType', filters.agentType);
  if (filters?.status) params.set('status', filters.status);
  const qs = params.toString();

  const rows = await getJson<Array<Record<string, unknown>>>(
    `/api/im/role_templates${qs ? `?${qs}` : ''}`,
  );

  if (rows && rows.length > 0) {
    return rows.map(toRoleTemplate);
  }

  if (STUDIO_MOCK_ENABLED) return MOCK_TEMPLATES;
  return [];
}
