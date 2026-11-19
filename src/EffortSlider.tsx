import {THINKING_PRESETS,thinkingPreset,type ThinkingPreset,type ThinkingPresetConfigs} from '../shared/model-presets.mjs'
import './effort-slider.css'
export type {ThinkingPreset} from '../shared/model-presets.mjs'

type Props={value:ThinkingPreset;configs?:ThinkingPresetConfigs;onChange:(value:ThinkingPreset)=>void;disabled?:boolean}
export function EffortToggle({value,configs,onChange,disabled=false}:Props){
  const index=Math.max(0,THINKING_PRESETS.indexOf(value)),next=THINKING_PRESETS[(index+1)%THINKING_PRESETS.length]
  const current=thinkingPreset(value,configs),nextSlot=thinkingPreset(next,configs)
  const detail=current.effort?`${current.model} · ${current.effort}`:current.model
  return <button type="button" className="effort-toggle" data-preset={value} data-effort={current.effort||''}
    aria-label={'思考强度：'+current.label} title={`当前：${current.label}（${detail}）· 点击切换到 ${nextSlot.label}`}
    disabled={disabled} onClick={()=>onChange(next)}>{current.label}</button>
}
