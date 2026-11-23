import {MAX_MATERIAL_BYTES,MATERIAL_SIZE_LABEL} from '../shared/file-limits.mjs'
import {useCallback,useEffect,useMemo,useRef,useState,type DragEvent,type FormEvent,type KeyboardEvent} from 'react'
import {
 AlertCircle,ArrowUpRight,BookOpen,Check,ChevronDown,Download,FileCode2,FileSpreadsheet,FileText,
 Folder,FolderInput,FolderPlus,Globe,Image as ImageIcon,Pencil,Plus,Presentation,RefreshCw,
 Search,Sparkles,Trash2,Upload,X
} from 'lucide-react'
import {CourseAvatar} from './CourseAvatar'
import {tCurrent,useI18n} from './i18n'
import {formatBytes,formatShortDate,type ManagedCourse,type ManagedFolder,type ManagedSource} from './settings-types'
import {isEpubSource,isHtmlSource,isImageSource,isMarkdownSource,isPdfSource,isReadableCoursewareSource,isSlidesSource,isSpreadsheetSource} from './source-types'

type PendingImport={jobId:string;attachmentId:string;sourceId?:string;name:string;relativePath:string;status:'needs_review'|'failed';reason:string}
type TypeFilter='all'|'courseware'|'material'
type SortMode='name'|'recent'|'size'

type Props={
 courses:ManagedCourse[]
 selectedCourseId:string
 onSelectCourse:(courseId:string)=>void
 activeCourseId:string
 currentSourceId?:string|null
 conversationBusy:boolean
 revision?:number
 onChanged?:(courseId:string)=>void
 onOpenSource?:(courseId:string,sourceId:string,page?:number)=>Promise<void>|void
 onSourcesDeleted?:(courseId:string,sourceIds:string[],attachmentIds:string[])=>void
 onSourceRenamed?:(courseId:string,source:ManagedSource)=>void
}

const STANDARD_CATEGORIES=['课件','教材','作业','笔记','课程说明','图片','其他资料']

async function apiJson(path:string,body?:unknown,signal?:AbortSignal){
 const res=await fetch(path,body===undefined?{signal}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal})
 const value=await res.json()
 if(!res.ok)throw new Error(value.error||tCurrent('app.operationFailed'))
 return value
}

const isPdf=isPdfSource
const isReadableCourseware=isReadableCoursewareSource
const isMarkdown=isMarkdownSource
const isHtml=isHtmlSource
const isImage=isImageSource
const isSlides=isSlidesSource
const isSpreadsheet=isSpreadsheetSource
const isEpub=isEpubSource

function splitFilename(name:string):{stem:string;ext:string}{
 const dot=name.lastIndexOf('.')
 if(dot<=0||dot===name.length-1)return {stem:name,ext:''}
 return {stem:name.slice(0,dot),ext:name.slice(dot)}
}

function fileBadge(source:ManagedSource){
 if(isReadableCourseware(source))return {kind:'courseware',icon:<Presentation size={16}/>}
 if(isSlides(source))return {kind:'slides',icon:<Presentation size={16}/>}
 if(isPdf(source))return {kind:'pdf',icon:<FileText size={16}/>}
 if(isMarkdown(source))return {kind:'markdown',icon:<FileCode2 size={16}/>}
 if(isHtml(source))return {kind:'html',icon:<Globe size={16}/>}
 if(isImage(source))return {kind:'image',icon:<ImageIcon size={16}/>}
 if(isSpreadsheet(source))return {kind:'sheet',icon:<FileSpreadsheet size={16}/>}
 if(isEpub(source))return {kind:'book',icon:<BookOpen size={16}/>}
 return {kind:'doc',icon:<FileText size={16}/>}
}

export function SettingsMaterials({
 courses,selectedCourseId,onSelectCourse,activeCourseId,currentSourceId,conversationBusy,
 revision,onChanged,onOpenSource,onSourcesDeleted,onSourceRenamed
}:Props){
 const {locale,t,collator,courseDisplayName,folderDisplayName}=useI18n()
 const [sources,setSources]=useState<ManagedSource[]>([])
 const [folders,setFolders]=useState<ManagedFolder[]>([])
 const [pendingImports,setPendingImports]=useState<PendingImport[]>([])
 const [activeImportIds,setActiveImportIds]=useState<string[]>([])
 const [showPendingDetails,setShowPendingDetails]=useState(false)
 const [loading,setLoading]=useState(true)
 const [error,setError]=useState('')
 const [notice,setNotice]=useState('')
 const [busyKey,setBusyKey]=useState<string|null>(null)
 const [localRev,setLocalRev]=useState(0)

 const [typeFilter,setTypeFilter]=useState<TypeFilter>('all')
 const [folderFilter,setFolderFilter]=useState<string>('__all__')
 const [query,setQuery]=useState('')
 const [sortBy,setSortBy]=useState<SortMode>('name')

 const [selectedIds,setSelectedIds]=useState<Set<string>>(new Set())
 const [renamingId,setRenamingId]=useState<string|null>(null)
 const [renameStem,setRenameStem]=useState('')
 const [renameExt,setRenameExt]=useState('')
 const [movingId,setMovingId]=useState<string|null>(null)
 const [moveNewFolderOpen,setMoveNewFolderOpen]=useState(false)
 const [moveNewFolderName,setMoveNewFolderName]=useState('')
 const [confirmDeleteId,setConfirmDeleteId]=useState<string|null>(null)

 const [batchMoveFolder,setBatchMoveFolder]=useState('教材')
 const [confirmBatchDelete,setConfirmBatchDelete]=useState(false)

 const [creatingFolder,setCreatingFolder]=useState(false)
 const [newFolderInput,setNewFolderInput]=useState('')
 const [renamingFolder,setRenamingFolder]=useState<string|null>(null)
 const [renameFolderInput,setRenameFolderInput]=useState('')
 const [confirmDeleteFolder,setConfirmDeleteFolder]=useState<string|null>(null)

 const [uploading,setUploading]=useState(false)
 const [uploadStatus,setUploadStatus]=useState('')
 const [dragging,setDragging]=useState(false)

 const coursewareInput=useRef<HTMLInputElement>(null)
 const materialInput=useRef<HTMLInputElement>(null)
 const renameInputRef=useRef<HTMLInputElement>(null)
 const newFolderRef=useRef<HTMLInputElement>(null)
 const renameFolderRef=useRef<HTMLInputElement>(null)
 const activeCourseRef=useRef(selectedCourseId)
 const requestSeq=useRef(0)

 const base='/api/courses/'+encodeURIComponent(selectedCourseId)
 const courseLocked=conversationBusy&&selectedCourseId===activeCourseId
 const selectedCourse=courses.find(c=>c.id===selectedCourseId)
 const selectedCourseLabel=selectedCourse?courseDisplayName(selectedCourse):t('sm.currentCourse')

 useEffect(()=>{
  activeCourseRef.current=selectedCourseId
  requestSeq.current++
  setSources([]);setFolders([]);setPendingImports([]);setActiveImportIds([])
  setShowPendingDetails(false);setError('');setNotice('')
  setTypeFilter('all');setFolderFilter('__all__');setQuery('')
  setSelectedIds(new Set());setRenamingId(null);setMovingId(null);setConfirmDeleteId(null)
  setConfirmBatchDelete(false);setCreatingFolder(false);setNewFolderInput('')
  setRenamingFolder(null);setConfirmDeleteFolder(null)
 },[selectedCourseId])

 useEffect(()=>{
  const controller=new AbortController(),seq=++requestSeq.current
  setLoading(true);setError('')
  Promise.all([
   apiJson(base+'/sources',undefined,controller.signal),
   apiJson(base+'/folders',undefined,controller.signal)
  ]).then(([sourceData,folderData])=>{
   if(activeCourseRef.current!==selectedCourseId||seq!==requestSeq.current)return
   const nextSources=Array.isArray(sourceData.sources)?sourceData.sources:[]
   const nextFolders=Array.isArray(folderData.folders)?folderData.folders:[]
   setSources(nextSources)
   setFolders(nextFolders)
   setSelectedIds(prev=>{
    if(!prev.size)return prev
    const valid=new Set(nextSources.map((item:ManagedSource)=>item.id))
    const filtered=new Set([...prev].filter(id=>valid.has(id)))
    return filtered.size===prev.size?prev:filtered
   })
  }).catch(err=>{
   if(err.name!=='AbortError'&&activeCourseRef.current===selectedCourseId&&seq===requestSeq.current)setError(err.message)
  }).finally(()=>{
   if(activeCourseRef.current===selectedCourseId&&seq===requestSeq.current)setLoading(false)
  })
  return()=>controller.abort()
 },[selectedCourseId,base,revision,localRev])

 useEffect(()=>{
  const controller=new AbortController()
  let timer:ReturnType<typeof setTimeout>|undefined,lastSignature=''
  async function load(){
   try{
    const value=await apiJson(base+'/imports',undefined,controller.signal)
    if(controller.signal.aborted||activeCourseRef.current!==selectedCourseId)return
    const pending=Array.isArray(value.pending)?value.pending:[]
    const activeIds=Array.isArray(value.activeAttachmentIds)?value.activeAttachmentIds:[]
    setPendingImports(pending);setActiveImportIds(activeIds)
    const sig=JSON.stringify([pending,activeIds])
    if(lastSignature&&sig!==lastSignature)setLocalRev(v=>v+1)
    lastSignature=sig
    if(value.active)timer=setTimeout(load,2000)
   }catch{}
  }
  void load()
  return()=>{controller.abort();if(timer)clearTimeout(timer)}
 },[selectedCourseId,base,revision,localRev])

 useEffect(()=>{if(renamingId)renameInputRef.current?.focus();if(renamingId)renameInputRef.current?.select()},[renamingId])
 useEffect(()=>{if(creatingFolder)newFolderRef.current?.focus()},[creatingFolder])
 useEffect(()=>{if(renamingFolder){renameFolderRef.current?.focus();renameFolderRef.current?.select()}},[renamingFolder])

 const reload=useCallback(()=>{
  setLocalRev(v=>v+1)
  onChanged?.(selectedCourseId)
 },[onChanged,selectedCourseId])

 const pendingBySourceId=useMemo(()=>{
  const map=new Map<string,PendingImport>()
  for(const item of pendingImports){
   const matched=sources.find(s=>s.attachmentId===item.attachmentId||s.id===item.sourceId)
   if(matched)map.set(matched.id,item)
  }
  return map
 },[pendingImports,sources])

 const counts=useMemo(()=>{
  let courseware=0,material=0,totalBytes=0,rootCount=0
  const byFolder=new Map<string,number>()
  for(const source of sources){
   if(isReadableCourseware(source))courseware++
   else material++
   totalBytes+=source.size||0
   const f=source.folder||''
   if(!f)rootCount++
   else byFolder.set(f,(byFolder.get(f)||0)+1)
  }
  return {total:sources.length,courseware,material,totalBytes,rootCount,byFolder}
 },[sources])

 const existingFolders=useMemo(()=>{
  const set=new Set<string>()
  for(const f of folders)if(f.path)set.add(f.path)
  for(const s of sources)if(s.folder)set.add(s.folder)
  return [...set].sort((a,b)=>{
   if(a==='课件')return -1
   if(b==='课件')return 1
   return collator.compare(folderDisplayName(a),folderDisplayName(b))
  })
 },[folders,sources,collator,folderDisplayName])

 const moveTargetOptions=useMemo(()=>{
  const set=new Set<string>(['',...STANDARD_CATEGORIES,...existingFolders])
  return [...set].sort((a,b)=>{
   if(!a)return -1
   if(!b)return 1
   if(a==='课件')return -1
   if(b==='课件')return 1
   return collator.compare(folderDisplayName(a),folderDisplayName(b))
  })
 },[existingFolders,collator,folderDisplayName])

 useEffect(()=>{
  if(folderFilter!=='__all__'&&folderFilter!=='__root__'&&!existingFolders.includes(folderFilter)){
   setFolderFilter('__all__')
  }
 },[existingFolders,folderFilter])

 const visibleSources=useMemo(()=>{
  const q=query.trim().toLowerCase()
  const filtered=sources.filter(source=>{
   if(typeFilter==='courseware'&&!isReadableCourseware(source))return false
   if(typeFilter==='material'&&isReadableCourseware(source))return false
   if(folderFilter==='__root__'&&source.folder)return false
   if(folderFilter!=='__all__'&&folderFilter!=='__root__'&&source.folder!==folderFilter)return false
   if(q&&!source.name.toLowerCase().includes(q)&&!source.folder.toLowerCase().includes(q)&&!folderDisplayName(source.folder).toLowerCase().includes(q)&&!source.relativePath.toLowerCase().includes(q))return false
   return true
  })
  return filtered.sort((a,b)=>{
   if(sortBy==='size')return (b.size||0)-(a.size||0)||collator.compare(a.name,b.name)
   if(sortBy==='recent'){
    const ta=Date.parse(a.modifiedAt||a.uploadedAt||'')||0
    const tb=Date.parse(b.modifiedAt||b.uploadedAt||'')||0
    return tb-ta||collator.compare(a.name,b.name)
   }
   return collator.compare(a.name,b.name)||collator.compare(a.relativePath,b.relativePath)
  })
 },[sources,typeFilter,folderFilter,query,sortBy,collator,folderDisplayName])

 const visibleIds=useMemo(()=>visibleSources.map(s=>s.id),[visibleSources])
 const selectedVisibleCount=useMemo(()=>visibleIds.filter(id=>selectedIds.has(id)).length,[visibleIds,selectedIds])
 const allVisibleSelected=visibleIds.length>0&&selectedVisibleCount===visibleIds.length
 const selectedSources=useMemo(()=>sources.filter(s=>selectedIds.has(s.id)),[sources,selectedIds])
 const canPromoteSelectedToCourseware=selectedSources.length>0&&selectedSources.every(isPdf)&&selectedSources.some(s=>!isReadableCourseware(s))

 const selectedFolderHasChildren=useMemo(()=>{
  if(folderFilter==='__all__'||folderFilter==='__root__')return true
  const fileCount=counts.byFolder.get(folderFilter)||0
  if(fileCount>0)return true
  return existingFolders.some(path=>path.startsWith(folderFilter+'/'))
 },[folderFilter,counts.byFolder,existingFolders])

 function toggleSelect(id:string){
  setConfirmBatchDelete(false)
  setSelectedIds(prev=>{
   const next=new Set(prev)
   if(next.has(id))next.delete(id);else next.add(id)
   return next
  })
 }

 function toggleSelectAll(){
  setConfirmBatchDelete(false)
  if(allVisibleSelected){
   setSelectedIds(prev=>{const next=new Set(prev);visibleIds.forEach(id=>next.delete(id));return next})
  }else{
   setSelectedIds(prev=>{const next=new Set(prev);visibleIds.forEach(id=>next.add(id));return next})
  }
 }

 async function uploadFiles(files:FileList|File[]|null,mode:'courseware'|'material'){
  if(!files?.length||uploading)return
  const list=Array.from(files)
  const targetCourse=selectedCourseId
  const directFolder=mode==='material'&&folderFilter!=='__all__'?folderFilter==='__root__'?'':folderFilter:null
  setUploading(true);setError('');setNotice('')
  const addedForAutoOrg:string[]=[],skipped:string[]=[]
  let uploadedCount=0
  try{
   for(let i=0;i<list.length;i++){
    const file=list[i]
    setUploadStatus(t('sm.uploadingProgress',{current:i+1,total:list.length,name:file.name}))
    try{
     if(mode==='courseware'){
      if(!/\.pdf$/i.test(file.name)||!/^%PDF-[0-9]\.[0-9][\t\n\f\r ]/.test(await file.slice(0,9).text())){
       skipped.push(file.name);continue
      }
     }
     if(file.size>MAX_MATERIAL_BYTES)throw new Error(t('composer.fileTooLarge',{name:file.name,limit:MATERIAL_SIZE_LABEL}))
     const headers:Record<string,string>={
      'Content-Type':file.type||'application/octet-stream',
      'x-file-name':encodeURIComponent(file.name)
     }
     if(mode==='courseware'){
      headers['x-upload-intent']='courseware'
     }else if(directFolder!==null){
      headers['x-upload-intent']='direct'
      headers['x-folder']=encodeURIComponent(directFolder)
     }else{
      headers['x-folder']=encodeURIComponent('待整理')
     }
     const response=await fetch('/api/courses/'+encodeURIComponent(targetCourse)+'/attachments',{method:'POST',headers,body:file})
     const value=await response.json()
     if(!response.ok)throw new Error(value.error||t('composer.uploadFailed'))
     uploadedCount++
     if(mode==='material'&&directFolder===null)addedForAutoOrg.push(value.attachment.id)
    }catch(err:any){
     setError(err.message||t('sm.uploadPartialFailed'))
    }
   }
   if(addedForAutoOrg.length&&activeCourseRef.current===targetCourse){
    try{
     for(let offset=0;offset<addedForAutoOrg.length;offset+=100){
      await apiJson('/api/courses/'+encodeURIComponent(targetCourse)+'/imports',{attachmentIds:addedForAutoOrg.slice(offset,offset+100)})
     }
    }catch(err:any){
     setError(t('composer.autoOrgNotStarted',{reason:err.message}))
    }
   }
   if(activeCourseRef.current===targetCourse){
    if(skipped.length){
     setError(t('sm.invalidPdfSkipped',{names:skipped.join(', ')}))
    }
    if(uploadedCount>0){
     setNotice(mode==='courseware'?t('sm.uploadedCourseware',{count:uploadedCount}):directFolder!==null?t('sm.uploadedToFolder',{count:uploadedCount,folder:folderDisplayName(directFolder)}):t('sm.uploadedAutoOrg',{count:uploadedCount}))
     reload()
    }
   }
  }finally{
   setUploading(false);setUploadStatus('')
   if(coursewareInput.current)coursewareInput.current.value=''
   if(materialInput.current)materialInput.current.value=''
  }
 }

 function handleDrop(event:DragEvent){
  event.preventDefault();event.stopPropagation();setDragging(false)
  if(!event.dataTransfer.files?.length)return
  const dropAsCourseware=typeFilter==='courseware'||folderFilter==='课件'
  void uploadFiles(event.dataTransfer.files,dropAsCourseware?'courseware':'material')
 }

 function startRename(source:ManagedSource){
  const {stem,ext}=splitFilename(source.name)
  setRenamingId(source.id);setRenameStem(stem);setRenameExt(ext)
  setMovingId(null);setConfirmDeleteId(null);setError('');setNotice('')
 }

 async function submitRename(event:FormEvent,source:ManagedSource){
  event.preventDefault()
  const nextName=(renameStem.trim()+(renameExt||'')).trim()
  if(!renameStem.trim()||nextName===source.name){setRenamingId(null);return}
  setBusyKey('rename:'+source.id);setError('');setNotice('')
  try{
   const result=await apiJson(base+'/sources/rename',{sourceId:source.id,name:nextName})
   setRenamingId(null)
   if(result.source)onSourceRenamed?.(selectedCourseId,result.source)
   setNotice(t('sm.noticeRenamed',{name:nextName}))
   reload()
  }catch(err:any){
   setError(err.message||t('sm.errRename'))
  }finally{
   setBusyKey(null)
  }
 }

 async function moveSingle(source:ManagedSource,folder:string,requirePdf=false){
  setBusyKey('move:'+source.id);setError('');setNotice('')
  try{
   await apiJson(base+'/sources/move',{sourceId:source.id,folder,requirePdf})
   setMovingId(null);setMoveNewFolderOpen(false);setMoveNewFolderName('')
   setNotice(folder==='课件'&&requirePdf?t('sm.noticePromoted',{name:source.name}):t('sm.noticeMoved',{folder:folderDisplayName(folder)}))
   reload()
  }catch(err:any){
   setError(err.message||t('sm.errMove'))
  }finally{
   setBusyKey(null)
  }
 }

 async function createFolderAndMove(event:FormEvent,source:ManagedSource){
  event.preventDefault()
  const name=moveNewFolderName.trim()
  if(!name)return
  if(/[\\/]/.test(name)||name==='.'||name==='..'||name.startsWith('.')){setError(t('sm.errBadCategoryName'));return}
  setBusyKey('move:'+source.id);setError('');setNotice('')
  try{
   await apiJson(base+'/folders',{path:name})
   await apiJson(base+'/sources/move',{sourceId:source.id,folder:name})
   setMovingId(null);setMoveNewFolderOpen(false);setMoveNewFolderName('')
   setNotice(t('sm.noticeCreatedAndMoved',{name}))
   reload()
  }catch(err:any){
   setError(err.message||t('sm.errCreateMove'))
  }finally{
   setBusyKey(null)
  }
 }

 async function deleteSingle(source:ManagedSource){
  setBusyKey('delete:'+source.id);setError('');setNotice('')
  try{
   const result=await apiJson(base+'/sources/delete',{sourceIds:[source.id]})
   setConfirmDeleteId(null)
   setSelectedIds(prev=>{const next=new Set(prev);next.delete(source.id);return next})
   onSourcesDeleted?.(selectedCourseId,result.deletedIds||[source.id],result.attachmentIds||[])
   setNotice(t('sm.noticeDeleted',{name:source.name}))
   reload()
  }catch(err:any){
   setError(err.message||t('sm.errDelete'))
  }finally{
   setBusyKey(null)
  }
 }

 async function batchMove(folder:string,requirePdf=false){
  const ids=[...selectedIds]
  if(!ids.length)return
  setBusyKey('batch-move');setError('');setNotice('')
  try{
   await apiJson(base+'/sources/move-batch',{sourceIds:ids,folder,requirePdf})
   setSelectedIds(new Set());setConfirmBatchDelete(false)
   setNotice(requirePdf?t('sm.noticeBatchPromoted',{count:ids.length}):t('sm.noticeBatchMoved',{count:ids.length,folder:folderDisplayName(folder)}))
   reload()
  }catch(err:any){
   setError(err.message||t('sm.errBatchMove'))
  }finally{
   setBusyKey(null)
  }
 }

 async function batchDelete(){
  const ids=[...selectedIds]
  if(!ids.length)return
  setBusyKey('batch-delete');setError('');setNotice('')
  try{
   const result=await apiJson(base+'/sources/delete',{sourceIds:ids})
   setSelectedIds(new Set());setConfirmBatchDelete(false)
   onSourcesDeleted?.(selectedCourseId,result.deletedIds||ids,result.attachmentIds||[])
   setNotice(t('sm.noticeBatchDeleted',{count:(result.deletedIds||ids).length}))
   reload()
  }catch(err:any){
   setError(err.message||t('sm.errBatchDelete'))
  }finally{
   setBusyKey(null)
  }
 }

 async function createFolder(event:FormEvent){
  event.preventDefault()
  const name=newFolderInput.trim()
  if(!name)return
  if(/[\\/]/.test(name)||name==='.'||name==='..'||name.startsWith('.')){setError(t('sm.errBadCategoryName'));return}
  setBusyKey('folder-create');setError('');setNotice('')
  try{
   await apiJson(base+'/folders',{path:name})
   setCreatingFolder(false);setNewFolderInput('')
   setFolderFilter(name)
   setNotice(t('sm.noticeCategoryCreated',{name}))
   reload()
  }catch(err:any){
   setError(err.message||t('sm.errCreateCategory'))
  }finally{
   setBusyKey(null)
  }
 }

 async function submitRenameFolder(event:FormEvent){
  event.preventDefault()
  if(!renamingFolder)return
  const leaf=renameFolderInput.trim()
  if(!leaf){setRenamingFolder(null);return}
  if(/[\\/]/.test(leaf)||leaf==='.'||leaf==='..'||leaf.startsWith('.')){setError(t('sm.errBadCategoryName'));return}
  const parent=renamingFolder.includes('/')?renamingFolder.slice(0,renamingFolder.lastIndexOf('/')):''
  const nextPath=parent?`${parent}/${leaf}`:leaf
  if(nextPath===renamingFolder){setRenamingFolder(null);return}
  setBusyKey('folder-rename');setError('');setNotice('')
  try{
   await apiJson(base+'/folders/rename',{path:renamingFolder,newPath:nextPath})
   setRenamingFolder(null);setFolderFilter(nextPath)
   setNotice(t('sm.noticeCategoryRenamed',{name:folderDisplayName(nextPath)}))
   reload()
  }catch(err:any){
   setError(err.message||t('sm.errRenameCategory'))
  }finally{
   setBusyKey(null)
  }
 }

 async function deleteSelectedFolder(path:string){
  setBusyKey('folder-delete');setError('');setNotice('')
  try{
   await apiJson(base+'/folders/delete',{path})
   setConfirmDeleteFolder(null);setFolderFilter('__all__')
   setNotice(t('sm.noticeCategoryDeleted',{name:folderDisplayName(path)}))
   reload()
  }catch(err:any){
   setError(err.message||t('sm.errDeleteCategory'))
  }finally{
   setBusyKey(null)
  }
 }

 async function retryPendingImports(){
  if(!pendingImports.length)return
  setBusyKey('retry-imports');setError('')
  try{
   for(const jobId of new Set(pendingImports.map(item=>item.jobId))){
    await apiJson(base+'/imports/retry',{jobId})
   }
   reload()
  }catch(err:any){
   setError(err.message||t('sm.errRetryImports'))
  }finally{
   setBusyKey(null)
  }
 }

 function stopEscape(event:KeyboardEvent,onCancel:()=>void){
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onCancel()}
 }

 const dropHint=typeFilter==='courseware'||folderFilter==='课件'
  ?t('sm.dropCourseware',{course:selectedCourseLabel})
  :folderFilter!=='__all__'
   ?t('sm.dropFolder',{folder:folderFilter==='__root__'?t('folder.uncategorized'):folderDisplayName(folderFilter)})
   :t('sm.dropAutoOrg',{course:selectedCourseLabel})

 return <div
  className={'sm-root'+(dragging?' is-dragging':'')}
  onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.stopPropagation();setDragging(true)}}}
  onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDragging(false)}}
  onDrop={handleDrop}
 >
  <input ref={coursewareInput} type="file" accept=".pdf,application/pdf" multiple className="sr-only" aria-label={t('sm.uploadCoursewareAria')} onChange={event=>void uploadFiles(event.target.files,'courseware')}/>
  <input ref={materialInput} type="file" multiple className="sr-only" aria-label={t('sm.uploadMaterialsAria')} onChange={event=>void uploadFiles(event.target.files,'material')}/>

  {dragging&&<div className="sm-drop-overlay" aria-hidden="true"><Upload size={26}/><strong>{dropHint}</strong><span>{t('sm.maxFileSize',{limit:MATERIAL_SIZE_LABEL})}</span></div>}

  <div className="sm-course-strip" role="tablist" aria-label={t('sm.selectCourseAria')}>
   {courses.map(course=>{
    const selected=course.id===selectedCourseId
    return <button
     key={course.id}
     type="button"
     role="tab"
     aria-selected={selected}
     className={'sm-course-pill'+(selected?' is-active':'')}
     onClick={()=>onSelectCourse(course.id)}
    >
     <CourseAvatar courseId={course.id} size={18} interactive={false}/>
     <span>{courseDisplayName(course)}</span>
     {course.id===activeCourseId&&<em className="sm-pill-dot" title={t('settings.currentCourseDot')}/>}
    </button>
   })}
  </div>

  <div className="sm-overview-bar">
   <div className="sm-metrics">
    <span className="sm-metric"><strong>{counts.courseware}</strong> {t('sm.metricCourseware',{count:''}).trim()}</span>
    <span className="sm-metric-sep" aria-hidden="true">·</span>
    <span className="sm-metric"><strong>{counts.material}</strong> {t('sm.metricMaterials',{count:''}).trim()}</span>
    <span className="sm-metric-sep" aria-hidden="true">·</span>
    <span className="sm-metric sm-tabular">{formatBytes(counts.totalBytes)}</span>
   </div>
   <div className="sm-upload-actions">
    <button type="button" className="settings-btn-accent" disabled={uploading||!!busyKey} onClick={()=>coursewareInput.current?.click()}>
     <Presentation size={14}/>{t('sm.uploadCourseware')}
    </button>
    <button type="button" className="settings-btn-secondary" disabled={uploading||!!busyKey} onClick={()=>materialInput.current?.click()}>
     <Upload size={14}/>{folderFilter!=='__all__'&&folderFilter!=='课件'?t('sm.uploadToFolder',{folder:folderFilter==='__root__'?t('folder.uncategorized'):folderDisplayName(folderFilter)}):t('sm.uploadMaterials')}
    </button>
   </div>
  </div>

  {uploading&&<div className="sm-banner is-info" role="status"><span className="spinner"/><span>{uploadStatus||t('sm.uploadingDefault')}</span></div>}

  {activeImportIds.length>0?<div className="sm-banner is-info" role="status">
   <span className="spinner"/><span>{t('sm.bgOrganizing',{count:activeImportIds.length})}</span>
  </div>:pendingImports.length>0&&<div className="sm-banner is-warn" role="status">
   <div className="sm-banner-head">
    <Sparkles size={14}/>
    <button type="button" className="sm-banner-toggle" aria-expanded={showPendingDetails} onClick={()=>setShowPendingDetails(v=>!v)}>
     <span>{t('sm.pendingConfirm',{count:pendingImports.length})}</span>
     <ChevronDown size={13} className={showPendingDetails?'is-rotated':''}/>
    </button>
    <button type="button" className="sm-banner-action" disabled={!!busyKey} onClick={()=>void retryPendingImports()}>
     <RefreshCw size={12}/>{busyKey==='retry-imports'?t('sm.reorganizing'):t('sm.reorganize')}
    </button>
   </div>
   {showPendingDetails&&<ul className="sm-pending-list">
    {pendingImports.map(item=>{
     const matched=sources.find(s=>s.attachmentId===item.attachmentId||s.id===item.sourceId)
     return <li key={item.attachmentId}>
      <div className="sm-pending-info">
       <strong>{item.name}</strong>
       <span>{item.reason}</span>
      </div>
      {matched&&<div className="sm-pending-controls">
       <select aria-label={t('sm.chooseCategoryFor',{name:matched.name})} value={matched.folder||''} disabled={!!busyKey} onChange={event=>void moveSingle(matched,event.target.value)}>
        {moveTargetOptions.map(path=><option key={path} value={path}>{folderDisplayName(path)}</option>)}
       </select>
       <button type="button" disabled={!!busyKey} onClick={()=>void moveSingle(matched,matched.folder||'')}>{t('sm.confirmKeep')}</button>
      </div>}
     </li>
    })}
   </ul>}
  </div>}

  {error&&<div className="settings-alert is-error" role="alert"><AlertCircle size={15}/><span>{error}</span><button type="button" aria-label={t('app.closeNotice')} onClick={()=>setError('')}><X size={13}/></button></div>}
  {notice&&<div className="settings-alert is-success" role="status"><Check size={14}/><span>{notice}</span><button type="button" aria-label={t('app.closeNotice')} onClick={()=>setNotice('')}><X size={13}/></button></div>}

  <div className="sm-toolbar">
   <div className="sm-segmented" role="group" aria-label={t('sm.filterTypeAria')}>
    {([
     {id:'all',label:t('sm.filterAll'),count:counts.total},
     {id:'courseware',label:t('sm.filterCourseware'),count:counts.courseware},
     {id:'material',label:t('sm.filterMaterial'),count:counts.material}
    ] as {id:TypeFilter;label:string;count:number}[]).map(item=><button
     key={item.id}
     type="button"
     className={typeFilter===item.id?'is-active':''}
     aria-pressed={typeFilter===item.id}
     onClick={()=>setTypeFilter(item.id)}
    >{item.label}<small>{item.count}</small></button>)}
   </div>

   <label className="sm-search">
    <Search size={14}/>
    <input type="search" aria-label={t('sm.searchAria')} placeholder={t('sm.searchPlaceholder')} value={query} onChange={event=>setQuery(event.target.value)}/>
    {query&&<button type="button" aria-label={t('app.clearSearch')} onClick={()=>setQuery('')}><X size={13}/></button>}
   </label>

   <select className="sm-sort" aria-label={t('sm.sortAria')} value={sortBy} onChange={event=>setSortBy(event.target.value as SortMode)}>
    <option value="name">{t('sm.sortName')}</option>
    <option value="recent">{t('sm.sortRecent')}</option>
    <option value="size">{t('sm.sortSize')}</option>
   </select>
  </div>

  <div className="sm-folder-bar" aria-label={t('sm.folderBarAria')}>
   <div className="sm-folder-chips">
    <button type="button" className={'sm-chip'+(folderFilter==='__all__'?' is-active':'')} onClick={()=>{setFolderFilter('__all__');setRenamingFolder(null);setConfirmDeleteFolder(null)}}>
     {t('sm.allCategories')}<small>{counts.total}</small>
    </button>
    {counts.rootCount>0&&<button type="button" className={'sm-chip'+(folderFilter==='__root__'?' is-active':'')} onClick={()=>{setFolderFilter('__root__');setRenamingFolder(null);setConfirmDeleteFolder(null)}}>
     {t('folder.uncategorized')}<small>{counts.rootCount}</small>
    </button>}
    {existingFolders.map(path=><button
     key={path}
     type="button"
     className={'sm-chip'+(folderFilter===path?' is-active':'')}
     onClick={()=>{setFolderFilter(path);setRenamingFolder(null);setConfirmDeleteFolder(null)}}
    >
     <Folder size={12}/><span>{folderDisplayName(path)}</span><small>{counts.byFolder.get(path)||0}</small>
    </button>)}
    {creatingFolder?<form className="sm-inline-folder-form" onSubmit={event=>void createFolder(event)}>
     <input ref={newFolderRef} aria-label={t('sidebar.newCategoryName')} placeholder={t('sm.newCategoryPlaceholder')} value={newFolderInput} maxLength={60} onChange={event=>setNewFolderInput(event.target.value)} onKeyDown={event=>stopEscape(event,()=>{setCreatingFolder(false);setNewFolderInput('')})}/>
     <button type="submit" disabled={!newFolderInput.trim()||!!busyKey}>{t('app.add')}</button>
     <button type="button" aria-label={t('sm.cancelNewCategory')} onClick={()=>{setCreatingFolder(false);setNewFolderInput('')}}><X size={12}/></button>
    </form>:<button type="button" className="sm-chip sm-chip-add" disabled={!!busyKey} onClick={()=>{setCreatingFolder(true);setRenamingFolder(null);setConfirmDeleteFolder(null)}}>
     <FolderPlus size={12}/>{t('sm.newCategory')}
    </button>}
   </div>

   {folderFilter!=='__all__'&&folderFilter!=='__root__'&&<div className="sm-folder-manage">
    {renamingFolder===folderFilter?<form className="sm-inline-folder-form" onSubmit={event=>void submitRenameFolder(event)}>
     <input ref={renameFolderRef} aria-label={t('sm.renameCategory')} value={renameFolderInput} maxLength={60} onChange={event=>setRenameFolderInput(event.target.value)} onKeyDown={event=>stopEscape(event,()=>setRenamingFolder(null))}/>
     <button type="submit" disabled={!renameFolderInput.trim()||!!busyKey}>{t('app.save')}</button>
     <button type="button" onClick={()=>setRenamingFolder(null)}>{t('app.cancel')}</button>
    </form>:confirmDeleteFolder===folderFilter?<div className="sm-inline-confirm">
     <span>{t('sm.confirmDeleteEmptyCategory')}</span>
     <button type="button" className="is-danger" disabled={!!busyKey||courseLocked} onClick={()=>void deleteSelectedFolder(folderFilter)}>{t('app.delete')}</button>
     <button type="button" onClick={()=>setConfirmDeleteFolder(null)}>{t('app.cancel')}</button>
    </div>:<>
     <button type="button" className="sm-folder-action" disabled={!!busyKey||courseLocked} title={courseLocked?t('sm.renameBusyTitle'):undefined} onClick={()=>{const leaf=folderFilter.split('/').pop()||folderFilter;setRenamingFolder(folderFilter);setRenameFolderInput(leaf);setConfirmDeleteFolder(null)}}>
      <Pencil size={12}/>{t('sm.renameCategory')}
     </button>
     {!selectedFolderHasChildren&&<button type="button" className="sm-folder-action is-danger" disabled={!!busyKey||courseLocked} onClick={()=>{setConfirmDeleteFolder(folderFilter);setRenamingFolder(null)}}>
      <Trash2 size={12}/>{t('sm.deleteEmptyCategory')}
     </button>}
    </>}
   </div>}
  </div>

  {loading&&!sources.length?<div className="settings-state-loading" role="status"><span className="spinner"/>{t('sm.loadingMaterials')}</div>:visibleSources.length===0?<div className="sm-empty">
   <div className="sm-empty-icon">{typeFilter==='courseware'?<Presentation size={24}/>:<FileText size={24}/>}</div>
   {sources.length===0?<>
    <h3>{t('sm.emptyCourseTitle',{course:selectedCourseLabel})}</h3>
    <p>{t('sm.emptyCourseDesc')}</p>
    <div className="sm-empty-actions">
     <button type="button" className="settings-btn-accent" disabled={uploading} onClick={()=>coursewareInput.current?.click()}><Presentation size={14}/>{t('sm.uploadCourseware')}</button>
     <button type="button" className="settings-btn-secondary" disabled={uploading} onClick={()=>materialInput.current?.click()}><Upload size={14}/>{t('sm.uploadMaterials')}</button>
    </div>
   </>:<>
    <h3>{t('sm.emptyFilterTitle')}</h3>
    <p>{t('sm.emptyFilterDesc')}</p>
    <button type="button" className="settings-btn-secondary" onClick={()=>{setTypeFilter('all');setFolderFilter('__all__');setQuery('')}}>{t('sm.clearAllFilters')}</button>
   </>}
  </div>:<div className="sm-list-wrap">
   <div className="sm-list-header">
    <label className="sm-checkbox-wrap">
     <input
      type="checkbox"
      aria-label={t('sm.selectAllAria')}
      checked={allVisibleSelected}
      ref={el=>{if(el)el.indeterminate=selectedVisibleCount>0&&!allVisibleSelected}}
      onChange={toggleSelectAll}
     />
     <span>{t('sm.colFileName',{count:visibleSources.length})}</span>
    </label>
    <span className="sm-col-meta">{t('sm.colMeta')}</span>
    <span className="sm-col-actions">{t('sm.colActions')}</span>
   </div>

   <div className="sm-list" role="list">
    {visibleSources.map(source=>{
     const badge=fileBadge(source)
     const courseware=isReadableCourseware(source)
     const readingNow=selectedCourseId===activeCourseId&&currentSourceId===source.id
     const pending=pendingBySourceId.get(source.id)
     const checked=selectedIds.has(source.id)
     const isRenaming=renamingId===source.id
     const isMoving=movingId===source.id
     const isConfirmingDelete=confirmDeleteId===source.id
     const downloadUrl=(source.url||`/api/courses/${encodeURIComponent(selectedCourseId)}/sources/${encodeURIComponent(source.id)}/file`)+'?download=1'
     const dateLabel=formatShortDate(source.modifiedAt||source.uploadedAt,locale)

     return <div key={source.id} role="listitem" className={'sm-row-wrap'+(checked?' is-selected':'')+(isMoving||isRenaming?' is-editing':'')}>
      <div className="sm-row">
       <label className="sm-row-check">
        <input type="checkbox" aria-label={t('sm.selectItemAria',{name:source.name})} checked={checked} onChange={()=>toggleSelect(source.id)}/>
       </label>

       <span className={'sm-file-icon is-'+badge.kind} aria-hidden="true">{badge.icon}</span>

       <div className="sm-row-main">
        {isRenaming?<form className="sm-rename-form" onSubmit={event=>void submitRename(event,source)}>
         <div className="sm-rename-input-group">
          <input
           ref={renameInputRef}
           aria-label={t('sm.newFileNameAria')}
           value={renameStem}
           maxLength={220}
           disabled={!!busyKey}
           onChange={event=>setRenameStem(event.target.value)}
           onKeyDown={event=>stopEscape(event,()=>setRenamingId(null))}
          />
          {renameExt&&<span className="sm-rename-ext">{renameExt}</span>}
         </div>
         <button type="submit" className="settings-btn-primary-xs" disabled={!renameStem.trim()||!!busyKey}>{t('app.save')}</button>
         <button type="button" className="settings-btn-ghost-xs" onClick={()=>setRenamingId(null)}>{t('app.cancel')}</button>
        </form>:<>
         <button
          type="button"
          className="sm-row-title"
          title={t('sm.openPathTitle',{path:source.relativePath})}
          disabled={!!busyKey||(conversationBusy&&selectedCourseId!==activeCourseId)}
          onClick={()=>void onOpenSource?.(selectedCourseId,source.id)}
         >
          <span>{source.name}</span>
         </button>
         <div className="sm-row-tags">
          <span className={'sm-tag '+(courseware?'is-courseware':'is-folder')}>{courseware?t('sm.tagCourseware'):folderDisplayName(source.folder)}</span>
          {courseware&&source.folder&&source.folder!=='课件'&&<span className="sm-tag is-subtle">{folderDisplayName(source.folder)}</span>}
          {readingNow&&<span className="sm-tag is-reading">{t('sm.tagReading')}</span>}
          {pending&&<span className="sm-tag is-warn">{t('sm.tagPending')}</span>}
          {isSlides(source)&&<span className="sm-tag is-subtle">{t('sidebar.convertSlidesHint')}</span>}
         </div>
        </>}
       </div>

       <div className="sm-row-meta sm-tabular">
        <span>{formatBytes(source.size)}</span>
        {dateLabel&&<small>{dateLabel}</small>}
       </div>

       <div className="sm-row-actions">
        {isConfirmingDelete?<div className="sm-inline-confirm" onKeyDown={event=>stopEscape(event,()=>setConfirmDeleteId(null))}>
         <button type="button" className="is-danger" disabled={!!busyKey||courseLocked} onClick={()=>void deleteSingle(source)}>{busyKey==='delete:'+source.id?t('app.deleting'):t('sm.confirmDelete')}</button>
         <button type="button" onClick={()=>setConfirmDeleteId(null)}>{t('app.cancel')}</button>
        </div>:<>
         {onOpenSource&&<button type="button" className="sm-icon-btn" title={t('sm.openInWorkspace')} aria-label={t('sm.openItemAria',{name:source.name})} disabled={!!busyKey||(conversationBusy&&selectedCourseId!==activeCourseId)} onClick={()=>void onOpenSource(selectedCourseId,source.id)}>
          <ArrowUpRight size={14}/>
         </button>}
         <button type="button" className={'sm-icon-btn'+(isMoving?' is-active':'')} title={t('sm.moveTitle')} aria-label={t('sm.moveItemAria',{name:source.name})} aria-expanded={isMoving} disabled={!!busyKey} onClick={()=>{setMovingId(isMoving?null:source.id);setMoveNewFolderOpen(false);setMoveNewFolderName('');setRenamingId(null);setConfirmDeleteId(null)}}>
          <FolderInput size={14}/>
         </button>
         <button type="button" className={'sm-icon-btn'+(isRenaming?' is-active':'')} title={courseLocked?t('sm.renameFileBusyTitle'):t('sm.renameTitle')} aria-label={t('sm.renameItemAria',{name:source.name})} disabled={!!busyKey||courseLocked} onClick={()=>startRename(source)}>
          <Pencil size={14}/>
         </button>
         <a className="sm-icon-btn" href={downloadUrl} download={source.name} title={t('sm.downloadOriginal')} aria-label={t('sm.downloadItemAria',{name:source.name})}>
          <Download size={14}/>
         </a>
         <button type="button" className="sm-icon-btn is-danger" title={courseLocked?t('sm.deleteFileBusyTitle'):t('sm.deleteFile')} aria-label={t('sm.deleteItemAria',{name:source.name})} disabled={!!busyKey||courseLocked} onClick={()=>{setConfirmDeleteId(source.id);setMovingId(null);setRenamingId(null)}}>
          <Trash2 size={14}/>
         </button>
        </>}
       </div>
      </div>

      {isMoving&&<div className="sm-move-drawer" onKeyDown={event=>stopEscape(event,()=>setMovingId(null))}>
       <div className="sm-move-row">
        <label className="sm-move-select-wrap">
         <span>{t('sm.moveToCategory')}</span>
         <select aria-label={t('sm.chooseNewCategoryAria',{name:source.name})} value={source.folder||''} disabled={!!busyKey} onChange={event=>void moveSingle(source,event.target.value)}>
          {moveTargetOptions.map(path=><option key={path} value={path}>{folderDisplayName(path)}</option>)}
         </select>
        </label>
        {isPdf(source)&&!courseware&&<button type="button" className="settings-btn-accent-xs" disabled={!!busyKey} onClick={()=>void moveSingle(source,'课件',true)}>
         <Presentation size={12}/>{t('sm.promoteCourseware')}
        </button>}
        {courseware&&<button type="button" className="settings-btn-secondary-xs" disabled={!!busyKey} onClick={()=>void moveSingle(source,'教材')}>
         {t('sm.demoteMaterial')}
        </button>}
        <button type="button" className="settings-btn-ghost-xs" disabled={!!busyKey} onClick={()=>setMoveNewFolderOpen(v=>!v)}>
         <Plus size={12}/>{t('sm.newCategory')}
        </button>
        <button type="button" className="sm-icon-btn" aria-label={t('sm.closeMoveDrawer')} onClick={()=>setMovingId(null)}><X size={13}/></button>
       </div>
       {moveNewFolderOpen&&<form className="sm-move-new-form" onSubmit={event=>void createFolderAndMove(event,source)}>
        <input autoFocus aria-label={t('sidebar.newCategoryName')} placeholder={t('sm.newCategoryInputPlaceholder')} value={moveNewFolderName} maxLength={60} disabled={!!busyKey} onChange={event=>setMoveNewFolderName(event.target.value)}/>
        <button type="submit" className="settings-btn-primary-xs" disabled={!moveNewFolderName.trim()||!!busyKey}>{t('sm.createAndMove')}</button>
       </form>}
      </div>}
     </div>
    })}
   </div>
  </div>}

  {selectedIds.size>0&&<div className="sm-batch-bar" role="region" aria-label={t('sm.batchAria')}>
   <span className="sm-batch-count"><strong>{t('sm.batchSelected',{count:selectedIds.size})}</strong></span>
   <div className="sm-batch-controls">
    {confirmBatchDelete?<>
     <span className="sm-batch-warn">{t('sm.batchDeleteWarn')}</span>
     <button type="button" className="sm-batch-btn is-danger" disabled={!!busyKey||courseLocked} onClick={()=>void batchDelete()}>{busyKey==='batch-delete'?t('app.deleting'):t('sm.batchConfirmDelete',{count:selectedIds.size})}</button>
     <button type="button" className="sm-batch-btn" onClick={()=>setConfirmBatchDelete(false)}>{t('app.cancel')}</button>
    </>:<>
     <div className="sm-batch-move">
      <select aria-label={t('sm.batchMoveAria')} value={batchMoveFolder} disabled={!!busyKey} onChange={event=>setBatchMoveFolder(event.target.value)}>
       {moveTargetOptions.map(path=><option key={path} value={path}>{folderDisplayName(path)}</option>)}
      </select>
      <button type="button" className="sm-batch-btn" disabled={!!busyKey} onClick={()=>void batchMove(batchMoveFolder)}>{t('sm.batchMoveBtn')}</button>
     </div>
     {canPromoteSelectedToCourseware&&<button type="button" className="sm-batch-btn is-accent" disabled={!!busyKey} onClick={()=>void batchMove('课件',true)}>
      <Presentation size={13}/>{t('sm.batchSetCourseware')}
     </button>}
     <button type="button" className="sm-batch-btn is-danger-soft" disabled={!!busyKey||courseLocked} title={courseLocked?t('sm.deleteFileBusyTitle'):undefined} onClick={()=>setConfirmBatchDelete(true)}>
      <Trash2 size={13}/>{t('app.delete')}
     </button>
     <button type="button" className="sm-batch-close" aria-label={t('sm.clearSelection')} onClick={()=>setSelectedIds(new Set())}><X size={14}/></button>
    </>}
   </div>
  </div>}
 </div>
}
