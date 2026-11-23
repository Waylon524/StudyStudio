import {useEffect,useRef,useState,type FormEvent} from 'react'
import {AlertCircle,Archive,ArrowUpRight,BookOpen,ChevronRight,FilePenLine,FolderOpen,Plus,RotateCcw,Save,X} from 'lucide-react'
import {CourseAvatar} from './CourseAvatar'
import {useI18n} from './i18n'
import {formatBytes,type ManagedCourse} from './settings-types'

type MemoryEntry={id:string;text:string;category:'preferences'|'courseRules';source?:string}
type WorkspaceInstructions={workspacePath:string;instructions:string;instructionsVersion:string;memory:MemoryEntry[]}

type Props={
 courses:ManagedCourse[]
 activeCourseId:string
 conversationBusy:boolean
 loading?:boolean
 loadError?:string
 onCreate:(name:string)=>Promise<void>
 onArchive:(id:string,archived:boolean)=>Promise<void>
 onOpen:(id:string)=>Promise<void>|void
 onManageMaterials:(courseId:string)=>void
 onChanged?:(courseId:string)=>void
}

function CourseInstructionsEditor({courseId,onChanged}:{courseId:string;onChanged?:()=>void}){
 const {t}=useI18n()
 const [data,setData]=useState<WorkspaceInstructions|null>(null)
 const [draft,setDraft]=useState('')
 const [baseline,setBaseline]=useState<{content:string;version:string}|null>(null)
 const [loading,setLoading]=useState(true)
 const [saving,setSaving]=useState(false)
 const [saved,setSaved]=useState(false)
 const [error,setError]=useState('')

 useEffect(()=>{
  const controller=new AbortController()
  setLoading(true);setError('');setSaved(false)
  fetch('/api/courses/'+encodeURIComponent(courseId)+'/workspace',{signal:controller.signal})
   .then(async res=>{
    const value=await res.json()
    if(!res.ok)throw new Error(value.error||t('sc.readInstructionsFailed'))
    if(controller.signal.aborted)return
    setData({
     workspacePath:value.workspacePath||'',
     instructions:value.instructions||'',
     instructionsVersion:value.instructionsVersion||'',
     memory:Array.isArray(value.memory)?value.memory:[]
    })
    setDraft(value.instructions||'')
    setBaseline({content:value.instructions||'',version:value.instructionsVersion||''})
   })
   .catch(err=>{if(err.name!=='AbortError')setError(err.message)})
   .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
  return()=>controller.abort()
 },[courseId,t])

 async function save(){
  if(!baseline||saving||draft===baseline.content)return
  setSaving(true);setError('');setSaved(false)
  try{
   const res=await fetch('/api/courses/'+encodeURIComponent(courseId)+'/instructions',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({content:draft,version:baseline.version})
   })
   const value=await res.json()
   if(!res.ok)throw new Error(value.error||t('sc.saveInstructionsFailed'))
   setBaseline({content:draft,version:value.instructionsVersion||value.version||baseline.version})
   setSaved(true)
   onChanged?.()
  }catch(err:any){
   setError(err.message||t('sc.saveInstructionsFailed'))
  }finally{
   setSaving(false)
  }
 }

 const dirty=baseline!==null&&draft!==baseline.content

 return <div className="sc-instructions">
  {error&&<div className="settings-alert is-error" role="alert"><AlertCircle size={14}/><span>{error}</span></div>}
  {loading?<div className="settings-state-loading"><span className="spinner"/>{t('sc.loadingInstructions')}</div>:data&&<>
   <div className="sc-instructions-head">
    <div>
     <strong>{t('sc.instructionsTitle')}</strong>
     <p>{t('sc.instructionsDesc')}</p>
    </div>
    <button type="button" className="settings-btn-primary-xs" disabled={saving||!dirty} onClick={()=>void save()}>
     <Save size={12}/>{saving?t('app.saving'):saved&&!dirty?t('app.saved'):t('sc.saveInstructions')}
    </button>
   </div>
   <textarea
    aria-label={t('sc.instructionsAria')}
    spellCheck={false}
    value={draft}
    onChange={event=>{setDraft(event.target.value);setSaved(false)}}
    onKeyDown={event=>{if(event.key==='Escape')event.stopPropagation()}}
   />
   {data.memory.length>0&&<div className="sc-memory-box">
    <span className="sc-memory-title">{t('sc.memoryTitle',{count:data.memory.length})}</span>
    <ul>
     {data.memory.map(item=><li key={item.id}><span className="sc-memory-tag">{item.category==='preferences'?t('sc.memoryPreference'):t('sc.memoryRule')}</span><span>{item.text}</span></li>)}
    </ul>
   </div>}
   {data.workspacePath&&<p className="sc-workspace-path" title={data.workspacePath}>{t('sc.dirPrefix',{path:data.workspacePath})}</p>}
  </>}
 </div>
}

export function SettingsCourses({courses,activeCourseId,conversationBusy,loading=false,loadError='',onCreate,onArchive,onOpen,onManageMaterials,onChanged}:Props){
 const {t,collator,courseDisplayName}=useI18n()
 const [adding,setAdding]=useState(false)
 const [name,setName]=useState('')
 const [pending,setPending]=useState<string|null>(null)
 const [error,setError]=useState('')
 const [editingInstructionsId,setEditingInstructionsId]=useState<string|null>(null)
 const [confirmArchiveId,setConfirmArchiveId]=useState<string|null>(null)
 const nameInput=useRef<HTMLInputElement>(null)

 const active=courses.filter(course=>!course.archivedAt).sort((a,b)=>{
  if(a.id===activeCourseId)return -1
  if(b.id===activeCourseId)return 1
  if(a.id==='general')return -1
  if(b.id==='general')return 1
  return collator.compare(courseDisplayName(a),courseDisplayName(b))
 })
 const archived=courses.filter(course=>!!course.archivedAt).sort((a,b)=>collator.compare(courseDisplayName(a),courseDisplayName(b)))

 useEffect(()=>{if(adding)nameInput.current?.focus()},[adding])

 async function perform(key:string,action:()=>Promise<void>|void){
  if(pending)return
  setError('');setPending(key)
  try{await action()}catch(err){setError((err as Error).message||t('app.operationFailed'))}
  finally{setPending(null)}
 }

 function handleCreate(event:FormEvent){
  event.preventDefault()
  const value=name.trim()
  if(!value)return
  void perform('create',async()=>{await onCreate(value);setAdding(false);setName('')})
 }

 function handleArchive(course:ManagedCourse,value:boolean){
  void perform(course.id,async()=>{
   await onArchive(course.id,value)
   setConfirmArchiveId(null)
   if(editingInstructionsId===course.id)setEditingInstructionsId(null)
  })
 }

 return <div className="sc-root">
  <div className="sc-topbar">
   <p className="sc-subtitle">{t('sc.subtitle',{active:active.length,archived:archived.length>0?t('sc.subtitleArchived',{count:archived.length}):''})}</p>
   <button type="button" className="settings-btn-accent" aria-expanded={adding} disabled={!!pending||loading} onClick={()=>{setAdding(v=>!v);setError('')}}>
    <Plus size={14}/>{t('sc.addCourse')}
   </button>
  </div>

  {adding&&<form className="sc-create-card" onSubmit={handleCreate}>
   <input
    ref={nameInput}
    aria-label={t('sc.courseNameAria')}
    placeholder={t('sc.courseNamePlaceholder')}
    value={name}
    maxLength={80}
    disabled={!!pending||loading}
    onChange={event=>setName(event.target.value)}
    onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setAdding(false)}}}
   />
   <button type="submit" className="settings-btn-primary" disabled={!name.trim()||!!pending||loading}>{pending==='create'?t('sc.creating'):t('sc.createCourse')}</button>
   <button type="button" className="settings-btn-ghost" disabled={!!pending||loading} onClick={()=>setAdding(false)}>{t('app.cancel')}</button>
  </form>}

  {(error||loadError)&&<div className="settings-alert is-error" role="alert"><AlertCircle size={15}/><span>{error||loadError}</span><button type="button" aria-label={t('app.closeError')} onClick={()=>setError('')}><X size={13}/></button></div>}
  {loading&&!courses.length&&<div className="settings-state-loading" role="status"><span className="spinner"/>{t('sc.loadingCourses')}</div>}

  <div className="sc-list">
   {active.map(course=>{
    const current=course.id===activeCourseId
    const instructionsOpen=editingInstructionsId===course.id
    const confirmingArchive=confirmArchiveId===course.id
    const stats=course.stats
    const displayName=courseDisplayName(course)
    return <article key={course.id} className={'sc-card'+(current?' is-current':'')+(instructionsOpen?' is-expanded':'')}>
     <div className="sc-card-main">
      <div className="sc-avatar-wrap">
       <CourseAvatar courseId={course.id} size={36} label={t('avatar.changeFor',{name:displayName})}/>
      </div>
      <div className="sc-info">
       <div className="sc-title-row">
        <h3>{displayName}</h3>
        {current&&<span className="sc-badge-current">{t('sc.currentBadge')}</span>}
        {course.id==='general'&&<span className="sc-badge-muted">{t('app.defaultTag')}</span>}
       </div>
       <p className="sc-meta sm-tabular">
        {stats?t('sc.statsLine',{courseware:stats.coursewareCount,materials:stats.materialCount,questions:stats.questionCount??0,bytes:formatBytes(stats.totalBytes)}):t('sc.workspaceReady')}
       </p>
      </div>
      <div className="sc-actions">
       <button type="button" className="sc-action-btn" disabled={!!pending||loading||(conversationBusy&&!current)} onClick={()=>void perform('open:'+course.id,()=>onOpen(course.id))}>
        <ArrowUpRight size={13}/>{current?t('sc.backToChat'):t('sc.openCourse')}
       </button>
       <button type="button" className="sc-action-btn" disabled={!!pending||loading} onClick={()=>onManageMaterials(course.id)}>
        <FolderOpen size={13}/>{t('sc.manageMaterials')}
       </button>
       <button type="button" className={'sc-action-btn'+(instructionsOpen?' is-active':'')} aria-expanded={instructionsOpen} disabled={!!pending||loading} onClick={()=>{setEditingInstructionsId(instructionsOpen?null:course.id);setConfirmArchiveId(null)}}>
        <FilePenLine size={13}/>{t('sc.instructions')}
       </button>
       {course.id!=='general'&&(confirmingArchive?<div className="sm-inline-confirm">
        <button type="button" className="is-danger" disabled={!!pending||loading||(current&&conversationBusy)} onClick={()=>handleArchive(course,true)}>{pending===course.id?t('sc.processing'):t('sc.confirmArchive')}</button>
        <button type="button" onClick={()=>setConfirmArchiveId(null)}>{t('app.cancel')}</button>
       </div>:<button type="button" className="sc-action-btn is-subtle" disabled={!!pending||loading||(current&&conversationBusy)} title={current&&conversationBusy?t('sc.archiveBusyTitle'):t('sc.archiveTitle')} onClick={()=>{setConfirmArchiveId(course.id);setEditingInstructionsId(null)}}>
        <Archive size={13}/>{t('sc.archive')}
       </button>)}
      </div>
     </div>
     {confirmingArchive&&<p className="sc-archive-note">{t('sc.archiveNote')}</p>}
     {instructionsOpen&&<CourseInstructionsEditor courseId={course.id} onChanged={()=>onChanged?.(course.id)}/>}
    </article>
   })}
  </div>

  {!loading&&<details className="sc-archived" open={archived.length>0&&active.length<=2}>
   <summary><ChevronRight size={14}/><span>{t('sc.archivedSection')}</span><small>{archived.length}</small></summary>
   <div className="sc-archived-list">
    {archived.length?archived.map(course=><div key={course.id} className="sc-archived-row">
     <BookOpen size={16}/>
     <div className="sc-archived-info">
      <strong>{courseDisplayName(course)}</strong>
      {course.stats&&<span className="sm-tabular">{t('sc.statsLine',{courseware:course.stats.coursewareCount,materials:course.stats.materialCount,questions:course.stats.questionCount??0,bytes:formatBytes(course.stats.totalBytes)})}</span>}
     </div>
     <button type="button" className="settings-btn-secondary-xs" disabled={!!pending||loading} onClick={()=>handleArchive(course,false)}>
      <RotateCcw size={12}/>{pending===course.id?t('sc.restoring'):t('sc.restoreCourse')}
     </button>
    </div>):<p className="sc-archived-empty">{t('sc.archivedEmpty')}</p>}
   </div>
  </details>}
 </div>
}
