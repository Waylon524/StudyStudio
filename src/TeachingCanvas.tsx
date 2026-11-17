import {useEffect,useMemo,useRef,useState} from 'react'
import type {CSSProperties} from 'react'
import {Bookmark,Check,Maximize2,Minimize2,RotateCcw} from 'lucide-react'
import './teaching-canvas.css'

type CanvasSpec={id:string;title:string;html:string;height?:number}
type CanvasReport={label:string;value?:string}
type Props={canvas:CanvasSpec;onSave?:()=>Promise<void>;saved?:boolean;onReport?:(report:CanvasReport)=>void}

const policy="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'"
const safeJSON=(value:unknown)=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029')

// Only this isolated document executes the authored content. The host renders
// no authored HTML, evaluates no authored scripts, and grants no app origin.
export function buildCanvasDocument(canvas:CanvasSpec,token:string){
  const bootstrap=`(()=>{
    const token=${safeJSON(token)};
    for(const key of ['RTCPeerConnection','webkitRTCPeerConnection']){try{Object.defineProperty(window,key,{value:undefined,writable:false,configurable:false})}catch{}}
    const send=(type,detail={})=>parent.postMessage({source:'study-canvas',token,type,...detail},'*');
    addEventListener('error',event=>send('error',{message:String(event.message||'动画运行失败').slice(0,1000)}));
    addEventListener('unhandledrejection',event=>send('error',{message:String(event.reason?.message||event.reason||'动画运行失败').slice(0,1000)}));
    addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();send('close')}});
    let reportTimer;
    function report(event){
      if(!event.isTrusted||!(event.target instanceof Element))return;
      const el=event.target.closest('input,select,textarea,button,[data-study-label],canvas,svg');
      if(!el)return;
      const label=el.getAttribute('data-study-label')||el.getAttribute('aria-label')||el.labels?.[0]?.textContent||el.name||el.id||el.textContent||el.tagName.toLowerCase();
      let value;
      if(el instanceof HTMLInputElement)value=el.type==='checkbox'||el.type==='radio'?String(el.checked):el.value;
      else if(el instanceof HTMLSelectElement||el instanceof HTMLTextAreaElement)value=el.value;
      else if(event.type==='pointerup'&&(el.tagName.toLowerCase()==='canvas'||el.tagName.toLowerCase()==='svg')){const rect=el.getBoundingClientRect();value='x='+Math.round(event.clientX-rect.left)+', y='+Math.round(event.clientY-rect.top)}
      clearTimeout(reportTimer);reportTimer=setTimeout(()=>send('report',{label:String(label).trim().slice(0,120),...(value===undefined?{}:{value:String(value).slice(0,1000)})}),600);
    }
    for(const name of ['input','change','click','pointerup'])document.addEventListener(name,report,true);
    const nativeRAF=requestAnimationFrame.bind(window),nativeCancel=cancelAnimationFrame.bind(window),pending=new Map();
    let active=true,nextFrame=1;
    function schedule(id,entry){entry.native=nativeRAF(time=>{entry.native=null;if(!active)return;pending.delete(id);entry.callback(time)})}
    window.requestAnimationFrame=callback=>{const id=nextFrame++,entry={callback,native:null};pending.set(id,entry);if(active)schedule(id,entry);return id};
    window.cancelAnimationFrame=id=>{const entry=pending.get(id);if(entry&&entry.native!==null)nativeCancel(entry.native);pending.delete(id)};
    addEventListener('message',event=>{
      if(event.source!==parent||event.data?.source!=='study-canvas-host'||event.data?.token!==token)return;
      if(event.data.type!=='visibility')return;
      const next=event.data.active===true;if(next===active)return;active=next;
      document.documentElement.classList.toggle('study-canvas-paused',!active);
      for(const [id,entry] of pending){if(active)schedule(id,entry);else if(entry.native!==null){nativeCancel(entry.native);entry.native=null}}
    });
    const ready=()=>send('ready');if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
  })();`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html{color-scheme:light;background:#fff;color:#383633;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}body{margin:0;padding:16px;box-sizing:border-box;min-height:100vh}*,*::before,*::after{box-sizing:border-box}canvas,svg,img{max-width:100%}button,input,select,textarea{font:inherit}button{cursor:pointer}:focus-visible{outline:2px solid #ad8d79;outline-offset:3px}.study-canvas-paused *, .study-canvas-paused *::before,.study-canvas-paused *::after{animation-play-state:paused!important}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}</style><script>${bootstrap}</script></head><body>${canvas.html}</body></html>`
}

export function TeachingCanvas({canvas,onSave,saved=false,onReport}:Props){
  const iframe=useRef<HTMLIFrameElement>(null),expandButton=useRef<HTMLButtonElement>(null),shell=useRef<HTMLDivElement>(null),container=useRef<HTMLElement>(null)
  const callbacks=useRef({onReport});callbacks.current={onReport}
  const [run,setRun]=useState(0),[expanded,setExpanded]=useState(false),[saving,setSaving]=useState(false),[localSaved,setLocalSaved]=useState(saved)
  const [loading,setLoading]=useState(true),[runtimeError,setRuntimeError]=useState(''),[saveError,setSaveError]=useState('')
  const token=useMemo(()=>crypto.randomUUID(),[canvas.id,canvas.html,run])
  const source=useMemo(()=>buildCanvasDocument(canvas,token),[canvas.html,token])
  const height=Number.isInteger(canvas.height)?Math.min(900,Math.max(240,canvas.height!)):420
  const [placeholderHeight,setPlaceholderHeight]=useState(height+45)
  const visibility=useRef(true),lastReportAt=useRef(0)
  const sendVisibility=()=>iframe.current?.contentWindow?.postMessage({source:'study-canvas-host',token,type:'visibility',active:!document.hidden&&(expanded||visibility.current)},'*')

  useEffect(()=>{setLocalSaved(saved);setSaveError('')},[saved,canvas.id,canvas.html])
  useEffect(()=>{
    setLoading(true);setRuntimeError('')
    const timeout=window.setTimeout(()=>{setLoading(false);setRuntimeError('动画暂时无法打开，请重新运行。')},12000)
    const receive=(event:MessageEvent)=>{
      if(event.source!==iframe.current?.contentWindow||event.data?.source!=='study-canvas'||event.data?.token!==token)return
      const data=event.data
      if(data.type==='ready'){clearTimeout(timeout);setLoading(false);sendVisibility()}
      else if(data.type==='error'){clearTimeout(timeout);setLoading(false);setRuntimeError('动画运行遇到问题，请重新运行。')}
      else if(data.type==='close')setExpanded(false)
      else if(data.type==='report'&&typeof data.label==='string'&&data.label.trim()&&data.label.length<=120&&(data.value===undefined||typeof data.value==='string'&&data.value.length<=1000)){const now=Date.now();if(now-lastReportAt.current<600)return;lastReportAt.current=now;callbacks.current.onReport?.({label:data.label,...(data.value===undefined?{}:{value:data.value})})}
    }
    window.addEventListener('message',receive)
    return()=>{clearTimeout(timeout);window.removeEventListener('message',receive)}
  },[token])
  useEffect(()=>{
    const observer=new IntersectionObserver(entries=>{visibility.current=Boolean(entries[0]?.isIntersecting);sendVisibility()},{threshold:0})
    if(container.current)observer.observe(container.current)
    document.addEventListener('visibilitychange',sendVisibility)
    sendVisibility()
    return()=>{observer.disconnect();document.removeEventListener('visibilitychange',sendVisibility)}
  },[expanded,token])
  useEffect(()=>{
    if(!expanded)return
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null,overflow=document.body.style.overflow
    document.body.style.overflow='hidden';expandButton.current?.focus()
    const keydown=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();setExpanded(false)}}
    window.addEventListener('keydown',keydown,true)
    return()=>{document.body.style.overflow=overflow;window.removeEventListener('keydown',keydown,true);previous?.focus()}
  },[expanded])
  function toggleExpanded(){if(!expanded)setPlaceholderHeight(container.current?.getBoundingClientRect().height||height+45);setExpanded(value=>!value)}
  async function save(){if(!onSave||localSaved||saving)return;setSaving(true);setSaveError('');try{await onSave();setLocalSaved(true)}catch(error){setSaveError(error instanceof Error?error.message:'画布暂时无法保存，请重试。')}finally{setSaving(false)}}
  function focusEdge(last=false){const controls=shell.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');const target=last?controls?.[controls.length-1]:controls?.[0];target?.focus()}
  const style={'--teaching-canvas-height':height+'px',...(expanded?{height:placeholderHeight}: {})} as CSSProperties
  return <section className="teaching-canvas" ref={container} style={style} data-canvas-id={canvas.id}>
    {expanded&&<div className="teaching-canvas-backdrop" onClick={()=>setExpanded(false)}/>}
    <div className={'teaching-canvas-shell'+(expanded?' is-expanded':'')} ref={shell} role={expanded?'dialog':undefined} aria-modal={expanded||undefined} aria-label={expanded?canvas.title:undefined}>
      {expanded&&<span tabIndex={0} className="sr-only" onFocus={()=>focusEdge(true)}/>}
      <header className="teaching-canvas-toolbar"><strong title={canvas.title}>{canvas.title}</strong><div className="teaching-canvas-actions">
        {(onSave||localSaved)&&<button type="button" className="teaching-canvas-save" onClick={()=>void save()} disabled={localSaved||saving} aria-label={localSaved?'画布已保存':saving?'正在保存画布':'保存到练习'}>{localSaved?<Check size={14}/>:<Bookmark size={14}/>}<span>{localSaved?'已保存':saving?'保存中…':'保存到练习'}</span></button>}
        <button type="button" className="teaching-canvas-icon" onClick={()=>setRun(value=>value+1)} aria-label="重新运行动画" title="重新运行"><RotateCcw size={15}/></button>
        <button type="button" ref={expandButton} className="teaching-canvas-icon" onClick={toggleExpanded} aria-label={expanded?'收起画布':'放大画布'} title={expanded?'收起画布':'放大画布'}>{expanded?<Minimize2 size={15}/>:<Maximize2 size={15}/>}</button>
      </div></header>
      <div className="teaching-canvas-stage" aria-busy={loading}>
        <iframe key={token} ref={iframe} title={canvas.title} srcDoc={source} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; payment 'none'; usb 'none'"/>
        {loading&&<div className="teaching-canvas-status" role="status"><span className="spinner"/>正在打开画布…</div>}
        {runtimeError&&<div className="teaching-canvas-status teaching-canvas-runtime-error" role="alert"><p>{runtimeError}</p><button type="button" onClick={()=>setRun(value=>value+1)}>重新运行</button></div>}
      </div>
      {saveError&&<p className="teaching-canvas-save-error" role="alert">{saveError}</p>}
      {expanded&&<span tabIndex={0} className="sr-only" onFocus={()=>focusEdge()}/>}
    </div>
  </section>
}
