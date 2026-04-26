'use client';

import { useState } from 'react';
import { useTheme } from '@/contexts/theme-context';
import { LanguageSwitcher, type DocLanguage } from './language-switcher';
import { EndpointDetail } from './endpoint-detail';
import type { ProcessedEndpoint } from '../_lib/openapi-loader';
import type { CookbookMeta } from '../_lib/cookbook-loader';

interface Props {
  endpoint: ProcessedEndpoint;
  locale: string;
  relatedCookbooks: CookbookMeta[];
  labels: Record<string, string>;
}

export function EndpointPageClient({ endpoint, locale, relatedCookbooks, labels }: Props) {
  const [activeLang, setActiveLang] = useState<DocLanguage>('bash');
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return (
    <div>
      <div className="flex justify-end mb-4">
        <LanguageSwitcher active={activeLang} onChange={setActiveLang} isDark={isDark} />
      </div>
      <EndpointDetail
        endpoint={endpoint}
        activeLang={activeLang}
        locale={locale}
        relatedCookbooks={relatedCookbooks}
        labels={labels}
      />
    </div>
  );
}
