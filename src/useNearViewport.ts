import {useEffect,useState} from 'react'

type Pool={observer:IntersectionObserver;listeners:Map<Element,()=>void>}
const pools=new Map<Element|null,Pool>()
function observeOnce(target:Element,ready:()=>void){
  if(typeof IntersectionObserver==='undefined'){ready();return()=>{}}
  const root=target.closest('.reading-pane,.context-panel-body')
  let pool=pools.get(root)
  if(!pool){
    const listeners=new Map<Element,()=>void>()
    const observer=new IntersectionObserver(entries=>{
      for(const entry of entries)if(entry.isIntersecting){
        const listener=listeners.get(entry.target)
        if(listener){listeners.delete(entry.target);observer.unobserve(entry.target);listener()}
      }
      if(!listeners.size){observer.disconnect();if(pools.get(root)?.observer===observer)pools.delete(root)}
    },{root,rootMargin:'600px 0px',threshold:0})
    pool={observer,listeners};pools.set(root,pool)
  }
  pool.listeners.set(target,ready);pool.observer.observe(target)
  return()=>{pool.listeners.delete(target);pool.observer.unobserve(target);if(!pool.listeners.size){pool.observer.disconnect();if(pools.get(root)===pool)pools.delete(root)}}
}

/** Keep rendered figures mounted; only defer their first expensive drawing. */
export function useNearViewport(enabled:boolean){
  const [node,setNode]=useState<HTMLElement|null>(null),[seen,setSeen]=useState(false)
  useEffect(()=>{if(!enabled||seen||!node)return;return observeOnce(node,()=>setSeen(true))},[enabled,seen,node])
  return {ref:setNode,near:seen}
}
