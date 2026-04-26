'use client';

import { CreditCard } from 'lucide-react';
import { useTheme } from '@/contexts/theme-context';
import { CodeBlock } from '@/components/ui/code-block';
import MarkdownRenderer from '@/components/ui/markdown-renderer';
import { ParamTable } from './param-table';
import { ApiTester } from './api-tester';
import type { ProcessedEndpoint } from '../_lib/openapi-loader';
import type { DocLanguage } from './language-switcher';
import type { CookbookMeta } from '../_lib/cookbook-loader';
import Link from 'next/link';

interface Props {
  endpoint: ProcessedEndpoint;
  activeLang: DocLanguage;
  locale: string;
  relatedCookbooks: CookbookMeta[];
  labels: Record<string, string>;
}

export function EndpointDetail({ endpoint, activeLang, locale, relatedCookbooks, labels }: Props) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const codeSample = endpoint.codeSamples?.find((s) => s.lang === activeLang);

  const METHOD_COLORS: Record<string, string> = isDark
    ? {
        POST: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
        GET: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
        PATCH: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
        DELETE: 'bg-red-500/10 text-red-400 border-red-500/20',
        WS: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
      }
    : {
        POST: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        GET: 'bg-blue-50 text-blue-700 border-blue-200',
        PATCH: 'bg-amber-50 text-amber-700 border-amber-200',
        DELETE: 'bg-red-50 text-red-700 border-red-200',
        WS: 'bg-purple-50 text-purple-700 border-purple-200',
      };
  const methodColor =
    METHOD_COLORS[endpoint.method] ??
    (isDark ? 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20' : 'bg-zinc-50 text-zinc-700 border-zinc-200');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <span className={`px-2.5 py-1 font-mono text-xs font-bold border rounded ${methodColor}`}>
            {endpoint.method}
          </span>
          <h1 className="font-mono text-lg text-zinc-900 dark:text-white">{endpoint.path}</h1>
          {endpoint.cost && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <CreditCard className="w-3 h-3" /> {endpoint.cost}
            </span>
          )}
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{endpoint.summary}</p>
      </div>

      {/* Description */}
      {endpoint.description && endpoint.description !== endpoint.summary && (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <MarkdownRenderer content={endpoint.description} />
        </div>
      )}

      {/* Code Sample */}
      {codeSample ? (
        <CodeBlock
          code={codeSample.source}
          language={codeSample.lang === 'bash' ? 'bash' : codeSample.lang}
          isDark={isDark}
        />
      ) : (
        <div className="px-4 py-3 rounded-xl text-xs bg-zinc-100 dark:bg-zinc-800/30 border border-zinc-200 dark:border-white/5 text-zinc-500">
          {labels.noCodeSample}
        </div>
      )}

      {/* Parameters */}
      {endpoint.parameters && endpoint.parameters.length > 0 && (
        <ParamTable params={endpoint.parameters} title={labels.parameters} isDark={isDark} />
      )}

      {/* Request Body */}
      {endpoint.bodyFields && endpoint.bodyFields.length > 0 && (
        <ParamTable params={endpoint.bodyFields} title={labels.requestBody} isDark={isDark} showNesting />
      )}

      {/* Example Request */}
      {endpoint.exampleRequests && endpoint.exampleRequests.length > 0 && (
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider mb-3 text-zinc-500">{labels.requestExample}</h3>
          <CodeBlock
            code={JSON.stringify(endpoint.exampleRequests[0].value, null, 2)}
            language="json"
            isDark={isDark}
          />
        </div>
      )}

      {/* Example Response */}
      {endpoint.exampleResponses && endpoint.exampleResponses.length > 0 && (
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider mb-3 text-zinc-500">{labels.responseExample}</h3>
          <CodeBlock
            code={JSON.stringify(endpoint.exampleResponses[0].value, null, 2)}
            language="json"
            isDark={isDark}
          />
        </div>
      )}

      {/* API Tester — accepts endpoint, activeLang, isDark */}
      <ApiTester endpoint={endpoint} activeLang={activeLang} isDark={isDark} />

      {/* Related Cookbooks */}
      {relatedCookbooks.length > 0 && (
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider mb-3 text-zinc-500">{labels.relatedCookbooks}</h3>
          <div className="flex gap-2 flex-wrap">
            {relatedCookbooks.map((cb) => (
              <Link
                key={cb.slug}
                href={`/docs/${locale}/cookbook/${cb.slug}`}
                className="px-3 py-1.5 rounded-lg text-xs bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 transition-colors"
              >
                {cb.title}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
