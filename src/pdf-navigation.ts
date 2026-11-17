import type {PDFDocumentProxy} from 'pdfjs-dist'

export type PdfOutlineItem={title:string;dest:string|unknown[]|null;items:PdfOutlineItem[]}

/** PDF destinations use zero-based page indices or indirect page references. */
export async function resolvePdfDestinationPage(document:Pick<PDFDocumentProxy,'getDestination'|'getPageIndex'|'numPages'>,destination:PdfOutlineItem['dest']):Promise<number|null>{
  const resolved=typeof destination==='string'?await document.getDestination(destination):destination
  if(!Array.isArray(resolved)||!resolved.length)return null
  const reference=resolved[0]
  let index:number
  if(typeof reference==='number')index=reference
  else if(reference&&typeof reference==='object'&&'num' in reference&&'gen' in reference&&typeof reference.num==='number'&&typeof reference.gen==='number')index=await document.getPageIndex({num:reference.num,gen:reference.gen})
  else return null
  return Number.isInteger(index)&&index>=0&&index<document.numPages?index+1:null
}
