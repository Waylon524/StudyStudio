import {useEffect,useMemo,useRef,useState} from 'react'
import {BookOpen,CalendarClock,FolderOpen,SlidersHorizontal,X} from 'lucide-react'
import type {ThinkingPreset,ThinkingPresetConfigs,ThinkingPresetOverride} from '../shared/model-presets.mjs'
import {CourseAvatar} from './CourseAvatar'
import {DailyCourseManagement,type RequirementSource} from './CourseRequirements'
import {SettingsCourses} from './SettingsCourses'
import {SettingsGeneral} from './SettingsGeneral'
import {SettingsMaterials} from './SettingsMaterials'
import type {CatalogModel,ManagedCourse,ManagedSource,SettingsInfo} from './settings-types'
import './settings.css'

export type {CatalogModel,ManagedCourse,ManagedSource}
export type SettingsSection='materials'|'courses'|'daily'|'general'

type Props={
 courses:ManagedCourse[]
 activeCourseId:string
 currentSourceId?:string|null
 conversationBusy:boolean
 loading?:boolean
 loadError?:string
 initialSection?:SettingsSection
 preset:ThinkingPreset
 onPresetChange:(preset:ThinkingPreset)=>void
 presetConfigs:ThinkingPresetConfigs
 onSavePresetConfigs:(next:ThinkingPresetOverride)=>Promise<void>
 onResetPresetConfigs:()=>Promise<void>
 catalogModels:CatalogModel[]
 onRefreshModels:()=>Promise<void>
 status:{connected:boolean;authenticated:boolean}|null
 leftOpen:boolean
 onToggleLeftOpen:()=>void
 onResetLayout:()=>void
 onCreate:(name:string)=>Promise<void>
 onArchive:(id:string,archived:boolean)=>Promise<void>
 onOpen:(id:string)=>Promise<void>|void
 onClose:()=>void
 onChanged?:(courseId:string)=>void
 onOpenSource?:(courseId:string,sourceId:string,page?:number)=>Promise<void>|void
 onOpenConversation?:(courseId:string,source:RequirementSource)=>Promise<void>|void
 onSourcesDeleted?:(courseId:string,sourceIds:string[],attachmentIds:string[])=>void
 onSourceRenamed?:(courseId:string,source:ManagedSource)=>void
 revision?:number
}

const collator=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'})

const SECTION_META:Record<SettingsSection,{title:string;subtitle:string;navLabel:string}>={
 materials:{navLabel:'资料与课件',title:'资料与课件',subtitle:'上传、分类、重命名、移动或清理各课程的 PDF 课件与学习资料。'},
 courses:{navLabel:'课程管理',title:'课程管理',subtitle:'管理活跃与归档课程、专属头像以及每门课的学习约定（AGENTS.md）。'},
 daily:{navLabel:'日程与要求',title:'日程与要求',subtitle:'查看、更正或移除从对话与资料中记录的考试、作业与课程要求。'},
 general:{navLabel:'偏好与状态',title:'偏好与状态',subtitle:'配置默认思考强度、界面布局，查看本机服务连接与存储位置。'}
}

export function SettingsPage({
 courses,activeCourseId,currentSourceId,conversationBusy,loading=false,loadError='',
 initialSection='materials',preset,onPresetChange,presetConfigs,onSavePresetConfigs,onResetPresetConfigs,
 catalogModels,onRefreshModels,status,leftOpen,onToggleLeftOpen,onResetLayout,
 onCreate,onArchive,onOpen,onClose,onChanged,onOpenSource,onOpenConversation,onSourcesDeleted,onSourceRenamed,revision
}:Props){
 const [section,setSection]=useState<SettingsSection>(initialSection)
 const [selectedCourseId,setSelectedCourseId]=useState<string>(activeCourseId)
 const [info,setInfo]=useState<SettingsInfo|null>(null)
 const dialog=useRef<HTMLDivElement>(null),closeRef=useRef(onClose)
 closeRef.current=onClose

 const activeCourses=useMemo(()=>{
  return courses.filter(course=>!course.archivedAt).sort((a,b)=>{
   if(a.id===activeCourseId)return -1
   if(b.id===activeCourseId)return 1
   if(a.id==='general')return -1
   if(b.id==='general')return 1
   return collator.compare(a.name,b.name)
  })
 },[courses,activeCourseId])

 useEffect(()=>{
  if(activeCourses.length&&!activeCourses.some(c=>c.id===selectedCourseId)){
   setSelectedCourseId(activeCourses.some(c=>c.id===activeCourseId)?activeCourseId:activeCourses[0].id)
  }
 },[activeCourses,activeCourseId,selectedCourseId])

 useEffect(()=>{
  const controller=new AbortController()
  fetch('/api/settings/info',{signal:controller.signal})
   .then(async res=>{if(!res.ok)return;const data=await res.json();if(!controller.signal.aborted)setInfo(data)})
   .catch(()=>{})
  return()=>controller.abort()
 },[])

 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null
  dialog.current?.focus({preventScroll:true})
  const onKeyDown=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){
    if(event.defaultPrevented)return
    event.preventDefault();event.stopPropagation();closeRef.current()
    return
   }
   if(event.key!=='Tab')return
   const focusable=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')||[]).filter(el=>el.getClientRects().length>0)
   const first=focusable[0],last=focusable.at(-1)
   if(!first){event.preventDefault();return}
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
  }
  window.addEventListener('keydown',onKeyDown)
  return()=>{window.removeEventListener('keydown',onKeyDown);if(previous?.isConnected)previous.focus()}
 },[])

 const totalActiveFiles=useMemo(()=>activeCourses.reduce((sum,course)=>sum+(course.stats?.fileCount||0),0),[activeCourses])
 const hasStats=useMemo(()=>activeCourses.some(course=>Boolean(course.stats)),[activeCourses])

 const navItems:Array<{id:SettingsSection;icon:typeof FolderOpen;badge?:number}>=[
  {id:'materials',icon:FolderOpen,badge:hasStats?totalActiveFiles:undefined},
  {id:'courses',icon:BookOpen,badge:activeCourses.length||undefined},
  {id:'daily',icon:CalendarClock},
  {id:'general',icon:SlidersHorizontal}
 ]

 const meta=SECTION_META[section]

 return <div className="settings-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}>
  <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="study-settings-title" className="settings-page">
   <aside className="settings-sidebar" aria-label="设置导航">
    <div className="settings-brand">
     <h1 id="study-settings-title">设置</h1>
     <p>工作区与偏好</p>
    </div>

    <nav className="settings-nav" role="tablist" aria-label="设置分类">
     {navItems.map(item=>{
      const Icon=item.icon,active=section===item.id
      return <button
       key={item.id}
       type="button"
       role="tab"
       aria-selected={active}
       className={'settings-nav-item'+(active?' is-active':'')}
       onClick={()=>setSection(item.id)}
      >
       <Icon size={16}/>
       <span>{SECTION_META[item.id].navLabel}</span>
       {typeof item.badge==='number'&&<small className="sm-tabular">{item.badge}</small>}
      </button>
     })}
    </nav>

    <div className="settings-sidebar-footer">
     <div className="settings-conn-summary">
      <span className={'settings-conn-dot '+(status?.authenticated?'is-online':'')} aria-hidden="true"/>
      <span>{status?.authenticated?'Codex 已连接':'等待连接'}</span>
     </div>
     <span className="settings-version sm-tabular">v{info?.version||'0.20.22'}</span>
    </div>
   </aside>

   <div className="settings-main">
    <header className="settings-main-header">
     <div className="settings-main-title">
      <h2>{meta.title}</h2>
      <p>{meta.subtitle}</p>
     </div>
     <button className="settings-close" type="button" aria-label="关闭设置" title="关闭设置 (Esc)" onClick={onClose}>
      <X size={18}/>
     </button>
    </header>

    <div className="settings-main-body" role="tabpanel" aria-label={meta.title}>
     {section==='materials'&&<SettingsMaterials
      courses={activeCourses}
      selectedCourseId={selectedCourseId}
      onSelectCourse={setSelectedCourseId}
      activeCourseId={activeCourseId}
      currentSourceId={currentSourceId}
      conversationBusy={conversationBusy}
      revision={revision}
      onChanged={onChanged}
      onOpenSource={onOpenSource}
      onSourcesDeleted={onSourcesDeleted}
      onSourceRenamed={onSourceRenamed}
     />}

     {section==='courses'&&<SettingsCourses
      courses={courses}
      activeCourseId={activeCourseId}
      conversationBusy={conversationBusy}
      loading={loading}
      loadError={loadError}
      onCreate={onCreate}
      onArchive={onArchive}
      onOpen={onOpen}
      onManageMaterials={id=>{setSelectedCourseId(id);setSection('materials')}}
      onChanged={onChanged}
     />}

     {section==='daily'&&<div className="sd-root">
      <div className="sm-course-strip" role="tablist" aria-label="选择课程查看日常管理">
       {activeCourses.map(course=>{
        const selected=course.id===selectedCourseId
        return <button
         key={course.id}
         type="button"
         role="tab"
         aria-selected={selected}
         className={'sm-course-pill'+(selected?' is-active':'')}
         onClick={()=>setSelectedCourseId(course.id)}
        >
         <CourseAvatar courseId={course.id} size={18} interactive={false}/>
         <span>{course.name}</span>
         {course.id===activeCourseId&&<em className="sm-pill-dot" title="当前所在课程"/>}
        </button>
       })}
      </div>
      <div className="sd-panel">
       <DailyCourseManagement
        courseId={selectedCourseId}
        revision={revision}
        disabled={conversationBusy&&selectedCourseId===activeCourseId}
        onChanged={()=>onChanged?.(selectedCourseId)}
        onOpenSource={onOpenSource?(id,page)=>void onOpenSource(selectedCourseId,id,page):undefined}
        onOpenConversation={onOpenConversation?source=>void onOpenConversation(selectedCourseId,source):undefined}
       />
      </div>
     </div>}

     {section==='general'&&<SettingsGeneral
      preset={preset}
      onPresetChange={onPresetChange}
      presetConfigs={presetConfigs}
      onSavePresetConfigs={onSavePresetConfigs}
      onResetPresetConfigs={onResetPresetConfigs}
      catalogModels={catalogModels}
      onRefreshModels={onRefreshModels}
      status={status}
      leftOpen={leftOpen}
      onToggleLeftOpen={onToggleLeftOpen}
      onResetLayout={onResetLayout}
      courses={activeCourses}
      info={info}
      conversationBusy={conversationBusy}
     />}
    </div>
   </div>
  </div>
 </div>
}
