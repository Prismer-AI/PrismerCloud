'use client';

import { Globe2 } from 'lucide-react';
import { APP_LOCALE_LABELS, APP_LOCALES, type AppLocale } from '@/lib/i18n';
import { useI18n } from '@/contexts/i18n-context';
import { useTheme } from '@/contexts/theme-context';

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return (
    <label
      className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors ${
        isDark
          ? 'text-zinc-400 hover:bg-white/5 hover:text-white'
          : 'text-zinc-600 hover:bg-[var(--prismer-primary)]/5 hover:text-zinc-900'
      }`}
      title={t('common.language')}
      aria-label={t('common.language')}
    >
      <Globe2 className={compact ? 'h-4 w-4' : 'h-[18px] w-[18px]'} />
      {!compact ? <span className="text-xs font-semibold">{APP_LOCALE_LABELS[locale].short}</span> : null}
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value as AppLocale)}
        className="cursor-pointer appearance-none bg-transparent text-xs font-semibold outline-none"
        aria-label={t('common.language')}
      >
        {APP_LOCALES.map((item) => (
          <option key={item} value={item}>
            {APP_LOCALE_LABELS[item].native}
          </option>
        ))}
      </select>
    </label>
  );
}
