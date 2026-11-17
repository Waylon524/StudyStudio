import {memo,useEffect,useId,useRef,useState,useSyncExternalStore} from 'react'
import {createPortal} from 'react-dom'
import {RefreshCw} from 'lucide-react'
import './course-avatar.css'

type Primitive={type:'path';d:string}|{type:'circle';cx:number;cy:number;r:number}|{type:'ellipse';cx:number;cy:number;rx:number;ry:number}|{type:'line';x1:number;y1:number;x2:number;y2:number}|{type:'polyline';points:number[][]}
type Avatar={status:'pending'|'ready'|'failed';icon?:{elements:Primitive[]};error?:string}
type Props={courseId:string;size?:number;className?:string;label?:string}
const pending:Avatar={status:'pending'},entries=new Map<string,ReturnType<typeof createEntry>>()
function createEntry(courseId:string){
 let value:Avatar=pending,controller:AbortController|null=null,timer:ReturnType<typeof setTimeout>|null=null,inFlight=false,regenerating=false,epoch=0
 const listeners=new Set<()=>void>(),url='/api/courses/'+encodeURIComponent(courseId)+'/avatar'
 function notify(){listeners.forEach(listener=>listener())}
 function stop(){epoch++;controller?.abort();controller=null;inFlight=false;if(timer)clearTimeout(timer);timer=null}
 function poll(){if(value.status==='pending'&&listeners.size&&!timer)timer=setTimeout(()=>{timer=null;void read()},1200)}
 async function read(){
  if(inFlight||regenerating||!listeners.size||value.status==='ready'||value.status==='failed')return
  const version=epoch;inFlight=true;controller=new AbortController()
  try{
   const response=await fetch(url,{signal:controller.signal}),data=await response.json()
   if(version!==epoch)return
   if(!response.ok||!data.avatar||!['pending','ready','failed'].includes(data.avatar.status))throw Error('课程头像暂时不可用。')
   value=data.avatar;notify()
  }catch(error){if(version!==epoch||(error as Error).name==='AbortError')return;value={...value,status:'failed',error:'头像暂时无法读取，请重试。'};notify()}
  finally{if(version===epoch){inFlight=false;controller=null;poll()}}
 }
 async function regenerate(){
  if(regenerating||value.status==='pending')return
  stop();regenerating=true;const previous=value;value={status:'pending',...(previous.icon?{icon:previous.icon}:{})};notify()
  try{
   const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),data=await response.json()
   if(!response.ok||!data.avatar||!['pending','ready','failed'].includes(data.avatar.status))throw Error(data.error||'头像暂未更换，请重试。')
   value=data.avatar
  }catch(error){value={status:'failed',...(previous.icon?{icon:previous.icon}:{}),error:(error as Error).message||'头像暂未更换，请重试。'}}
  finally{regenerating=false;notify();poll()}
 }
 return {getSnapshot:()=>value,regenerate,subscribe:(listener:()=>void)=>{listeners.add(listener);void read();return()=>{listeners.delete(listener);if(!listeners.size)stop()}}}
}
function entryFor(courseId:string){let entry=entries.get(courseId);if(!entry){entry=createEntry(courseId);entries.set(courseId,entry)}return entry}

export const CourseAvatar=memo(function CourseAvatar({courseId,size=28,className='',label='课程头像'}:Props){
 const entry=entryFor(courseId),avatar=useSyncExternalStore(entry.subscribe,entry.getSnapshot,entry.getSnapshot)
 const [open,setOpen]=useState(false),[position,setPosition]=useState({left:0,top:0}),trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null),menuId=useId()
 const elements=Array.isArray(avatar.icon?.elements)?avatar.icon.elements:null
 useEffect(()=>setOpen(false),[courseId])
 useEffect(()=>{
  if(!open)return
  const outside=(event:PointerEvent)=>{const node=event.target as Node;if(!trigger.current?.contains(node)&&!menu.current?.contains(node))setOpen(false)}
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);trigger.current?.focus()}}
  const close=()=>setOpen(false)
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);window.addEventListener('resize',close)
  menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);window.removeEventListener('resize',close)}
 },[open])
 function toggle(){if(open){setOpen(false);return}const rect=trigger.current?.getBoundingClientRect();if(rect)setPosition({left:Math.max(8,Math.min(rect.left,innerWidth-188)),top:Math.max(8,Math.min(rect.bottom+8,innerHeight-112))});setOpen(true)}
 return <span className={'course-avatar '+className} data-avatar-status={avatar.status} data-has-icon={!!elements} style={{width:size,height:size}}>
  <button ref={trigger} type="button" className="course-avatar-trigger" aria-label={label} aria-haspopup="menu" aria-controls={open?menuId:undefined} aria-expanded={open} onClick={toggle} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();if(!open)toggle()}}} title={avatar.status==='pending'?'正在生成课程头像':'更换课程头像'}><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{elements?elements.map((element,index)=>{
   switch(element.type){
    case 'path':return <path key={index} d={element.d}/>
    case 'circle':return <circle key={index} cx={element.cx} cy={element.cy} r={element.r}/>
    case 'ellipse':return <ellipse key={index} cx={element.cx} cy={element.cy} rx={element.rx} ry={element.ry}/>
    case 'line':return <line key={index} x1={element.x1} y1={element.y1} x2={element.x2} y2={element.y2}/>
    case 'polyline':return <polyline key={index} points={element.points.map(point=>point.join(',')).join(' ')}/>
    default:return null
   }
  }):<><path d="M8 12 C14 10 19 12 24 16 C29 12 34 10 40 12 L40 36 C34 34 29 36 24 40 C19 36 14 34 8 36 Z"/><path d="M24 16 V40"/></>}</svg></button>
  {open&&createPortal(<div ref={menu} id={menuId} role="menu" aria-label="课程头像选项" className="course-avatar-menu" style={position}><button type="button" role="menuitem" disabled={avatar.status==='pending'} onClick={()=>{setOpen(false);void entry.regenerate();trigger.current?.focus()}}><RefreshCw size={14}/>{avatar.status==='pending'?'正在生成…':'更换头像'}</button>{avatar.status==='failed'&&avatar.error&&<p role="status">{avatar.error}</p>}</div>,document.body)}
 </span>
})
