import { loadSpec, getEndpointSlug } from './openapi-loader';
import { listCookbooks } from './cookbook-loader';
import type { Locale } from './i18n';

export interface SearchEntry {
  type: 'cookbook' | 'endpoint';
  title: string;
  subtitle: string;
  href: string;
  group?: string;
}

export function buildSearchIndex(locale: Locale): SearchEntry[] {
  const entries: SearchEntry[] = [];

  for (const cb of listCookbooks(locale)) {
    entries.push({
      type: 'cookbook',
      title: cb.title,
      subtitle: cb.estimatedTime,
      href: `/docs/${locale}/cookbook/${cb.slug}`,
    });
  }

  const spec = loadSpec();
  for (const ep of spec.endpoints) {
    entries.push({
      type: 'endpoint',
      title: `${ep.method} ${ep.path}`,
      subtitle: ep.summary,
      href: `/docs/${locale}/api/${ep.group}/${getEndpointSlug(ep)}`,
      group: ep.group,
    });
  }

  return entries;
}
