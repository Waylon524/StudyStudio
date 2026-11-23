import { checkedPdfOutline } from '../shared/pdf-outline.mjs';

const MAX_TURN_WRITES = 8;
const MAX_TOOL_CALLS = 32;
const allowedKeys = new Set(['action', 'sourceId', 'startPage', 'endPage', 'items']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const outlineNodeSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 300 },
    page: { type: 'integer', minimum: 1 },
    children: { type: 'array', items: { type: 'object' } },
  },
  required: ['title', 'page'],
  additionalProperties: false,
};

export const pdfOutlineTool = {
  name: 'study_pdf_outline',
  description:
    '读取、扫描并改写当前打开的（或指定 sourceId 的）课程 PDF 的目录（大纲 / 书签）。不会破坏原 PDF 文件，改写后立即同步到右侧 PDF 阅读器的目录面板并在导出 PDF 时内嵌。action="get" 读取总页数、当前自定义目录及 PDF 原目录；action="scan" 快速提取指定页码范围（每次最多 60 页）的每页标题与开头文字以便准确定位章节页码；action="replace" 用新的层级目录 items:[{title,page,children?}] 替换整份目录（页码从 1 开始）；action="reset" 恢复 PDF 原目录。省略 sourceId 默认操作本轮右侧打开的 PDF。改写前请先核实真实页码，切勿编造页码。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'scan', 'replace', 'reset'] },
      sourceId: { type: 'string', pattern: '^[0-9a-f]{24}$' },
      startPage: { type: 'integer', minimum: 1 },
      endPage: { type: 'integer', minimum: 1 },
      items: { type: 'array', items: outlineNodeSchema },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

function prepare(active, args) {
  if (!record(args) || Object.keys(args).some(key => !allowedKeys.has(key))) {
    throw new TypeError('PDF 目录工具参数无效。');
  }
  if (!['get', 'scan', 'replace', 'reset'].includes(args.action)) {
    throw new TypeError('action 必须是 get、scan、replace 或 reset。');
  }
  const fixed = active.readerSnapshot;
  const sourceId = args.sourceId !== undefined ? args.sourceId : fixed?.sourceId;
  if (typeof sourceId !== 'string' || !/^[0-9a-f]{24}$/.test(sourceId)) {
    throw new TypeError('请先打开一份 PDF，或提供有效的课程 PDF sourceId。');
  }
  if (args.action === 'scan') {
    const startPage = args.startPage === undefined ? 1 : args.startPage;
    const endPage = args.endPage;
    if (!Number.isSafeInteger(startPage) || startPage < 1) {
      throw new TypeError('startPage 必须是大于等于 1 的整数。');
    }
    if (endPage !== undefined && (!Number.isSafeInteger(endPage) || endPage < startPage)) {
      throw new TypeError('endPage 必须是大于等于 startPage 的整数。');
    }
    return { action: 'scan', sourceId, startPage, endPage };
  }
  if (args.action === 'replace') {
    const checked = checkedPdfOutline(args.items);
    if (!checked.items.length) {
      throw new TypeError('新目录不能为空；如需清除自定义目录并恢复原目录，请使用 action="reset"。');
    }
    return { action: 'replace', sourceId, items: checked.items };
  }
  return { action: args.action, sourceId };
}

export async function managePdfOutline({
  pdfOutlines,
  course,
  active,
  args,
  threadId,
  turnId,
  callId,
  write,
  onUpdate,
  isActive,
}) {
  if (!active || active.course?.id !== course.id || !isActive()) {
    throw new Error('本轮对话已经结束，未执行 PDF 目录操作。');
  }
  if (typeof callId !== 'string' || !callId || callId.length > 200) {
    throw new TypeError('PDF 目录工具调用编号无效。');
  }
  const request = prepare(active, args);
  active.pdfOutlineCalls ||= new Map();
  if (active.pdfOutlineCalls.has(callId)) return active.pdfOutlineCalls.get(callId);
  if (active.pdfOutlineCalls.size >= MAX_TOOL_CALLS) {
    throw new TypeError('本轮 PDF 目录工具调用次数已达到上限。');
  }

  if (request.action === 'get') {
    const task = pdfOutlines.inspect(course, { sourceId: request.sourceId });
    active.pdfOutlineCalls.set(callId, task);
    return task;
  }
  if (request.action === 'scan') {
    const task = pdfOutlines.scan(course, {
      sourceId: request.sourceId,
      startPage: request.startPage,
      endPage: request.endPage,
    });
    active.pdfOutlineCalls.set(callId, task);
    return task;
  }

  if ((active.pdfOutlineWriteCount || 0) >= MAX_TURN_WRITES) {
    throw new TypeError(`本轮最多改写 ${MAX_TURN_WRITES} 次 PDF 目录，请先完成当前回复。`);
  }
  active.pdfOutlineWriteCount = (active.pdfOutlineWriteCount || 0) + 1;
  const task = Promise.resolve()
    .then(() =>
      write(async () => {
        if (!isActive()) throw new Error('本轮对话已经结束，未保存 PDF 目录。');
        const result =
          request.action === 'replace'
            ? await pdfOutlines.replace(
                course,
                { sourceId: request.sourceId, items: request.items },
                { kind: 'agent', threadId, turnId: active.turnId || turnId || null, callId }
              )
            : await pdfOutlines.reset(course, { sourceId: request.sourceId });
        const scope = { courseId: course.id, sourceId: request.sourceId };
        try {
          onUpdate(scope);
        } catch {
          /* Saving succeeded even if an SSE subscriber has disconnected. */
        }
        return result;
      })
    )
    .catch(error => {
      active.pdfOutlineWriteCount -= 1;
      throw error;
    });
  active.pdfOutlineCalls.set(callId, task);
  return task;
}
