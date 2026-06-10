import { describe, expect, it } from 'vitest';

import {
  filterRoleTemplateItems,
  makeDefaultFacets,
  normalizeRoleTemplate,
  normalizeRoleTemplates,
  renderedRoleToTemplateItem,
} from '../template-browser';
import type { RenderedRole } from '../../../lib/templates/types';

describe('role template browser normalization', () => {
  it('normalizes current and curation role template fields', () => {
    const item = normalizeRoleTemplate({
      id: 'tpl_1',
      slug: 'software-architect',
      displayName: { en: 'Software Architect', zh: '软件架构师' },
      description: { en: 'Owns architecture', zh: '负责架构' },
      agentType: 'orchestrator',
      category: 'engineering',
      tags: ['architecture', 'code'],
      requiredSkills: [{ skillSlug: 'context.load' }],
      metadata: {
        license: 'MIT',
        source: 'agency-agents',
        curatedQuality: 'gold',
        sourceSlug: 'software-architect',
      },
    });

    expect(item).toMatchObject({
      slug: 'software-architect',
      displayName: '软件架构师',
      description: '负责架构',
      agentType: 'orchestrator',
      category: 'engineering',
      source: 'agency-agents',
      sourceSlug: 'software-architect',
      qualityTier: 'gold',
      license: 'MIT',
      requiredSkillCount: 1,
    });
    expect(item?.role).toMatchObject({
      slug: 'software-architect',
      displayName: '软件架构师',
      primary: true,
      capabilities: ['architecture', 'code'],
    });
  });

  it('dedupes by slug and filters by search plus facets', () => {
    const localRole: RenderedRole = {
      slug: 'engineer',
      displayName: 'Engineer',
      agentType: 'specialist',
      primary: false,
      rationale: 'Ships code',
      capabilities: ['code'],
      defaultIcon: 'code',
    };
    const items = [
      renderedRoleToTemplateItem(localRole),
      ...normalizeRoleTemplates([
        {
          id: 'tpl_2',
          slug: 'growth-lead',
          name: { en: 'Growth Lead' },
          description: { en: 'Runs experiments' },
          category: 'growth',
          source: 'agency-agents',
          curatedQuality: 'silver',
          tags: ['analytics'],
        },
        {
          id: 'dup',
          slug: 'growth-lead',
          name: { en: 'Duplicate' },
        },
      ]),
    ];

    const filtered = filterRoleTemplateItems(items, {
      search: 'experiment',
      facets: { ...makeDefaultFacets(), qualityTier: 'silver', source: 'agency-agents' },
    });

    expect(items).toHaveLength(2);
    expect(filtered.map((item) => item.slug)).toEqual(['growth-lead']);
  });
});
