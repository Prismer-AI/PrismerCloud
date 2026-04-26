import { notFound } from 'next/navigation';
import { isValidLocale, getMessages, type Locale } from '../_lib/i18n';
import { listCookbooks } from '../_lib/cookbook-loader';
import { loadSpec } from '../_lib/openapi-loader';
import { CookbookCard } from '../_components/cookbook-card';
import { LocaleSwitcher } from '../_components/locale-switcher';
import Link from 'next/link';
import type { Metadata } from 'next';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const msgs = getMessages((locale as Locale) ?? 'en');
  return {
    title: msgs.meta.title,
    description: msgs.meta.description,
    alternates: {
      languages: {
        en: '/docs/en',
        zh: '/docs/zh',
      },
    },
  };
}

export default async function DocsLandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: loc } = await params;
  if (!isValidLocale(loc)) notFound();
  const locale = loc as Locale;
  const msgs = getMessages(locale);
  const cookbooks = listCookbooks(locale);
  const spec = loadSpec();

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-8">
        {/* Header */}
        <div className="flex items-start sm:items-center justify-between mb-6 sm:mb-8">
          <div>
            <h1 className="text-xl sm:text-2xl md:text-3xl font-bold mb-1 sm:mb-2">{msgs.meta.title}</h1>
            <p className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-400">{msgs.meta.description}</p>
          </div>
          <LocaleSwitcher current={locale} />
        </div>

        {/* Quick Start */}
        <section className="mb-12" id="quickstart">
          <h2 className="text-xl font-bold mb-4">{msgs.landing.quickStartTitle}</h2>
          <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-zinc-900/30 p-6">
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">Install the SDK and set your API key:</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-zinc-500 mb-2">TypeScript</div>
                <pre className="bg-zinc-100 dark:bg-zinc-950 rounded-lg p-3 text-xs text-zinc-700 dark:text-zinc-300 font-mono overflow-x-auto">
                  npm install @prismer/sdk
                </pre>
              </div>
              <div>
                <div className="text-xs text-zinc-500 mb-2">Python</div>
                <pre className="bg-zinc-100 dark:bg-zinc-950 rounded-lg p-3 text-xs text-zinc-700 dark:text-zinc-300 font-mono overflow-x-auto">
                  pip install prismer
                </pre>
              </div>
            </div>
            <div className="mt-4 text-xs text-zinc-500">
              Set <code className="text-violet-600 dark:text-violet-400">PRISMER_API_KEY</code> environment variable or
              pass it to the client constructor.{' '}
              <Link
                href={`/docs/${locale}/cookbook/quickstart`}
                className="text-violet-600 dark:text-violet-400 hover:underline"
              >
                → Full Quick Start Guide
              </Link>
            </div>
          </div>
        </section>

        {/* Cookbook Cards */}
        <section className="mb-12">
          <h2 className="text-xl font-bold mb-2">{msgs.landing.cookbookTitle}</h2>
          <p className="text-sm text-zinc-500 mb-6">{msgs.landing.cookbookSubtitle}</p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {cookbooks.map((cb) => (
              <CookbookCard
                key={cb.slug}
                title={cb.title}
                description={cb.description}
                estimatedTime={cb.estimatedTime}
                icon={cb.icon}
                href={`/docs/${locale}/cookbook/${cb.slug}`}
              />
            ))}
          </div>
        </section>

        {/* API Reference Index */}
        <section className="mb-12">
          <h2 className="text-xl font-bold mb-2">{msgs.landing.apiIndexTitle}</h2>
          <p className="text-sm text-zinc-500 mb-6">{msgs.landing.apiIndexSubtitle}</p>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {spec.groups.map((group) => (
              <Link
                key={group.id}
                href={`/docs/${locale}/api/${group.id}`}
                className="block rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-zinc-900/30 p-4 hover:border-violet-500/30 hover:bg-violet-500/5 transition-all"
              >
                <div className="text-sm font-medium text-zinc-900 dark:text-white mb-1">
                  {(msgs.groups as Record<string, string>)[group.id] ?? group.id}
                </div>
                <div className="text-xs text-zinc-500">{group.endpointCount} endpoints</div>
              </Link>
            ))}
          </div>
        </section>

        {/* Pricing (anchor target for /docs#pricing backward compat) */}
        <section id="pricing" className="mb-12">
          <h2 className="text-xl font-bold mb-4">Pricing</h2>
          <div className="rounded-xl overflow-hidden border border-zinc-200 dark:border-white/5 bg-zinc-50 dark:bg-zinc-900/50">
            <table className="w-full text-sm">
              <thead className="bg-zinc-100 dark:bg-zinc-800/50">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-zinc-600 dark:text-zinc-400">Operation</th>
                  <th className="text-left px-4 py-3 font-medium text-zinc-600 dark:text-zinc-400">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-white/5">
                {[
                  ['Context Load (cached)', 'Free'],
                  ['Context Load (new)', '~8 credits / 1K output tokens'],
                  ['Context Search', '20 credits / query'],
                  ['Parse Fast', '2 credits / page'],
                  ['Parse HiRes', '5 credits / page'],
                  ['IM Message', '0.001 credits'],
                  ['Workspace Init', '0.01 credits'],
                  ['File Upload', '0.5 credits / MB'],
                  ['WebSocket / SSE', 'Free'],
                  ['Context Save', 'Free'],
                ].map(([op, cost]) => (
                  <tr key={op}>
                    <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{op}</td>
                    <td
                      className={`px-4 py-3 ${cost === 'Free' ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-500 dark:text-zinc-400'}`}
                    >
                      {cost}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Error Codes (anchor target for /docs#errors backward compat) */}
        <section id="errors">
          <h2 className="text-xl font-bold mb-4">Error Codes</h2>
          <div className="rounded-xl overflow-hidden border border-zinc-200 dark:border-white/5 bg-zinc-50 dark:bg-zinc-900/50">
            <table className="w-full text-sm">
              <thead className="bg-zinc-100 dark:bg-zinc-800/50">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-zinc-600 dark:text-zinc-400">Code</th>
                  <th className="text-left px-4 py-3 font-medium text-zinc-600 dark:text-zinc-400">HTTP</th>
                  <th className="text-left px-4 py-3 font-medium text-zinc-600 dark:text-zinc-400">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-white/5">
                {[
                  ['INVALID_INPUT', '400', 'Invalid request parameters'],
                  ['UNAUTHORIZED', '401', 'Missing or invalid authentication'],
                  ['INSUFFICIENT_CREDITS', '402', 'Not enough credits'],
                  ['FORBIDDEN', '403', 'Permission denied'],
                  ['NOT_FOUND', '404', 'Resource not found'],
                  ['CONFLICT', '409', 'Duplicate resource'],
                  ['RATE_LIMITED', '429', 'Too many requests'],
                  ['INTERNAL_ERROR', '500', 'Server error — retry with backoff'],
                ].map(([code, http, desc]) => (
                  <tr key={code}>
                    <td className="px-4 py-3 font-mono text-emerald-600 dark:text-emerald-400">{code}</td>
                    <td className="px-4 py-3 text-amber-600 dark:text-amber-400">{http}</td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
