import {useState} from 'react'
import {AlertCircle,Check,Copy,Globe,HardDrive,RefreshCw,RotateCcw,Sparkles,X} from 'lucide-react'
import {
 DEFAULT_PRESET_CONFIGS,THINKING_PRESETS,effortLabel,thinkingPreset,
 type ThinkingPreset,type ThinkingPresetConfigs,type ThinkingPresetOverride
} from '../shared/model-presets.mjs'
import {LOCALE_META,SUPPORTED_LOCALES,useI18n,type Locale} from './i18n'
import {formatBytes,type CatalogModel,type ManagedCourse,type SettingsInfo} from './settings-types'

type Props={
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
 courses:ManagedCourse[]
 info:SettingsInfo|null
 conversationBusy:boolean
}

const PRESET_TITLES:Record<ThinkingPreset,string>={
 fast:'Fast',
 default:'Default',
 deep:'Deep'
}

function modelOptionLabel(model:CatalogModel){
 if(!model.displayName||model.displayName===model.model)return model.model
 return `${model.displayName} (${model.model})`
}

function isSlotAvailable(catalogModels:CatalogModel[],modelId:string,effort:string|null){
 if(!catalogModels.length)return true
 const found=catalogModels.find(m=>m.model===modelId||m.id===modelId)
 if(!found)return false
 const efforts=found.supportedReasoningEfforts.map(e=>e.reasoningEffort)
 if(!efforts.length)return !effort
 return Boolean(effort&&efforts.includes(effort))
}

export function SettingsGeneral({
 preset,onPresetChange,presetConfigs,onSavePresetConfigs,onResetPresetConfigs,
 catalogModels,onRefreshModels,status,leftOpen,onToggleLeftOpen,onResetLayout,courses,info,conversationBusy
}:Props){
 const {locale,setLocale,t}=useI18n()
 const [copiedPath,setCopiedPath]=useState(false)
 const [layoutResetDone,setLayoutResetDone]=useState(false)
 const [savingPreset,setSavingPreset]=useState(false)
 const [savedNotice,setSavedNotice]=useState('')
 const [savedLocale,setSavedLocale]=useState<Locale|null>(null)
 const [presetError,setPresetError]=useState('')
 const [refreshingModels,setRefreshingModels]=useState(false)

 const isCustomized=THINKING_PRESETS.some(id=>{
  const cur=thinkingPreset(id,presetConfigs),def=DEFAULT_PRESET_CONFIGS[id]
  return cur.model!==def.model||cur.effort!==def.effort
 })

 const totalStats=courses.reduce((acc,course)=>{
  if(course.stats){
   acc.courseware+=course.stats.coursewareCount
   acc.materials+=course.stats.materialCount
   acc.bytes+=course.stats.totalBytes
  }
  return acc
 },{courseware:0,materials:0,bytes:0})

 function flashSaved(message:string){
  setSavedNotice(message)
  setTimeout(()=>setSavedNotice(prev=>prev===message?'':prev),2000)
 }

 function handleLocaleChange(next:Locale){
  if(next===locale)return
  setLocale(next)
  setSavedLocale(next)
  setTimeout(()=>setSavedLocale(prev=>prev===next?null:prev),2200)
 }

 async function updateSlot(id:ThinkingPreset,nextModel:string,nextEffort:string|null){
  setSavingPreset(true);setPresetError('')
  try{
   const payload:ThinkingPresetOverride={}
   for(const key of THINKING_PRESETS){
    const current=thinkingPreset(key,presetConfigs)
    payload[key]=key===id?{model:nextModel,effort:nextEffort}:{model:current.model,effort:current.effort}
   }
   await onSavePresetConfigs(payload)
   flashSaved(t('sg.presetUpdated',{preset:PRESET_TITLES[id]}))
  }catch(err:any){
   setPresetError(err.message||t('sg.presetSaveFailed'))
  }finally{
   setSavingPreset(false)
  }
 }

 function handleModelChange(id:ThinkingPreset,nextModelId:string){
  const current=thinkingPreset(id,presetConfigs)
  const target=catalogModels.find(m=>m.model===nextModelId||m.id===nextModelId)
  const efforts=target?.supportedReasoningEfforts.map(e=>e.reasoningEffort)||[]
  let nextEffort:string|null=current.effort
  if(!efforts.length){
   nextEffort=null
  }else if(!nextEffort||!efforts.includes(nextEffort)){
   nextEffort=target?.defaultReasoningEffort&&efforts.includes(target.defaultReasoningEffort)
    ?target.defaultReasoningEffort
    :efforts[0]
  }
  void updateSlot(id,nextModelId,nextEffort)
 }

 async function handleResetPresets(){
  setSavingPreset(true);setPresetError('')
  try{
   await onResetPresetConfigs()
   flashSaved(t('sg.presetResetDone'))
  }catch(err:any){
   setPresetError(err.message||t('sg.presetResetFailed'))
  }finally{
   setSavingPreset(false)
  }
 }

 async function handleRefreshModels(){
  setRefreshingModels(true);setPresetError('')
  try{
   await onRefreshModels()
   flashSaved(t('sg.modelsSynced'))
  }catch(err:any){
   setPresetError(err.message||t('sg.modelsSyncFailed'))
  }finally{
   setRefreshingModels(false)
  }
 }

 async function copyWorkspacePath(){
  if(!info?.workspaceRoot)return
  try{
   await navigator.clipboard.writeText(info.workspaceRoot)
   setCopiedPath(true)
   setTimeout(()=>setCopiedPath(false),1800)
  }catch{}
 }

 function handleResetLayout(){
  onResetLayout()
  setLayoutResetDone(true)
  setTimeout(()=>setLayoutResetDone(false),1800)
 }

 return <div className="sg-root">
  <section className="sg-section" aria-labelledby="sg-lang-title">
   <div className="sg-section-head-row">
    <div className="sg-section-head">
     <h3 id="sg-lang-title">{t('sg.langTitle')}</h3>
     <p>{t('sg.langDesc')}</p>
    </div>
    {savedLocale&&<span className="sg-saved-pill" role="status"><Check size={12}/>{t('sg.langSaved',{lang:LOCALE_META[savedLocale].nativeLabel})}</span>}
   </div>
   <div className="sg-card-list">
    <div className="sg-row">
     <div className="sg-row-info">
      <strong>{t('sg.langLabel')}</strong>
      <span>{t('sg.langHint')}</span>
     </div>
     <div className="sg-lang-pills" role="radiogroup" aria-label={t('sg.langLabel')}>
      {SUPPORTED_LOCALES.map(code=>{
       const active=locale===code
       return <button
        key={code}
        type="button"
        role="radio"
        aria-checked={active}
        className={'sg-lang-btn'+(active?' is-active':'')}
        onClick={()=>handleLocaleChange(code)}
       >
        <Globe size={13}/>
        <span>{LOCALE_META[code].nativeLabel}</span>
       </button>
      })}
     </div>
    </div>
   </div>
  </section>

  <section className="sg-section" aria-labelledby="sg-preset-title">
   <div className="sg-section-head-row">
    <div className="sg-section-head">
     <h3 id="sg-preset-title">{t('sg.presetTitle')}</h3>
     <p>{t('sg.presetDesc')}</p>
    </div>
    <div className="sg-section-actions">
     {savedNotice&&<span className="sg-saved-pill" role="status"><Check size={12}/>{savedNotice}</span>}
     <button type="button" className="settings-btn-secondary-xs" disabled={refreshingModels||savingPreset} onClick={()=>void handleRefreshModels()}>
      <RefreshCw size={12} className={refreshingModels?'sg-spin':''}/>{t('sg.refreshModels')}
     </button>
     {isCustomized&&<button type="button" className="settings-btn-ghost-xs" disabled={savingPreset||conversationBusy} onClick={()=>void handleResetPresets()}>
      <RotateCcw size={12}/>{t('sg.resetDefault')}
     </button>}
    </div>
   </div>

   {presetError&&<div className="settings-alert is-error" role="alert"><AlertCircle size={14}/><span>{presetError}</span><button type="button" aria-label={t('app.closeError')} onClick={()=>setPresetError('')}><X size={13}/></button></div>}

   <div className="sg-preset-list" role="radiogroup" aria-label={t('sg.presetGroupAria')}>
    {THINKING_PRESETS.map(id=>{
     const slot=thinkingPreset(id,presetConfigs)
     const title=PRESET_TITLES[id]
     const subtitle=id==='fast'?t('effort.preset.fast.subtitle'):id==='deep'?t('effort.preset.deep.subtitle'):t('effort.preset.default.subtitle')
     const desc=id==='fast'?t('effort.preset.fast.desc'):id==='deep'?t('effort.preset.deep.desc'):t('effort.preset.default.desc')
     const selected=preset===id
     const matchedModel=catalogModels.find(m=>m.model===slot.model||m.id===slot.model)
     const available=isSlotAvailable(catalogModels,slot.model,slot.effort)
     const effortOptions=matchedModel?.supportedReasoningEfforts||[]
     const effortMissing=Boolean(matchedModel&&effortOptions.length>0&&slot.effort&&!effortOptions.some(e=>e.reasoningEffort===slot.effort))
     const canEdit=catalogModels.length>0&&!savingPreset&&!conversationBusy

     return <div key={id} className={'sg-preset-row'+(selected?' is-selected':'')+(!available?' is-unavailable':'')}>
      <button
       type="button"
       role="radio"
       aria-checked={selected}
       className="sg-preset-select"
       disabled={conversationBusy}
       onClick={()=>onPresetChange(id)}
      >
       <span className={'sg-radio-ring'+(selected?' is-checked':'')} aria-hidden="true"><i/></span>
       <div className="sg-preset-meta">
        <div className="sg-preset-heading">
         <span className="sg-preset-name">{title}</span>
         <span className="sg-preset-sub">{subtitle}</span>
         {selected&&<span className="sg-active-tag">{t('app.currentTag')}</span>}
         {!available&&<span className="sg-warn-tag">{t('app.unavailableTag')}</span>}
        </div>
        <p className="sg-preset-desc">{desc}</p>
       </div>
      </button>

      <div className="sg-preset-controls">
       <label className="sg-field">
        <span>{t('sg.modelLabel')}</span>
        <select
         aria-label={t('sg.modelAria',{preset:title})}
         value={slot.model}
         disabled={!canEdit}
         onChange={event=>handleModelChange(id,event.target.value)}
        >
         {!matchedModel&&<option value={slot.model}>{slot.model}{catalogModels.length?t('sg.modelUnavailableSuffix'):''}</option>}
         {catalogModels.map(m=><option key={m.model} value={m.model}>{modelOptionLabel(m)}</option>)}
        </select>
       </label>

       <label className="sg-field is-effort">
        <span>{t('sg.effortLabel')}</span>
        <select
         aria-label={t('sg.effortAria',{preset:title})}
         value={slot.effort??''}
         disabled={!canEdit||!matchedModel||effortOptions.length===0}
         onChange={event=>void updateSlot(id,slot.model,event.target.value||null)}
        >
         {!matchedModel?<option value={slot.effort??''}>{effortLabel(slot.effort,locale)}</option>
          :effortOptions.length===0?<option value="">{t('sg.effortNone')}</option>
          :<>
           {effortMissing&&<option value={slot.effort??''}>{effortLabel(slot.effort,locale)}{t('sg.effortUnsupportedSuffix')}</option>}
           {effortOptions.map(opt=><option key={opt.reasoningEffort} value={opt.reasoningEffort}>{effortLabel(opt.reasoningEffort,locale)}</option>)}
          </>}
        </select>
       </label>
      </div>
     </div>
    })}
   </div>
   {!catalogModels.length&&<p className="sg-catalog-hint">{t('sg.waitingCatalog')}</p>}
  </section>

  <section className="sg-section" aria-labelledby="sg-layout-title">
   <div className="sg-section-head">
    <h3 id="sg-layout-title">{t('sg.layoutTitle')}</h3>
    <p>{t('sg.layoutDesc')}</p>
   </div>
   <div className="sg-card-list">
    <div className="sg-row">
     <div className="sg-row-info">
      <strong>{t('sg.showLeftSidebar')}</strong>
      <span>{t('sg.showLeftSidebarDesc')}</span>
     </div>
     <button
      type="button"
      role="switch"
      aria-checked={leftOpen}
      aria-label={t('sg.showLeftSidebar')}
      className={'sg-switch'+(leftOpen?' is-on':'')}
      onClick={onToggleLeftOpen}
     >
      <span className="sg-switch-thumb"/>
     </button>
    </div>

    <div className="sg-row">
     <div className="sg-row-info">
      <strong>{t('sg.paneWidths')}</strong>
      <span>{t('sg.paneWidthsDesc')}</span>
     </div>
     <button type="button" className="settings-btn-secondary-xs" onClick={handleResetLayout}>
      {layoutResetDone?<><Check size={12}/>{t('sg.resetDone')}</>:<><RotateCcw size={12}/>{t('sg.resetWidths')}</>}
     </button>
    </div>
   </div>
  </section>

  <section className="sg-section" aria-labelledby="sg-storage-title">
   <div className="sg-section-head">
    <h3 id="sg-storage-title">{t('sg.storageTitle')}</h3>
    <p>{t('sg.storageDesc')}</p>
   </div>
   <div className="sg-card-list">
    <div className="sg-row">
     <div className="sg-row-info">
      <strong>{t('sg.codexStatus')}</strong>
      <span>{status?.authenticated?t('sg.codexAuthDesc',{count:catalogModels.length}):status?.connected?t('sg.codexWaitAuthDesc'):t('sg.codexConnectingDesc')}</span>
     </div>
     <span className={'sg-status-pill '+(status?.authenticated?'is-online':'is-offline')}>
      <i aria-hidden="true"/>{status?.authenticated?t('sg.statusOnline'):t('sg.statusOffline')}
     </span>
    </div>

    <div className="sg-row">
     <div className="sg-row-info">
      <strong>{t('sg.workspaceRoot')}</strong>
      <span className="sg-mono">{info?.workspaceRoot||'~/Documents/StudyStudio'}</span>
     </div>
     {info?.workspaceRoot&&<button type="button" className="settings-btn-secondary-xs" onClick={()=>void copyWorkspacePath()}>
      {copiedPath?<><Check size={12}/>{t('app.copied')}</>:<><Copy size={12}/>{t('sg.copyPath')}</>}
     </button>}
    </div>

    <div className="sg-row">
     <div className="sg-row-info">
      <strong>{t('sg.materialsOverview')}</strong>
      <span className="sm-tabular">{t('sg.materialsOverviewText',{courseware:totalStats.courseware,materials:totalStats.materials,bytes:formatBytes(totalStats.bytes),limit:info?.maxMaterialLabel||'100 MB'})}</span>
     </div>
     <HardDrive size={16} className="sg-row-icon"/>
    </div>

    <div className="sg-row">
     <div className="sg-row-info">
      <strong>{t('sg.appVersion')}</strong>
      <span>{t('app.tagline')}</span>
     </div>
     <span className="sg-version-chip"><Sparkles size={11}/>v{info?.version||'0.21.0'}</span>
    </div>
   </div>
  </section>
 </div>
}
