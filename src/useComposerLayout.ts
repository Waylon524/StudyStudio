import {useCallback,useLayoutEffect,type RefObject} from 'react'

type ElementRef<T extends HTMLElement> = RefObject<T|null>
type Props={input:ElementRef<HTMLTextAreaElement>;frame:ElementRef<HTMLElement>;area:ElementRef<HTMLDivElement>;scroller:ElementRef<HTMLElement>;value:string;auxiliaryKey:string}

export function useComposerLayout({input,frame,area,scroller,value,auxiliaryKey}:Props){
 const fit=useCallback(()=>{
  const field=input.current,container=frame.current,overlay=area.current
  if(!field||!container||!overlay)return
  const minimum=parseFloat(getComputedStyle(field).minHeight)||56
  const chrome=Math.max(0,overlay.getBoundingClientRect().height-field.getBoundingClientRect().height)
  const transcriptSpace=container.classList.contains('is-empty')?140:100
  const maximum=Math.max(minimum,Math.min(640,container.clientHeight*.6,container.clientHeight-chrome-transcriptSpace))
  field.style.height='auto'
  const content=field.scrollHeight,height=Math.min(maximum,Math.max(minimum,content))
  field.style.height=Math.ceil(height)+'px'
  field.style.overflowY=content>height+1?'auto':'hidden'
  if(content<=height+1)field.scrollTop=0
 },[input,frame,area])
 useLayoutEffect(fit,[fit,value,auxiliaryKey])
 useLayoutEffect(()=>{
  const container=frame.current
  if(!container)return
  const observer=new ResizeObserver(fit);observer.observe(container)
  window.addEventListener('resize',fit)
  return()=>{observer.disconnect();window.removeEventListener('resize',fit)}
 },[fit,frame])
 useLayoutEffect(()=>{
  const overlay=area.current,container=frame.current
  if(!overlay||!container)return
  let previous=0
  const update=()=>{
   const next=Math.ceil(overlay.getBoundingClientRect().height)+12
   if(next===previous)return
   const pane=scroller.current,pinned=!!pane&&pane.scrollHeight-pane.clientHeight-pane.scrollTop<32
   previous=next;container.style.setProperty('--composer-space',next+'px')
   if(pane&&pinned&&!container.classList.contains('is-empty'))pane.scrollTop=pane.scrollHeight
  }
  const observer=new ResizeObserver(update);observer.observe(overlay);update()
  return()=>observer.disconnect()
 },[area,frame,scroller])
}
