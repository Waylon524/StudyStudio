import {useEffect,useRef,useState} from 'react'
import type {CSSProperties} from 'react'
import {Bookmark,Check,Maximize2,Minimize2,PanelRight,RotateCcw} from 'lucide-react'
import {SandboxedHtmlFrame,buildCanvasDocument,type CanvasReport} from './SandboxedHtmlFrame'
import './teaching-canvas.css'

export {buildCanvasDocument}

type CanvasSpec={id:string;title:string;html:string;height?:number}
type Props={canvas:CanvasSpec;onSave?:()=>Promise<void>;saved?:boolean;onReport?:(report:CanvasReport)=>void;onOpenInReader?:()=>void}

export function TeachingCanvas({canvas,onSave,saved=false,onReport,onOpenInReader}:Props){
  const expandButton=useRef<HTMLButtonElement>(null),shell=useRef<HTMLDivElement>(null),container=useRef<HTMLElement>(null)
  const [run,setRun]=useState(0),[expanded,setExpanded]=useState(false),[saving,setSaving]=useState(false),[localSaved,setLocalSaved]=useState(saved)
  const [saveError,setSaveError]=useState('')
  const height=Number.isInteger(canvas.height)?Math.min(900,Math.max(240,canvas.height!)):420
  const [placeholderHeight,setPlaceholderHeight]=useState(height+45)

  useEffect(()=>{setLocalSaved(saved);setSaveError('')},[saved,canvas.id,canvas.html])
  useEffect(()=>{
    if(!expanded)return
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null,overflow=document.body.style.overflow
    document.body.style.overflow='hidden';expandButton.current?.focus()
    const keydown=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();setExpanded(false)}}
    window.addEventListener('keydown',keydown,true)
    return()=>{document.body.style.overflow=overflow;window.removeEventListener('keydown',keydown,true);previous?.focus()}
  },[expanded])

  function toggleExpanded(){if(!expanded)setPlaceholderHeight(container.current?.getBoundingClientRect().height||height+45);setExpanded(value=>!value)}
  function openInReader(){if(expanded)setExpanded(false);onOpenInReader?.()}
  async function save(){if(!onSave||localSaved||saving)return;setSaving(true);setSaveError('');try{await onSave();setLocalSaved(true)}catch(error){setSaveError(error instanceof Error?error.message:'画布暂时无法保存，请重试。')}finally{setSaving(false)}}
  function focusEdge(last=false){const controls=shell.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');const target=last?controls?.[controls.length-1]:controls?.[0];target?.focus()}
  const style={'--teaching-canvas-height':height+'px',...(expanded?{height:placeholderHeight}:{})} as CSSProperties
  return <section className="teaching-canvas" ref={container} style={style} data-canvas-id={canvas.id}>
    {expanded&&<div className="teaching-canvas-backdrop" onClick={()=>setExpanded(false)}/>}
    <div className={'teaching-canvas-shell'+(expanded?' is-expanded':'')} ref={shell} role={expanded?'dialog':undefined} aria-modal={expanded||undefined} aria-label={expanded?canvas.title:undefined}>
      {expanded&&<span tabIndex={0} className="sr-only" onFocus={()=>focusEdge(true)}/>}
      <header className="teaching-canvas-toolbar"><strong title={canvas.title}>{canvas.title}</strong><div className="teaching-canvas-actions">
        {(onSave||localSaved)&&<button type="button" className="teaching-canvas-save" onClick={()=>void save()} disabled={localSaved||saving} aria-label={localSaved?'画布已保存':saving?'正在保存画布':'保存到练习'}>{localSaved?<Check size={14}/>:<Bookmark size={14}/>}<span>{localSaved?'已保存':saving?'保存中…':'保存到练习'}</span></button>}
        {onOpenInReader&&<button type="button" className="teaching-canvas-reader-btn" onClick={openInReader} aria-label="在右侧 HTML 阅读器中打开" title="在右侧 HTML 阅读器中打开"><PanelRight size={14}/><span>右侧打开</span></button>}
        <button type="button" className="teaching-canvas-icon" onClick={()=>setRun(value=>value+1)} aria-label="重新运行动画" title="重新运行"><RotateCcw size={15}/></button>
        <button type="button" ref={expandButton} className="teaching-canvas-icon" onClick={toggleExpanded} aria-label={expanded?'收起画布':'放大画布'} title={expanded?'收起画布':'放大画布'}>{expanded?<Minimize2 size={15}/>:<Maximize2 size={15}/>}</button>
      </div></header>
      <SandboxedHtmlFrame
        html={canvas.html}
        title={canvas.title}
        runKey={run}
        mode="canvas"
        forceActive={expanded}
        onReport={onReport}
        onEscapeClose={()=>setExpanded(false)}
        onRetry={()=>setRun(value=>value+1)}
      />
      {saveError&&<p className="teaching-canvas-save-error" role="alert">{saveError}</p>}
      {expanded&&<span tabIndex={0} className="sr-only" onFocus={()=>focusEdge()}/>}
    </div>
  </section>
}
