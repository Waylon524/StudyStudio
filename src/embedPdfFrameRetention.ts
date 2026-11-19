import type {EmbedPdfViewerElement,Viewer} from '@embedpdf/viewer-react'

/** Bridge the SDK's paged DOM replacement with one inert, decoded page picture.
 * No second PDF render is requested. Public main-lens picture readiness means
 * the new image loaded and the SDK allowed two frames for its presentation. */
export function installPageFrameRetention(viewer:Viewer,element:EmbedPdfViewerElement){
  const shadow=element.shadowRoot
  if(!shadow)return()=>{}
  type Frame={image:HTMLImageElement;stage:HTMLElement;page:number;rect:DOMRect;stageRect:DOMRect;rotation:number}
  type Hold={canvas:HTMLCanvasElement;stage:HTMLElement;target:number;pointer:string;inert:boolean;busy:string|null;timer:number}
  let last:Frame|null=null,hold:Hold|null=null,refreshFrame=0,stopDocument=()=>{}
  const identify=(image:HTMLImageElement)=>{
    if(image.closest('[data-epdf-panel],[data-study-navigation-exit]')||image.style.position!=='absolute'||image.style.width!=='100%'||image.style.height!=='100%'||!['0px','0'].includes(image.style.inset))return null
    let stage=image.parentElement
    while(stage&&stage.getRootNode()===shadow){
      if(stage.style.touchAction==='none'&&stage.style.overflow==='hidden'&&stage.style.position==='relative')return stage
      stage=stage.parentElement
    }
    return null
  }
  const release=()=>{
    if(!hold)return
    const current=hold;hold=null;clearTimeout(current.timer)
    current.canvas.remove();current.canvas.width=0;current.canvas.height=0
    current.stage.style.pointerEvents=current.pointer;current.stage.inert=current.inert
    if(current.busy===null)current.stage.removeAttribute('aria-busy');else current.stage.setAttribute('aria-busy',current.busy)
    current.stage.removeAttribute('data-study-page-awaiting')
  }
  const stopWatch=viewer.watch(()=>viewer.tryGet('stage'),stage=>{
    stopDocument();release();last=null;stopDocument=()=>{}
    if(!stage)return
    const render=viewer.tryGet('render')
    if(!render)return
    const remember=(image:HTMLImageElement)=>{
      const host=identify(image)
      if(!host||!image.complete||!image.naturalWidth||!image.naturalHeight||!image.isConnected)return
      const rect=image.getBoundingClientRect(),stageRect=host.getBoundingClientRect()
      if(!rect.width||!rect.height)return
      const matrix=new DOMMatrixReadOnly(getComputedStyle(image.parentElement!).transform)
      const rotation=(Math.round(Math.atan2(matrix.b,matrix.a)*180/Math.PI/90)*90+360)%360
      host.dataset.studyPdfStage='true'
      last={image,stage:host,page:stage.getCurrentPageIndex(),rect,stageRect,rotation}
    }
    const refresh=()=>{
      if(refreshFrame)cancelAnimationFrame(refreshFrame)
      refreshFrame=requestAnimationFrame(()=>{refreshFrame=0;for(const image of shadow.querySelectorAll<HTMLImageElement>('img'))if(identify(image))remember(image)})
    }
    const reset=()=>{release();last=null;refresh()}
    const retain=(target:number,previous:number)=>{
      if(hold){hold.target=target;hold.canvas.dataset.studyPageTarget=String(target+1);hold.stage.dataset.studyPageAwaiting=String(target+1);return}
      const frame=last
      if(!frame||frame.page!==previous||!frame.stage.isConnected||!frame.image.complete||!frame.image.naturalWidth)return
      const rect=frame.image.isConnected?frame.image.getBoundingClientRect():frame.rect
      const stageRect=frame.stage.getBoundingClientRect()
      if(!rect.width||!rect.height||!stageRect.width||!stageRect.height)return
      const canvas=document.createElement('canvas'),turned=frame.rotation%180!==0
      const naturalWidth=turned?frame.image.naturalHeight:frame.image.naturalWidth,naturalHeight=turned?frame.image.naturalWidth:frame.image.naturalHeight
      const scale=Math.min(1,4096/Math.max(naturalWidth,naturalHeight),Math.sqrt(2000000/(naturalWidth*naturalHeight)))
      canvas.width=Math.max(1,Math.round(naturalWidth*scale));canvas.height=Math.max(1,Math.round(naturalHeight*scale))
      const context=canvas.getContext('2d')
      if(!context)return
      try{
        context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height)
        context.translate(canvas.width/2,canvas.height/2);context.rotate(frame.rotation*Math.PI/180)
        context.drawImage(frame.image,-frame.image.naturalWidth*scale/2,-frame.image.naturalHeight*scale/2,frame.image.naturalWidth*scale,frame.image.naturalHeight*scale)
      }catch{canvas.width=0;canvas.height=0;return}
      const scaleX=frame.stage.offsetWidth?stageRect.width/frame.stage.offsetWidth:1,scaleY=frame.stage.offsetHeight?stageRect.height/frame.stage.offsetHeight:1
      canvas.dataset.studyPageRetainedFrom=String(previous+1);canvas.dataset.studyPageTarget=String(target+1)
      canvas.inert=true;canvas.setAttribute('aria-hidden','true')
      Object.assign(canvas.style,{position:'absolute',left:(rect.left-stageRect.left)/scaleX+'px',top:(rect.top-stageRect.top)/scaleY+'px',width:rect.width/scaleX+'px',height:rect.height/scaleY+'px',pointerEvents:'none',userSelect:'none',zIndex:'20'})
      const pointer=frame.stage.style.pointerEvents,inert=frame.stage.inert,busy=frame.stage.getAttribute('aria-busy')
      frame.stage.style.pointerEvents='none';frame.stage.inert=true;frame.stage.setAttribute('aria-busy','true');frame.stage.dataset.studyPageAwaiting=String(target+1)
      frame.stage.append(canvas)
      hold={canvas,stage:frame.stage,target,pointer,inert,busy,timer:window.setTimeout(release,8000)}
    }
    const onLoad=(event:Event)=>{if(event.target instanceof HTMLImageElement)remember(event.target)}
    shadow.addEventListener('load',onLoad,true)
    const page=stage.onPageChanged(({pageIndex,previousPageIndex})=>retain(pageIndex,previousPageIndex))
    const picture=render.onPictureStateChanged(event=>{
      // Viewer 3.3 registers its main Stage as "stage"; thumbnails use another lens.
      if(event.view!=='stage'||viewer.documents.getPageIndex(event.page)!==stage.getCurrentPageIndex())return
      if(['error','forbidden'].includes(event.status)){release();last=null;return}
      if(event.status==='ready'){if(hold?.target===stage.getCurrentPageIndex())release();refresh()}
    })
    const zoom=stage.onZoomChanged(()=>{
      // Paged navigation can also refit the target to the viewer width.
      // During that refit, keep the old picture until the new one is ready.
      if(hold||(last&&last.page!==stage.getCurrentPageIndex()))return
      reset()
    })
    const viewport=stage.onViewportChanged(reset)
    const settings=stage.onSettingsChanged(({changedKeys})=>{if(changedKeys.some(key=>['viewRotation','flow','spread','layout'].includes(key)))reset()})
    const camera=stage.onCameraChanged(()=>{if(!hold)refresh()})
    refresh()
    stopDocument=()=>{page();picture();zoom();viewport();settings();camera();shadow.removeEventListener('load',onLoad,true);if(refreshFrame)cancelAnimationFrame(refreshFrame);refreshFrame=0;release();last=null}
  },{immediate:true})
  return()=>{stopWatch();stopDocument();release();last=null}
}
