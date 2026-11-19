import {useEffect,useRef,useState} from 'react'
import {CalendarDays} from 'lucide-react'
import './course-schedule.css'

type ScheduleEvent={id:string;title:string;start?:string;end?:string;allDay:boolean;timeText:string;timezone?:string;kind:string;status:string;conditions?:string;revision:number;updatedAt:string}
type Props={courseId:string;revision?:number;onChanged?:()=>void;onOpenSource?:(id:string,page?:number)=>void}
const dateOnly=/^\d{4}-\d{2}-\d{2}$/
function localDate(value:string,timezone?:string){
 if(dateOnly.test(value)||!timezone)return value.slice(0,10)
 try{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value)),get=(type:string)=>parts.find(part=>part.type===type)?.value||'';return `${get('year')}-${get('month')}-${get('day')}`}catch{return value.slice(0,10)}
}
function clock(value:string,timezone?:string){
 if(dateOnly.test(value))return ''
 if(!timezone)return /T(\d{2}:\d{2})/.exec(value)?.[1]||''
 try{return new Intl.DateTimeFormat('zh-CN',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value))}catch{return /T(\d{2}:\d{2})/.exec(value)?.[1]||''}
}
function formatDate(value:string){const [year,month,day]=value.split('-');return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`}
function timeLabel(event:ScheduleEvent){
 if(!event.start)return event.timeText
 const start=clock(event.start,event.timezone)
 if(!event.end)return start
 const end=clock(event.end,event.timezone),endDate=localDate(event.end,event.timezone)
 if(endDate!==localDate(event.start,event.timezone))return `${start?start+' ':''}至 ${formatDate(endDate)}${end?' '+end:''}`
 return start&&end?`${start}–${end}`:start
}

export function CourseSchedule({courseId,revision}:Props){
 const [events,setEvents]=useState<ScheduleEvent[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('')
 const active=useRef(courseId)
 useEffect(()=>{active.current=courseId;setEvents([]);return()=>{if(active.current===courseId)active.current=''}},[courseId])
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError('')
  fetch('/api/courses/'+encodeURIComponent(courseId)+'/schedule',{signal:controller.signal}).then(async response=>{const value=await response.json();if(!response.ok)throw Error(value.error||'日程暂时无法读取。');if(!Array.isArray(value.events))throw Error('日程暂时无法读取。');if(!controller.signal.aborted&&active.current===courseId)setEvents(value.events)}).catch(error=>{if(error.name!=='AbortError'&&active.current===courseId)setError(error.message)}).finally(()=>{if(!controller.signal.aborted&&active.current===courseId)setLoading(false)})
  return()=>controller.abort()
 },[courseId,revision])
 let lastDate=''
 return <section className="course-schedule" aria-label="课程日程">
  <div className="course-schedule-toolbar"><h2>日程</h2>{events.length>0&&<small>{events.length}</small>}</div>
  {error&&<p className="schedule-error" role="alert">{error}</p>}
  {loading&&!events.length?<div className="schedule-loading"><span className="spinner"/>正在读取…</div>:!events.length?<div className="schedule-empty"><div className="schedule-empty-icon"><CalendarDays size={22}/></div><p>对话中的考试与重要日期会记录在这里。</p></div>:<ol className="schedule-list">{events.map(event=>{
   const date=event.start?localDate(event.start,event.timezone):'',showDate=date!==lastDate||!date;lastDate=date
   const time=timeLabel(event)
   return <li key={event.id} className={'schedule-event status-'+event.status+(!event.start?' unresolved':'')}>
    {showDate&&<div className="schedule-date">{date?<time dateTime={date}>{formatDate(date)}</time>:<span>待确认时间</span>}</div>}
    <div className="schedule-event-line"><span className="schedule-point" aria-hidden="true"/><div className="schedule-event-content">
     {time&&<p className="schedule-event-time">{time}</p>}<p className="schedule-event-title">{event.title}</p>
     {event.conditions&&<p className="schedule-event-condition">{event.conditions}</p>}
     {(event.status==='unverified'||event.status==='conflicted')&&<span className={'schedule-event-status '+event.status}>{event.status==='conflicted'?'有冲突':'待核实'}</span>}
    </div></div>
   </li>
  })}</ol>}
 </section>
}
