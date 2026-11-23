import {localEngine} from '@embedpdf/engine'
import type {Annotation,AnnotationBundle,OutlineItemRef} from '@embedpdf/engine-core'
import type {AbortablePromise,LocalDocumentHandle,LocalEngine} from '@embedpdf/engine-core/public'
import type {Viewer} from '@embedpdf/viewer-react'
import {checkedPdfAnnotation} from '../shared/pdf-markup.mjs'
import {checkedPdfOutline,type PdfOutlineNode} from '../shared/pdf-outline.mjs'
import {pdfAnnotationFont,storedToEmbedAnnotation,type StoredPdfAnnotation} from './embedPdfAnnotationMapping'
import {flushEmbedPdfAnnotations} from './useEmbedPdfAnnotations'

export type PdfAnnotationPageSnapshot={page:number;annotations:StoredPdfAnnotation[]}
export type AnnotatedPdfExportOptions={viewer:Viewer|null;courseId:string;sourceId:string;sourceUrl:string;signal?:AbortSignal}
const importBatchSize=200

async function cancellable<T>(task:AbortablePromise<T>,signal?:AbortSignal):Promise<T>{
 if(!signal)return await task
 if(signal.aborted){task.abort();await task.catch(()=>{});signal.throwIfAborted()}
 const cancel=()=>task.abort();signal.addEventListener('abort',cancel,{once:true})
 try{return await task}finally{signal.removeEventListener('abort',cancel)}
}
function checkedSnapshot(value:unknown):PdfAnnotationPageSnapshot[]{
 if(!value||typeof value!=='object'||!Array.isArray((value as {pages?:unknown}).pages))throw Error('批注快照不完整，未导出 PDF。')
 const pages=(value as {pages:unknown[]}).pages,result:PdfAnnotationPageSnapshot[]=[],seen=new Set<number>()
 for(const item of pages){
  if(!item||typeof item!=='object')throw Error('批注快照不完整，未导出 PDF。')
  const {page,annotations}=item as {page:number;annotations:unknown}
  if(!Number.isSafeInteger(page)||page<1||seen.has(page)||!Array.isArray(annotations))throw Error('批注页码或内容无效，未导出 PDF。')
  seen.add(page);const ids=new Set<string>(),records=annotations.map(value=>{const checked=checkedPdfAnnotation(value);if(ids.has(checked.id))throw Error('批注编号重复，未导出 PDF。');ids.add(checked.id);return checked})
  result.push({page,annotations:records})
 }
 return result.sort((a,b)=>a.page-b.page)
}

/** No viewer instance is involved: only an isolated document is changed. */
export async function mergePdfSidecarAnnotations(
 engine:LocalEngine,
 original:ArrayBuffer,
 pages:PdfAnnotationPageSnapshot[],
 signal?:AbortSignal,
 customOutline?:PdfOutlineNode[]|null
):Promise<Uint8Array>{
 const snapshot=checkedSnapshot({pages});let document:LocalDocumentHandle|undefined
 try{
  signal?.throwIfAborted()
  // The engine may transfer its input buffer; keep the fetched original intact.
  document=await cancellable(engine.open({kind:'bytes',bytes:original.slice(0)}),signal)
  const layout=await cancellable(document.pages.list(),signal),items:AnnotationBundle['items'][number][]=[],bundlePages=new Map<number,AnnotationBundle['pages'][number]>()
  let nextObjectNumber=1000000000
  for(const saved of snapshot){
   const page=layout.pages[saved.page-1]
   if(!page)throw Error('有批注的页面已不存在，未导出 PDF。')
   const geometry={ref:page.ref,index:saved.page-1,width:page.size.width,height:page.size.height,rotation:page.rotation}
   bundlePages.set(saved.page,{page:page.ref,position:saved.page-1,size:page.size})
   for(const record of saved.annotations){
    const annotation=storedToEmbedAnnotation(record,geometry)
    // Refs in the transfer bundle are unique placeholders; import allocates
    // document-owned refs without replacing any original PDF annotation.
    const data={...annotation,ref:{kind:'objectNumber' as const,page:page.ref,objectNumber:nextObjectNumber++}} as Annotation
    items.push({data,resources:{}})
   }
  }
  for(let start=0;start<items.length;start+=importBatchSize){
   signal?.throwIfAborted();const batch=items.slice(start,start+importBatchSize),pageNumbers=new Set(batch.map(item=>item.data.page.objectNumber))
   const bundle:AnnotationBundle={format:'embedpdf/annotations',version:1,pages:[...bundlePages.values()].filter(page=>pageNumbers.has(page.page.objectNumber)),items:batch,resources:{}}
   const imported=await cancellable(document.annotations.import(bundle,{attribution:'restore'}),signal)
   if(imported.dropped.length||imported.annotations.length!==batch.length)throw Error('有批注未能写入，未导出不完整的 PDF。')
  }
  if(Array.isArray(customOutline)){
   signal?.throwIfAborted()
   const validated=checkedPdfOutline(customOutline,{maxPage:layout.pages.length}).items
   const existing=await cancellable(document.outline.get(),signal)
   for(const item of existing.items){
    if(item.parent===null)await cancellable(document.outline.delete(item.ref),signal)
   }
   const writeNodes=async(nodes:readonly PdfOutlineNode[],parent:OutlineItemRef|null,depth:number)=>{
    for(const node of nodes){
     signal?.throwIfAborted()
     const page=layout.pages[Math.max(0,Math.min(layout.pages.length-1,(node.page||1)-1))]
     const created=await cancellable(document!.outline.create({
      title:node.title,
      target:page?{kind:'goto',destination:{kind:'fit',page:page.ref}}:null,
     },{parent}),signal)
     if(Array.isArray(node.children)&&node.children.length){
      await writeNodes(node.children,created.item.ref,depth+1)
      if(depth===0)await cancellable(document!.outline.update(created.item.ref,{open:true}),signal)
     }
    }
   }
   await writeNodes(validated,null,0)
  }
  signal?.throwIfAborted()
  return await cancellable(document.download({mode:'incremental'}),signal)
 }finally{await document?.close().catch(()=>{})}
}

/** Export every saved sidecar page and custom outline, including pages never opened in the viewer. */
export async function exportAnnotatedPdf({viewer,courseId,sourceId,sourceUrl,signal}:AnnotatedPdfExportOptions):Promise<Blob>{
 await flushEmbedPdfAnnotations({viewer,courseId,sourceId,signal})
 signal?.throwIfAborted()
 const endpoint='/api/courses/'+encodeURIComponent(courseId)+'/pdf-annotations?'+new URLSearchParams({sourceId,all:'1'})
 const outlineEndpoint='/api/courses/'+encodeURIComponent(courseId)+'/pdf-outline?'+new URLSearchParams({sourceId})
 const [snapshotResponse,outlineResponse]=await Promise.all([
  fetch(endpoint,{signal}),
  fetch(outlineEndpoint,{signal}).catch(()=>null),
 ])
 const value=await snapshotResponse.json()
 if(!snapshotResponse.ok)throw Error(value.error||'无法读取完整批注，未导出 PDF。')
 let customOutline:PdfOutlineNode[]|null=null
 if(outlineResponse&&outlineResponse.ok){
  try{
   const outlineData=await outlineResponse.json()
   if(outlineData?.hasCustomOutline&&Array.isArray(outlineData.items))customOutline=outlineData.items
  }catch{}
 }
 const snapshot=checkedSnapshot(value),response=await fetch(sourceUrl,{signal})
 if(!response.ok)throw Error('无法读取原 PDF，未导出文件。')
 const original=await response.arrayBuffer();signal?.throwIfAborted()
 const engine=localEngine({fonts:[pdfAnnotationFont]})
 try{
  const bytes=await mergePdfSidecarAnnotations(engine,original,snapshot,signal,customOutline)
  return new Blob([bytes.slice().buffer as ArrayBuffer],{type:'application/pdf'})
 }finally{await engine.destroy().catch(()=>{})}
}
