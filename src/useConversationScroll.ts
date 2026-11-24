import {useCallback,useLayoutEffect,useRef,useState,type RefObject} from 'react'

type Props={scroller:RefObject<HTMLElement|null>;content:unknown;progress:string;resetKey:string;enabled:boolean}
const bottomTolerance=40

/** Keep following new text only while the learner is already reading the end. */
export function useConversationScroll({scroller,content,progress,resetKey,enabled}:Props){
 const [showScrollToBottom,setShowScrollToBottom]=useState(false)
 const following=useRef(true),animation=useRef<number|null>(null)
 const enabledRef=useRef(enabled)
 enabledRef.current=enabled
 const distance=useCallback(()=>{
  const pane=scroller.current
  return pane?Math.max(0,pane.scrollHeight-pane.clientHeight-Math.max(0,pane.scrollTop)):0
 },[scroller])
 const updateVisibility=useCallback(()=>{
  const pane=scroller.current
  setShowScrollToBottom(!!pane&&enabledRef.current&&pane.scrollHeight-pane.clientHeight>bottomTolerance&&distance()>bottomTolerance)
 },[scroller,distance])
 const cancelAnimation=useCallback(()=>{if(animation.current!==null)cancelAnimationFrame(animation.current);animation.current=null},[])
 const follow=useCallback(()=>{
  const pane=scroller.current
  if(pane&&enabledRef.current&&following.current&&animation.current===null)pane.scrollTo({top:pane.scrollHeight,behavior:'instant'})
  updateVisibility()
 },[scroller,updateVisibility])
 const resetScroll=useCallback(()=>{cancelAnimation();following.current=true;setShowScrollToBottom(false)},[cancelAnimation])
 const scrollToBottom=useCallback(()=>{
  const pane=scroller.current
  if(!pane)return
  cancelAnimation();following.current=true
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){pane.scrollTo({top:pane.scrollHeight,behavior:'instant'});updateVisibility();return}
  const start=pane.scrollTop,started=performance.now(),duration=360
  const tick=(now:number)=>{
   const progress=Math.min(1,(now-started)/duration),target=Math.max(0,pane.scrollHeight-pane.clientHeight)
   pane.scrollTo({top:start+(target-start)*(1-Math.pow(1-progress,3)),behavior:'instant'})
   updateVisibility()
   if(progress<1)animation.current=requestAnimationFrame(tick)
   else{animation.current=null;follow()}
  }
  animation.current=requestAnimationFrame(tick)
 },[scroller,cancelAnimation,follow,updateVisibility])

 useLayoutEffect(resetScroll,[resetKey,resetScroll])
 useLayoutEffect(follow,[content,progress,enabled,follow])
 useLayoutEffect(()=>{
  const pane=scroller.current
  if(!pane)return
  const onScroll=()=>{if(animation.current===null)following.current=distance()<=bottomTolerance;updateVisibility()}
  const cancelForInteraction=()=>{if(animation.current!==null){cancelAnimation();following.current=false;updateVisibility()}}
  const onWheel=(event:WheelEvent)=>{cancelForInteraction();if(event.deltaY<0)following.current=false}
  const onKey=(event:KeyboardEvent)=>{
   const target=event.target as HTMLElement|null
   if(target?.closest('input,textarea,select,[contenteditable="true"]'))return
   if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))cancelForInteraction()
   if(['ArrowUp','PageUp','Home'].includes(event.key))following.current=false
  }
  let resizeFrame:number|null=null
  const onResize=()=>{
   if(resizeFrame!==null)return
   resizeFrame=requestAnimationFrame(()=>{resizeFrame=null;follow()})
  }
  const observer=new ResizeObserver(onResize)
  observer.observe(pane)
  if(pane.firstElementChild)observer.observe(pane.firstElementChild)
  pane.addEventListener('scroll',onScroll,{passive:true})
  pane.addEventListener('wheel',onWheel,{passive:true})
  pane.addEventListener('pointerdown',cancelForInteraction,{passive:true})
  pane.addEventListener('touchstart',cancelForInteraction,{passive:true})
  pane.addEventListener('keydown',onKey)
  follow()
  return()=>{
   if(resizeFrame!==null)cancelAnimationFrame(resizeFrame)
   observer.disconnect();cancelAnimation()
   pane.removeEventListener('scroll',onScroll);pane.removeEventListener('wheel',onWheel)
   pane.removeEventListener('pointerdown',cancelForInteraction);pane.removeEventListener('touchstart',cancelForInteraction);pane.removeEventListener('keydown',onKey)
  }
 },[scroller,distance,updateVisibility,follow,cancelAnimation])
 return {showScrollToBottom,scrollToBottom,resetScroll}
}
