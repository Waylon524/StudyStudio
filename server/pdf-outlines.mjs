import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkedPdfOutline, entriesToOutlineTree, MAX_OUTLINE_ITEMS, MAX_OUTLINE_DEPTH } from '../shared/pdf-outline.mjs';
import { pdfPage } from './pdf-reader.mjs';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_PAGES = 60;
const MAX_SCAN_CHARS_PER_PAGE = 420;
const MAX_SINGLE_PASS_PAGES = 180;
const OUTLINE_BATCH_PAGES = 150;
const MAX_VISUAL_OUTLINE_PAGES = 16;
const storageError = () => Error('已保存的 PDF 目录无法读取，请保留原文件后重试。');

let pdfjsPromise = null;
async function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch(err => {
      pdfjsPromise = null;
      throw err;
    });
  }
  return pdfjsPromise;
}

async function resolveDestPage(doc, dest) {
  try {
    const resolved = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || !resolved.length) return null;
    const ref = resolved[0];
    let index = -1;
    if (typeof ref === 'number') {
      index = ref;
    } else if (ref && typeof ref === 'object' && typeof ref.num === 'number' && typeof ref.gen === 'number') {
      index = await doc.getPageIndex({ num: ref.num, gen: ref.gen });
    }
    return Number.isInteger(index) && index >= 0 && index < doc.numPages ? index + 1 : null;
  } catch {
    return null;
  }
}

async function openPdfDocument(filePath) {
  const pdfjs = await loadPdfJs();
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new TypeError('PDF 文件不存在。');
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    return { task, doc };
  } catch (error) {
    await task.destroy().catch(() => {});
    throw error;
  }
}

async function readOriginalOutlineFromDoc(doc) {
  const raw = await doc.getOutline();
  if (!Array.isArray(raw) || !raw.length) {
    return { pages: doc.numPages, items: [] };
  }
  let count = 0;
  const convert = async (list, depth) => {
    if (!Array.isArray(list) || depth > MAX_OUTLINE_DEPTH) return [];
    const out = [];
    for (const entry of list) {
      if (count >= MAX_OUTLINE_ITEMS) break;
      count += 1;
      const title = String(entry?.title || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim() || '(Untitled)';
      const page = entry?.dest ? await resolveDestPage(doc, entry.dest) : null;
      const children = Array.isArray(entry?.items) && entry.items.length ? await convert(entry.items, depth + 1) : [];
      const node = { title, page };
      if (children.length) node.children = children;
      out.push(node);
    }
    return out;
  };
  const items = await convert(raw, 1);
  return { pages: doc.numPages, items };
}

export async function readOriginalPdfOutline(filePath) {
  let opened;
  try {
    opened = await openPdfDocument(filePath);
    return await readOriginalOutlineFromDoc(opened.doc);
  } catch {
    return { pages: null, items: [], warning: '无法读取原 PDF 内嵌目录。' };
  } finally {
    await opened?.task.destroy().catch(() => {});
  }
}

function extractPageSnippet(content, charLimit) {
  const lines = [];
  let currentLine = '';
  let currentMaxFont = 0;
  let lastY = null;
  let overallMaxFont = 0;

  const flushLine = () => {
    const cleaned = currentLine.replace(/[ \t]+/g, ' ').trim();
    if (cleaned) lines.push({ text: cleaned, fontSize: currentMaxFont });
    currentLine = '';
    currentMaxFont = 0;
  };

  for (const item of content?.items || []) {
    if (typeof item?.str !== 'string') continue;
    const s = item.str;
    const y = Array.isArray(item.transform) ? Math.round(item.transform[5]) : null;
    const fontSize = Array.isArray(item.transform)
      ? Math.hypot(Number(item.transform[0]) || 0, Number(item.transform[1]) || 0)
      : Number(item.height) || 0;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
      flushLine();
    } else if (currentLine && !currentLine.endsWith(' ') && !s.startsWith(' ')) {
      currentLine += ' ';
    }
    currentLine += s;
    if (s.trim() && fontSize > currentMaxFont) currentMaxFont = fontSize;
    if (s.trim() && fontSize > overallMaxFont) overallMaxFont = fontSize;
    if (y !== null) lastY = y;
    if (lines.length >= 240) break;
  }
  flushLine();

  const fullText = lines.map(l => l.text).join('\n').trim();
  if (!fullText) return { text: '', hasText: false, truncated: false };
  if (fullText.length <= charLimit) {
    return { text: fullText, hasText: true, truncated: false };
  }
  let snippet = fullText.slice(0, charLimit).trimEnd() + '…';
  if (overallMaxFont >= 12) {
    const threshold = overallMaxFont * 0.85;
    const extras = [];
    for (const line of lines) {
      if (line.fontSize < threshold) continue;
      if (line.text.length < 2 || line.text.length > 100) continue;
      if (snippet.includes(line.text)) continue;
      if (extras.includes(line.text)) continue;
      extras.push(line.text);
      if (extras.length >= 2) break;
    }
    if (extras.length) {
      snippet += '\n[Heading] ' + extras.join(' | ').slice(0, 160);
    }
  }
  return { text: snippet, hasText: true, truncated: true };
}

export async function extractPdfOutlineContext(filePath) {
  let opened;
  try {
    opened = await openPdfDocument(filePath);
    const { doc } = opened;
    const totalPages = doc.numPages;
    let originalItems = [];
    try {
      const original = await readOriginalOutlineFromDoc(doc);
      originalItems = original.items;
    } catch {
      originalItems = [];
    }
    const baseLimit = totalPages <= 60 ? 450 : totalPages <= 180 ? 280 : 200;
    const tocPages = totalPages <= 60 ? 0 : totalPages <= 180 ? 15 : 20;
    const scannedPages = [];
    let textPageCount = 0;

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
      let result = { text: '', hasText: false, truncated: false };
      try {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        const limit = pageNumber <= tocPages ? 900 : baseLimit;
        result = extractPageSnippet(content, limit);
        page.cleanup();
      } catch {
        result = { text: '', hasText: false, truncated: false };
      }
      if (result.text.replace(/\s+/g, '').length >= 8) textPageCount += 1;
      scannedPages.push({
        page: pageNumber,
        text: result.text,
        hasText: result.hasText,
        ...(result.truncated ? { truncated: true } : {}),
      });
    }
    return { pages: totalPages, originalItems, scannedPages, textPageCount };
  } finally {
    await opened?.task.destroy().catch(() => {});
  }
}

function selectVisualSamplePages(totalPages, maxCount = MAX_VISUAL_OUTLINE_PAGES) {
  if (totalPages <= maxCount) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  const picked = new Set();
  const frontCount = Math.min(8, Math.floor(maxCount / 2));
  for (let p = 1; p <= frontCount; p++) picked.add(p);
  const remaining = maxCount - picked.size;
  const span = totalPages - frontCount;
  for (let i = 1; i <= remaining; i++) {
    const p = Math.min(totalPages, frontCount + Math.round((span * i) / remaining));
    picked.add(p);
  }
  return [...picked].sort((a, b) => a - b);
}

export async function scanPdfPagesText(filePath, { startPage = 1, endPage } = {}) {
  let opened;
  try {
    opened = await openPdfDocument(filePath);
    const { doc } = opened;
    const totalPages = doc.numPages;
    const from = Math.max(1, Math.min(totalPages, Number.isSafeInteger(startPage) ? startPage : 1));
    const requestedEnd = Number.isSafeInteger(endPage) ? endPage : from + MAX_SCAN_PAGES - 1;
    const to = Math.max(from, Math.min(totalPages, requestedEnd, from + MAX_SCAN_PAGES - 1));
    const scannedPages = [];
    for (let pageNumber = from; pageNumber <= to; pageNumber++) {
      let text = '';
      let truncated = false;
      try {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        const parts = [];
        let lastY = null;
        for (const item of content.items || []) {
          if (typeof item?.str !== 'string') continue;
          const s = item.str;
          const y = Array.isArray(item.transform) ? Math.round(item.transform[5]) : null;
          if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
            parts.push('\n');
          } else if (parts.length && !parts[parts.length - 1].endsWith('\n') && !parts[parts.length - 1].endsWith(' ') && !s.startsWith(' ')) {
            parts.push(' ');
          }
          parts.push(s);
          if (y !== null) lastY = y;
          if (parts.join('').length > MAX_SCAN_CHARS_PER_PAGE * 2) break;
        }
        const cleaned = parts.join('').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
        if (cleaned.length > MAX_SCAN_CHARS_PER_PAGE) {
          text = cleaned.slice(0, MAX_SCAN_CHARS_PER_PAGE) + '…';
          truncated = true;
        } else {
          text = cleaned;
        }
        page.cleanup();
      } catch {
        text = '';
      }
      scannedPages.push({ page: pageNumber, text, hasText: Boolean(text), ...(truncated ? { truncated: true } : {}) });
    }
    return {
      pages: totalPages,
      startPage: from,
      endPage: to,
      hasMore: to < totalPages,
      nextStartPage: to < totalPages ? to + 1 : null,
      scannedPages,
    };
  } finally {
    await opened?.task.destroy().catch(() => {});
  }
}

/** Separate outline sidecar files never rewrite the original PDF on disk. */
export class PdfOutlines {
  constructor({ store }) {
    this.store = store;
    this.locks = new Map();
  }

  _checkSourceId(sourceId) {
    if (typeof sourceId !== 'string' || !/^[0-9a-f]{24}$/.test(sourceId)) {
      throw new TypeError('PDF 资料 ID 无效。');
    }
    return sourceId;
  }

  async _resolved(course, sourceId) {
    const checkedId = this._checkSourceId(sourceId);
    let snapshot;
    try {
      snapshot = await this.store.resolveReader(course, { sourceId: checkedId, page: 1 });
    } catch (error) {
      if (['EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE'].includes(error.code)) throw error;
      throw new TypeError(error.message || 'PDF 资料无效。');
    }
    if (!snapshot || snapshot.sourceId !== checkedId || snapshot.source?.mime !== 'application/pdf') {
      throw new TypeError('指定的资料不是有效的课程 PDF。');
    }
    return {
      courseId: course.id,
      sourceId: checkedId,
      name: snapshot.name,
      relativePath: snapshot.source.relativePath,
      pages: snapshot.pages,
    };
  }

  async _serialized(course, sourceId, operation) {
    const key = JSON.stringify([this.store.coursePath(course), sourceId]);
    const previous = this.locks.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    this.locks.set(key, task);
    try {
      return await task;
    } finally {
      if (this.locks.get(key) === task) this.locks.delete(key);
    }
  }

  _relative(sourceId) {
    return `.study-studio/pdf-outlines/${sourceId}.json`;
  }

  async _ensureDirectory(course) {
    for (const rel of ['.study-studio', '.study-studio/pdf-outlines']) {
      const target = await this.store.safePath(course, rel);
      try {
        await fs.mkdir(target, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('PDF 目录存储路径无效。');
    }
  }

  async _readSidecar(course, scope) {
    let handle;
    try {
      handle = await fs.open(await this.store.safePath(course, this._relative(scope.sourceId)), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw storageError();
      const parsed = JSON.parse(await handle.readFile('utf8'));
      if (parsed?.version !== 1 || parsed.courseId !== scope.courseId || parsed.sourceId !== scope.sourceId) {
        throw storageError();
      }
      const { items } = checkedPdfOutline(parsed.items, { maxPage: scope.pages });
      return {
        items,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
        provenance: parsed.provenance || null,
      };
    } catch (error) {
      if (error.message?.includes('已保存的 PDF 目录')) throw error;
      throw storageError();
    } finally {
      await handle.close();
    }
  }

  async get(course, { sourceId }) {
    const checkedId = this._checkSourceId(sourceId);
    return this._serialized(course, checkedId, async () => {
      const scope = await this._resolved(course, checkedId);
      const saved = await this._readSidecar(course, scope);
      return {
        sourceId: scope.sourceId,
        pages: scope.pages,
        hasCustomOutline: Boolean(saved),
        items: saved ? saved.items : null,
        updatedAt: saved?.updatedAt || null,
      };
    });
  }

  async inspect(course, { sourceId }) {
    const checkedId = this._checkSourceId(sourceId);
    return this._serialized(course, checkedId, async () => {
      const scope = await this._resolved(course, checkedId);
      const [saved, original] = await Promise.all([
        this._readSidecar(course, scope),
        readOriginalPdfOutline(await this.store.safePath(course, scope.relativePath)),
      ]);
      return {
        sourceId: scope.sourceId,
        name: scope.name,
        relativePath: scope.relativePath,
        pages: scope.pages,
        hasCustomOutline: Boolean(saved),
        items: saved ? saved.items : null,
        originalItems: original.items,
        ...(original.warning ? { originalWarning: original.warning } : {}),
        updatedAt: saved?.updatedAt || null,
      };
    });
  }

  async scan(course, { sourceId, startPage = 1, endPage }) {
    const checkedId = this._checkSourceId(sourceId);
    return this._serialized(course, checkedId, async () => {
      const scope = await this._resolved(course, checkedId);
      const filePath = await this.store.safePath(course, scope.relativePath);
      const result = await scanPdfPagesText(filePath, { startPage, endPage });
      return {
        sourceId: scope.sourceId,
        name: scope.name,
        relativePath: scope.relativePath,
        ...result,
      };
    });
  }

  async replace(course, { sourceId, items }, provenance = { kind: 'user' }) {
    const checkedId = this._checkSourceId(sourceId);
    return this._serialized(course, checkedId, async () => {
      const scope = await this._resolved(course, checkedId);
      const checked = checkedPdfOutline(items, { maxPage: scope.pages });
      await this._ensureDirectory(course);
      const updatedAt = new Date().toISOString();
      const payload = {
        version: 1,
        courseId: scope.courseId,
        sourceId: scope.sourceId,
        items: checked.items,
        updatedAt,
        provenance,
      };
      const text = JSON.stringify(payload, null, 2);
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
        throw new TypeError('PDF 目录内容过大，请精简条目数量或标题长度。');
      }
      const relative = this._relative(scope.sourceId);
      const temporary = `.study-studio/pdf-outlines/.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await fs.open(await this.store.safePath(course, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(text);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(await this.store.safePath(course, temporary), await this.store.safePath(course, relative));
      } finally {
        await handle?.close().catch(() => {});
        await fs.rm(await this.store.safePath(course, temporary), { force: true });
      }
      return {
        ok: true,
        sourceId: scope.sourceId,
        name: scope.name,
        pages: scope.pages,
        hasCustomOutline: true,
        count: checked.count,
        items: checked.items,
        updatedAt,
      };
    });
  }

  async reset(course, { sourceId }) {
    const checkedId = this._checkSourceId(sourceId);
    return this._serialized(course, checkedId, async () => {
      const scope = await this._resolved(course, checkedId);
      try {
        await fs.unlink(await this.store.safePath(course, this._relative(scope.sourceId)));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return {
        ok: true,
        sourceId: scope.sourceId,
        name: scope.name,
        pages: scope.pages,
        hasCustomOutline: false,
        items: null,
      };
    });
  }

  async removeSource(course, sourceId) {
    if (typeof sourceId !== 'string' || !/^[0-9a-f]{24}$/.test(sourceId)) return { removed: false };
    return this._serialized(course, sourceId, async () => {
      const target = await this.store.safePath(course, this._relative(sourceId));
      await fs.rm(target, { force: true });
      return { removed: true };
    });
  }
}

/** Background PDF bookmark generator (ephemeral model task, independent of chat threads). */
export class PdfOutlineGenerator {
  constructor({ store, pdfOutlines, generate, renderPage = pdfPage, write = (_course, fn) => fn(), onUpdate = () => {} }) {
    if (!store || !pdfOutlines || typeof generate !== 'function') {
      throw Error('缺少 PDF 书签生成服务。');
    }
    this.store = store;
    this.pdfOutlines = pdfOutlines;
    this.generate = generate;
    this.renderPage = renderPage;
    this.write = write;
    this.onUpdate = onUpdate;
    this.jobs = new Map();
    this.states = new Map();
  }

  _key(course, sourceId) {
    return JSON.stringify([this.store.coursePath(course), sourceId]);
  }

  _publish(payload) {
    try {
      this.onUpdate(payload);
    } catch {
      /* Subscriber disconnects must not fail background outline generation. */
    }
  }

  status(course, sourceId) {
    if (typeof sourceId !== 'string' || !/^[0-9a-f]{24}$/.test(sourceId)) {
      return { status: 'idle' };
    }
    const state = this.states.get(this._key(course, sourceId));
    return state ? { ...state } : { status: 'idle' };
  }

  isCourseBusy(courseId) {
    for (const entry of this.jobs.values()) {
      if (entry.courseId === courseId) return true;
    }
    return false;
  }

  clearSource(course, sourceId) {
    if (typeof sourceId !== 'string' || !/^[0-9a-f]{24}$/.test(sourceId)) return;
    this.states.delete(this._key(course, sourceId));
  }

  async regenerate(course, { sourceId, locale = 'zh-CN' } = {}) {
    const scope = await this.pdfOutlines._resolved(course, sourceId);
    const key = this._key(course, scope.sourceId);
    const running = this.jobs.get(key);
    if (running) {
      return this.status(course, scope.sourceId);
    }
    const isEn = typeof locale === 'string' && locale.toLowerCase().startsWith('en');
    const requestId = randomUUID();
    const startedAt = new Date().toISOString();
    const generatingState = {
      status: 'generating',
      requestId,
      startedAt,
      updatedAt: startedAt,
      error: null,
    };
    this.states.set(key, generatingState);
    this._publish({ courseId: course.id, sourceId: scope.sourceId, generation: { ...generatingState } });

    const isStillCurrent = () => this.states.get(key)?.requestId === requestId;

    const promise = Promise.resolve()
      .then(async () => {
        const filePath = await this.store.safePath(course, scope.relativePath);
        const context = await extractPdfOutlineContext(filePath);
        if (!isStillCurrent()) return;

        const totalPages = context.pages || scope.pages;
        const lowText = context.textPageCount < Math.max(1, Math.floor(totalPages * 0.15));
        const tempDirs = [];
        const images = [];
        const imagePages = [];

        try {
          if (lowText) {
            const visualPages = selectVisualSamplePages(totalPages, MAX_VISUAL_OUTLINE_PAGES);
            const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'study-outline-vis-'));
            tempDirs.push(tempRoot);
            for (const pageNum of visualPages) {
              if (!isStillCurrent()) return;
              try {
                const rendered = await this.renderPage(filePath, pageNum, tempRoot);
                if (rendered?.tempDir) tempDirs.push(rendered.tempDir);
                if (rendered?.imagePath) {
                  images.push(rendered.imagePath);
                  imagePages.push({ imageIndex: images.length, page: pageNum });
                }
              } catch {
                /* Best-effort visual fallback for image-only pages. */
              }
            }
          }

          if (!isStillCurrent()) return;

          if (context.textPageCount === 0 && images.length === 0 && context.originalItems.length === 0) {
            throw Error(
              isEn
                ? 'Could not extract text or page images from this PDF to generate bookmarks.'
                : '无法从这份 PDF 提取文字或页面图像，暂时无法生成书签。'
            );
          }

          const collectedEntries = [];
          const cwd = this.store.coursePath(course);

          if (totalPages <= MAX_SINGLE_PASS_PAGES || images.length > 0) {
            const pagePayload = images.length > 0
              ? context.scannedPages.filter(p => p.hasText).map(p => ({ page: p.page, text: p.text }))
              : context.scannedPages.map(p => ({ page: p.page, text: p.text }));
            const response = await this.generate({
              courseName: course.name,
              fileName: scope.name,
              totalPages,
              pages: pagePayload,
              originalOutline: context.originalItems,
              pageRange: { start: 1, end: totalPages },
              locale,
              images,
              imagePages,
              cwd,
            });
            if (Array.isArray(response?.entries)) {
              collectedEntries.push(...response.entries);
            }
          } else {
            for (let start = 1; start <= totalPages; start += OUTLINE_BATCH_PAGES) {
              if (!isStillCurrent()) return;
              const end = Math.min(totalPages, start + OUTLINE_BATCH_PAGES - 1);
              const slice = context.scannedPages
                .slice(start - 1, end)
                .map(p => ({ page: p.page, text: p.text }));
              const response = await this.generate({
                courseName: course.name,
                fileName: scope.name,
                totalPages,
                pages: slice,
                originalOutline: start === 1 ? context.originalItems : [],
                pageRange: { start, end },
                locale,
                images: [],
                imagePages: [],
                cwd,
              });
              if (Array.isArray(response?.entries)) {
                for (const entry of response.entries) {
                  const p = Number(entry?.page);
                  if (Number.isSafeInteger(p) && p >= start && p <= end) {
                    collectedEntries.push(entry);
                  }
                }
              }
            }
          }

          if (!isStillCurrent()) return;

          const tree = entriesToOutlineTree(collectedEntries, { maxPage: totalPages });
          const checked = checkedPdfOutline(tree, { maxPage: totalPages });
          if (!checked.items.length) {
            throw Error(
              isEn
                ? 'Could not identify a valid bookmark structure for this PDF. Please try again.'
                : '未能从这份 PDF 中识别出有效的书签结构，请稍后重试。'
            );
          }

          const saved = await this.write(course, async () => {
            if (!isStillCurrent()) return null;
            return this.pdfOutlines.replace(
              course,
              { sourceId: scope.sourceId, items: checked.items },
              { kind: 'regenerate', requestId }
            );
          });
          if (!saved || !isStillCurrent()) return;

          const readyState = {
            status: 'ready',
            requestId,
            startedAt,
            updatedAt: saved.updatedAt || new Date().toISOString(),
            error: null,
          };
          this.states.set(key, readyState);
          this._publish({ courseId: course.id, sourceId: scope.sourceId, generation: { ...readyState } });
        } finally {
          for (const dir of tempDirs) {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
          }
        }
      })
      .catch(error => {
        if (!isStillCurrent()) return;
        const message =
          error?.message && typeof error.message === 'string'
            ? error.message
            : isEn
              ? 'Failed to regenerate bookmarks. Please try again.'
              : '书签生成失败，请稍后重试。';
        const failedState = {
          status: 'failed',
          requestId,
          startedAt,
          updatedAt: new Date().toISOString(),
          error: message,
        };
        this.states.set(key, failedState);
        this._publish({ courseId: course.id, sourceId: scope.sourceId, generation: { ...failedState } });
      })
      .finally(() => {
        if (this.jobs.get(key)?.requestId === requestId) {
          this.jobs.delete(key);
        }
      });

    this.jobs.set(key, { requestId, courseId: course.id, promise });
    promise.catch(() => {});
    return { ...generatingState };
  }

  async wait(course, sourceId) {
    const key = this._key(course, sourceId);
    await this.jobs.get(key)?.promise;
    return this.status(course, sourceId);
  }
}
