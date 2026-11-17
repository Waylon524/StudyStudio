import {useEffect,useRef,useState,type FormEvent} from 'react'
import {Archive,ArrowUpRight,BookOpen,ChevronDown,ChevronRight,Plus,RotateCcw,X} from 'lucide-react'
import './settings.css'
import {DailyCourseManagement,type RequirementSource} from './CourseRequirements'

export type ManagedCourse={id:string;name:string;archivedAt?:string}
type Props={
 courses:ManagedCourse[]
 activeCourseId:string
 conversationBusy:boolean
 loading?:boolean
 loadError?:string
 onCreate:(name:string)=>Promise<void>
 onArchive:(id:string,archived:boolean)=>Promise<void>
 onOpen:(id:string)=>Promise<void>|void
 onClose:()=>void
 onChanged?:(courseId:string)=>void
 onOpenSource?:(courseId:string,sourceId:string,page?:number)=>Promise<void>|void
 onOpenConversation?:(courseId:string,source:RequirementSource)=>Promise<void>|void
 revision?:number
}
const collator=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'})

export function SettingsPage({courses,activeCourseId,conversationBusy,loading=false,loadError='',onCreate,onArchive,onOpen,onClose,onChanged,onOpenSource,onOpenConversation,revision}:Props){
 const [expanded,setExpanded]=useState<string|null>(null),[adding,setAdding]=useState(false),[name,setName]=useState('')
 const [pending,setPending]=useState<string|null>(null),[error,setError]=useState(''),[dailyOpen,setDailyOpen]=useState<string|null>(null)
 const dialog=useRef<HTMLDivElement>(null),nameInput=useRef<HTMLInputElement>(null),closeRef=useRef(onClose)
 closeRef.current=onClose
 const active=courses.filter(course=>!course.archivedAt).sort((a,b)=>collator.compare(a.name,b.name))
 const archived=courses.filter(course=>!!course.archivedAt).sort((a,b)=>collator.compare(a.name,b.name))
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null
  dialog.current?.querySelector<HTMLButtonElement>('.settings-close')?.focus()
  const keydown=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeRef.current();return}
   if(event.key!=='Tab')return
   const focusable=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')||[]).filter(element=>element.getClientRects().length>0)
   const first=focusable[0],last=focusable.at(-1)
   if(!first){event.preventDefault();return}
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
  }
  document.addEventListener('keydown',keydown,true)
  return()=>{document.removeEventListener('keydown',keydown,true);if(previous?.isConnected)previous.focus()}
 },[])
 useEffect(()=>{if(adding)nameInput.current?.focus()},[adding])
 async function perform(key:string,action:()=>Promise<void>|void){
  if(pending)return
  setError('');setPending(key)
  try{await action()}catch(error){setError((error as Error).message||'操作未完成，请重试。')}
  finally{setPending(null)}
 }
 function create(event:FormEvent){
  event.preventDefault();const value=name.trim();if(!value)return
  void perform('create',async()=>{await onCreate(value);setAdding(false);setName('')})
 }
 function archive(course:ManagedCourse,value:boolean){
  void perform(course.id,async()=>{await onArchive(course.id,value);setExpanded(null)})
 }
 return <div className="settings-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}>
  <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="study-settings-title" className="settings-page">
   <header className="settings-header"><h1 id="study-settings-title">设置</h1><button className="settings-close" type="button" aria-label="关闭设置" onClick={onClose}><X size={19}/></button></header>
   <div className="settings-body">
    <section className="settings-courses" aria-labelledby="settings-courses-title">
     <div className="settings-section-heading"><h2 id="settings-courses-title">课程</h2><button type="button" className="settings-add" aria-expanded={adding} onClick={()=>{setAdding(value=>!value);setError('')}} disabled={!!pending||loading}><Plus size={15}/>添加课程</button></div>
     {adding&&<form className="settings-create" onSubmit={create}><input ref={nameInput} aria-label="课程名称" placeholder="课程名称" value={name} maxLength={80} onChange={event=>setName(event.target.value)} disabled={!!pending||loading}/><button className="settings-primary" type="submit" disabled={!name.trim()||!!pending||loading}>{pending==='create'?'正在添加…':'添加'}</button><button type="button" className="settings-cancel" onClick={()=>setAdding(false)} disabled={!!pending||loading}>取消</button></form>}
     {(error||loadError)&&<p className="settings-error" role="alert">{error||loadError}</p>}{loading&&<p className="settings-loading" role="status"><span className="spinner"/>正在读取课程…</p>}
     <div className="settings-course-list">
      {active.map(course=>{const open=expanded===course.id,current=course.id===activeCourseId;return <article key={course.id} className={'settings-course'+(open?' is-open':'')}>
       <button type="button" className="settings-course-toggle" aria-expanded={open} onClick={()=>setExpanded(open?null:course.id)}><BookOpen size={20}/><span className="settings-course-name">{course.name}</span>{current&&<small>当前</small>}{open?<ChevronDown size={15}/>:<ChevronRight size={15}/>}</button>
       {open&&<div className="settings-course-options"><div className="settings-course-actions"><button type="button" onClick={()=>void perform(course.id,()=>onOpen(course.id))} disabled={!!pending||loading||conversationBusy&&!current}><ArrowUpRight size={14}/>进入课程</button>{course.id!=='general'&&<button type="button" onClick={()=>archive(course,true)} disabled={!!pending||loading||current&&conversationBusy} title={current&&conversationBusy?'回复完成后可归档':undefined}><Archive size={14}/>{pending===course.id?'正在处理…':'归档课程'}</button>}</div>{course.id!=='general'&&<p>归档后移出课程列表，资料与对话保留。</p>}<details className="settings-daily-section" open={dailyOpen===course.id} onToggle={event=>setDailyOpen(event.currentTarget.open?course.id:null)}><summary><ChevronRight size={13}/>日常管理</summary>{dailyOpen===course.id&&<DailyCourseManagement courseId={course.id} revision={revision} disabled={conversationBusy||!!pending} onChanged={()=>onChanged?.(course.id)} onOpenSource={onOpenSource?(id,page)=>void perform('source',()=>onOpenSource(course.id,id,page)):undefined} onOpenConversation={onOpenConversation?source=>void perform('conversation',()=>onOpenConversation(course.id,source)):undefined}/>}</details></div>}
      </article>})}
     </div>
     {!loading&&<details className="settings-archived"><summary><ChevronRight size={14}/><span>已归档</span><small>{archived.length}</small></summary><div className="settings-archived-list">{archived.length?archived.map(course=><div key={course.id} className="settings-archived-course"><BookOpen size={18}/><span>{course.name}</span><button type="button" onClick={()=>archive(course,false)} disabled={!!pending||loading}><RotateCcw size={13}/>{pending===course.id?'正在恢复…':'恢复'}</button></div>):<p className="settings-empty">暂无归档课程</p>}</div></details>}
    </section>
   </div>
  </div>
 </div>
}
