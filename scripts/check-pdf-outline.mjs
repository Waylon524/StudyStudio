import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LearningStore } from '../server/learning.mjs';
import { PdfOutlines, PdfOutlineGenerator, extractPdfOutlineContext } from '../server/pdf-outlines.mjs';
import { managePdfOutline } from '../server/pdf-outline-tool.mjs';
import { checkedPdfOutline, countOutlineNodes, entriesToOutlineTree, stableOutlineSignature } from '../shared/pdf-outline.mjs';

function buildMinimalPdf(pagesText, { withOutline = false } = {}) {
  const objects = [];
  const addObj = body => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = addObj('');
  const pagesId = addObj('');
  const fontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  for (const text of pagesText) {
    const escaped = text.replace(/[()\\]/g, m => '\\' + m);
    const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
    const contentId = addObj(`<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`);
    const pageId = addObj(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  }
  let outlinesRef = '';
  if (withOutline && pageIds.length >= 2) {
    const outlinesId = addObj('');
    const item1Id = addObj('');
    const item2Id = addObj('');
    objects[outlinesId - 1] = `<< /Type /Outlines /First ${item1Id} 0 R /Last ${item2Id} 0 R /Count 2 >>`;
    objects[item1Id - 1] = `<< /Title (Original Chapter 1) /Parent ${outlinesId} 0 R /Next ${item2Id} 0 R /Dest [${pageIds[0]} 0 R /Fit] >>`;
    objects[item2Id - 1] = `<< /Title (Original Chapter 2) /Parent ${outlinesId} 0 R /Prev ${item1Id} 0 R /Dest [${pageIds[1]} 0 R /Fit] >>`;
    outlinesRef = ` /Outlines ${outlinesId} 0 R`;
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R${outlinesRef} >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(out, 'utf8'));
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(out, 'utf8');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, 'utf8');
}

// 1. Schema validation tests
const normalized = checkedPdfOutline(
  [
    {
      title: '  Chapter 1\nAtoms  ',
      page: 1,
      children: [{ title: '1.1 Orbitals', page: 2 }],
    },
  ],
  { maxPage: 3 }
);
assert.equal(normalized.items.length, 1);
assert.equal(normalized.items[0].title, 'Chapter 1 Atoms');
assert.equal(countOutlineNodes(normalized.items), 2);
assert.equal(
  stableOutlineSignature(normalized.items),
  stableOutlineSignature([{ title: 'Chapter 1 Atoms', page: 1, children: [{ title: '1.1 Orbitals', page: 2 }] }])
);
assert.throws(() => checkedPdfOutline([{ title: 'Bad Page', page: 5 }], { maxPage: 3 }));
assert.throws(() => checkedPdfOutline([{ title: '', page: 1 }]));
let deep = { title: 'Leaf', page: 1 };
for (let i = 0; i < 10; i++) deep = { title: `Level ${i}`, page: 1, children: [deep] };
assert.throws(() => checkedPdfOutline([deep]));

// 1b. Flat entries -> hierarchical tree conversion
const flatTree = entriesToOutlineTree(
  [
    { title: 'Chapter 1', page: 1, level: 1 },
    { title: 'Chapter 1', page: 1, level: 1 }, // consecutive duplicate ignored
    { title: '1.1 Intro', page: 1, level: 2 },
    { title: '1.1.1 Deep', page: 2, level: 4 }, // skipped level still nests cleanly
    { title: '1.2 Next', page: 2, level: 2 },
    { title: 'Bad page', page: 99, level: 1 }, // filtered by maxPage
    { title: '   ', page: 2, level: 1 }, // empty title filtered
    { title: 'Chapter 2', page: 3, level: 1 },
  ],
  { maxPage: 3 }
);
assert.equal(flatTree.length, 2);
assert.equal(flatTree[0].title, 'Chapter 1');
assert.equal(flatTree[0].children.length, 2);
assert.equal(flatTree[0].children[0].children[0].title, '1.1.1 Deep');
assert.equal(flatTree[1].title, 'Chapter 2');
assert.equal(checkedPdfOutline(flatTree, { maxPage: 3 }).count, 5);

// 2. PdfOutlines sidecar + PDF.js inspection/scanning + tool guards
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'study-outline-test-'));
try {
  const course = { id: 'course-outline', name: '物理化学' };
  const store = new LearningStore({ root });
  const base = await store.initCourse(course);
  const pdfOutlines = new PdfOutlines({ store });

  const pdfBytes = buildMinimalPdf(
    ['Chapter 1 Thermodynamics Overview', 'Section 1.2 First Law of Thermodynamics', 'Chapter 2 Chemical Kinetics'],
    { withOutline: true }
  );
  const originalHash = pdfBytes.toString('hex');
  await store.upload(course, {
    name: 'lecture.pdf',
    mime: 'application/pdf',
    data: pdfBytes,
    folder: '课件',
  });
  const sources = await store.listSources(course);
  const pdfSource = sources.find(s => s.name === 'lecture.pdf');
  assert(pdfSource, 'uploaded PDF source should exist');

  // Inspect initial state: no custom outline, original outline present
  const inspected0 = await pdfOutlines.inspect(course, { sourceId: pdfSource.id });
  assert.equal(inspected0.pages, 3);
  assert.equal(inspected0.hasCustomOutline, false);
  assert.equal(inspected0.items, null);
  assert.equal(inspected0.originalItems.length, 2);
  assert.equal(inspected0.originalItems[0].title, 'Original Chapter 1');
  assert.equal(inspected0.originalItems[0].page, 1);

  // Scan pages text
  const scanned = await pdfOutlines.scan(course, { sourceId: pdfSource.id, startPage: 1, endPage: 3 });
  assert.equal(scanned.pages, 3);
  assert.equal(scanned.scannedPages.length, 3);
  assert(scanned.scannedPages[0].text.includes('Thermodynamics Overview'));
  assert(scanned.scannedPages[2].text.includes('Chemical Kinetics'));

  // Replace via sidecar
  const replaced = await pdfOutlines.replace(course, {
    sourceId: pdfSource.id,
    items: [
      {
        title: 'Chapter 1 Thermodynamics',
        page: 1,
        children: [{ title: '1.2 First Law', page: 2 }],
      },
      { title: 'Chapter 2 Kinetics', page: 3 },
    ],
    author: 'agent',
    threadId: 't-1',
    turnId: 'turn-1',
  });
  assert.equal(replaced.hasCustomOutline, true);
  assert.equal(replaced.count, 3);

  // Verify original PDF on disk was NOT mutated
  const diskBytes = await fs.readFile(path.join(base, pdfSource.relativePath));
  assert.equal(diskBytes.toString('hex'), originalHash, 'original PDF bytes must remain untouched');

  // Verify get() reads sidecar
  const loaded = await pdfOutlines.get(course, { sourceId: pdfSource.id });
  assert.equal(loaded.hasCustomOutline, true);
  assert.equal(loaded.items.length, 2);
  assert.equal(loaded.items[0].children[0].page, 2);

  // Reject out-of-range page numbers
  await assert.rejects(() =>
    pdfOutlines.replace(course, {
      sourceId: pdfSource.id,
      items: [{ title: 'Out of bounds', page: 99 }],
    })
  );

  // Manage via tool wrapper: active-turn guard, idempotency, SSE callback, write cap
  const updates = [];
  const active = { course, readerSnapshot: { sourceId: pdfSource.id, page: 1 } };
  const toolResult = await managePdfOutline({
    pdfOutlines,
    course,
    active,
    args: {
      action: 'replace',
      items: [{ title: 'Clean Chapter 1', page: 1 }, { title: 'Clean Chapter 2', page: 3 }],
    },
    threadId: 't-1',
    turnId: 'turn-2',
    callId: 'call-1',
    write: fn => fn(),
    onUpdate: payload => updates.push(payload),
    isActive: () => true,
  });
  assert.equal(toolResult.hasCustomOutline, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].sourceId, pdfSource.id);

  // Idempotent repeat of same callId does not double-write or double-broadcast
  const repeated = await managePdfOutline({
    pdfOutlines,
    course,
    active,
    args: {
      action: 'replace',
      items: [{ title: 'Clean Chapter 1', page: 1 }, { title: 'Clean Chapter 2', page: 3 }],
    },
    threadId: 't-1',
    turnId: 'turn-2',
    callId: 'call-1',
    write: fn => fn(),
    onUpdate: payload => updates.push(payload),
    isActive: () => true,
  });
  assert.equal(repeated.count, 2);
  assert.equal(updates.length, 1);

  // Reset via tool
  const resetResult = await managePdfOutline({
    pdfOutlines,
    course,
    active,
    args: { action: 'reset' },
    threadId: 't-1',
    turnId: 'turn-2',
    callId: 'call-2',
    write: fn => fn(),
    onUpdate: payload => updates.push(payload),
    isActive: () => true,
  });
  assert.equal(resetResult.hasCustomOutline, false);
  assert.equal(updates.length, 2);
  assert.equal((await pdfOutlines.get(course, { sourceId: pdfSource.id })).hasCustomOutline, false);

  // Inactive turn rejected
  await assert.rejects(() =>
    managePdfOutline({
      pdfOutlines,
      course,
      active,
      args: { action: 'replace', items: [{ title: 'Late', page: 1 }] },
      threadId: 't-1',
      turnId: 'turn-2',
      callId: 'call-3',
      write: fn => fn(),
      onUpdate: () => {},
      isActive: () => false,
    })
  );

  // Sidecar symlink rejection
  const outlineDir = path.join(base, '.study-studio', 'pdf-outlines');
  await fs.mkdir(outlineDir, { recursive: true });
  const sidecarPath = path.join(outlineDir, `${pdfSource.id}.json`);
  const decoy = path.join(root, 'decoy.json');
  await fs.writeFile(decoy, '{"items":[]}', 'utf8');
  await fs.rm(sidecarPath, { force: true });
  await fs.symlink(decoy, sidecarPath);
  await assert.rejects(() => pdfOutlines.get(course, { sourceId: pdfSource.id }));
  await fs.unlink(sidecarPath);

  // removeSource cleans up sidecar
  await pdfOutlines.replace(course, {
    sourceId: pdfSource.id,
    items: [{ title: 'Temp', page: 1 }],
  });
  await pdfOutlines.removeSource(course, pdfSource.id);
  assert.equal((await pdfOutlines.get(course, { sourceId: pdfSource.id })).hasCustomOutline, false);

  // 3. extractPdfOutlineContext + PdfOutlineGenerator background regeneration
  const context = await extractPdfOutlineContext(path.join(base, pdfSource.relativePath));
  assert.equal(context.pages, 3);
  assert.equal(context.originalItems.length, 2);
  assert.equal(context.textPageCount, 3);

  let genCalls = 0;
  let releaseGen;
  const events = [];
  const generator = new PdfOutlineGenerator({
    store,
    pdfOutlines,
    generate: async input => {
      genCalls += 1;
      assert.equal(input.totalPages, 3);
      assert.equal(input.pages.length, 3);
      await new Promise(resolve => {
        releaseGen = resolve;
      });
      return {
        entries: [
          { title: '第 1 章 热力学概论', page: 1, level: 1 },
          { title: '1.2 热力学第一定律', page: 2, level: 2 },
          { title: '第 2 章 化学动力学', page: 3, level: 1 },
        ],
      };
    },
    onUpdate: payload => events.push(payload),
  });

  // Concurrent regenerate calls deduplicate into a single background job
  const [st1, st2] = await Promise.all([
    generator.regenerate(course, { sourceId: pdfSource.id, locale: 'zh-CN' }),
    generator.regenerate(course, { sourceId: pdfSource.id, locale: 'zh-CN' }),
  ]);
  assert.equal(st1.status, 'generating');
  assert.equal(st2.status, 'generating');
  assert.equal(st1.requestId, st2.requestId);
  assert.equal(generator.isCourseBusy(course.id), true);
  while (!releaseGen) await new Promise(r => setTimeout(r, 10));
  releaseGen();
  const doneState = await generator.wait(course, pdfSource.id);
  assert.equal(genCalls, 1);
  assert.equal(doneState.status, 'ready');
  assert.equal(generator.isCourseBusy(course.id), false);
  assert(events.some(e => e.generation?.status === 'generating'));
  assert(events.some(e => e.generation?.status === 'ready'));
  const generatedLoaded = await pdfOutlines.get(course, { sourceId: pdfSource.id });
  assert.equal(generatedLoaded.hasCustomOutline, true);
  assert.equal(generatedLoaded.items.length, 2);
  assert.equal(generatedLoaded.items[0].children[0].page, 2);

  // Failure retains existing outline and sets status=failed
  const failingGen = new PdfOutlineGenerator({
    store,
    pdfOutlines,
    generate: async () => {
      throw new Error('model temporarily unavailable');
    },
  });
  await failingGen.regenerate(course, { sourceId: pdfSource.id });
  const failedState = await failingGen.wait(course, pdfSource.id);
  assert.equal(failedState.status, 'failed');
  assert(failedState.error.includes('model temporarily unavailable'));
  assert.equal((await pdfOutlines.get(course, { sourceId: pdfSource.id })).items.length, 2);

  // Stale in-flight regeneration discarded after clearSource
  let releaseStale;
  const staleGen = new PdfOutlineGenerator({
    store,
    pdfOutlines,
    generate: async () => {
      await new Promise(resolve => {
        releaseStale = resolve;
      });
      return { entries: [{ title: 'Stale Outline', page: 1, level: 1 }] };
    },
  });
  await staleGen.regenerate(course, { sourceId: pdfSource.id });
  while (!releaseStale) await new Promise(r => setTimeout(r, 10));
  staleGen.clearSource(course, pdfSource.id);
  await pdfOutlines.reset(course, { sourceId: pdfSource.id });
  releaseStale();
  await staleGen.wait(course, pdfSource.id);
  assert.equal((await pdfOutlines.get(course, { sourceId: pdfSource.id })).hasCustomOutline, false);

  // Low-text / image-only PDF falls back to renderPage visual sampling
  const blankPdfBytes = buildMinimalPdf(['', ''], { withOutline: false });
  await store.upload(course, {
    name: 'scanned.pdf',
    mime: 'application/pdf',
    data: blankPdfBytes,
    folder: '课件',
  });
  const scannedSource = (await store.listSources(course)).find(s => s.name === 'scanned.pdf');
  assert(scannedSource);
  let sawImages = 0;
  const visualGen = new PdfOutlineGenerator({
    store,
    pdfOutlines,
    renderPage: async (_file, pageNum, tempRoot) => {
      const fakeImg = path.join(tempRoot, `p-${pageNum}.png`);
      await fs.writeFile(fakeImg, Buffer.from([137, 80, 78, 71]));
      return { page: pageNum, pages: 2, text: '', imagePath: fakeImg, tempDir: null, warnings: [] };
    },
    generate: async input => {
      sawImages = input.images.length;
      assert.deepEqual(input.imagePages, [
        { imageIndex: 1, page: 1 },
        { imageIndex: 2, page: 2 },
      ]);
      return { entries: [{ title: 'Scanned Cover', page: 1, level: 1 }, { title: 'Scanned Topic', page: 2, level: 1 }] };
    },
  });
  await visualGen.regenerate(course, { sourceId: scannedSource.id });
  const visualState = await visualGen.wait(course, scannedSource.id);
  assert.equal(visualState.status, 'ready');
  assert.equal(sawImages, 2);
  assert.equal((await pdfOutlines.get(course, { sourceId: scannedSource.id })).items.length, 2);

  console.log('PdfOutlines, PdfOutlineGenerator & study_pdf_outline: validation, inspect, scan, replace, reset, background generation, dedupe, stale guard, visual fallback, immutability, and symlink safety passed.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
