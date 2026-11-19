import {useEffect,useRef,useState} from 'react'
import {BookOpen,Check,Code2,Copy,Download,FileText,ListTree,MessageSquareQuote,RotateCcw,X} from 'lucide-react'
import {Markdown} from './Markdown'
import type {Source} from './CourseContextPanel'
import './document-reader.css'

type HeadingItem={index:number;level:number;text:string}
type ReadResult={text?:string;warning?:string|null;truncated?:boolean}

type Props={
  courseId:string
  source:Source
  revision?:number
  onClose:()=>void
  onOpenSource?:(id:string,page?:number)=>void
  onAskAboutDocument?:(source:Source)=>void
}

export function MarkdownReader({courseId,source,revision=0,onClose,onOpenSource,onAskAboutDocument}:Props){
  const [content,setContent]=useState<string|null>(null)
  const [warning,setWarning]=useState<string|null>(null)
  const [truncated,setTruncated]=useState(false)
  const [loading,setLoading]=useState(true)
  const [refreshing,setRefreshing]=useState(false)
  const [error,setError]=useState('')
  const [viewMode,setViewMode]=useState<'preview'|'source'>('preview')
  const [outlineOpen,setOutlineOpen]=useState(false)
  const [headings,setHeadings]=useState<HeadingItem[]>([])
  const [reloadCount,setReloadCount]=useState(0)
  const [copied,setCopied]=useState(false)
  const loadedKey=useRef('')
  const articleRef=useRef<HTMLElement>(null)
  const stageRef=useRef<HTMLDivElement>(null)
  const copyTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined)

  const docKey=`${courseId}:${source.id}:${source.relativePath}`
  const downloadUrl=(source.url||`/api/courses/${encodeURIComponent(courseId)}/sources/${encodeURIComponent(source.id)}/file`)+'?download=1'

  useEffect(()=>()=>{if(copyTimer.current)clearTimeout(copyTimer.current)},[])

  useEffect(()=>{
    const sameDoc=loadedKey.current===docKey
    if(!sameDoc){
      setContent(null);setWarning(null);setTruncated(false);setError('')
      setHeadings([]);setOutlineOpen(false);setViewMode('preview')
      setLoading(true)
    }else{
      setRefreshing(true)
    }
    const controller=new AbortController()
    const endpoint=`/api/courses/${encodeURIComponent(courseId)}/files/read?path=${encodeURIComponent(source.relativePath)}&mode=reader`
    fetch(endpoint,{signal:controller.signal})
      .then(async res=>{
        const data=await res.json()
        if(!res.ok)throw new Error(data.error||'无法读取 Markdown 文件。')
        return data as ReadResult
      })
      .then(data=>{
        if(controller.signal.aborted)return
        loadedKey.current=docKey
        setContent(typeof data.text==='string'?data.text:'')
        setWarning(data.warning||null)
        setTruncated(Boolean(data.truncated))
        setError('')
      })
      .catch(err=>{
        if(err.name==='AbortError')return
        if(!sameDoc)setContent(null)
        setError(err.message||'无法读取 Markdown 文件。')
      })
      .finally(()=>{
        if(!controller.signal.aborted){setLoading(false);setRefreshing(false)}
      })
    return()=>controller.abort()
  },[courseId,source.relativePath,docKey,revision,reloadCount])

  useEffect(()=>{
    if(viewMode!=='preview'||content===null||!articleRef.current){setHeadings([]);return}
    const nodes=Array.from(articleRef.current.querySelectorAll<HTMLElement>('h1,h2,h3,h4'))
    const items=nodes
      .map((node,index)=>({index,level:Number(node.tagName.slice(1)),text:(node.textContent||'').trim()}))
      .filter(item=>item.text)
    setHeadings(items)
    if(items.length<2)setOutlineOpen(false)
  },[content,viewMode])

  function scrollToHeading(index:number){
    const nodes=articleRef.current?.querySelectorAll<HTMLElement>('h1,h2,h3,h4')
    const target=nodes?.[index]
    if(target)target.scrollIntoView({behavior:'smooth',block:'start'})
  }

  async function copyContent(){
    if(content===null)return
    try{
      await navigator.clipboard.writeText(content)
      setCopied(true)
      if(copyTimer.current)clearTimeout(copyTimer.current)
      copyTimer.current=setTimeout(()=>setCopied(false),1800)
    }catch{}
  }

  const folderLabel=source.folder?source.folder.split('/').join(' / '):''

  return <section className="doc-reader doc-reader-md" aria-label={`阅读 Markdown：${source.name}`}>
    <header className="doc-reader-header">
      <span className="doc-reader-badge is-markdown" aria-hidden="true"><FileText size={15}/></span>
      <div className="doc-reader-heading">
        <strong className="doc-reader-title" title={source.relativePath}>{source.name}</strong>
        {folderLabel&&<span className="doc-reader-folder" title={folderLabel}>{folderLabel}</span>}
      </div>
      <div className="doc-reader-actions">
        {onAskAboutDocument&&<button type="button" className="doc-reader-pill-btn" onClick={()=>onAskAboutDocument(source)} title="围绕这份文档向助教提问"><MessageSquareQuote size={14}/><span>提问</span></button>}
        {viewMode==='preview'&&headings.length>=2&&<button type="button" className={'doc-reader-icon'+(outlineOpen?' is-active':'')} aria-label="文档目录" title="文档目录" aria-expanded={outlineOpen} onClick={()=>setOutlineOpen(v=>!v)}><ListTree size={16}/></button>}
        <button type="button" className={'doc-reader-icon'+(viewMode==='source'?' is-active':'')} aria-label={viewMode==='preview'?'查看 Markdown 原文':'返回阅读视图'} title={viewMode==='preview'?'查看 Markdown 原文':'返回阅读视图'} onClick={()=>setViewMode(m=>m==='preview'?'source':'preview')}>{viewMode==='preview'?<Code2 size={16}/>:<BookOpen size={16}/>}</button>
        {viewMode==='source'&&content!==null&&<button type="button" className="doc-reader-icon" aria-label="复制 Markdown 原文" title={copied?'已复制':'复制原文'} onClick={()=>void copyContent()}>{copied?<Check size={16}/>:<Copy size={15}/>}</button>}
        <button type="button" className="doc-reader-icon" aria-label="刷新文档" title="刷新文档" disabled={loading||refreshing} onClick={()=>setReloadCount(v=>v+1)}><RotateCcw size={15} className={refreshing?'doc-reader-spin':undefined}/></button>
        <a className="doc-reader-icon" href={downloadUrl} download={source.name} aria-label={`下载 ${source.name}`} title={`下载 ${source.name}`}><Download size={16}/></a>
        <button type="button" className="doc-reader-icon" onClick={onClose} aria-label="关闭阅读器" title="关闭阅读器"><X size={18}/></button>
      </div>
    </header>

    <div className="doc-reader-body">
      {outlineOpen&&viewMode==='preview'&&headings.length>=2&&<aside className="doc-reader-outline" aria-label="文档目录">
        <div className="doc-reader-outline-title">目录</div>
        <ul>
          {headings.map(item=><li key={item.index} className={'level-'+item.level}>
            <button type="button" title={item.text} onClick={()=>scrollToHeading(item.index)}>{item.text}</button>
          </li>)}
        </ul>
      </aside>}

      <div className="doc-reader-stage doc-reader-md-stage" ref={stageRef}>
        {loading&&content===null?<div className="doc-reader-status" role="status"><span className="spinner"/>正在打开 Markdown 文档…</div>
        :error&&content===null?<div className="doc-reader-status is-error" role="alert"><p>{error}</p><button type="button" onClick={()=>setReloadCount(v=>v+1)}>重新加载</button></div>
        :<div className="doc-reader-sheet">
          {error&&<div className="doc-reader-notice is-error" role="alert">{error}</div>}
          {(warning||truncated)&&<div className="doc-reader-notice is-warn" role="status">{warning||'文档内容较长，当前显示前 500,000 个字符。'}</div>}
          {viewMode==='source'?<pre className="doc-reader-source"><code>{content||''}</code></pre>
          :content&&content.trim()?<article className="doc-reader-markdown" ref={articleRef}>
            <Markdown text={content} allowStudy={false} onOpenSource={onOpenSource}/>
          </article>
          :<div className="doc-reader-empty">这份 Markdown 文档目前是空的。</div>}
        </div>}
      </div>
    </div>
  </section>
}
