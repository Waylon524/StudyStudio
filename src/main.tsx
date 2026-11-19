import {MAX_MATERIAL_BYTES,MATERIAL_SIZE_LABEL} from '../shared/file-limits.mjs';
import {boundPdfSelection} from '../shared/pdf-selection.mjs'
import {boundPdfRegion} from '../shared/pdf-markup.mjs'
import React,{lazy,Suspense,useCallback,useEffect,useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Plus,ArrowUp,ArrowDown,Square,PanelLeft,PanelRight,ChevronDown,Paperclip,Settings,X,FileText,Upload} from 'lucide-react'
import {Markdown} from './Markdown'
import {MarkdownReader} from './MarkdownReader'
import {HtmlReader} from './HtmlReader'
import {notifyStudyChanged,studyApi} from './StudyComponents'
import type {CanvasSpec,OpenCanvasMeta,SavedCanvas} from './study-types'
import {isHtmlSource,isMarkdownSource,isPdfSource} from './source-types'
import {ConversationMessages,type ConversationMessage as Message,type MessageAttachment as Attachment} from './ConversationMessages'
import {useEventCallback} from './useEventCallback'
import {waitForStudySubmissions} from './study-submissions'
import {CourseContextPanel} from './CourseContextPanel'
import type {Source} from './CourseContextPanel'
import type {PdfReaderProps,PdfTextSelection,PdfRegionSelection} from './PdfReader'
import {AnimatedSidebar} from './AnimatedSidebar'
import {CourseAvatar} from './CourseAvatar'
import {SettingsPage,type CatalogModel,type ManagedCourse,type ManagedSource,type SettingsSection} from './SettingsPage'
import {EffortToggle} from './EffortSlider'
import {
 MODEL_ID,thinkingPreset,normalizePresetConfigs,restoreThinkingPreset,
 PRESET_STORAGE_KEY,PRESET_CONFIGS_STORAGE_KEY,LEGACY_EFFORT_STORAGE_KEY,
 type ThinkingPreset,type ThinkingPresetConfigs,type ThinkingPresetOverride
} from '../shared/model-presets.mjs'
import {ThinkingIndicator} from './ThinkingIndicator'
import {useComposerLayout} from './useComposerLayout'
import {useConversationScroll} from './useConversationScroll'
import {finalAssistantItems} from '../shared/final-messages.mjs'
import {isContinuationMessage} from '../shared/continuation.mjs'
import {createFinalStream,applyFinalStream,finishFinalStream,finalStreamMessages} from '../shared/final-stream.mjs'
import './streaming.css'
import './style.css'
import './study.css'
import './conversation.css'
import './studio-layout.css'
import './claude-theme.css'
import './scrollbars.css'
import './native-window.css'
import './composer-overlay.css'

const IME_CONFIRM_WINDOW_MS=50

type Course={id:string;name:string}
type ContextTab='sources'|'courseware'|'schedule'|'learning'
type UploadTarget='conversation'|'sources'|'courseware'
type Reading=
 |{kind:'pdf';source:Source;page:number;pages?:number}
 |{kind:'markdown';source:Source}
 |{kind:'html';source:Source}
 |{kind:'canvas';canvas:CanvasSpec;savedCanvas?:SavedCanvas;threadId?:string;itemId?:string}
type PdfSelection=PdfTextSelection|PdfRegionSelection
type PdfAnnotationUpdate={courseId:string;sourceId:string;page:number;revision:number}
const LegacyPdfReader=lazy(()=>import('./PdfReader').then(module=>({default:module.PdfReader})))
const EmbeddedPdfReader=lazy(()=>import('./EmbedPdfReader').then(module=>({default:module.EmbedPdfReader}),()=>({default:LegacyFallbackReader})))
function LegacyFallbackReader(props:PdfReaderProps){
 return <LegacyPdfReader {...props} annotationReadOnly/>
}
function CoursePdfReader({annotationUpdates,onFocusQuestion,...props}:PdfReaderProps&{annotationUpdates?:PdfAnnotationUpdate;onFocusQuestion?:()=>void}){
 const [fallback,setFallback]=useState(false)
 return <Suspense fallback={null}>{fallback?<LegacyFallbackReader {...props} annotationUpdates={annotationUpdates}/>:<EmbeddedPdfReader {...props} annotationUpdates={annotationUpdates} onFocusQuestion={onFocusQuestion} onViewerError={()=>setFallback(true)}/>}</Suspense>
}
function pdfSelectionPreview(text:string){
 const characters=Array.from(text.replace(/\s+/g,' ').trim())
 return characters.length>12?characters.slice(0,12).join('')+'…':characters.join('')
}
async function api(path:string,body?:unknown){const res=await fetch('/api'+path,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await res.json();if(!res.ok)throw new Error(value.error||'请求失败');return value}
function restoreMessages(thread:any):Message[]{
 const restored:Message[]=[]
 for(const turn of thread.turns||[]){const complete=turn.status==='completed',finalIds=new Set((complete?finalAssistantItems<any>(turn.items||[]):(turn.items||[]).filter((item:any)=>item.type==='agentMessage'&&item.phase==='final_answer').slice(-1)).map((item:any)=>item.id));for(const item of turn.items||[]){
  if(item.type==='userMessage'&&!isContinuationMessage(item,thread.turnActions?.[turn.id]))restored.push({id:item.id,role:'user',text:item.content?.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n')||'',attachments:thread.attachments?.[turn.id]||item.attachments||[]})
  if(item.type==='agentMessage'&&finalIds.has(item.id))restored.push({id:item.id,role:'assistant',text:item.text,incomplete:!complete})
  if(turn.status==='completed'&&item.type==='dynamicToolCall'&&item.tool==='study_render')try{const saved=thread.studyRenders?.[item.id],args=typeof item.arguments==='string'?JSON.parse(item.arguments):item.arguments,spec=saved?.spec||args?.spec||args;if(['calculate','analyze','spreadsheet','pdf_annotate','workspace_write'].includes(args?.spec?.operation))continue;if(spec)restored.push({id:saved?.itemId||('tool-'+item.id),role:'assistant',text:'```study\n'+JSON.stringify(spec)+'\n```'})}catch{}
 }}
 return restored
}
function App(){
 const [courses,setCourses]=useState<Course[]>([]),[courseId,setCourseId]=useState('general')
 const [status,setStatus]=useState<{connected:boolean;authenticated:boolean}|null>(null),[model,setModel]=useState(''),[catalogModels,setCatalogModels]=useState<CatalogModel[]>([])
 const [preset,setPreset]=useState<ThinkingPreset>(()=>restoreThinkingPreset(localStorage.getItem(PRESET_STORAGE_KEY),localStorage.getItem(LEGACY_EFFORT_STORAGE_KEY)))
 const [presetConfigs,setPresetConfigs]=useState<ThinkingPresetConfigs>(()=>{try{return normalizePresetConfigs(JSON.parse(localStorage.getItem(PRESET_CONFIGS_STORAGE_KEY)||'null'))}catch{return normalizePresetConfigs(null)}})
 const [threadId,setThreadId]=useState<string|null>(null),[messages,setMessages]=useState<Message[]>([]),[loadingCourse,setLoadingCourse]=useState(true)
 const [leftTab,setLeftTab]=useState<ContextTab>('courseware'),[leftOpen,setLeftOpen]=useState(()=>localStorage.getItem('study-studio:left-open')!=='false'),[focusSource,setFocusSource]=useState<{id:string;page?:number}|undefined>()
 const [reading,setReading]=useState<Reading|null>(null),[readerVisible,setReaderVisible]=useState(false),[openingPdf,setOpeningPdf]=useState(false)
 const [pdfAnnotationUpdate,setPdfAnnotationUpdate]=useState<PdfAnnotationUpdate>()
 const [pdfSelection,setPdfSelection]=useState<PdfSelection|null>(null)
 const [textSelectionReset,setTextSelectionReset]=useState(0)
 const pdfSelectionRef=useRef<PdfSelection|null>(null)
 const [leftWidth,setLeftWidth]=useState(()=>Number(localStorage.getItem('study-studio:left-width'))||280),[pdfWidth,setPdfWidth]=useState(()=>Number(localStorage.getItem('study-studio:pdf-width'))||600),[screenWidth,setScreenWidth]=useState(innerWidth)
 const readingRef=useRef<Reading|null>(null),readerSequence=useRef(0),readerWrites=useRef(new Map<string,Promise<any>>()),resizeRef=useRef<{side:'left'|'right';x:number;width:number}|null>(null)
 const [input,setInput]=useState(''),[busy,setBusy]=useState(false),[turnId,setTurnId]=useState<string|null>(null),[error,setError]=useState(''),[progress,setProgress]=useState('')
 const [adding,setAdding]=useState(false),[courseName,setCourseName]=useState(''),[revision,setRevision]=useState(0)
 const [settingsOpen,setSettingsOpen]=useState(false),[settingsSection,setSettingsSection]=useState<SettingsSection>('materials'),[managedCourses,setManagedCourses]=useState<ManagedCourse[]|null>(null),[settingsLoading,setSettingsLoading]=useState(false),[settingsError,setSettingsError]=useState('')
 const settingsLoad=useRef(0)
 const [skippedCourseware,setSkippedCourseware]=useState<string[]>([])
 const [pendingFiles,setPendingFiles]=useState<Attachment[]>([]),[uploading,setUploading]=useState(false),[dragging,setDragging]=useState(false)
 const turnOutputs=useRef(new Map<string,any>())
 const finalStream=useRef(createFinalStream()),streamFrame=useRef<number|null>(null),lastStreamPaint=useRef(0),[hasFinalOutput,setHasFinalOutput]=useState(false)
 const events=useRef<EventSource|null>(null),activeThread=useRef<string|null>(null),activeCourse=useRef('general'),busyRef=useRef(false),activation=useRef(0),fileInput=useRef<HTMLInputElement>(null),uploadTarget=useRef<UploadTarget>('conversation'),composerInput=useRef<HTMLTextAreaElement>(null)
 const composerComposition=useRef({active:false,endedAt:-Infinity})
 const conversationFrame=useRef<HTMLElement>(null),conversationScroller=useRef<HTMLElement>(null),composerOverlay=useRef<HTMLDivElement>(null)
 useComposerLayout({input:composerInput,frame:conversationFrame,area:composerOverlay,scroller:conversationScroller,value:input,auxiliaryKey:error+'\0'+pendingFiles.map(file=>file.id).join(',')+'\0'+uploading+'\0'+Boolean(pdfSelection)})
 const {showScrollToBottom,scrollToBottom,resetScroll}=useConversationScroll({scroller:conversationScroller,content:messages,progress,resetKey:courseId+':'+(threadId||''),enabled:!loadingCourse&&messages.length>0})
 const course=courses.find(c=>c.id===courseId)
 const {model:turnModel,effort,label:presetLabel}=thinkingPreset(preset,presetConfigs)
 const matchedTurnModel=catalogModels.find(m=>m.model===turnModel||m.id===turnModel)
 const turnModelAvailable=Boolean(matchedTurnModel&&(matchedTurnModel.supportedReasoningEfforts.length===0?!effort:Boolean(effort&&matchedTurnModel.supportedReasoningEfforts.some(e=>e.reasoningEffort===effort))))
 const refresh=useCallback(()=>setRevision(n=>n+1),[])
 const setCurrentPdfSelection=useCallback((selection:PdfSelection|null)=>{
  pdfSelectionRef.current=selection
  setPdfSelection(selection)
 },[])
 const capturePdfSelection=useCallback((selection:PdfTextSelection|null)=>{
  const current=readingRef.current,previous=pdfSelectionRef.current
  if(activeCourse.current!==courseId)return
  if(!selection){
   if(previous&&'text' in previous)setCurrentPdfSelection(null)
   return
  }
  if(!current||current.kind!=='pdf'||selection.sourceId!==current.source.id||selection.page!==current.page)return
  const text=boundPdfSelection(selection.text)
  if(!text)return
  if(previous&&'text' in previous&&previous.sourceId===selection.sourceId&&previous.page===selection.page&&previous.text===text)return
  setCurrentPdfSelection({...selection,text})
 },[courseId,setCurrentPdfSelection])
 const capturePdfRegion=useCallback((selection:PdfRegionSelection|null)=>{
  const current=readingRef.current,previous=pdfSelectionRef.current
  if(activeCourse.current!==courseId)return
  if(!selection){
   if(previous&&'region' in previous)setCurrentPdfSelection(null)
   return
  }
  if(!current||current.kind!=='pdf'||selection.sourceId!==current.source.id||selection.page!==current.page)return
  const region=boundPdfRegion(selection.region)
  if(!region)return
  if(previous&&'text' in previous)setTextSelectionReset(value=>value+1)
  setCurrentPdfSelection({...selection,region})
 },[courseId,setCurrentPdfSelection])
 function clearPdfSelection(){
  if(!pdfSelectionRef.current)return
  setCurrentPdfSelection(null)
  setTextSelectionReset(value=>value+1)
 }
 function askAboutPdfSelection(){
  if(innerWidth<900)setReaderVisible(false)
  composerInput.current?.focus({preventScroll:true})
 }
 async function loadSettingsCourses(){
  const seq=++settingsLoad.current;setSettingsLoading(true);setSettingsError('')
  try{const value=await api('/courses?includeArchived=true&stats=true');if(seq===settingsLoad.current)setManagedCourses(value.courses)}catch(e:any){if(seq===settingsLoad.current)setSettingsError(e.message)}finally{if(seq===settingsLoad.current)setSettingsLoading(false)}
 }
 function showSettings(section:SettingsSection='materials'){setAdding(false);setSettingsSection(section);setSettingsOpen(true);void loadSettingsCourses()}
 async function applyStatus(value:any){
  setStatus(value)
  const models:CatalogModel[]=Array.isArray(value.models)?value.models:[]
  setCatalogModels(models)
  const nextPresets=value.presets?normalizePresetConfigs(value.presets):presetConfigs
  if(value.presets){setPresetConfigs(nextPresets);localStorage.setItem(PRESET_CONFIGS_STORAGE_KEY,JSON.stringify(nextPresets))}
  const preferred=nextPresets.default.model
  const picked=models.find(m=>m.model===preferred)||models.find(m=>m.model===MODEL_ID)||models.find(m=>m.isDefault)||models[0]
  setModel(picked?picked.model:'')
  if(value.authenticated&&!picked)throw new Error('当前账号暂无可用模型，请检查 Codex 登录状态。')
 }
 async function refreshModels(){
  const value=await api('/status?refresh=1')
  await applyStatus(value)
 }
 async function savePresetConfigs(next:ThinkingPresetOverride){
  const value=await api('/settings/presets',{presets:next})
  const normalized=normalizePresetConfigs(value.presets)
  setPresetConfigs(normalized)
  localStorage.setItem(PRESET_CONFIGS_STORAGE_KEY,JSON.stringify(normalized))
  setError('')
 }
 async function resetPresetConfigs(){
  const value=await api('/settings/presets',{reset:true})
  const normalized=normalizePresetConfigs(value.presets)
  setPresetConfigs(normalized)
  localStorage.setItem(PRESET_CONFIGS_STORAGE_KEY,JSON.stringify(normalized))
  setError('')
 }
 async function openSourceFromSettings(id:string,sourceId:string,page?:number){
  if(activeCourse.current===id){
   setSettingsOpen(false)
   await openSource(sourceId,page)
   return
  }
  await openManagedCourse(id)
  setFocusSource({id:sourceId,page})
  setLeftTab('sources')
  setLeftOpen(true)
 }
 function handleSourcesDeleted(deletedCourseId:string,deletedSourceIds:string[],deletedAttachmentIds:string[]){
  if(deletedCourseId===activeCourse.current){
   if(readingRef.current&&readingRef.current.kind!=='canvas'&&deletedSourceIds.includes(readingRef.current.source.id)){
    clearPdfSelection();++readerSequence.current;readingRef.current=null;setReading(null);setReaderVisible(false);setOpeningPdf(false)
   }
   if(deletedAttachmentIds.length)setPendingFiles(old=>old.filter(file=>!deletedAttachmentIds.includes(file.id)))
   if(focusSource&&deletedSourceIds.includes(focusSource.id))setFocusSource(undefined)
  }
  refresh();void loadSettingsCourses()
 }
 function handleSourceRenamed(renamedCourseId:string,updatedSource:ManagedSource){
  const current=readingRef.current
  if(renamedCourseId===activeCourse.current&&current&&current.kind!=='canvas'&&current.source.id===updatedSource.id){
   const nextSource={...current.source,name:updatedSource.name,relativePath:updatedSource.relativePath,folder:updatedSource.folder,category:updatedSource.category,kind:updatedSource.kind,mime:updatedSource.mime}
   let next:Reading|null=null
   if(current.kind==='pdf')next={...current,source:nextSource}
   else if(isHtmlSource(nextSource))next={kind:'html',source:nextSource}
   else if(isMarkdownSource(nextSource))next={kind:'markdown',source:nextSource}
   readingRef.current=next;setReading(next)
   if(!next)setReaderVisible(false)
  }
  refresh();void loadSettingsCourses()
 }
 function resetLayoutWidths(){
  setLeftWidth(280);setPdfWidth(600)
  localStorage.setItem('study-studio:left-width','280')
  localStorage.setItem('study-studio:pdf-width','600')
 }
 useEffect(()=>{
  const target=window as Window&{__studyOpenSettingsRequested?:boolean}
  const open=()=>{target.__studyOpenSettingsRequested=false;showSettings()}
  const shortcut=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&event.key===','&&!document.documentElement.classList.contains('study-native-window')){event.preventDefault();open()}}
  window.addEventListener('study:open-settings',open);window.addEventListener('keydown',shortcut)
  if(target.__studyOpenSettingsRequested)open()
  return()=>{window.removeEventListener('study:open-settings',open);window.removeEventListener('keydown',shortcut)}
 },[])
 useEffect(()=>{
  const update=()=>{if(document.visibilityState==='visible')refresh()}
  window.addEventListener('focus',update);document.addEventListener('visibilitychange',update)
  return()=>{window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update)}
 },[])
 async function createManagedCourse(name:string){
  const value=await api('/courses',{name:name.trim()});setCourses(old=>[...old,value.course]);setManagedCourses(old=>old?[...old,value.course]:old);return value.course as Course
 }
 async function archiveManagedCourse(id:string,archived:boolean){
  if(id===activeCourse.current&&(busyRef.current||uploading))throw Error('请等待当前回复或文件添加完成。')
  if(id===activeCourse.current)await readerWrites.current.get(id)
  const response=await fetch('/api/courses/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({archived})}),value=await response.json()
  if(!response.ok)throw Error(value.error||'课程尚未更新，请重试。')
  ++settingsLoad.current;setSettingsLoading(false);setSettingsError('')
  const updated=value.course as ManagedCourse
  setManagedCourses(old=>(old||courses).map(item=>item.id===id?updated:item))
  setCourses(old=>archived?old.filter(item=>item.id!==id):old.some(item=>item.id===id)?old.map(item=>item.id===id?updated:item):[...old,updated])
  if(archived&&activeCourse.current===id)await activateCourse('general')
 }
 async function openManagedCourse(id:string){
  if(activeCourse.current===id){setSettingsOpen(false);return}
  if(busyRef.current||uploading)throw Error('请等待当前回复或文件添加完成。')
  setSettingsOpen(false);await activateCourse(id)
 }
 function resetFinalOutput(update=true){if(streamFrame.current!==null)cancelAnimationFrame(streamFrame.current);streamFrame.current=null;lastStreamPaint.current=0;finalStream.current=createFinalStream();if(update)setHasFinalOutput(false)}
 function paintFinalOutput(){
  const state=finalStream.current,visible=finalStreamMessages(state),owned=new Set(state.items.keys()),visibleIds=new Set(visible.map(item=>item.id))
  setHasFinalOutput(visible.length>0)
  setMessages(old=>{
   let changed=false
   const next=old.filter(item=>{const keep=!owned.has(item.id)||visibleIds.has(item.id);if(!keep)changed=true;return keep})
   for(const message of visible){const index=next.findIndex(item=>item.id===message.id);if(index<0){next.push(message);changed=true}else{const previous=next[index];if(previous.text!==message.text||previous.streaming!==message.streaming||previous.incomplete!==message.incomplete){next[index]=message;changed=true}}}
   return changed?next:old
  })
 }
 function queueFinalOutput(id:string){
  if(streamFrame.current!==null)return
  const render=(now:number)=>{if(activeThread.current!==id){streamFrame.current=null;return}if(now-lastStreamPaint.current<32){streamFrame.current=requestAnimationFrame(render);return}streamFrame.current=null;lastStreamPaint.current=now;paintFinalOutput()}
  streamFrame.current=requestAnimationFrame(render)
 }
 function finishFinalOutput(success=false,items:any[]=[]){if(streamFrame.current!==null)cancelAnimationFrame(streamFrame.current);streamFrame.current=null;if(!finalStream.current.finished)finishFinalStream(finalStream.current,{success,items});paintFinalOutput()}

 useEffect(()=>{
  let alive=true
  api('/status').then(value=>{if(!alive)return;return applyStatus(value)}).catch(e=>{if(alive)setError(e.message)})
  api('/courses').then(value=>{if(!alive)return;setCourses(value.courses);const saved=localStorage.getItem('study-studio:active-course');void activateCourse(value.courses.some((c:Course)=>c.id===saved)?saved!:value.courses[0]?.id||'general')}).catch(e=>{if(alive){setError(e.message);setLoadingCourse(false)}})
  return ()=>{alive=false;activation.current++;events.current?.close();resetFinalOutput(false)}
 },[])
 useEffect(()=>{const resize=()=>setScreenWidth(innerWidth),escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!document.querySelector('[aria-modal="true"]')){if(innerWidth<900)setReaderVisible(false);if(innerWidth<1000)setLeftOpen(false);setAdding(false)}};window.addEventListener('resize',resize);window.addEventListener('keydown',escape);return()=>{window.removeEventListener('resize',resize);window.removeEventListener('keydown',escape)}},[])
 useEffect(()=>{localStorage.setItem('study-studio:left-open',String(leftOpen))},[leftOpen])
 useEffect(()=>{localStorage.setItem(PRESET_STORAGE_KEY,preset);localStorage.removeItem(LEGACY_EFFORT_STORAGE_KEY)},[preset])
 useEffect(()=>{if(catalogModels.length&&!turnModelAvailable)setError(`${presetLabel} 档位配置的 ${turnModel}${effort?' ('+effort+')':''} 暂不可用，请在设置中更换模型或切换思考强度。`)},[preset,presetLabel,turnModel,effort,catalogModels,turnModelAvailable,loadingCourse])
 async function connect(id:string){
  events.current?.close();activeThread.current=id
  const stream=new EventSource('/api/events?threadId='+encodeURIComponent(id));events.current=stream
  stream.onmessage=event=>{
   if(activeThread.current!==id)return
   const {method,params:p}=JSON.parse(event.data)
   if(method==='item/agentMessage/delta'||method==='item/started'&&p.item?.type==='agentMessage'){
    if(applyFinalStream(finalStream.current,method,p))queueFinalOutput(id)
   }else if(method==='item/completed'&&p.item?.type==='agentMessage'){
    turnOutputs.current.set(p.item.id,p.item);if(applyFinalStream(finalStream.current,method,p))queueFinalOutput(id)
   }else if(method==='study/render'){
    const itemId=p.itemId||p.set?.id||crypto.randomUUID(),spec=p.spec||p.set
    if(spec)turnOutputs.current.set(itemId,{id:itemId,type:'studyRender',text:'```study\n'+JSON.stringify(spec)+'\n```'})
    refresh()
   }else if(method==='pdf/annotations-updated'&&p.courseId===activeCourse.current&&typeof p.sourceId==='string'&&Number.isSafeInteger(p.page)){
    setPdfAnnotationUpdate(previous=>({courseId:p.courseId,sourceId:p.sourceId,page:p.page,revision:(previous?.revision||0)+1}))
   }else if(['study/updated','workspace/updated','memory/updated','sources/updated'].includes(method))refresh()
   else if(method==='study/error')setError(p.message||p.error?.message||'学习记录保存失败，请重试')
   else if(method==='turn/started'){if(finalStream.current.finished||finalStream.current.turnId&&finalStream.current.turnId!==p.turn?.id)resetFinalOutput();finalStream.current.turnId=p.turn?.id||null;setTurnId(p.turn?.id||null)}
   else if(method==='item/started'&&p.item?.type==='contextCompaction')setProgress('正在整理较早的对话…')
   else if(method==='item/completed'&&p.item?.type==='contextCompaction'){if(busyRef.current)setProgress('继续思考…')}
   else if(method==='item/started'&&p.item?.type==='dynamicToolCall')setProgress(p.item.tool==='study_current_slide'?'正在查看当前课件…':p.item.tool==='study_pdf_annotate'?'正在标注课件…':p.item.tool==='study_workspace_write'?'正在生成课程资料文件…':p.item.tool==='study_workspace_list'?'正在浏览课程目录…':p.item.tool?.includes('read')?'正在阅读课程资料…':p.item.tool?.includes('render')?'正在准备练习…':p.item.tool?.includes('memory')?'正在记住你的学习习惯…':'正在整理学习记录…')
   else if(method==='turn/completed'){
    finishFinalOutput(p.turn?.status==='completed',p.turn?.items||[])
    if(p.turn?.status==='completed'){
     const visible:Message[]=[...turnOutputs.current.values()].filter(item=>item.type==='studyRender').map(item=>({id:item.id,role:'assistant',text:item.text}))
     setMessages(old=>[...old,...visible.filter(item=>!old.some(existing=>existing.id===item.id))])
    }
    turnOutputs.current.clear();setBusy(false);busyRef.current=false;setProgress('');setTurnId(null);refresh();if(p.turn?.status==='failed')setError(p.turn?.error?.message||'本次回复未完成')
   }
   else if(method==='error'){setError(p.error?.message||p.message||'对话出现错误');if(!p.willRetry){finishFinalOutput();setBusy(false);busyRef.current=false;setProgress('');setTurnId(null)}}
   else if(method==='connection/error'){setError(p.message||'连接已关闭');finishFinalOutput();setBusy(false);busyRef.current=false;setProgress('');setTurnId(null)}
  }
  stream.onerror=()=>{if(busyRef.current)setProgress('正在恢复连接…')}
  return new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('连接超时，请重试')),12000);stream.onopen=()=>{clearTimeout(timer);resolve()};stream.addEventListener('error',()=>{if(stream.readyState===EventSource.CLOSED){clearTimeout(timer);reject(new Error('连接已关闭，请重试'))}},{once:true})})
 }
 async function activateCourse(id:string){
  if(busyRef.current||uploading)return
  resetScroll()
  const seq=++activation.current;events.current?.close();events.current=null;activeThread.current=null;resetFinalOutput()
  if(activeCourse.current!==id){setFocusSource(undefined)}
  clearPdfSelection()
  const readerSeq=++readerSequence.current;readingRef.current=null;setReading(null);setReaderVisible(false);setOpeningPdf(false)
  turnOutputs.current.clear();activeCourse.current=id;setCourseId(id);localStorage.setItem('study-studio:active-course',id);setThreadId(null);setMessages([]);setPendingFiles([]);setSkippedCourseware([]);setError('');setProgress('');setInput('');setLoadingCourse(true)
  try{
   const value=await api('/courses/'+encodeURIComponent(id)+'/conversation',model?{model}:{})
   if(seq!==activation.current)return
   const [threadResult,readerResult]=await Promise.allSettled([api('/threads/'+encodeURIComponent(value.threadId)),(async()=>{await readerWrites.current.get(id)?.catch(()=>{});return api('/courses/'+encodeURIComponent(id)+'/reader')})()])
   if(seq!==activation.current)return
   if(threadResult.status==='rejected')throw threadResult.reason
   setThreadId(value.threadId);setMessages(restoreMessages(threadResult.value.thread))
   if(readerSeq===readerSequence.current){
    if(readerResult.status==='fulfilled'&&readerResult.value.reader){const r=readerResult.value.reader;if(r.source){const next:Reading={kind:'pdf',source:r.source,page:r.page,pages:r.pages};readingRef.current=next;setReading(next);setReaderVisible(true);if(innerWidth<1100)setLeftOpen(false)}}
    else if(readerResult.status==='rejected')setError('上次的课件暂时无法打开，你仍可继续对话。')
   }
   await connect(value.threadId);refresh()
  }catch(e:any){if(seq===activation.current)setError(e.message)}finally{if(seq===activation.current)setLoadingCourse(false)}
 }
 async function sendText(text:string,attached=pendingFiles,action?:'continue'){
  const continuing=action==='continue'
  if((continuing?!messages.some(message=>message.role==='assistant'&&message.text.trim()):!text.trim()&&!attached.length)||busyRef.current||busy||uploading||loadingCourse||!status?.authenticated||!threadId||!model)return
  if(!turnModelAvailable){setError('当前思考强度所需模型暂不可用，请切换后重试。');return}
  const readingAtSend=readingRef.current
  const pdfReading=readingAtSend?.kind==='pdf'?readingAtSend:null
  const selection=pdfSelectionRef.current
  const selected=pdfReading&&selection&&selection.sourceId===pdfReading.source.id&&selection.page===pdfReading.page?selection:null
  const reader=pdfReading?{
   sourceId:pdfReading.source.id,
   page:pdfReading.page,
   ...(selected&&'text' in selected?{selectedText:selected.text}:{}),
   ...(selected&&'region' in selected?{selectedRegion:selected.region}:{})
  }:null
  const activeDocument=readingAtSend&&readingAtSend.kind!=='pdf'
   ?(readingAtSend.kind==='canvas'
     ?{kind:'canvas',title:readingAtSend.canvas.title}
     :{kind:readingAtSend.kind,sourceId:readingAtSend.source.id})
   :undefined
  const draftBeforeSave=input
  busyRef.current=true;setBusy(true);setError('');setProgress('正在保存作答…')
  try{await waitForStudySubmissions(courseId)}catch(e:any){busyRef.current=false;setBusy(false);setProgress('');setError(e.message);return}
  resetScroll()
  turnOutputs.current.clear();resetFinalOutput();setError('');setBusy(true);busyRef.current=true;setProgress('正在思考…')
  if(!continuing){setInput(current=>current===draftBeforeSave?'':current);setPendingFiles(current=>current.filter(file=>!attached.some(sent=>sent.id===file.id)));setMessages(old=>[...old,{id:crypto.randomUUID(),role:'user',text:text.trim(),attachments:attached}])}
  try{
   if(activeThread.current!==threadId||!events.current)await connect(threadId)
   const value=await api('/turn',{threadId,text:text.trim(),attachmentIds:attached.map(a=>a.id),...(action?{action}:{}),model:turnModel,effort,reader,...(activeDocument?{activeDocument}:{})})
   if(selected&&pdfSelectionRef.current===selected)clearPdfSelection()
   if(busyRef.current)setTurnId(value.turnId)
  }catch(e:any){finishFinalOutput();setBusy(false);busyRef.current=false;setProgress('');setError(e.message);if(!continuing){setInput(text);setPendingFiles(attached)}}
 }
 function send(event?:React.FormEvent){event?.preventDefault();return sendText(input)}
 function handleComposerKeyDown(event:React.KeyboardEvent<HTMLTextAreaElement>){
  if(event.key!=='Enter'||event.shiftKey||event.defaultPrevented)return
  const composition=composerComposition.current
  if(composition.active||event.nativeEvent.isComposing||event.nativeEvent.keyCode===229)return
  event.preventDefault()
  // WebKit can deliver the confirmation Enter just after compositionend.
  if(event.repeat||performance.now()-composition.endedAt<IME_CONFIRM_WINDOW_MS)return
  void send()
 }
 async function stop(){if(!threadId||!turnId)return;try{await api('/interrupt',{threadId,turnId})}catch(e:any){setError(e.message)}}
 async function addCourse(event:React.FormEvent){event.preventDefault();if(!courseName.trim())return;try{const created=await createManagedCourse(courseName);setAdding(false);setCourseName('');await activateCourse(created.id)}catch(e:any){setError(e.message)}}
 async function upload(files:FileList|File[]|null,target=uploadTarget.current){
  const attach=target==='conversation',courseware=target==='courseware'
  if(!files?.length||(attach&&(busy||loadingCourse))||uploading)return
  setUploading(true);setError('')
  if(courseware)setSkippedCourseware([])
  const base='/api/courses/'+encodeURIComponent(courseId),added:string[]=[],skipped:string[]=[]
  try{
   for(const file of Array.from(files)){
    try{
     if(courseware&&(!/\.pdf$/i.test(file.name)||!/^%PDF-[0-9]\.[0-9][\t\n\f\r ]/.test(await file.slice(0,9).text()))){
      skipped.push(file.name);continue
     }
     if(file.size>MAX_MATERIAL_BYTES)throw new Error(file.name+' 超过 '+MATERIAL_SIZE_LABEL)
     const folder=['待整理',file.webkitRelativePath?.split('/').slice(0,-1).join('/')].filter(Boolean).join('/')
     const response=await fetch(base+'/attachments',{method:'POST',headers:{
      'Content-Type':file.type||'application/octet-stream','x-file-name':encodeURIComponent(file.name),
      ...(courseware?{'x-upload-intent':'courseware'}:{'x-folder':encodeURIComponent(folder)}),
     },body:file})
     const value=await response.json()
     if(!response.ok)throw new Error(value.error||'添加资料失败')
     added.push(value.attachment.id)
     if(attach)setPendingFiles(old=>[...old,value.attachment])
     setLeftTab(courseware?'courseware':'sources');setLeftOpen(true);refresh()
    }catch(error:any){setError(error.message)}
   }
   if(added.length&&!courseware){
    try{for(let offset=0;offset<added.length;offset+=100)await api('/courses/'+encodeURIComponent(courseId)+'/imports',{attachmentIds:added.slice(offset,offset+100)});refresh()}
    catch(error:any){setError('资料已保存，自动整理尚未启动：'+error.message)}
   }
  }finally{
   if(skipped.length&&activeCourse.current===courseId){setSkippedCourseware(skipped);setLeftTab('courseware');setLeftOpen(true)}
   setUploading(false);if(fileInput.current)fileInput.current.value=''
  }
 }
 function chooseFiles(target:UploadTarget='conversation'){uploadTarget.current=target;fileInput.current?.click()}
 const askAgent=useEventCallback((text:string)=>{if(innerWidth<1000)setLeftOpen(false);if(innerWidth<900)setReaderVisible(false);void sendText(text,[])})
 function persistReader(course:string,value:{sourceId:string|null;page?:number}){const previous=readerWrites.current.get(course)||Promise.resolve();const pending=previous.catch(()=>{}).then(()=>api('/courses/'+encodeURIComponent(course)+'/reader',value));readerWrites.current.set(course,pending);const clear=()=>{if(readerWrites.current.get(course)===pending)readerWrites.current.delete(course)};void pending.then(clear,clear);return pending}
 async function openCourseware(source:Source,page?:number){
  if(!isPdfSource(source)){setError('请先将这份课件转换为 PDF 后阅读。');return}
  const seq=++readerSequence.current,course=courseId;setOpeningPdf(true);setError('')
  try{
   const value=await persistReader(course,{sourceId:source.id,...(page===undefined?{}:{page})})
   if(seq!==readerSequence.current||activeCourse.current!==course)return
   const r=value.reader,next:Reading={kind:'pdf',source:r.source||{...source,selected:true},page:r.page,pages:r.pages}
   const current=readingRef.current
   if(!current||current.kind!=='pdf'||current.source.id!==next.source.id||current.page!==next.page)clearPdfSelection()
   readingRef.current=next;setReading(next);setReaderVisible(true);setFocusSource(undefined);if(innerWidth<1100)setLeftOpen(false);refresh()
  }catch(e:any){if(seq===readerSequence.current)setError(e.message)}finally{if(seq===readerSequence.current)setOpeningPdf(false)}
 }
 function openDocument(source:Source){
  if(!isMarkdownSource(source)&&!isHtmlSource(source))return
  ++readerSequence.current;setOpeningPdf(false);setError('');clearPdfSelection()
  const next:Reading={kind:isHtmlSource(source)?'html':'markdown',source}
  readingRef.current=next;setReading(next);setReaderVisible(true);setFocusSource(undefined)
  if(innerWidth<1100)setLeftOpen(false)
 }
 function openCanvasInReader(canvas:CanvasSpec,meta?:OpenCanvasMeta){
  ++readerSequence.current;setOpeningPdf(false);setError('');clearPdfSelection()
  const next:Reading={kind:'canvas',canvas,savedCanvas:meta?.savedCanvas,threadId:meta?.threadId,itemId:meta?.itemId}
  readingRef.current=next;setReading(next);setReaderVisible(true);setFocusSource(undefined)
  if(innerWidth<1100)setLeftOpen(false)
  if(meta?.savedCanvas){
   const course=activeCourse.current
   void studyApi('/courses/'+encodeURIComponent(course)+'/canvas/activity',{canvasId:meta.savedCanvas.id,kind:'opened'}).then(()=>{notifyStudyChanged(course);refresh()}).catch(()=>{})
  }
 }
 const onOpenCanvas=useEventCallback(openCanvasInReader)
 async function saveActiveCanvas(){
  const current=readingRef.current
  if(!current||current.kind!=='canvas'||!current.threadId||!current.itemId)return
  const course=activeCourse.current
  const result=await studyApi('/courses/'+encodeURIComponent(course)+'/canvas/save',{threadId:current.threadId,itemId:current.itemId,canvas:current.canvas})
  if(readingRef.current===current){
   const next:Reading={...current,savedCanvas:result.canvas}
   readingRef.current=next;setReading(next)
  }
  notifyStudyChanged(course);refresh()
 }
 function reportActiveCanvas(report:{label:string;value?:string}){
  const current=readingRef.current
  if(!current||current.kind!=='canvas'||!current.savedCanvas)return
  const course=activeCourse.current
  void studyApi('/courses/'+encodeURIComponent(course)+'/canvas/activity',{canvasId:current.savedCanvas.id,kind:'reported_interaction',...report}).catch(()=>{})
 }
 function askAboutDocument(source:Source){
  setInput(prev=>prev.trim()?prev:`请结合《${source.name}》帮我`)
  if(innerWidth<900)setReaderVisible(false)
  composerInput.current?.focus({preventScroll:true})
 }
 function askAboutCanvas(canvas:CanvasSpec){
  setInput(prev=>prev.trim()?prev:`关于交互画布《${canvas.title}》，`)
  if(innerWidth<900)setReaderVisible(false)
  composerInput.current?.focus({preventScroll:true})
 }
 function changePage(page:number){
  const current=readingRef.current;if(!current||current.kind!=='pdf')return
  if(current.page!==page)clearPdfSelection()
  const next:Reading={...current,page};readingRef.current=next;setReading(next)
  const seq=++readerSequence.current,course=courseId
  void persistReader(course,{sourceId:current.source.id,page}).catch(e=>{if(seq===readerSequence.current&&activeCourse.current===course)setError('页码同步失败：'+e.message)})
 }
 function closeReader(){
  const wasPdf=readingRef.current?.kind==='pdf'
  clearPdfSelection();const course=courseId;++readerSequence.current;readingRef.current=null;setReading(null);setReaderVisible(false);setOpeningPdf(false)
  if(wasPdf)void persistReader(course,{sourceId:null}).catch(e=>{if(activeCourse.current===course)setError(e.message)})
 }
 async function openSource(id:string,page?:number){
  const course=courseId,seq=activation.current
  try{
   const value=await api('/courses/'+encodeURIComponent(course)+'/sources')
   if(seq!==activation.current||activeCourse.current!==course)return
   const source=value.sources.find((s:Source)=>s.id===id)
   if(!source)throw Error('这份来源暂时无法打开。')
   if(isPdfSource(source))await openCourseware(source,page)
   else if(isMarkdownSource(source)||isHtmlSource(source))openDocument(source)
   else{setFocusSource({id,page});setLeftTab('sources');setLeftOpen(true);if(innerWidth<1000)setReaderVisible(false)}
  }catch(e:any){if(seq===activation.current&&activeCourse.current===course)setError(e.message)}
 }
 const onMessageSource=useEventCallback(openSource)
 const renderMarkdown=useCallback((text:string)=><Markdown text={text} allowStudy={false} onOpenSource={onMessageSource}/>,[onMessageSource])
 async function openAttachment(a:Attachment){const course=courseId,seq=activation.current;try{const value=await api('/courses/'+encodeURIComponent(course)+'/sources');if(seq!==activation.current||activeCourse.current!==course)return;const source=value.sources.find((s:Source)=>s.attachmentId===a.id);if(source)void openSource(source.id);else setError('这份资料暂时无法打开，请在资料栏重试。')}catch(e:any){if(seq===activation.current&&activeCourse.current===course)setError(e.message)}}
 const onMessageAttachment=useEventCallback(openAttachment)
 const actualLeftWidth=Math.max(220,Math.min(420,leftWidth))
 const actualPdfWidth=Math.max(360,Math.min(pdfWidth,Math.max(360,screenWidth-(leftOpen&&screenWidth>1100?actualLeftWidth:0)-340)))
 function resizeStart(event:React.PointerEvent<HTMLDivElement>,side:'left'|'right'){event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);resizeRef.current={side,x:event.clientX,width:side==='left'?actualLeftWidth:actualPdfWidth};document.documentElement.classList.add('studio-resizing')}
 function resizeMove(event:React.PointerEvent<HTMLDivElement>){const drag=resizeRef.current;if(!drag)return;const delta=event.clientX-drag.x;if(drag.side==='left')setLeftWidth(Math.max(220,Math.min(420,drag.width+delta)));else setPdfWidth(Math.max(360,Math.min(Math.max(360,screenWidth-(leftOpen?actualLeftWidth:0)-340),drag.width-delta)))}
 function resizeEnd(event:React.PointerEvent<HTMLDivElement>){if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);resizeRef.current=null;document.documentElement.classList.remove('studio-resizing');localStorage.setItem('study-studio:left-width',String(leftWidth));localStorage.setItem('study-studio:pdf-width',String(pdfWidth))}
 function resizeKey(event:React.KeyboardEvent<HTMLDivElement>,side:'left'|'right'){if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const change=event.key==='ArrowRight'?20:-20;if(side==='left')setLeftWidth(value=>Math.max(220,Math.min(420,value+change)));else setPdfWidth(value=>Math.max(360,Math.min(Math.max(360,screenWidth-(leftOpen?actualLeftWidth:0)-340),value-change)))}

 const currentReadingSourceId=reading&&reading.kind!=='canvas'?reading.source.id:undefined
 const readerToggleLabel=reading?.kind==='pdf'?'课件':reading?.kind==='markdown'?'文档':reading?.kind==='html'?'网页':'画布'
 const composerPlaceholder=reading?.kind==='pdf'
  ?'围绕这一页提问，或做一道随堂练习…'
  :reading?.kind==='markdown'
   ?'围绕这份文档提问，或让助教补充修改…'
   :reading?.kind==='html'||reading?.kind==='canvas'
    ?'围绕右侧页面提问，或让助教调整交互…'
    :'提问，或拖入图片与课程资料…'

 return <div className="studio-shell" onDragOverCapture={e=>{if((e.target as HTMLElement).closest?.('[data-study-answer-input],.settings-backdrop'))setDragging(false)}} onDropCapture={e=>{if((e.target as HTMLElement).closest?.('[data-study-answer-input],.settings-backdrop'))setDragging(false)}} onDragOver={e=>{if(settingsOpen||(e.target as HTMLElement).closest?.('.settings-backdrop'))return;if(e.dataTransfer.types.includes('Files')){e.preventDefault();setDragging(true)}}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDragging(false)}} onDrop={e=>{if(settingsOpen||(e.target as HTMLElement).closest?.('.settings-backdrop'))return;e.preventDefault();setDragging(false);void upload(e.dataTransfer.files,(e.target as Element).closest?.('[data-courseware-drop-zone]')?'courseware':'conversation')}}>
  <input ref={fileInput} type="file" multiple className="sr-only" aria-label="上传图片或文件" onChange={e=>upload(e.target.files)}/>
  {dragging&&<div className="drop-overlay"><Upload size={30}/><strong>添加到「{course?.name}」</strong></div>}
  <header className="studio-topbar"><div className="studio-header-left"><button className="icon-button" aria-label={leftOpen?'收起资料栏':'展开资料栏'} aria-expanded={leftOpen} onClick={()=>{setLeftOpen(!leftOpen);if(!leftOpen&&innerWidth<1000)setReaderVisible(false)}}><PanelLeft size={19}/></button><a className="studio-brand" href="/" onClick={e=>e.preventDefault()}><span>Study Studio</span></a><span className="studio-header-divider"/><label className="studio-course-picker"><span className="sr-only">课程</span>{!loadingCourse&&<CourseAvatar courseId={courseId} size={24}/>}<select aria-label="课程" value={courseId} onChange={e=>void activateCourse(e.target.value)} disabled={busy||uploading}>{courses.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select><ChevronDown size={13}/></label><button className="icon-button" aria-label="添加课程" onClick={()=>setAdding(v=>!v)} disabled={busy||uploading||loadingCourse}><Plus size={16}/></button></div><div className="studio-header-right">{openingPdf&&<span className="studio-opening"><span className="spinner"/>正在打开课件…</span>}{reading&&!readerVisible&&<button className="reader-toggle" aria-label={readerVisible?'收起右侧阅读器':'展开右侧阅读器'} onClick={()=>{setReaderVisible(!readerVisible);if(innerWidth<1000)setLeftOpen(false)}}><PanelRight size={17}/><span>{readerToggleLabel}</span></button>}<button type="button" className="icon-button studio-settings-button" aria-label="设置" title="设置 (⌘,)" onClick={()=>showSettings()}><Settings size={17}/></button><span className={'connection-dot '+(status?.authenticated?'online':'')} title={status?.authenticated?'Codex 已连接':'正在连接 Codex'}/></div></header>
  {adding&&<form className="studio-course-add" onSubmit={addCourse}><input autoFocus aria-label="新课程名称" placeholder="课程名称" value={courseName} onChange={e=>setCourseName(e.target.value)} maxLength={80}/><button type="submit">添加</button><button type="button" aria-label="取消添加课程" onClick={()=>setAdding(false)}><X size={15}/></button></form>}
  <main className="studio-body">
   {leftOpen&&<button className="studio-left-scrim" aria-label="收起资料栏遮罩" onClick={()=>setLeftOpen(false)}/>}<AnimatedSidebar open={leftOpen} width={actualLeftWidth+5} side="left"><aside className="studio-left" style={{width:actualLeftWidth}} data-courseware-drop-zone={leftOpen&&leftTab==='courseware'?'':undefined}><CourseContextPanel key={courseId} courseId={courseId} revision={revision} tab={leftTab} onTabChange={setLeftTab} onUpload={chooseFiles} onManageMaterials={()=>showSettings('materials')} uploadInProgress={uploading} skippedCourseware={skippedCourseware} onOpenCourseware={(source,page)=>void openCourseware(source,page)} onOpenDocument={openDocument} onOpenCanvas={onOpenCanvas} currentSourceId={currentReadingSourceId} onAskAgent={askAgent} onDraftMessage={text=>{setInput(text);if(innerWidth<1000)setLeftOpen(false);if(innerWidth<900)setReaderVisible(false);composerInput.current?.focus()}} onChanged={refresh} renderMarkdown={renderMarkdown} focusSourceId={focusSource?.id} focusSourcePage={focusSource?.page}/></aside><div className="studio-resizer left" role="separator" aria-label="调整资料栏宽度" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={420} aria-valuenow={actualLeftWidth} tabIndex={0} onPointerDown={e=>resizeStart(e,'left')} onPointerMove={resizeMove} onPointerUp={resizeEnd} onPointerCancel={resizeEnd} onKeyDown={e=>resizeKey(e,'left')} onDoubleClick={()=>setLeftWidth(280)}/></AnimatedSidebar>
   <section ref={conversationFrame} className={'conversation'+(!loadingCourse&&!messages.length?' is-empty':'')}>
    <h1 className="sr-only">{course?.name||'通用学习'}</h1>
    <section ref={conversationScroller} className="reading-pane" aria-label="课程对话"><div className="reading-column messages">
     {loadingCourse?<div className="course-loading"><span className="spinner"/>正在打开课程…</div>:!messages.length?<div className="welcome"><div className="welcome-title"><CourseAvatar courseId={courseId} size={48}/><h2>今天想弄懂什么？</h2></div></div>:<ConversationMessages messages={messages} courseId={courseId} threadId={threadId} revision={revision} onLearningChange={refresh} onAskAgent={askAgent} onOpenSource={onMessageSource} onOpenAttachment={onMessageAttachment} onOpenCanvas={onOpenCanvas} renderMarkdown={renderMarkdown}/>}
     {busy&&!hasFinalOutput&&<ThinkingIndicator courseId={courseId} preset={preset}/>}<div className="message-end"/>
    </div></section>
    <div className="composer-area" ref={composerOverlay}><div className="composer-column">{showScrollToBottom&&<button type="button" className="conversation-bottom-button" aria-label="回到底部" title="回到底部" onPointerDown={event=>event.preventDefault()} onClick={scrollToBottom}><ArrowDown size={17}/></button>}{error&&<div className="app-error" role="alert"><span>{error}</span>{!threadId&&<button onClick={()=>void activateCourse(courseId)}>重试</button>}<button aria-label="关闭错误" onClick={()=>setError('')}>×</button></div>}
     {!!pendingFiles.length&&<div className="pending-attachments">{pendingFiles.map(a=><span key={a.id}><FileText size={13}/>{a.name}<button type="button" aria-label={'移除附件 '+a.name} onClick={()=>setPendingFiles(old=>old.filter(f=>f.id!==a.id))}><X size={12}/></button></span>)}</div>}
     {pdfSelection&&<div className="pending-attachments">
      <span className="pdf-selection-chip">
       <FileText size={13}/>
       <span className="pdf-selection-page">{'text' in pdfSelection?'课件选文':'课件选区'} · 第 {pdfSelection.page} 页</span>
       {'text' in pdfSelection&&<span className="pdf-selection-excerpt" title={pdfSelection.text.slice(0,320)}>{pdfSelectionPreview(pdfSelection.text)}</span>}
       <button type="button" aria-label={'text' in pdfSelection?'移除课件选中文字':'移除课件选区'} onClick={clearPdfSelection}><X size={12}/></button>
      </span>
     </div>}
     <form className="composer" onSubmit={send}>
      <textarea
       ref={composerInput}
       aria-label="学习问题"
       placeholder={composerPlaceholder}
       value={input}
       rows={1}
       onChange={event=>setInput(event.target.value)}
       onCompositionStart={()=>{composerComposition.current.active=true}}
       onCompositionEnd={()=>{composerComposition.current={active:false,endedAt:performance.now()}}}
       onBlur={()=>{composerComposition.current.active=false}}
       onKeyDown={handleComposerKeyDown}
      />
      <div className="composer-footer"><div className="composer-options"><button type="button" className="attach-button icon-button" aria-label="添加图片或文件" title="添加图片或文件" onClick={()=>chooseFiles()} disabled={busy||uploading||loadingCourse}><Paperclip size={18}/></button><EffortToggle value={preset} configs={presetConfigs} onChange={value=>{setPreset(value);setError('')}} disabled={busy||loadingCourse||!model}/>{uploading&&<span className="uploading-label">正在添加…</span>}</div><button type="button" className="continue-button" onClick={()=>void sendText('',[],'continue')} disabled={busy||!messages.some(message=>message.role==='assistant'&&message.text.trim())||!status?.authenticated||uploading||loadingCourse||!threadId||!model||!turnModelAvailable}>继续</button>{busy?<button type="button" className="send-button stop" aria-label="停止回复" onClick={stop} disabled={!turnId}><Square size={16}/></button>:<button className="send-button" type="submit" aria-label="发送问题" disabled={(!input.trim()&&!pendingFiles.length)||!status?.authenticated||uploading||loadingCourse||!threadId||!model||!turnModelAvailable}><ArrowUp size={19}/></button>}</div></form>
    </div></div>
   </section>
   <AnimatedSidebar open={Boolean(reading&&readerVisible)} width={actualPdfWidth+5} side="right">{reading&&<><div className="studio-resizer right" role="separator" aria-label="调整阅读器宽度" aria-orientation="vertical" aria-valuemin={360} aria-valuemax={Math.max(360,screenWidth-340)} aria-valuenow={actualPdfWidth} tabIndex={0} onPointerDown={e=>resizeStart(e,'right')} onPointerMove={resizeMove} onPointerUp={resizeEnd} onPointerCancel={resizeEnd} onKeyDown={e=>resizeKey(e,'right')} onDoubleClick={()=>setPdfWidth(600)}/><aside className="studio-pdf" style={{width:actualPdfWidth}}>
    {reading.kind==='pdf'?<CoursePdfReader key={courseId+':'+reading.source.id} annotationUpdates={pdfAnnotationUpdate?.courseId===courseId&&pdfAnnotationUpdate.sourceId===reading.source.id?pdfAnnotationUpdate:undefined} keyboardEnabled={readerVisible} courseId={courseId} source={{id:reading.source.id,name:reading.source.name,url:reading.source.url||'/api/courses/'+encodeURIComponent(courseId)+'/sources/'+encodeURIComponent(reading.source.id)+'/file'}} page={reading.page} onPageChange={changePage} onClose={closeReader} onTextSelectionChange={capturePdfSelection} textSelectionReset={textSelectionReset} regionSelection={pdfSelection&&'region' in pdfSelection?pdfSelection:null} onRegionSelectionChange={capturePdfRegion} onFocusQuestion={askAboutPdfSelection} onAskSelection={screenWidth<900&&pdfSelection?askAboutPdfSelection:undefined}/>
    :reading.kind==='markdown'?<MarkdownReader key={courseId+':md:'+reading.source.id} courseId={courseId} source={reading.source} revision={revision} onClose={closeReader} onOpenSource={onMessageSource} onAskAboutDocument={askAboutDocument}/>
    :reading.kind==='html'?<HtmlReader key={courseId+':html:'+reading.source.id} kind="file" courseId={courseId} source={reading.source} revision={revision} visible={readerVisible} onClose={closeReader} onAskAboutDocument={askAboutDocument}/>
    :<HtmlReader key={courseId+':canvas:'+reading.canvas.id+':'+(reading.itemId||'')} kind="canvas" canvas={reading.canvas} saved={Boolean(reading.savedCanvas)} onSave={reading.threadId&&reading.itemId?saveActiveCanvas:undefined} onReport={reading.savedCanvas?reportActiveCanvas:undefined} visible={readerVisible} onClose={closeReader} onAskAboutCanvas={askAboutCanvas}/>}
   </aside></>}</AnimatedSidebar>
  </main>
  {settingsOpen&&<SettingsPage revision={revision} initialSection={settingsSection} courses={managedCourses||courses} activeCourseId={courseId} currentSourceId={currentReadingSourceId} conversationBusy={busy||uploading} loading={settingsLoading} loadError={settingsError} preset={preset} onPresetChange={value=>{setPreset(value);setError('')}} presetConfigs={presetConfigs} onSavePresetConfigs={savePresetConfigs} onResetPresetConfigs={resetPresetConfigs} catalogModels={catalogModels} onRefreshModels={refreshModels} status={status} leftOpen={leftOpen} onToggleLeftOpen={()=>setLeftOpen(v=>!v)} onResetLayout={resetLayoutWidths} onCreate={async name=>{await createManagedCourse(name);void loadSettingsCourses()}} onArchive={async(id,archived)=>{await archiveManagedCourse(id,archived);void loadSettingsCourses()}} onOpen={openManagedCourse} onChanged={()=>{refresh();void loadSettingsCourses()}} onOpenSource={openSourceFromSettings} onSourcesDeleted={handleSourcesDeleted} onSourceRenamed={handleSourceRenamed} onClose={()=>setSettingsOpen(false)}/>}
 </div>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>)
