import {useEffect,useMemo,useRef,useState} from 'react'
import type {ReactNode} from 'react'
import {ArrowLeft,ChevronDown,ChevronRight,FileText,Folder,FolderPlus,Image as ImageIcon,MessageSquarePlus,MoreHorizontal,Plus,Presentation,Upload,X} from 'lucide-react'
import {LearningArea} from './LearningArea'
import {CourseRequirements} from './CourseRequirements'
import {CourseSchedule} from './CourseSchedule'
import './context-panel.css'

export type Source={id:string;name:string;relativePath:string;mime?:string;size?:number;attachmentId?:string;url?:string;selected?:boolean;folder:string;category:string;kind:'courseware'|'material'}
type PanelTab='sources'|'courseware'|'schedule'|'learning'
type CourseFolder={path:string;name:string;kind:'courseware'|'material'}
type SourceDetail={text?:string;content?:string;preservedText?:string;preservedtext?:string;warning?:string|string[];page?:number;pages?:number|{page?:number;number?:number;text?:string}[];pageCount?:number;truncated?:boolean;imageUrl?:string;imageurl?:string;url?:string;kind?:string}
type PendingImport={jobId:string;attachmentId:string;sourceId?:string;name:string;relativePath:string;status:'needs_review'|'failed';reason:string}
type FolderNode={path:string;name:string;children:FolderNode[];sources:Source[]}
type Props={courseId:string;revision?:number;tab:PanelTab;onTabChange:(tab:PanelTab)=>void;onUpload:(folder?:string)=>void;onOpenCourseware:(source:Source,page?:number)=>void;onAskAgent:(text:string)=>void;onDraftMessage?:(text:string)=>void;onChanged?:()=>void;renderMarkdown?:(text:string)=>ReactNode;focusSourceId?:string|null;focusSourcePage?:number|null;currentSourceId?:string|null}

async function request(path:string,body?:unknown,signal?:AbortSignal){
 const response=await fetch(path,body===undefined?{signal}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal})
 const value=await response.json()
 if(!response.ok)throw new Error(value.error||'暂时无法读取，请稍后重试。')
 return value
}
const describeSize=(size?:number)=>typeof size!=='number'?'':size<1024?size+' B':size<1024*1024?(size/1024).toFixed(0)+' KB':(size/1024/1024).toFixed(1)+' MB'
const isImage=(source:Source)=>Boolean(source.mime?.startsWith('image/')||/\.(?:png|jpe?g|webp|gif)$/i.test(source.name))
const isPdf=(source:Source)=>source.mime==='application/pdf'||/\.pdf$/i.test(source.name)
const isSlides=(source:Source)=>/\.pptx?$/i.test(source.name)
const sourceFolder=(source:Source)=>source.folder||''
const folderTitle=(path:string)=>path?path.split('/').join(' / '):'未分类'
const naturalNames=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'})
const sourceIcon=(source:Source)=>isImage(source)?<ImageIcon size={17}/>:source.kind==='courseware'?<Presentation size={17}/>:<FileText size={17}/>
function buildTree(sources:Source[],folders:CourseFolder[]){
 const root:FolderNode={path:'',name:'',children:[],sources:[]},nodes=new Map<string,FolderNode>([['',root]])
 function ensure(path:string):FolderNode{
  const existing=nodes.get(path);if(existing)return existing
  const segments=path.split('/'),name=segments.pop()||'',parent=ensure(segments.join('/')),node={path,name,children:[],sources:[]} as FolderNode
  nodes.set(path,node);parent.children.push(node);return node
 }
 folders.forEach(folder=>ensure(folder.path));sources.forEach(source=>ensure(sourceFolder(source)).sources.push(source))
 function sort(node:FolderNode){node.children.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));node.sources.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));node.children.forEach(sort)}
 sort(root);return root
}
export function CourseContextPanel({courseId,revision,tab,onTabChange,onUpload,onOpenCourseware,onAskAgent,onDraftMessage,onChanged,renderMarkdown,focusSourceId,focusSourcePage,currentSourceId}:Props){
 const [sources,setSources]=useState<Source[]>([]),[folders,setFolders]=useState<CourseFolder[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0)
 const [openedId,setOpenedId]=useState<string|null>(null),[detail,setDetail]=useState<SourceDetail|null>(null),[reading,setReading]=useState(false),[readError,setReadError]=useState(''),[focusUnavailable,setFocusUnavailable]=useState('')
 const [pendingImports,setPendingImports]=useState<PendingImport[]>([]),[activeImportIds,setActiveImportIds]=useState<string[]>([]),[showImportDetails,setShowImportDetails]=useState(false),[retrying,setRetrying]=useState(false),[importError,setImportError]=useState(''),[newFolder,setNewFolder]=useState(false),[folderName,setFolderName]=useState(''),[movingId,setMovingId]=useState<string|null>(null),[collapsed,setCollapsed]=useState<Set<string>>(new Set())
 const activeCourse=useRef(courseId),sourceRequest=useRef(0),readRequest=useRef(0),lastFocus=useRef(''),mutation=useRef(false),reader=useRef<HTMLElement|null>(null)
 const render=renderMarkdown||((text:string)=><div style={{whiteSpace:'pre-wrap'}}>{text}</div>)
 const base='/api/courses/'+encodeURIComponent(courseId),isCourseware=tab==='courseware',opened=sources.find(source=>source.id===openedId)
 useEffect(()=>{
  activeCourse.current=courseId;sourceRequest.current++;readRequest.current++;lastFocus.current='';mutation.current=false
  setSources([]);setFolders([]);setOpenedId(null);setDetail(null);setReadError('');setError('');setFocusUnavailable('');setBusy(false);setPendingImports([]);setActiveImportIds([]);setShowImportDetails(false);setImportError('');setRetrying(false);setNewFolder(false);setFolderName('');setMovingId(null);setCollapsed(new Set())
 },[courseId])
 useEffect(()=>{
  const controller=new AbortController(),requestId=++sourceRequest.current
  setLoading(true);setError('')
  Promise.all([request(base+'/sources',undefined,controller.signal),request(base+'/folders',undefined,controller.signal)]).then(([sourceData,folderData])=>{
   if(activeCourse.current!==courseId||requestId!==sourceRequest.current)return
   if(!Array.isArray(sourceData.sources)||!Array.isArray(folderData.folders))throw new Error('资料列表暂时不可用。')
   setSources(sourceData.sources);setFolders(folderData.folders)
  }).catch(error=>{if(error.name!=='AbortError'&&activeCourse.current===courseId&&requestId===sourceRequest.current)setError(error.message)}).finally(()=>{if(activeCourse.current===courseId&&requestId===sourceRequest.current)setLoading(false)})
  return()=>controller.abort()
 },[courseId,revision,refresh])
 useEffect(()=>{setNewFolder(false);setFolderName('');setMovingId(null)},[tab])
 useEffect(()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,lastStatus=''
  async function load(){try{const value=await request(base+'/imports',undefined,controller.signal);if(controller.signal.aborted)return;const pending=Array.isArray(value.pending)?value.pending:[],activeIds=Array.isArray(value.activeAttachmentIds)?value.activeAttachmentIds:[];setPendingImports(pending);setActiveImportIds(activeIds);setImportError('');const signature=JSON.stringify([pending,activeIds]);if(lastStatus&&signature!==lastStatus)setRefresh(previous=>previous+1);lastStatus=signature;if(value.active)timer=setTimeout(load,2000)}catch(error:any){if(error.name!=='AbortError')setImportError(error.message)}}
  void load();return()=>{controller.abort();if(timer)clearTimeout(timer)}
 },[courseId,revision,refresh])
 useEffect(()=>{
  if(!focusSourceId){setFocusUnavailable('');return}
  if(loading)return
  const key=courseId+':'+focusSourceId+':'+(focusSourcePage||'')
  if(lastFocus.current===key)return
  const source=sources.find(item=>item.id===focusSourceId)
  if(source){lastFocus.current=key;void openSource(source,focusSourcePage??undefined)}
  else{++readRequest.current;onTabChange('sources');setOpenedId(null);setDetail(null);setReading(false);setFocusUnavailable('来源暂不可用，可能已被移除。')}
 },[courseId,focusSourceId,focusSourcePage,sources,loading])
 async function openSource(source:Source,page?:number){
  setFocusUnavailable('');setMovingId(null)
  if(isPdf(source)){onOpenCourseware(source,page);return}
  onTabChange(source.kind==='courseware'?'courseware':'sources')
  setOpenedId(source.id);setDetail(null);setReadError('')
  if(isSlides(source)){setReading(false);return}
  const requestId=++readRequest.current,course=courseId;setReading(true)
  try{const value=await request(base+'/files/read?path='+encodeURIComponent(source.relativePath));if(activeCourse.current===course&&requestId===readRequest.current)setDetail(value)}catch(error:any){if(activeCourse.current===course&&requestId===readRequest.current)setReadError(error.message)}finally{if(activeCourse.current===course&&requestId===readRequest.current)setReading(false)}
 }
 function askSource(){
  if(opened)onAskAgent('请根据课程资料《'+opened.name+'》帮助我学习。先概括它的知识框架，并标明引用的原文位置。')
 }
 async function createFolder(source:Source){
  const name=folderName.trim();if(!name||mutation.current)return
  if(/[\\/]/.test(name)||name==='.'||name==='..'){setError('分类名称不能包含斜杠。');return}
  const path=name,course=courseId
  mutation.current=true;setBusy(true);setError('')
  try{
   const value=await request(base+'/folders',{path});if(activeCourse.current!==course)return
   if(!Array.isArray(value.folders))throw new Error('分类尚未保存，请重试。')
   await request(base+'/sources/move',{sourceId:source.id,folder:path});if(activeCourse.current!==course)return;setFolders(value.folders);setFolderName('');setNewFolder(false);setMovingId(null);setRefresh(value=>value+1);onChanged?.()
  }catch(error:any){if(activeCourse.current===course)setError(error.message)}finally{if(activeCourse.current===course){mutation.current=false;setBusy(false)}}
 }
 async function moveSource(source:Source,folder:string,confirm=false){
  if(sourceFolder(source)===folder&&!confirm){setMovingId(null);return}if(mutation.current)return
  const course=courseId;mutation.current=true;++sourceRequest.current;setLoading(false);setBusy(true);setError('')
  try{
   await request(base+'/sources/move',{sourceId:source.id,folder});if(activeCourse.current!==course)return
   setMovingId(null);setRefresh(value=>value+1);onChanged?.()
  }catch(error:any){if(activeCourse.current===course)setError(error.message)}finally{if(activeCourse.current===course){mutation.current=false;setBusy(false)}}
 }
 async function retryImport(){const course=courseId;setRetrying(true);setImportError('');try{for(const jobId of new Set(pendingImports.map(item=>item.jobId))){await request(base+'/imports/retry',{jobId});if(activeCourse.current!==course)return}setRefresh(value=>value+1)}catch(error:any){if(activeCourse.current===course)setImportError(error.message)}finally{if(activeCourse.current===course)setRetrying(false)}}
 const pendingSource=(item:PendingImport)=>sources.find(source=>source.attachmentId===item.attachmentId||source.id===item.sourceId)
 const visibleSources=sources.filter(source=>isCourseware?source.kind==='courseware':source.kind==='material')
 const visibleFolders=folders.filter(folder=>isCourseware?folder.kind==='courseware':folder.kind==='material')
 const tree=useMemo(()=>buildTree(isCourseware?[]:visibleSources,isCourseware?[]:visibleFolders),[sources,folders,isCourseware])
 const flatCourseware=useMemo(()=>sources.filter(source=>source.kind==='courseware').sort((a,b)=>naturalNames.compare(a.name,b.name)||naturalNames.compare(a.relativePath,b.relativePath)||a.id.localeCompare(b.id)),[sources])
 const allFolders=useMemo(()=>['',...new Set([...folders.map(folder=>folder.path),...sources.map(source=>sourceFolder(source))].filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN')),[folders,sources])
 const requestedPage=opened?.id===focusSourceId?focusSourcePage:null,detailText=detail?.text||detail?.preservedText||detail?.preservedtext||detail?.content||''
 const warnings=Array.isArray(detail?.warning)?detail.warning.filter(Boolean):detail?.warning?[detail.warning]:[]
 const textPages=useMemo(()=>{const matches=[...detailText.matchAll(/(?:^|\n)\[第\s*(\d+)\s*页(?:幻灯片)?\]\s*/g)];return matches.map((match,index)=>({page:Number(match[1]),text:detailText.slice((match.index||0)+match[0].length,index+1<matches.length?matches[index+1].index:undefined)}))},[detailText])
 const locatedPage=Boolean(requestedPage&&(textPages.some(page=>page.page===requestedPage)||Array.isArray(detail?.pages)&&detail.pages.some((page,index)=>(page.page||page.number||index+1)===requestedPage)))
 useEffect(()=>{if(requestedPage&&detail&&locatedPage)reader.current?.querySelector('[data-source-page="'+requestedPage+'"]')?.scrollIntoView({block:'start',behavior:'auto'})},[detail,requestedPage,locatedPage])
 function renderSource(source:Source){return <div key={source.id} className={'context-source-entry'+(currentSourceId===source.id?' is-current':'')}>
  <div className="context-source-row"><button className="context-source-open" title={isCourseware?source.relativePath:source.name} onClick={()=>openSource(source)} aria-current={currentSourceId===source.id?'page':undefined}><span className="context-document-icon">{sourceIcon(source)}</span><span className="context-source-name"><strong>{source.name}</strong><small>{isSlides(source)?'需转为 PDF 阅读':currentSourceId===source.id?'正在阅读':describeSize(source.size)}</small></span></button>{!isCourseware&&<button className="context-icon-button context-source-more" aria-label={'移动《'+source.name+'》到分类'} aria-expanded={movingId===source.id} disabled={busy} onClick={()=>{setMovingId(movingId===source.id?null:source.id);setNewFolder(false);setFolderName('')}}><MoreHorizontal size={15}/></button>}</div>
  {!isCourseware&&movingId===source.id&&<><div className="context-move-source"><label>移动到<select aria-label={'《'+source.name+'》的分类'} value={sourceFolder(source)} disabled={busy} onChange={event=>moveSource(source,event.target.value)}>{allFolders.map(path=><option key={path} value={path}>{folderTitle(path)}</option>)}</select></label><button className="context-icon-button" aria-label="新建分类并移动" aria-expanded={newFolder} onClick={()=>setNewFolder(value=>!value)} disabled={busy}><FolderPlus size={14}/></button><button className="context-icon-button" aria-label="取消移动" onClick={()=>setMovingId(null)}><X size={13}/></button></div>{newFolder&&<form className="context-new-folder context-move-new-folder" onSubmit={event=>{event.preventDefault();void createFolder(source)}}><input autoFocus aria-label="新分类名称" placeholder="分类名称" value={folderName} onChange={event=>setFolderName(event.target.value)} disabled={busy}/><button type="submit" disabled={!folderName.trim()||busy}>移入</button></form>}</>}
 </div>}
 function renderFolder(node:FolderNode):ReactNode{const closed=collapsed.has(node.path);return <section key={node.path} className="context-folder"><div className="context-folder-heading"><button className="context-folder-toggle" aria-expanded={!closed} onClick={()=>setCollapsed(previous=>{const next=new Set(previous);next.has(node.path)?next.delete(node.path):next.add(node.path);return next})}>{closed?<ChevronRight size={13}/>:<ChevronDown size={13}/>}<Folder size={15}/><span title={node.name}>{node.name}</span><small>{node.sources.length+node.children.length}</small></button></div>{!closed&&<div className="context-folder-content">{node.sources.map(renderSource)}{node.children.map(renderFolder)}{!node.sources.length&&!node.children.length&&<p className="context-folder-empty">暂无文件</p>}</div>}</section>}
 function closePreview(){++readRequest.current;setOpenedId(null);setDetail(null);setReadError('');setReading(false)}
 const showPreview=Boolean(opened&&(tab==='courseware')===(opened.kind==='courseware'))
 return <aside className="course-context-panel" aria-label="课程内容">
  <header className="context-panel-header"><nav role="tablist" aria-label="课程内容">{([{id:'sources',label:'资料'},{id:'courseware',label:'课件'},{id:'schedule',label:'日常'},{id:'learning',label:'练习'}] as {id:PanelTab;label:string}[]).map(item=><button key={item.id} role="tab" aria-selected={tab===item.id} onClick={()=>onTabChange(item.id)}>{item.label}</button>)}</nav></header>
  <div className="context-panel-body" role="tabpanel">
   {tab==='schedule'?<div className="context-daily">{error&&<p className="context-error" role="alert">{error}</p>}<CourseSchedule courseId={courseId} revision={revision} onChanged={onChanged} onOpenSource={(id,page)=>{const source=sources.find(item=>item.id===id);if(source)void openSource(source,page);else setError('来源暂不可用，可能已被移除。')}}/><CourseRequirements courseId={courseId} revision={revision} refresh={refresh} onAskAgent={onAskAgent} onDraftMessage={onDraftMessage} onOpenSource={(id,page)=>{const source=sources.find(item=>item.id===id);if(source)void openSource(source,page);else setError('来源暂不可用，可能已被移除。')}}/></div>:tab==='learning'?<LearningArea courseId={courseId} revision={revision} onAskAgent={onAskAgent} onChanged={onChanged} renderMarkdown={renderMarkdown} compact/>:showPreview&&opened?<section className="context-source-reader" ref={reader}>
    <button className="context-back" onClick={closePreview}><ArrowLeft size={14}/>{isCourseware?'全部课件':'全部资料'}</button>
    <div className="context-reader-heading"><span className="context-document-icon">{sourceIcon(opened)}</span><h2>{opened.name}</h2></div>
    {isSlides(opened)?<div className="context-format-note"><Presentation size={25}/><p>请将这份课件转为 PDF 后上传，即可逐页阅读。</p><button className="context-text-button" onClick={()=>onUpload('')}><Upload size={14}/>上传 PDF 课件</button></div>:<>
     <button className="context-ask-source" onClick={askSource}><MessageSquarePlus size={15}/>根据这份资料提问</button>
     {error&&<div className="context-error" role="alert">{error}</div>}
     {reading?<div className="context-loading"><span className="spinner"/>正在读取…</div>:readError?<div className="context-error" role="alert">{readError}</div>:detail?<>
      {requestedPage&&<p className="context-citation-location">引用指向第 {requestedPage} 页{locatedPage?' · 已定位到提取的页码':'；当前预览未保留可定位的页码。'}</p>}
      {warnings.map((warning,index)=><p className="context-read-warning" key={index}>{warning}</p>)}
      {detail.truncated&&<p className="context-read-warning">当前预览只显示已提取的部分内容。</p>}
      {(detail.page||detail.pageCount||typeof detail.pages==='number')&&<div className="context-page-label">{detail.page?'第 '+detail.page+' 页':(detail.pageCount||detail.pages)+' 页'}</div>}
      {(detail.kind==='image'||isImage(opened))&&(detail.imageUrl||detail.imageurl||detail.url||opened.url)?<img className="context-source-image" alt={opened.name} src={detail.imageUrl||detail.imageurl||detail.url||opened.url}/>:null}
      {Array.isArray(detail.pages)?detail.pages.map((page,index)=><section className="context-source-page" key={index} data-source-page={page.page||page.number||index+1}><h3>第 {page.page||page.number||index+1} 页</h3>{render(page.text||'')}</section>):textPages.length?textPages.map((page,index)=><section className="context-source-page" key={index} data-source-page={page.page}><h3>第 {page.page} 页</h3><div className="context-source-text">{render(page.text)}</div></section>):detailText?<div className="context-source-text">{render(detailText)}</div>:!isImage(opened)&&<p className="context-muted">这份资料暂无可预览的文字。</p>}
     </>:null}
    </>}
   </section>:<section className="context-sources">

    <div className="context-source-toolbar"><button className="context-upload-button" onClick={()=>onUpload('')} disabled={busy}><Plus size={15}/>{isCourseware?'添加课件':'添加资料'}</button></div>
    {activeImportIds.length>0?<div className="context-import-status" role="status"><span className="spinner"/>正在整理 {activeImportIds.length} 份资料…</div>:pendingImports.length>0&&<><div className="context-import-status needs-review" role="status"><button className="context-import-details-toggle" type="button" aria-expanded={showImportDetails} onClick={()=>setShowImportDetails(value=>!value)}>{pendingImports.length} 份资料待确认<ChevronDown size={12}/></button><button type="button" disabled={retrying||busy} onClick={()=>void retryImport()}>{retrying?'正在重试…':'重试'}</button></div>{showImportDetails&&<ul className="context-import-details">{pendingImports.map(item=>{const source=pendingSource(item);return <li key={item.attachmentId}><button className="context-import-file" type="button" disabled={!source} onClick={()=>source&&void openSource(source)}>{item.name}</button><p>{item.reason}</p>{source&&<div className="context-import-actions"><select aria-label={'确认《'+source.name+'》的分类'} value={sourceFolder(source)} disabled={busy||retrying} onChange={event=>void moveSource(source,event.target.value,true)}>{[...new Set([...allFolders,'课件','教材','作业','笔记','课程说明','图片','其他资料'])].map(folder=><option key={folder} value={folder}>{folderTitle(folder)}</option>)}</select><button type="button" disabled={busy||retrying} onClick={()=>void moveSource(source,sourceFolder(source),true)}>保留此分类</button></div>}</li>})}</ul>}</>}
    {importError&&<div className="context-error" role="alert">{importError}</div>}
    {error&&<div className="context-error" role="alert">{error}</div>}{focusUnavailable&&<div className="context-error" role="alert">{focusUnavailable}</div>}
    {loading&&!sources.length?<div className="context-loading"><span className="spinner"/>正在读取…</div>:!visibleSources.length&&!tree.children.length?<div className="context-empty"><div>{isCourseware?<Presentation size={26}/>:<FileText size={26}/>}</div><h2>{isCourseware?'添加本课程的课件':'从课程资料开始'}</h2><p>{isCourseware?'添加课件，边读边学。':'添加后自动整理。'}</p><button onClick={()=>onUpload('')}><Upload size={15}/>{isCourseware?'添加课件':'添加资料'}</button></div>:<>
     <div className={isCourseware?'context-courseware-list':'context-source-tree'}>{isCourseware?flatCourseware.map(renderSource):<>{tree.sources.map(renderSource)}{tree.children.map(renderFolder)}</>}</div>
    </>}
   </section>}
  </div>
 </aside>
}
