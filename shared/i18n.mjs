export const SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'en']);
export const DEFAULT_LOCALE = 'zh-CN';
export const LOCALE_STORAGE_KEY = 'study-studio:locale';

export const LOCALE_META = Object.freeze({
  'zh-CN': Object.freeze({
    code: 'zh-CN',
    nativeLabel: '简体中文',
    englishLabel: 'Simplified Chinese',
    collator: 'zh-CN',
    embedPdfLocale: 'zh-CN',
  }),
  en: Object.freeze({
    code: 'en',
    nativeLabel: 'English',
    englishLabel: 'English',
    collator: 'en-US',
    embedPdfLocale: 'en',
  }),
});

export function isValidLocale(value) {
  return typeof value === 'string' && SUPPORTED_LOCALES.includes(value);
}

export function normalizeLocale(raw, fallback = DEFAULT_LOCALE) {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (isValidLocale(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('en')) return 'en';
  return fallback;
}

export function detectInitialLocale(stored, navigatorLanguage) {
  if (typeof stored === 'string' && stored.trim()) {
    const normalized = normalizeLocale(stored, '');
    if (normalized) return normalized;
  }
  if (typeof navigatorLanguage === 'string' && navigatorLanguage.trim()) {
    return normalizeLocale(navigatorLanguage, DEFAULT_LOCALE);
  }
  return DEFAULT_LOCALE;
}
