import {useEffect,useRef,useState,type FormEvent} from 'react'
import {AlertCircle,Archive,ArrowUpRight,BookOpen,ChevronRight,FilePenLine,FolderOpen,Plus,RotateCcw,Save,X} from 'lucide-react'
import {CourseAvatar} from './CourseAvatar'
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

const collator=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'})

function CourseInstructionsEditor({courseId,onChanged}:{courseId:string;onChanged?:()=>void}){
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
    if(!res.ok)throw new Error(value.error||'课程说明读取失败')
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
 },[courseId])

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
   if(!res.ok)throw new Error(value.error||'课程说明保存失败')
   setBaseline({content:draft,version:value.instructionsVersion||value.version||baseline.version})
   setSaved(true)
   onChanged?.()
  }catch(err:any){
   setError(err.message||'课程说明保存失败')
  }finally{
   setSaving(false)
  }
 }

 const dirty=baseline!==null&&draft!==baseline.content

 return <div className="sc-instructions">
  {error&&<div className="settings-alert is-error" role="alert"><AlertCircle size={14}/><span>{error}</span></div>}
  {loading?<div className="settings-state-loading"><span className="spinner"/>正在读取课程说明…</div>:data&&<>
   <div className="sc-instructions-head">
    <div>
     <strong>课程学习约定（AGENTS.md）</strong>
     <p>每次对话前自动读取，可用于指定教材风格、公式记号、重点方向或讲解深度。</p>
    </div>
    <button type="button" className="settings-btn-primary-xs" disabled={saving||!dirty} onClick={()=>void save()}>
     <Save size={12}/>{saving?'保存中…':saved&&!dirty?'已保存':'保存说明'}
    </button>
   </div>
   <textarea
    aria-label="课程说明 AGENTS.md"
    spellCheck={false}
    value={draft}
    onChange={event=>{setDraft(event.target.value);setSaved(false)}}
    onKeyDown={event=>{if(event.key==='Escape')event.stopPropagation()}}
   />
   {data.memory.length>0&&<div className="sc-memory-box">
    <span className="sc-memory-title">已记录的学习偏好与课程规则（{data.memory.length}）</span>
    <ul>
     {data.memory.map(item=><li key={item.id}><span className="sc-memory-tag">{item.category==='preferences'?'偏好':'规则'}</span><span>{item.text}</span></li>)}
    </ul>
   </div>}
   {data.workspacePath&&<p className="sc-workspace-path" title={data.workspacePath}>目录：{data.workspacePath}</p>}
  </>}
 </div>
}

export function SettingsCourses({courses,activeCourseId,conversationBusy,loading=false,loadError='',onCreate,onArchive,onOpen,onManageMaterials,onChanged}:Props){
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
  return collator.compare(a.name,b.name)
 })
 const archived=courses.filter(course=>!!course.archivedAt).sort((a,b)=>collator.compare(a.name,b.name))

 useEffect(()=>{if(adding)nameInput.current?.focus()},[adding])

 async function perform(key:string,action:()=>Promise<void>|void){
  if(pending)return
  setError('');setPending(key)
  try{await action()}catch(err){setError((err as Error).message||'操作未完成，请重试。')}
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
   <p className="sc-subtitle">共 {active.length} 门活跃课程{archived.length>0?`，${archived.length} 门已归档`:''}。点击课程头像可重新生成专属图标。</p>
   <button type="button" className="settings-btn-accent" aria-expanded={adding} disabled={!!pending||loading} onClick={()=>{setAdding(v=>!v);setError('')}}>
    <Plus size={14}/>添加课程
   </button>
  </div>

  {adding&&<form className="sc-create-card" onSubmit={handleCreate}>
   <input
    ref={nameInput}
    aria-label="课程名称"
    placeholder="输入新课程名称，例如：有机化学、线性代数…"
    value={name}
    maxLength={80}
    disabled={!!pending||loading}
    onChange={event=>setName(event.target.value)}
    onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setAdding(false)}}}
   />
   <button type="submit" className="settings-btn-primary" disabled={!name.trim()||!!pending||loading}>{pending==='create'?'正在添加…':'创建课程'}</button>
   <button type="button" className="settings-btn-ghost" disabled={!!pending||loading} onClick={()=>setAdding(false)}>取消</button>
  </form>}

  {(error||loadError)&&<div className="settings-alert is-error" role="alert"><AlertCircle size={15}/><span>{error||loadError}</span><button type="button" aria-label="关闭错误" onClick={()=>setError('')}><X size={13}/></button></div>}
  {loading&&!courses.length&&<div className="settings-state-loading" role="status"><span className="spinner"/>正在读取课程…</div>}

  <div className="sc-list">
   {active.map(course=>{
    const current=course.id===activeCourseId
    const instructionsOpen=editingInstructionsId===course.id
    const confirmingArchive=confirmArchiveId===course.id
    const stats=course.stats
    return <article key={course.id} className={'sc-card'+(current?' is-current':'')+(instructionsOpen?' is-expanded':'')}>
     <div className="sc-card-main">
      <div className="sc-avatar-wrap">
       <CourseAvatar courseId={course.id} size={36} label={`更换「${course.name}」的课程头像`}/>
      </div>
      <div className="sc-info">
       <div className="sc-title-row">
        <h3>{course.name}</h3>
        {current&&<span className="sc-badge-current">当前课程</span>}
        {course.id==='general'&&<span className="sc-badge-muted">默认</span>}
       </div>
       <p className="sc-meta sm-tabular">
        {stats?`${stats.coursewareCount} 份课件 · ${stats.materialCount} 份资料 · ${formatBytes(stats.totalBytes)}`:'学习工作区已就绪'}
       </p>
      </div>
      <div className="sc-actions">
       <button type="button" className="sc-action-btn" disabled={!!pending||loading||(conversationBusy&&!current)} onClick={()=>void perform('open:'+course.id,()=>onOpen(course.id))}>
        <ArrowUpRight size={13}/>{current?'返回对话':'进入课程'}
       </button>
       <button type="button" className="sc-action-btn" disabled={!!pending||loading} onClick={()=>onManageMaterials(course.id)}>
        <FolderOpen size={13}/>管理资料
       </button>
       <button type="button" className={'sc-action-btn'+(instructionsOpen?' is-active':'')} aria-expanded={instructionsOpen} disabled={!!pending||loading} onClick={()=>{setEditingInstructionsId(instructionsOpen?null:course.id);setConfirmArchiveId(null)}}>
        <FilePenLine size={13}/>课程说明
       </button>
       {course.id!=='general'&&(confirmingArchive?<div className="sm-inline-confirm">
        <button type="button" className="is-danger" disabled={!!pending||loading||(current&&conversationBusy)} onClick={()=>handleArchive(course,true)}>{pending===course.id?'处理中…':'确认归档'}</button>
        <button type="button" onClick={()=>setConfirmArchiveId(null)}>取消</button>
       </div>:<button type="button" className="sc-action-btn is-subtle" disabled={!!pending||loading||(current&&conversationBusy)} title={current&&conversationBusy?'回复完成后可归档':'归档后移出课程列表，资料与对话保留'} onClick={()=>{setConfirmArchiveId(course.id);setEditingInstructionsId(null)}}>
        <Archive size={13}/>归档
       </button>)}
      </div>
     </div>
     {confirmingArchive&&<p className="sc-archive-note">归档后将从主界面课程列表中隐藏，所有资料、课件和对话记录均完整保留，随时可恢复。</p>}
     {instructionsOpen&&<CourseInstructionsEditor courseId={course.id} onChanged={()=>onChanged?.(course.id)}/>}
    </article>
   })}
  </div>

  {!loading&&<details className="sc-archived" open={archived.length>0&&active.length<=2}>
   <summary><ChevronRight size={14}/><span>已归档课程</span><small>{archived.length}</small></summary>
   <div className="sc-archived-list">
    {archived.length?archived.map(course=><div key={course.id} className="sc-archived-row">
     <BookOpen size={16}/>
     <div className="sc-archived-info">
      <strong>{course.name}</strong>
      {course.stats&&<span className="sm-tabular">{course.stats.coursewareCount} 份课件 · {course.stats.materialCount} 份资料 · {formatBytes(course.stats.totalBytes)}</span>}
     </div>
     <button type="button" className="settings-btn-secondary-xs" disabled={!!pending||loading} onClick={()=>handleArchive(course,false)}>
      <RotateCcw size={12}/>{pending===course.id?'正在恢复…':'恢复课程'}
     </button>
    </div>):<p className="sc-archived-empty">暂无归档课程。完成一学期的课程后可在此归档保存。</p>}
   </div>
  </details>}
 </div>
}
