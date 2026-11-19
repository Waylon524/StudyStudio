import {useEffect,useLayoutEffect,useRef,useState,type KeyboardEvent,type PointerEvent as ReactPointerEvent,type RefObject} from 'react'
import {createPortal} from 'react-dom'
import {Circle,Grip,Minus,MousePointer2,Pencil,Scan,Square,Trash2,Type} from 'lucide-react'
import type {PdfAnnotation,PdfMarkupColor,PdfRegion,PdfShapeAnnotation,PdfTextAnnotation} from '../shared/pdf-markup.mjs'
import {usePdfAnnotations} from './usePdfAnnotations'
import {usePdfMarkupInspector} from './usePdfMarkupInspector'
import './pdf-markup.css'

export type PdfRegionSelection={sourceId:string;page:number;region:PdfRegion}
type Tool='select'|'text'|'line'|'rectangle'|'ellipse'|'region'
type Point={x:number;y:number}
type MoveGesture={pointerId:number;tool:'move';clientStart:Point;pageWidth:number;pageHeight:number;annotation:PdfAnnotation}
type Gesture=MoveGesture|{pointerId:number;start:Point;tool:'line'|'rectangle'|'ellipse'|'region'}
type Props={courseId:string;sourceId:string;page:number;enabled:boolean;readOnly?:boolean;refreshRevision?:number;pageSize:{width:number;height:number}|null;sheetRef:RefObject<HTMLDivElement|null>;regionSelection?:PdfRegionSelection|null;onRegionSelectionChange?:(selection:PdfRegionSelection|null)=>void}
const colors:{id:PdfMarkupColor;label:string;value:string}[]=[{id:'black',label:'黑色',value:'#171717'},{id:'red',label:'红色',value:'#d52d29'},{id:'blue',label:'蓝色',value:'#245cdb'},{id:'yellow',label:'黄色',value:'#e9b818'},{id:'green',label:'绿色',value:'#27863c'},{id:'white',label:'白色',value:'#fff'}]
const colorValue=(color:PdfMarkupColor)=>colors.find(value=>value.id===color)?.value||'#171717'
const bound=(value:number,min=0,max=1)=>Math.min(max,Math.max(min,value))
const kindLabel=(kind:PdfAnnotation['kind'])=>({text:'文字',line:'直线',rectangle:'矩形',ellipse:'椭圆'})[kind]
function regionBetween(start:Point,end:Point):PdfRegion{return {x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y)}}
function translated(annotation:PdfAnnotation,dx:number,dy:number):PdfAnnotation{
  const xs=annotation.kind==='text'?[annotation.x]:[annotation.x,annotation.endX],ys=annotation.kind==='text'?[annotation.y]:[annotation.y,annotation.endY]
  dx=bound(dx,-Math.min(...xs),1-Math.max(...xs));dy=bound(dy,-Math.min(...ys),1-Math.max(...ys))
  return annotation.kind==='text'?{...annotation,x:annotation.x+dx,y:annotation.y+dy}:{...annotation,x:annotation.x+dx,y:annotation.y+dy,endX:annotation.endX+dx,endY:annotation.endY+dy}
}
function movedAnnotation(gesture:MoveGesture,event:{clientX:number;clientY:number}){
  const dx=event.clientX-gesture.clientStart.x,dy=event.clientY-gesture.clientStart.y
  if(Math.hypot(dx,dy)<4)return null
  return translated(gesture.annotation,dx/gesture.pageWidth,dy/gesture.pageHeight)
}
function Shape({annotation,width,height,hit=false}:{annotation:PdfShapeAnnotation;width:number;height:number;hit?:boolean}){
  const props={fill:'none',stroke:hit?'transparent':colorValue(annotation.color),strokeWidth:hit?Math.max(12,annotation.strokeWidth):annotation.strokeWidth,pointerEvents:hit?'stroke' as const:'none' as const}
  const x=annotation.x*width,y=annotation.y*height,endX=annotation.endX*width,endY=annotation.endY*height
  if(annotation.kind==='line')return <line x1={x} y1={y} x2={endX} y2={endY} {...props}/>
  if(annotation.kind==='ellipse')return <ellipse cx={(x+endX)/2} cy={(y+endY)/2} rx={Math.abs(endX-x)/2} ry={Math.abs(endY-y)/2} {...props}/>
  return <rect x={Math.min(x,endX)} y={Math.min(y,endY)} width={Math.abs(endX-x)} height={Math.abs(endY-y)} {...props}/>
}

function MarkupNumber({label,value,min,max,disabled,onCommit}:{label:string;value:number;min:number;max:number;disabled:boolean;onCommit:(value:number)=>void}){
  const [draft,setDraft]=useState(String(value)),focused=useRef(false)
  useEffect(()=>{if(!focused.current)setDraft(String(value))},[value])
  return <input aria-label={label} type="number" min={min} max={max} step={1} value={draft} disabled={disabled} onFocus={()=>{focused.current=true}} onChange={event=>setDraft(event.currentTarget.value)} onBlur={event=>{
    focused.current=false;const next=Number(event.currentTarget.value)
    if(event.currentTarget.value.trim()&&Number.isFinite(next)&&next>=min&&next<=max){setDraft(String(next));onCommit(next)}else setDraft(String(value))
  }} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur()}}}/>
}

export function PdfMarkup({courseId,sourceId,page,enabled,pageSize,sheetRef,regionSelection,onRegionSelectionChange,readOnly=false,refreshRevision}:Props){
  const {annotations,status,error,upsert,remove,retry}=usePdfAnnotations(courseId,sourceId,page,enabled,refreshRevision)
  const [tool,setTool]=useState<Tool>('select'),[color,setColor]=useState<PdfMarkupColor>('black'),[fontSize,setFontSize]=useState(16),[strokeWidth,setStrokeWidth]=useState(2)
  const [selectedId,setSelectedId]=useState<string|null>(null),[editingText,setEditingText]=useState<PdfTextAnnotation|null>(null),[moving,setMoving]=useState<PdfAnnotation|null>(null),[draftShape,setDraftShape]=useState<PdfShapeAnnotation|null>(null),[draftRegion,setDraftRegion]=useState<PdfRegion|null>(null)
  const panelRef=useRef<HTMLDivElement>(null),textSurfaceRef=useRef<HTMLDivElement>(null)
  const rootRef=useRef<HTMLDivElement>(null),menuTrigger=useRef<HTMLButtonElement>(null)
  const [menuOpen,setMenuOpen]=useState(false)
  const svgRef=useRef<SVGSVGElement>(null),gesture=useRef<Gesture|null>(null),composition=useRef(false),knownWrites=useRef(new Set<string>()),ignoreClick=useRef<string|null>(null)
  const editingRef=useRef(editingText);editingRef.current=editingText
  const interactive=!readOnly&&enabled&&status!=='loading'&&status!=='error'
  const sheet=sheetRef.current,width=pageSize?.width||1,height=pageSize?.height||1
  const selected=editingText?.id===selectedId?editingText:annotations.find(item=>item.id===selectedId)||null
  const displayAnnotations=annotations.map(item=>moving?.id===item.id?moving:editingText?.id===item.id?editingText:item)
  if(editingText&&!displayAnnotations.some(item=>item.id===editingText.id))displayAnnotations.push(moving?.id===editingText.id?moving:editingText)
  const activeColor=selected?.color||color
  const region=regionSelection?.sourceId===sourceId&&regionSelection.page===page?regionSelection.region:null
  usePdfMarkupInspector({rootRef,sheetRef,panelRef,selectedId,active:Boolean(enabled&&selected&&!menuOpen)})
  useLayoutEffect(()=>{
    const surface=textSurfaceRef.current
    if(!enabled||!sheet||!surface)return
    const update=()=>{surface.style.transform=`scale(${sheet.getBoundingClientRect().width/width})`}
    update();const observer=new ResizeObserver(update);observer.observe(sheet)
    return()=>observer.disconnect()
  },[enabled,sheet,width,height])

  function save(annotation:PdfAnnotation,debounce=false){
    if(annotation.kind==='text'&&!annotation.text.trim())return
    knownWrites.current.add(annotation.id);upsert(annotation,{debounce})
  }
  function flushText(note=editingRef.current){
    composition.current=false
    if(!note)return
    if(note.text.trim())save(note)
    else{
      if(annotations.some(item=>item.id===note.id)||knownWrites.current.has(note.id))remove(note.id)
      setEditingText(null);setSelectedId(value=>value===note.id?null:value)
    }
  }
  function commitFocusedInput(){
    const focused=document.activeElement
    if(focused instanceof HTMLElement&&(rootRef.current?.contains(focused)||textSurfaceRef.current?.contains(focused))&&focused.matches('input,textarea'))focused.blur()
  }
  function changeTool(next:Tool){
    commitFocusedInput();setMenuOpen(false);flushText();setEditingText(null);setSelectedId(null);setMoving(null);setDraftShape(null);setDraftRegion(null);gesture.current=null;setTool(next)
  }
  function select(annotation:PdfAnnotation){
    if(readOnly)return
    if(selectedId!==annotation.id)flushText()
    setMenuOpen(false);setSelectedId(annotation.id);setTool('select');setColor(annotation.color)
    if(annotation.kind==='text'){setEditingText(annotation);setFontSize(annotation.fontSize)}else{setEditingText(null);setStrokeWidth(annotation.strokeWidth)}
  }
  function updateText(text:string,composing=composition.current){
    const note=editingRef.current
    if(!note)return
    const next={...note,text};editingRef.current=next;setEditingText(next)
    if(!composing)save(next,true)
  }
  function patchSelected(patch:{color?:PdfMarkupColor;fontSize?:number;strokeWidth?:number}){
    if(!selected)return
    const next=selected.kind==='text'?{...selected,...(patch.color?{color:patch.color}:{}),...(patch.fontSize?{fontSize:patch.fontSize}:{})}:{...selected,...(patch.color?{color:patch.color}:{}),...(patch.strokeWidth?{strokeWidth:patch.strokeWidth}:{})}
    if(next.kind==='text'){editingRef.current=next;setEditingText(next)}
    save(next)
  }
  function deleteSelected(id=selectedId){
    if(!id)return
    remove(id);knownWrites.current.delete(id);setEditingText(null);setSelectedId(null);setMoving(null)
  }
  useEffect(()=>{
    if(!sheet)return
    const outside=(event:PointerEvent)=>{
      if(event.altKey||(event.target as Element)?.closest?.('[data-pdf-markup]'))return
      flushText();setEditingText(null);setSelectedId(null)
    }
    sheet.addEventListener('pointerdown',outside,true)
    return()=>sheet.removeEventListener('pointerdown',outside,true)
  },[sheet,annotations])
  useEffect(()=>()=>{gesture.current=null},[])
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{
      const target=event.target as Node|null
      if(!target||(event.altKey&&sheet?.contains(target))||rootRef.current?.contains(target)||svgRef.current?.contains(target)||textSurfaceRef.current?.contains(target))return
      if(target instanceof Element&&target.closest('.pdf-reader-footer,.pdf-reader-navigation,.studio-resizer.right')){
        commitFocusedInput()
        setMenuOpen(false)
        return
      }
      if(target instanceof HTMLDivElement&&target.classList.contains('pdf-reader-stage')){
        const {left,top}=target.getBoundingClientRect()
        if(event.clientX>=left+target.clientWidth||event.clientY>=top+target.clientHeight)return
      }
      changeTool('select')
    }
    document.addEventListener('pointerdown',outside,true)
    return()=>document.removeEventListener('pointerdown',outside,true)
  },[annotations])
  useEffect(()=>{
    if(!menuOpen)return
    const reader=rootRef.current?.closest('.pdf-reader')
    if(!reader)return
    const observer=new ResizeObserver(()=>{
      if(reader.clientWidth<650)return
      const focused=rootRef.current?.querySelector('.pdf-markup-tool-popover')?.contains(document.activeElement)
      setMenuOpen(false)
      if(focused)rootRef.current?.querySelector<HTMLButtonElement>('.pdf-markup-inline-tools button[aria-pressed="true"]')?.focus({preventScroll:true})
    })
    observer.observe(reader)
    return()=>observer.disconnect()
  },[menuOpen])
  function restoreToolFocus(){
    const trigger=menuTrigger.current
    if(trigger?.getClientRects().length)trigger.focus({preventScroll:true})
    else rootRef.current?.querySelector<HTMLButtonElement>('.pdf-markup-inline-tools button')?.focus({preventScroll:true})
  }

  function point(event:{clientX:number;clientY:number}):Point{
    const rect=svgRef.current!.getBoundingClientRect()
    return {x:bound((event.clientX-rect.left)/Math.max(1,rect.width)),y:bound((event.clientY-rect.top)/Math.max(1,rect.height))}
  }
  function start(event:ReactPointerEvent<SVGSVGElement>){
    if(!enabled||(tool!=='region'&&!interactive)||event.button!==0||tool==='select')return
    event.preventDefault();event.stopPropagation();svgRef.current?.focus({preventScroll:true})
    const start=point(event)
    if(tool==='text'){
      flushText()
      const note:PdfTextAnnotation={id:crypto.randomUUID(),kind:'text',...start,color,text:'',fontSize}
      editingRef.current=note;setEditingText(note);setSelectedId(note.id);setTool('select');return
    }
    gesture.current={pointerId:event.pointerId,start,tool}
    svgRef.current?.setPointerCapture(event.pointerId)
    if(tool==='region')setDraftRegion(regionBetween(start,start))
    else setDraftShape({id:crypto.randomUUID(),kind:tool,...start,endX:start.x,endY:start.y,color,strokeWidth})
  }
  function startMove(event:ReactPointerEvent<Element>,annotation:PdfAnnotation){
    if(!interactive||event.button!==0)return
    const layer=svgRef.current
    if(!layer)return
    event.preventDefault();event.stopPropagation()
    const rect=layer.getBoundingClientRect()
    // Defer opening the editor until pointerup so a click cannot resize the
    // reader midway through the gesture. Measure moves in physical pixels.
    gesture.current={pointerId:event.pointerId,tool:'move',annotation,
      clientStart:{x:event.clientX,y:event.clientY},pageWidth:Math.max(1,rect.width),pageHeight:Math.max(1,rect.height)}
    layer.setPointerCapture(event.pointerId)
  }
  function move(event:ReactPointerEvent<SVGSVGElement>){
    const current=gesture.current
    if(!current||current.pointerId!==event.pointerId)return
    event.preventDefault();event.stopPropagation()
    if(current.tool==='move'){
      setMoving(movedAnnotation(current,event))
      return
    }
    const end=point(event)
    if(current.tool==='region')setDraftRegion(regionBetween(current.start,end))
    else setDraftShape(shape=>shape?{...shape,endX:end.x,endY:end.y}:shape)
  }
  function finish(event:ReactPointerEvent<SVGSVGElement>){
    const current=gesture.current
    if(!current||current.pointerId!==event.pointerId)return
    event.preventDefault();event.stopPropagation()
    if(current.tool==='move'){
      const next=movedAnnotation(current,event)
      if(next){
        ignoreClick.current=next.id
        window.setTimeout(()=>{if(ignoreClick.current===next.id)ignoreClick.current=null},0)
        save(next)
      }
      select(next||current.annotation)
    }else{
      const end=point(event),rect=event.currentTarget.getBoundingClientRect()
      const moved=Math.hypot((end.x-current.start.x)*rect.width,(end.y-current.start.y)*rect.height)>=4
      if(current.tool==='region'){
        const region=regionBetween(current.start,end)
        if(region.width*rect.width>=4&&region.height*rect.height>=4)onRegionSelectionChange?.({sourceId,page,region})
      }else if(draftShape){
        let next={...draftShape,endX:end.x,endY:end.y}
        if(!moved||(current.tool!=='line'&&(Math.abs(end.x-current.start.x)*rect.width<4||Math.abs(end.y-current.start.y)*rect.height<4))){const x=Math.min(current.start.x,.8),y=Math.min(current.start.y,.88);next={...next,x,y,endX:x+.18,endY:current.tool==='line'?y:y+.1}}
        save(next);select(next)
      }
    }
    gesture.current=null;setMoving(null);setDraftShape(null);setDraftRegion(null);setTool('select')
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)
  }
  function cancel(event?:ReactPointerEvent<SVGSVGElement>){
    if(event&&gesture.current?.pointerId!==event.pointerId)return
    gesture.current=null;setMoving(null);setDraftShape(null);setDraftRegion(null)
  }
  function itemKey(event:KeyboardEvent<Element>,annotation:PdfAnnotation){
    if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();select(annotation)}
    else if(interactive&&(event.key==='Delete'||event.key==='Backspace')){event.preventDefault();event.stopPropagation();deleteSelected(annotation.id)}
    else if(interactive&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){
      event.preventDefault();event.stopPropagation();const step=event.shiftKey?10:1
      const next=translated(annotation,(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0)/width,(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0)/height)
      if(next.kind==='text'){editingRef.current=next;setEditingText(next)}save(next)
    }
  }
  const tools=[{id:'select',label:'选择文字',icon:MousePointer2},{id:'text',label:'添加文字标注',icon:Type},{id:'line',label:'画直线',icon:Minus},{id:'rectangle',label:'画矩形',icon:Square},{id:'ellipse',label:'画椭圆',icon:Circle},{id:'region',label:'框选区域',icon:Scan}] as const
  const overlay=enabled&&sheet&&pageSize?<svg ref={svgRef} className={'pdf-markup-layer'+(tool!=='select'&&enabled&&(tool==='region'||interactive)?' is-drawing':'')} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="group" aria-label="PDF 标注页面" tabIndex={tool==='select'?-1:0} data-pdf-markup="page" data-tool={tool} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();changeTool('select')}}}>
    {region&&<rect className="pdf-region-selection" data-pdf-region-selection="true" x={region.x*width} y={region.y*height} width={region.width*width} height={region.height*height} vectorEffect="non-scaling-stroke"/>}
    {displayAnnotations.filter((annotation):annotation is PdfShapeAnnotation=>annotation.kind!=='text').map(annotation=>{
      const active=annotation.id===selectedId
      return <g key={annotation.id} role="button" tabIndex={0} aria-label={`${kindLabel(annotation.kind)}标注`} aria-pressed={active} data-pdf-annotation={annotation.id} className={'pdf-markup-item'+(active?' is-selected':'')} onPointerDown={event=>startMove(event,annotation)} onClick={event=>{event.stopPropagation();if(ignoreClick.current===annotation.id){ignoreClick.current=null;return}select(annotation)}} onKeyDown={event=>itemKey(event,annotation)}>
        <Shape annotation={annotation} width={width} height={height}/><Shape annotation={annotation} width={width} height={height} hit/>
      </g>
    })}
    {draftShape&&<Shape annotation={draftShape} width={width} height={height}/>}
    {draftRegion&&<rect className="pdf-region-draft" x={draftRegion.x*width} y={draftRegion.y*height} width={draftRegion.width*width} height={draftRegion.height*height} vectorEffect="non-scaling-stroke"/>}
  </svg>:null
  const textNotes=enabled&&sheet&&pageSize?<div ref={textSurfaceRef} className={'pdf-markup-text-surface'+(tool!=='select'?' is-drawing':'')} data-pdf-markup="notes" style={{width,height}}>
    {displayAnnotations.filter((annotation):annotation is PdfTextAnnotation=>annotation.kind==='text').map(annotation=>{
      const active=annotation.id===selectedId,editing=active&&editingText?.id===annotation.id
      return <div key={annotation.id} role="group" tabIndex={editing?-1:0} aria-label={'文字标注'+(annotation.text?'：'+annotation.text.slice(0,60):'')} data-pdf-annotation={annotation.id} className={'pdf-markup-note'+(active?' is-selected':'')} style={{left:annotation.x*width,top:annotation.y*height,maxWidth:Math.max(1,(1-annotation.x)*width),fontSize:annotation.fontSize,color:colorValue(annotation.color)}} onClick={event=>{
        event.stopPropagation();if(event.target instanceof HTMLTextAreaElement)return
        if(ignoreClick.current===annotation.id){ignoreClick.current=null;return}select(annotation)
      }} onKeyDown={event=>{if(event.target===event.currentTarget)itemKey(event,annotation)}}>
        <div className={'pdf-markup-note-box'+(editing?' is-editing':'')} data-pdf-annotation-anchor="true">
          <span className="pdf-markup-note-mirror" aria-hidden={editing||undefined}>{(annotation.text||'输入文字…')+'\u200b'}</span>
          {editing&&<textarea autoFocus className="pdf-markup-inline-editor" aria-label="标注文字" placeholder="输入文字…" rows={1} maxLength={4000} value={annotation.text} disabled={!interactive} onChange={event=>updateText(event.currentTarget.value)} onCompositionStart={()=>{composition.current=true}} onCompositionEnd={event=>{composition.current=false;updateText(event.currentTarget.value,false)}} onBlur={event=>{const note=editingRef.current;if(note)flushText({...note,text:event.currentTarget.value})}}/>}
        </div>
        {active&&<button type="button" className="pdf-markup-note-move" aria-label="移动文字标注" title="拖动移动文字" onPointerDown={event=>startMove(event,annotation)} onClick={event=>event.stopPropagation()}><Grip size={12}/></button>}
      </div>
    })}
  </div>:null
  const toolButtons=tools.filter(tool=>!readOnly||tool.id==='select'||tool.id==='region').map(({id,label,icon:Icon})=><button key={id} type="button" className="pdf-markup-tool" aria-label={label} title={label} aria-pressed={tool===id} disabled={!enabled||(id!=='select'&&id!=='region'&&(status==='loading'||status==='error'))||(id==='region'&&!onRegionSelectionChange)} onClick={()=>{changeTool(id);restoreToolFocus()}}><Icon size={16}/></button>)
  const activeTool=tools.find(item=>item.id===tool)||tools[0],ActiveIcon=tool==='select'?Pencil:activeTool.icon
  const showInspector=Boolean(error||selected||tool==='text'||['line','rectangle','ellipse'].includes(tool))
  return <div ref={rootRef} className="pdf-markup" data-pdf-markup="tools" onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();changeTool('select');restoreToolFocus()}}}>
    <div className="pdf-markup-toolbar" role="toolbar" aria-label="PDF 标注工具" aria-busy={status==='saving'}>
      <div className="pdf-markup-inline-tools">{toolButtons}</div>
      <button ref={menuTrigger} type="button" className="pdf-markup-tool pdf-markup-menu-trigger" aria-label="标注工具" title={'标注工具：'+activeTool.label} aria-expanded={menuOpen} aria-pressed={tool!=='select'||Boolean(selected)} disabled={!enabled} onClick={()=>{commitFocusedInput();flushText();setMenuOpen(value=>!value)}}><ActiveIcon size={17}/></button>
      {menuOpen&&<div className="pdf-markup-tool-popover" role="group" aria-label="标注工具菜单">{toolButtons}</div>}
    </div>
    {showInspector&&!menuOpen&&<div ref={panelRef} className={'pdf-markup-inspector'+(selected?' is-anchored':'')} role="group" aria-label="批注参数">
      <div className="pdf-markup-parameters">
      <select aria-label="标注颜色" value={activeColor} disabled={!interactive} onChange={event=>{const next=event.target.value as PdfMarkupColor;setColor(next);patchSelected({color:next})}}>{colors.map(color=><option key={color.id} value={color.id}>{color.label}</option>)}</select>
      {(tool==='text'||selected?.kind==='text')&&<label className="pdf-markup-number">字号<MarkupNumber key={(selectedId||'new')+':font'} label="文字大小" min={8} max={96} value={selected?.kind==='text'?selected.fontSize:fontSize} disabled={!interactive} onCommit={value=>{setFontSize(value);patchSelected({fontSize:value})}}/></label>}
      {(['line','rectangle','ellipse'].includes(tool)||selected&&selected.kind!=='text')&&<label className="pdf-markup-number">线宽<MarkupNumber key={(selectedId||'new')+':stroke'} label="线宽" min={1} max={16} value={selected&&selected.kind!=='text'?selected.strokeWidth:strokeWidth} disabled={!interactive} onCommit={value=>{setStrokeWidth(value);patchSelected({strokeWidth:value})}}/></label>}
      {selected&&<button type="button" className="pdf-markup-tool pdf-markup-delete" aria-label="删除标注" title="删除标注" disabled={!interactive} onClick={()=>deleteSelected()}><Trash2 size={15}/></button>}
      </div>

    {error&&<div className="pdf-markup-error" role="alert"><span>{error}</span><button type="button" onClick={retry}>重试保存</button></div>}
    </div>}
    {overlay&&createPortal(overlay,sheet!)}
    {textNotes&&createPortal(textNotes,sheet!)}
  </div>
}
