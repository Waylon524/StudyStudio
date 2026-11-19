import {useEffect,useMemo,useRef,useState} from 'react'

export type CanvasReport={label:string;value?:string}

export const HTML_SANDBOX_POLICY="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'"
export const HTML_SANDBOX_ATTR='allow-scripts'
export const HTML_SANDBOX_ALLOW="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; payment 'none'; usb 'none'"

const safeJSON=(value:unknown)=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029')
const escapeTitle=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')

const FRAGMENT_BASE_STYLE="html{color-scheme:light;background:#fff;color:#383633;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}body{margin:0;padding:16px;box-sizing:border-box;min-height:100vh}*,*::before,*::after{box-sizing:border-box}canvas,svg,img{max-width:100%}button,input,select,textarea{font:inherit}button{cursor:pointer}:focus-visible{outline:2px solid #ad8d79;outline-offset:3px}.study-canvas-paused *, .study-canvas-paused *::before,.study-canvas-paused *::after{animation-play-state:paused!important}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}"
const PAUSE_ONLY_STYLE='.study-canvas-paused *, .study-canvas-paused *::before,.study-canvas-paused *::after{animation-play-state:paused!important}'

function buildBootstrap(token:string){
  return `(()=>{
    const token=${safeJSON(token)};
    for(const key of ['RTCPeerConnection','webkitRTCPeerConnection']){try{Object.defineProperty(window,key,{value:undefined,writable:false,configurable:false})}catch{}}
    const send=(type,detail={})=>parent.postMessage({source:'study-canvas',token,type,...detail},'*');
    addEventListener('error',event=>send('error',{message:String(event.message||'页面脚本运行遇到问题').slice(0,1000)}));
    addEventListener('unhandledrejection',event=>send('error',{message:String(event.reason?.message||event.reason||'页面脚本运行遇到问题').slice(0,1000)}));
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
}

const isFullHtmlDocument=(html:string)=>/^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\b|<html\b)/i.test(html)

// Only this isolated document executes authored content. The host renders
// no authored HTML, evaluates no authored scripts, and grants no app origin.
export function buildSandboxedHtmlDocument(rawHtml:string,token:string){
  const bootstrap=buildBootstrap(token)
  if(isFullHtmlDocument(rawHtml)){
    const headInjection=`<meta http-equiv="Content-Security-Policy" content="${HTML_SANDBOX_POLICY}"><style>${PAUSE_ONLY_STYLE}</style><script>${bootstrap}</script>`
    if(/<head\b[^>]*>/i.test(rawHtml))return rawHtml.replace(/<head\b[^>]*>/i,match=>match+headInjection)
    if(/<html\b[^>]*>/i.test(rawHtml))return rawHtml.replace(/<html\b[^>]*>/i,match=>`${match}<head><meta charset="utf-8">${headInjection}</head>`)
    if(/<body\b[^>]*>/i.test(rawHtml))return rawHtml.replace(/<body\b[^>]*>/i,match=>`<head><meta charset="utf-8">${headInjection}</head>${match}`)
    return rawHtml.replace(/<!doctype[^>]*>/i,match=>`${match}<head><meta charset="utf-8">${headInjection}</head>`)
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_SANDBOX_POLICY}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${FRAGMENT_BASE_STYLE}</style><script>${bootstrap}</script></head><body>${rawHtml}</body></html>`
}

export function buildCanvasDocument(canvas:{html:string},token:string){
  return buildSandboxedHtmlDocument(canvas.html,token)
}

export function buildStandaloneHtmlFile(title:string,rawHtml:string){
  if(isFullHtmlDocument(rawHtml))return rawHtml
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeTitle(title)}</title><style>${FRAGMENT_BASE_STYLE}</style></head><body>${rawHtml}</body></html>`
}

type Props={
  html:string
  title:string
  runKey?:number
  mode?:'canvas'|'document'
  forceActive?:boolean
  paused?:boolean
  className?:string
  loadingLabel?:string
  onReport?:(report:CanvasReport)=>void
  onEscapeClose?:()=>void
  onRetry?:()=>void
  onViewSource?:()=>void
}

export function SandboxedHtmlFrame({
  html,title,runKey=0,mode='canvas',forceActive=false,paused=false,className,
  loadingLabel,onReport,onEscapeClose,onRetry,onViewSource
}:Props){
  const iframe=useRef<HTMLIFrameElement>(null),stage=useRef<HTMLDivElement>(null)
  const callbacks=useRef({onReport,onEscapeClose})
  callbacks.current={onReport,onEscapeClose}
  const [internalRun,setInternalRun]=useState(0)
  const [loading,setLoading]=useState(true)
  const [readyOnce,setReadyOnce]=useState(false)
  const [runtimeError,setRuntimeError]=useState('')
  const [bannerDismissed,setBannerDismissed]=useState(false)
  const token=useMemo(()=>crypto.randomUUID(),[html,runKey,internalRun])
  const source=useMemo(()=>buildSandboxedHtmlDocument(html,token),[html,token])
  const visibility=useRef(true),lastReportAt=useRef(0)

  const sendVisibility=()=>{
    const active=!paused&&!document.hidden&&(forceActive||visibility.current)
    iframe.current?.contentWindow?.postMessage({source:'study-canvas-host',token,type:'visibility',active},'*')
  }

  useEffect(()=>{
    setLoading(true);setReadyOnce(false);setRuntimeError('');setBannerDismissed(false)
    let ready=false
    const timeout=window.setTimeout(()=>{
      setLoading(false)
      setRuntimeError(mode==='document'?'页面加载超时，请重新加载或查看源码。':'动画暂时无法打开，请重新运行。')
    },12000)
    const receive=(event:MessageEvent)=>{
      if(event.source!==iframe.current?.contentWindow||event.data?.source!=='study-canvas'||event.data?.token!==token)return
      const data=event.data
      if(data.type==='ready'){
        ready=true;clearTimeout(timeout);setLoading(false);setReadyOnce(true);sendVisibility()
      }else if(data.type==='error'){
        clearTimeout(timeout);setLoading(false)
        setBannerDismissed(false)
        setRuntimeError(mode==='document'&&ready
          ?`页面脚本遇到问题：${String(data.message||'请重新加载')}`
          :mode==='document'?'页面运行遇到问题，请重新加载或查看源码。':'动画运行遇到问题，请重新运行。')
      }else if(data.type==='close'){
        callbacks.current.onEscapeClose?.()
      }else if(data.type==='report'&&typeof data.label==='string'&&data.label.trim()&&data.label.length<=120&&(data.value===undefined||typeof data.value==='string'&&data.value.length<=1000)){
        const now=Date.now()
        if(now-lastReportAt.current<600)return
        lastReportAt.current=now
        callbacks.current.onReport?.({label:data.label,...(data.value===undefined?{}:{value:data.value})})
      }
    }
    window.addEventListener('message',receive)
    return()=>{clearTimeout(timeout);window.removeEventListener('message',receive)}
  },[token,mode])

  useEffect(()=>{
    const observer=new IntersectionObserver(entries=>{visibility.current=Boolean(entries[0]?.isIntersecting);sendVisibility()},{threshold:0})
    if(stage.current)observer.observe(stage.current)
    document.addEventListener('visibilitychange',sendVisibility)
    sendVisibility()
    return()=>{observer.disconnect();document.removeEventListener('visibilitychange',sendVisibility)}
  },[forceActive,paused,token])

  function retry(){
    if(onRetry)onRetry()
    else setInternalRun(v=>v+1)
  }

  const showOverlayError=Boolean(runtimeError)&&!(mode==='document'&&readyOnce)
  const showBannerError=Boolean(runtimeError)&&mode==='document'&&readyOnce&&!bannerDismissed

  return <div className={className||'teaching-canvas-stage'} ref={stage} aria-busy={loading}>
    <iframe
      key={token}
      ref={iframe}
      title={title}
      srcDoc={source}
      sandbox={HTML_SANDBOX_ATTR}
      referrerPolicy="no-referrer"
      allow={HTML_SANDBOX_ALLOW}
    />
    {loading&&<div className="teaching-canvas-status" role="status"><span className="spinner"/>{loadingLabel||(mode==='document'?'正在渲染页面…':'正在打开画布…')}</div>}
    {showOverlayError&&<div className="teaching-canvas-status teaching-canvas-runtime-error" role="alert">
      <p>{runtimeError}</p>
      <div className="teaching-canvas-error-actions">
        <button type="button" onClick={retry}>{mode==='document'?'重新加载':'重新运行'}</button>
        {onViewSource&&<button type="button" onClick={onViewSource}>查看源码</button>}
      </div>
    </div>}
    {showBannerError&&<div className="doc-reader-runtime-banner" role="alert">
      <span>{runtimeError}</span>
      <button type="button" onClick={retry}>重新加载</button>
      <button type="button" onClick={()=>setBannerDismissed(true)}>忽略</button>
    </div>}
  </div>
}
