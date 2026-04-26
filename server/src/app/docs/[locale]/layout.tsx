import { notFound } from 'next/navigation';
import Link from 'next/link';
import { isValidLocale, getMessages, LOCALES, type Locale } from '../_lib/i18n';
import { buildSearchIndex } from '../_lib/search-index';
import { SearchCommand } from '../_components/search-command';
import { SearchTrigger } from '../_components/search-trigger';

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export default async function DocsLocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isValidLocale(locale)) notFound();

  const searchEntries = buildSearchIndex(locale as Locale);
  const msgs = getMessages(locale as Locale);

  return (
    <>
      <SearchCommand entries={searchEntries} placeholder={msgs.nav.search} />
      <div className="sticky top-0 z-40 border-b border-zinc-200 dark:border-white/10 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href={`/docs/${locale}`} className="text-sm font-semibold text-zinc-900 dark:text-white">
              Docs
            </Link>
            <Link
              href={`/docs/${locale}/cookbook/quickstart`}
              className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-white transition-colors"
            >
              Cookbooks
            </Link>
            <Link
              href={`/docs/${locale}/api/context`}
              className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-white transition-colors"
            >
              API Reference
            </Link>
          </div>
          <SearchTrigger placeholder={msgs.nav.search} />
        </div>
      </div>
      {children}
    </>
  );
}
