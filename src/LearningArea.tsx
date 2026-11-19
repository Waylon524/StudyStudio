import React, {useState} from 'react'
import {BookOpen,ChevronDown,ChevronRight,FolderOpen,CheckCircle2,Clock3,Layers} from 'lucide-react'
import {CanvasCard,QuestionCard,StudyProvider,latestFor,useCourseLearning,studyApi,notifyStudyChanged} from './StudyComponents'
import type {CanvasSpec,OpenCanvasMeta,SavedCanvas} from './study-types'
import './study.css'

type Filter='all'|'unanswered'|'pending'|'answered'|'canvas'
const labels:Record<string,string>={true_false:'判断题',choice:'选择题',fill_blank:'填空题',short_answer:'简答题',flashcard:'闪卡'}
export function LearningArea({courseId,threadId,onAskAgent,onOpenCanvas,onChanged,revision,renderMarkdown,compact=false}:{courseId:string;threadId?:string|null;onAskAgent?:(text:string)=>void;onOpenCanvas?:(canvas:CanvasSpec,meta?:OpenCanvasMeta)=>void;onChanged?:()=>void;revision?:number;compact?:boolean;renderMarkdown?:(text:string)=>React.ReactNode}) {
 const {data,loading,error}=useCourseLearning(courseId,revision)
 const [filter,setFilter]=useState<Filter>('all'),[opened,setOpened]=useState<string|null>(null)
 const items=data.items||[],canvases=data.canvases||[]
 const visible=items.filter(q=>{const a=latestFor(q,data.attempts);return filter==='all'||filter==='unanswered'&&!a||filter==='answered'&&Boolean(a)||filter==='pending'&&a?.grade?.status==='pending_feedback'&&!a.feedback})
 const visibleCanvases=filter==='all'||filter==='canvas'?canvases:[]
 const render=renderMarkdown||((text:string)=><span style={{whiteSpace:'pre-wrap'}}>{text}</span>)
 const hasRecords=items.length>0||canvases.length>0
 function openCanvas(canvas:SavedCanvas){
  setOpened(opened===canvas.id?null:canvas.id)
  if(opened===canvas.id)return
  void studyApi('/courses/'+encodeURIComponent(courseId)+'/canvas/activity',{canvasId:canvas.id,kind:'opened'}).then(()=>{notifyStudyChanged(courseId);onChanged?.()}).catch(()=>{})
 }
 return <div className={'learning-area'+(compact?' is-compact':'')}>
  {!compact&&<div className="learning-heading"><h2>学习区</h2></div>}
  <div className="learning-filters" role="group" aria-label="筛选学习内容">{([{id:'all',text:'全部'},...(canvases.length?[{id:'canvas',text:'画布'}]:[]),{id:'unanswered',text:'未作答'},{id:'pending',text:'待反馈'},{id:'answered',text:'已作答'}] as {id:Filter;text:string}[]).map(item=><button key={item.id} aria-pressed={filter===item.id} onClick={()=>setFilter(item.id)} className={filter===item.id?'active':''}>{item.text}</button>)}</div>
  {error&&<p className="study-error" role="alert">{error}</p>}
  {loading&&!hasRecords?<div className="study-component-loading"><span className="spinner"/>正在读取学习记录…</div>:!hasRecords?<div className="learning-empty"><div><BookOpen size={22}/></div><h3>让问题变成可回顾的练习</h3><p>对话生成的题目、闪卡和保存的教学画布会出现在这里。</p></div>:!visible.length&&!visibleCanvases.length?<p className="learning-no-results">当前筛选下还没有内容。</p>:<div className="learning-item-list">{visible.map((q,index)=>{
    const attempt=latestFor(q,data.attempts),expanded=opened===q.id
    const statusTone=!attempt?'is-unanswered':attempt.grade?.status==='pending_feedback'&&!attempt.feedback?'is-pending':attempt.grade?.correct===true?'is-correct':attempt.grade?.correct===false?'is-incorrect':'is-done'
    return <div className={'learning-item'+(expanded?' is-expanded':'')} key={q.id||index}>
     <button className="learning-item-toggle" aria-expanded={expanded} onClick={()=>setOpened(expanded?null:q.id||String(index))}>
      <span className={'learning-item-icon '+statusTone}>{q.type==='flashcard'?<Layers size={14}/>:attempt?.grade?.status==='pending_feedback'&&!attempt.feedback?<Clock3 size={14}/>:attempt?<CheckCircle2 size={14}/>:<BookOpen size={14}/>}</span>
      <span className="learning-item-text"><span className="learning-item-kind">{labels[q.type]||'题目'}{q.multiple?' · 多选':''}</span><span className="learning-prompt-preview">{render(q.prompt)}</span></span>
      <span className={'learning-item-status '+statusTone}>{!attempt?'未作答':attempt.grade?.status==='self_assessed'?'已自评':attempt.grade?.status==='pending_feedback'&&!attempt.feedback?'待反馈':attempt.grade?.correct===true?'已答对':attempt.grade?.correct===false?'待巩固':'已反馈'}</span>{expanded?<ChevronDown size={14}/>:<ChevronRight size={14}/>}
     </button>
     {expanded&&<StudyProvider value={{courseId,threadId:q.threadId||threadId,itemId:q.itemId,onAskAgent,onLearningChange:onChanged,renderMarkdown}}><QuestionCard question={q} latestAttempt={attempt} onAskAgent={onAskAgent}/></StudyProvider>}
    </div>
  })}{visibleCanvases.map(canvas=><div className={'learning-item'+(opened===canvas.id?' is-expanded':'')} key={canvas.id}>
    <button className="learning-item-toggle" aria-expanded={opened===canvas.id} onClick={()=>openCanvas(canvas)}><span className="learning-item-icon is-canvas"><Layers size={14}/></span><span className="learning-item-text"><span className="learning-item-kind">教学画布</span><span className="learning-prompt-preview">{canvas.title}</span></span><span className="learning-item-status is-canvas">{canvas.lastOpenedAt?'已查看':'已保存'}</span>{opened===canvas.id?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>
    {opened===canvas.id&&<StudyProvider value={{courseId,threadId:canvas.threadId,itemId:canvas.itemId,revision,onLearningChange:onChanged,onOpenCanvas}}><CanvasCard canvas={{id:canvas.sourceId,title:canvas.title,html:canvas.html,height:canvas.height}} savedCanvas={canvas}/></StudyProvider>}
  </div>)}</div>}
  {!compact&&(data.workspacePath||data.importantInfo||data.progress)&&<div className="learning-course-records">
   {data.workspacePath&&<details><summary><FolderOpen size={15}/>课程工作区</summary><p className="learning-workspace-path">{data.workspacePath}</p></details>}
   {data.importantInfo&&<details><summary>课程重要信息</summary><div className="learning-notes">{render(data.importantInfo)}</div></details>}
   {typeof data.progress==='string'&&data.progress&&<details><summary>学习进度记录</summary><div className="learning-notes">{render(data.progress)}</div></details>}
  </div>}
 </div>
}
