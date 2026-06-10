'use client';

/**
 * Templates — private-library store (localStorage, mock-first).
 *
 * ─── Honesty note (READ before consuming) ────────────────────────────────────
 * The backend `IMRoleTemplate` table is a single **global curated** catalogue:
 * it has no owner / visibility / favourite columns and exposes no per-user
 * private-template or favourite endpoints (verified: role-templates.ts only has
 * GET list, GET :slug, admin-only POST/PATCH, and POST :slug/apply). So the
 * "私有模板库 / 收藏 / 编辑自定义模板" flow has **zero server support** today.
 *
 * Per the project's mock-first convention we implement the private library in
 * **localStorage**, namespaced by workspaceId so two workspaces don't bleed.
 * This is explicitly LOCAL-ONLY: callers must surface a "本地 · 后端持久化待接入"
 * banner so the user knows their library lives in this browser, and "apply a
 * private template" must be gated (no server apply path for custom templates).
 *
 * Storage key: `prismer.studio.privateTemplates::<workspaceId|default>`.
 */

import type { CuratedQuality } from '../types';

const KEY_PREFIX = 'prismer.studio.privateTemplates';

/** A forked, locally-editable template. Mirrors EnrichedTemplate + local meta. */
export interface PrivateTemplate {
  /** Local id (not a server slug). */
  id: string;
  name: string;
  agentType: string;
  category: string;
  curatedQuality: CuratedQuality | null;
  description: string;
  requiredSkills: string[];
  mcpServers: string[];
  operatingPrinciples: string[];
  /** Provenance, e.g. `forked-from:ceo`. */
  source: string;
  /** ms epoch. */
  createdAt: number;
  updatedAt: number;
}

function storageKey(workspaceId: string | null): string {
  return `${KEY_PREFIX}::${workspaceId || 'default'}`;
}

function readRaw(workspaceId: string | null): PrivateTemplate[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PrivateTemplate[]) : [];
  } catch {
    return [];
  }
}

function writeRaw(workspaceId: string | null, rows: PrivateTemplate[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(rows));
  } catch {
    // Quota / disabled storage — surfaced by the caller's empty list, not thrown.
  }
}

function newId(): string {
  return `priv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** List the private library for a workspace (newest first). */
export function listPrivateTemplates(workspaceId: string | null): PrivateTemplate[] {
  return readRaw(workspaceId).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** What you can fork from — a public template's enriched fields. */
export interface ForkInput {
  slug: string;
  name: string;
  agentType: string;
  category: string;
  curatedQuality: CuratedQuality | null;
  description: string;
  requiredSkills: string[];
  mcpServers: string[];
  operatingPrinciples: string[];
}

/** Deep-copy a public template into the private library; returns the new row. */
export function favoriteTemplate(workspaceId: string | null, input: ForkInput): PrivateTemplate {
  const now = Date.now();
  const row: PrivateTemplate = {
    id: newId(),
    name: input.name,
    agentType: input.agentType,
    category: input.category,
    curatedQuality: input.curatedQuality,
    description: input.description,
    requiredSkills: [...input.requiredSkills],
    mcpServers: [...input.mcpServers],
    operatingPrinciples: [...input.operatingPrinciples],
    source: `forked-from:${input.slug}`,
    createdAt: now,
    updatedAt: now,
  };
  const rows = readRaw(workspaceId);
  rows.push(row);
  writeRaw(workspaceId, rows);
  return row;
}

/** The mutable slice of a private template. */
export type PrivateTemplatePatch = Partial<
  Pick<
    PrivateTemplate,
    'name' | 'description' | 'requiredSkills' | 'mcpServers' | 'operatingPrinciples'
  >
>;

/** Persist an edit to a private template; returns the updated row (or null). */
export function updatePrivateTemplate(
  workspaceId: string | null,
  id: string,
  patch: PrivateTemplatePatch,
): PrivateTemplate | null {
  const rows = readRaw(workspaceId);
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const next: PrivateTemplate = { ...rows[idx], ...patch, updatedAt: Date.now() };
  rows[idx] = next;
  writeRaw(workspaceId, rows);
  return next;
}

/** Remove a template from the private library. */
export function removePrivateTemplate(workspaceId: string | null, id: string): void {
  writeRaw(
    workspaceId,
    readRaw(workspaceId).filter((r) => r.id !== id),
  );
}

/** Count — used for the scope-toggle badge. */
export function countPrivateTemplates(workspaceId: string | null): number {
  return readRaw(workspaceId).length;
}

/** Whether a given public slug is already forked into this workspace's library. */
export function isFavorited(workspaceId: string | null, slug: string): boolean {
  return readRaw(workspaceId).some((r) => r.source === `forked-from:${slug}`);
}
