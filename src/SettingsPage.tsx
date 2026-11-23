import {useEffect,useMemo,useRef,useState} from 'react'
import {BookOpen,CalendarClock,FolderOpen,GraduationCap,SlidersHorizontal,X} from 'lucide-react'
import type {ThinkingPreset,ThinkingPresetConfigs,ThinkingPresetOverride} from '../shared/model-presets.mjs'
import {CourseAvatar} from './CourseAvatar'
import {DailyCourseManagement,type RequirementSource} from './CourseRequirements'
import {useI18n} from './i18n'
import {SettingsCourses} from './SettingsCourses'
import {SettingsGeneral} from './SettingsGeneral'
import {SettingsMaterials} from './SettingsMaterials'
import {SettingsPractice} from './SettingsPractice'
import type {CatalogModel,ManagedCourse,ManagedSource,SettingsInfo} from './settings-types'
import './settings.css'

export type {CatalogModel,ManagedCourse,ManagedSource}
export type SettingsSection='materials'|'practice'|'courses'|'daily'|'general'

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

export function SettingsPage({
 courses,activeCourseId,currentSourceId,conversationBusy,loading=false,loadError='',
 initialSection='materials',preset,onPresetChange,presetConfigs,onSavePresetConfigs,onResetPresetConfigs,
 catalogModels,onRefreshModels,status,leftOpen,onToggleLeftOpen,onResetLayout,
 onCreate,onArchive,onOpen,onClose,onChanged,onOpenSource,onOpenConversation,onSourcesDeleted,onSourceRenamed,revision
}:Props){
 const {t,collator,courseDisplayName}=useI18n()
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
   return collator.compare(courseDisplayName(a),courseDisplayName(b))
  })
 },[courses,activeCourseId,collator,courseDisplayName])

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
 const totalActiveQuestions=useMemo(()=>activeCourses.reduce((sum,course)=>sum+(course.stats?.questionCount||0),0),[activeCourses])
 const hasStats=useMemo(()=>activeCourses.some(course=>Boolean(course.stats)),[activeCourses])

 const navItems:Array<{id:SettingsSection;icon:typeof FolderOpen;badge?:number}>=[
  {id:'materials',icon:FolderOpen,badge:hasStats?totalActiveFiles:undefined},
  {id:'practice',icon:GraduationCap,badge:hasStats?totalActiveQuestions:undefined},
  {id:'courses',icon:BookOpen,badge:activeCourses.length||undefined},
  {id:'daily',icon:CalendarClock},
  {id:'general',icon:SlidersHorizontal}
 ]

 const sectionMeta={
  materials:{navLabel:t('settings.section.materials.nav'),title:t('settings.section.materials.title'),subtitle:t('settings.section.materials.subtitle')},
  practice:{navLabel:t('settings.section.practice.nav'),title:t('settings.section.practice.title'),subtitle:t('settings.section.practice.subtitle')},
  courses:{navLabel:t('settings.section.courses.nav'),title:t('settings.section.courses.title'),subtitle:t('settings.section.courses.subtitle')},
  daily:{navLabel:t('settings.section.daily.nav'),title:t('settings.section.daily.title'),subtitle:t('settings.section.daily.subtitle')},
  general:{navLabel:t('settings.section.general.nav'),title:t('settings.section.general.title'),subtitle:t('settings.section.general.subtitle')}
 }
 const meta=sectionMeta[section]

 return <div className="settings-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}>
  <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="study-settings-title" className="settings-page">
   <aside className="settings-sidebar" aria-label={t('settings.navAria')}>
    <div className="settings-brand">
     <h1 id="study-settings-title">{t('settings.title')}</h1>
     <p>{t('settings.subtitle')}</p>
    </div>

    <nav className="settings-nav" role="tablist" aria-label={t('settings.tabsAria')}>
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
       <span>{sectionMeta[item.id].navLabel}</span>
       {typeof item.badge==='number'&&<small className="sm-tabular">{item.badge}</small>}
      </button>
     })}
    </nav>

    <div className="settings-sidebar-footer">
     <div className="settings-conn-summary">
      <span className={'settings-conn-dot '+(status?.authenticated?'is-online':'')} aria-hidden="true"/>
      <span>{status?.authenticated?t('app.codexConnected'):t('app.codexWaiting')}</span>
     </div>
     <span className="settings-version sm-tabular">v{info?.version||'0.21.0'}</span>
    </div>
   </aside>

   <div className="settings-main">
    <header className="settings-main-header">
     <div className="settings-main-title">
      <h2>{meta.title}</h2>
      <p>{meta.subtitle}</p>
     </div>
     <button className="settings-close" type="button" aria-label={t('settings.close')} title={t('settings.closeTitle')} onClick={onClose}>
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

     {section==='practice'&&<SettingsPractice
      courses={activeCourses}
      selectedCourseId={selectedCourseId}
      onSelectCourse={setSelectedCourseId}
      activeCourseId={activeCourseId}
      revision={revision}
      onChanged={onChanged}
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
      <div className="sm-course-strip" role="tablist" aria-label={t('settings.selectCourseForDaily')}>
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
         <span>{courseDisplayName(course)}</span>
         {course.id===activeCourseId&&<em className="sm-pill-dot" title={t('settings.currentCourseDot')}/>}
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
