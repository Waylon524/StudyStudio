export const PDF_MARKUP_COLORS = Object.freeze(['black', 'red', 'blue', 'yellow', 'green', 'white']);
export const MAX_PDF_ANNOTATION_TEXT = 4000;

const shapeKinds = new Set(['line', 'rectangle', 'ellipse']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;

const embedPdfSubtypes = Object.freeze({text:'free-text', line:'line', rectangle:'square', ellipse:'circle'});
const embedPdfFields = new Set([
  'subtype', 'rect', 'box', 'start', 'end', 'points', 'linePoints', 'contents', 'intent',
  'fontFamily', 'fontSize', 'fontColor', 'textAlign', 'verticalAlign', 'richText',
  'color', 'strokeWidth', 'opacity', 'rotation', 'borderStyle', 'dashArray',
  'interiorColor', 'lineEnding', 'lineEndings', 'cloudyIntensity', 'calloutLine',
]);
const unsafeJsonKeys = new Set(['__proto__', 'constructor', 'prototype']);
const annotationEncoder = new TextEncoder();
const validAnnotationJson = (value, depth = 0) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth >= 10) return false;
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => validAnnotationJson(item, depth + 1));
  return isRecord(value) && Object.entries(value).every(([key, item]) => !unsafeJsonKeys.has(key) && validAnnotationJson(item, depth + 1));
};

function checkedEmbedPdfMarkup(value, kind) {
  const annotation = value?.annotation;
  if (value?.version !== 3 || !isRecord(annotation) || annotation.subtype !== embedPdfSubtypes[kind]
      || !isRecord(annotation.rect) || !Object.keys(annotation).every(field => embedPdfFields.has(field))
      || !validAnnotationJson(annotation) || annotationEncoder.encode(JSON.stringify(annotation)).byteLength > 44 * 1024) {
    throw new TypeError('PDF 编辑器批注格式无效或内容过长。');
  }
  return {version:3, annotation};
}

export function checkedPdfAnnotationId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError('批注编号无效。');
  }
  return value;
}

export function checkedPdfAnnotation(value) {
  if (!isRecord(value)) throw new TypeError('批注格式无效。');
  const {kind, x, y, color} = value;
  const id = checkedPdfAnnotationId(value.id);
  if (!inRange(x, 0, 1) || !inRange(y, 0, 1) || !PDF_MARKUP_COLORS.includes(color)) {
    throw new TypeError('批注位置或颜色无效。');
  }
  const attribution = value.author === 'agent' ? {author:'agent'} : {};
  const editor = value.embedPdf === undefined ? {} : {embedPdf:checkedEmbedPdfMarkup(value.embedPdf, kind)};
  if (kind === 'text') {
    const {text, fontSize} = value;
    if (typeof text !== 'string' || text.length > MAX_PDF_ANNOTATION_TEXT || text.includes('\0') || !inRange(fontSize, 8, 96)) {
      throw new TypeError('批注文字或字号无效。');
    }
    return {id, kind, x, y, color, text, fontSize, ...attribution, ...editor};
  }
  const {endX, endY, strokeWidth} = value;
  const hasSize = kind === 'line' ? endX !== x || endY !== y : endX !== x && endY !== y;
  if (!shapeKinds.has(kind) || !hasSize || !inRange(endX, 0, 1) || !inRange(endY, 0, 1) || !inRange(strokeWidth, 1, 16)) {
    throw new TypeError('图形种类、尺寸或线宽无效。');
  }
  return {id, kind, x, y, endX, endY, color, strokeWidth, ...attribution, ...editor};
}

/** A rectangle in displayed PDF page fractions, with an upper-left origin. */
export function boundPdfRegion(value) {
  if (!isRecord(value)) return null;
  const {x, y, width, height} = value;
  if (!inRange(x, 0, 1) || !inRange(y, 0, 1) || !inRange(width, 0, 1) || !inRange(height, 0, 1)) return null;
  if (width <= 0 || height <= 0 || x + width > 1 + Number.EPSILON || y + height > 1 + Number.EPSILON) return null;
  const boundedWidth = Math.min(width, 1 - x), boundedHeight = Math.min(height, 1 - y);
  if (boundedWidth <= 0 || boundedHeight <= 0) return null;
  return {x, y, width: boundedWidth, height: boundedHeight};
}
