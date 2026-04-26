import { notFound } from 'next/navigation';
import { isValidLocale, getMessages, LOCALES, type Locale } from '../../../_lib/i18n';
import { loadSpec, getEndpointsByGroup, getEndpointSlug } from '../../../_lib/openapi-loader';
import { listCookbooks, findCookbooksForEndpoint } from '../../../_lib/cookbook-loader';
import { DocsSidebar } from '../../../_components/docs-sidebar';
import { EndpointPageClient } from '../../../_components/endpoint-page-client';
import { LocaleSwitcher } from '../../../_components/locale-switcher';
import Link from 'next/link';
import type { Metadata } from 'next';

export function generateStaticParams() {
  const spec = loadSpec();
  const params: { locale: string; path: string[] }[] = [];
  for (const locale of LOCALES) {
    for (const group of spec.groups) {
      params.push({ locale, path: [group.id] });
      for (const ep of getEndpointsByGroup(group.id)) {
        params.push({ locale, path: [group.id, getEndpointSlug(ep)] });
      }
    }
  }
  return params;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; path: string[] }>;
}): Promise<Metadata> {
  const { locale, path } = await params;
  const msgs = getMessages((locale as Locale) ?? 'en');
  if (path.length === 1) {
    const groupName = (msgs.groups as Record<string, string>)[path[0]] ?? path[0];
    return { title: `${groupName} API — Prismer Cloud` };
  }
  const endpoints = getEndpointsByGroup(path[0]);
  const ep = endpoints.find((e) => getEndpointSlug(e) === path[1]);
  return {
    title: ep ? `${ep.method} ${ep.path} — Prismer Cloud API` : 'Not Found',
    description: ep?.summary,
  };
}

export default async function ApiReferencePage({ params }: { params: Promise<{ locale: string; path: string[] }> }) {
  const { locale: loc, path } = await params;
  if (!isValidLocale(loc)) notFound();
  const locale = loc as Locale;
  const msgs = getMessages(locale);
  const spec = loadSpec();
  const cookbooks = listCookbooks(locale);

  const groupId = path[0];
  const endpoints = getEndpointsByGroup(groupId);
  if (endpoints.length === 0) notFound();

  // Build endpointsByGroup for sidebar
  const endpointsByGroup: Record<string, { slug: string; method: string; path: string }[]> = {};
  for (const group of spec.groups) {
    endpointsByGroup[group.id] = getEndpointsByGroup(group.id).map((ep) => ({
      slug: getEndpointSlug(ep),
      method: ep.method,
      path: ep.path,
    }));
  }

  const sidebarProps = {
    locale,
    cookbooks,
    groups: spec.groups,
    groupNames: Object.fromEntries(
      spec.groups.map((g) => [g.id, (msgs.groups as Record<string, string>)[g.id] ?? g.id]),
    ),
    endpointsByGroup,
    mode: 'api' as const,
  };

  // GROUP PAGE: list all endpoints in this group
  if (path.length === 1) {
    const groupName = (msgs.groups as Record<string, string>)[groupId] ?? groupId;
    return (
      <div className="flex min-h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white">
        <DocsSidebar {...sidebarProps} />
        <main className="flex-1 max-w-4xl px-8 py-10">
          <div className="flex items-center justify-between mb-8">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Link href={`/docs/${locale}`} className="text-xs text-zinc-500 hover:text-violet-400">
                  Docs
                </Link>
                <span className="text-xs text-zinc-600">/</span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">API</span>
              </div>
              <h1 className="text-2xl font-bold">{groupName}</h1>
              <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">{endpoints.length} endpoints</p>
            </div>
            <LocaleSwitcher current={locale} />
          </div>
          <div className="space-y-3">
            {endpoints.map((ep) => {
              const slug = getEndpointSlug(ep);
              const METHOD_TEXT: Record<string, string> = {
                POST: 'text-emerald-600 dark:text-emerald-400',
                GET: 'text-blue-600 dark:text-blue-400',
                PATCH: 'text-amber-600 dark:text-amber-400',
                DELETE: 'text-red-600 dark:text-red-400',
                WS: 'text-purple-600 dark:text-purple-400',
              };
              return (
                <Link
                  key={ep.operationId || `${ep.method}-${ep.path}`}
                  href={`/docs/${locale}/api/${groupId}/${slug}`}
                  className="flex items-center gap-3 p-4 rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-zinc-900/30 hover:border-violet-500/30 transition-all"
                >
                  <span className={`font-mono text-xs font-bold w-16 ${METHOD_TEXT[ep.method] ?? 'text-zinc-400'}`}>
                    {ep.method}
                  </span>
                  <span className="font-mono text-sm text-zinc-900 dark:text-white">{ep.path}</span>
                  <span className="text-sm text-zinc-500 ml-auto truncate max-w-xs">{ep.summary}</span>
                </Link>
              );
            })}
          </div>
        </main>
      </div>
    );
  }

  // ENDPOINT DETAIL PAGE
  const endpointSlug = path[1];
  const endpoint = endpoints.find((e) => getEndpointSlug(e) === endpointSlug);
  if (!endpoint) notFound();

  const relatedCookbooks = findCookbooksForEndpoint(locale, endpoint.path);

  return (
    <div className="flex min-h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white">
      <DocsSidebar {...sidebarProps} />
      <main className="flex-1 max-w-4xl px-8 py-10">
        <div className="flex items-center gap-2 mb-6">
          <Link href={`/docs/${locale}`} className="text-xs text-zinc-500 hover:text-violet-400">
            Docs
          </Link>
          <span className="text-xs text-zinc-600">/</span>
          <Link href={`/docs/${locale}/api/${groupId}`} className="text-xs text-zinc-500 hover:text-violet-400">
            {(msgs.groups as Record<string, string>)[groupId] ?? groupId}
          </Link>
        </div>
        <EndpointPageClient
          endpoint={endpoint}
          locale={locale}
          relatedCookbooks={relatedCookbooks}
          labels={msgs.api as unknown as Record<string, string>}
        />
      </main>
    </div>
  );
}
