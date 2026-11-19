import {useEffect, useMemo, useSyncExternalStore} from 'react'
import type {PdfAnnotation} from '../shared/pdf-markup.mjs'

type Status = 'loading' | 'ready' | 'saving' | 'error'
type Snapshot = {annotations:PdfAnnotation[]; status:Status; error:string}
type Change = {op:'upsert'; annotation:PdfAnnotation} | {op:'delete'; id:string}
type Pending = {change:Change; readyAt:number}

const emptySnapshot:Snapshot = {annotations:[], status:'loading', error:''}
const textSaveDelay = 450
const pageCacheLimit = 32
const cache = new Map<string, AnnotationPage>()

async function request(url:string, init?:RequestInit){
  const response = await fetch(url,init)
  const result = await response.json()
  if(!response.ok)throw new Error(result.error||'无法保存课件批注。')
  return result
}

// Keep a page's queue alive while the reader switches pages or closes.
class AnnotationPage {
  private readonly endpoint:string
  private readonly query:string
  private readonly listeners = new Set<()=>void>()
  private readonly items = new Map<string,PdfAnnotation>()
  private readonly pending = new Map<string,Pending>()
  private snapshot = emptySnapshot
  private loaded = false
  private loading = false
  private loadAgain = false
  private writing = false
  private keepalive = false
  private error = ''
  private timer:number|undefined

  constructor(courseId:string, private readonly sourceId:string, private readonly page:number){
    this.endpoint = '/api/courses/'+encodeURIComponent(courseId)+'/pdf-annotations'
    this.query = new URLSearchParams({sourceId,page:String(page)}).toString()
  }

  get idle(){
    return !this.listeners.size&&!this.pending.size&&!this.loading&&!this.writing
  }

  getSnapshot = ()=>this.snapshot
  subscribe = (listener:()=>void)=>{
    this.listeners.add(listener)
    return ()=>{this.listeners.delete(listener)}
  }

  load = async (refresh=false)=>{
    if(this.loading){this.loadAgain ||= refresh;return}
    if(this.loaded&&!refresh)return
    this.loading=true
    this.error=''
    this.publish()
    try{
      const result = await request(this.endpoint+'?'+this.query)
      if(!Array.isArray(result.annotations))throw new Error('批注数据格式无效。')
      this.items.clear()
      for(const annotation of result.annotations)this.items.set(annotation.id,annotation)
      this.loaded=true
    }catch(error){
      this.error=error instanceof Error?error.message:'无法读取课件批注。'
    }finally{
      this.loading=false
      this.publish()
      if(this.loadAgain){this.loadAgain=false;void this.load(true)}
    }
  }

  upsert = (annotation:PdfAnnotation, {debounce=false}:{debounce?:boolean}={})=>{
    if(!this.loaded)return
    if(this.items.get(annotation.id)===annotation){
      const pending=this.pending.get(annotation.id)
      if(pending&&!debounce){
        pending.readyAt=0
        this.schedule()
      }
      return
    }
    this.items.set(annotation.id,annotation)
    this.queue(annotation.id,{op:'upsert',annotation},debounce)
  }

  remove = (id:string)=>{
    if(!this.loaded||!this.items.delete(id))return
    this.queue(id,{op:'delete',id},false)
  }

  flush = (keepalive=false)=>{
    if(!this.pending.size)return
    this.keepalive ||= keepalive
    for(const operation of this.pending.values())operation.readyAt=0
    this.schedule()
  }

  retry = ()=>{
    if(!this.loaded){void this.load();return}
    this.error=''
    this.flush()
  }

  private publish(){
    const status = this.error?'error':!this.loaded?'loading':this.pending.size||this.writing?'saving':'ready'
    this.snapshot={annotations:[...this.items.values()],status,error:this.error}
    for(const listener of this.listeners)listener()
  }

  private queue(id:string,change:Change,debounce:boolean){
    this.pending.set(id,{change,readyAt:debounce?performance.now()+textSaveDelay:0})
    this.error=''
    this.publish()
    this.schedule()
  }

  private schedule(){
    window.clearTimeout(this.timer)
    if(this.writing||this.error||!this.pending.size)return
    const earliest=Math.min(...[...this.pending.values()].map(item=>item.readyAt))
    const wait=earliest-performance.now()
    if(wait>0)this.timer=window.setTimeout(()=>this.schedule(),Math.ceil(wait))
    else void this.write()
  }

  private async write(){
    this.writing=true
    try{
      while(this.pending.size){
        const next=[...this.pending].find(([,item])=>item.readyAt<=performance.now())
        if(!next)break
        const [id,operation]=next
        await request(this.endpoint,{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({sourceId:this.sourceId,page:this.page,...operation.change}),
          keepalive:this.keepalive
        })
        if(this.pending.get(id)===operation)this.pending.delete(id)
      }
    }catch(error){
      this.error=error instanceof Error?error.message:'无法保存课件批注。'
    }finally{
      this.writing=false
      if(!this.pending.size)this.keepalive=false
      this.publish()
      this.schedule()
    }
  }
}

function getPage(courseId:string,sourceId:string,page:number){
  const key=JSON.stringify([courseId,sourceId,page])
  const entry=cache.get(key)||new AnnotationPage(courseId,sourceId,page)
  cache.delete(key)
  cache.set(key,entry)
  if(cache.size>pageCacheLimit){
    for(const [oldKey,oldPage] of cache){
      if(oldKey!==key&&oldPage.idle)cache.delete(oldKey)
      if(cache.size<=pageCacheLimit)break
    }
  }
  return entry
}

const noop=()=>{}
const emptySubscribe=()=>noop
const getEmpty=()=>emptySnapshot

export function usePdfAnnotations(courseId:string,sourceId:string,page:number,enabled:boolean,refreshRevision?:number){
  const entry=useMemo(()=>enabled?getPage(courseId,sourceId,page):null,[courseId,sourceId,page,enabled])
  const snapshot=useSyncExternalStore(entry?.subscribe||emptySubscribe,entry?.getSnapshot||getEmpty)
  useEffect(()=>{
    if(!entry)return
    void entry.load()
    const flush=()=>entry.flush(true)
    const onVisibility=()=>{
      if(document.visibilityState==='hidden')flush()
    }
    window.addEventListener('pagehide',flush)
    document.addEventListener('visibilitychange',onVisibility)
    return ()=>{
      window.removeEventListener('pagehide',flush)
      document.removeEventListener('visibilitychange',onVisibility)
      entry.flush()
    }
  },[entry])
  useEffect(()=>{
    if(refreshRevision!==undefined)void entry?.load(true)
  },[entry,refreshRevision])
  return {
    ...snapshot,
    upsert:entry?.upsert||noop,
    remove:entry?.remove||noop,
    retry:entry?.retry||noop
  }
}
