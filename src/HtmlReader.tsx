import {useEffect,useRef,useState} from 'react'
import {Bookmark,Check,Code2,Copy,Download,Eye,Globe,Layers,MessageSquareQuote,RotateCcw,X} from 'lucide-react'
import {SandboxedHtmlFrame,buildStandaloneHtmlFile,type CanvasReport} from './SandboxedHtmlFrame'
import type {Source} from './CourseContextPanel'
import type {CanvasSpec} from './study-types'
import './document-reader.css'

type ReadResult={text?:string;warning?:string|null;truncated?:boolean}

type FileProps={
  kind:'file'
  courseId:string
  source:Source
  revision?:number
  visible?:boolean
  onClose:()=>void
  onAskAboutDocument?:(source:Source)=>void
}

type CanvasProps={
  kind:'canvas'
  canvas:CanvasSpec
  saved?:boolean
  onSave?:()=>Promise<void>
  onReport?:(report:CanvasReport)=>void
  visible?:boolean
  onClose:()=>void
  onAskAboutCanvas?:(canvas:CanvasSpec)=>void
}

export type HtmlReaderProps=FileProps|CanvasProps

export function HtmlReader(props:HtmlReaderProps){
  const [fileHtml,setFileHtml]=useState<string|null>(null)
  const [warning,setWarning]=useState<string|null>(null)
  const [truncated,setTruncated]=useState(false)
  const [loading,setLoading]=useState(props.kind==='file')
  const [refreshing,setRefreshing]=useState(false)
  const [error,setError]=useState('')
  const [viewMode,setViewMode]=useState<'preview'|'source'>('preview')
  const [run,setRun]=useState(0)
  const [reloadCount,setReloadCount]=useState(0)
  const [saving,setSaving]=useState(false)
  const [localSaved,setLocalSaved]=useState(props.kind==='canvas'?Boolean(props.saved):false)
  const [saveError,setSaveError]=useState('')
  const [copied,setCopied]=useState(false)

  const loadedKey=useRef('')
  const copyTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined)
  const downloadUrls=useRef(new Map<string,ReturnType<typeof setTimeout>>())

  const fileCourseId=props.kind==='file'?props.courseId:''
  const fileSourceId=props.kind==='file'?props.source.id:''
  const filePath=props.kind==='file'?props.source.relativePath:''
  const fileRevision=props.kind==='file'?(props.revision??0):0
  const canvasId=props.kind==='canvas'?props.canvas.id:''
  const canvasHtml=props.kind==='canvas'?props.canvas.html:''
  const canvasSaved=props.kind==='canvas'?Boolean(props.saved):false
  const docKey=props.kind==='file'?`file:${fileCourseId}:${fileSourceId}:${filePath}`:`canvas:${canvasId}`

  useEffect(()=>()=>{
    if(copyTimer.current)clearTimeout(copyTimer.current)
    for(const [url,timer] of downloadUrls.current){clearTimeout(timer);URL.revokeObjectURL(url)}
    downloadUrls.current.clear()
  },[])

  useEffect(()=>{
    setLocalSaved(canvasSaved);setSaveError('')
  },[canvasSaved,canvasId,canvasHtml])

  useEffect(()=>{
    if(props.kind!=='file'){
      loadedKey.current=docKey
      setLoading(false);setRefreshing(false);setError('');setWarning(null);setTruncated(false)
      setViewMode('preview')
      return
    }
    const sameDoc=loadedKey.current===docKey
    if(!sameDoc){
      setFileHtml(null);setWarning(null);setTruncated(false);setError('')
      setViewMode('preview');setLoading(true)
    }else{
      setRefreshing(true)
    }
    const controller=new AbortController()
    const endpoint=`/api/courses/${encodeURIComponent(fileCourseId)}/files/read?path=${encodeURIComponent(filePath)}&mode=reader`
    fetch(endpoint,{signal:controller.signal})
      .then(async res=>{
        const data=await res.json()
        if(!res.ok)throw new Error(data.error||'无法读取 HTML 文件。')
        return data as ReadResult
      })
      .then(data=>{
        if(controller.signal.aborted)return
        loadedKey.current=docKey
        const nextText=typeof data.text==='string'?data.text:''
        setFileHtml(prev=>prev===nextText?prev:nextText)
        setWarning(data.warning||null)
        setTruncated(Boolean(data.truncated))
        setError('')
      })
      .catch(err=>{
        if(err.name==='AbortError')return
        if(!sameDoc)setFileHtml(null)
        setError(err.message||'无法读取 HTML 文件。')
      })
      .finally(()=>{
        if(!controller.signal.aborted){setLoading(false);setRefreshing(false)}
      })
    return()=>controller.abort()
  },[props.kind,fileCourseId,filePath,docKey,fileRevision,reloadCount])

  const html=props.kind==='canvas'?props.canvas.html:fileHtml
  const title=props.kind==='canvas'?props.canvas.title:props.source.name
  const subtitle=props.kind==='canvas'?'交互画布':(props.source.folder?props.source.folder.split('/').join(' / '):'')
  const visible=props.visible!==false

  function reload(){
    setRun(v=>v+1)
    if(props.kind==='file')setReloadCount(v=>v+1)
  }

  async function handleSaveCanvas(){
    if(props.kind!=='canvas'||!props.onSave||localSaved||saving)return
    setSaving(true);setSaveError('')
    try{await props.onSave();setLocalSaved(true)}
    catch(err){setSaveError(err instanceof Error?err.message:'画布暂时无法保存，请重试。')}
    finally{setSaving(false)}
  }

  function downloadCanvasHtml(){
    if(props.kind!=='canvas')return
    const standalone=buildStandaloneHtmlFile(props.canvas.title,props.canvas.html)
    const blob=new Blob([standalone],{type:'text/html;charset=utf-8'})
    const url=URL.createObjectURL(blob)
    const safeName=(props.canvas.title||'交互画布').replace(/[\/\\:*?"<>|]/g,'_').trim()||'交互画布'
    const anchor=document.createElement('a')
    anchor.href=url;anchor.download=safeName.endsWith('.html')?safeName:`${safeName}.html`;anchor.hidden=true
    document.body.append(anchor);anchor.click();anchor.remove()
    const timer=setTimeout(()=>{URL.revokeObjectURL(url);downloadUrls.current.delete(url)},120000)
    downloadUrls.current.set(url,timer)
  }

  async function copySource(){
    if(html===null)return
    try{
      await navigator.clipboard.writeText(html)
      setCopied(true)
      if(copyTimer.current)clearTimeout(copyTimer.current)
      copyTimer.current=setTimeout(()=>setCopied(false),1800)
    }catch{}
  }

  const fileDownloadUrl=props.kind==='file'
    ?(props.source.url||`/api/courses/${encodeURIComponent(props.courseId)}/sources/${encodeURIComponent(props.source.id)}/file`)+'?download=1'
    :''

  return <section className="doc-reader doc-reader-html" aria-label={`阅读 HTML：${title}`}>
    <header className="doc-reader-header">
      <span className={'doc-reader-badge '+(props.kind==='canvas'?'is-canvas':'is-html')} aria-hidden="true">
        {props.kind==='canvas'?<Layers size={15}/>:<Globe size={15}/>}
      </span>
      <div className="doc-reader-heading">
        <strong className="doc-reader-title" title={props.kind==='file'?props.source.relativePath:title}>{title}</strong>
        {subtitle&&<span className={'doc-reader-folder'+(props.kind==='canvas'?' is-canvas':'')} title={subtitle}>{subtitle}</span>}
      </div>
      <div className="doc-reader-actions">
        {props.kind==='canvas'&&(props.onSave||localSaved)&&<button type="button" className={'doc-reader-pill-btn'+(localSaved?' is-saved':'')} onClick={()=>void handleSaveCanvas()} disabled={localSaved||saving} title={localSaved?'已保存到练习':'保存到练习'}>
          {localSaved?<Check size={14}/>:<Bookmark size={14}/>}
          <span>{localSaved?'已保存':saving?'保存中…':'保存到练习'}</span>
        </button>}
        {props.kind==='file'&&props.onAskAboutDocument&&<button type="button" className="doc-reader-pill-btn" onClick={()=>props.onAskAboutDocument?.(props.source)} title="围绕这份页面向助教提问"><MessageSquareQuote size={14}/><span>提问</span></button>}
        {props.kind==='canvas'&&props.onAskAboutCanvas&&<button type="button" className="doc-reader-pill-btn" onClick={()=>props.onAskAboutCanvas?.(props.canvas)} title="围绕这个画布向助教提问"><MessageSquareQuote size={14}/><span>提问</span></button>}
        <button type="button" className={'doc-reader-icon'+(viewMode==='source'?' is-active':'')} aria-label={viewMode==='preview'?'查看 HTML 源码':'返回页面预览'} title={viewMode==='preview'?'查看 HTML 源码':'返回页面预览'} onClick={()=>setViewMode(m=>m==='preview'?'source':'preview')}>{viewMode==='preview'?<Code2 size={16}/>:<Eye size={16}/>}</button>
        {viewMode==='source'&&html!==null&&<button type="button" className="doc-reader-icon" aria-label="复制 HTML 源码" title={copied?'已复制':'复制源码'} onClick={()=>void copySource()}>{copied?<Check size={16}/>:<Copy size={15}/>}</button>}
        <button type="button" className="doc-reader-icon" aria-label="重新运行页面" title="重新运行" disabled={loading||refreshing} onClick={reload}><RotateCcw size={15} className={refreshing?'doc-reader-spin':undefined}/></button>
        {props.kind==='file'?<a className="doc-reader-icon" href={fileDownloadUrl} download={props.source.name} aria-label={`下载 ${props.source.name}`} title={`下载 ${props.source.name}`}><Download size={16}/></a>
        :<button type="button" className="doc-reader-icon" onClick={downloadCanvasHtml} aria-label={`下载 ${title}.html`} title="下载独立 HTML 文件"><Download size={16}/></button>}
        <button type="button" className="doc-reader-icon" onClick={props.onClose} aria-label="关闭阅读器" title="关闭阅读器"><X size={18}/></button>
      </div>
    </header>

    {saveError&&<div className="doc-reader-top-alert is-error" role="alert">{saveError}</div>}
    {props.kind==='file'&&(warning||truncated)&&<div className="doc-reader-top-alert is-warn" role="status">{warning||'HTML 文件较长，当前显示前 500,000 个字符。'}</div>}
    {props.kind==='file'&&error&&fileHtml!==null&&<div className="doc-reader-top-alert is-error" role="alert">{error}</div>}

    <div className="doc-reader-body">
      {loading&&html===null?<div className="doc-reader-stage doc-reader-html-stage"><div className="doc-reader-status" role="status"><span className="spinner"/>正在打开 HTML 页面…</div></div>
      :error&&html===null?<div className="doc-reader-stage doc-reader-html-stage"><div className="doc-reader-status is-error" role="alert"><p>{error}</p><button type="button" onClick={reload}>重新加载</button></div></div>
      :viewMode==='source'?<div className="doc-reader-stage doc-reader-md-stage"><div className="doc-reader-sheet"><pre className="doc-reader-source"><code>{html||''}</code></pre></div></div>
      :html&&html.trim()?<SandboxedHtmlFrame
        className="doc-reader-html-frame"
        html={html}
        title={title}
        runKey={run}
        mode={props.kind==='canvas'?'canvas':'document'}
        forceActive={visible}
        paused={!visible}
        loadingLabel={props.kind==='canvas'?'正在打开画布…':'正在渲染页面…'}
        onReport={props.kind==='canvas'?props.onReport:undefined}
        onEscapeClose={()=>{if(window.innerWidth<900)props.onClose()}}
        onRetry={reload}
        onViewSource={()=>setViewMode('source')}
      />
      :<div className="doc-reader-stage doc-reader-html-stage"><div className="doc-reader-empty">这份 HTML 文件目前是空的。</div></div>}
    </div>
  </section>
}
