import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LearningStore } from '../server/learning.mjs';
import { resolveDropZone } from '../shared/drop-zone.mjs';

function makeNode(attrs = {}, classes = [], parent = null) {
  const node = {
    parentElement: parent,
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? attrs[name] : null;
    },
    closest(selector) {
      let cur = node;
      while (cur) {
        if (selector === '[data-drop-zone]' && cur.getAttribute('data-drop-zone') !== null) return cur;
        if (selector === '.studio-left' && cur._classes.includes('studio-left')) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    _classes: classes,
  };
  return node;
}

// 1. Verify resolveDropZone routing across all layout states
{
  const left = makeNode({}, ['studio-left']);
  const leftInner = makeNode({}, [], left);
  const leftTextNode = { parentElement: leftInner };
  assert.equal(resolveDropZone(leftInner, { leftOpen: true, leftTab: 'sources' }), 'sources');
  assert.equal(resolveDropZone(leftTextNode, { leftOpen: true, leftTab: 'schedule' }), 'sources');
  assert.equal(resolveDropZone(leftInner, { leftOpen: true, leftTab: 'courseware' }), 'courseware');
  assert.equal(resolveDropZone(leftInner, { leftOpen: false, leftTab: 'courseware' }), 'conversation');

  // Explicit secondary pill inside open sidebar overrides sidebar default
  const pillCourseware = makeNode({ 'data-drop-zone': 'courseware' }, ['drop-zone-pill'], left);
  const pillChild = makeNode({}, [], pillCourseware);
  assert.equal(resolveDropZone(pillChild, { leftOpen: true, leftTab: 'sources' }), 'courseware');

  // Explicit dock cards inside collapsed conversation pane override conversation default
  const conv = makeNode({ 'data-drop-zone': 'conversation' }, ['conversation']);
  const convChild = makeNode({}, [], conv);
  assert.equal(resolveDropZone(convChild, { leftOpen: false, leftTab: 'sources' }), 'conversation');
  const dockSources = makeNode({ 'data-drop-zone': 'sources' }, ['drop-zone-dock-item'], conv);
  const dockCourseware = makeNode({ 'data-drop-zone': 'courseware' }, ['drop-zone-dock-item'], conv);
  assert.equal(resolveDropZone(makeNode({}, [], dockSources), { leftOpen: false, leftTab: 'courseware' }), 'sources');
  assert.equal(resolveDropZone(makeNode({}, [], dockCourseware), { leftOpen: false, leftTab: 'sources' }), 'courseware');

  // Fallback for null/unknown target defaults to conversation
  assert.equal(resolveDropZone(null, { leftOpen: true, leftTab: 'courseware' }), 'conversation');
}

// 2. Verify backend chat-only attachment storage isolation & lifecycle
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'study-chat-attach-'));
try {
  const store = new LearningStore({ root });
  const course = { id: 'chem-drop', name: '拖放分离测试' };
  await store.initCourse(course);

  // Upload a chat-only screenshot with generic mime -> mime inferred from extension
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const chatImg = await store.upload(course, {
    name: 'question-shot.png',
    mime: 'application/octet-stream',
    data: pngBytes,
    intent: 'chat',
  });
  assert.equal(chatImg.scope, 'chat');
  assert.equal(chatImg.mime, 'image/png');
  assert(chatImg.relativePath.startsWith('.study-studio/chat-attachments/'));

  // Upload a chat-only text note
  const chatNote = await store.upload(course, {
    name: 'snippet.md',
    mime: 'application/octet-stream',
    data: Buffer.from('# Quick Question\nWhy does SN2 invert configuration?\n', 'utf8'),
    intent: 'chat',
  });
  assert.equal(chatNote.scope, 'chat');
  assert.equal(chatNote.mime, 'text/markdown');

  // Chat-only attachments MUST NOT appear in course materials, workspace listing, or stats
  assert.deepEqual(await store.listSources(course), []);
  const ws = await store.listWorkspace(course);
  assert(!ws.files.some(f => f.name === 'question-shot.png' || f.name === 'snippet.md'));
  const stats = await store.courseStats(course);
  assert.equal(stats.materialCount, 0);
  assert.equal(stats.coursewareCount, 0);
  assert.equal(stats.fileCount, 0);

  // Chat-only attachments remain readable by /api/turn and /attachments/:id
  const fetchedImg = await store.attachment(course, chatImg.id);
  assert.equal(fetchedImg.scope, 'chat');
  assert.equal((await fs.readFile(fetchedImg.absolutePath)).equals(pngBytes), true);
  const readNote = await store.readFile(course, chatNote.relativePath);
  assert.match(readNote.text, /Why does SN2 invert configuration/);

  // Regular course material upload appears in listSources and CANNOT be deleted via removeChatAttachment
  const material = await store.upload(course, {
    name: 'chapter1.md',
    mime: 'text/markdown',
    data: Buffer.from('# Chapter 1\nNotes\n', 'utf8'),
    folder: '待整理',
  });
  assert.equal(material.scope, undefined);
  assert.equal((await store.listSources(course)).length, 1);
  await assert.rejects(() => store.removeChatAttachment(course, material.id), /仅可移除对话临时附件/);

  // Regular courseware upload appears as courseware and CANNOT be deleted via removeChatAttachment
  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
  const slide = await store.upload(course, {
    name: 'lecture1.pdf',
    mime: 'application/pdf',
    data: pdfBytes,
    intent: 'courseware',
  });
  const allSources = await store.listSources(course);
  assert.equal(allSources.length, 2);
  assert(allSources.some(s => s.attachmentId === slide.id && s.kind === 'courseware'));
  await assert.rejects(() => store.removeChatAttachment(course, slide.id), /仅可移除对话临时附件/);

  // Removing unsent chat attachment cleans both file and metadata without touching materials
  const removed = await store.removeChatAttachment(course, chatImg.id);
  assert.equal(removed.removed, true);
  await assert.rejects(() => store.attachment(course, chatImg.id), /未找到附件/);
  await assert.rejects(() => fs.stat(fetchedImg.absolutePath));
  assert.equal((await store.listSources(course)).length, 2);

  console.log('Chat attachments & drop-zone routing checks passed: zone routing, hidden chat storage, mime inference, source isolation, and safe draft removal verified.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
