export const MAX_OUTLINE_ITEMS = 2000;
export const MAX_OUTLINE_DEPTH = 8;
export const MAX_OUTLINE_TITLE_LENGTH = 300;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validate and normalize a hierarchical PDF Table of Contents / outline tree. */
export function checkedPdfOutline(items, { maxPage } = {}) {
  if (!Array.isArray(items)) {
    throw new TypeError('PDF 目录必须是条目数组。');
  }
  if (maxPage !== undefined && (!Number.isSafeInteger(maxPage) || maxPage < 1)) {
    throw new TypeError('PDF 总页数无效。');
  }
  let count = 0;

  function visit(list, depth) {
    if (!Array.isArray(list)) {
      throw new TypeError('PDF 目录子条目必须是数组。');
    }
    if (depth > MAX_OUTLINE_DEPTH) {
      throw new TypeError(`PDF 目录层级不能超过 ${MAX_OUTLINE_DEPTH} 层。`);
    }
    const normalized = [];
    for (const raw of list) {
      if (!record(raw)) {
        throw new TypeError('PDF 目录条目必须是对象。');
      }
      for (const key of Object.keys(raw)) {
        if (!['title', 'page', 'children'].includes(key)) {
          throw new TypeError(`PDF 目录条目包含不支持的字段：${key}。`);
        }
      }
      if (typeof raw.title !== 'string') {
        throw new TypeError('PDF 目录标题必须是字符串。');
      }
      const title = raw.title.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!title || title.length > MAX_OUTLINE_TITLE_LENGTH) {
        throw new TypeError(`PDF 目录标题应为 1 至 ${MAX_OUTLINE_TITLE_LENGTH} 个字符。`);
      }
      if (!Number.isSafeInteger(raw.page) || raw.page < 1) {
        throw new TypeError(`目录「${title}」的页码必须是大于等于 1 的整数。`);
      }
      if (maxPage !== undefined && raw.page > maxPage) {
        throw new TypeError(`目录「${title}」的页码 ${raw.page} 超出 PDF 总页数（${maxPage}）。`);
      }
      count += 1;
      if (count > MAX_OUTLINE_ITEMS) {
        throw new TypeError(`PDF 目录条目总数不能超过 ${MAX_OUTLINE_ITEMS} 条。`);
      }
      const children = raw.children === undefined ? [] : visit(raw.children, depth + 1);
      normalized.push(children.length ? { title, page: raw.page, children } : { title, page: raw.page });
    }
    return normalized;
  }

  const normalized = visit(items, 1);
  return { items: normalized, count };
}

export function countOutlineNodes(items) {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const item of items) {
    total += 1;
    if (Array.isArray(item?.children)) total += countOutlineNodes(item.children);
  }
  return total;
}

export function stableOutlineSignature(items) {
  function simplify(list) {
    if (!Array.isArray(list)) return [];
    return list.map(item => [
      String(item.title || '').trim(),
      Number(item.page) || 1,
      simplify(item.children),
    ]);
  }
  return JSON.stringify(simplify(items));
}

/** Convert flat leveled entries ({ title, page, level }) into a validated hierarchical outline tree. */
export function entriesToOutlineTree(entries, { maxPage } = {}) {
  if (!Array.isArray(entries)) return [];
  const roots = [];
  const stack = [];
  let total = 0;
  let lastKey = '';
  for (const raw of entries) {
    if (total >= MAX_OUTLINE_ITEMS) break;
    if (!record(raw)) continue;
    const title = String(raw.title || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_OUTLINE_TITLE_LENGTH);
    const page = Number(raw.page);
    if (!title || !Number.isSafeInteger(page) || page < 1) continue;
    if (maxPage !== undefined && page > maxPage) continue;
    const rawLevel = Number.isSafeInteger(raw.level) ? raw.level : 1;
    const level = Math.max(1, Math.min(MAX_OUTLINE_DEPTH, rawLevel));
    const dedupeKey = `${level}\0${page}\0${title.toLowerCase()}`;
    if (dedupeKey === lastKey) continue;
    lastKey = dedupeKey;

    while (stack.length && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    if (stack.length >= MAX_OUTLINE_DEPTH) continue;
    const node = { title, page };
    if (stack.length === 0) {
      roots.push(node);
    } else {
      const parent = stack[stack.length - 1].node;
      if (!parent.children) parent.children = [];
      parent.children.push(node);
    }
    stack.push({ level, node });
    total += 1;
  }
  return roots;
}
