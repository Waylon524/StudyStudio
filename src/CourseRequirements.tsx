import {useEffect,useRef,useState,type FormEvent} from 'react'
import {ChevronDown,ChevronRight,FileText,Pencil,RotateCcw,Trash2} from 'lucide-react'
import './requirements.css'

export type RequirementSource={type:'user'|'teacher_report'|'material';quote:string;verification?:'text_matched'|'visual_unverified';sourceId?:string;page?:number;relativePath?:string;name?:string;threadId?:string;turnId?:string}
export type RequirementTiming={start?:string;end?:string;allDay?:boolean;timeText:string;timezone?:string}
export type RequirementRevision={revision:number;kind:string;text:string;conditions?:string;status:'confirmed'|'unverified'|'conflicted'|'withdrawn';createdAt:string;source:RequirementSource;reason?:string;timing?:RequirementTiming;actor?:'user';origin?:string;action?:'update'|'remove'|'restore';actionEvidence?:{quote:string;threadId:string;turnId:string|null}}
export type Requirement=RequirementRevision&{id:string;updatedAt:string;revisions:RequirementRevision[];scheduleDismissed?:boolean}
type Props={courseId:string;revision?:number;refresh?:number;onAskAgent?:(text:string)=>void;onDraftMessage?:(text:string)=>void;onOpenSource?:(id:string,page?:number)=>void}
const statusText={confirmed:'已确认',unverified:'待核实',conflicted:'有冲突',withdrawn:'已移除'}
const kindText:Record<string,string>={exam:'考试',assignment:'作业',grading:'评分',schedule:'日程',general:'课程要求'}
const dateText=(date:string)=>Number.isNaN(Date.parse(date))?'':new Date(date).toLocaleString('zh-CN',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})
function userActionLabel(entry:RequirementRevision){return '用户在'+(entry.origin==='conversation'?'对话':'设置')+'中'+(entry.action==='restore'?'恢复':entry.status==='withdrawn'?'移除':'更正')}
function useRequirements(courseId:string,revision?:number,refresh?:number){
 const [requirements,setRequirements]=useState<Requirement[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true)
 useEffect(()=>{const controller=new AbortController();setLoading(true);setError('');setRequirements([])
  fetch('/api/courses/'+encodeURIComponent(courseId)+'/requirements',{signal:controller.signal}).then(async response=>{const value=await response.json();if(!response.ok)throw Error(value.error||'课程要求暂时不可用。');if(!Array.isArray(value.requirements))throw Error('课程要求暂时不可用。');if(!controller.signal.aborted)setRequirements(value.requirements)}).catch(error=>{if(error.name!=='AbortError')setError(error.message)}).finally(()=>{if(!controller.signal.aborted)setLoading(false)})
  return()=>controller.abort()
 },[courseId,revision,refresh])
 return {requirements,error,loading}
}
export function CourseRequirements({courseId,revision,refresh}:Props){
 const {requirements,error,loading}=useRequirements(courseId,revision,refresh),[open,setOpen]=useState(false)
 const visible=requirements.filter(item=>item.status!=='withdrawn')
 return <section className="course-requirements" aria-label="课程要求">
  <button className="course-requirements-heading" type="button" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{open?<ChevronDown size={13}/>:<ChevronRight size={13}/>}<span>课程要求</span>{visible.length>0&&<small>{visible.length}</small>}</button>
  {open&&<div className="course-requirements-content">{error?<p className="requirement-error" role="alert">{error}</p>:loading?<p className="requirement-empty">正在读取…</p>:!visible.length?<p className="requirement-empty">对话中的课程要求会记录在这里。</p>:visible.map(item=><article key={item.id} className={'course-requirement status-'+item.status}>
   <div className="requirement-meta"><span className={'requirement-status '+item.status}>{statusText[item.status]||item.status}</span></div>
   <p className="requirement-text">{item.text}</p>{item.conditions&&<p className="requirement-condition">{item.conditions}</p>}
  </article>)}</div>}
 </section>
}
function timingLabel(timing?:RequirementTiming){
 if(!timing)return ''
 if(!timing.start)return timing.timeText
 const format=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)?value.replace(/-/g,'/'):new Intl.DateTimeFormat('zh-CN',{timeZone:timing.timezone,year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value))
 try{return format(timing.start)+(timing.end?' — '+format(timing.end):'')}catch{return timing.timeText}
}
function SourceHistory({item,onOpenSource,onOpenConversation}:{item:Requirement;onOpenSource?:(id:string,page?:number)=>void;onOpenConversation?:(source:RequirementSource)=>void}){
 return <details className="daily-provenance"><summary><ChevronRight size={13}/>原文与更正记录</summary><ol>{[...(item.revisions?.length?item.revisions:[item])].reverse().map(entry=>{
  const source=entry.source,label=source.type==='material'?(source.name||source.relativePath?.split('/').pop()||'课程资料')+(source.page?' · 第 '+source.page+' 页':''):source.type==='teacher_report'?'课程对话 · 用户转述教师要求':'课程对话 · 用户消息'
  return <li key={entry.revision}><div className="daily-revision-meta"><span>{entry.revision===item.revision?'当前版本':'第 '+entry.revision+' 版'} · {entry.actor==='user'?userActionLabel(entry):statusText[entry.status]}</span><time dateTime={entry.createdAt}>{dateText(entry.createdAt)}</time></div>
   <p>{entry.text}</p>{entry.conditions&&<p className="daily-detail-muted">条件：{entry.conditions}</p>}{entry.timing&&<p className="daily-detail-muted">时间：{timingLabel(entry.timing)}</p>}{entry.reason&&<p className="daily-correction-reason">更正原因：{entry.reason}</p>}
   {entry.actionEvidence&&<><div className="daily-source-label">本轮用户对话依据</div><blockquote>{entry.actionEvidence.quote}</blockquote></>}
   <div className="daily-source-label">{entry.actor==='user'&&<span>原始来源： </span>}{source.sourceId&&onOpenSource?<button type="button" onClick={()=>onOpenSource(source.sourceId!,source.page)}><FileText size={12}/>{label}</button>:source.type!=='material'&&onOpenConversation?<button type="button" onClick={()=>onOpenConversation(source)}>{label}</button>:<span>{label}</span>}</div>
   {source.verification==='visual_unverified'&&<small>图像转录，待核实</small>}<blockquote>{source.quote}</blockquote>
  </li>
 })}</ol></details>
}
const pad=(value:number)=>String(value).padStart(2,'0')
function localFields(value?:string){if(!value)return {date:'',time:''};if(/^\d{4}-\d{2}-\d{2}$/.test(value))return {date:value,time:''};const date=new Date(value);return Number.isNaN(date.getTime())?{date:'',time:''}:{date:`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`,time:`${pad(date.getHours())}:${pad(date.getMinutes())}`}}
type EditorProps={item:Requirement;pending:boolean;onSave:(value:Record<string,unknown>)=>Promise<void>;onCancel:()=>void}
function RequirementEditor({item,pending,onSave,onCancel}:EditorProps){
 const start=localFields(item.timing?.start),end=localFields(item.timing?.end)
 const [text,setText]=useState(item.text),[conditions,setConditions]=useState(item.conditions||''),[reason,setReason]=useState(''),[hasTiming,setHasTiming]=useState(!!item.timing),[allDay,setAllDay]=useState(item.timing?.allDay??true)
 const [startDate,setStartDate]=useState(start.date),[startTime,setStartTime]=useState(start.time),[endDate,setEndDate]=useState(end.date),[endTime,setEndTime]=useState(end.time),[timeText,setTimeText]=useState(item.timing?.timeText||''),[error,setError]=useState('')
 const changedTime=()=>setTimeText('')
 async function save(event:FormEvent){
  event.preventDefault();setError('')
  if(!text.trim()||!reason.trim()){setError('请填写内容和更正原因。');return}
  let timing:RequirementTiming|undefined
  if(hasTiming){
   if(!startDate&&!timeText.trim()){setError('请填写日期或尚待确认的时间说明。');return}
   if(startDate&&!allDay&&!startTime){setError('请填写开始时间，或选择全天。');return}
   if(endDate&&!startDate||endDate&&!allDay&&!endTime){setError('请完整填写结束日期与时间。');return}
   const instant=(date:string,time:string)=>allDay?date:new Date(date+'T'+time+':00').toISOString()
   const value=startDate?instant(startDate,startTime):undefined,endValue=endDate?instant(endDate,endTime):undefined
   const summary=timeText.trim()||[startDate,allDay?'':startTime,endDate?'至 '+endDate+(allDay?'':' '+endTime):''].filter(Boolean).join(' ')
   timing={timeText:summary,allDay,...(value?{start:value}:{}),...(endValue?{end:endValue}:{}),...(!allDay?{timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}:{})}
  }
  try{await onSave({expectedRevision:item.revision,text:text.trim(),conditions:conditions.trim(),reason:reason.trim(),...(hasTiming?{timing}:{timing:null})})}catch(error){setError((error as Error).message||'更正尚未保存。')}
 }
 return <form className="daily-editor" onSubmit={event=>void save(event)}>
  <label>内容<textarea aria-label="日常内容" value={text} onChange={event=>setText(event.target.value)} maxLength={4000} required disabled={pending}/></label>
  <label>适用条件<input aria-label="适用条件" value={conditions} onChange={event=>setConditions(event.target.value)} maxLength={2000} disabled={pending}/></label>
  <label className="daily-checkbox"><input type="checkbox" checked={hasTiming} onChange={event=>setHasTiming(event.target.checked)} disabled={pending}/>包含日程时间</label>
  {hasTiming&&<div className="daily-time-editor"><label className="daily-checkbox"><input type="checkbox" checked={allDay} onChange={event=>{setAllDay(event.target.checked);changedTime()}} disabled={pending}/>全天</label><div className="daily-time-fields"><label>开始日期<input type="date" aria-label="开始日期" value={startDate} onChange={event=>{setStartDate(event.target.value);changedTime()}} disabled={pending}/></label>{!allDay&&<label>开始时间<input type="time" aria-label="开始时间" value={startTime} onChange={event=>{setStartTime(event.target.value);changedTime()}} disabled={pending}/></label>}<label>结束日期<input type="date" aria-label="结束日期" value={endDate} onChange={event=>{setEndDate(event.target.value);changedTime()}} disabled={pending}/></label>{!allDay&&<label>结束时间<input type="time" aria-label="结束时间" value={endTime} onChange={event=>{setEndTime(event.target.value);changedTime()}} disabled={pending}/></label>}</div>{!allDay&&<p className="daily-field-note">时间按本机时区显示。</p>}<label>时间说明<input aria-label="时间说明" placeholder="日期尚未确定时填写" value={timeText} onChange={event=>setTimeText(event.target.value)} maxLength={1000} disabled={pending}/></label></div>}
  <label>更正原因<input aria-label="更正原因" value={reason} onChange={event=>setReason(event.target.value)} maxLength={2000} required disabled={pending}/></label>
  {error&&<p className="settings-error" role="alert">{error}</p>}<div className="daily-editor-actions"><button type="submit" className="settings-primary" disabled={pending||!text.trim()||!reason.trim()}>{pending?'正在保存…':'保存更正'}</button><button type="button" onClick={onCancel} disabled={pending}>取消</button></div>
 </form>
}
export function DailyCourseManagement({courseId,revision,onChanged,onOpenSource,onOpenConversation,disabled=false}:{courseId:string;revision?:number;onChanged?:()=>void;onOpenSource?:(id:string,page?:number)=>void;onOpenConversation?:(source:RequirementSource)=>void;disabled?:boolean}){
 const [refresh,setRefresh]=useState(0),{requirements,error:loadError,loading}=useRequirements(courseId,revision,refresh),[editing,setEditing]=useState<string|null>(null),[pending,setPending]=useState<string|null>(null),[error,setError]=useState('')
 const active=useRef(courseId)
 useEffect(()=>{active.current=courseId;setEditing(null);setPending(null);setError('');return()=>{active.current=''}},[courseId])
 async function change(item:Requirement,method:'PATCH'|'DELETE',value:Record<string,unknown>){
  if(pending||disabled)return
  const current=courseId,controller=new AbortController();setPending(item.id);setError('')
  try{const response=await fetch('/api/courses/'+encodeURIComponent(current)+'/requirements/'+encodeURIComponent(item.id),{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(value),signal:controller.signal}),result=await response.json();if(!response.ok){if(response.status===409&&active.current===current){setEditing(null);setRefresh(value=>value+1);setError(result.error||'记录已更新，请核对最新版本后重新编辑。')}throw Error(result.error||'操作尚未保存，请重试。')}onChanged?.();if(active.current===current&&!controller.signal.aborted){setEditing(null);setRefresh(value=>value+1)}}
  catch(error){if((error as Error).name!=='AbortError'&&active.current===current){if(method==='DELETE')setError((error as Error).message);throw error}}
  finally{if(active.current===current){setPending(null)}}
 }
 function row(item:Requirement){return <details key={item.id} className={'settings-daily-item'+(item.status==='withdrawn'?' is-removed':'')}><summary><ChevronRight size={13}/><span>{item.text}</span><small>{item.timing?'日程':kindText[item.kind]||'课程要求'}</small></summary><div className="settings-daily-detail">
  <div className="daily-item-meta"><span>{statusText[item.status]}</span>{item.actor==='user'&&<span>{userActionLabel(item)}</span>}</div>{item.timing&&<p className="daily-item-time">{timingLabel(item.timing)}{item.scheduleDismissed&&<small> · 已从日程隐藏</small>}</p>}{item.conditions&&<p className="daily-detail-muted">条件：{item.conditions}</p>}
  <SourceHistory item={item} onOpenSource={onOpenSource} onOpenConversation={onOpenConversation}/>
  {editing===item.id?<RequirementEditor key={item.id+':'+item.revision} item={item} pending={pending===item.id||disabled} onSave={value=>change(item,'PATCH',value)} onCancel={()=>setEditing(null)}/>:<div className="daily-item-actions"><button type="button" onClick={()=>setEditing(item.id)} disabled={!!pending||disabled}>{item.status==='withdrawn'?<RotateCcw size={13}/>:<Pencil size={13}/>} {item.status==='withdrawn'?'恢复并更正':'编辑'}</button>{item.status!=='withdrawn'&&<button type="button" onClick={()=>void change(item,'DELETE',{expectedRevision:item.revision}).catch(()=>{})} disabled={!!pending||disabled}><Trash2 size={13}/>移除</button>}</div>}
 </div></details>}
 const visible=requirements.filter(item=>item.status!=='withdrawn'),removed=requirements.filter(item=>item.status==='withdrawn')
 return <div className="settings-daily-management">{(error||loadError)&&<p className="settings-error" role="alert">{error||loadError}</p>}{loading?<p className="settings-loading"><span className="spinner"/>正在读取日常…</p>:<>{visible.length?visible.map(row):<p className="settings-empty">暂无日程或课程要求</p>}{removed.length>0&&<details className="settings-daily-removed"><summary><ChevronRight size={13}/>已移除 <small>{removed.length}</small></summary>{removed.map(row)}</details>}</>}</div>
}
