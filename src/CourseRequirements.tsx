import {useEffect,useRef,useState,type FormEvent} from 'react'
import {ChevronDown,ChevronRight,FileText,Pencil,RotateCcw,Trash2} from 'lucide-react'
import {tCurrent,useI18n} from './i18n'
import './requirements.css'

export type RequirementSource={type:'user'|'teacher_report'|'material';quote:string;verification?:'text_matched'|'visual_unverified';sourceId?:string;page?:number;relativePath?:string;name?:string;threadId?:string;turnId?:string}
export type RequirementTiming={start?:string;end?:string;allDay?:boolean;timeText:string;timezone?:string}
export type RequirementRevision={revision:number;kind:string;text:string;conditions?:string;status:'confirmed'|'unverified'|'conflicted'|'withdrawn';createdAt:string;source:RequirementSource;reason?:string;timing?:RequirementTiming;actor?:'user';origin?:string;action?:'update'|'remove'|'restore';actionEvidence?:{quote:string;threadId:string;turnId:string|null}}
export type Requirement=RequirementRevision&{id:string;updatedAt:string;revisions:RequirementRevision[];scheduleDismissed?:boolean}
type Props={courseId:string;revision?:number;refresh?:number;onAskAgent?:(text:string)=>void;onDraftMessage?:(text:string)=>void;onOpenSource?:(id:string,page?:number)=>void}

function useRequirements(courseId:string,revision?:number,refresh?:number){
 const [requirements,setRequirements]=useState<Requirement[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true)
 useEffect(()=>{const controller=new AbortController();setLoading(true);setError('');setRequirements([])
  fetch('/api/courses/'+encodeURIComponent(courseId)+'/requirements',{signal:controller.signal}).then(async response=>{const value=await response.json();if(!response.ok)throw Error(value.error||tCurrent('req.readError'));if(!Array.isArray(value.requirements))throw Error(tCurrent('req.readError'));if(!controller.signal.aborted)setRequirements(value.requirements)}).catch(error=>{if(error.name!=='AbortError')setError(error.message)}).finally(()=>{if(!controller.signal.aborted)setLoading(false)})
  return()=>controller.abort()
 },[courseId,revision,refresh])
 return {requirements,error,loading}
}

export function CourseRequirements({courseId,revision,refresh}:Props){
 const {t}=useI18n()
 const {requirements,error,loading}=useRequirements(courseId,revision,refresh),[open,setOpen]=useState(false)
 const visible=requirements.filter(item=>item.status!=='withdrawn')
 const statusLabel=(status:RequirementRevision['status'])=>status==='confirmed'?t('req.status.confirmed'):status==='unverified'?t('req.status.unverified'):status==='conflicted'?t('req.status.conflicted'):status==='withdrawn'?t('req.status.withdrawn'):status
 return <section className="course-requirements" aria-label={t('req.aria')}>
  <button className="course-requirements-heading" type="button" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{open?<ChevronDown size={13}/>:<ChevronRight size={13}/>}<span>{t('req.title')}</span>{visible.length>0&&<small>{visible.length}</small>}</button>
  {open&&<div className="course-requirements-content">{error?<p className="requirement-error" role="alert">{error}</p>:loading?<p className="requirement-empty">{t('app.loading')}</p>:!visible.length?<p className="requirement-empty">{t('req.empty')}</p>:visible.map(item=><article key={item.id} className={'course-requirement status-'+item.status}>
   <div className="requirement-meta"><span className={'requirement-status '+item.status}>{statusLabel(item.status)}</span></div>
   <p className="requirement-text">{item.text}</p>{item.conditions&&<p className="requirement-condition">{item.conditions}</p>}
  </article>)}</div>}
 </section>
}

function timingLabel(locale:string,timing?:RequirementTiming){
 if(!timing)return ''
 if(!timing.start)return timing.timeText
 const format=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)?value.replace(/-/g,'/'):new Intl.DateTimeFormat(locale,{timeZone:timing.timezone,year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value))
 try{return format(timing.start)+(timing.end?' — '+format(timing.end):'')}catch{return timing.timeText}
}

function SourceHistory({item,onOpenSource,onOpenConversation}:{item:Requirement;onOpenSource?:(id:string,page?:number)=>void;onOpenConversation?:(source:RequirementSource)=>void}){
 const {locale,t,formatDateTime}=useI18n()
 const statusLabel=(status:RequirementRevision['status'])=>status==='confirmed'?t('req.status.confirmed'):status==='unverified'?t('req.status.unverified'):status==='conflicted'?t('req.status.conflicted'):t('req.status.withdrawn')
 const userActionLabel=(entry:RequirementRevision)=>t('req.userAction',{origin:entry.origin==='conversation'?t('req.origin.conversation'):t('req.origin.settings'),action:entry.action==='restore'?t('req.action.restore'):entry.status==='withdrawn'?t('req.action.remove'):t('req.action.update')})
 return <details className="daily-provenance"><summary><ChevronRight size={13}/>{t('req.provenance')}</summary><ol>{[...(item.revisions?.length?item.revisions:[item])].reverse().map(entry=>{
  const source=entry.source,label=source.type==='material'?(source.name||source.relativePath?.split('/').pop()||t('req.sourceMaterial'))+(source.page?' · '+t('sidebar.pageNumber',{page:source.page}):''):source.type==='teacher_report'?t('req.sourceTeacher'):t('req.sourceUser')
  return <li key={entry.revision}><div className="daily-revision-meta"><span>{entry.revision===item.revision?t('req.currentVersion'):t('req.revisionN',{n:entry.revision})} · {entry.actor==='user'?userActionLabel(entry):statusLabel(entry.status)}</span><time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt,{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time></div>
   <p>{entry.text}</p>{entry.conditions&&<p className="daily-detail-muted">{t('req.conditions',{text:entry.conditions})}</p>}{entry.timing&&<p className="daily-detail-muted">{t('req.time',{text:timingLabel(locale,entry.timing)})}</p>}{entry.reason&&<p className="daily-correction-reason">{t('req.reason',{text:entry.reason})}</p>}
   {entry.actionEvidence&&<><div className="daily-source-label">{t('req.turnEvidence')}</div><blockquote>{entry.actionEvidence.quote}</blockquote></>}
   <div className="daily-source-label">{entry.actor==='user'&&<span>{t('req.originalSource')}</span>}{source.sourceId&&onOpenSource?<button type="button" onClick={()=>onOpenSource(source.sourceId!,source.page)}><FileText size={12}/>{label}</button>:source.type!=='material'&&onOpenConversation?<button type="button" onClick={()=>onOpenConversation(source)}>{label}</button>:<span>{label}</span>}</div>
   {source.verification==='visual_unverified'&&<small>{t('req.visualUnverified')}</small>}<blockquote>{source.quote}</blockquote>
  </li>
 })}</ol></details>
}

const pad=(value:number)=>String(value).padStart(2,'0')
function localFields(value?:string){if(!value)return {date:'',time:''};if(/^\d{4}-\d{2}-\d{2}$/.test(value))return {date:value,time:''};const date=new Date(value);return Number.isNaN(date.getTime())?{date:'',time:''}:{date:`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`,time:`${pad(date.getHours())}:${pad(date.getMinutes())}`}}
type EditorProps={item:Requirement;pending:boolean;onSave:(value:Record<string,unknown>)=>Promise<void>;onCancel:()=>void}
function RequirementEditor({item,pending,onSave,onCancel}:EditorProps){
 const {t}=useI18n()
 const start=localFields(item.timing?.start),end=localFields(item.timing?.end)
 const [text,setText]=useState(item.text),[conditions,setConditions]=useState(item.conditions||''),[reason,setReason]=useState(''),[hasTiming,setHasTiming]=useState(!!item.timing),[allDay,setAllDay]=useState(item.timing?.allDay??true)
 const [startDate,setStartDate]=useState(start.date),[startTime,setStartTime]=useState(start.time),[endDate,setEndDate]=useState(end.date),[endTime,setEndTime]=useState(end.time),[timeText,setTimeText]=useState(item.timing?.timeText||''),[error,setError]=useState('')
 const changedTime=()=>setTimeText('')
 async function save(event:FormEvent){
  event.preventDefault();setError('')
  if(!text.trim()||!reason.trim()){setError(t('req.editContentAndReason'));return}
  let timing:RequirementTiming|undefined
  if(hasTiming){
   if(!startDate&&!timeText.trim()){setError(t('req.editDateOrTimeText'));return}
   if(startDate&&!allDay&&!startTime){setError(t('req.editStartTimeOrAllDay'));return}
   if(endDate&&!startDate||endDate&&!allDay&&!endTime){setError(t('req.editEndDateTime'));return}
   const instant=(date:string,time:string)=>allDay?date:new Date(date+'T'+time+':00').toISOString()
   const value=startDate?instant(startDate,startTime):undefined,endValue=endDate?instant(endDate,endTime):undefined
   const summary=timeText.trim()||[startDate,allDay?'':startTime,endDate?t('schedule.toDate',{date:endDate})+(allDay?'':' '+endTime):''].filter(Boolean).join(' ')
   timing={timeText:summary,allDay,...(value?{start:value}:{}),...(endValue?{end:endValue}:{}),...(!allDay?{timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}:{})}
  }
  try{await onSave({expectedRevision:item.revision,text:text.trim(),conditions:conditions.trim(),reason:reason.trim(),...(hasTiming?{timing}:{timing:null})})}catch(error){setError((error as Error).message||t('req.saveFailed'))}
 }
 return <form className="daily-editor" onSubmit={event=>void save(event)}>
  <label>{t('req.fieldContent')}<textarea aria-label={t('req.fieldContentAria')} value={text} onChange={event=>setText(event.target.value)} maxLength={4000} required disabled={pending}/></label>
  <label>{t('req.fieldConditions')}<input aria-label={t('req.fieldConditions')} value={conditions} onChange={event=>setConditions(event.target.value)} maxLength={2000} disabled={pending}/></label>
  <label className="daily-checkbox"><input type="checkbox" checked={hasTiming} onChange={event=>setHasTiming(event.target.checked)} disabled={pending}/>{t('req.fieldHasTiming')}</label>
  {hasTiming&&<div className="daily-time-editor"><label className="daily-checkbox"><input type="checkbox" checked={allDay} onChange={event=>{setAllDay(event.target.checked);changedTime()}} disabled={pending}/>{t('req.fieldAllDay')}</label><div className="daily-time-fields"><label>{t('req.fieldStartDate')}<input type="date" aria-label={t('req.fieldStartDate')} value={startDate} onChange={event=>{setStartDate(event.target.value);changedTime()}} disabled={pending}/></label>{!allDay&&<label>{t('req.fieldStartTime')}<input type="time" aria-label={t('req.fieldStartTime')} value={startTime} onChange={event=>{setStartTime(event.target.value);changedTime()}} disabled={pending}/></label>}<label>{t('req.fieldEndDate')}<input type="date" aria-label={t('req.fieldEndDate')} value={endDate} onChange={event=>{setEndDate(event.target.value);changedTime()}} disabled={pending}/></label>{!allDay&&<label>{t('req.fieldEndTime')}<input type="time" aria-label={t('req.fieldEndTime')} value={endTime} onChange={event=>{setEndTime(event.target.value);changedTime()}} disabled={pending}/></label>}</div>{!allDay&&<p className="daily-field-note">{t('req.fieldLocalTzNote')}</p>}<label>{t('req.fieldTimeText')}<input aria-label={t('req.fieldTimeText')} placeholder={t('req.fieldTimeTextPlaceholder')} value={timeText} onChange={event=>setTimeText(event.target.value)} maxLength={1000} disabled={pending}/></label></div>}
  <label>{t('req.fieldReason')}<input aria-label={t('req.fieldReason')} value={reason} onChange={event=>setReason(event.target.value)} maxLength={2000} required disabled={pending}/></label>
  {error&&<p className="settings-error" role="alert">{error}</p>}<div className="daily-editor-actions"><button type="submit" className="settings-primary" disabled={pending||!text.trim()||!reason.trim()}>{pending?t('req.savingCorrection'):t('req.saveCorrection')}</button><button type="button" onClick={onCancel} disabled={pending}>{t('app.cancel')}</button></div>
 </form>
}

export function DailyCourseManagement({courseId,revision,onChanged,onOpenSource,onOpenConversation,disabled=false}:{courseId:string;revision?:number;onChanged?:()=>void;onOpenSource?:(id:string,page?:number)=>void;onOpenConversation?:(source:RequirementSource)=>void;disabled?:boolean}){
 const {locale,t}=useI18n()
 const [refresh,setRefresh]=useState(0),{requirements,error:loadError,loading}=useRequirements(courseId,revision,refresh),[editing,setEditing]=useState<string|null>(null),[pending,setPending]=useState<string|null>(null),[error,setError]=useState('')
 const active=useRef(courseId)
 useEffect(()=>{active.current=courseId;setEditing(null);setPending(null);setError('');return()=>{active.current=''}},[courseId])
 const statusLabel=(status:RequirementRevision['status'])=>status==='confirmed'?t('req.status.confirmed'):status==='unverified'?t('req.status.unverified'):status==='conflicted'?t('req.status.conflicted'):t('req.status.withdrawn')
 const kindLabel=(kind:string)=>kind==='exam'?t('req.kind.exam'):kind==='assignment'?t('req.kind.assignment'):kind==='grading'?t('req.kind.grading'):kind==='schedule'?t('req.kind.schedule'):t('req.kind.general')
 const userActionLabel=(entry:RequirementRevision)=>t('req.userAction',{origin:entry.origin==='conversation'?t('req.origin.conversation'):t('req.origin.settings'),action:entry.action==='restore'?t('req.action.restore'):entry.status==='withdrawn'?t('req.action.remove'):t('req.action.update')})
 async function change(item:Requirement,method:'PATCH'|'DELETE',value:Record<string,unknown>){
  if(pending||disabled)return
  const current=courseId,controller=new AbortController();setPending(item.id);setError('')
  try{const response=await fetch('/api/courses/'+encodeURIComponent(current)+'/requirements/'+encodeURIComponent(item.id),{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(value),signal:controller.signal}),result=await response.json();if(!response.ok){if(response.status===409&&active.current===current){setEditing(null);setRefresh(value=>value+1);setError(result.error||t('req.conflictReload'))}throw Error(result.error||t('req.actionNotSaved'))}onChanged?.();if(active.current===current&&!controller.signal.aborted){setEditing(null);setRefresh(value=>value+1)}}
  catch(error){if((error as Error).name!=='AbortError'&&active.current===current){if(method==='DELETE')setError((error as Error).message);throw error}}
  finally{if(active.current===current){setPending(null)}}
 }
 function row(item:Requirement){return <details key={item.id} className={'settings-daily-item'+(item.status==='withdrawn'?' is-removed':'')}><summary><ChevronRight size={13}/><span>{item.text}</span><small>{item.timing?t('req.kind.schedule'):kindLabel(item.kind)}</small></summary><div className="settings-daily-detail">
  <div className="daily-item-meta"><span>{statusLabel(item.status)}</span>{item.actor==='user'&&<span>{userActionLabel(item)}</span>}</div>{item.timing&&<p className="daily-item-time">{timingLabel(locale,item.timing)}{item.scheduleDismissed&&<small>{t('req.dismissedFromSchedule')}</small>}</p>}{item.conditions&&<p className="daily-detail-muted">{t('req.conditions',{text:item.conditions})}</p>}
  <SourceHistory item={item} onOpenSource={onOpenSource} onOpenConversation={onOpenConversation}/>
  {editing===item.id?<RequirementEditor key={item.id+':'+item.revision} item={item} pending={pending===item.id||disabled} onSave={value=>change(item,'PATCH',value)} onCancel={()=>setEditing(null)}/>:<div className="daily-item-actions"><button type="button" onClick={()=>setEditing(item.id)} disabled={!!pending||disabled}>{item.status==='withdrawn'?<RotateCcw size={13}/>:<Pencil size={13}/>} {item.status==='withdrawn'?t('req.restoreAndEdit'):t('app.edit')}</button>{item.status!=='withdrawn'&&<button type="button" onClick={()=>void change(item,'DELETE',{expectedRevision:item.revision}).catch(()=>{})} disabled={!!pending||disabled}><Trash2 size={13}/>{t('req.remove')}</button>}</div>}
 </div></details>}
 const visible=requirements.filter(item=>item.status!=='withdrawn'),removed=requirements.filter(item=>item.status==='withdrawn')
 return <div className="settings-daily-management">{(error||loadError)&&<p className="settings-error" role="alert">{error||loadError}</p>}{loading?<p className="settings-loading"><span className="spinner"/>{t('req.loadingDaily')}</p>:<>{visible.length?visible.map(row):<p className="settings-empty">{t('req.emptyDaily')}</p>}{removed.length>0&&<details className="settings-daily-removed"><summary><ChevronRight size={13}/>{t('req.removedSection')} <small>{removed.length}</small></summary>{removed.map(row)}</details>}</>}</div>
}
