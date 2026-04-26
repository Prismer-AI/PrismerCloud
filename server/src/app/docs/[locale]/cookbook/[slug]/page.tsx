import { notFound } from 'next/navigation';
import { isValidLocale, getMessages, LOCALES, type Locale } from '../../../_lib/i18n';
import { getCookbook, listCookbooks } from '../../../_lib/cookbook-loader';
import { loadSpec, getEndpointsByGroup, getEndpointSlug } from '../../../_lib/openapi-loader';
import { CookbookRenderer } from '../../../_components/cookbook-renderer';
import { DocsSidebar } from '../../../_components/docs-sidebar';
import { LocaleSwitcher } from '../../../_components/locale-switcher';
import Link from 'next/link';
import type { Metadata } from 'next';

export function generateStaticParams() {
  const params: { locale: string; slug: string }[] = [];
  for (const locale of LOCALES) {
    for (const cb of listCookbooks(locale)) {
      params.push({ locale, slug: cb.slug });
    }
  }
  return params;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const cb = getCookbook(locale as Locale, slug);
  return {
    title: cb ? `${cb.title} — Prismer Cloud Docs` : 'Not Found',
    description: cb?.description,
  };
}

export default async function CookbookPage({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale: loc, slug } = await params;
  if (!isValidLocale(loc)) notFound();
  const locale = loc as Locale;
  const cookbook = getCookbook(locale, slug);
  if (!cookbook) notFound();

  const cookbooks = listCookbooks(locale);
  const spec = loadSpec();
  const msgs = getMessages(locale);

  // Build endpointsByGroup for sidebar
  const endpointsByGroup: Record<string, { slug: string; method: string; path: string }[]> = {};
  for (const group of spec.groups) {
    endpointsByGroup[group.id] = getEndpointsByGroup(group.id).map((ep) => ({
      slug: getEndpointSlug(ep),
      method: ep.method,
      path: ep.path,
    }));
  }

  return (
    <div className="flex min-h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white">
      <DocsSidebar
        locale={locale}
        cookbooks={cookbooks}
        groups={spec.groups}
        groupNames={Object.fromEntries(
          spec.groups.map((g) => [g.id, (msgs.groups as Record<string, string>)[g.id] ?? g.id]),
        )}
        endpointsByGroup={endpointsByGroup}
        mode="cookbook"
      />
      <main className="flex-1 max-w-4xl px-8 py-10">
        <div className="flex items-center justify-between mb-8">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Link href={`/docs/${locale}`} className="text-xs text-zinc-500 hover:text-violet-400">
                Docs
              </Link>
              <span className="text-xs text-zinc-600">/</span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">Cookbook</span>
            </div>
            <h1 className="text-2xl font-bold">{cookbook.title}</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">{cookbook.description}</p>
          </div>
          <LocaleSwitcher current={locale} />
        </div>
        {cookbook.estimatedTime && (
          <div className="text-xs text-zinc-500 mb-6">
            ⏱ {msgs.cookbook.estimatedTime}: {cookbook.estimatedTime}
          </div>
        )}
        <CookbookRenderer content={cookbook.content} />
      </main>
    </div>
  );
}
