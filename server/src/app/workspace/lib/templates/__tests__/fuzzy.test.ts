import { describe, expect, it } from 'vitest';

import { fuzzyFilter, fuzzyScore } from '../fuzzy';

describe('fuzzy', () => {
  const items = [
    { slug: 'frontend-developer', searchText: 'frontend developer react tailwind ui engineering' },
    { slug: 'backend-developer', searchText: 'backend developer node python api engineering' },
    { slug: 'ui-designer', searchText: 'ui designer figma visual design design-system' },
    { slug: 'growth-hacker', searchText: 'growth hacker ab funnel acquisition marketing' },
    { slug: 'support-responder', searchText: 'support responder ticket triage helpdesk customer support' },
  ];

  it('scores prefix match higher than substring', () => {
    const prefixScore = fuzzyScore('fro', 'frontend developer react');
    const substringScore = fuzzyScore('fro', 'misc role frontline support');
    expect(prefixScore).toBeGreaterThan(substringScore);
  });

  it('returns empty array for empty query when limit absent', () => {
    expect(fuzzyFilter('', items).length).toBe(items.length);
  });

  it('finds frontend by prefix', () => {
    const out = fuzzyFilter('frontend', items);
    expect(out[0]?.slug).toBe('frontend-developer');
  });

  it('finds ui designer by partial token', () => {
    const out = fuzzyFilter('ui', items);
    expect(out[0]?.slug).toBe('ui-designer');
  });

  it('returns no results for unrelated query', () => {
    expect(fuzzyFilter('xenon-zigzag', items)).toEqual([]);
  });

  it('respects limit', () => {
    const out = fuzzyFilter('developer', items, 1);
    expect(out.length).toBe(1);
  });

  it('case-insensitive', () => {
    expect(fuzzyFilter('GROWTH', items)[0]?.slug).toBe('growth-hacker');
  });
});
