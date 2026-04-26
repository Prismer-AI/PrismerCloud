'use client';

import { useRouter, usePathname } from 'next/navigation';
import type { Locale } from '../_lib/i18n';
import { LOCALES } from '../_lib/i18n';

const LOCALE_LABELS: Record<Locale, string> = { en: 'EN', zh: '中文' };

export function LocaleSwitcher({ current }: { current: Locale }) {
  const router = useRouter();
  const pathname = usePathname();

  const switchTo = (locale: Locale) => {
    const newPath = pathname.replace(/^\/docs\/\w+/, `/docs/${locale}`);
    router.push(newPath);
  };

  return (
    <div className="flex gap-1">
      {LOCALES.map((locale) => (
        <button
          key={locale}
          onClick={() => switchTo(locale)}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            current === locale ? 'bg-violet-500/10 text-violet-400 font-medium' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {LOCALE_LABELS[locale]}
        </button>
      ))}
    </div>
  );
}
