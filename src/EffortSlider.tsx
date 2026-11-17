import './effort-slider.css'

export type ReasoningEffort = 'medium'|'high'|'xhigh'
type Props = {
  value:ReasoningEffort
  onChange:(value:ReasoningEffort)=>void
  disabled?:boolean
}
const levels:ReasoningEffort[] = ['medium','high','xhigh']
const labels = ['Fast','Default','Deep']

export function EffortToggle({value,onChange,disabled=false}:Props){
  const index = Math.max(0,levels.indexOf(value))
  return <button type="button" className="effort-toggle" data-effort={value}
    aria-label={'思考强度：'+labels[index]} title={'切换到 '+labels[(index+1)%levels.length]}
    disabled={disabled} onClick={()=>onChange(levels[(index+1)%levels.length])}>
    {labels[index]}
  </button>
}
