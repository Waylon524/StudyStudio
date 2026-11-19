export type PdfMarkupColor = 'black' | 'red' | 'blue' | 'yellow' | 'green' | 'white';
export type PdfRegion = {x:number; y:number; width:number; height:number};
export type EmbedPdfMarkup = {version:3; annotation:Record<string,unknown>};
type PdfAnnotationBase = {
  id:string;
  x:number;
  y:number;
  color:PdfMarkupColor;
  author?:'agent';
  embedPdf?:EmbedPdfMarkup;
};
export type PdfTextAnnotation = PdfAnnotationBase & {kind:'text'; text:string; fontSize:number};
export type PdfShapeAnnotation = PdfAnnotationBase & {
  kind:'line' | 'rectangle' | 'ellipse';
  endX:number;
  endY:number;
  strokeWidth:number;
};
export type PdfAnnotation = PdfTextAnnotation | PdfShapeAnnotation;
export const PDF_MARKUP_COLORS: readonly PdfMarkupColor[];
export const MAX_PDF_ANNOTATION_TEXT: number;
export function checkedPdfAnnotationId(value:unknown):string;
export function checkedPdfAnnotation(value:unknown):PdfAnnotation;
export function boundPdfRegion(value:unknown):PdfRegion | null;
