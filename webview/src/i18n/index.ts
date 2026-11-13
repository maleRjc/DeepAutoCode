import { formatMessage, getMessage, hasMessage } from './messages.js';
import { simplifiedToTraditional } from './s2t.js';
import {
  APP_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  detectBrowserLocale,
  normalizeLocale,
  type AppLocale,
  type LocalePair,
} from './types.js';

export type { AppLocale, LocalePair };
export {
  APP_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  detectBrowserLocale,
  normalizeLocale,
  formatMessage,
  getMessage,
  hasMessage,
  simplifiedToTraditional,
};

/**
 * Pick a localized string from a zh-CN / en pair.
 * zh-TW is derived via phrase+char conversion when not provided.
 */
export function pick(locale: AppLocale, pair: LocalePair, traditional?: string): string {
  if (locale === 'en') return pair.en;
  if (locale === 'zh-TW') return traditional ?? simplifiedToTraditional(pair.zh);
  return pair.zh;
}

export type Translator = {
  locale: AppLocale;
  t: (key: string, vars?: Record<string, string | number>) => string;
  pick: (pair: LocalePair, traditional?: string) => string;
  /** Shorthand: tr(zh, en) */
  tr: (zh: string, en: string) => string;
};

export function createTranslator(locale: AppLocale): Translator {
  const normalized = normalizeLocale(locale);
  return {
    locale: normalized,
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? formatMessage(normalized, key, vars) : getMessage(normalized, key),
    pick: (pair: LocalePair, traditional?: string) => pick(normalized, pair, traditional),
    tr: (zh: string, en: string) => pick(normalized, { zh, en }),
  };
}

export function resolveInitialLocale(stored?: unknown): AppLocale {
  if (stored != null && String(stored).trim()) {
    return normalizeLocale(stored);
  }
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage.getItem('dac.locale') : null;
    if (ls) return normalizeLocale(ls);
  } catch {
    // ignore
  }
  return detectBrowserLocale();
}
