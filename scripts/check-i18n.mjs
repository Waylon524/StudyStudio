import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_LOCALE,
  LOCALE_META,
  SUPPORTED_LOCALES,
  detectInitialLocale,
  isValidLocale,
  normalizeLocale,
} from '../shared/i18n.mjs';
import { effortLabel } from '../shared/model-presets.mjs';

// 1. Shared i18n helpers
assert.deepEqual(SUPPORTED_LOCALES, ['zh-CN', 'en']);
assert.equal(DEFAULT_LOCALE, 'zh-CN');
assert.equal(isValidLocale('zh-CN'), true);
assert.equal(isValidLocale('en'), true);
assert.equal(isValidLocale('fr'), false);
assert.equal(normalizeLocale('en-US'), 'en');
assert.equal(normalizeLocale('en_GB'), 'en');
assert.equal(normalizeLocale('zh-Hans'), 'zh-CN');
assert.equal(normalizeLocale('zh'), 'zh-CN');
assert.equal(normalizeLocale('unknown', 'en'), 'en');
assert.equal(detectInitialLocale('en', 'zh-CN'), 'en');
assert.equal(detectInitialLocale(null, 'en-US'), 'en');
assert.equal(detectInitialLocale(null, 'zh-CN'), 'zh-CN');
for (const code of SUPPORTED_LOCALES) {
  assert(LOCALE_META[code]?.nativeLabel, `missing meta for ${code}`);
  assert(LOCALE_META[code]?.embedPdfLocale, `missing embedPdfLocale for ${code}`);
}

// 2. effortLabel localization
assert.equal(effortLabel('high', 'zh-CN'), '高 (high)');
assert.equal(effortLabel('high', 'en'), 'High');
assert.equal(effortLabel('medium', 'en'), 'Medium');
assert.equal(effortLabel(null, 'en'), 'Default');
assert.equal(effortLabel(null, 'zh-CN'), '默认');

// 3. Parse zhCN and en dictionaries in src/i18n.tsx and verify 100% key + placeholder parity
const i18nSource = await fs.readFile(path.resolve('src/i18n.tsx'), 'utf8');

function extractDict(source, constName) {
  const startMatch = new RegExp(`const\\s+${constName}\\b[^=]*=\\s*\\{`).exec(source);
  assert(startMatch, `Could not find ${constName} in src/i18n.tsx`);
  let i = startMatch.index + startMatch[0].length;
  let depth = 1;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (inSingle) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inDouble = false;
    } else {
      if (ch === "'") inSingle = true;
      else if (ch === '"') inDouble = true;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    i++;
  }
  const body = source.slice(startMatch.index + startMatch[0].length, i - 1);
  const map = new Map();
  const entryRe = /'([^']+)'\s*:\s*'((?:\\.|[^'\\])*)'/g;
  let m;
  const allowEmpty = new Set(['pdf.pageUnit']);
  while ((m = entryRe.exec(body))) {
    const key = m[1];
    const val = m[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    assert(!map.has(key), `Duplicate key "${key}" in ${constName}`);
    if (!allowEmpty.has(key)) {
      assert(val.trim().length > 0, `Empty translation for "${key}" in ${constName}`);
    }
    map.set(key, val);
  }
  return map;
}

const zhDict = extractDict(i18nSource, 'zhCN');
const enDict = extractDict(i18nSource, 'en');

assert(zhDict.size > 200, `Expected >200 zhCN keys, got ${zhDict.size}`);
assert.equal(zhDict.size, enDict.size, `Key count mismatch: zhCN=${zhDict.size}, en=${enDict.size}`);

const placeholders = str => [...str.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

for (const [key, zhVal] of zhDict) {
  assert(enDict.has(key), `Missing key "${key}" in en dictionary`);
  const enVal = enDict.get(key);
  assert.deepEqual(
    placeholders(enVal),
    placeholders(zhVal),
    `Placeholder mismatch for "${key}": zh="${zhVal}", en="${enVal}"`
  );
}

console.log(`i18n: shared helpers, effortLabel, and ${zhDict.size} zh-CN/en translation keys + placeholders verified.`);
