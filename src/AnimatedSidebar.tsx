import {useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react'

export function AnimatedSidebar({open,width,side,children}:{open:boolean;width:number;side:'left'|'right';children:ReactNode}){
 const [present,setPresent]=useState(open),[visible,setVisible]=useState(false)
 const content=useRef(children)
 if(open)content.current=children
 useLayoutEffect(()=>{
  if(open){
   setPresent(true)
   const frame=requestAnimationFrame(()=>setVisible(true))
   return()=>cancelAnimationFrame(frame)
  }
  setVisible(false)
  const timer=setTimeout(()=>setPresent(false),240)
  return()=>clearTimeout(timer)
 },[open])
 if(!present)return null
 return <div className={'studio-panel-frame '+side+(visible?' is-open':'')} style={{'--panel-width':width+'px'} as CSSProperties} inert={!open} aria-hidden={!open||undefined}>
  <div className="studio-panel-content">{content.current}</div>
 </div>
}
