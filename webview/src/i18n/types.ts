export type AppLocale = 'zh-CN' | 'zh-TW' | 'en';

export type LocalePair = { zh: string; en: string };

export const DEFAULT_LOCALE: AppLocale = 'zh-CN';

export const APP_LOCALES: Array<{ id: AppLocale; nativeLabel: string; englishLabel: string }> = [
  { id: 'zh-CN', nativeLabel: '简体中文', englishLabel: 'Simplified Chinese' },
  { id: 'zh-TW', nativeLabel: '繁體中文', englishLabel: 'Traditional Chinese' },
  { id: 'en', nativeLabel: 'English', englishLabel: 'English' },
];

export const LOCALE_LABELS: Record<AppLocale, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
};

export function normalizeLocale(raw: unknown): AppLocale {
  const v = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (v === 'en' || v === 'en-us' || v === 'en-gb' || v === 'english') return 'en';
  if (
    v === 'zh-tw' ||
    v === 'zh-hk' ||
    v === 'zh-hant' ||
    v === 'zh-mo' ||
    v === 'cht' ||
    v === 'traditional'
  ) {
    return 'zh-TW';
  }
  if (
    v === 'zh' ||
    v === 'zh-cn' ||
    v === 'zh-hans' ||
    v === 'zh-sg' ||
    v === 'chs' ||
    v === 'simplified'
  ) {
    return 'zh-CN';
  }
  return DEFAULT_LOCALE;
}

export function detectBrowserLocale(): AppLocale {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
    const langs =
      typeof navigator !== 'undefined' && Array.isArray(navigator.languages)
        ? navigator.languages
        : [];
    for (const candidate of [...langs, nav]) {
      if (!candidate) continue;
      const n = normalizeLocale(candidate);
      const lower = String(candidate).toLowerCase().replace(/_/g, '-');
      if (
        lower.startsWith('en') ||
        lower.startsWith('zh-tw') ||
        lower.startsWith('zh-hk') ||
        lower.startsWith('zh-hant') ||
        lower.startsWith('zh-cn') ||
        lower.startsWith('zh-hans') ||
        lower === 'zh'
      ) {
        return n;
      }
    }
    return normalizeLocale(nav);
  } catch {
    return DEFAULT_LOCALE;
  }
}
