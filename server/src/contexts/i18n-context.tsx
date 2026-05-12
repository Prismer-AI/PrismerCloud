'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  APP_LOCALE_COOKIE,
  APP_LOCALE_STORAGE_KEY,
  DEFAULT_APP_LOCALE,
  type AppLocale,
  type TranslationKey,
  isAppLocale,
  translate,
} from '@/lib/i18n';

interface I18nContextType {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  t: (key: TranslationKey, values?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

function readInitialLocale(): AppLocale {
  if (typeof window === 'undefined') return DEFAULT_APP_LOCALE;
  const stored = window.localStorage.getItem(APP_LOCALE_STORAGE_KEY);
  if (isAppLocale(stored)) return stored;
  const cookie = document.cookie
    .split('; ')
    .find((item) => item.startsWith(`${APP_LOCALE_COOKIE}=`))
    ?.split('=')[1];
  if (isAppLocale(cookie)) return cookie;
  const preferred = window.navigator.languages?.find((item) => isAppLocale(item.split('-')[0]))?.split('-')[0];
  return isAppLocale(preferred) ? preferred : DEFAULT_APP_LOCALE;
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(DEFAULT_APP_LOCALE);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setLocaleState(readInitialLocale());
      setInitialized(true);
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!initialized) return;
    document.documentElement.lang = locale;
    window.localStorage.setItem(APP_LOCALE_STORAGE_KEY, locale);
    document.cookie = `${APP_LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; SameSite=Lax`;
  }, [initialized, locale]);

  const setLocale = useCallback((next: AppLocale) => {
    setLocaleState(next);
  }, []);

  const value = useMemo<I18nContextType>(
    () => ({
      locale,
      setLocale,
      t: (key, values) => translate(locale, key, values),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextType {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
