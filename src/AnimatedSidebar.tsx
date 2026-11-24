import {useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode,type RefObject} from 'react'

export function AnimatedSidebar({open,width,side,keepMounted=false,frameRef,children}:{open:boolean;width:number;side:'left'|'right';keepMounted?:boolean;frameRef?:RefObject<HTMLDivElement|null>;children:ReactNode}){
 const [present,setPresent]=useState(open),[visible,setVisible]=useState(open),[settledClosed,setSettledClosed]=useState(!open)
 const content=useRef(children)
 if(open||keepMounted)content.current=children
 useLayoutEffect(()=>{
  if(open){
   setPresent(true)
   setSettledClosed(false)
   const frame=requestAnimationFrame(()=>setVisible(true))
   return()=>cancelAnimationFrame(frame)
  }
  setVisible(false)
  const timer=setTimeout(()=>{
   setSettledClosed(true)
   if(!keepMounted)setPresent(false)
  },200)
  return()=>clearTimeout(timer)
 },[open,keepMounted])
 if(!present)return null
 return <div ref={frameRef} className={'studio-panel-frame '+side+(visible?' is-open':'')+(settledClosed&&!open?' is-collapsed':'')} style={{'--panel-width':width+'px'} as CSSProperties} inert={!open} aria-hidden={!open||undefined}>
  <div className="studio-panel-content">{content.current}</div>
 </div>
}
