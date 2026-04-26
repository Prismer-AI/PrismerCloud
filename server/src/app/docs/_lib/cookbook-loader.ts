import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { LOCALES } from './i18n';
import type { Locale } from './i18n';

export interface CookbookMeta {
  slug: string;
  title: string;
  description: string;
  estimatedTime: string;
  endpoints: string[];
  icon: string;
  order: number;
}

export interface CookbookFull extends CookbookMeta {
  content: string; // raw markdown body (without frontmatter)
}

const COOKBOOK_DIR = join(process.cwd(), 'src', 'app', 'docs', '_cookbook');

export function listCookbooks(locale: Locale): CookbookMeta[] {
  if (!LOCALES.includes(locale)) return [];
  const dir = join(COOKBOOK_DIR, locale);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  return files
    .map((f) => {
      try {
        const slug = f.replace(/\.md$/, '');
        const raw = readFileSync(join(dir, f), 'utf-8');
        const { data } = matter(raw);
        return {
          slug,
          title: (data.title as string) ?? slug,
          description: (data.description as string) ?? '',
          estimatedTime: (data.estimatedTime as string) ?? '',
          endpoints: (data.endpoints as string[]) ?? [],
          icon: (data.icon as string) ?? 'book',
          order: (data.order as number) ?? 999,
        };
      } catch (err) {
        console.error(`[cookbook-loader] Failed to parse ${f}:`, err instanceof Error ? err.message : err);
        return null;
      }
    })
    .filter((x): x is CookbookMeta => x !== null)
    .sort((a, b) => a.order - b.order);
}

export function getCookbook(locale: Locale, slug: string): CookbookFull | null {
  if (!LOCALES.includes(locale)) return null;
  const filePath = join(COOKBOOK_DIR, locale, `${slug}.md`);
  if (!filePath.startsWith(COOKBOOK_DIR + '/')) return null; // prevent traversal
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const { data, content } = matter(raw);
    return {
      slug,
      title: (data.title as string) ?? slug,
      description: (data.description as string) ?? '',
      estimatedTime: (data.estimatedTime as string) ?? '',
      endpoints: (data.endpoints as string[]) ?? [],
      icon: (data.icon as string) ?? 'book',
      order: (data.order as number) ?? 999,
      content,
    };
  } catch (err) {
    console.error(`[cookbook-loader] Failed to read ${slug}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export function findCookbooksForEndpoint(locale: Locale, endpointPath: string): CookbookMeta[] {
  return listCookbooks(locale).filter((c) => c.endpoints.includes(endpointPath));
}
