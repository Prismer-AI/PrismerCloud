import type { AgentType, RenderedRole } from '../../../lib/templates/types';

export type RoleTemplateQualityTier = 'gold' | 'silver' | 'bronze' | 'review' | 'unknown';

export interface RoleTemplateBrowserItem {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  agentType: AgentType;
  category: string;
  source: string;
  sourceSlug?: string;
  qualityTier: RoleTemplateQualityTier;
  license?: string;
  tags: string[];
  requiredSkillCount: number;
  role: RenderedRole;
  // Visual identity from agency-agents (or any future source that ships
  // metadata.theme). All optional — RoleCardCatalog falls back to neutral
  // styling when absent.
  emoji?: string;
  color?: string;
  tagline?: string;
}

export interface RoleTemplateBrowserFacets {
  qualityTier: RoleTemplateQualityTier | 'all';
  category: string;
  source: string;
}

export interface RoleTemplateBrowserQuery {
  search: string;
  facets: RoleTemplateBrowserFacets;
}

export type RoleTemplateLoader = (signal?: AbortSignal) => Promise<unknown[]>;
