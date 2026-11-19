import {useLayoutEffect,useRef,type RefObject} from 'react'

type Props={
  rootRef:RefObject<HTMLDivElement|null>
  sheetRef:RefObject<HTMLDivElement|null>
  panelRef:RefObject<HTMLDivElement|null>
  selectedId:string|null
  active:boolean
}
type Bounds={left:number;top:number;right:number;bottom:number}
const gap=8
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value))

function elementGeometry(element:HTMLElement){
  const rect=element.getBoundingClientRect()
  const scaleX=element.offsetWidth?rect.width/element.offsetWidth:1
  const scaleY=element.offsetHeight?rect.height/element.offsetHeight:1
  return {rect,scaleX:scaleX||1,scaleY:scaleY||1}
}

// clientWidth/clientHeight exclude scrollbars; their origin includes the border.
function clientBounds(element:HTMLElement):Bounds{
  const {rect,scaleX,scaleY}=elementGeometry(element)
  const left=rect.left+element.clientLeft*scaleX,top=rect.top+element.clientTop*scaleY
  return {left,top,right:left+element.clientWidth*scaleX,bottom:top+element.clientHeight*scaleY}
}

function setStyle(panel:HTMLDivElement,name:string,value:string){
  if(panel.style.getPropertyValue(name)!==value)panel.style.setProperty(name,value)
}

export function usePdfMarkupInspector({rootRef,sheetRef,panelRef,selectedId,active}:Props):void{
  const measureRef=useRef<()=>void>(()=>{})

  useLayoutEffect(()=>{
    const panel=panelRef.current,sheet=sheetRef.current,root=rootRef.current
    const hide=()=>{if(panel)setStyle(panel,'visibility','hidden')}
    const clear=()=>{
      if(panel)for(const name of ['left','top','visibility','--pdf-markup-inspector-max-width','--pdf-markup-inspector-max-height'])panel.style.removeProperty(name)
    }
    if(!active||!selectedId){
      clear()
      measureRef.current=clear
      return
    }
    if(!panel||!sheet||!root){
      hide()
      measureRef.current=hide
      return
    }
    const stage=sheet.closest<HTMLElement>('.pdf-reader-stage')
    const item=sheet.querySelector<Element>('[data-pdf-annotation="'+CSS.escape(selectedId)+'"]')
    const anchor=item?.querySelector<Element>('[data-pdf-annotation-anchor]')||item
    if(!stage||!anchor){
      hide()
      measureRef.current=hide
      return
    }
    // The stage can itself be clipped while the reader sidebar opens or closes.
    const ancestors:HTMLElement[]=[]
    for(let element=stage.parentElement;element;element=element.parentElement)ancestors.push(element)
    let frame=0
    const measure=()=>{
      if(!panel.isConnected||!anchor.isConnected||root.closest('[inert],[aria-hidden="true"]')){hide();return}
      const parent=panel.offsetParent
      if(!(parent instanceof HTMLElement)||!stage.clientWidth||!stage.clientHeight){hide();return}
      const bounds=clientBounds(stage)
      bounds.left=Math.max(0,bounds.left);bounds.top=Math.max(0,bounds.top)
      bounds.right=Math.min(document.documentElement.clientWidth,bounds.right)
      bounds.bottom=Math.min(document.documentElement.clientHeight,bounds.bottom)
      for(const element of ancestors){
        const style=getComputedStyle(element)
        const clipX=/^(hidden|clip|auto|scroll)$/.test(style.overflowX)
        const clipY=/^(hidden|clip|auto|scroll)$/.test(style.overflowY)
        if(!clipX&&!clipY)continue
        const clip=clientBounds(element)
        if(clipX){bounds.left=Math.max(bounds.left,clip.left);bounds.right=Math.min(bounds.right,clip.right)}
        if(clipY){bounds.top=Math.max(bounds.top,clip.top);bounds.bottom=Math.min(bounds.bottom,clip.bottom)}
      }
      const target=anchor.getBoundingClientRect()
      if(![target.left,target.top,target.right,target.bottom].every(Number.isFinite)||
        target.right<bounds.left||target.left>bounds.right||target.bottom<bounds.top||target.top>bounds.bottom||
        bounds.right-bounds.left<=gap*2||bounds.bottom-bounds.top<=gap*2){hide();return}
      const {rect:parentRect,scaleX,scaleY}=elementGeometry(parent)
      const left=bounds.left+gap,top=bounds.top+gap,right=bounds.right-gap,bottom=bounds.bottom-gap
      setStyle(panel,'--pdf-markup-inspector-max-width',Math.max(0,(right-left)/scaleX)+'px')
      setStyle(panel,'--pdf-markup-inspector-max-height',Math.max(0,(bottom-top)/scaleY)+'px')
      const size=panel.getBoundingClientRect(),width=size.width,height=size.height
      if(!width||!height){hide();return}
      // A horizontal or vertical SVG line may legitimately have a zero dimension.
      const anchorLeft=clamp(target.left,bounds.left,bounds.right),anchorRight=clamp(target.right,bounds.left,bounds.right)
      const anchorTop=clamp(target.top,bounds.top,bounds.bottom),anchorBottom=clamp(target.bottom,bounds.top,bounds.bottom)
      const centerX=(anchorLeft+anchorRight)/2,centerY=(anchorTop+anchorBottom)/2
      const positions=[
        {x:centerX-width/2,y:anchorTop-height-gap},
        {x:centerX-width/2,y:anchorBottom+gap},
        {x:anchorRight+gap,y:centerY-height/2},
        {x:anchorLeft-width-gap,y:centerY-height/2}
      ]
      const fits=({x,y}:{x:number;y:number})=>x>=left&&y>=top&&x+width<=right&&y+height<=bottom
      const visibleArea=({x,y}:{x:number;y:number})=>Math.max(0,Math.min(x+width,right)-Math.max(x,left))*Math.max(0,Math.min(y+height,bottom)-Math.max(y,top))
      const position=positions.find(fits)||positions.reduce((best,value)=>visibleArea(value)>visibleArea(best)?value:best)
      const x=clamp(position.x,left,Math.max(left,right-width)),y=clamp(position.y,top,Math.max(top,bottom-height))
      // Absolute offsets use the offset parent's padding edge, not its border box.
      setStyle(panel,'left',((x-parentRect.left)/scaleX-parent.clientLeft+parent.scrollLeft)+'px')
      setStyle(panel,'top',((y-parentRect.top)/scaleY-parent.clientTop+parent.scrollTop)+'px')
      setStyle(panel,'visibility','visible')
    }
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;measure()})}
    measureRef.current=measure
    const observer=new ResizeObserver(schedule)
    for(const element of new Set<Element>([panel,sheet,stage,anchor,...ancestors]))observer.observe(element)
    window.addEventListener('scroll',schedule,true)
    window.addEventListener('resize',schedule)
    return()=>{
      if(frame)cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('scroll',schedule,true)
      window.removeEventListener('resize',schedule)
      measureRef.current=()=>{}
      clear()
    }
  },[active,selectedId,rootRef,sheetRef,panelRef])

  // Moving an annotation may change only its SVG/CSS transform, not its size.
  useLayoutEffect(()=>{measureRef.current()})
}
