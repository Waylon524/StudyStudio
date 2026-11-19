export const MAX_PDF_SELECTION_CHARS=12000;

/** Bound a quoted selection without collapsing its original line breaks. */
export function boundPdfSelection(value){
  if(typeof value!=='string')return '';
  const text=value.trim();
  if(text.length<=MAX_PDF_SELECTION_CHARS)return text;
  let end=MAX_PDF_SELECTION_CHARS;
  const last=text.charCodeAt(end-1),next=text.charCodeAt(end);
  if(last>=0xD800&&last<=0xDBFF&&next>=0xDC00&&next<=0xDFFF)end--;
  if(text[end-1]==='\r'&&text[end]==='\n')end--;
  return text.slice(0,end);
}
