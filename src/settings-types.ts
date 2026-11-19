import type {ThinkingPresetConfigs} from '../shared/model-presets.mjs'

export type CatalogEffort={
 reasoningEffort:string
 description?:string
}

export type CatalogModel={
 id:string
 model:string
 displayName?:string
 description?:string
 isDefault?:boolean
 supportedReasoningEfforts:CatalogEffort[]
 defaultReasoningEffort:string|null
}

export type CourseStats={
 coursewareCount:number
 materialCount:number
 fileCount:number
 totalBytes:number
 workspacePath:string
}

export type ManagedCourse={
 id:string
 name:string
 archivedAt?:string
 workspaceError?:string
 stats?:CourseStats
}

export type ManagedSource={
 id:string
 name:string
 originalName?:string
 relativePath:string
 path?:string
 folder:string
 category:string
 kind:'courseware'|'material'
 mime?:string
 attachmentId?:string|null
 url?:string
 size?:number
 modifiedAt?:string|null
 uploadedAt?:string|null
 selected?:boolean
}

export type ManagedFolder={
 path:string
 name:string
 kind:'courseware'|'material'
}

export type SettingsInfo={
 version:string
 workspaceRoot:string
 maxMaterialBytes:number
 maxMaterialLabel:string
 presets?:ThinkingPresetConfigs
 defaultPresets?:ThinkingPresetConfigs
}

export function formatBytes(size?:number):string{
 if(typeof size!=='number'||!Number.isFinite(size)||size<0)return '—'
 if(size<1024)return size+' B'
 if(size<1024*1024)return (size/1024).toFixed(size<10*1024?1:0)+' KB'
 if(size<1024*1024*1024)return (size/1024/1024).toFixed(1)+' MB'
 return (size/1024/1024/1024).toFixed(2)+' GB'
}

export function formatShortDate(iso?:string|null):string{
 if(!iso)return ''
 const ms=Date.parse(iso)
 if(!Number.isFinite(ms))return ''
 const date=new Date(ms),now=new Date()
 const sameYear=date.getFullYear()===now.getFullYear()
 try{
  return new Intl.DateTimeFormat('zh-CN',sameYear?{month:'short',day:'numeric'}:{year:'numeric',month:'short',day:'numeric'}).format(date)
 }catch{
  return iso.slice(0,10)
 }
}
