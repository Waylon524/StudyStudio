import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Check, ChevronDown, ChevronRight, CircleHelp, RotateCcw, Eye, Layers, ImagePlus, X } from 'lucide-react'
import type { CanvasSpec, SavedCanvas, LearningData, StudyAnswer, StudyAnswerImage, StudyAttempt, StudyContextValue, StudyQuestion, StudySpec, StudyType, UIBlock } from './study-types'
import {TeachingCanvas} from './TeachingCanvas'
import {validateCanvasSpec} from '../shared/canvas-schema.mjs'
import {trackStudySubmission} from './study-submissions'
import {createLearningEntry,learningIndex,indexedLatestAttempt,registeredStudySet,canvasKey} from './course-learning-store'
import {tCurrent,useI18n} from './i18n'
import './study.css'

const Context = createContext<StudyContextValue>({})
export function StudyProvider({ value, children }: { value: StudyContextValue; children: React.ReactNode }) { return <Context.Provider value={value}>{children}</Context.Provider> }
export const useStudyContext = () => useContext(Context)
const types = new Set<StudyType>(['true_false','choice','fill_blank','short_answer','flashcard'])
const learningEntries = new Map<string,ReturnType<typeof createLearningEntry>>()
const registrationCache = new Map<string,{request:Promise<any>;changed:boolean;notified:boolean}>()

export async function studyApi(path:string,body?:unknown) {
  const response=await fetch('/api'+path,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  const value=await response.json()
  if(!response.ok)throw Object.assign(new Error(value.error||value.message||tCurrent('practice.saveError')),{status:response.status})
  return value
}
function courseLearning(courseId:string){
  let entry=learningEntries.get(courseId)
  if(!entry){entry=createLearningEntry(()=>studyApi('/courses/'+encodeURIComponent(courseId)+'/learning'));learningEntries.set(courseId,entry)}
  return entry
}
const emptyLearning=createLearningEntry(async()=>({items:[],attempts:[]}))
export function notifyStudyChanged(courseId:string) {courseLearning(courseId).invalidate()}
export function useCourseLearning(courseId?:string, revision?:number) {
  const entry=courseId?courseLearning(courseId):emptyLearning
  const snapshot=useSyncExternalStore(entry.subscribe,entry.getSnapshot,entry.getSnapshot)
  useEffect(()=>{if(courseId)entry.ensure(revision)},[entry,courseId,revision])
  return {...snapshot,refresh:entry.invalidate}
}

// Scan only syntactically complete values within the top-level array. This is a
// parser, not code execution: unfinished tokens remain a quiet placeholder.
export function extractStudyQuestions(blocks:UIBlock[]):StudyQuestion[] {
  const result:StudyQuestion[]=[]
  for(const block of blocks){if(!block||typeof block!=='object')continue;if(block.type==='question'&&block.question)result.push(block.question);if(Array.isArray(block.tabs))for(const tab of block.tabs)if(Array.isArray(tab.blocks))result.push(...extractStudyQuestions(tab.blocks))}
  return result
}
export function parseLiveStudy(source:string):{spec:StudySpec;complete:boolean;invalid:boolean} {
  try {
    const parsed=JSON.parse(source)
    if(parsed&&Array.isArray(parsed.blocks))return {spec:{id:parsed.id,title:parsed.title,items:extractStudyQuestions(parsed.blocks),blocks:parsed.blocks},complete:true,invalid:false}
    if(parsed&&Array.isArray(parsed.items))return {spec:parsed,complete:true,invalid:false}
    return {spec:{items:[]},complete:true,invalid:true}
  } catch { /* A streamed JSON document may not be complete yet. */ }
  const found=/"(items|blocks)"\s*:\s*\[/.exec(source)
  if(!found)return {spec:{items:[]},complete:false,invalid:false}
  const items:any[]=[]
  let start=-1,depth=0,inString=false,escaped=false
  for(let i=found.index+found[0].length;i<source.length;i++){
    const char=source[i]
    if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;continue}
    if(char==='"'){inString=true;continue}
    if(char==='{'||char==='['){if(depth===0)start=i;depth++}
    if(char==='}'||char===']'){
      if(depth===0)break
      depth--
      if(depth===0&&start>=0){try{const item=JSON.parse(source.slice(start,i+1));if(item&&typeof item==='object')items.push(item)}catch{}start=-1}
    }
  }
  const titleMatch=/"title"\s*:\s*("(?:\\.|[^"\\])*")/.exec(source.slice(0,found.index))
  let title:string|undefined
  if(titleMatch){try{title=JSON.parse(titleMatch[1])}catch{}}
  return {spec:found[1]==='blocks'?{title,items:extractStudyQuestions(items),blocks:items}:{title,items},complete:false,invalid:false}
}

function textAnswer(answer:unknown,q?:StudyQuestion,trueText?:string,falseText?:string,joiner='、'):string {
  if(typeof answer==='boolean')return answer?(trueText||tCurrent('study.true')):(falseText||tCurrent('study.false'))
  if(Array.isArray(answer)){
    const parts=answer.map(item=>q?.options?.find(o=>o.id===item)?.text||String(item))
    return parts.some(part=>/[\n`$]/.test(part)&&/(?:```|~~~|\$\$|\n)/.test(part))?parts.join('\n\n'):parts.join(joiner)
  }
  return q?.options?.find(o=>o.id===answer)?.text||String(answer??'')
}
function feedbackText(attempt?:StudyAttempt|null) { const feedback=attempt?.feedback;return typeof feedback==='string'?feedback:feedback?.feedback||feedback?.text||'' }
const maxAnswerImages=4,maxAnswerImageBytes=10*1024*1024
const answerImageAccept='image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,.heic,.heif'
type AnswerImageDraft={key:string;name:string;url:string;status:'uploading'|'ready'|'failed';file:File;image?:StudyAnswerImage;error?:string}
function imageBase64(file:File):Promise<string>{return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',',2)[1]||'');reader.onerror=()=>reject(Error(tCurrent('study.imageReadFailed')));reader.onabort=()=>reject(Error(tCurrent('study.imageReadAborted')));reader.readAsDataURL(file)})}
function AnswerImageGallery({images,compact=false}:{images:StudyAnswerImage[];compact?:boolean}){
 const {t}=useI18n()
 const [expanded,setExpanded]=useState<string|null>(null)
 if(!images.length)return null
 return <div className={'study-answer-images'+(compact?' is-compact':'')} aria-label={t('study.savedImagesAria')}>{images.map((image,index)=><button type="button" className={'study-answer-image'+(expanded===image.id?' is-expanded':'')} key={image.id} aria-label={expanded===image.id?t('study.shrinkImage',{n:index+1,name:image.name}):t('study.expandImage',{n:index+1,name:image.name})} aria-expanded={expanded===image.id} onClick={()=>setExpanded(expanded===image.id?null:image.id)}><img src={image.url} alt={t('study.savedImageAlt',{n:index+1,name:image.name})} loading="lazy"/></button>)}</div>
}
export function latestFor(question:StudyQuestion,attempts?:StudyAttempt[]) {return question.latestAttempt||question.attempts?.at(-1)||(attempts?indexedLatestAttempt(attempts,question.id):null)||null}
export function CanvasCard({canvas,savedCanvas}:{canvas:CanvasSpec;savedCanvas?:SavedCanvas}){
  const context=useStudyContext(),{data}=useCourseLearning(context.courseId,context.revision)
  const [local,setLocal]=useState<SavedCanvas|null>(null)
  useEffect(()=>{setLocal(null)},[context.courseId,context.threadId,context.itemId,canvas.id])
  const saved=savedCanvas||local||learningIndex(data).canvases.get(canvasKey(canvas.id,context.threadId,context.itemId))
  async function save(){
    const result=await studyApi('/courses/'+encodeURIComponent(context.courseId!)+'/canvas/save',{threadId:context.threadId,itemId:context.itemId,canvas})
    setLocal(result.canvas);notifyStudyChanged(context.courseId!);context.onLearningChange?.()
  }
  function report(value:{label:string;value?:string}){
    if(!saved||!context.courseId)return
    void studyApi('/courses/'+encodeURIComponent(context.courseId)+'/canvas/activity',{canvasId:saved.id,kind:'reported_interaction',...value}).catch(()=>{})
  }
  return <TeachingCanvas canvas={canvas} saved={Boolean(saved)} onSave={context.courseId&&context.threadId&&context.itemId?save:undefined} onReport={report} onOpenInReader={context.onOpenCanvas?()=>context.onOpenCanvas!(canvas,{savedCanvas:saved||undefined,threadId:context.threadId||undefined,itemId:context.itemId}):undefined}/>
}
function CanvasBlock({block,disabled}:{block:UIBlock;disabled:boolean}){
  const {t}=useI18n()
  if(disabled)return <div className="study-component-loading"><span className="spinner"/>{t('study.canvasLoading')}</div>
  try{return <CanvasCard canvas={validateCanvasSpec(block)}/>}
  catch{return <p className="study-component-error" role="alert">{t('study.canvasInvalid')}</p>}
}
type QuestionCardProps={question:StudyQuestion;number?:number;disabled?:boolean;latestAttempt?:StudyAttempt|null;renderMarkdown?:(text:string)=>React.ReactNode;onSaved?:()=>void;onAskAgent?:(text:string)=>void}
export function QuestionCard(props:QuestionCardProps){const context=useStudyContext();return <QuestionCardBody key={(context.courseId||'')+':'+(props.question.id||props.question.prompt)} {...props}/>}
function QuestionCardBody({question,number,disabled=false,latestAttempt,renderMarkdown,onSaved}:QuestionCardProps) {
  const {locale,t,questionTypeLabel,formatDateTime}=useI18n()
  const context=useStudyContext(),q=question
  const render=renderMarkdown||context.renderMarkdown||((text:string)=><span style={{whiteSpace:'pre-wrap'}}>{text}</span>)
  const latest=latestAttempt===undefined?latestFor(q):latestAttempt
  const [answer,setAnswer]=useState<StudyAnswer>(q.multiple?[]:'')
  const [localAttempt,setLocalAttempt]=useState<StudyAttempt|null>(null)
  const [reveal,setReveal]=useState(false),[everRevealed,setEverRevealed]=useState(Boolean(q.reveals?.length)),[retry,setRetry]=useState(false)
  const [saving,setSaving]=useState(false),[error,setError]=useState(''),[history,setHistory]=useState(false)
  const [imageDrafts,setImageDrafts]=useState<AnswerImageDraft[]>([]),[draggingImages,setDraggingImages]=useState(false)
  const imageDraftsRef=useRef<AnswerImageDraft[]>([]),imageInput=useRef<HTMLInputElement|null>(null),uploadRequests=useRef(new Set<AbortController>()),alive=useRef(true)
  const submissionRef=useRef<{key:string;id:string}|null>(null)
  // A switched-away view cannot delete photos while their submit may commit.
  // Keep protection after an ambiguous network error until an idempotent retry.
  const submittedImageIds=useRef(new Set<string>())
  const currentLocal=localAttempt&&latest?.id===localAttempt.id?latest:localAttempt
  const attempt=retry?currentLocal:currentLocal||latest
  const displayAnswer=attempt?.answer??answer
  const revealVisible=reveal||Boolean(attempt&&attempt.grade?.status!=='pending_feedback'&&q.type!=='flashcard')||Boolean(q.reveals?.length)
  const locked=disabled||saving||!context.courseId||!q.id
  const imageBusy=imageDrafts.some(image=>image.status==='uploading'),imageFailed=imageDrafts.some(image=>image.status==='failed')
  const imageBase='/api/courses/'+encodeURIComponent(context.courseId||'')+'/answer-images'
  const answerJoiner=locale==='zh-CN'?'、':', '
  const formatAns=(val:unknown)=>textAnswer(val,q,t('study.true'),t('study.false'),answerJoiner)
  function discardRemote(image:StudyAnswerImage){void fetch(imageBase+'/'+encodeURIComponent(image.id),{method:'DELETE'}).catch(()=>{})}
  function disposeImages(images:AnswerImageDraft[],removeRemote:boolean){for(const image of images){URL.revokeObjectURL(image.url);if(removeRemote&&image.image&&!submittedImageIds.current.has(image.image.id))discardRemote(image.image)}}
  function setDrafts(update:(images:AnswerImageDraft[])=>AnswerImageDraft[]){const next=update(imageDraftsRef.current);imageDraftsRef.current=next;if(alive.current)setImageDrafts(next)}
  function clearImages(removeRemote=true){const previous=imageDraftsRef.current;imageDraftsRef.current=[];disposeImages(previous,removeRemote);if(alive.current){setImageDrafts([]);setDraggingImages(false)}}
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;for(const controller of uploadRequests.current)controller.abort();disposeImages(imageDraftsRef.current,true);imageDraftsRef.current=[]}},[])
  useEffect(()=>{setLocalAttempt(null);setRetry(false);setReveal(false);setAnswer(q.multiple?[]:'');setError('');setEverRevealed(Boolean(q.reveals?.length));submissionRef.current=null},[q.id])
  const changed=()=>{if(context.courseId)notifyStudyChanged(context.courseId);context.onLearningChange?.();onSaved?.()}
  async function submit(value:StudyAnswer=answer){
    if(locked||imageBusy||imageFailed)return
    setSaving(true);setError('')
    const imageIds=q.type==='short_answer'?imageDraftsRef.current.flatMap(image=>image.image?[image.image.id]:[]):[]
    for(const id of imageIds)submittedImageIds.current.add(id)
    try {
      const payload={questionId:q.id,answer:value,hintUsed:false,revealed:everRevealed||revealVisible,...(q.type==='short_answer'?{imageIds}:{})}
      const key=JSON.stringify(payload)
      if(submissionRef.current?.key!==key)submissionRef.current={key,id:crypto.randomUUID()}
      const result=await trackStudySubmission(context.courseId!,q.id!,studyApi('/courses/'+encodeURIComponent(context.courseId!)+'/attempts',{...payload,clientId:submissionRef.current.id}))
      for(const id of imageIds)submittedImageIds.current.delete(id)
      submissionRef.current=null
      if(!alive.current){if(context.courseId)notifyStudyChanged(context.courseId);return}
      setLocalAttempt(result.attempt);setRetry(false);clearImages(false);changed()
    } catch(err:any){if(typeof err.status==='number')for(const id of imageIds)submittedImageIds.current.delete(id);if(alive.current)setError(err.message)} finally {if(alive.current)setSaving(false)}
  }
  async function uploadImage(draft:AnswerImageDraft){
    const controller=new AbortController();uploadRequests.current.add(controller)
    try{
      const data=await imageBase64(draft.file)
      if(!alive.current||!imageDraftsRef.current.some(image=>image.key===draft.key))return
      const response=await fetch(imageBase,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({questionId:q.id,name:draft.file.name,mime:draft.file.type||'application/octet-stream',data}),signal:controller.signal})
      const result=await response.json()
      if(!response.ok)throw Error(result.error||result.message||tCurrent('study.imageUploadFailed'))
      const image=result.image as StudyAnswerImage
      if(!image||typeof image.id!=='string'||typeof image.url!=='string'||!image.url.startsWith(imageBase+'/'))throw Error(tCurrent('study.imageNotSaved'))
      if(!alive.current||!imageDraftsRef.current.some(item=>item.key===draft.key)){discardRemote(image);return}
      setDrafts(images=>images.map(item=>item.key===draft.key?{...item,status:'ready',image,error:undefined}:item))
    }catch(err:any){if(alive.current&&err.name!=='AbortError')setDrafts(images=>images.map(item=>item.key===draft.key?{...item,status:'failed',error:err.message||tCurrent('study.imageUploadFailed')}:item))}
    finally{uploadRequests.current.delete(controller)}
  }
  function addImageFiles(files:File[]){
    if(locked||attempt||q.type!=='short_answer'||!files.length)return
    if(imageDraftsRef.current.length+files.length>maxAnswerImages){setError(t('study.imageMaxCount'));return}
    for(const file of files){if(!/\.(png|jpe?g|webp|gif|heic|heif)$/i.test(file.name)){setError(t('study.imageAllowedFormats'));return}if(!file.size||file.size>maxAnswerImageBytes){setError(t('study.imageMaxSize'));return}}
    setError('')
    const added=files.map(file=>({key:crypto.randomUUID(),name:file.name,url:URL.createObjectURL(file),status:'uploading' as const,file}))
    setDrafts(images=>[...images,...added]);for(const draft of added)void uploadImage(draft)
  }
  function removeImage(key:string){const draft=imageDraftsRef.current.find(image=>image.key===key);if(!draft)return;disposeImages([draft],true);setDrafts(images=>images.filter(image=>image.key!==key))}
  async function showAnswer(){
    if(locked)return
    setSaving(true);setError('')
    try {await studyApi('/courses/'+encodeURIComponent(context.courseId!)+'/reveal',{questionId:q.id});setReveal(true);setEverRevealed(true);changed()}catch(err:any){setError(err.message)}finally{setSaving(false)}
  }
  function retryQuestion(){setLocalAttempt(null);setRetry(true);setAnswer(q.multiple?[]:'');clearImages();setError('');setReveal(false);submissionRef.current=null;if(revealVisible)setEverRevealed(true)}
  const hasInput=typeof answer==='boolean'||(Array.isArray(answer)?answer.length>0:answer.trim().length>0)||(q.type==='short_answer'&&imageDrafts.some(image=>image.status==='ready'))
  const feedback=feedbackText(attempt)
  return <section className={'study-question '+(attempt?.grade?.correct===true?'study-is-correct':attempt?.grade?.correct===false?'study-is-incorrect':'')} data-study-question={q.id||undefined}>
    <div className="study-question-header"><span>{number?number+'. ':''}{types.has(q.type)?questionTypeLabel(q.type):t('study.componentDefault')}{q.type==='choice'&&q.multiple?t('practice.multipleTag'):''}</span><div className="study-question-tools">{disabled?<span className="study-live-label">{t('study.generating')}</span>:attempt?<span className="study-state-label">{attempt.grade?.status==='pending_feedback'&&!feedback?t('practice.status.pending'):attempt.grade?.status==='self_assessed'?t('practice.status.selfAssessed'):feedback?t('practice.status.feedback'):t('practice.status.answered')}</span>:null}{attempt&&q.type!=='flashcard'&&<button type="button" className="study-text-button study-retry" disabled={locked} onClick={retryQuestion}><RotateCcw size={13}/>{t('study.retryQuestion')}</button>}</div></div>
    <div className="study-prompt">{render(q.prompt)}</div>
    {q.type==='flashcard'?<div className="study-flashcard">
      {revealVisible?<><div className="study-flash-answer">{render(formatAns(q.answer)||q.explanation||t('study.flashcardNoBack'))}</div>{q.explanation&&q.answer&&<div className="study-explanation">{render(q.explanation)}</div>}<div className="flash-ratings" role="group" aria-label={t('study.flashcardRatingAria')}>{[{id:'again',label:t('study.flash.again')},{id:'hard',label:t('study.flash.hard')},{id:'good',label:t('study.flash.good')},{id:'easy',label:t('study.flash.easy')}].map(r=><button key={r.id} disabled={locked} className={attempt?.answer===r.id?'selected':''} onClick={()=>submit(r.id)}>{r.label}</button>)}</div><p className="study-footnote">{t('study.flashcardFootnote')}</p></>:<button className="study-flip" disabled={locked} onClick={showAnswer}><Layers size={17}/>{t('study.flipAnswer')}</button>}
    </div>:<>
      {q.type==='true_false'&&<div className="study-options" role="radiogroup" aria-label={t('study.tfAria')}>{[{value:true,label:t('study.true')},{value:false,label:t('study.false')}].map(option=><button key={String(option.value)} type="button" role="radio" aria-checked={displayAnswer===option.value} disabled={locked||Boolean(attempt)} onClick={()=>setAnswer(option.value)} className={displayAnswer===option.value?'selected':''}><span className="choice-indicator">{displayAnswer===option.value&&<span/>}</span>{option.label}</button>)}</div>}
      {q.type==='choice'&&<div className="study-options" role={q.multiple?'group':'radiogroup'} aria-label={t('study.choiceAria')}>{(q.options||[]).map(option=>{const selected=Array.isArray(displayAnswer)?displayAnswer.includes(option.id):displayAnswer===option.id;return <button key={option.id} type="button" role={q.multiple?'checkbox':'radio'} aria-checked={selected} disabled={locked||Boolean(attempt)} onClick={()=>setAnswer(q.multiple?(Array.isArray(answer)?selected?answer.filter(a=>a!==option.id):[...answer,option.id]:[option.id]):option.id)} className={selected?'selected':''}><span className={'choice-indicator '+(q.multiple?'square':'')}>{selected&&(q.multiple?<Check size={12}/>:<span/>)}</span><span className="study-option-id">{option.id.toUpperCase()}</span><span className="study-option-body">{render(option.text)}</span></button>})}</div>}
      {q.type==='fill_blank'&&<input className="study-answer-input" aria-label={t('study.fillBlankAria')} placeholder={t('study.fillBlankPlaceholder')} value={typeof displayAnswer==='string'?displayAnswer:''} onChange={event=>setAnswer(event.target.value)} disabled={locked||Boolean(attempt)} onKeyDown={event=>{if(event.key==='Enter'&&hasInput)submit()}}/>}
      {q.type==='short_answer'&&<div data-study-answer-input className={'study-short-answer'+(draggingImages?' is-dragging':'')} onDragEnter={event=>{if(!locked&&!attempt&&event.dataTransfer.types.includes('Files')){event.preventDefault();event.stopPropagation();setDraggingImages(true)}}} onDragOver={event=>{if(!locked&&!attempt&&event.dataTransfer.types.includes('Files')){event.preventDefault();event.stopPropagation();setDraggingImages(true)}}} onDragLeave={event=>{if(!(event.relatedTarget instanceof Node)||!event.currentTarget.contains(event.relatedTarget))setDraggingImages(false)}} onDrop={event=>{if(locked||attempt)return;event.preventDefault();event.stopPropagation();setDraggingImages(false);addImageFiles(Array.from(event.dataTransfer.files))}}>
       <textarea className="study-answer-textarea" aria-label={t('study.shortAnswerAria')} placeholder={t('study.shortAnswerPlaceholder')} rows={3} value={typeof displayAnswer==='string'?displayAnswer:''} onChange={event=>setAnswer(event.target.value)} onPaste={event=>{const images=Array.from(event.clipboardData.files);if(!locked&&!attempt&&images.length){event.preventDefault();event.stopPropagation();addImageFiles(images)}}} disabled={locked||Boolean(attempt)}/>
       {!attempt&&<><input ref={imageInput} type="file" accept={answerImageAccept} multiple hidden aria-label={t('study.selectAnswerImageAria')} onChange={event=>{addImageFiles(Array.from(event.target.files||[]));event.target.value=''}}/><button className="study-text-button study-add-answer-image" type="button" disabled={locked||imageDrafts.length>=maxAnswerImages} onClick={()=>imageInput.current?.click()}><ImagePlus size={14}/>{t('study.addImage')}</button>{imageDrafts.length>0&&<div className="study-answer-drafts" aria-label={t('study.pendingImagesAria')}>{imageDrafts.map((image,index)=><div className={'study-answer-draft '+image.status} key={image.key}>{/\.(heic|heif)$/i.test(image.name)?image.image?<img src={image.image.url} alt={t('study.pendingImageAlt',{n:index+1})}/>:<span className="study-answer-photo-placeholder"><ImagePlus size={22}/></span>:<img src={image.url} alt={t('study.pendingImageAlt',{n:index+1})}/>}<button type="button" className="study-remove-answer-image" aria-label={t('study.removeImage',{n:index+1,name:image.name})} disabled={locked} onClick={()=>removeImage(image.key)}><X size={12}/></button>{image.status==='uploading'&&<span className="study-answer-uploading" role="status"><span className="spinner"/>{t('study.uploading')}</span>}{image.status==='failed'&&<div className="study-answer-upload-error" role="alert"><span>{image.error}</span><button type="button" disabled={locked} onClick={()=>{setDrafts(images=>images.map(item=>item.key===image.key?{...item,status:'uploading',error:undefined}:item));void uploadImage(image)}}>{t('app.retry')}</button></div>}</div>)}</div>}</>}
      </div>}
      {!attempt?<div className="study-actions"><button className="study-submit" disabled={locked||!hasInput||imageBusy||imageFailed} onClick={()=>submit()}>{saving?t('study.savingAnswer'):t('study.submitAnswer')}</button>{q.type==='short_answer'&&(q.answer||q.explanation)&&<button className="study-text-button" disabled={locked} onClick={showAnswer}><Eye size={14}/>{t('study.viewReference')}</button>}</div>:<div className="study-result">
        <div className={'study-grade '+(attempt.grade?.correct===true?'correct':attempt.grade?.correct===false?'incorrect':'pending')}><span>{attempt.grade?.correct===true?t('study.gradeCorrect'):attempt.grade?.correct===false?t('study.gradeIncorrect'):feedback?t('study.gradeFeedback'):t('study.gradePending')}</span>{(attempt.revealed||attempt.hintUsed)&&<small>{t('study.hintOrRevealUsed')}</small>}</div>
        <div className="study-your-answer"><span>{t('study.yourAnswer',{answer:''})}</span><div className="study-your-answer-body">{formatAns(attempt.answer)?render(formatAns(attempt.answer)):(attempt.images?.length?t('study.imageAnswer'):'')}</div></div>
        {q.type==='short_answer'&&attempt.images?.length?<AnswerImageGallery images={attempt.images}/>:null}
        {revealVisible&&q.answer!==undefined&&<div className="study-reference"><span>{t('study.referenceAnswer')}</span>{render(formatAns(q.answer))}</div>}
        {revealVisible&&q.explanation&&<div className="study-explanation">{render(q.explanation)}</div>}
        {feedback&&<div className="study-feedback">{render(feedback)}</div>}
      </div>}
      {!attempt&&revealVisible&&<div className="study-reference"><span>{t('study.referenceAnswer')}</span>{render(formatAns(q.answer)||q.explanation||t('study.noReference'))}</div>}
    </>}
    {error&&<p className="study-error" role="alert">{error}</p>}
    {(q.attempts?.length||0)>1&&<div className="study-history"><button className="study-text-button" onClick={()=>setHistory(!history)}>{history?<ChevronDown size={13}/>:<ChevronRight size={13}/>}{t('study.attemptHistory',{count:q.attempts?.length||0})}</button>{history&&<ol>{q.attempts?.map(a=><li key={a.id}><time>{formatDateTime(a.createdAt)}</time><span className="study-history-answer">{formatAns(a.answer)?render(formatAns(a.answer)):(a.images?.length?t('study.imageAnswer'):'')}{a.images?.length?<AnswerImageGallery images={a.images} compact/>:null}</span><span>{a.grade?.status==='self_assessed'?t('study.historySelf'):a.grade?.correct===true?t('study.historyCorrect'):a.grade?.correct===false?t('study.historyIncorrect'):t('study.historyPending')}</span></li>)}</ol>}</div>}
  </section>
}

export function LiveStudyBlock({source,streaming=false,blockId}:{source:string;streaming?:boolean;blockId?:string}) {
  const {t}=useI18n()
  const context=useStudyContext(),parsed=useMemo(()=>{const value=parseLiveStudy(source);if(blockId&&!value.spec.id)value.spec.id=blockId;return value},[source,blockId])
  const [saved,setSaved]=useState<StudyQuestion[]>([]),[error,setError]=useState(''),[saving,setSaving]=useState(false)
  const {data}=useCourseLearning(context.courseId,context.revision)
  useEffect(()=>{
    if(streaming||!parsed.complete||parsed.invalid||!parsed.spec.items.length||!context.courseId||!context.threadId||!context.itemId)return
    const key=JSON.stringify([context.courseId,context.threadId,context.itemId,parsed.spec.id||'set',source])
    let active=true;setSaving(true);setError('');setSaved([])
    if(!registrationCache.has(key)){
      const entry=courseLearning(context.courseId)
      const registration={request:Promise.resolve<any>(null),changed:false,notified:false}
      registration.request=(async()=>{
        const current=await entry.read()
        const existing=await registeredStudySet(current,context.courseId!,context.threadId!,context.itemId!,parsed.spec)
        if(existing)return {items:existing}
        const result=await studyApi('/courses/'+encodeURIComponent(context.courseId!)+'/study/register',{threadId:context.threadId,itemId:context.itemId,spec:{...(parsed.spec.blocks?{id:parsed.spec.id,title:parsed.spec.title||''}:parsed.spec),items:parsed.spec.items}})
        registration.changed=true
        notifyStudyChanged(context.courseId!)
        return result
      })().catch(err=>{if(registrationCache.get(key)===registration)registrationCache.delete(key);throw err})
      registrationCache.set(key,registration)
    }
    const registration=registrationCache.get(key)!
    registration.request.then(result=>{if(active){setSaved(result.items||result.set?.items||[]);if(registration.changed&&!registration.notified&&context.onLearningChange){registration.notified=true;context.onLearningChange()}}}).catch(err=>{if(active)setError(err.message)}).finally(()=>{if(active)setSaving(false)})
    return ()=>{active=false}
  },[source,streaming,context.courseId,context.threadId,context.itemId,parsed.spec.id])
  const index=learningIndex(data)
  const registered=useMemo(()=>saved.map(question=>index.questions.get(question.id!)||question),[saved,index])
  const questions=registered.length?registered:parsed.spec.items
  const resolveQuestion=useMemo(()=>{
    const bySource=new Map(registered.map(question=>[question.sourceId,question]))
    const resolved=new Map(parsed.spec.items.map((question,index)=>[question,bySource.get(question.id??String(index+1))||question]))
    return (question:StudyQuestion)=>resolved.get(question)||question
  },[registered,parsed])
  if((parsed.invalid||!parsed.complete)&&!streaming)return <div className="study-component-error" role="alert">{t('study.blockInvalid')}</div>
  return <div className="study-set">
    {(parsed.spec.title||saving)&&<div className="study-set-heading">{parsed.spec.title&&<h3>{parsed.spec.title}</h3>}{saving&&<span>{t('study.savingQuestions')}</span>}</div>}
    {!questions.length&&!parsed.spec.blocks?.length&&streaming&&<div className="study-component-loading"><span className="spinner"/>{t('study.loadingComponents')}</div>}
    {parsed.spec.blocks?.map((block,index)=><GenericBlock key={index} block={block} resolveQuestion={resolveQuestion} disabled={streaming||saving||Boolean(parsed.spec.items.length&&!registered.length)}/>)}
    {!parsed.spec.blocks&&questions.filter(q=>q&&types.has(q.type)&&typeof q.prompt==='string').map((question,index)=><QuestionCard key={question.id||String(index)} question={question} number={questions.length>1?index+1:undefined} disabled={streaming||saving||!registered.length}/>) }
    {streaming&&questions.length>0&&<div className="study-stream-indicator"><span/>{t('study.continuingGeneration')}</div>}
    {!streaming&&!context.courseId&&questions.length>0&&<p className="study-footnote">{t('study.selectCourseFootnote')}</p>}
    {error&&<p className="study-error" role="alert">{error}</p>}
  </div>
}

function GenericBlock({block,resolveQuestion,disabled,depth=0}:{block:UIBlock;resolveQuestion:(question:StudyQuestion)=>StudyQuestion;disabled:boolean;depth?:number}) {
  const {t}=useI18n()
  const context=useStudyContext(),[tab,setTab]=useState(0)
  const render=context.renderMarkdown||((text:string)=><span>{text}</span>)
  if(!block||typeof block!=='object'||depth>5)return null
  if(block.type==='canvas')return <CanvasBlock block={block} disabled={disabled}/>
  if(block.type==='question'&&block.question&&types.has(block.question.type))return <QuestionCard question={resolveQuestion(block.question)} disabled={disabled}/>
  if(block.type==='markdown'||block.type==='text')return <div className="study-ui-markdown">{render(String(block.text||block.content||''))}</div>
  if(block.type==='callout')return <aside className={'study-callout '+(block.tone==='warning'?'warning':'')}><CircleHelp size={17}/><div>{block.title&&<strong>{block.title}</strong>}{render(String(block.text||''))}</div></aside>
  if(block.type==='table'&&Array.isArray(block.columns)&&Array.isArray(block.rows))return <div className="study-table"><table><thead><tr>{block.columns.slice(0,12).map((column,i)=><th key={i}>{column}</th>)}</tr></thead><tbody>{block.rows.slice(0,100).map((row,i)=><tr key={i}>{Array.isArray(row)&&row.slice(0,12).map((cell,j)=><td key={j}>{render(String(cell??''))}</td>)}</tr>)}</tbody></table></div>
  if(block.type==='steps'&&Array.isArray(block.items))return <ol className="study-steps">{block.items.slice(0,30).map((step,i)=><li key={i}>{step.title&&<strong>{step.title}</strong>}{render(String(step.text||''))}</li>)}</ol>
  if(block.type==='tabs'&&Array.isArray(block.tabs)&&block.tabs.length){const active=Math.min(tab,block.tabs.length-1);return <div className="study-ui-tabs"><div role="tablist">{block.tabs.slice(0,10).map((item,i)=><button key={i} role="tab" aria-selected={active===i} onClick={()=>setTab(i)}>{item.label}</button>)}</div><div role="tabpanel">{(block.tabs[active]?.blocks||[]).slice(0,30).map((child,i)=><GenericBlock key={i} block={child} resolveQuestion={resolveQuestion} disabled={disabled} depth={depth+1}/>)}</div></div>}
  if(block.type==='chart'&&Array.isArray(block.values))return <StudyChart block={block}/>
  return <p className="study-footnote">{t('study.unsupportedBlock',{type:String(block.type||t('study.unknownType'))})}</p>
}
function StudyChart({block}:{block:UIBlock}) {
  const {t}=useI18n()
  const values=(block.values||[]).slice(0,30).map(v=>Number.isFinite(v)?v:0),labels=(block.labels||[]).slice(0,30)
  if(!values.length)return null
  const min=Math.min(0,...values),max=Math.max(0,...values),range=max-min||1
  const x=(i:number)=>50+(i+.5)*500/values.length,y=(v:number)=>20+(max-v)*145/range,zero=y(0)
  const points=values.map((v,i)=>x(i)+','+y(v)).join(' ')
  return <figure className="study-chart">{block.title&&<figcaption>{block.title}</figcaption>}<svg viewBox="0 0 600 205" role="img" aria-label={block.title||t('study.chartAria')}><line x1={42} x2={560} y1={zero} y2={zero} stroke="#c7d8d4"/>{block.kind==='line'?<><polyline points={points} fill="none" stroke="var(--teal)" strokeWidth={2.5}/>{values.map((v,i)=><circle key={i} cx={x(i)} cy={y(v)} r={3.5} fill="var(--teal)"><title>{labels[i]||i+1}: {v}</title></circle>)}</>:values.map((v,i)=><rect key={i} x={x(i)-Math.min(22,160/values.length)} y={Math.min(y(v),zero)} width={Math.min(44,320/values.length)} height={Math.max(1,Math.abs(y(v)-zero))} rx={3} fill="#5da99a"><title>{labels[i]||i+1}: {v}</title></rect>)}{values.map((v,i)=><g key={i}><text x={x(i)} y={v>=0?y(v)-7:y(v)+14} textAnchor="middle" fontSize={11} fill="#4a6b66">{v}</text><text x={x(i)} y={190} textAnchor="middle" fontSize={11} fill="#7b8c8b">{String(labels[i]||i+1).slice(0,10)}</text></g>)}</svg></figure>
}
