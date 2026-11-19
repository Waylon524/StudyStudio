import {useState} from 'react'
import {AlertCircle,Check,Copy,HardDrive,RefreshCw,RotateCcw,Sparkles,X} from 'lucide-react'
import {
 DEFAULT_PRESET_CONFIGS,THINKING_PRESETS,effortLabel,thinkingPreset,
 type ThinkingPreset,type ThinkingPresetConfigs,type ThinkingPresetOverride
} from '../shared/model-presets.mjs'
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

const PRESET_META:Record<ThinkingPreset,{title:string;subtitle:string;desc:string}>={
 fast:{title:'Fast',subtitle:'快速响应',desc:'适合概念查询、日常问答与快速核对细节。'},
 default:{title:'Default',subtitle:'均衡深入',desc:'日常课程辅导与习题讲解的默认档位。'},
 deep:{title:'Deep',subtitle:'深度推理',desc:'适合复杂推导、机理分析与综合专题复习。'}
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
 const [copiedPath,setCopiedPath]=useState(false)
 const [layoutResetDone,setLayoutResetDone]=useState(false)
 const [savingPreset,setSavingPreset]=useState(false)
 const [savedNotice,setSavedNotice]=useState('')
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

 async function updateSlot(id:ThinkingPreset,nextModel:string,nextEffort:string|null){
  setSavingPreset(true);setPresetError('')
  try{
   const payload:ThinkingPresetOverride={}
   for(const key of THINKING_PRESETS){
    const current=thinkingPreset(key,presetConfigs)
    payload[key]=key===id?{model:nextModel,effort:nextEffort}:{model:current.model,effort:current.effort}
   }
   await onSavePresetConfigs(payload)
   flashSaved(`已更新 ${PRESET_META[id].title} 配置`)
  }catch(err:any){
   setPresetError(err.message||'模型配置未能保存，请重试。')
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
   flashSaved('已恢复默认模型配置')
  }catch(err:any){
   setPresetError(err.message||'恢复默认失败，请重试。')
  }finally{
   setSavingPreset(false)
  }
 }

 async function handleRefreshModels(){
  setRefreshingModels(true);setPresetError('')
  try{
   await onRefreshModels()
   flashSaved('已同步 Codex 模型列表')
  }catch(err:any){
   setPresetError(err.message||'刷新模型目录失败。')
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
  <section className="sg-section" aria-labelledby="sg-preset-title">
   <div className="sg-section-head-row">
    <div className="sg-section-head">
     <h3 id="sg-preset-title">思考强度与模型配置</h3>
     <p>选择当前档位，并为 Fast、Default、Deep 分别配置 Codex 提供的模型与思考强度。</p>
    </div>
    <div className="sg-section-actions">
     {savedNotice&&<span className="sg-saved-pill" role="status"><Check size={12}/>{savedNotice}</span>}
     <button type="button" className="settings-btn-secondary-xs" disabled={refreshingModels||savingPreset} onClick={()=>void handleRefreshModels()}>
      <RefreshCw size={12} className={refreshingModels?'sg-spin':''}/>刷新模型
     </button>
     {isCustomized&&<button type="button" className="settings-btn-ghost-xs" disabled={savingPreset||conversationBusy} onClick={()=>void handleResetPresets()}>
      <RotateCcw size={12}/>恢复默认
     </button>}
    </div>
   </div>

   {presetError&&<div className="settings-alert is-error" role="alert"><AlertCircle size={14}/><span>{presetError}</span><button type="button" aria-label="关闭错误" onClick={()=>setPresetError('')}><X size={13}/></button></div>}

   <div className="sg-preset-list" role="radiogroup" aria-label="思考强度档位配置">
    {THINKING_PRESETS.map(id=>{
     const slot=thinkingPreset(id,presetConfigs)
     const meta=PRESET_META[id]
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
         <span className="sg-preset-name">{meta.title}</span>
         <span className="sg-preset-sub">{meta.subtitle}</span>
         {selected&&<span className="sg-active-tag">当前</span>}
         {!available&&<span className="sg-warn-tag">不可用</span>}
        </div>
        <p className="sg-preset-desc">{meta.desc}</p>
       </div>
      </button>

      <div className="sg-preset-controls">
       <label className="sg-field">
        <span>模型</span>
        <select
         aria-label={`${meta.title} 档位模型`}
         value={slot.model}
         disabled={!canEdit}
         onChange={event=>handleModelChange(id,event.target.value)}
        >
         {!matchedModel&&<option value={slot.model}>{slot.model}{catalogModels.length?'（当前账号不可用）':''}</option>}
         {catalogModels.map(m=><option key={m.model} value={m.model}>{modelOptionLabel(m)}</option>)}
        </select>
       </label>

       <label className="sg-field is-effort">
        <span>思考强度</span>
        <select
         aria-label={`${meta.title} 档位思考强度`}
         value={slot.effort??''}
         disabled={!canEdit||!matchedModel||effortOptions.length===0}
         onChange={event=>void updateSlot(id,slot.model,event.target.value||null)}
        >
         {!matchedModel?<option value={slot.effort??''}>{effortLabel(slot.effort)}</option>
          :effortOptions.length===0?<option value="">默认（无分级）</option>
          :<>
           {effortMissing&&<option value={slot.effort??''}>{effortLabel(slot.effort)}（不支持）</option>}
           {effortOptions.map(opt=><option key={opt.reasoningEffort} value={opt.reasoningEffort}>{effortLabel(opt.reasoningEffort)}</option>)}
          </>}
        </select>
       </label>
      </div>
     </div>
    })}
   </div>
   {!catalogModels.length&&<p className="sg-catalog-hint">正在等待 Codex 返回可用模型列表；连接就绪后即可自由调整每个档位的模型与思考强度。</p>}
  </section>

  <section className="sg-section" aria-labelledby="sg-layout-title">
   <div className="sg-section-head">
    <h3 id="sg-layout-title">工作区界面</h3>
    <p>调整侧边栏显示与分栏默认尺寸。</p>
   </div>
   <div className="sg-card-list">
    <div className="sg-row">
     <div className="sg-row-info">
      <strong>显示左侧课程资料栏</strong>
      <span>展开后可随时浏览课件、资料、日程与练习记录。</span>
     </div>
     <button
      type="button"
      role="switch"
      aria-checked={leftOpen}
      aria-label="显示左侧课程资料栏"
      className={'sg-switch'+(leftOpen?' is-on':'')}
      onClick={onToggleLeftOpen}
     >
      <span className="sg-switch-thumb"/>
     </button>
    </div>

    <div className="sg-row">
     <div className="sg-row-info">
      <strong>分栏宽度</strong>
      <span>恢复左侧资料栏（280px）与右侧 PDF 阅读器（600px）的默认比例。</span>
     </div>
     <button type="button" className="settings-btn-secondary-xs" onClick={handleResetLayout}>
      {layoutResetDone?<><Check size={12}/>已恢复默认</>:<><RotateCcw size={12}/>重置宽度</>}
     </button>
    </div>
   </div>
  </section>

  <section className="sg-section" aria-labelledby="sg-storage-title">
   <div className="sg-section-head">
    <h3 id="sg-storage-title">本地服务与存储</h3>
    <p>所有课程文件、PDF 批注与学习记录均保存在你的本机磁盘中。</p>
   </div>
   <div className="sg-card-list">
    <div className="sg-row">
     <div className="sg-row-info">
      <strong>Codex 连接状态</strong>
      <span>{status?.authenticated?`已通过本机 Codex 登录，已发现 ${catalogModels.length} 个可用模型`:status?.connected?'已连接到 Codex，等待登录授权':'正在连接本机 Codex 服务…'}</span>
     </div>
     <span className={'sg-status-pill '+(status?.authenticated?'is-online':'is-offline')}>
      <i aria-hidden="true"/>{status?.authenticated?'已连接':'未就绪'}
     </span>
    </div>

    <div className="sg-row">
     <div className="sg-row-info">
      <strong>课程文件根目录</strong>
      <span className="sg-mono">{info?.workspaceRoot||'~/Documents/StudyStudio'}</span>
     </div>
     {info?.workspaceRoot&&<button type="button" className="settings-btn-secondary-xs" onClick={()=>void copyWorkspacePath()}>
      {copiedPath?<><Check size={12}/>已复制</>:<><Copy size={12}/>复制路径</>}
     </button>}
    </div>

    <div className="sg-row">
     <div className="sg-row-info">
      <strong>已上传资料总览</strong>
      <span className="sm-tabular">共 {totalStats.courseware} 份课件、{totalStats.materials} 份资料，合计占用 {formatBytes(totalStats.bytes)}（单文件上限 {info?.maxMaterialLabel||'100 MB'}）</span>
     </div>
     <HardDrive size={16} className="sg-row-icon"/>
    </div>

    <div className="sg-row">
     <div className="sg-row-info">
      <strong>应用版本</strong>
      <span>Study Studio · 本地优先 AI 学习工作区</span>
     </div>
     <span className="sg-version-chip"><Sparkles size={11}/>v{info?.version||'0.20.22'}</span>
    </div>
   </div>
  </section>
 </div>
}
