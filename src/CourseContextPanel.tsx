import {memo,useEffect,useMemo,useRef,useState} from 'react'
import type {ReactNode} from 'react'
import {ArrowLeft,BookOpen,CalendarDays,ChevronDown,ChevronRight,FileCode2,FileSpreadsheet,FileText,Folder,FolderOpen,FolderPlus,Globe,GraduationCap,Image as ImageIcon,MessageSquarePlus,MoreHorizontal,Plus,Presentation,Search,SlidersHorizontal,Upload,X} from 'lucide-react'
import {LearningArea} from './LearningArea'
import {CourseRequirements} from './CourseRequirements'
import {CourseSchedule} from './CourseSchedule'
import type {CanvasSpec,OpenCanvasMeta} from './study-types'
import {isEpubSource,isHtmlSource,isImageSource,isMarkdownSource,isPdfSource,isReadableCoursewareSource,isSlidesSource,isSpreadsheetSource} from './source-types'
import {tCurrent,useI18n} from './i18n'
import './context-panel.css'

export type Source={id:string;name:string;relativePath:string;mime?:string;size?:number;attachmentId?:string;url?:string;selected?:boolean;folder:string;category:string;kind:'courseware'|'material'}
type PanelTab='sources'|'courseware'|'schedule'|'learning'
type CourseFolder={path:string;name:string;kind:'courseware'|'material'}
type SourceDetail={text?:string;content?:string;preservedText?:string;preservedtext?:string;warning?:string|string[];page?:number;pages?:number|{page?:number;number?:number;text?:string}[];pageCount?:number;truncated?:boolean;imageUrl?:string;imageurl?:string;url?:string;kind?:string}
type PendingImport={jobId:string;attachmentId:string;sourceId?:string;name:string;relativePath:string;status:'needs_review'|'failed';reason:string}
type FolderNode={path:string;name:string;children:FolderNode[];sources:Source[]}
type Props={courseId:string;revision?:number;tab:PanelTab;onTabChange:(tab:PanelTab)=>void;onUpload:(target:'sources'|'courseware')=>void;onManageMaterials?:()=>void;onManagePractice?:()=>void;uploadInProgress?:boolean;skippedCourseware?:string[];onOpenCourseware:(source:Source,page?:number)=>void;onOpenDocument:(source:Source)=>void;onOpenCanvas?:(canvas:CanvasSpec,meta?:OpenCanvasMeta)=>void;onAskAgent:(text:string)=>void;onDraftMessage?:(text:string)=>void;onChanged?:()=>void;renderMarkdown?:(text:string)=>ReactNode;focusSourceId?:string|null;focusSourcePage?:number|null;currentSourceId?:string|null}

async function request(path:string,body?:unknown,signal?:AbortSignal){
 const response=await fetch(path,body===undefined?{signal}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal})
 const value=await response.json()
 if(!response.ok)throw new Error(value.error||tCurrent('sidebar.readFailed'))
 return value
}
const describeSize=(size?:number)=>typeof size!=='number'?'':size<1024?size+' B':size<1024*1024?(size/1024).toFixed(0)+' KB':(size/1024/1024).toFixed(1)+' MB'
const isImage=isImageSource
const isPdf=isPdfSource
const isMarkdown=isMarkdownSource
const isHtml=isHtmlSource
const isReadableCourseware=isReadableCoursewareSource
const isSlides=isSlidesSource
const isSpreadsheet=isSpreadsheetSource
const isEpub=isEpubSource
const sourceFolder=(source:Source)=>source.folder||''

function sourceVisual(source:Source){
 if(isReadableCourseware(source))return {tone:'courseware',icon:<Presentation size={15}/>}
 if(isSlides(source))return {tone:'slides',icon:<Presentation size={15}/>}
 if(isPdf(source))return {tone:'pdf',icon:<FileText size={15}/>}
 if(isMarkdown(source))return {tone:'markdown',icon:<FileCode2 size={15}/>}
 if(isHtml(source))return {tone:'html',icon:<Globe size={15}/>}
 if(isImage(source))return {tone:'image',icon:<ImageIcon size={15}/>}
 if(isSpreadsheet(source))return {tone:'sheet',icon:<FileSpreadsheet size={15}/>}
 if(isEpub(source))return {tone:'book',icon:<BookOpen size={15}/>}
 return {tone:'doc',icon:<FileText size={15}/>}
}

function buildTree(sources:Source[],folders:CourseFolder[],naturalNames:Intl.Collator){
 const root:FolderNode={path:'',name:'',children:[],sources:[]},nodes=new Map<string,FolderNode>([['',root]])
 function ensure(path:string):FolderNode{
  const existing=nodes.get(path);if(existing)return existing
  const segments=path.split('/'),name=segments.pop()||'',parent=ensure(segments.join('/')),node={path,name,children:[],sources:[]} as FolderNode
  nodes.set(path,node);parent.children.push(node);return node
 }
 folders.forEach(folder=>ensure(folder.path));sources.forEach(source=>ensure(sourceFolder(source)).sources.push(source))
 function sort(node:FolderNode){node.children.sort((a,b)=>naturalNames.compare(a.name,b.name));node.sources.sort((a,b)=>naturalNames.compare(a.name,b.name));node.children.forEach(sort)}
 sort(root);return root
}

export const CourseContextPanel=memo(function CourseContextPanel({courseId,revision,tab,onTabChange,onUpload,onManageMaterials,onManagePractice,uploadInProgress,skippedCourseware,onOpenCourseware,onOpenDocument,onOpenCanvas,onAskAgent,onDraftMessage,onChanged,renderMarkdown,focusSourceId,focusSourcePage,currentSourceId}:Props){
 const {t,collator,folderDisplayName}=useI18n()
 const [sources,setSources]=useState<Source[]>([]),[folders,setFolders]=useState<CourseFolder[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0)
 const [openedId,setOpenedId]=useState<string|null>(null),[detail,setDetail]=useState<SourceDetail|null>(null),[reading,setReading]=useState(false),[readError,setReadError]=useState(''),[focusUnavailable,setFocusUnavailable]=useState('')
 const [pendingImports,setPendingImports]=useState<PendingImport[]>([]),[activeImportIds,setActiveImportIds]=useState<string[]>([]),[showImportDetails,setShowImportDetails]=useState(false),[retrying,setRetrying]=useState(false),[importError,setImportError]=useState(''),[newFolder,setNewFolder]=useState(false),[folderName,setFolderName]=useState(''),[movingId,setMovingId]=useState<string|null>(null),[collapsed,setCollapsed]=useState<Set<string>>(new Set())
 const [filterText,setFilterText]=useState('')
 const activeCourse=useRef(courseId),sourceRequest=useRef(0),readRequest=useRef(0),lastFocus=useRef(''),mutation=useRef(false),reader=useRef<HTMLElement|null>(null)
 const render=renderMarkdown||((text:string)=><div style={{whiteSpace:'pre-wrap'}}>{text}</div>)
 const base='/api/courses/'+encodeURIComponent(courseId),isCourseware=tab==='courseware',opened=sources.find(source=>source.id===openedId)
 useEffect(()=>{
  activeCourse.current=courseId;sourceRequest.current++;readRequest.current++;lastFocus.current='';mutation.current=false
  setSources([]);setFolders([]);setOpenedId(null);setDetail(null);setReadError('');setError('');setFocusUnavailable('');setBusy(false);setPendingImports([]);setActiveImportIds([]);setShowImportDetails(false);setImportError('');setRetrying(false);setNewFolder(false);setFolderName('');setMovingId(null);setCollapsed(new Set());setFilterText('')
 },[courseId])
 useEffect(()=>{
  const controller=new AbortController(),requestId=++sourceRequest.current
  setLoading(true);setError('')
  Promise.all([request(base+'/sources',undefined,controller.signal),request(base+'/folders',undefined,controller.signal)]).then(([sourceData,folderData])=>{
   if(activeCourse.current!==courseId||requestId!==sourceRequest.current)return
   if(!Array.isArray(sourceData.sources)||!Array.isArray(folderData.folders))throw new Error(tCurrent('sidebar.listUnavailable'))
   setSources(sourceData.sources);setFolders(folderData.folders)
  }).catch(error=>{if(error.name!=='AbortError'&&activeCourse.current===courseId&&requestId===sourceRequest.current)setError(error.message)}).finally(()=>{if(activeCourse.current===courseId&&requestId===sourceRequest.current)setLoading(false)})
  return()=>controller.abort()
 },[courseId,revision,refresh])
 useEffect(()=>{setNewFolder(false);setFolderName('');setMovingId(null);setFilterText('')},[tab])
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
  else{++readRequest.current;onTabChange('sources');setOpenedId(null);setDetail(null);setReading(false);setFocusUnavailable(tCurrent('sidebar.sourceRemoved'))}
 },[courseId,focusSourceId,focusSourcePage,sources,loading])
 async function openSource(source:Source,page?:number){
  setFocusUnavailable('');setMovingId(null)
  if(isPdf(source)){onOpenCourseware(source,page);return}
  if(isMarkdown(source)||isHtml(source)){onOpenDocument(source);return}
  onTabChange('sources')
  setOpenedId(source.id);setDetail(null);setReadError('')
  if(isSlides(source)){setReading(false);return}
  const requestId=++readRequest.current,course=courseId;setReading(true)
  try{const value=await request(base+'/files/read?path='+encodeURIComponent(source.relativePath));if(activeCourse.current===course&&requestId===readRequest.current)setDetail(value)}catch(error:any){if(activeCourse.current===course&&requestId===readRequest.current)setReadError(error.message)}finally{if(activeCourse.current===course&&requestId===readRequest.current)setReading(false)}
 }
 function askSource(){
  if(opened)onAskAgent(t('sidebar.askSourcePrompt',{name:opened.name}))
 }
 async function createFolder(source:Source){
  const name=folderName.trim();if(!name||mutation.current)return
  if(/[\\/]/.test(name)||name==='.'||name==='..'){setError(t('sidebar.folderSlashError'));return}
  const path=name,course=courseId
  mutation.current=true;setBusy(true);setError('')
  try{
   const value=await request(base+'/folders',{path});if(activeCourse.current!==course)return
   if(!Array.isArray(value.folders))throw new Error(t('sidebar.folderSaveError'))
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
 const rawMaterials=useMemo(()=>sources.filter(source=>!isReadableCourseware(source)),[sources])
 const flatCourseware=useMemo(()=>sources.filter(isReadableCourseware).sort((a,b)=>collator.compare(a.name,b.name)||collator.compare(a.relativePath,b.relativePath)||a.id.localeCompare(b.id)),[sources,collator])
 const normalizedQuery=filterText.trim().toLowerCase()
 const filteredCourseware=useMemo(()=>normalizedQuery?flatCourseware.filter(s=>s.name.toLowerCase().includes(normalizedQuery)||s.relativePath.toLowerCase().includes(normalizedQuery)):flatCourseware,[flatCourseware,normalizedQuery])
 const filteredMaterials=useMemo(()=>normalizedQuery?rawMaterials.filter(s=>s.name.toLowerCase().includes(normalizedQuery)||s.folder.toLowerCase().includes(normalizedQuery)||folderDisplayName(s.folder).toLowerCase().includes(normalizedQuery)):rawMaterials,[rawMaterials,normalizedQuery,folderDisplayName])
 const materialTree=useMemo(()=>buildTree(filteredMaterials,normalizedQuery?[]:folders.filter(folder=>folder.kind==='material'),collator),[filteredMaterials,folders,normalizedQuery,collator])
 const allFolders=useMemo(()=>['',...new Set([...folders.map(folder=>folder.path),...sources.map(source=>sourceFolder(source))].filter(Boolean))].sort((a,b)=>collator.compare(a,b)),[folders,sources,collator])
 const showQuickSearch=(isCourseware?flatCourseware.length:rawMaterials.length)>=5||Boolean(filterText)
 const requestedPage=opened?.id===focusSourceId?focusSourcePage:null,detailText=detail?.text||detail?.preservedText||detail?.preservedtext||detail?.content||''
 const warnings=Array.isArray(detail?.warning)?detail.warning.filter(Boolean):detail?.warning?[detail.warning]:[]
 const textPages=useMemo(()=>{const matches=[...detailText.matchAll(/(?:^|\n)\[第\s*(\d+)\s*页(?:幻灯片)?\]\s*/g)];return matches.map((match,index)=>({page:Number(match[1]),text:detailText.slice((match.index||0)+match[0].length,index+1<matches.length?matches[index+1].index:undefined)}))},[detailText])
 const locatedPage=Boolean(requestedPage&&(textPages.some(page=>page.page===requestedPage)||Array.isArray(detail?.pages)&&detail.pages.some((page,index)=>(page.page||page.number||index+1)===requestedPage)))
 useEffect(()=>{if(requestedPage&&detail&&locatedPage)reader.current?.querySelector('[data-source-page="'+requestedPage+'"]')?.scrollIntoView({block:'start',behavior:'auto'})},[detail,requestedPage,locatedPage])

 const navTabs:Array<{id:PanelTab;label:string;icon:ReactNode}>=[
  {id:'sources',label:t('sidebar.tab.sources'),icon:<FolderOpen size={17}/>},
  {id:'courseware',label:t('sidebar.tab.courseware'),icon:<Presentation size={17}/>},
  {id:'schedule',label:t('sidebar.tab.schedule'),icon:<CalendarDays size={17}/>},
  {id:'learning',label:t('sidebar.tab.learning'),icon:<GraduationCap size={17}/>},
 ]
 const activeTabLabel=navTabs.find(item=>item.id===tab)?.label||''

 function renderSource(source:Source){
  const visual=sourceVisual(source),current=currentSourceId===source.id
  return <div key={source.id} className={'context-source-entry'+(current?' is-current':'')}>
   <div className="context-source-row"><button className="context-source-open" title={isCourseware?source.relativePath:source.name} onClick={()=>openSource(source)} aria-current={current?'page':undefined}><span className={'context-document-icon is-'+visual.tone}>{visual.icon}</span><span className="context-source-name"><strong>{source.name}</strong><small>{isSlides(source)?t('sidebar.convertSlidesHint'):current?<em className="context-reading-pill">{t('sidebar.readingNow')}</em>:describeSize(source.size)}</small></span></button>{!isCourseware&&<button className="context-icon-button context-source-more" aria-label={t('sidebar.moveToCategoryAria',{name:source.name})} aria-expanded={movingId===source.id} disabled={busy} onClick={()=>{setMovingId(movingId===source.id?null:source.id);setNewFolder(false);setFolderName('')}}><MoreHorizontal size={15}/></button>}</div>
   {!isCourseware&&movingId===source.id&&<><div className="context-move-source"><label>{t('sidebar.categoryLabel')}<select aria-label={t('sidebar.categoryOfAria',{name:source.name})} value={sourceFolder(source)} disabled={busy} onChange={event=>moveSource(source,event.target.value)}>{allFolders.map(path=><option key={path} value={path}>{folderDisplayName(path)}</option>)}</select></label><button className="context-icon-button" aria-label={t('sidebar.newCategoryAndMove')} aria-expanded={newFolder} onClick={()=>setNewFolder(value=>!value)} disabled={busy}><FolderPlus size={14}/></button><button className="context-icon-button" aria-label={t('sidebar.cancelMove')} onClick={()=>setMovingId(null)}><X size={13}/></button></div>{newFolder&&<form className="context-new-folder context-move-new-folder" onSubmit={event=>{event.preventDefault();void createFolder(source)}}><input autoFocus aria-label={t('sidebar.newCategoryName')} placeholder={t('sidebar.newCategoryName')} value={folderName} onChange={event=>setFolderName(event.target.value)} disabled={busy}/><button type="submit" disabled={!folderName.trim()||busy}>{t('sidebar.moveIn')}</button></form>}</>}
  </div>
 }
 function renderFolder(node:FolderNode):ReactNode{
  const closed=collapsed.has(node.path)
  const count=node.sources.length+node.children.length
  const label=folderDisplayName(node.path).split(' / ').pop()||node.name
  return <section key={node.path} className="context-folder">
   <div className="context-folder-heading"><button className="context-folder-toggle" aria-expanded={!closed} onClick={()=>setCollapsed(previous=>{const next=new Set(previous);next.has(node.path)?next.delete(node.path):next.add(node.path);return next})}>{closed?<ChevronRight size={13}/>:<ChevronDown size={13}/>}<Folder size={14} className="context-folder-glyph"/><span title={label}>{label}</span><small>{count}</small></button></div>
   {!closed&&<div className="context-folder-content">{node.sources.map(renderSource)}{node.children.map(renderFolder)}{!count&&<p className="context-folder-empty">{t('sidebar.folderEmpty')}</p>}</div>}
  </section>
 }
 function closePreview(){++readRequest.current;setOpenedId(null);setDetail(null);setReadError('');setReading(false)}
 const showPreview=Boolean(opened&&tab==='sources')
 const openedVisual=opened?sourceVisual(opened):null
 return <aside className="course-context-panel" aria-label={t('sidebar.aria')}>
  <header className="context-panel-header">
   <nav className="context-icon-nav" role="tablist" aria-label={t('sidebar.aria')}>
    {navTabs.map(item=><button
     key={item.id}
     type="button"
     role="tab"
     data-tab={item.id}
     aria-selected={tab===item.id}
     aria-label={item.label}
     title={item.label}
     onClick={()=>onTabChange(item.id)}
    >
     {item.icon}
     {item.id==='sources'&&pendingImports.length>0&&<i className="context-tab-dot" aria-hidden="true"/>}
    </button>)}
   </nav>
   <div className="context-panel-section-bar">
    <span className="context-panel-section-label">{activeTabLabel}</span>
    {tab==='sources'&&rawMaterials.length>0&&<small>{rawMaterials.length}</small>}
    {tab==='courseware'&&flatCourseware.length>0&&<small>{flatCourseware.length}</small>}
   </div>
  </header>
  <div className="context-panel-body" role="tabpanel" aria-label={activeTabLabel}>
   {tab==='schedule'?<div className="context-daily">{error&&<p className="context-error" role="alert">{error}</p>}<CourseSchedule courseId={courseId} revision={revision} onChanged={onChanged} onOpenSource={(id,page)=>{const source=sources.find(item=>item.id===id);if(source)void openSource(source,page);else setError(t('sidebar.sourceRemoved'))}}/><CourseRequirements courseId={courseId} revision={revision} refresh={refresh} onAskAgent={onAskAgent} onDraftMessage={onDraftMessage} onOpenSource={(id,page)=>{const source=sources.find(item=>item.id===id);if(source)void openSource(source,page);else setError(t('sidebar.sourceRemoved'))}}/></div>:tab==='learning'?<LearningArea courseId={courseId} revision={revision} onAskAgent={onAskAgent} onOpenCanvas={onOpenCanvas} onManagePractice={onManagePractice} onChanged={onChanged} renderMarkdown={renderMarkdown} compact/>:showPreview&&opened?<section className="context-source-reader" ref={reader}>
    <button className="context-back" onClick={closePreview}><ArrowLeft size={13}/>{isCourseware?t('sidebar.backToCourseware'):t('sidebar.backToMaterials')}</button>
    <div className="context-reader-heading">{openedVisual&&<span className={'context-document-icon is-'+openedVisual.tone}>{openedVisual.icon}</span>}<h2>{opened.name}</h2></div>
    {isSlides(opened)?<div className="context-format-note"><Presentation size={24}/><p>{t('sidebar.slidesConvertNote')}</p><button className="context-text-button" disabled={uploadInProgress} onClick={()=>onUpload('courseware')}><Upload size={14}/>{t('sidebar.uploadPdfCourseware')}</button></div>:<>
     <button className="context-ask-source" onClick={askSource}><MessageSquarePlus size={14}/>{t('sidebar.askAboutSource')}</button>
     {error&&<div className="context-error" role="alert">{error}</div>}
     {reading?<div className="context-loading"><span className="spinner"/>{t('app.loading')}</div>:readError?<div className="context-error" role="alert">{readError}</div>:detail?<>
      {requestedPage&&<p className="context-citation-location">{t('sidebar.citationPage',{page:requestedPage})}{locatedPage?t('sidebar.citationLocated'):t('sidebar.citationUnlocated')}</p>}
      {warnings.map((warning,index)=><p className="context-read-warning" key={index}>{warning}</p>)}
      {detail.truncated&&<p className="context-read-warning">{t('sidebar.previewTruncated')}</p>}
      {(detail.page||detail.pageCount||typeof detail.pages==='number')&&<div className="context-page-label">{detail.page?t('sidebar.pageNumber',{page:detail.page}):t('sidebar.totalPages',{count:Number(detail.pageCount||detail.pages)})}</div>}
      {(detail.kind==='image'||isImage(opened))&&(detail.imageUrl||detail.imageurl||detail.url||opened.url)?<img className="context-source-image" alt={opened.name} src={detail.imageUrl||detail.imageurl||detail.url||opened.url}/>:null}
      {Array.isArray(detail.pages)?detail.pages.map((page,index)=><section className="context-source-page" key={index} data-source-page={page.page||page.number||index+1}><h3>{t('sidebar.pageNumber',{page:page.page||page.number||index+1})}</h3>{render(page.text||'')}</section>):textPages.length?textPages.map((page,index)=><section className="context-source-page" key={index} data-source-page={page.page}><h3>{t('sidebar.pageNumber',{page:page.page})}</h3><div className="context-source-text">{render(page.text)}</div></section>):detailText?<div className="context-source-text">{render(detailText)}</div>:!isImage(opened)&&<p className="context-muted">{t('sidebar.noPreviewText')}</p>}
     </>:null}
    </>}
   </section>:<section className="context-sources">
    <div className="context-source-toolbar">
     <button className="context-upload-button" onClick={()=>onUpload(isCourseware?'courseware':'sources')} disabled={busy||uploadInProgress}><Plus size={14}/>{isCourseware?t('sidebar.addCourseware'):t('sidebar.addMaterials')}</button>
     {onManageMaterials&&<button type="button" className="context-manage-button" aria-label={t('sidebar.manageMaterials')} title={t('sidebar.manageMaterials')} onClick={onManageMaterials}><SlidersHorizontal size={14}/></button>}
    </div>
    {showQuickSearch&&<label className="context-search-box"><Search size={13}/><input type="search" aria-label={isCourseware?t('sidebar.searchCourseware'):t('sidebar.searchMaterials')} placeholder={isCourseware?t('sidebar.searchCoursewarePlaceholder'):t('sidebar.searchMaterialsPlaceholder')} value={filterText} onChange={event=>setFilterText(event.target.value)}/>{filterText&&<button type="button" aria-label={t('app.clearSearch')} onClick={()=>setFilterText('')}><X size={12}/></button>}</label>}
    {isCourseware&&Boolean(skippedCourseware?.length)&&<p className="context-error" role="status">{t('sidebar.skippedCourseware')}<br/>{skippedCourseware?.join(', ')}</p>}
    {activeImportIds.length>0?<div className="context-import-status" role="status"><span className="spinner"/>{t('sidebar.organizingImports',{count:activeImportIds.length})}</div>:pendingImports.length>0&&<div className="context-import-card"><div className="context-import-status needs-review" role="status"><button className="context-import-details-toggle" type="button" aria-expanded={showImportDetails} onClick={()=>setShowImportDetails(value=>!value)}>{t('sidebar.pendingImports',{count:pendingImports.length})}<ChevronDown size={12}/></button><button type="button" disabled={retrying||busy} onClick={()=>void retryImport()}>{retrying?t('sidebar.retrying'):t('app.retry')}</button></div>{showImportDetails&&<ul className="context-import-details">{pendingImports.map(item=>{const source=pendingSource(item);return <li key={item.attachmentId}><button className="context-import-file" type="button" disabled={!source} onClick={()=>source&&void openSource(source)}>{item.name}</button><p>{item.reason}</p>{source&&<div className="context-import-actions"><select aria-label={t('sidebar.confirmCategoryAria',{name:source.name})} value={sourceFolder(source)} disabled={busy||retrying} onChange={event=>void moveSource(source,event.target.value,true)}>{[...new Set([...allFolders,'课件','教材','作业','笔记','课程说明','图片','其他资料'])].map(folder=><option key={folder} value={folder}>{folderDisplayName(folder)}</option>)}</select><button type="button" disabled={busy||retrying} onClick={()=>void moveSource(source,sourceFolder(source),true)}>{t('app.confirm')}</button></div>}</li>})}</ul>}</div>}
    {importError&&<div className="context-error" role="alert">{importError}</div>}
    {error&&<div className="context-error" role="alert">{error}</div>}{focusUnavailable&&<div className="context-error" role="alert">{focusUnavailable}</div>}
    {loading&&!sources.length?<div className="context-loading"><span className="spinner"/>{t('app.loading')}</div>:(isCourseware?!flatCourseware.length:!rawMaterials.length&&!folders.some(f=>f.kind==='material'&&f.path))?<div className="context-empty"><div>{isCourseware?<Presentation size={22}/>:<FileText size={22}/>}</div><h2>{isCourseware?t('sidebar.emptyCoursewareTitle'):t('sidebar.emptyMaterialsTitle')}</h2><p>{isCourseware?t('sidebar.emptyCoursewareDesc'):t('sidebar.emptyMaterialsDesc')}</p><button disabled={uploadInProgress} onClick={()=>onUpload(isCourseware?'courseware':'sources')}><Upload size={14}/>{isCourseware?t('sidebar.addCourseware'):t('sidebar.addMaterials')}</button></div>:normalizedQuery&&(isCourseware?!filteredCourseware.length:!filteredMaterials.length)?<div className="context-filter-empty"><p>{isCourseware?t('sidebar.noMatchingCourseware'):t('sidebar.noMatchingMaterials')}</p><button type="button" onClick={()=>setFilterText('')}>{t('sidebar.clearFilter')}</button></div>:<>
     <div className={isCourseware?'context-courseware-list':'context-source-tree'}>{isCourseware?filteredCourseware.map(renderSource):<>{materialTree.sources.map(renderSource)}{materialTree.children.map(renderFolder)}</>}</div>
    </>}
   </section>}
  </div>
 </aside>
})
