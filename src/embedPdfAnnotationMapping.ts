import {annotationOfDraft,annotationKey} from '@embedpdf/engine-core'
import type {Annotation,AnnotationDraft,AnnotationRef,PageRef} from '@embedpdf/engine-core'
import type {PdfAnnotation,PdfMarkupColor} from '../shared/pdf-markup.mjs'

export type StoredPdfAnnotation=PdfAnnotation&{author?:'agent';embedPdf?:{version:3;annotation:Record<string,unknown>}}
export type PdfPageGeometry={ref:PageRef;index:number;width:number;height:number;rotation:number}
export const pdfAnnotationFont = {key:'NotoSansSC',familyName:'Noto Sans SC',url:'/embedpdf-fonts/NotoSansSC-Regular.otf'}
export const EMBED_PDF_EDITABLE_KINDS=['free-text','square','circle','line'] as const
const fields=['subtype','rect','box','linePoints','contents','intent','fontFamily','fontSize','fontColor','textAlign','verticalAlign','richText','color','strokeWidth','opacity','rotation','borderStyle','dashArray','interiorColor','lineEnding','lineEndings','cloudyIntensity','calloutLine'] as const
const colors:Record<PdfMarkupColor,string>={black:'#171717',red:'#d52d29',blue:'#245cdb',yellow:'#e9b818',green:'#27863c',white:'#ffffff'}
const bounded=(value:number,min=0,max=1)=>Math.max(min,Math.min(max,value))
export const supportedEmbedAnnotation=(annotation:Annotation)=>EMBED_PDF_EDITABLE_KINDS.some(kind=>kind===annotation.subtype)
export const embedRefKey=(ref:AnnotationRef)=>annotationKey(ref)
export const embedAnnotationKey=(annotation:Pick<Annotation,'ref'>)=>embedRefKey(annotation.ref)
export const managedAnnotationName=(id:string)=>'study-studio:'+id
export function managedAnnotationId(annotation:Annotation){const value=annotation.nm?.replace(/^study-studio:/,'');return annotation.nm?.startsWith('study-studio:')&&value&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)?value:null}
export function nativeAnnotationFields(annotation:Annotation):Record<string,unknown>{
 const source=annotation as unknown as Record<string,unknown>,result:Record<string,unknown>={}
 for(const field of fields)if(source[field]!==undefined)result[field]=source[field]
 return JSON.parse(JSON.stringify(result))
}
export function stableAnnotationJson(value:unknown):string{
 return JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
}
function toPoint(x:number,y:number,g:PdfPageGeometry){switch((g.rotation+360)%360){case 90:return {x:y*g.width,y:(1-x)*g.height};case 180:return {x:(1-x)*g.width,y:(1-y)*g.height};case 270:return {x:(1-y)*g.width,y:x*g.height};default:return {x:x*g.width,y:y*g.height}}}
function fromPoint(x:number,y:number,g:PdfPageGeometry){const a=x/g.width,b=y/g.height;switch((g.rotation+360)%360){case 90:return {x:bounded(1-b),y:bounded(a)};case 180:return {x:bounded(1-a),y:bounded(1-b)};case 270:return {x:bounded(b),y:bounded(1-a)};default:return {x:bounded(a),y:bounded(b)}}}
function nearestColor(value:unknown):PdfMarkupColor{
 const match=typeof value==='string'&&/^#([\da-f]{6})$/i.exec(value),rgb=match?[0,2,4].map(i=>parseInt(match[1].slice(i,i+2),16)):[0,0,0]
 return (Object.keys(colors) as PdfMarkupColor[]).reduce((best,key)=>{const distance=(k:PdfMarkupColor)=>[0,2,4].reduce((sum,i,j)=>sum+(parseInt(colors[k].slice(1+i,3+i),16)-rgb[j])**2,0);return distance(key)<distance(best)?key:best},'black')
}
function legacyDraft(record:StoredPdfAnnotation,g:PdfPageGeometry):AnnotationDraft{
 const start=toPoint(record.x,record.y,g),color=colors[record.color]
 if(record.kind==='text'){
  const lines=record.text.split('\n'),canvas=typeof document==='undefined'?null:document.createElement('canvas'),context=canvas?.getContext('2d');if(context)context.font=record.fontSize+'px Arial'
  const measured=context?Math.max(...lines.map(line=>context.measureText(line).width))+8:240
  return {subtype:'free-text',box:{...start,width:Math.max(1,Math.min(g.width-start.x,Math.max(record.fontSize*2,measured))),height:Math.max(1,Math.min(g.height-start.y,lines.length*record.fontSize*1.3+8))},contents:record.text,fontSize:record.fontSize,fontColor:color,strokeWidth:0,interiorColor:null}
 }
 const end=toPoint(record.endX,record.endY,g),rect={x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y)}
 if(record.kind==='line')return {subtype:'line',linePoints:{start,end},color,strokeWidth:record.strokeWidth,rect}
 return {subtype:record.kind==='rectangle'?'square':'circle',rect,color,strokeWidth:record.strokeWidth,interiorColor:null}
}
/** Build a complete, SDK-owned transfer DTO; no engine refs or scripts come from disk. */
export function storedToEmbedAnnotation(record:StoredPdfAnnotation,g:PdfPageGeometry):Annotation{
 let draft=(record.embedPdf?.annotation||legacyDraft(record,g)) as AnnotationDraft
 // Older text and agent annotations may omit their font.
 if(draft.subtype==='free-text'&&!draft.fontFamily&&/\p{Script=Han}/u.test(draft.contents??''))draft={...draft,fontFamily:pdfAnnotationFont.key}
 const raw=draft as unknown as Record<string,any>,line=raw.linePoints
 const rect=line?{x:Math.min(line.start.x,line.end.x),y:Math.min(line.start.y,line.end.y),width:Math.abs(line.end.x-line.start.x),height:Math.abs(line.end.y-line.start.y)}:undefined
 const annotation=annotationOfDraft({...draft,nm:managedAnnotationName(record.id)}, {ref:{kind:'objectNumber',objectNumber:1000000000,page:g.ref},...(rect?{rect}:{})})
 return {...annotation,author:record.author==='agent'?'学习助教':annotation.author}
}
/** Keep the old agent geometry useful while retaining every supported editor style. */
export function embedToStoredAnnotation(annotation:Annotation,g:PdfPageGeometry,id:string,previous?:StoredPdfAnnotation):StoredPdfAnnotation{
 const raw=annotation as unknown as Record<string,any>,rect=raw.box||annotation.rect
 const a=annotation.subtype==='line'?raw.linePoints.start:{x:rect.x,y:rect.y},b=annotation.subtype==='line'?raw.linePoints.end:{x:rect.x+rect.width,y:rect.y+rect.height}
 const start=fromPoint(a.x,a.y,g),end=fromPoint(b.x,b.y,g),base={id,...start,color:nearestColor(annotation.subtype==='free-text'?raw.fontColor:raw.color),...(previous?.author?{author:previous.author}:{}),embedPdf:{version:3 as const,annotation:nativeAnnotationFields(annotation)}}
 if(annotation.subtype==='free-text')return {...base,kind:'text',text:(annotation.contents||'').slice(0,4000),fontSize:bounded(raw.fontSize||12,8,96)}
 const kind=annotation.subtype==='line'?'line':annotation.subtype==='square'?'rectangle':'ellipse'
 if(kind!=='line'){base.x=Math.min(start.x,end.x);base.y=Math.min(start.y,end.y);end.x=Math.max(start.x,end.x);end.y=Math.max(start.y,end.y)}
 if(end.x===base.x&&(kind!=='line'||end.y===base.y))end.x=base.x<1?base.x+1e-6:base.x-1e-6
 if(end.y===base.y&&kind!=='line')end.y=base.y<1?base.y+1e-6:base.y-1e-6
 return {...base,kind,endX:end.x,endY:end.y,strokeWidth:bounded(raw.strokeWidth||1,1,16)}
}
