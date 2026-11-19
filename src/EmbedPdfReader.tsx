import { localEngine } from '@embedpdf/engine'
import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { PDFViewer, type Viewer, type ViewerConfig, type Layout, type CommandDefinition, type EmbedPdfViewerElement } from '@embedpdf/viewer-react'
import { ChevronLeft, ChevronRight, Download, LoaderCircle, MessageSquareQuote, X } from 'lucide-react'
import type { PdfReaderProps, PdfRegionSelection } from './PdfReader'
import { pdfAnnotationFont } from './embedPdfAnnotationMapping'
import { useEmbedPdfAnnotations } from './useEmbedPdfAnnotations'
import { exportAnnotatedPdf } from './exportAnnotatedPdf'
import { installPageFrameRetention } from './embedPdfFrameRetention'
import './embed-pdf-reader.css'

export type EmbedPdfReaderProps = PdfReaderProps & {
  annotationUpdates?: {sourceId:string;page:number;revision:number}
  /** A host can retain the original reader as a recovery path. */
  onViewerError?: () => void
  onFocusQuestion?: () => void
}

// Register before restoring annotations. A global CJK fallback can break source-page rendering.
const engine = () => localEngine({fonts:[pdfAnnotationFont]})
const fonts:ViewerConfig['fonts'] = [{...pdfAnnotationFont,label:'思源黑体'}]
const plugins:ViewerConfig['plugins'] = {
  stage:{flow:'paged',spread:'none',zoom:{mode:'fit-width'}},
  actions:{javascript:{enabled:false},openSequence:'off',triggers:{document:false,page:false,annotation:false}},
  annotation:{editable:['free-text','square','circle','line'],afterCreate:{select:true,tool:'default',editText:true},tools:[{id:'free-text',defaults:{fontFamily:pdfAnnotationFont.key,fontSize:18,fontColor:'#000000'}},{id:'line',defaults:{strokeWidth:2}},{id:'square',defaults:{strokeWidth:2}},{id:'circle',defaults:{strokeWidth:2}}]},
}
const features:ViewerConfig['features'] = {
  annotations:false,'annotations.text':true,shapes:true,snapshots:true,
  comments:false,stamps:false,signatures:false,forms:false,pages:false,
  attachments:false,redaction:false,measurement:false,
  'outline.editing':false,'documents.open':false,'documents.tabs':false,'documents.download':false,
}
// The viewer retains its own adaptive toolbar, popovers, text editor and handles.
// Only the supported, persisted annotation kinds have creation buttons.
function readerLayout(layout:Layout){
  return layout.tabs('never').removeBar(['annotate','shapes','insert','form','redact','measure','pager']).addBar('main',{
    place:'bottom',
    start:[{id:'navigation',importance:5,items:['panel:thumbnails','panel:outline']}],
    center:[{id:'study-tools',importance:3,titleKey:'study.tools',collapse:'menu',items:['tool:pointer','tool:free-text','tool:line','tool:square','tool:circle','tool:snapshot','history:undo','history:redo']}],
    end:[{id:'zoom',importance:4,items:[{custom:'zoom',command:'menu:zoom',variants:['inline','button']}]},{id:'search',importance:3,items:['panel:search']}],
  }).panel('thumbnails',{present:{compact:'overlay',medium:'overlay',expanded:'dock'}}).panel('outline',{present:{compact:'overlay',medium:'overlay',expanded:'dock'}}).add('study:quote-text',{to:'selection',group:'selection'}).add('study:quote-region',{to:'snapshot',group:'snapshot'})
}
type ReaderAppState={isComposing:()=>boolean;focusQuestion:()=>void;canFocusQuestion:()=>boolean;quoteRegion:()=>void;canQuoteRegion:()=>boolean}
const hiddenTools = ['tool:insert-text','tool:replace-text','tool:callout','tool:arrow','tool:polyline','tool:polygon','tool:cloud','tool:ink','tool:ink-highlight','tool:note','tool:link','tool:highlight','tool:underline','tool:strikeout','tool:squiggly']
const commands:ViewerConfig<ReaderAppState>['commands'] = [
  {id:'panel:outline',visible:context=>context.viewer.documents.getActive()?.status==='ready',enabled:context=>context.viewer.documents.getActive()?.status==='ready'},
  ...hiddenTools.map(id=>({id,visible:()=>false,enabled:()=>false})),
  ...['free-text','line','square','circle','snapshot'].map((tool):CommandDefinition<ReaderAppState>=>({
    id:'tool:'+tool,
    ...(tool==='snapshot'?{label:'框选区域',labelKey:'study.region'}:{}),
    run:async context=>{
      // The native edit handler consumes the next page gesture while editing.
      // End that session at an explicit tool change, never during an IME draft.
      if(context.appState.isComposing())return
      const annotation=context.tryGet('annotation')
      const ending=annotation?.text.getEditing()?annotation.text.end({signal:context.signal}):null
      // text.end clears its session synchronously; its returned promise saves it.
      context.tryGet('interaction')?.activateTool(tool)
      if(ending)await ending
    },
  })),
  ...['text','region'].map((kind):CommandDefinition<ReaderAppState>=>({
    id:'study:quote-'+kind,label:'引用到对话',labelKey:'study.quote',icon:'comment',
    visible:context=>context.appState.canFocusQuestion(),
    enabled:context=>kind==='region'?context.appState.canQuoteRegion():context.appState.canFocusQuestion(),
    run:context=>kind==='region'?context.appState.quoteRegion():context.appState.focusQuestion(),
  })),
]
const strings:ViewerConfig['strings'] = {
  en:{'study.region':'Select region','study.tools':'More annotation tools','study.quote':'Quote in chat'},
  'zh-CN':{'study.region':'框选区域','study.tools':'更多批注工具','study.quote':'引用到对话'},
}

/** A separate instance owns one course/document, including every viewer listener. */
export function EmbedPdfReader(props:EmbedPdfReaderProps){
  return <ReaderBoundary key={JSON.stringify([props.courseId,props.source.id,props.source.url])} onError={props.onReaderError} onFallback={props.onViewerError}><DocumentReader {...props}/></ReaderBoundary>
}

function DocumentReader(props:EmbedPdfReaderProps){
  const {courseId,source,page,textSelectionReset=0,regionSelection,annotationUpdates,onAskSelection,onClose,onViewerError}=props
  const [viewer,setViewer]=useState<Viewer|null>(null)
  const [error,setError]=useState('')
  const [pageCount,setPageCount]=useState(0)
  const [pageDraft,setPageDraft]=useState(String(page||1))
  const [downloadOpen,setDownloadOpen]=useState(false)
  const [exporting,setExporting]=useState(false)
  const [downloadError,setDownloadError]=useState('')
  const root=useRef<HTMLElement>(null)
  const viewerElement=useRef<EmbedPdfViewerElement|null>(null)
  const viewerRef=useRef<Viewer|null>(null)
  const stagedRegion=useRef<PdfRegionSelection|null>(null)
  const downloadMenu=useRef<HTMLDivElement>(null)
  const downloadTrigger=useRef<HTMLButtonElement>(null)
  const exportAbort=useRef<AbortController|null>(null)
  const exportBusy=useRef(false)
  const alive=useRef(true)
  const downloadUrls=useRef(new Map<string,ReturnType<typeof setTimeout>>())
  const callbacks=useRef(props)
  const lastRead=useRef(0)
  const localGesture=useRef(false)
  const suppressClear=useRef(false)
  const composing=useRef(false)
  callbacks.current=props
  viewerRef.current=viewer
  const currentRegion=():PdfRegionSelection|null=>{
    const currentViewer=viewerRef.current,snapshot=currentViewer?.tryGet('render')?.getSnapshot(),stage=currentViewer?.tryGet('stage')
    if(!currentViewer||!snapshot||!stage)return null
    const index=currentViewer.documents.getPageIndex(snapshot.page),layout=currentViewer.documents.getPage(snapshot.page)
    if(!layout||index!==stage.getCurrentPageIndex())return null
    const {width,height}=layout.size
    const x=Math.max(0,Math.min(1,snapshot.rect.x/width)),y=Math.max(0,Math.min(1,snapshot.rect.y/height))
    const w=Math.min(1-x,snapshot.rect.width/width),h=Math.min(1-y,snapshot.rect.height/height)
    return w>0&&h>0?{sourceId:callbacks.current.source.id,page:index+1,region:{x,y,width:w,height:h}}:null
  }
  const canQuoteRegion=()=>!!callbacks.current.onRegionSelectionChange&&!!currentRegion()
  const appState=useMemo<ReaderAppState>(()=>({
    isComposing:()=>composing.current,
    focusQuestion:()=>callbacks.current.onFocusQuestion?.(),
    canFocusQuestion:()=>!!callbacks.current.onFocusQuestion,
    canQuoteRegion,
    quoteRegion:()=>{const selection=currentRegion();if(!selection||!callbacks.current.onRegionSelectionChange)return;callbacks.current.onRegionSelectionChange(selection);callbacks.current.onFocusQuestion?.()},
  }),[])
  const ready=useCallback((next:Viewer)=>setViewer(next),[])
  const annotations=useEmbedPdfAnnotations({viewer,courseId,sourceId:source.id,annotationUpdates})

  useEffect(()=>{
    if(!viewer)return
    let disposeDocument=()=>{}
    let alive=true
    const attach=()=>{
      const info=viewer.documents.getActive()
      if(info?.status!=='ready')return
      disposeDocument()
      const doc=viewer.forDocument(info.id),stage=doc.get('stage'),selection=doc.get('selection'),render=doc.get('render')
      let disposed=false
      setPageCount(info.pageCount)
      const requested=Math.max(0,Math.min(info.pageCount-1,(callbacks.current.page||1)-1))
      stage.goToPage(requested,{behavior:'instant'})
      if(requested+1!==callbacks.current.page)callbacks.current.onPageChange(requested+1)
      const pageChanged=stage.onPageChanged(({pageIndex})=>{
        stagedRegion.current=null;render.clearSnapshot()
        if(pageIndex>=0&&pageIndex+1!==callbacks.current.page)callbacks.current.onPageChange(pageIndex+1)
      })
      const committed=selection.onCommitted(({range})=>{
        const first=viewer.documents.getPageIndex(range.start.page,info.id)
        const last=viewer.documents.getPageIndex(range.end.page,info.id)
        const current=stage.getCurrentPageIndex()
        // Quotes always name one real PDF page, never text from menus or sidebars.
        if(first!==current||last!==current)return
        const request=++lastRead.current
        void selection.readTextInRange(range).then(text=>{
          if(alive&&!disposed&&request===lastRead.current&&text.trim())callbacks.current.onTextSelectionChange?.({sourceId:source.id,page:current+1,text:text.trim()})
        }).catch(()=>{/* Copy-restricted PDFs remain readable. */})
      })
      const cleared=selection.onCleared(()=>{
        ++lastRead.current
        if(!suppressClear.current&&localGesture.current)callbacks.current.onTextSelectionChange?.(null)
      })
      const snapshot=render.onSnapshotChanged(({snapshot})=>{
        if(!snapshot){stagedRegion.current=null;return}
        // Snapshot images are viewer-owned; Agent uses the normalized source region.
        void snapshot.image.catch(()=>{})
        const index=viewer.documents.getPageIndex(snapshot.page,info.id)
        const layout=viewer.documents.getPage(snapshot.page,info.id)
        if(!layout||index<0)return
        const {width,height}=layout.size
        const x=Math.max(0,Math.min(1,snapshot.rect.x/width)),y=Math.max(0,Math.min(1,snapshot.rect.y/height))
        const w=Math.min(1-x,snapshot.rect.width/width),h=Math.min(1-y,snapshot.rect.height/height)
        if(w>0&&h>0&&index===stage.getCurrentPageIndex())stagedRegion.current={sourceId:source.id,page:index+1,region:{x,y,width:w,height:h}}
      })
      disposeDocument=()=>{disposed=true;pageChanged();committed();cleared();snapshot()}
      setError('')
    }
    const opened=viewer.documents.onOpened(attach)
    const failed=viewer.documents.onOpenFailed(({error})=>{
      const message=error.message||'无法打开这份 PDF。'
      setError(message);callbacks.current.onReaderError?.(message)
    })
    attach()
    return()=>{alive=false;++lastRead.current;opened();failed();disposeDocument()}
  },[viewer,source.id])

  useEffect(()=>{setPageDraft(String(page||1));stagedRegion.current=null;viewer?.tryGet('render')?.clearSnapshot()},[viewer,page])
  useEffect(()=>{
    const stage=viewer?.tryGet('stage')
    if(stage&&stage.getCurrentPageIndex()!==page-1)stage.goToPage(Math.max(0,page-1),{behavior:'instant'})
  },[viewer,page])
  useEffect(()=>{
    ++lastRead.current;suppressClear.current=true
    stagedRegion.current=null;viewer?.tryGet('render')?.clearSnapshot()
    viewer?.tryGet('selection')?.clear()
    suppressClear.current=false
  },[viewer,textSelectionReset])
  useEffect(()=>{
    if(!regionSelection){stagedRegion.current=null;viewer?.tryGet('render')?.clearSnapshot()}
  },[viewer,regionSelection])
  useEffect(()=>{
    const pointer=(event:PointerEvent)=>{
      const path=event.composedPath()
      localGesture.current=!!root.current&&path.includes(root.current)&&!path.some(node=>node instanceof HTMLElement&&(node.matches('button,input,textarea,select,[contenteditable="true"],[role="button"],[role="menuitem"]')))
    }
    const compositionStart=()=>{composing.current=true},compositionEnd=()=>{composing.current=false}
    const element=root.current
    element?.addEventListener('compositionstart',compositionStart,true)
    element?.addEventListener('compositionend',compositionEnd,true)
    window.document.addEventListener('pointerdown',pointer,true)
    return()=>{window.document.removeEventListener('pointerdown',pointer,true);element?.removeEventListener('compositionstart',compositionStart,true);element?.removeEventListener('compositionend',compositionEnd,true)}
  },[])
  useEffect(()=>{
    if(!viewer)return
    const keydown=(event:KeyboardEvent)=>{
      if(callbacks.current.keyboardEnabled===false||event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||!['ArrowLeft','ArrowRight'].includes(event.key))return
      const path=event.composedPath()
      if(path.some(node=>node instanceof HTMLElement&&(node.isContentEditable||node.matches('button,input,textarea,select,a,[role="button"],[role="textbox"],[role="slider"],[role="spinbutton"],[role="menu"],[role="menuitem"],[role="option"]'))))return
      // A global page shortcut must leave the composer's caret and other UI alone.
      const active=window.document.activeElement
      if(active&&active!==window.document.body&&!root.current?.contains(active))return
      const stage=viewer.tryGet('stage')
      if(!stage)return
      event.preventDefault();event.stopPropagation()
      if(event.key==='ArrowRight')stage.nextPage({behavior:'instant'});else stage.previousPage({behavior:'instant'})
    }
    window.document.addEventListener('keydown',keydown,true)
    return()=>window.document.removeEventListener('keydown',keydown,true)
  },[viewer])
  useEffect(()=>{
    const shadow=viewerElement.current?.shadowRoot
    if(!viewer||!shadow)return
    // The SDK exposes the whole panel-header as a part, not its switcher.
    // Scope this to navigation panels only; their bottom buttons and Escape close them.
    const style=document.createElement('style')
    style.dataset.studyNavigationHeader='true'
    style.textContent='[data-epdf-panel="thumbnails"] [data-epdf-panel-header],[data-epdf-panel="outline"] [data-epdf-panel-header]{display:none}'
    shadow.append(style)
    const stopMotion=installNavigationExitMotion(viewer,viewerElement.current!)
    const stopFrames=installPageFrameRetention(viewer,viewerElement.current!)
    return()=>{stopFrames();stopMotion();style.remove()}
  },[viewer])
  useEffect(()=>{
    if(!downloadOpen)return
    const outside=(event:PointerEvent)=>{if(!downloadMenu.current?.contains(event.target as Node))setDownloadOpen(false)}
    downloadMenu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();setDownloadOpen(false);downloadTrigger.current?.focus();return}
      if(!downloadMenu.current?.contains(event.target as Node)||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return
      const items=Array.from(downloadMenu.current.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'))
      if(!items.length)return
      event.preventDefault()
      const index=items.indexOf(document.activeElement as HTMLElement)
      const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length
      items[next]?.focus()
    }
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key,true)
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',key,true)}
  },[downloadOpen])
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;exportAbort.current?.abort();for(const [url,timer] of downloadUrls.current){clearTimeout(timer);URL.revokeObjectURL(url)}downloadUrls.current.clear()}},[])
  const navigate=(value:number)=>{const stage=viewer?.tryGet('stage');if(!stage||!Number.isFinite(value))return null;const index=Math.max(0,Math.min(stage.getPageCount()-1,Math.round(value)-1));stage.goToPage(index,{behavior:'instant'});return index+1}
  const commitPage=()=>{const value=pageDraft.trim(),target=/^\d+$/.test(value)?navigate(Number(value)):null;setPageDraft(String(target??page??1))}
  const downloadAnnotated=async()=>{
    if(exportBusy.current||composing.current||!viewer||annotations.status==='loading'||annotations.status==='error')return
    exportBusy.current=true;setExporting(true);setDownloadError('');setDownloadOpen(false);downloadTrigger.current?.focus()
    const controller=new AbortController();exportAbort.current=controller
    try{
      const blob=await exportAnnotatedPdf({viewer,courseId,sourceId:source.id,sourceUrl:source.url,signal:controller.signal})
      if(!alive.current||controller.signal.aborted)return
      const url=URL.createObjectURL(blob),anchor=document.createElement('a')
      anchor.href=url;anchor.download=source.name.replace(/\.pdf$/i,'')+'（含批注）.pdf';anchor.hidden=true
      document.body.append(anchor);anchor.click();anchor.remove()
      const timer=setTimeout(()=>{URL.revokeObjectURL(url);downloadUrls.current.delete(url)},300000)
      downloadUrls.current.set(url,timer)
    }catch(reason){if(alive.current&&!controller.signal.aborted)setDownloadError(reason instanceof Error?reason.message:'无法导出含批注的 PDF，请重试。')}
    finally{exportBusy.current=false;if(alive.current)setExporting(false);if(exportAbort.current===controller)exportAbort.current=null}
  }
  return <section className="pdf-reader embed-pdf-reader" ref={root} aria-label="课件阅读器">
    <header className="embed-pdf-reader-header">
      <strong className="embed-pdf-reader-title" title={source.name}>{source.name}</strong>
      {onAskSelection&&<button type="button" className="embed-pdf-reader-ask" onClick={onAskSelection} aria-label={regionSelection?'用选区提问':'用选中文字提问'} title={regionSelection?'用选区提问':'用选中文字提问'}><MessageSquareQuote size={16}/><span>{regionSelection?'用选区提问':'用选中文字提问'}</span></button>}
      <form className="embed-pdf-reader-pages" aria-label="PDF 页码" onSubmit={event=>{event.preventDefault();commitPage()}}>
        <button type="button" className="embed-pdf-reader-icon" aria-label="上一页" title="上一页" disabled={!pageCount||page<=1} onClick={()=>navigate(viewer?.tryGet('stage')?.getCurrentPageIndex()??page-1)}><ChevronLeft size={17}/></button>
        <input aria-label="页码" inputMode="numeric" pattern="[0-9]*" value={pageDraft} disabled={!pageCount} style={{width:Math.max(String(pageCount).length,2)+.5+'ch'}} onChange={event=>setPageDraft(event.target.value)} onBlur={commitPage}/>
        <span className="embed-pdf-reader-page-count">/ {pageCount||'—'}</span>
        <button type="button" className="embed-pdf-reader-icon" aria-label="下一页" title="下一页" disabled={!pageCount||page>=pageCount} onClick={()=>navigate((viewer?.tryGet('stage')?.getCurrentPageIndex()??page-1)+2)}><ChevronRight size={17}/></button>
      </form>
      <div className="embed-pdf-reader-download" ref={downloadMenu} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDownloadOpen(false)}}>
        <button type="button" className="embed-pdf-reader-icon" ref={downloadTrigger} aria-label="下载 PDF" title={exporting?'正在导出 PDF…':'下载 PDF'} aria-haspopup="menu" aria-expanded={downloadOpen} onClick={()=>setDownloadOpen(open=>!open)}>{exporting?<LoaderCircle size={17} className="embed-pdf-reader-export-spinner"/>:<Download size={17}/>}</button>
        {downloadOpen&&<div className="embed-pdf-reader-download-menu" role="menu" aria-label="下载 PDF">
          <a role="menuitem" href={source.url} download={source.name} onClick={()=>setDownloadOpen(false)}>下载原件</a>
          <button type="button" role="menuitem" disabled={!viewer||exporting||annotations.status==='loading'||annotations.status==='error'} onClick={()=>void downloadAnnotated()}>{exporting?'正在导出…':'导出带批注的 PDF'}</button>
        </div>}
      </div>
      <button type="button" className="embed-pdf-reader-icon" aria-label="关闭阅读器" title="关闭阅读器" onClick={onClose}><X size={18}/></button>
    </header>
    <div className="embed-pdf-reader-viewer">
      <PDFViewer className="study-embed-viewer" elementRef={viewerElement} src={source.url} onReady={ready} engine={engine} fonts={fonts} plugins={plugins} features={features} commands={commands} appState={appState} strings={strings} layout={readerLayout} locale="zh-CN" theme={{preference:'light',accent:'#9a634c'}} warnBeforeLeaving={false} readOnly={exporting||annotations.status==='loading'||annotations.status==='error'}/>
    </div>
    {(error||downloadError||annotations.status==='error')&&<div className="embed-pdf-reader-error" role="status"><span>{error||downloadError||annotations.error}</span>{annotations.status==='error'&&<button type="button" onClick={annotations.retry}>重试保存</button>}{error&&onViewerError&&<button type="button" onClick={onViewerError}>使用原阅读器</button>}</div>}
  </section>
}
/** The SDK removes closed panels immediately. Retain only its detached pixels for
 * a brief, inert exit; document layout and every real control close immediately. */
function installNavigationExitMotion(viewer:Viewer,element:EmbedPdfViewerElement){
  const shadow=element.shadowRoot
  if(!shadow)return()=>{}
  const navigation=new Set(['thumbnails','outline'])
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)')
  type Exit={id:string;panel:HTMLElement;parent:HTMLElement;left:number;top:number;width:number;height:number}
  const pending=new Map<HTMLElement,Exit>()
  const ghosts=new Map<HTMLElement,{animation:Animation;timer:number}>()
  let live=true,stopShell=()=>{}
  const removeGhost=(ghost:HTMLElement)=>{const entry=ghosts.get(ghost);ghosts.delete(ghost);if(entry){clearTimeout(entry.timer);entry.animation.cancel()}ghost.remove()}
  const clear=()=>{pending.clear();for(const ghost of [...ghosts.keys()])removeGhost(ghost)}
  const finishRemoved=()=>{
    for(const [panel,exit] of pending){
      if(panel.isConnected)continue
      pending.delete(panel)
      if(!live||reduced.matches||!exit.parent.isConnected)continue
      const ghost=document.createElement('div')
      ghost.dataset.studyNavigationExit=exit.id
      ghost.inert=true;ghost.setAttribute('aria-hidden','true')
      Object.assign(ghost.style,{position:'absolute',left:exit.left+'px',top:exit.top+'px',width:exit.width+'px',height:exit.height+'px',overflow:'hidden',pointerEvents:'none',userSelect:'none',zIndex:'41'})
      // Reusing the detached DOM retains already-decoded thumbnail pixels, with
      // none of the SDK's render subscriptions, handlers or focusable hitboxes.
      panel.removeAttribute('data-epdf-panel');panel.removeAttribute('id');panel.removeAttribute('role')
      panel.inert=true;panel.setAttribute('aria-hidden','true')
      panel.querySelector<HTMLElement>('[data-epdf-panel-header]')?.setAttribute('hidden','')
      Object.assign(panel.style,{position:'absolute',inset:'0',width:'100%',height:'100%',minWidth:'0',maxWidth:'none',margin:'0',transform:'none',translate:'none',transition:'none',pointerEvents:'none'})
      ghost.append(panel);exit.parent.append(ghost)
      const direction=getComputedStyle(exit.parent).direction==='rtl'?'100%':'-100%'
      const animation=ghost.animate([{transform:'translateX(0)',opacity:1},{transform:`translateX(${direction})`,opacity:0}],{duration:180,easing:'cubic-bezier(.22,.75,.25,1)',fill:'both'})
      const timer=window.setTimeout(()=>removeGhost(ghost),220)
      ghosts.set(ghost,{animation,timer})
      void animation.finished.then(()=>removeGhost(ghost),()=>removeGhost(ghost))
    }
  }
  const observer=new MutationObserver(finishRemoved)
  observer.observe(shadow,{childList:true,subtree:true})
  const stopWatch=viewer.watch(()=>viewer.tryGet('shell'),shell=>{
    stopShell();clear();stopShell=()=>{}
    if(!shell)return
    const closed=shell.onSurfaceClosed(({id})=>{
      if(!navigation.has(id))return
      clear()
      // A switch should immediately show the new panel, without an old overlay.
      if(reduced.matches||[...navigation].some(other=>other!==id&&shell.isOpen(other)))return
      const panel=shadow.querySelector<HTMLElement>(`[data-epdf-panel="${id}"]`),parent=panel?.parentElement
      if(!panel||!parent||typeof panel.animate!=='function')return
      const rect=panel.getBoundingClientRect(),base=parent.getBoundingClientRect()
      if(!rect.width||!rect.height)return
      if(panel.contains(shadow.activeElement)){
        const label=viewer.commands.resolveCommand('panel:'+id)?.label
        Array.from(shadow.querySelectorAll<HTMLButtonElement>('[part~="toolbar-main"] button')).find(button=>button.getAttribute('aria-label')===label)?.focus()
      }
      const scaleX=parent.offsetWidth?base.width/parent.offsetWidth:1,scaleY=parent.offsetHeight?base.height/parent.offsetHeight:1
      pending.set(panel,{id,panel,parent,left:(rect.left-base.left)/scaleX+parent.scrollLeft,top:(rect.top-base.top)/scaleY+parent.scrollTop,width:rect.width/scaleX,height:rect.height/scaleY})
      queueMicrotask(finishRemoved)
    })
    const opened=shell.onSurfaceOpened(clear)
    stopShell=()=>{closed();opened()}
  },{immediate:true})
  const resize=new ResizeObserver(clear)
  resize.observe(element)
  reduced.addEventListener('change',clear)
  return()=>{live=false;stopWatch();stopShell();observer.disconnect();resize.disconnect();reduced.removeEventListener('change',clear);clear()}
}

class ReaderBoundary extends Component<{children:ReactNode;onError?: (message:string)=>void;onFallback?:()=>void},{failed:boolean}>{
  state={failed:false}
  static getDerivedStateFromError(){return{failed:true}}
  componentDidCatch(error:Error,_info:ErrorInfo){this.props.onError?.(error.message||'阅读器暂时无法打开。')}
  render(){return this.state.failed?<div className="embed-pdf-reader-error" role="alert">阅读器暂时无法打开。{this.props.onFallback&&<button type="button" onClick={this.props.onFallback}>使用原阅读器</button>}</div>:this.props.children}
}
