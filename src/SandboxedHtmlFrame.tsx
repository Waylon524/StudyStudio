import {useEffect,useMemo,useRef,useState} from 'react'
import {getCurrentLocale,tCurrent,useI18n} from './i18n'
import {chemistryRenderQueue} from './chemistry-client'
import {sanitizeChemistrySvg} from './ChemistrySvg'

export type CanvasReport={label:string;value?:string}

export const HTML_SANDBOX_POLICY="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'"
export const HTML_SANDBOX_ATTR='allow-scripts'
export const HTML_SANDBOX_ALLOW="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; payment 'none'; usb 'none'"

const safeJSON=(value:unknown)=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029')
const escapeTitle=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')

const CHEM_HELPER_STYLE="chem-figure,[data-chem]{display:inline-flex;align-items:center;justify-content:center;max-width:100%;vertical-align:middle;color:#000;line-height:normal}chem-figure[block],[data-chem-block]{display:flex;margin:.4em auto}.study-chem-svg{display:block;height:auto;max-width:100%;overflow:visible;fill:currentColor}.study-chem-loading{font-size:12px;color:#7c8c88}.study-chem-error{font-size:12px;color:#976339}"
const FRAGMENT_BASE_STYLE="html{color-scheme:light;background:#fff;color:#383633;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}body{margin:0;padding:16px;box-sizing:border-box;min-height:100vh}*,*::before,*::after{box-sizing:border-box}canvas,svg,img{max-width:100%}button,input,select,textarea{font:inherit}button{cursor:pointer}:focus-visible{outline:2px solid #ad8d79;outline-offset:3px}.study-canvas-paused *, .study-canvas-paused *::before,.study-canvas-paused *::after{animation-play-state:paused!important}"+CHEM_HELPER_STYLE+"@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}"
const PAUSE_ONLY_STYLE='.study-canvas-paused *, .study-canvas-paused *::before,.study-canvas-paused *::after{animation-play-state:paused!important}'+CHEM_HELPER_STYLE

const ALLOWED_CANVAS_CHEM_KINDS=new Set(['molecule','reaction','mechanism','equation','formula'])

function buildBootstrap(token:string){
  const fallbackErr=safeJSON(tCurrent('study.frameDocError'))
  const chemLoadingText=safeJSON(tCurrent('md.drawing'))
  const chemFailedText=safeJSON(tCurrent('md.renderRequestFailed'))
  return `(()=>{
    const token=${safeJSON(token)};
    for(const key of ['RTCPeerConnection','webkitRTCPeerConnection']){try{Object.defineProperty(window,key,{value:undefined,writable:false,configurable:false})}catch{}}
    const send=(type,detail={})=>parent.postMessage({source:'study-canvas',token,type,...detail},'*');
    addEventListener('error',event=>send('error',{message:String(event.message||${fallbackErr}).slice(0,1000)}));
    addEventListener('unhandledrejection',event=>send('error',{message:String(event.reason?.message||event.reason||${fallbackErr}).slice(0,1000)}));
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
    const chemPending=new Map(),chemCache=new Map();
    let chemReqSeq=0,chemMountSeq=0;
    const normKind=value=>{const k=String(value||'molecule').trim().toLowerCase();return k==='smiles'?'molecule':k};
    const normSource=value=>value&&typeof value==='object'?JSON.stringify(value):String(value??'').trim();
    function chemRender(kind,source){
      const k=normKind(kind),src=normSource(source);
      if(!src)return Promise.reject(new Error(${chemFailedText}));
      const key=k+':'+src,cached=chemCache.get(key);
      if(cached)return cached;
      const promise=new Promise((resolve,reject)=>{
        const requestId='c'+(++chemReqSeq);
        const timer=setTimeout(()=>{chemPending.delete(requestId);if(chemCache.get(key)===promise)chemCache.delete(key);reject(new Error(${chemFailedText}))},25000);
        chemPending.set(requestId,{resolve:val=>{clearTimeout(timer);resolve(val)},reject:err=>{clearTimeout(timer);if(chemCache.get(key)===promise)chemCache.delete(key);reject(err)}});
        send('chem-render',{requestId,kind:k,chemSource:src});
      });
      chemCache.set(key,promise);
      return promise;
    }
    async function chemMount(el,kindOrSpec,maybeSource){
      if(!(el instanceof Element))throw new Error('Invalid target element');
      let kind='molecule',source='',scale=1,maxWidth='',maxHeight='';
      if(kindOrSpec&&typeof kindOrSpec==='object'){
        kind=kindOrSpec.kind||'molecule';source=kindOrSpec.source;
        if(kindOrSpec.scale!==undefined)scale=Number(kindOrSpec.scale)||1;
        if(kindOrSpec.maxWidth!==undefined)maxWidth=String(kindOrSpec.maxWidth);
        if(kindOrSpec.maxHeight!==undefined)maxHeight=String(kindOrSpec.maxHeight);
      }else{
        kind=kindOrSpec||'molecule';source=maybeSource;
        const attrScale=el.getAttribute('scale')||el.getAttribute('data-scale');
        if(attrScale)scale=Number(attrScale)||1;
      }
      scale=Math.max(0.4,Math.min(3.5,Number.isFinite(scale)&&scale>0?scale:1));
      const k=normKind(kind),src=normSource(source),key=k+':'+src+':'+scale;
      const seq=++chemMountSeq;el.__studyChemSeq=seq;el.__studyChemKey=key;
      if(!chemCache.has(k+':'+src)){
        const status=document.createElement('span');status.className='study-chem-loading';status.textContent=${chemLoadingText};
        el.replaceChildren(status);
      }
      try{
        const res=await chemRender(k,src);
        if(el.__studyChemSeq!==seq)return res;
        const doc=new DOMParser().parseFromString(res.svg,'image/svg+xml'),root=doc.documentElement;
        if(!root||root.localName!=='svg')throw new Error(${chemFailedText});
        const svg=document.importNode(root,true);
        svg.classList.add('study-chem-svg');
        svg.style.width='min('+(res.width*scale)+'px, 100%)';
        svg.style.aspectRatio=res.width+' / '+res.height;
        if(maxWidth)svg.style.maxWidth=maxWidth;
        if(maxHeight)svg.style.maxHeight=maxHeight;
        el.replaceChildren(svg);
        return res;
      }catch(err){
        if(el.__studyChemSeq===seq){
          const box=document.createElement('span');box.className='study-chem-error';box.textContent=err&&err.message?err.message:${chemFailedText};
          el.replaceChildren(box);
        }
        throw err;
      }
    }
    function hydrateOne(el){
      if(!(el instanceof Element))return Promise.resolve();
      const kind=el.getAttribute('kind')||el.getAttribute('data-kind')||el.getAttribute('data-chem')||'molecule';
      let src=el.getAttribute('data-source')??el.getAttribute('source')??el.getAttribute('data-chem-raw');
      if(src===null){src=(el.textContent||'').trim();if(src)el.setAttribute('data-chem-raw',src)}
      if(!src||!src.trim())return Promise.resolve();
      const scaleAttr=el.getAttribute('scale')||el.getAttribute('data-scale');
      const scale=Math.max(0.4,Math.min(3.5,Number(scaleAttr)||1));
      const key=normKind(kind)+':'+src.trim()+':'+scale;
      if(el.__studyChemKey===key)return Promise.resolve();
      return chemMount(el,kind,src).catch(()=>{});
    }
    function chemHydrate(root=document){
      const targets=[];
      if(root instanceof Element&&(root.matches('chem-figure,[data-chem]')))targets.push(root);
      if(root&&root.querySelectorAll)targets.push(...root.querySelectorAll('chem-figure,[data-chem]'));
      return Promise.all(targets.map(hydrateOne));
    }
    window.StudyChem=Object.freeze({
      render:chemRender,
      mount:chemMount,
      hydrate:chemHydrate,
      molecule:source=>chemRender('molecule',source),
      reaction:source=>chemRender('reaction',source),
      equation:source=>chemRender('equation',source),
      formula:source=>chemRender('formula',source),
      mechanism:source=>chemRender('mechanism',source),
    });
    addEventListener('message',event=>{
      if(event.source!==parent||event.data?.source!=='study-canvas-host'||event.data?.token!==token)return;
      if(event.data.type==='chem-result'){
        const slot=chemPending.get(event.data.requestId);
        if(!slot)return;
        chemPending.delete(event.data.requestId);
        if(event.data.ok)slot.resolve({svg:event.data.svg,viewBox:event.data.viewBox,width:event.data.width,height:event.data.height});
        else slot.reject(new Error(event.data.error||${chemFailedText}));
        return;
      }
      if(event.data.type!=='visibility')return;
      const next=event.data.active===true;if(next===active)return;active=next;
      document.documentElement.classList.toggle('study-canvas-paused',!active);
      for(const [id,entry] of pending){if(active)schedule(id,entry);else if(entry.native!==null){nativeCancel(entry.native);entry.native=null}}
    });
    const startChem=()=>{
      void chemHydrate(document);
      if(typeof MutationObserver==='function'&&document.documentElement){
        const observer=new MutationObserver(mutations=>{
          for(const m of mutations){
            if(m.type==='attributes'&&m.target instanceof Element&&m.target.matches('chem-figure,[data-chem]')){void hydrateOne(m.target)}
            else if(m.type==='childList'){for(const node of m.addedNodes){if(node instanceof Element)void chemHydrate(node)}}
          }
        });
        observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['kind','data-kind','data-chem','data-source','source','scale','data-scale']});
      }
    };
    const ready=()=>{startChem();send('ready')};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
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
  const lang=getCurrentLocale()
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_SANDBOX_POLICY}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${FRAGMENT_BASE_STYLE}</style><script>${bootstrap}</script></head><body>${rawHtml}</body></html>`
}

export function buildCanvasDocument(canvas:{html:string},token:string){
  return buildSandboxedHtmlDocument(canvas.html,token)
}

export function buildStandaloneHtmlFile(title:string,rawHtml:string){
  if(isFullHtmlDocument(rawHtml))return rawHtml
  const lang=getCurrentLocale()
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeTitle(title)}</title><style>${FRAGMENT_BASE_STYLE}</style></head><body>${rawHtml}</body></html>`
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
  const {t}=useI18n()
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
    let ready=false,disposed=false,chemRequestCount=0,chemScopeSeq=0
    const timeout=window.setTimeout(()=>{
      setLoading(false)
      setRuntimeError(mode==='document'?tCurrent('study.frameTimeoutDoc'):tCurrent('study.frameTimeoutCanvas'))
    },12000)
    const replyChem=(requestId:string,payload:Record<string,unknown>)=>{
      if(disposed)return
      iframe.current?.contentWindow?.postMessage({source:'study-canvas-host',token,type:'chem-result',requestId,...payload},'*')
    }
    const receive=(event:MessageEvent)=>{
      if(event.source!==iframe.current?.contentWindow||event.data?.source!=='study-canvas'||event.data?.token!==token)return
      const data=event.data
      if(data.type==='ready'){
        ready=true;clearTimeout(timeout);setLoading(false);setReadyOnce(true);sendVisibility()
      }else if(data.type==='chem-render'){
        const requestId=typeof data.requestId==='string'&&data.requestId.length<=64?data.requestId:''
        if(!requestId)return
        const rawKind=String(data.kind||'').trim().toLowerCase()
        const kind=rawKind==='smiles'?'molecule':rawKind
        const chemSource=typeof data.chemSource==='string'?data.chemSource.trim():''
        if(!ALLOWED_CANVAS_CHEM_KINDS.has(kind)||!chemSource||chemSource.length>60_000){
          replyChem(requestId,{ok:false,error:tCurrent('md.renderRequestFailed')})
          return
        }
        if(!chemistryRenderQueue.peek(kind,chemSource)&&++chemRequestCount>100){
          replyChem(requestId,{ok:false,error:tCurrent('md.renderRequestFailed')})
          return
        }
        void chemistryRenderQueue.render(kind,chemSource).then(result=>{
          const blocked=result?.status==='blocked_for_publication'||result?.status==='error'||result?.status==='blocked'
          if(blocked||!result?.svg){
            replyChem(requestId,{ok:false,error:result?.warnings?.join('; ')||tCurrent('md.noStructureReturned')})
            return
          }
          const sanitized=sanitizeChemistrySvg(result.svg,`canvas-chem-${++chemScopeSeq}`)
          if(!sanitized){
            replyChem(requestId,{ok:false,error:tCurrent('chem.svgError')})
            return
          }
          replyChem(requestId,{ok:true,svg:sanitized.svg,viewBox:sanitized.viewBox,width:sanitized.width,height:sanitized.height})
        }).catch(err=>{
          replyChem(requestId,{ok:false,error:err instanceof Error?err.message:tCurrent('md.renderRequestFailed')})
        })
      }else if(data.type==='error'){
        clearTimeout(timeout);setLoading(false)
        setBannerDismissed(false)
        setRuntimeError(mode==='document'&&ready
          ?tCurrent('study.frameScriptError',{message:String(data.message||tCurrent('app.reload'))})
          :mode==='document'?tCurrent('study.frameDocError'):tCurrent('study.frameCanvasError'))
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
    return()=>{disposed=true;clearTimeout(timeout);window.removeEventListener('message',receive)}
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
    {loading&&<div className="teaching-canvas-status" role="status"><span className="spinner"/>{loadingLabel||(mode==='document'?t('study.frameRenderingPage'):t('study.frameOpeningCanvas'))}</div>}
    {showOverlayError&&<div className="teaching-canvas-status teaching-canvas-runtime-error" role="alert">
      <p>{runtimeError}</p>
      <div className="teaching-canvas-error-actions">
        <button type="button" onClick={retry}>{mode==='document'?t('app.reload'):t('study.rerun')}</button>
        {onViewSource&&<button type="button" onClick={onViewSource}>{t('study.viewSource')}</button>}
      </div>
    </div>}
    {showBannerError&&<div className="doc-reader-runtime-banner" role="alert">
      <span>{runtimeError}</span>
      <button type="button" onClick={retry}>{t('app.reload')}</button>
      <button type="button" onClick={()=>setBannerDismissed(true)}>{t('app.ignore')}</button>
    </div>}
  </div>
}
