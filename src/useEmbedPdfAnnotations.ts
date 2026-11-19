import {useCallback,useEffect,useRef,useState} from 'react'
import type {Viewer} from '@embedpdf/viewer-react'
import type {Annotation,AnnotationPatch,AnnotationRef} from '@embedpdf/engine-core'
import {HistoryToken} from '@embedpdf/react/history'
import {checkedPdfAnnotation} from '../shared/pdf-markup.mjs'
import {EMBED_PDF_EDITABLE_KINDS,embedAnnotationKey,embedRefKey,embedToStoredAnnotation,managedAnnotationId,managedAnnotationName,nativeAnnotationFields,stableAnnotationJson,storedToEmbedAnnotation,supportedEmbedAnnotation,type PdfPageGeometry,type StoredPdfAnnotation} from './embedPdfAnnotationMapping'

export type EmbedPdfAnnotationUpdate={sourceId:string;page:number;revision:number}
type Props={viewer:Viewer|null;courseId:string;sourceId:string;annotationUpdates?:EmbedPdfAnnotationUpdate}
type State={status:'loading'|'ready'|'saving'|'error';error:string}
type Change={sourceId:string;page:number;op:'upsert';annotation:StoredPdfAnnotation}|{sourceId:string;page:number;op:'delete';id:string}
const writers=new Map<string,AnnotationWriter>()
async function request(url:string,init?:RequestInit){const response=await fetch(url,init),value=await response.json();if(!response.ok)throw Error(value.error||'课件批注保存失败，请重试。');return value}

/** The last edit of each id survives viewer disposal and is sent in order. */
class AnnotationWriter{
 readonly pending=new Map<string,{change:Change;at:number}>()
 readonly listeners=new Set<()=>void>()
 writing=false;error='';private timer:ReturnType<typeof setTimeout>|undefined;private keepalive=false
 constructor(readonly endpoint:string){}
 publish(){for(const listener of this.listeners)listener()}
 enqueue(change:Change,delay=300){const id=change.op==='upsert'?change.annotation.id:change.id;this.pending.set(change.page+':'+id,{change,at:Date.now()+delay});this.error='';this.publish();this.schedule()}
 flush(keepalive=false){this.keepalive ||=keepalive;for(const item of this.pending.values())item.at=0;this.schedule()}
 retry(){this.error='';this.flush();this.publish()}
 drain(signal?:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
   const cleanup=()=>{this.listeners.delete(check);signal?.removeEventListener('abort',cancel)}
   const cancel=()=>{cleanup();reject(new DOMException('已取消导出。','AbortError'))}
   const check=()=>{if(this.error){cleanup();reject(Error(this.error))}else if(!this.pending.size&&!this.writing){cleanup();resolve()}}
   if(signal?.aborted){cancel();return}
   this.listeners.add(check);signal?.addEventListener('abort',cancel,{once:true});this.flush();check()
  })
 }
 overlay(page:number,records:StoredPdfAnnotation[]){const merged=new Map(records.map(record=>[record.id,record]));for(const {change} of this.pending.values())if(change.page===page){if(change.op==='delete')merged.delete(change.id);else merged.set(change.annotation.id,change.annotation)}return [...merged.values()]}
 private schedule(){clearTimeout(this.timer);if(this.writing||this.error||!this.pending.size)return;const at=Math.min(...[...this.pending.values()].map(item=>item.at));if(at>Date.now())this.timer=setTimeout(()=>this.schedule(),at-Date.now());else void this.write()}
 private async write(){this.writing=true;this.publish();try{while(this.pending.size){const entry=[...this.pending].find(([,item])=>item.at<=Date.now());if(!entry)break;const [id,item]=entry;await request(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(item.change),keepalive:this.keepalive});if(this.pending.get(id)===item)this.pending.delete(id)}}catch(error){this.error=error instanceof Error?error.message:'课件批注保存失败，请重试。'}finally{this.writing=false;if(!this.pending.size)this.keepalive=false;this.publish();this.schedule()}}
}
function writerFor(courseId:string,sourceId:string){const key=courseId+':'+sourceId;let writer=writers.get(key);if(!writer){writer=new AnnotationWriter('/api/courses/'+encodeURIComponent(courseId)+'/pdf-annotations');writers.set(key,writer)}if(writers.size>32)for(const [oldKey,old] of writers)if(oldKey!==key&&!old.pending.size&&!old.writing&&!old.listeners.size){writers.delete(oldKey);if(writers.size<=32)break}return writer}

export function useEmbedPdfAnnotations({viewer,courseId,sourceId,annotationUpdates}:Props):State&{retry:()=>void}{
 const [state,setState]=useState<State>({status:'loading',error:''}),controller=useRef<{refresh:(page?:number)=>void}|null>(null),latestUpdate=useRef(annotationUpdates);latestUpdate.current=annotationUpdates
 const retry=useCallback(()=>{writerFor(courseId,sourceId).retry();controller.current?.refresh()},[courseId,sourceId])
 useEffect(()=>{
  if(!viewer){setState({status:'loading',error:''});return}
  let alive=true,ready=false,loadError='',sessionStop:()=>void=()=>{}
  const writer=writerFor(courseId,sourceId),publish=()=>{if(alive)setState({status:loadError||writer.error?'error':!ready?'loading':writer.pending.size||writer.writing?'saving':'ready',error:loadError||writer.error})}
  writer.listeners.add(publish);publish()
  const stopViewer=viewer.watch(()=>{const api=viewer.tryGet('annotation');return api?.getStatus()==='ready'?api:null},value=>{
   sessionStop();sessionStop=()=>{};if(!value)return
   const api=value
   const documentId=viewer.documents.getActiveId();if(!documentId)return
   const scope=viewer.forDocument(documentId),stage=scope.get('stage'),abort=new AbortController()
   let live=true,initialized=false,chain=Promise.resolve(),bootstrap:Promise<void>|null=null
   const ownedNames=new Map<string,{id:string;page:number}>(),nativeSignatures=new Map<string,string>(),localRevisions=new Map<number,number>()
   const metadata=new Map<string,StoredPdfAnnotation>(),refs=new Map<string,{ref:AnnotationRef;id:string;page:number}>(),applied=new Map<string,string>(),loaded=new Set<number>(),syncing=new Set<string>(),deleting=new Set<string>(),queued=new Set<number>(),dirty=new Set<number>(),importingNames=new Set<string>()
   const geometry=(page:number):PdfPageGeometry|null=>{const box=stage.getPageBox(page-1);if(!box)return null;const scale=box.transform.viewScale;if(!scale)return null;return {ref:box.ref,index:page-1,width:box.transform.contentWidth/scale,height:box.transform.contentHeight/scale,rotation:(box.rotation-stage.getViewRotation()+360)%360}}
   const pageOf=(annotation:Pick<Annotation,'page'>)=>{for(let index=0;index<stage.getPageCount();index++){const box=stage.getPageBox(index);if(box?.ref.objectNumber===annotation.page.objectNumber)return index+1}return null}
   const currentPages=()=>[...new Set([stage.getCurrentPageIndex()+1,...stage.listVisiblePages().map(page=>page.pageIndex+1)])].filter(page=>page>0)
   const report=(error:unknown)=>{if(!live)return;loadError=error instanceof Error?error.message:'课件批注暂时无法同步，请重试。';publish()}
   const bind=(annotation:Annotation,id:string,page:number)=>{const key=embedAnnotationKey(annotation);for(const [oldKey,entry] of refs)if(oldKey!==key&&entry.id===id&&entry.page===page)refs.delete(oldKey);refs.set(key,{ref:annotation.ref,id,page});if(annotation.nm)ownedNames.set(page+':'+annotation.nm,{id,page});nativeSignatures.set(id,stableAnnotationJson(nativeAnnotationFields(annotation)))}
   const changed=(page:number)=>localRevisions.set(page,(localRevisions.get(page)||0)+1)
   const saveLocal=(annotation:Annotation)=>{
    if(!live||!supportedEmbedAnnotation(annotation))return
    const key=embedAnnotationKey(annotation);if(syncing.has(key))return
    const previous=refs.get(key),page=previous?.page||pageOf(annotation);if(!page)return
    const g=geometry(page);if(!g)return
    const id=previous?.id||managedAnnotationId(annotation)||crypto.randomUUID()
    try{const record=embedToStoredAnnotation(annotation,g,id,metadata.get(id));checkedPdfAnnotation(record);bind(annotation,id,page);metadata.set(id,record);applied.set(id,stableAnnotationJson(record));changed(page);writer.enqueue({sourceId,page,op:'upsert',annotation:record})}catch(error){report(error)}
   }
   const deleted=(deletedRefs:readonly AnnotationRef[])=>{for(const ref of deletedRefs){const key=embedRefKey(ref),saved=refs.get(key);if(!saved||deleting.has(key)||syncing.has(key))continue;changed(saved.page);writer.enqueue({sourceId,page:saved.page,op:'delete',id:saved.id},0);refs.delete(key);applied.delete(saved.id)}}
   // SDK history can restore a whole page as onResynced, without create/update
   // events. Match only names this instance already owned, never original marks.
   const reconcileNativeHistory=()=>{
    if(!initialized)return
    const present=new Set<string>()
    for(const annotation of api.list()){
     const key=embedAnnotationKey(annotation);present.add(key)
     if(!supportedEmbedAnnotation(annotation))continue
     const page=pageOf(annotation),owner=refs.get(key)||(page&&annotation.nm?ownedNames.get(page+':'+annotation.nm):undefined)
     if(!owner)continue
     if(!refs.has(key)||nativeSignatures.get(owner.id)!==stableAnnotationJson(nativeAnnotationFields(annotation))){bind(annotation,owner.id,owner.page);saveLocal(annotation)}
    }
    deleted([...refs.values()].filter(entry=>!present.has(embedRefKey(entry.ref))).map(entry=>entry.ref))
   }
   // Imports/refreshes only suppress their own refs. Other user edits still save.
   const stops=[api.onCreated(({annotation,origin})=>{if(origin.kind==='local'&&!importingNames.has(annotation.nm||''))saveLocal(annotation)}),api.onUpdated(({annotation,origin})=>{if(origin.kind==='local'&&refs.has(embedAnnotationKey(annotation)))saveLocal(annotation)}),api.onDeleted(({refs,origin})=>{if(origin.kind==='local')deleted(refs)})]
   async function syncPage(page:number){
    if(!live)return;const g=geometry(page);if(!g){loaded.delete(page);return}
    const revision=localRevisions.get(page)||0
    const value=await request(writer.endpoint+'?'+new URLSearchParams({sourceId,page:String(page)}),{signal:abort.signal});if(!live)return
    if(revision!==(localRevisions.get(page)||0)){dirty.add(page);return}
    if(!Array.isArray(value.annotations))throw Error('批注数据格式无效。')
    const records=writer.overlay(page,value.annotations as StoredPdfAnnotation[]),ids=new Set(records.map(record=>record.id))
    for(const [key,entry] of refs)if(entry.page===page&&!ids.has(entry.id)){deleting.add(key);try{if(api.get(entry.ref))await api.delete(entry.ref)}finally{deleting.delete(key);refs.delete(key);metadata.delete(entry.id);applied.delete(entry.id);nativeSignatures.delete(entry.id);for(const [name,owner] of ownedNames)if(owner.id===entry.id)ownedNames.delete(name)}}
    for(const record of records){
     if(!live)return;const signature=stableAnnotationJson(record);if(applied.get(record.id)===signature)continue
     const entry=[...refs.values()].find(entry=>entry.id===record.id&&entry.page===page),existing=entry&&api.get(entry.ref),data=storedToEmbedAnnotation(record,g)
     if(existing){const key=embedAnnotationKey(existing);syncing.add(key);try{const {annotation}=await api.update(existing.ref,data as AnnotationPatch);const current=api.get(existing.ref);bind(annotation,record.id,page);metadata.set(record.id,record);applied.set(record.id,signature);if(current&&stableAnnotationJson(current)!==stableAnnotationJson(annotation)){syncing.delete(key);saveLocal(current)}}finally{syncing.delete(key)}}
     else{
      const name=managedAnnotationName(record.id);importingNames.add(name)
      let result;try{result=await api.import({format:'embedpdf/annotations',version:1,pages:[{page:g.ref,position:g.index,size:{width:g.width,height:g.height}}],items:[{data,resources:{}}],resources:{}},{history:false,attribution:'restore'})}finally{importingNames.delete(name)}
      const annotation=result.annotations.find(annotation=>annotation.nm===managedAnnotationName(record.id));if(!annotation)throw Error('有一条课件批注未能恢复，请保留原记录后重试。')
      bind(annotation,record.id,page);metadata.set(record.id,record);applied.set(record.id,signature)
     }
    }
    loaded.add(page)
   }
   async function initialize(){
    if(initialized)return;if(bootstrap)return bootstrap
    bootstrap=(async()=>{
     api.updateSettings({editable:false})
     // Original PDF marks remain visible but cannot be silently edited outside
     // the sidecar. The source PDF is never rewritten.
     for(const annotation of api.list())if(supportedEmbedAnnotation(annotation)&&!refs.has(embedAnnotationKey(annotation))&&!annotation.readOnly)await api.update(annotation.ref,{readOnly:true,locked:true,lockedContents:true})
     scope.tryGet(HistoryToken)?.clear()
     for(const page of currentPages())await syncPage(page)
     if(!live)return;initialized=true;ready=true;loadError='';api.updateSettings({editable:[...EMBED_PDF_EDITABLE_KINDS]});publish()
    })().finally(()=>{bootstrap=null})
    return bootstrap
   }
   function schedule(page?:number,force=false){
    if(page!==undefined&&(page<1||page>stage.getPageCount()))return
    const pages=page===undefined?currentPages():[page]
    for(const n of pages){if(queued.has(n)){if(force)dirty.add(n);continue}if(!force&&loaded.has(n))continue;queued.add(n);chain=chain.catch(()=>{}).then(async()=>{try{await initialize();if(live&&initialized&&(force||!loaded.has(n)))await syncPage(n);while(live&&dirty.delete(n))await syncPage(n);loadError='';publish()}catch(error){if(live)report(error)}finally{queued.delete(n);if(live&&dirty.delete(n))schedule(n,true)}})}
   }
   const refresh=(page?:number)=>schedule(page,true);controller.current={refresh}
   const stopPages=viewer.watch(()=>{const current=stage.getCurrentPageIndex();return current+':'+stage.listVisiblePages().map(page=>page.pageIndex).join(',')+':'+!!stage.getPageBox(current)},(_value,previous)=>{const pages=currentPages();for(const page of pages)schedule(page,previous!==undefined&&page===stage.getCurrentPageIndex()+1)},{immediate:true})
   const resync=api.onResynced(()=>{reconcileNativeHistory();refresh()})
   const history=scope.tryGet(HistoryToken)?.onUndone(()=>reconcileNativeHistory())
   const foreground=()=>{if(document.visibilityState==='visible')refresh()};window.addEventListener('focus',foreground);window.addEventListener('online',foreground);document.addEventListener('visibilitychange',foreground)
   const pending=latestUpdate.current;if(pending?.sourceId===sourceId)schedule(pending.page,true)
   sessionStop=()=>{live=false;abort.abort();stopPages();resync();history?.();for(const stop of stops)stop();window.removeEventListener('focus',foreground);window.removeEventListener('online',foreground);document.removeEventListener('visibilitychange',foreground);controller.current=null}
  },{immediate:true})
  const flush=()=>writer.flush(true);window.addEventListener('pagehide',flush)
  return()=>{alive=false;stopViewer();sessionStop();writer.listeners.delete(publish);window.removeEventListener('pagehide',flush);writer.flush(true)}
 },[viewer,courseId,sourceId])
 useEffect(()=>{if(annotationUpdates?.sourceId===sourceId)controller.current?.refresh(annotationUpdates.page)},[annotationUpdates?.sourceId,annotationUpdates?.page,annotationUpdates?.revision,sourceId])
 return {...state,retry}
}

/** Settle the SDK's current edit before reading a complete server snapshot. */
export async function flushEmbedPdfAnnotations({viewer,courseId,sourceId,signal}:{viewer:Viewer|null;courseId:string;sourceId:string;signal?:AbortSignal}):Promise<void>{
 signal?.throwIfAborted()
 const api=viewer?.tryGet('annotation')
 if(viewer&&(!api||api.getStatus()!=='ready'))throw Error('课件还没有准备好，请稍后再导出。')
 if(api){
  if(api.text.getEditing())await api.text.end({signal})
  // The supported export call waits for queued native writes without changing
  // the active PDF, view, selection, history, or its download/dirty state.
  await api.export({refs:[]},{signal})
  // A rejected local record may never have entered the write queue. Detect it
  // here rather than silently exporting the older saved version.
  for(const annotation of api.list())if(supportedEmbedAnnotation(annotation)&&!annotation.readOnly){
   const page=viewer!.documents.getPage(annotation.page)
   if(!page)throw Error('批注所在页面尚未准备好，未导出 PDF。')
   checkedPdfAnnotation(embedToStoredAnnotation(annotation,{ref:page.ref,index:page.index,width:page.size.width,height:page.size.height,rotation:page.rotation},crypto.randomUUID()))
  }
 }
 signal?.throwIfAborted()
 await writerFor(courseId,sourceId).drain(signal)
}
