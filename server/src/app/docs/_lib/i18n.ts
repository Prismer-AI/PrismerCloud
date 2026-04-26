import en from '../_i18n/en.json';
import zh from '../_i18n/zh.json';

export type Locale = 'en' | 'zh';
export const LOCALES: Locale[] = ['en', 'zh'];
export const DEFAULT_LOCALE: Locale = 'en';

type Messages = typeof en;

const messages: Record<Locale, Messages> = { en, zh };

export function isValidLocale(locale: string): locale is Locale {
  return LOCALES.includes(locale as Locale);
}

export function getMessages(locale: Locale): Messages {
  return messages[locale] ?? messages[DEFAULT_LOCALE];
}

export function getGroupName(locale: Locale, groupId: string): string {
  const msgs = getMessages(locale);
  return (msgs.groups as Record<string, string>)[groupId] ?? groupId;
}
