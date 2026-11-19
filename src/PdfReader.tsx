/// <reference types="vite/client" />
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { ChevronLeft, ChevronRight, Download, ListTree, Maximize, Minus, PanelsTopLeft, Plus, X } from 'lucide-react'
import { resolvePdfDestinationPage, type PdfOutlineItem } from './pdf-navigation'
import {PdfMarkup,type PdfRegionSelection} from './PdfMarkup'
export type {PdfRegionSelection} from './PdfMarkup'
import './pdf-reader.css'

GlobalWorkerOptions.workerSrc = workerUrl

export type PdfReaderSource = { id:string; name:string; url:string }
export type PdfTextSelection = {sourceId:string;page:number;text:string}
export type PdfReaderProps = {
  courseId:string
  source:PdfReaderSource
  page:number
  onPageChange:(page:number)=>void
  onClose:()=>void
  onReaderError?:(message:string)=>void
  onTextSelectionChange?:(selection:PdfTextSelection|null)=>void
  textSelectionReset?:number
  onAskSelection?:()=>void
  onRegionSelectionChange?:(selection:PdfRegionSelection|null)=>void
  regionSelection?:PdfRegionSelection|null
  keyboardEnabled?:boolean
  annotationReadOnly?:boolean
  annotationUpdates?:{sourceId:string;page:number;revision:number}
}

/** A PDF owns its document, worker, canvases and pending callbacks for one lifetime. */
export function PdfReader(props:PdfReaderProps) {
  return <DocumentReader key={JSON.stringify([props.courseId,props.source.id,props.source.url])} {...props}/>
}

/** One canvas per render avoids overlapping PDF.js operations during fast page changes. */
function DocumentReader({courseId,source,page,onPageChange,onClose,onReaderError,onTextSelectionChange,textSelectionReset=0,onAskSelection,onRegionSelectionChange,regionSelection,keyboardEnabled=true,annotationReadOnly=false,annotationUpdates}:PdfReaderProps) {
  const [document,setDocument] = useState<PDFDocumentProxy|null>(null)
  const [pages,setPages] = useState(0)
  const [width,setWidth] = useState(0)
  const [zoom,setZoom] = useState(1)
  const [renderZoom,setRenderZoom] = useState(1)
  const [draft,setDraft] = useState(String(page || 1))
  const [renderedPage,setRenderedPage] = useState<number|null>(null)
  const [pageSize,setPageSize]=useState<{page:number;width:number;height:number}|null>(null)
  const [error,setError] = useState('')
  const [loading,setLoading] = useState(true)
  const [dragging,setDragging] = useState(false)
  const [navigation,setNavigation] = useState<'thumbnails'|'outline'|null>(null)
  const [outline,setOutline] = useState<PdfOutlineItem[]>([])
  const readerRef = useRef<HTMLElement>(null)
  const outlineRequest = useRef(0)
  const alive = useRef(true)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasHostRef = useRef<HTMLDivElement>(null)
  const textLayerHostRef = useRef<HTMLDivElement>(null)
  const textLayerRef = useRef<{page:number;width:number;task:TextLayer;node:HTMLDivElement}|null>(null)
  const reportedSelection = useRef<PdfTextSelection|null>(null)
  const selectionGesture = useRef<number|null>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const callbacks = useRef({onPageChange,onReaderError,onTextSelectionChange})
  const currentPage = useRef(page)
  const zoomRef = useRef(1)
  const fitWidthRef = useRef(0)
  const lastRender = useRef<{page:number;baseWidth:number;baseHeight:number;canvasWidth:number;canvasHeight:number}|null>(null)
  const dragRef = useRef<{pointerId:number;x:number;y:number;left:number;top:number;active:boolean}|null>(null)
  callbacks.current = {onPageChange,onReaderError,onTextSelectionChange}
  currentPage.current = page
  zoomRef.current = zoom

  // Invalidate synchronously on unmount, before old asynchronous work can report
  // an error or publish a canvas into the next document's UI.
  useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;disposeTextLayer()}},[])
  useEffect(()=>{setDraft(String(page || 1))},[page])
  useEffect(()=>{
    if(textLayerRef.current&&textLayerRef.current.page!==page)disposeTextLayer()
  },[page])
  useEffect(()=>{
    reportedSelection.current=null;selectionGesture.current=null
    const selection=window.getSelection(),host=textLayerHostRef.current
    if(selection&&host&&(host.contains(selection.anchorNode)||host.contains(selection.focusNode)))selection.removeAllRanges()
    // Clearing a parent-owned quote does not report another selection change.
  },[textSelectionReset])

  function disposeTextLayer(){
    textLayerRef.current?.task.cancel();textLayerRef.current=null
    textLayerHostRef.current?.replaceChildren()
  }
  function mountTextLayer(pdfPage:PDFPageProxy,viewport:ReturnType<PDFPageProxy['getViewport']>,current:number){
    const host=textLayerHostRef.current
    if(!host||textLayerRef.current?.page===current)return
    disposeTextLayer()
    const layer=window.document.createElement('div')
    layer.className='textLayer pdf-reader-text-layer'
    layer.dataset.pdfTextLayer='true';layer.dataset.sourceId=source.id;layer.dataset.page=String(current)
    layer.style.setProperty('--total-scale-factor',String(viewport.scale*viewport.userUnit))
    layer.style.setProperty('--scale-round-x','0.0001px');layer.style.setProperty('--scale-round-y','0.0001px')
    const task=new TextLayer({textContentSource:pdfPage.streamTextContent({includeMarkedContent:true,disableNormalization:true}),container:layer,viewport})
    host.style.width=`${viewport.width}px`;host.style.height=`${viewport.height}px`
    host.replaceChildren(layer)
    textLayerRef.current={page:current,width:viewport.width,task,node:layer}
    // A text layer is retained for this page across bitmap refreshes and scaled
    // from its committed viewport, preserving native ranges during zoom.
    void task.render().catch(()=>{/* Image-only/unreadable text must not hide a valid page bitmap. */})
  }
  function currentTextLayer(){
    const record=textLayerRef.current,stage=stageRef.current
    if(!record||record.page!==currentPage.current||lastRender.current?.page!==record.page||!stage||stage.closest('[inert],[aria-hidden="true"]')||record.node.closest('[hidden]')||!record.node.isConnected)return null
    return record.node
  }
  function readTextSelection():PdfTextSelection|null|undefined{
    const layer=currentTextLayer()
    if(!layer)return undefined
    const selection=window.getSelection()
    if(!selection||selection.isCollapsed||selection.rangeCount!==1)return null
    const range=selection.getRangeAt(0)
    if(!layer.contains(range.startContainer)||!layer.contains(range.endContainer))return null
    const text=selection.toString().replace(/\0/g,'').trim()
    return text?{sourceId:source.id,page:currentPage.current,text}:null
  }
  function reportTextSelection(explicit=false){
    if(!alive.current)return
    const next=readTextSelection(),previous=reportedSelection.current
    if(next===undefined||!next&&!explicit)return
    if(next?.sourceId===previous?.sourceId&&next?.page===previous?.page&&next?.text===previous?.text)return
    reportedSelection.current=next
    callbacks.current.onTextSelectionChange?.(next)
  }
  useEffect(()=>{
    const reader=readerRef.current,stage=stageRef.current
    if(!reader||!stage)return
    let timer:number|undefined
    const begin=(event:PointerEvent)=>{
      if(event.button!==0||event.altKey||!(event.target instanceof Node)||!stage.contains(event.target)||(event.target instanceof Element&&event.target.closest('[data-pdf-markup]')))return
      window.clearTimeout(timer);selectionGesture.current=event.pointerId
    }
    const end=(event:PointerEvent)=>{
      if(selectionGesture.current!==event.pointerId)return
      selectionGesture.current=null
      window.clearTimeout(timer);timer=window.setTimeout(()=>reportTextSelection(true),0)
    }
    const cancel=()=>{selectionGesture.current=null;window.clearTimeout(timer)}
    const keyboard=(event:KeyboardEvent)=>{
      if(!(event.target instanceof Node)||!stage.contains(event.target))return
      if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Escape','a','A'].includes(event.key))reportTextSelection(true)
    }
    const changed=()=>{
      if(selectionGesture.current!==null||!reader.contains(window.document.activeElement))return
      window.clearTimeout(timer)
      // Native keyboard/context-menu selections are reported after they settle;
      // collapsed ranges from external focus or layer replacement are ignored.
      timer=window.setTimeout(()=>reportTextSelection(),100)
    }
    reader.addEventListener('pointerdown',begin,true)
    window.addEventListener('pointerup',end,true);window.addEventListener('pointercancel',cancel,true)
    reader.addEventListener('keyup',keyboard,true);window.document.addEventListener('selectionchange',changed)
    return()=>{
      window.clearTimeout(timer);selectionGesture.current=null
      reader.removeEventListener('pointerdown',begin,true)
      window.removeEventListener('pointerup',end,true);window.removeEventListener('pointercancel',cancel,true)
      reader.removeEventListener('keyup',keyboard,true);window.document.removeEventListener('selectionchange',changed)
    }
  },[])

  useEffect(()=>{
    const stage=stageRef.current
    if(!stage) return
    let timer:number|undefined
    const update=()=>{
      const style=getComputedStyle(stage)
      const next=Math.max(0,Math.floor(stage.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)))
      fitWidthRef.current=next
      displayZoom(zoomRef.current)
      window.clearTimeout(timer)
      // Keep the bitmap responsive throughout panel/window transitions, then
      // ask PDF.js for one sharp copy after the available width settles.
      if(!lastRender.current)setWidth(previous=>previous===next?previous:next)
      else timer=window.setTimeout(()=>setWidth(previous=>previous===next?previous:next),120)
    }
    update()
    const observer=new ResizeObserver(update)
    observer.observe(stage)
    return ()=>{observer.disconnect();window.clearTimeout(timer)}
  },[])

  useEffect(()=>{
    const timer=window.setTimeout(()=>setRenderZoom(zoom),90)
    return()=>window.clearTimeout(timer)
  },[zoom])

  // Layout dimensions, rather than the transform alone, define the scrollable page.
  // This updates the existing bitmap immediately while PDF.js renders a sharper copy.
  function displayZoom(value:number,point?:{x:number;y:number}){
    const stage=stageRef.current,sheet=sheetRef.current,canvas=canvasHostRef.current?.querySelector('canvas'),rendered=lastRender.current
    if(!stage||!sheet||!canvas||!rendered)return
    const before=sheet.getBoundingClientRect()
    const anchor=point&&before.width&&before.height?{x:Math.max(0,Math.min(1,(point.x-before.left)/before.width)),y:Math.max(0,Math.min(1,(point.y-before.top)/before.height))}:null
    const fitWidth=fitWidthRef.current||rendered.baseWidth
    const displayWidth=fitWidth*value,displayHeight=rendered.baseHeight*(fitWidth/rendered.baseWidth)*value
    sheet.style.width=`${displayWidth}px`;sheet.style.height=`${displayHeight}px`
    canvas.style.transform=`scale(${displayWidth/rendered.canvasWidth})`
    const text=textLayerRef.current,host=textLayerHostRef.current
    if(text&&host&&text.page===rendered.page)host.style.transform=`scale(${displayWidth/text.width})`
    if(point&&anchor){
      const after=sheet.getBoundingClientRect()
      stage.scrollLeft+=after.left+after.width*anchor.x-point.x
      stage.scrollTop+=after.top+after.height*anchor.y-point.y
    }
  }
  function updateZoom(value:number,point?:{x:number;y:number}){
    const next=Math.min(3,Math.max(.5,Math.round(value*100)/100))
    if(next===zoomRef.current)return
    displayZoom(next,point)
    zoomRef.current=next;setZoom(next)
  }

  useEffect(()=>{
    const stage=stageRef.current
    if(!stage||!document)return
    const wheel=(event:WheelEvent)=>{
      const unit=event.deltaMode===1?16:event.deltaMode===2?stage.clientHeight:1
      if(event.shiftKey){
        event.preventDefault()
        stage.scrollBy({top:event.deltaY*unit,left:event.deltaX*unit,behavior:'instant'})
        return
      }
      if(!event.deltaY)return
      event.preventDefault()
      const delta=event.deltaY*unit
      updateZoom(zoomRef.current*Math.exp(-Math.max(-200,Math.min(200,delta))*.0025),{x:event.clientX,y:event.clientY})
    }
    stage.addEventListener('wheel',wheel,{passive:false})
    return()=>stage.removeEventListener('wheel',wheel)
  },[document])

  useEffect(()=>{
    let cancelled=false
    setDocument(null);setPages(0);setError('');setLoading(true);setRenderedPage(null);setZoom(1);setRenderZoom(1)
    zoomRef.current=1;lastRender.current=null;dragRef.current=null;setDragging(false)
    if(sheetRef.current){sheetRef.current.style.width='';sheetRef.current.style.height=''}
    canvasHostRef.current?.replaceChildren();disposeTextLayer()
    const task=getDocument({url:source.url,cMapUrl:'/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/pdfjs/standard_fonts/',wasmUrl:'/pdfjs/wasm/',iccUrl:'/pdfjs/iccs/'})
    task.promise.then(pdf=>{
      if(cancelled||!alive.current)return
      setDocument(pdf);setPages(pdf.numPages)
      const value=currentPage.current
      const requested=Number.isFinite(value)?Math.trunc(value):1
      const safe=Math.min(pdf.numPages,Math.max(1,requested))
      if(safe!==value)callbacks.current.onPageChange(safe)
    }).catch(err=>{
      if(cancelled||!alive.current)return
      const message='无法打开 PDF，请检查文件是否损坏或需要密码。'
      setError(message);setLoading(false);callbacks.current.onReaderError?.(message)
      console.warn('PDF reader load failed',err)
    })
    return ()=>{cancelled=true;void task.destroy().catch(()=>{})}
    // Changing page must not reopen the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[courseId,source.id,source.url])

  useEffect(()=>{
    let cancelled=false
    setOutline([]);setNavigation(null)
    if(document)void document.getOutline().then(items=>{
      if(!cancelled&&alive.current)setOutline(Array.isArray(items)?items:[])
    }).catch(()=>{})
    return()=>{cancelled=true}
  },[document])

  useEffect(()=>{
    if(!keyboardEnabled||!pages)return
    const handleKey=(event:KeyboardEvent)=>{
      if(event.defaultPrevented||event.isComposing||event.keyCode===229||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return
      const reader=readerRef.current,stage=stageRef.current
      if(!reader||!stage||!reader.getClientRects().length||stage.closest('[inert],[aria-hidden="true"]'))return
      const target=event.target
      if(target instanceof Element&&target.closest('[data-pdf-markup]'))return
      const selection=window.getSelection(),layer=currentTextLayer()
      if(layer&&selection&&!selection.isCollapsed&&selection.rangeCount===1){
        const range=selection.getRangeAt(0)
        if(layer.contains(range.startContainer)&&layer.contains(range.endContainer))return
      }
      const horizontal=event.key==='ArrowLeft'||event.key==='ArrowRight'
      if(horizontal&&target instanceof HTMLElement&&(
        target.isContentEditable||target.matches('textarea,input')
      ))return
      // Preserve arrows owned by page entry, native controls and modal UI.
      if(target instanceof Element&&target.closest('.pdf-reader-page-form,input:not([type="text"]):not([type="search"]),select,[role="separator"],[role="slider"],[role="spinbutton"],[role="combobox"],[aria-haspopup="menu"],[aria-haspopup="listbox"],[role="menu"],[role="menuitem"],[role="listbox"],[role="option"],[role="radiogroup"],[role="radio"]'))return
      if(Array.from(window.document.querySelectorAll<HTMLElement>('dialog[open],[aria-modal="true"]')).some(element=>element.getClientRects().length))return
      event.preventDefault();event.stopPropagation()
      if(horizontal){
        const current=Number.isFinite(currentPage.current)?Math.trunc(currentPage.current):1
        navigate(current+(event.key==='ArrowLeft'?-1:1))
      }else{
        const sheet=sheetRef.current,style=getComputedStyle(stage)
        const available=stage.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom)
        if(sheet&&sheet.offsetHeight>available+1&&stage.scrollHeight>stage.clientHeight+1){
          stage.scrollBy({top:(event.key==='ArrowUp'?-1:1)*Math.max(40,Math.min(100,stage.clientHeight*.15)),behavior:'instant'})
        }
      }
    }
    window.addEventListener('keydown',handleKey,true)
    return()=>window.removeEventListener('keydown',handleKey,true)
  },[keyboardEnabled,pages])

  async function navigateOutline(destination:PdfOutlineItem['dest']){
    if(!document||!destination)return
    const request=++outlineRequest.current
    try{
      const target=await resolvePdfDestinationPage(document,destination)
      if(target!==null&&request===outlineRequest.current&&alive.current)navigate(target)
    }catch{/* An invalid PDF bookmark must not interrupt page reading. */}
  }

  useEffect(()=>{
    if(!document||!pages||!width)return
    const current=Math.min(pages,Math.max(1,Number.isFinite(page)?Math.trunc(page):1))
    let cancelled=false
    let render:RenderTask|null=null
    setLoading(true);setError('')
    ;(async()=>{
      const pdfPage=await document.getPage(current)
      if(cancelled||!alive.current)return
      const natural=pdfPage.getViewport({scale:1})
      const scale=Math.max(0.05,width/natural.width)*renderZoom
      const viewport=pdfPage.getViewport({scale})
      const canvas=window.document.createElement('canvas')
      const maxPixels=16_000_000
      const outputScale=Math.min(window.devicePixelRatio||1,Math.sqrt(maxPixels/Math.max(1,viewport.width*viewport.height)),16384/Math.max(1,viewport.width),16384/Math.max(1,viewport.height))
      canvas.width=Math.max(1,Math.floor(viewport.width*outputScale))
      canvas.height=Math.max(1,Math.floor(viewport.height*outputScale))
      canvas.style.width=`${viewport.width}px`;canvas.style.height=`${viewport.height}px`
      canvas.setAttribute('role','img');canvas.setAttribute('aria-label',`${source.name}，第 ${current} 页`)
      const context=canvas.getContext('2d')
      if(!context)throw new Error('canvas unavailable')
      render=pdfPage.render({canvas,canvasContext:context,viewport,transform:[outputScale,0,0,outputScale,0,0]})
      await render.promise
      if(cancelled||!alive.current)return
      const previous=lastRender.current
      canvasHostRef.current?.replaceChildren(canvas)
      lastRender.current={page:current,baseWidth:viewport.width/renderZoom,baseHeight:viewport.height/renderZoom,canvasWidth:viewport.width,canvasHeight:viewport.height}
      try{mountTextLayer(pdfPage,viewport,current)}catch{/* Text extraction is optional; the committed bitmap stays usable. */}
      displayZoom(zoomRef.current)
      setPageSize(previous=>previous?.page===current&&previous.width===natural.width&&previous.height===natural.height?previous:{page:current,width:natural.width,height:natural.height})
      setRenderedPage(current);setLoading(false)
      window.requestAnimationFrame(()=>{
        if(cancelled||!alive.current)return
        const stage=stageRef.current
        if(!stage)return
        if(previous?.page!==current){stage.scrollTop=0;stage.scrollLeft=0}
      })
    })().catch(err=>{
      if(cancelled||!alive.current||err?.name==='RenderingCancelledException')return
      const message='这一页无法显示，请尝试重新打开文件。'
      setError(message);setLoading(false);callbacks.current.onReaderError?.(message)
      console.warn('PDF reader render failed',err)
    })
    return ()=>{cancelled=true;render?.cancel()}
  },[document,pages,page,width,renderZoom,source.name])

  const actualPage=Math.min(pages||1,Math.max(1,Number.isFinite(page)?Math.trunc(page):1))
  function navigate(next:number){
    if(!pages)return
    ++outlineRequest.current
    const safe=Math.min(pages,Math.max(1,Math.trunc(next)))
    setDraft(String(safe))
    if(safe!==currentPage.current){currentPage.current=safe;callbacks.current.onPageChange(safe)}
  }
  function submitPage(event:FormEvent){event.preventDefault();const value=Number(draft);if(!Number.isInteger(value)||value<1||value>pages){setDraft(String(actualPage));return}navigate(value)}
  function changeZoom(amount:number){
    const rect=stageRef.current?.getBoundingClientRect()
    updateZoom(zoomRef.current+amount,rect?{x:rect.left+rect.width/2,y:rect.top+rect.height/2}:undefined)
  }
  function startDrag(event:ReactPointerEvent<HTMLDivElement>){
    const stage=stageRef.current,sheet=sheetRef.current
    if(!stage||event.button!==0)return
    const target=event.target
    if(target instanceof Element&&target.closest('input,textarea,select,button,a,[data-pdf-markup],[contenteditable]:not([contenteditable="false"])'))return
    if(target instanceof Element&&target.closest('[data-pdf-text-layer]')&&!event.altKey){stage.focus({preventScroll:true});return}
    if(event.altKey)event.preventDefault()
    stage.focus({preventScroll:true})
    if(!sheet||!lastRender.current||!sheet.contains(target as Node))return
    dragRef.current={pointerId:event.pointerId,x:event.clientX,y:event.clientY,left:stage.scrollLeft,top:stage.scrollTop,active:false}
    stage.setPointerCapture(event.pointerId)
  }
  function moveDrag(event:ReactPointerEvent<HTMLDivElement>){
    const drag=dragRef.current,stage=stageRef.current
    if(!drag||!stage||drag.pointerId!==event.pointerId)return
    const dx=event.clientX-drag.x,dy=event.clientY-drag.y
    if(!drag.active&&Math.hypot(dx,dy)<3)return
    if(!drag.active){drag.active=true;setDragging(true)}
    event.preventDefault();stage.scrollLeft=drag.left-dx;stage.scrollTop=drag.top-dy
  }
  function endDrag(event:ReactPointerEvent<HTMLDivElement>){
    if(dragRef.current?.pointerId!==event.pointerId)return
    dragRef.current=null;setDragging(false)
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function toggleNavigation(mode:'thumbnails'|'outline',trigger:HTMLButtonElement){
    const panel=readerRef.current?.querySelector('.pdf-reader-navigation')
    if(panel?.contains(window.document.activeElement))trigger.focus({preventScroll:true})
    setNavigation(value=>value===mode?null:mode)
  }

  return <section className="pdf-reader" ref={readerRef} aria-label={`阅读 ${source.name}`}>
    <header className="pdf-reader-header">
      <strong className="pdf-reader-title" title={source.name}>{source.name}</strong>
      {onAskSelection&&<button type="button" className="pdf-reader-selection-ask" onPointerDown={event=>event.preventDefault()} onClick={onAskSelection}>{regionSelection?.sourceId===source.id&&regionSelection.page===actualPage?'用选区提问':'用选中文字提问'}</button>}
      <a className="pdf-reader-icon" href={source.url} download={source.name} aria-label={`下载 ${source.name}`} title={`下载 ${source.name}`}><Download size={17}/></a>
      <button type="button" className="pdf-reader-icon" onClick={onClose} aria-label="关闭阅读器" title="关闭阅读器"><X size={18}/></button>
    </header>
    <div className="pdf-reader-body">
      {document&&<ReaderNavigation mode={navigation} document={document} pages={pages} currentPage={actualPage} outline={outline} onNavigate={navigate} onNavigateOutline={navigateOutline}/>}
    <div className={'pdf-reader-stage' +(dragging?' is-dragging':'')} ref={stageRef} tabIndex={0} aria-label="课件页面" aria-busy={loading} title="拖选文字，空白处或按住 Option 拖动平移；左右键翻页，上下键滚动，滚轮缩放" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
      {loading && <div className="pdf-reader-status" role="status">正在加载页面…</div>}
      {error && <div className="pdf-reader-status pdf-reader-error" role="alert">{error}</div>}
      <div className="pdf-reader-canvas" hidden={renderedPage===null || !!error} inert={renderedPage!==actualPage} aria-hidden={renderedPage!==actualPage||undefined}><div className="pdf-reader-sheet" ref={sheetRef}><div className="pdf-reader-canvas-host" ref={canvasHostRef}/><div className="pdf-reader-text-layer-host" ref={textLayerHostRef}/></div></div>
    </div>
    </div>
    <footer className="pdf-reader-footer" aria-label="课件阅读控制">
      <div className="pdf-reader-navigation-tools">
        <button type="button" className="pdf-reader-icon" aria-label="页面缩略图" title="页面缩略图" aria-expanded={navigation==='thumbnails'} disabled={!document} onClick={event=>toggleNavigation('thumbnails',event.currentTarget)}><PanelsTopLeft size={16}/></button>
        {outline.length>0&&<button type="button" className="pdf-reader-icon" aria-label="PDF 目录" title="PDF 目录" aria-expanded={navigation==='outline'} onClick={event=>toggleNavigation('outline',event.currentTarget)}><ListTree size={16}/></button>}
      </div>
      <div className="pdf-reader-pagination">
        <button type="button" className="pdf-reader-icon" disabled={!pages||actualPage<=1} onClick={()=>navigate(actualPage-1)} aria-label="上一页" title="上一页"><ChevronLeft size={17}/></button>
        <form onSubmit={submitPage} className="pdf-reader-page-form" style={{'--pdf-page-number-width':String(pages||1).length+'ch'} as CSSProperties}><label htmlFor="pdf-reader-page">第</label><input id="pdf-reader-page" aria-label="页码" type="number" inputMode="numeric" min={1} max={pages||1} disabled={!pages} value={draft} onChange={e=>setDraft(e.target.value)} onBlur={()=>setDraft(String(actualPage))}/><span>/ {pages||'–'}<span className="pdf-reader-page-unit"> 页</span></span></form>
        <button type="button" className="pdf-reader-icon" disabled={!pages||actualPage>=pages} onClick={()=>navigate(actualPage+1)} aria-label="下一页" title="下一页"><ChevronRight size={17}/></button>
      </div>
    <PdfMarkup key={source.id+':'+actualPage} courseId={courseId} sourceId={source.id} page={actualPage} readOnly={annotationReadOnly} refreshRevision={annotationUpdates?.sourceId===source.id&&annotationUpdates.page===actualPage?annotationUpdates.revision:undefined} enabled={renderedPage===actualPage&&!error&&pageSize?.page===actualPage} pageSize={pageSize?.page===actualPage?pageSize:null} sheetRef={sheetRef} regionSelection={regionSelection} onRegionSelectionChange={onRegionSelectionChange}/>
      <div className="pdf-reader-zoom">
        <button type="button" className="pdf-reader-icon" onClick={()=>changeZoom(-.1)} disabled={!document||zoom<=.5} aria-label="缩小" title="缩小"><Minus size={16}/></button>
        <span aria-label={`缩放 ${Math.round(zoom*100)}%`}>{Math.round(zoom*100)}%</span>
        <button type="button" className="pdf-reader-icon" onClick={()=>changeZoom(.1)} disabled={!document||zoom>=3} aria-label="放大" title="放大"><Plus size={16}/></button>
        <button type="button" className="pdf-reader-icon" onClick={()=>updateZoom(1)} disabled={!document} aria-label="适合宽度" title="适合宽度"><Maximize size={15}/></button>
      </div>
    </footer>
  </section>
}



const navigationTransitionMs=240
function useReducedReaderMotion(){
  const [reduced,setReduced]=useState(()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(()=>{
    const media=window.matchMedia('(prefers-reduced-motion: reduce)'),changed=()=>setReduced(media.matches)
    media.addEventListener('change',changed)
    return()=>media.removeEventListener('change',changed)
  },[])
  return reduced
}
function useReaderPresence(open:boolean,reduced:boolean,animateMount=false){
  const [present,setPresent]=useState(open),[visible,setVisible]=useState(open&&!animateMount)
  useLayoutEffect(()=>{
    if(open){
      setPresent(true)
      if(reduced){setVisible(true);return}
      let frame=window.requestAnimationFrame(()=>{frame=window.requestAnimationFrame(()=>setVisible(true))})
      return()=>window.cancelAnimationFrame(frame)
    }
    setVisible(false)
    if(!present)return
    if(reduced){setPresent(false);return}
    const timer=window.setTimeout(()=>setPresent(false),navigationTransitionMs)
    return()=>window.clearTimeout(timer)
  },[open,reduced,present])
  return {present,visible}
}
type NavigationMode='thumbnails'|'outline'|null
function ReaderNavigation({mode,document,pages,currentPage,outline,onNavigate,onNavigateOutline}:{mode:NavigationMode;document:PDFDocumentProxy;pages:number;currentPage:number;outline:PdfOutlineItem[];onNavigate:(page:number)=>void;onNavigateOutline:(destination:PdfOutlineItem['dest'])=>void}){
  const reduced=useReducedReaderMotion(),open=mode!==null,{present,visible}=useReaderPresence(open,reduced),lastMode=useRef(mode)
  if(mode)lastMode.current=mode
  if(!present)return null
  return <aside className={'pdf-reader-navigation'+(visible?' is-open':'')} aria-label={lastMode.current==='thumbnails'?'页面缩略图':'PDF 目录'} aria-hidden={!open||undefined} inert={!open}>
    <div className="pdf-reader-navigation-content">
      <NavigationPane open={mode==='thumbnails'} reduced={reduced} mode="thumbnails"><PageThumbnails document={document} pages={pages} currentPage={currentPage} active={mode==='thumbnails'} onNavigate={onNavigate}/></NavigationPane>
      <NavigationPane open={mode==='outline'} reduced={reduced} mode="outline"><nav className="pdf-reader-outline" aria-label="PDF 目录条目"><OutlineItems items={outline} onNavigate={onNavigateOutline} reduced={reduced}/></nav></NavigationPane>
    </div>
  </aside>
}
function NavigationPane({open,reduced,mode,children}:{open:boolean;reduced:boolean;mode:Exclude<NavigationMode,null>;children:ReactNode}){
  const {present,visible}=useReaderPresence(open,reduced,true)
  if(!present)return null
  return <div className={'pdf-reader-navigation-pane'+(visible?' is-visible':'')} data-mode={mode} aria-hidden={!open||undefined} inert={!open}>{children}</div>
}

/** Only pages near the panel viewport own canvases or active render tasks. */
function PageThumbnails({document,pages,currentPage,active,onNavigate}:{document:PDFDocumentProxy;pages:number;currentPage:number;active:boolean;onNavigate:(page:number)=>void}){
  const root=useRef<HTMLDivElement>(null),activeRef=useRef(active)
  activeRef.current=active
  const [visible,setVisible]=useState<Set<number>>(new Set())
  useEffect(()=>{
    const panel=root.current
    if(!panel||!active)return
    let cancelled=false
    const observer=new IntersectionObserver(entries=>{
      if(cancelled||!activeRef.current)return
      setVisible(previous=>{
        const next=new Set(previous)
        for(const entry of entries){const page=Number((entry.target as HTMLElement).dataset.page);if(entry.isIntersecting)next.add(page);else next.delete(page)}
        return next
      })
    },{root:panel,rootMargin:'160px 0px'})
    for(const button of panel.querySelectorAll('[data-page]'))observer.observe(button)
    // Freeze the existing previews during exit; their canvases and active
    // tasks are released only when the departing pane actually unmounts.
    return()=>{cancelled=true;observer.disconnect()}
  },[pages,active])
  useEffect(()=>{
    if(active)root.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'})
  },[currentPage,active])
  return <div className="pdf-reader-thumbnails" ref={root}>
    {Array.from({length:pages},(_,index)=>index+1).map(page=><button key={page} type="button" className="pdf-reader-thumbnail" data-page={page} aria-label={`转到第 ${page} 页`} aria-current={page===currentPage?'page':undefined} onClick={()=>onNavigate(page)}><Thumbnail document={document} page={page} visible={visible.has(page)}/><span>{page}</span></button>)}
  </div>
}

function Thumbnail({document,page,visible}:{document:PDFDocumentProxy;page:number;visible:boolean}){
  const preview=useRef<HTMLSpanElement>(null),host=useRef<HTMLSpanElement>(null)
  const [aspect,setAspect]=useState<number|null>(null)
  useEffect(()=>{
    let cancelled=false,render:RenderTask|null=null
    const target=host.current
    if(!target)return
    target.replaceChildren()
    if(visible)void(async()=>{
      const pdfPage=await document.getPage(page)
      if(cancelled)return
      const natural=pdfPage.getViewport({scale:1})
      setAspect(natural.width/natural.height)
      const width=preview.current?.getBoundingClientRect().width||116
      const viewport=pdfPage.getViewport({scale:width/natural.width})
      const canvas=window.document.createElement('canvas')
      const ratio=Math.min(2,window.devicePixelRatio||1,Math.sqrt(1_000_000/Math.max(1,viewport.width*viewport.height)),8192/Math.max(1,viewport.width),8192/Math.max(1,viewport.height))
      canvas.width=Math.max(1,Math.ceil(viewport.width*ratio));canvas.height=Math.max(1,Math.ceil(viewport.height*ratio))
      canvas.style.width='100%';canvas.style.height='100%';canvas.setAttribute('aria-hidden','true')
      const context=canvas.getContext('2d')
      if(!context)return
      render=pdfPage.render({canvas,canvasContext:context,viewport,transform:[ratio,0,0,ratio,0,0]})
      await render.promise
      if(!cancelled)target.replaceChildren(canvas)
    })().catch(()=>{})
    return()=>{cancelled=true;render?.cancel();target.replaceChildren()}
  },[document,page,visible])
  return <span className="pdf-reader-thumbnail-preview" ref={preview} style={aspect?{aspectRatio:String(aspect)}:undefined}><span ref={host}/></span>
}

function OutlineItems({items,onNavigate,reduced,depth=0}:{items:PdfOutlineItem[];onNavigate:(destination:PdfOutlineItem['dest'])=>void;reduced:boolean;depth?:number}){
  return <ul>{items.map((item,index)=><OutlineBranch key={index} item={item} onNavigate={onNavigate} reduced={reduced} depth={depth}/>)}</ul>
}
function OutlineBranch({item,onNavigate,reduced,depth}:{item:PdfOutlineItem;onNavigate:(destination:PdfOutlineItem['dest'])=>void;reduced:boolean;depth:number}){
  const [expanded,setExpanded]=useState(depth===0),childrenId=useId()
  const children=Array.isArray(item.items)?item.items:[]
  return <li><div className="pdf-reader-outline-row">
    {children.length>0?<button type="button" className="pdf-reader-outline-toggle" aria-label={`${expanded?'收起':'展开'} ${item.title}`} aria-expanded={expanded} aria-controls={childrenId} onClick={()=>setExpanded(value=>!value)}><ChevronRight size={13} className={expanded?'is-expanded':undefined}/></button>:<span className="pdf-reader-outline-spacer"/>}
    <button type="button" className="pdf-reader-outline-link" disabled={!item.dest} onClick={()=>onNavigate(item.dest)} title={item.title}>{item.title||'未命名书签'}</button>
  </div>{children.length>0&&<OutlineChildren open={expanded} reduced={reduced} id={childrenId}><OutlineItems items={children} onNavigate={onNavigate} reduced={reduced} depth={depth+1}/></OutlineChildren>}</li>
}
function OutlineChildren({open,reduced,id,children}:{open:boolean;reduced:boolean;id:string;children:ReactNode}){
  const {present,visible}=useReaderPresence(open,reduced)
  if(!present)return null
  return <div id={id} className={'pdf-reader-outline-children'+(visible?' is-open':'')} aria-hidden={!open||undefined} inert={!open}><div>{children}</div></div>
}
