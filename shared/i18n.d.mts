export type Locale = 'zh-CN' | 'en';
export type LocaleMeta = {
  readonly code: Locale;
  readonly nativeLabel: string;
  readonly englishLabel: string;
  readonly collator: string;
  readonly embedPdfLocale: string;
};
export const SUPPORTED_LOCALES: readonly Locale[];
export const DEFAULT_LOCALE: Locale;
export const LOCALE_STORAGE_KEY: string;
export const LOCALE_META: Readonly<Record<Locale, LocaleMeta>>;
export function isValidLocale(value: unknown): value is Locale;
export function normalizeLocale(raw: unknown, fallback?: Locale): Locale;
export function detectInitialLocale(stored: string | null | undefined, navigatorLanguage?: string | null): Locale;
