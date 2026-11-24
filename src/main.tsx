import {MAX_MATERIAL_BYTES,MATERIAL_SIZE_LABEL} from '../shared/file-limits.mjs';
import {resolveDropZone,type DropZone} from '../shared/drop-zone.mjs'
import {boundPdfSelection} from '../shared/pdf-selection.mjs'
import {boundPdfRegion} from '../shared/pdf-markup.mjs'
import React,{lazy,memo,Suspense,useCallback,useEffect,useMemo,useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Plus,ArrowUp,ArrowDown,Square,PanelLeft,PanelRight,ChevronDown,Paperclip,Settings,X,FileText,FolderOpen,Presentation,MessageSquarePlus,Download} from 'lucide-react'
import {Markdown} from './Markdown'
import {MarkdownReader} from './MarkdownReader'
import {HtmlReader} from './HtmlReader'
import {notifyStudyChanged,studyApi,syncCourseLearning} from './StudyComponents'
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
import {I18nProvider,tCurrent,useI18n} from './i18n'
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
type PdfOutlineUpdate={courseId:string;sourceId:string;revision:number}
const LegacyPdfReader=lazy(()=>import('./PdfReader').then(module=>({default:module.PdfReader})))
const EmbeddedPdfReader=lazy(()=>import('./EmbedPdfReader').then(module=>({default:module.EmbedPdfReader}),()=>({default:LegacyFallbackReader})))
function LegacyFallbackReader(props:PdfReaderProps){
 return <LegacyPdfReader {...props} annotationReadOnly/>
}
const CoursePdfReader=memo(function CoursePdfReader({annotationUpdates,outlineUpdates,onFocusQuestion,...props}:PdfReaderProps&{annotationUpdates?:PdfAnnotationUpdate;outlineUpdates?:PdfOutlineUpdate;onFocusQuestion?:()=>void}){
 const [fallback,setFallback]=useState(false)
 const handleViewerError=useCallback(()=>setFallback(true),[])
 return <Suspense fallback={null}>{fallback?<LegacyFallbackReader {...props} annotationUpdates={annotationUpdates} outlineUpdates={outlineUpdates}/>:<EmbeddedPdfReader {...props} annotationUpdates={annotationUpdates} outlineUpdates={outlineUpdates} onFocusQuestion={onFocusQuestion} onViewerError={handleViewerError}/>}</Suspense>
})
function pdfSelectionPreview(text:string){
 const characters=Array.from(text.replace(/\s+/g,' ').trim())
 return characters.length>12?characters.slice(0,12).join('')+'…':characters.join('')
}
async function api(path:string,body?:unknown){const res=await fetch('/api'+path,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await res.json();if(!res.ok)throw new Error(value.error||tCurrent('app.requestFailed'));return value}
function wrapStudySpec(spec:unknown){const json=JSON.stringify(spec);let fence='```';while(json.includes(fence))fence+='`';return `${fence}study\n${json}\n${fence}`}
function restoreMessages(thread:any):Message[]{
 const restored:Message[]=[]
 for(const turn of thread.turns||[]){const complete=turn.status==='completed',finalIds=new Set((complete?finalAssistantItems<any>(turn.items||[]):(turn.items||[]).filter((item:any)=>item.type==='agentMessage'&&item.phase==='final_answer').slice(-1)).map((item:any)=>item.id));for(const item of turn.items||[]){
  if(item.type==='userMessage'&&!isContinuationMessage(item,thread.turnActions?.[turn.id]))restored.push({id:item.id,role:'user',text:item.content?.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n')||'',attachments:thread.attachments?.[turn.id]||item.attachments||[]})
  if(item.type==='agentMessage'&&finalIds.has(item.id))restored.push({id:item.id,role:'assistant',text:item.text,incomplete:!complete})
  if(turn.status==='completed'&&item.type==='dynamicToolCall'&&item.tool==='study_render')try{const saved=thread.studyRenders?.[item.id],args=typeof item.arguments==='string'?JSON.parse(item.arguments):item.arguments,spec=saved?.spec||args?.spec||args;if(['calculate','analyze','spreadsheet','pdf_annotate','pdf_outline','workspace_write'].includes(args?.spec?.operation))continue;if(spec)restored.push({id:saved?.itemId||('tool-'+item.id),role:'assistant',text:wrapStudySpec(spec)})}catch{}
 }}
 return restored
}
function App(){
 const {t,syncLocaleFromServer,courseDisplayName}=useI18n()
 const [courses,setCourses]=useState<Course[]>([]),[courseId,setCourseId]=useState('general')
 const [status,setStatus]=useState<{connected:boolean;authenticated:boolean}|null>(null),[model,setModel]=useState(''),[catalogModels,setCatalogModels]=useState<CatalogModel[]>([])
 const [preset,setPreset]=useState<ThinkingPreset>(()=>restoreThinkingPreset(localStorage.getItem(PRESET_STORAGE_KEY),localStorage.getItem(LEGACY_EFFORT_STORAGE_KEY)))
 const [presetConfigs,setPresetConfigs]=useState<ThinkingPresetConfigs>(()=>{try{return normalizePresetConfigs(JSON.parse(localStorage.getItem(PRESET_CONFIGS_STORAGE_KEY)||'null'))}catch{return normalizePresetConfigs(null)}})
 const [threadId,setThreadId]=useState<string|null>(null),[messages,setMessages]=useState<Message[]>([]),[loadingCourse,setLoadingCourse]=useState(true)
 const [leftTab,setLeftTab]=useState<ContextTab>('courseware'),[leftOpen,setLeftOpen]=useState(()=>localStorage.getItem('study-studio:left-open')!=='false'),[focusSource,setFocusSource]=useState<{id:string;page?:number}|undefined>()
 const [reading,setReading]=useState<Reading|null>(null),[readerVisible,setReaderVisible]=useState(false),[openingPdf,setOpeningPdf]=useState(false)
 const [pdfAnnotationUpdate,setPdfAnnotationUpdate]=useState<PdfAnnotationUpdate>()
 const [pdfOutlineUpdate,setPdfOutlineUpdate]=useState<PdfOutlineUpdate>()
 const [pdfSelection,setPdfSelection]=useState<PdfSelection|null>(null)
 const [textSelectionReset,setTextSelectionReset]=useState(0)
 const pdfSelectionRef=useRef<PdfSelection|null>(null)
 const [leftWidth,setLeftWidth]=useState(()=>Number(localStorage.getItem('study-studio:left-width'))||280),[pdfWidth,setPdfWidth]=useState(()=>Number(localStorage.getItem('study-studio:pdf-width'))||600),[screenWidth,setScreenWidth]=useState(innerWidth)
 const readingRef=useRef<Reading|null>(null),readerSequence=useRef(0),readerWrites=useRef(new Map<string,Promise<any>>()),resizeRef=useRef<{side:'left'|'right';x:number;width:number;currentWidth:number}|null>(null),resizeRaf=useRef<number|null>(null)
 const leftFrameRef=useRef<HTMLDivElement|null>(null),rightFrameRef=useRef<HTMLDivElement|null>(null),leftPaneRef=useRef<HTMLElement|null>(null),rightPaneRef=useRef<HTMLElement|null>(null)
 const [input,setInput]=useState(''),[busy,setBusy]=useState(false),[turnId,setTurnId]=useState<string|null>(null),[error,setError]=useState(''),[progress,setProgress]=useState('')
 const [adding,setAdding]=useState(false),[courseName,setCourseName]=useState(''),[revision,setRevision]=useState(0)
 const [settingsOpen,setSettingsOpen]=useState(false),[settingsSection,setSettingsSection]=useState<SettingsSection>('materials'),[managedCourses,setManagedCourses]=useState<ManagedCourse[]|null>(null),[settingsLoading,setSettingsLoading]=useState(false),[settingsError,setSettingsError]=useState('')
 const settingsLoad=useRef(0)
 const [skippedCourseware,setSkippedCourseware]=useState<string[]>([])
 const [pendingFiles,setPendingFiles]=useState<Attachment[]>([]),[uploading,setUploading]=useState(false),[draggingFiles,setDraggingFiles]=useState(false),[activeDropZone,setActiveDropZone]=useState<DropZone|null>(null),[previewAttachment,setPreviewAttachment]=useState<Attachment|null>(null)
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
  if(value?.locale)syncLocaleFromServer(value.locale)
  const models:CatalogModel[]=Array.isArray(value.models)?value.models:[]
  setCatalogModels(models)
  const nextPresets=value.presets?normalizePresetConfigs(value.presets):presetConfigs
  if(value.presets){setPresetConfigs(nextPresets);localStorage.setItem(PRESET_CONFIGS_STORAGE_KEY,JSON.stringify(nextPresets))}
  const preferred=nextPresets.default.model
  const picked=models.find(m=>m.model===preferred)||models.find(m=>m.model===MODEL_ID)||models.find(m=>m.isDefault)||models[0]
  setModel(picked?picked.model:'')
  if(value.authenticated&&!picked)throw new Error(tCurrent('app.codexNoModels'))
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
 useEffect(()=>{syncCourseLearning(courseId,revision)},[courseId,revision])
 useEffect(()=>{
  const update=()=>{if(document.visibilityState==='visible')refresh()}
  window.addEventListener('focus',update);document.addEventListener('visibilitychange',update)
  return()=>{window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update)}
 },[])
 async function createManagedCourse(name:string){
  const value=await api('/courses',{name:name.trim()});setCourses(old=>[...old,value.course]);setManagedCourses(old=>old?[...old,value.course]:old);return value.course as Course
 }
 async function archiveManagedCourse(id:string,archived:boolean){
  if(id===activeCourse.current&&(busyRef.current||uploading))throw Error(tCurrent('app.waitForBusy'))
  if(id===activeCourse.current)await readerWrites.current.get(id)
  const response=await fetch('/api/courses/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({archived})}),value=await response.json()
  if(!response.ok)throw Error(value.error||tCurrent('course.updateFailed'))
  ++settingsLoad.current;setSettingsLoading(false);setSettingsError('')
  const updated=value.course as ManagedCourse
  setManagedCourses(old=>(old||courses).map(item=>item.id===id?updated:item))
  setCourses(old=>archived?old.filter(item=>item.id!==id):old.some(item=>item.id===id)?old.map(item=>item.id===id?updated:item):[...old,updated])
  if(archived&&activeCourse.current===id)await activateCourse('general')
 }
 async function openManagedCourse(id:string){
  if(activeCourse.current===id){setSettingsOpen(false);return}
  if(busyRef.current||uploading)throw Error(tCurrent('app.waitForBusy'))
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
 useEffect(()=>{const resize=()=>setScreenWidth(innerWidth),escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){if(previewAttachment){setPreviewAttachment(null);return}if(!document.querySelector('[aria-modal="true"]')){if(innerWidth<900)setReaderVisible(false);if(innerWidth<1000)setLeftOpen(false);setAdding(false)}}};window.addEventListener('resize',resize);window.addEventListener('keydown',escape);return()=>{window.removeEventListener('resize',resize);window.removeEventListener('keydown',escape)}},[previewAttachment])
 useEffect(()=>{
  if(!draggingFiles)return
  const clear=()=>{setDraggingFiles(false);setActiveDropZone(null)}
  window.addEventListener('dragend',clear);window.addEventListener('drop',clear);window.addEventListener('blur',clear)
  return()=>{window.removeEventListener('dragend',clear);window.removeEventListener('drop',clear);window.removeEventListener('blur',clear)}
 },[draggingFiles])
 useEffect(()=>{localStorage.setItem('study-studio:left-open',String(leftOpen))},[leftOpen])
 useEffect(()=>{localStorage.setItem(PRESET_STORAGE_KEY,preset);localStorage.removeItem(LEGACY_EFFORT_STORAGE_KEY)},[preset])
 useEffect(()=>{if(catalogModels.length&&!turnModelAvailable)setError(tCurrent('composer.presetUnavailable',{preset:presetLabel,model:turnModel,effort:effort?' ('+effort+')':''}))},[preset,presetLabel,turnModel,effort,catalogModels,turnModelAvailable,loadingCourse])
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
    if(spec)turnOutputs.current.set(itemId,{id:itemId,type:'studyRender',text:wrapStudySpec(spec)})
    refresh()
   }else if(method==='pdf/annotations-updated'&&p.courseId===activeCourse.current&&typeof p.sourceId==='string'&&Number.isSafeInteger(p.page)){
    setPdfAnnotationUpdate(previous=>({courseId:p.courseId,sourceId:p.sourceId,page:p.page,revision:(previous?.revision||0)+1}))
   }else if(method==='pdf/outline-updated'&&p.courseId===activeCourse.current&&typeof p.sourceId==='string'){
    setPdfOutlineUpdate(previous=>({courseId:p.courseId,sourceId:p.sourceId,revision:(previous?.revision||0)+1}))
   }else if(['study/updated','workspace/updated','memory/updated','sources/updated'].includes(method))refresh()
   else if(method==='study/error')setError(p.message||p.error?.message||tCurrent('app.learningSaveFailed'))
   else if(method==='turn/started'){if(finalStream.current.finished||finalStream.current.turnId&&finalStream.current.turnId!==p.turn?.id)resetFinalOutput();finalStream.current.turnId=p.turn?.id||null;setTurnId(p.turn?.id||null)}
   else if(method==='item/started'&&p.item?.type==='contextCompaction')setProgress(tCurrent('progress.compacting'))
   else if(method==='item/completed'&&p.item?.type==='contextCompaction'){if(busyRef.current)setProgress(tCurrent('progress.continueThinking'))}
   else if(method==='item/started'&&p.item?.type==='dynamicToolCall')setProgress(p.item.tool==='study_current_slide'?tCurrent('progress.viewingSlide'):p.item.tool==='study_pdf_annotate'?tCurrent('progress.annotatingPdf'):p.item.tool==='study_pdf_outline'?tCurrent('progress.updatingOutline'):p.item.tool==='study_workspace_write'?tCurrent('progress.writingFile'):p.item.tool==='study_workspace_list'?tCurrent('progress.browsingFiles'):p.item.tool?.includes('read')?tCurrent('progress.readingFiles'):p.item.tool?.includes('render')?tCurrent('progress.preparingPractice'):p.item.tool?.includes('memory')?tCurrent('progress.updatingMemory'):tCurrent('progress.updatingRecords'))
   else if(method==='turn/completed'){
    finishFinalOutput(p.turn?.status==='completed',p.turn?.items||[])
    if(p.turn?.status==='completed'){
     const visible:Message[]=[...turnOutputs.current.values()].filter(item=>item.type==='studyRender').map(item=>({id:item.id,role:'assistant',text:item.text}))
     setMessages(old=>[...old,...visible.filter(item=>!old.some(existing=>existing.id===item.id))])
    }
    turnOutputs.current.clear();setBusy(false);busyRef.current=false;setProgress('');setTurnId(null);refresh();if(p.turn?.status==='failed')setError(p.turn?.error?.message||tCurrent('app.replyFailed'))
   }
   else if(method==='error'){setError(p.error?.message||p.message||tCurrent('app.conversationError'));if(!p.willRetry){finishFinalOutput();setBusy(false);busyRef.current=false;setProgress('');setTurnId(null)}}
   else if(method==='connection/error'){setError(p.message||tCurrent('app.connectionClosed'));finishFinalOutput();setBusy(false);busyRef.current=false;setProgress('');setTurnId(null)}
  }
  stream.onerror=()=>{if(busyRef.current)setProgress(tCurrent('app.reconnecting'))}
  return new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(tCurrent('app.connectionTimeout'))),12000);stream.onopen=()=>{clearTimeout(timer);resolve()};stream.addEventListener('error',()=>{if(stream.readyState===EventSource.CLOSED){clearTimeout(timer);reject(new Error(tCurrent('app.connectionClosedRetry')))}},{once:true})})
 }
 async function activateCourse(id:string){
  if(busyRef.current||uploading)return
  resetScroll()
  const seq=++activation.current;events.current?.close();events.current=null;activeThread.current=null;resetFinalOutput()
  if(activeCourse.current!==id){setFocusSource(undefined)}
  clearPdfSelection()
  const readerSeq=++readerSequence.current;readingRef.current=null;setReading(null);setReaderVisible(false);setOpeningPdf(false)
  turnOutputs.current.clear();activeCourse.current=id;setCourseId(id);localStorage.setItem('study-studio:active-course',id);setThreadId(null);setMessages([]);setPendingFiles([]);setPreviewAttachment(null);setSkippedCourseware([]);setError('');setProgress('');setInput('');setLoadingCourse(true)
  try{
   const value=await api('/courses/'+encodeURIComponent(id)+'/conversation',model?{model}:{})
   if(seq!==activation.current)return
   const [threadResult,readerResult]=await Promise.allSettled([api('/threads/'+encodeURIComponent(value.threadId)),(async()=>{await readerWrites.current.get(id)?.catch(()=>{});return api('/courses/'+encodeURIComponent(id)+'/reader')})()])
   if(seq!==activation.current)return
   if(threadResult.status==='rejected')throw threadResult.reason
   setThreadId(value.threadId);setMessages(restoreMessages(threadResult.value.thread))
   if(readerSeq===readerSequence.current){
    if(readerResult.status==='fulfilled'&&readerResult.value.reader){const r=readerResult.value.reader;if(r.source){const next:Reading={kind:'pdf',source:r.source,page:r.page,pages:r.pages};readingRef.current=next;setReading(next);setReaderVisible(true);if(innerWidth<1100)setLeftOpen(false)}}
    else if(readerResult.status==='rejected')setError(tCurrent('course.lastPdfUnavailable'))
   }
   await connect(value.threadId);refresh()
  }catch(e:any){if(seq===activation.current)setError(e.message)}finally{if(seq===activation.current)setLoadingCourse(false)}
 }
 async function sendText(text:string,attached=pendingFiles,action?:'continue'){
  const continuing=action==='continue'
  if((continuing?!messages.some(message=>message.role==='assistant'&&message.text.trim()):!text.trim()&&!attached.length)||busyRef.current||busy||uploading||loadingCourse||!status?.authenticated||!threadId||!model)return
  if(!turnModelAvailable){setError(tCurrent('composer.modelUnavailable'));return}
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
  busyRef.current=true;setBusy(true);setError('');setProgress(tCurrent('progress.savingAnswers'))
  try{await waitForStudySubmissions(courseId)}catch(e:any){busyRef.current=false;setBusy(false);setProgress('');setError(e.message);return}
  resetScroll()
  turnOutputs.current.clear();resetFinalOutput();setError('');setBusy(true);busyRef.current=true;setProgress(tCurrent('progress.thinking'))
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
  const attach=target==='conversation',courseware=target==='courseware',list=files?Array.from(files):[]
  if(!list.length||uploading)return
  if(attach&&(busy||loadingCourse)){setError(tCurrent('app.waitForBusy'));return}
  let toUpload=list
  if(attach){
   const remaining=Math.max(0,10-pendingFiles.length)
   if(remaining===0){setError(tCurrent('composer.attachLimit'));return}
   if(list.length>remaining){setError(tCurrent('composer.attachLimit'));toUpload=list.slice(0,remaining)}
  }
  setUploading(true)
  if(!attach||list.length<=Math.max(0,10-pendingFiles.length))setError('')
  if(courseware)setSkippedCourseware([])
  const base='/api/courses/'+encodeURIComponent(courseId),added:string[]=[],skipped:string[]=[]
  try{
   for(const file of toUpload){
    try{
     if(courseware&&(!/\.pdf$/i.test(file.name)||!/^%PDF-[0-9]\.[0-9][\t\n\f\r ]/.test(await file.slice(0,9).text()))){
      skipped.push(file.name);continue
     }
     if(file.size>MAX_MATERIAL_BYTES)throw new Error(tCurrent('composer.fileTooLarge',{name:file.name,limit:MATERIAL_SIZE_LABEL}))
     const folder=['待整理',file.webkitRelativePath?.split('/').slice(0,-1).join('/')].filter(Boolean).join('/')
     const headers:Record<string,string>={
      'Content-Type':file.type||'application/octet-stream','x-file-name':encodeURIComponent(file.name),
     }
     if(attach)headers['x-upload-intent']='chat'
     else if(courseware)headers['x-upload-intent']='courseware'
     else headers['x-folder']=encodeURIComponent(folder)
     const response=await fetch(base+'/attachments',{method:'POST',headers,body:file})
     const value=await response.json()
     if(!response.ok)throw new Error(value.error||tCurrent('composer.uploadFailed'))
     added.push(value.attachment.id)
     if(attach){
      setPendingFiles(old=>[...old,value.attachment])
     }else{
      setLeftTab(courseware?'courseware':'sources');setLeftOpen(true);refresh()
     }
    }catch(error:any){setError(error.message)}
   }
   if(added.length&&attach){
    composerInput.current?.focus({preventScroll:true})
   }
   if(added.length&&!courseware&&!attach){
    try{for(let offset=0;offset<added.length;offset+=100)await api('/courses/'+encodeURIComponent(courseId)+'/imports',{attachmentIds:added.slice(offset,offset+100)});refresh()}
    catch(error:any){setError(tCurrent('composer.autoOrgNotStarted',{reason:error.message}))}
   }
  }finally{
   if(skipped.length&&activeCourse.current===courseId){setSkippedCourseware(skipped);setLeftTab('courseware');setLeftOpen(true)}
   setUploading(false);if(fileInput.current)fileInput.current.value=''
  }
 }
 function removePendingFile(file:Attachment){
  setPendingFiles(old=>old.filter(item=>item.id!==file.id))
  if(file.scope==='chat'){
   void fetch('/api/courses/'+encodeURIComponent(courseId)+'/attachments/'+encodeURIComponent(file.id),{method:'DELETE'}).catch(()=>{})
  }
 }
 function handleComposerPaste(event:React.ClipboardEvent<HTMLTextAreaElement>){
  const files=event.clipboardData?.files
  const plainText=event.clipboardData?.getData('text/plain')
  if(!files?.length||plainText)return
  event.preventDefault()
  void upload(files,'conversation')
 }
 function chooseFiles(target:UploadTarget='conversation'){uploadTarget.current=target;fileInput.current?.click()}
 const askAgent=useEventCallback((text:string)=>{if(innerWidth<1000)setLeftOpen(false);if(innerWidth<900)setReaderVisible(false);void sendText(text,[])})
 function persistReader(course:string,value:{sourceId:string|null;page?:number}){const previous=readerWrites.current.get(course)||Promise.resolve();const pending=previous.catch(()=>{}).then(()=>api('/courses/'+encodeURIComponent(course)+'/reader',value));readerWrites.current.set(course,pending);const clear=()=>{if(readerWrites.current.get(course)===pending)readerWrites.current.delete(course)};void pending.then(clear,clear);return pending}
 async function openCourseware(source:Source,page?:number){
  if(!isPdfSource(source)){setError(tCurrent('composer.convertCoursewareToPdf'));return}
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
  setInput(prev=>prev.trim()?prev:tCurrent('composer.askDocumentPrefix',{name:source.name}))
  if(innerWidth<900)setReaderVisible(false)
  composerInput.current?.focus({preventScroll:true})
 }
 function askAboutCanvas(canvas:CanvasSpec){
  setInput(prev=>prev.trim()?prev:tCurrent('composer.askCanvasPrefix',{title:canvas.title}))
  if(innerWidth<900)setReaderVisible(false)
  composerInput.current?.focus({preventScroll:true})
 }
 function changePage(page:number){
  const current=readingRef.current;if(!current||current.kind!=='pdf')return
  if(current.page!==page)clearPdfSelection()
  const next:Reading={...current,page};readingRef.current=next;setReading(next)
  const seq=++readerSequence.current,course=courseId
  void persistReader(course,{sourceId:current.source.id,page}).catch(e=>{if(seq===readerSequence.current&&activeCourse.current===course)setError(tCurrent('composer.pageSyncFailed',{reason:e.message}))})
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
   if(!source)throw Error(tCurrent('composer.sourceUnavailable'))
   if(isPdfSource(source))await openCourseware(source,page)
   else if(isMarkdownSource(source)||isHtmlSource(source))openDocument(source)
   else{setFocusSource({id,page});setLeftTab('sources');setLeftOpen(true);if(innerWidth<1000)setReaderVisible(false)}
  }catch(e:any){if(seq===activation.current&&activeCourse.current===course)setError(e.message)}
 }
 const onMessageSource=useEventCallback(openSource)
 const renderMarkdown=useCallback((text:string)=><Markdown text={text} allowStudy={false} onOpenSource={onMessageSource}/>,[onMessageSource])
 function attachmentDownloadUrl(course:string,a:Attachment){return (a.url||'/api/courses/'+encodeURIComponent(course)+'/attachments/'+encodeURIComponent(a.id))}
 function triggerAttachmentDownload(course:string,a:Attachment){
  const link=document.createElement('a')
  link.href=attachmentDownloadUrl(course,a)+'?download=1'
  link.download=a.name
  document.body.appendChild(link)
  link.click()
  link.remove()
 }
 async function openAttachment(a:Attachment){
  const course=courseId,seq=activation.current
  if(a.scope==='chat'){
   if(a.mime?.startsWith('image/')){setPreviewAttachment(a);return}
   triggerAttachmentDownload(course,a);return
  }
  try{
   const value=await api('/courses/'+encodeURIComponent(course)+'/sources')
   if(seq!==activation.current||activeCourse.current!==course)return
   const source=value.sources.find((s:Source)=>s.attachmentId===a.id)
   if(source){void openSource(source.id);return}
   if(a.mime?.startsWith('image/')){setPreviewAttachment(a);return}
   triggerAttachmentDownload(course,a)
  }catch(e:any){if(seq===activation.current&&activeCourse.current===course)setError(e.message)}
 }
 const onMessageAttachment=useEventCallback(openAttachment)
 const onSidebarUpload=useEventCallback((target:'sources'|'courseware')=>chooseFiles(target))
 const onManageMaterials=useEventCallback(()=>showSettings('materials'))
 const onManagePractice=useEventCallback(()=>showSettings('practice'))
 const onSidebarOpenCourseware=useEventCallback((source:Source,page?:number)=>{void openCourseware(source,page)})
 const onSidebarOpenDocument=useEventCallback(openDocument)
 const onSidebarDraftMessage=useEventCallback((text:string)=>{setInput(text);if(innerWidth<1000)setLeftOpen(false);if(innerWidth<900)setReaderVisible(false);composerInput.current?.focus()})
 const onPdfPageChange=useEventCallback(changePage)
 const onCloseReader=useEventCallback(closeReader)
 const onAskPdfSelection=useEventCallback(askAboutPdfSelection)
 const pdfReaderSource=useMemo(()=>reading?.kind==='pdf'?{id:reading.source.id,name:reading.source.name,url:reading.source.url||'/api/courses/'+encodeURIComponent(courseId)+'/sources/'+encodeURIComponent(reading.source.id)+'/file'}:null,[courseId,reading?.kind==='pdf'?reading.source.id:null,reading?.kind==='pdf'?reading.source.name:null,reading?.kind==='pdf'?reading.source.url:null])
 const actualLeftWidth=Math.max(220,Math.min(420,leftWidth))
 const actualPdfWidth=Math.max(360,Math.min(pdfWidth,Math.max(360,screenWidth-(leftOpen&&screenWidth>1100?actualLeftWidth:0)-340)))
 function applyLiveResize(side:'left'|'right',nextWidth:number){
  const frame=side==='left'?leftFrameRef.current:rightFrameRef.current
  const pane=side==='left'?leftPaneRef.current:rightPaneRef.current
  if(frame)frame.style.setProperty('--panel-width',(nextWidth+5)+'px')
  if(pane)pane.style.width=nextWidth+'px'
 }
 function resizeStart(event:React.PointerEvent<HTMLDivElement>,side:'left'|'right'){
  event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId)
  const startWidth=side==='left'?actualLeftWidth:actualPdfWidth
  resizeRef.current={side,x:event.clientX,width:startWidth,currentWidth:startWidth}
  document.documentElement.classList.add('studio-resizing')
 }
 function resizeMove(event:React.PointerEvent<HTMLDivElement>){
  const drag=resizeRef.current;if(!drag)return
  const delta=event.clientX-drag.x
  const nextWidth=drag.side==='left'
   ?Math.max(220,Math.min(420,drag.width+delta))
   :Math.max(360,Math.min(Math.max(360,screenWidth-(leftOpen?actualLeftWidth:0)-340),drag.width-delta))
  if(nextWidth===drag.currentWidth)return
  drag.currentWidth=nextWidth
  if(resizeRaf.current!==null)return
  resizeRaf.current=requestAnimationFrame(()=>{
   resizeRaf.current=null
   const active=resizeRef.current
   if(active)applyLiveResize(active.side,active.currentWidth)
  })
 }
 function resizeEnd(event:React.PointerEvent<HTMLDivElement>){
  if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)
  if(resizeRaf.current!==null){cancelAnimationFrame(resizeRaf.current);resizeRaf.current=null}
  const finished=resizeRef.current
  resizeRef.current=null
  document.documentElement.classList.remove('studio-resizing')
  if(finished){
   applyLiveResize(finished.side,finished.currentWidth)
   if(finished.side==='left'){setLeftWidth(finished.currentWidth);localStorage.setItem('study-studio:left-width',String(finished.currentWidth))}
   else{setPdfWidth(finished.currentWidth);localStorage.setItem('study-studio:pdf-width',String(finished.currentWidth))}
  }
 }
 function resizeKey(event:React.KeyboardEvent<HTMLDivElement>,side:'left'|'right'){if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const change=event.key==='ArrowRight'?20:-20;if(side==='left')setLeftWidth(value=>{const next=Math.max(220,Math.min(420,value+change));localStorage.setItem('study-studio:left-width',String(next));return next});else setPdfWidth(value=>{const next=Math.max(360,Math.min(Math.max(360,screenWidth-(leftOpen?actualLeftWidth:0)-340),value-change));localStorage.setItem('study-studio:pdf-width',String(next));return next})}

 const currentReadingSourceId=reading&&reading.kind!=='canvas'?reading.source.id:undefined
 const readerToggleLabel=reading?.kind==='pdf'?t('topbar.readerKind.pdf'):reading?.kind==='markdown'?t('topbar.readerKind.markdown'):reading?.kind==='html'?t('topbar.readerKind.html'):t('topbar.readerKind.canvas')
 const composerPlaceholder=reading?.kind==='pdf'
  ?t('composer.placeholder.pdf')
  :reading?.kind==='markdown'
   ?t('composer.placeholder.markdown')
   :reading?.kind==='html'||reading?.kind==='canvas'
    ?t('composer.placeholder.interactive')
    :t('composer.placeholder.default')
 const currentCourseName=courseDisplayName(course)
 const sidebarPrimaryZone:DropZone=leftTab==='courseware'?'courseware':'sources'
 const sidebarSecondaryZone:DropZone=sidebarPrimaryZone==='courseware'?'sources':'courseware'
 const clearDragState=()=>{setDraggingFiles(false);setActiveDropZone(null)}

 return <div className={'studio-shell'+(draggingFiles?' is-dragging-files':'')} onDragOverCapture={e=>{if((e.target as HTMLElement).closest?.('[data-study-answer-input],.settings-backdrop'))clearDragState()}} onDropCapture={e=>{if((e.target as HTMLElement).closest?.('[data-study-answer-input],.settings-backdrop'))clearDragState()}} onDragOver={e=>{if(settingsOpen||(e.target as HTMLElement).closest?.('.settings-backdrop,[data-study-answer-input]'))return;if(Array.from(e.dataTransfer.types||[]).includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';if(!draggingFiles)setDraggingFiles(true);const nextZone=resolveDropZone(e.target,{leftOpen,leftTab});setActiveDropZone(prev=>prev===nextZone?prev:nextZone)}}} onDragLeave={e=>{if(!e.relatedTarget||!e.currentTarget.contains(e.relatedTarget as Node))clearDragState()}} onDrop={e=>{if(settingsOpen||(e.target as HTMLElement).closest?.('.settings-backdrop,[data-study-answer-input]'))return;e.preventDefault();const zone=resolveDropZone(e.target,{leftOpen,leftTab});clearDragState();void upload(e.dataTransfer.files,zone)}}>
  <input ref={fileInput} type="file" multiple className="sr-only" aria-label={t('topbar.uploadFilesAria')} onChange={e=>upload(e.target.files)}/>
  <header className="studio-topbar"><div className="studio-header-left"><button className="icon-button" aria-label={leftOpen?t('topbar.collapseSidebar'):t('topbar.expandSidebar')} aria-expanded={leftOpen} onClick={()=>{setLeftOpen(!leftOpen);if(!leftOpen&&innerWidth<1000)setReaderVisible(false)}}><PanelLeft size={19}/></button><a className="studio-brand" href="/" onClick={e=>e.preventDefault()}><span>Study Studio</span></a><span className="studio-header-divider"/><label className="studio-course-picker"><span className="sr-only">{t('topbar.course')}</span>{!loadingCourse&&<CourseAvatar courseId={courseId} size={24}/>}<select aria-label={t('topbar.course')} value={courseId} onChange={e=>void activateCourse(e.target.value)} disabled={busy||uploading}>{courses.map(c=><option key={c.id} value={c.id}>{courseDisplayName(c)}</option>)}</select><ChevronDown size={13}/></label><button className="icon-button" aria-label={t('topbar.addCourse')} onClick={()=>setAdding(v=>!v)} disabled={busy||uploading||loadingCourse}><Plus size={16}/></button></div><div className="studio-header-right">{openingPdf&&<span className="studio-opening"><span className="spinner"/>{t('topbar.openingCourseware')}</span>}{reading&&!readerVisible&&<button className="reader-toggle" aria-label={readerVisible?t('topbar.collapseReader'):t('topbar.expandReader')} onClick={()=>{setReaderVisible(!readerVisible);if(innerWidth<1000)setLeftOpen(false)}}><PanelRight size={17}/><span>{readerToggleLabel}</span></button>}<button type="button" className="icon-button studio-settings-button" aria-label={t('topbar.settings')} title={t('topbar.settingsTitle')} onClick={()=>showSettings()}><Settings size={17}/></button><span className={'connection-dot '+(status?.authenticated?'online':'')} title={status?.authenticated?t('app.codexConnected'):t('app.codexConnecting')}/></div></header>
  {adding&&<form className="studio-course-add" onSubmit={addCourse}><input autoFocus aria-label={t('topbar.newCourseName')} placeholder={t('topbar.courseNamePlaceholder')} value={courseName} onChange={e=>setCourseName(e.target.value)} maxLength={80}/><button type="submit">{t('app.add')}</button><button type="button" aria-label={t('topbar.cancelAddCourse')} onClick={()=>setAdding(false)}><X size={15}/></button></form>}
  <main className="studio-body">
   {leftOpen&&<button className="studio-left-scrim" aria-label={t('topbar.closeSidebarScrim')} onClick={()=>setLeftOpen(false)}/>}<AnimatedSidebar open={leftOpen} width={actualLeftWidth+5} side="left" keepMounted frameRef={leftFrameRef}><aside ref={leftPaneRef} className="studio-left" style={{width:actualLeftWidth}} data-drop-zone={leftOpen?sidebarPrimaryZone:undefined}><CourseContextPanel key={courseId} courseId={courseId} revision={revision} tab={leftTab} onTabChange={setLeftTab} onUpload={onSidebarUpload} onManageMaterials={onManageMaterials} onManagePractice={onManagePractice} uploadInProgress={uploading} skippedCourseware={skippedCourseware} onOpenCourseware={onSidebarOpenCourseware} onOpenDocument={onSidebarOpenDocument} onOpenCanvas={onOpenCanvas} currentSourceId={currentReadingSourceId} onAskAgent={askAgent} onDraftMessage={onSidebarDraftMessage} onChanged={refresh} renderMarkdown={renderMarkdown} focusSourceId={focusSource?.id} focusSourcePage={focusSource?.page}/>{draggingFiles&&leftOpen&&<div className={'zone-drop-overlay is-sidebar'+(activeDropZone===sidebarPrimaryZone?' is-active':'')} aria-hidden="true"><div className="zone-drop-card">{sidebarPrimaryZone==='courseware'?<Presentation size={24}/>:<FolderOpen size={24}/>}<strong>{sidebarPrimaryZone==='courseware'?t('drop.coursewareTitle',{course:currentCourseName}):t('drop.sourcesTitle',{course:currentCourseName})}</strong><span>{sidebarPrimaryZone==='courseware'?t('drop.coursewareDesc'):t('drop.sourcesDesc')}</span></div><div className={'drop-zone-pill'+(activeDropZone===sidebarSecondaryZone?' is-active':'')} data-drop-zone={sidebarSecondaryZone}>{sidebarSecondaryZone==='courseware'?<Presentation size={15}/>:<FolderOpen size={15}/>}<span>{sidebarSecondaryZone==='courseware'?t('drop.switchToCourseware'):t('drop.switchToSources')}</span></div></div>}</aside><div className="studio-resizer left" role="separator" aria-label={t('topbar.resizeLeft')} aria-orientation="vertical" aria-valuemin={220} aria-valuemax={420} aria-valuenow={actualLeftWidth} tabIndex={0} onPointerDown={e=>resizeStart(e,'left')} onPointerMove={resizeMove} onPointerUp={resizeEnd} onPointerCancel={resizeEnd} onKeyDown={e=>resizeKey(e,'left')} onDoubleClick={()=>setLeftWidth(280)}/></AnimatedSidebar>
   <section ref={conversationFrame} className={'conversation'+(!loadingCourse&&!messages.length?' is-empty':'')} data-drop-zone="conversation">
    <h1 className="sr-only">{currentCourseName}</h1>
    <section ref={conversationScroller} className="reading-pane" aria-label={t('course.conversationAria')}><div className="reading-column messages">
     {loadingCourse?<div className="course-loading"><span className="spinner"/>{t('course.opening')}</div>:!messages.length?<div className="welcome"><div className="welcome-title"><CourseAvatar courseId={courseId} size={48}/><h2>{t('course.welcome')}</h2></div></div>:<ConversationMessages messages={messages} courseId={courseId} threadId={threadId} onLearningChange={refresh} onAskAgent={askAgent} onOpenSource={onMessageSource} onOpenAttachment={onMessageAttachment} onOpenCanvas={onOpenCanvas} renderMarkdown={renderMarkdown}/>}
     {busy&&!hasFinalOutput&&<ThinkingIndicator courseId={courseId} preset={preset}/>}<div className="message-end"/>
    </div></section>
    {draggingFiles&&<div className={'zone-drop-overlay is-chat'+(activeDropZone==='conversation'?' is-active':'')} aria-hidden="true">
     {!leftOpen&&<div className="drop-zone-dock">
      <div className={'drop-zone-dock-item'+(activeDropZone==='sources'?' is-active':'')} data-drop-zone="sources"><FolderOpen size={18}/><div><strong>{t('drop.dockSources')}</strong><span>{t('drop.dockSourcesHint')}</span></div></div>
      <div className={'drop-zone-dock-item'+(activeDropZone==='courseware'?' is-active':'')} data-drop-zone="courseware"><Presentation size={18}/><div><strong>{t('drop.dockCourseware')}</strong><span>{t('drop.dockCoursewareHint')}</span></div></div>
     </div>}
     <div className="zone-drop-card"><MessageSquarePlus size={26}/><strong>{t('drop.chatTitle')}</strong><span>{t('drop.chatDesc')}</span></div>
    </div>}
    <div className="composer-area" ref={composerOverlay}><div className="composer-column">{showScrollToBottom&&<button type="button" className="conversation-bottom-button" aria-label={t('composer.scrollBottom')} title={t('composer.scrollBottom')} onPointerDown={event=>event.preventDefault()} onClick={scrollToBottom}><ArrowDown size={17}/></button>}{error&&<div className="app-error" role="alert"><span>{error}</span>{!threadId&&<button onClick={()=>void activateCourse(courseId)}>{t('app.retry')}</button>}<button aria-label={t('app.closeError')} onClick={()=>setError('')}>×</button></div>}
     {!!pendingFiles.length&&<div className="pending-attachments">{pendingFiles.map(a=><span key={a.id}><FileText size={13}/>{a.name}<button type="button" aria-label={t('composer.removeAttachment',{name:a.name})} onClick={()=>removePendingFile(a)}><X size={12}/></button></span>)}</div>}
     {pdfSelection&&<div className="pending-attachments">
      <span className="pdf-selection-chip">
       <FileText size={13}/>
       <span className="pdf-selection-page">{'text' in pdfSelection?t('composer.pdfTextQuote',{page:pdfSelection.page}):t('composer.pdfRegionQuote',{page:pdfSelection.page})}</span>
       {'text' in pdfSelection&&<span className="pdf-selection-excerpt" title={pdfSelection.text.slice(0,320)}>{pdfSelectionPreview(pdfSelection.text)}</span>}
       <button type="button" aria-label={'text' in pdfSelection?t('composer.removePdfText'):t('composer.removePdfRegion')} onClick={clearPdfSelection}><X size={12}/></button>
      </span>
     </div>}
     <form className={'composer'+(draggingFiles&&activeDropZone==='conversation'?' is-drop-target':'')} onSubmit={send}>
      <textarea
       ref={composerInput}
       aria-label={t('composer.aria')}
       placeholder={composerPlaceholder}
       value={input}
       rows={1}
       onChange={event=>setInput(event.target.value)}
       onPaste={handleComposerPaste}
       onCompositionStart={()=>{composerComposition.current.active=true}}
       onCompositionEnd={()=>{composerComposition.current={active:false,endedAt:performance.now()}}}
       onBlur={()=>{composerComposition.current.active=false}}
       onKeyDown={handleComposerKeyDown}
      />
      <div className="composer-footer"><div className="composer-options"><button type="button" className="attach-button icon-button" aria-label={t('composer.attach')} title={t('composer.attach')} onClick={()=>chooseFiles('conversation')} disabled={busy||uploading||loadingCourse}><Paperclip size={18}/></button><EffortToggle value={preset} configs={presetConfigs} onChange={value=>{setPreset(value);setError('')}} disabled={busy||loadingCourse||!model}/>{uploading&&<span className="uploading-label">{t('app.adding')}</span>}</div><button type="button" className="continue-button" onClick={()=>void sendText('',[],'continue')} disabled={busy||!messages.some(message=>message.role==='assistant'&&message.text.trim())||!status?.authenticated||uploading||loadingCourse||!threadId||!model||!turnModelAvailable}>{t('composer.continue')}</button>{busy?<button type="button" className="send-button stop" aria-label={t('composer.stop')} onClick={stop} disabled={!turnId}><Square size={16}/></button>:<button className="send-button" type="submit" aria-label={t('composer.send')} disabled={(!input.trim()&&!pendingFiles.length)||!status?.authenticated||uploading||loadingCourse||!threadId||!model||!turnModelAvailable}><ArrowUp size={19}/></button>}</div></form>
    </div></div>
   </section>
   <AnimatedSidebar open={Boolean(reading&&readerVisible)} width={actualPdfWidth+5} side="right" keepMounted={Boolean(reading)} frameRef={rightFrameRef}>{reading&&<><div className="studio-resizer right" role="separator" aria-label={t('topbar.resizeRight')} aria-orientation="vertical" aria-valuemin={360} aria-valuemax={Math.max(360,screenWidth-340)} aria-valuenow={actualPdfWidth} tabIndex={0} onPointerDown={e=>resizeStart(e,'right')} onPointerMove={resizeMove} onPointerUp={resizeEnd} onPointerCancel={resizeEnd} onKeyDown={e=>resizeKey(e,'right')} onDoubleClick={()=>setPdfWidth(600)}/><aside ref={rightPaneRef} className="studio-pdf" style={{width:actualPdfWidth}} data-drop-zone="conversation">
    {reading.kind==='pdf'?(pdfReaderSource&&<CoursePdfReader key={courseId+':'+reading.source.id} annotationUpdates={pdfAnnotationUpdate?.courseId===courseId&&pdfAnnotationUpdate.sourceId===reading.source.id?pdfAnnotationUpdate:undefined} outlineUpdates={pdfOutlineUpdate?.courseId===courseId&&pdfOutlineUpdate.sourceId===reading.source.id?pdfOutlineUpdate:undefined} keyboardEnabled={readerVisible} courseId={courseId} source={pdfReaderSource} page={reading.page} onPageChange={onPdfPageChange} onClose={onCloseReader} onTextSelectionChange={capturePdfSelection} textSelectionReset={textSelectionReset} regionSelection={pdfSelection&&'region' in pdfSelection?pdfSelection:null} onRegionSelectionChange={capturePdfRegion} onFocusQuestion={onAskPdfSelection} onAskSelection={screenWidth<900&&pdfSelection?onAskPdfSelection:undefined}/>)
    :reading.kind==='markdown'?<MarkdownReader key={courseId+':md:'+reading.source.id} courseId={courseId} source={reading.source} revision={revision} onClose={onCloseReader} onOpenSource={onMessageSource} onAskAboutDocument={askAboutDocument}/>
    :reading.kind==='html'?<HtmlReader key={courseId+':html:'+reading.source.id} kind="file" courseId={courseId} source={reading.source} revision={revision} visible={readerVisible} onClose={onCloseReader} onAskAboutDocument={askAboutDocument}/>
    :<HtmlReader key={courseId+':canvas:'+reading.canvas.id+':'+(reading.itemId||'')} kind="canvas" canvas={reading.canvas} saved={Boolean(reading.savedCanvas)} onSave={reading.threadId&&reading.itemId?saveActiveCanvas:undefined} onReport={reading.savedCanvas?reportActiveCanvas:undefined} visible={readerVisible} onClose={onCloseReader} onAskAboutCanvas={askAboutCanvas}/>}
    {draggingFiles&&<div className={'zone-drop-overlay is-reader'+(activeDropZone==='conversation'?' is-active':'')} aria-hidden="true"><div className="zone-drop-card"><MessageSquarePlus size={24}/><strong>{t('drop.chatTitle')}</strong><span>{t('drop.chatDesc')}</span></div></div>}
   </aside></>}</AnimatedSidebar>
  </main>
  {previewAttachment&&<div className="attachment-lightbox" role="dialog" aria-modal="true" aria-label={t('composer.previewAttachmentAria',{name:previewAttachment.name})} onClick={e=>{if(e.target===e.currentTarget)setPreviewAttachment(null)}}>
   <div className="attachment-lightbox-card">
    <div className="attachment-lightbox-head">
     <strong title={previewAttachment.name}>{previewAttachment.name}</strong>
     <div className="attachment-lightbox-actions">
      <a href={attachmentDownloadUrl(courseId,previewAttachment)+'?download=1'} download={previewAttachment.name} aria-label={t('composer.downloadAttachment')} title={t('composer.downloadAttachment')}><Download size={16}/></a>
      <button type="button" aria-label={t('app.close')} onClick={()=>setPreviewAttachment(null)}><X size={17}/></button>
     </div>
    </div>
    <div className="attachment-lightbox-body"><img src={attachmentDownloadUrl(courseId,previewAttachment)} alt={previewAttachment.name}/></div>
   </div>
  </div>}
  {settingsOpen&&<SettingsPage revision={revision} initialSection={settingsSection} courses={managedCourses||courses} activeCourseId={courseId} currentSourceId={currentReadingSourceId} conversationBusy={busy||uploading} loading={settingsLoading} loadError={settingsError} preset={preset} onPresetChange={value=>{setPreset(value);setError('')}} presetConfigs={presetConfigs} onSavePresetConfigs={savePresetConfigs} onResetPresetConfigs={resetPresetConfigs} catalogModels={catalogModels} onRefreshModels={refreshModels} status={status} leftOpen={leftOpen} onToggleLeftOpen={()=>setLeftOpen(v=>!v)} onResetLayout={resetLayoutWidths} onCreate={async name=>{await createManagedCourse(name);void loadSettingsCourses()}} onArchive={async(id,archived)=>{await archiveManagedCourse(id,archived);void loadSettingsCourses()}} onOpen={openManagedCourse} onChanged={()=>{refresh();void loadSettingsCourses()}} onOpenSource={openSourceFromSettings} onSourcesDeleted={handleSourcesDeleted} onSourceRenamed={handleSourceRenamed} onClose={()=>setSettingsOpen(false)}/>}
 </div>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><I18nProvider><App/></I18nProvider></React.StrictMode>)
