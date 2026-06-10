import type { AgentType, RenderedRole } from '../../../lib/templates/types';

import type {
  RoleTemplateBrowserFacets,
  RoleTemplateBrowserItem,
  RoleTemplateBrowserQuery,
  RoleTemplateQualityTier,
} from './types';

const QUALITY_TIERS: readonly RoleTemplateQualityTier[] = ['gold', 'silver', 'bronze', 'review', 'unknown'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pickI18n(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return '';
  return text(value.zh) || text(value.en) || Object.values(value).map(text).find(Boolean) || '';
}

function pickStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(text).filter(Boolean);
}

function pickAgentType(value: unknown): AgentType {
  return value === 'orchestrator' || value === 'support' || value === 'specialist' ? value : 'specialist';
}

function pickQuality(value: unknown): RoleTemplateQualityTier {
  const quality = text(value).toLowerCase();
  return QUALITY_TIERS.includes(quality as RoleTemplateQualityTier) ? (quality as RoleTemplateQualityTier) : 'unknown';
}

function pickMetadata(row: Record<string, unknown>): Record<string, unknown> {
  return isRecord(row.metadata) ? row.metadata : {};
}

function pickTheme(metadata: Record<string, unknown>): { emoji?: string; color?: string; tagline?: string } {
  const theme = isRecord(metadata.theme) ? metadata.theme : {};
  const emoji = text(theme.emoji) || text(metadata.emoji) || undefined;
  const color = text(theme.color) || text(metadata.color) || undefined;
  const tagline = pickI18n(metadata.tagline) || pickI18n(theme.tagline) || text(metadata.vibe) || undefined;
  return { emoji, color, tagline };
}

export function normalizeRoleTemplate(row: unknown): RoleTemplateBrowserItem | null {
  if (!isRecord(row)) return null;
  const metadata = pickMetadata(row);
  const slug = text(row.slug) || text(row.id);
  if (!slug) return null;

  const displayName =
    pickI18n(row.displayName) ||
    pickI18n(row.name) ||
    text(row.label) ||
    text(row.title) ||
    slug.replace(/[-_]+/g, ' ');
  const description = pickI18n(row.description) || text(row.pitch) || text(row.rationale);
  const tags = pickStringArray(row.tags);
  const requiredSkills = Array.isArray(row.requiredSkills) ? row.requiredSkills : [];
  const category = text(row.category) || text(metadata.category) || 'general';
  const source = text(row.source) || text(metadata.source) || 'prismer-native';
  const qualityTier = pickQuality(row.curatedQuality ?? metadata.curatedQuality ?? metadata.qualityTier);
  const license = text(row.license) || text(metadata.license) || undefined;
  const agentType = pickAgentType(row.agentType);
  const { emoji, color, tagline } = pickTheme(metadata);

  return {
    id: text(row.id) || slug,
    slug,
    displayName,
    description,
    agentType,
    category,
    source,
    sourceSlug: text(row.sourceSlug) || text(metadata.sourceSlug) || undefined,
    qualityTier,
    license,
    tags,
    requiredSkillCount: requiredSkills.length,
    emoji,
    color,
    tagline,
    role: {
      slug,
      displayName,
      agentType,
      primary: agentType === 'orchestrator',
      rationale: description || tags.join(', ') || category,
      capabilities: tags,
      defaultIcon: 'user',
    },
  };
}

export function normalizeRoleTemplates(rows: readonly unknown[]): RoleTemplateBrowserItem[] {
  const seen = new Set<string>();
  const items: RoleTemplateBrowserItem[] = [];
  for (const row of rows) {
    const item = normalizeRoleTemplate(row);
    if (!item || seen.has(item.slug)) continue;
    seen.add(item.slug);
    items.push(item);
  }
  return items;
}

export function renderedRoleToTemplateItem(role: RenderedRole, category = 'local'): RoleTemplateBrowserItem {
  return {
    id: role.slug,
    slug: role.slug,
    displayName: role.displayName,
    description: role.rationale,
    agentType: role.agentType,
    category,
    source: 'workspace-template',
    qualityTier: role.primary ? 'gold' : 'review',
    tags: [...role.capabilities],
    requiredSkillCount: 0,
    role,
  };
}

export function filterRoleTemplateItems(
  items: readonly RoleTemplateBrowserItem[],
  query: RoleTemplateBrowserQuery,
): RoleTemplateBrowserItem[] {
  const search = query.search.trim().toLowerCase();
  return items.filter((item) => {
    if (query.facets.qualityTier !== 'all' && item.qualityTier !== query.facets.qualityTier) return false;
    if (query.facets.category !== 'all' && item.category !== query.facets.category) return false;
    if (query.facets.source !== 'all' && item.source !== query.facets.source) return false;
    if (!search) return true;
    const haystack = [item.displayName, item.slug, item.description, item.category, item.source, ...item.tags]
      .join(' ')
      .toLowerCase();
    return haystack.includes(search);
  });
}

export function makeDefaultFacets(): RoleTemplateBrowserFacets {
  return { qualityTier: 'all', category: 'all', source: 'all' };
}
