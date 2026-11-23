import './thinking-indicator.css'
import type {ThinkingPreset} from './EffortSlider'
import {useI18n} from './i18n'

type Props = {courseId:string;preset:ThinkingPreset;status?:string}

export function ThinkingIndicator({courseId,preset,status}:Props){
  const {t}=useI18n()
  const reconnecting = status==='reconnecting'
  return <div className="agent-thinking" data-preset={preset} role="status" aria-live="polite" aria-atomic="true">
    <span className="thinking-motion" key={courseId} aria-hidden="true"><span className="thinking-orbit outer"/><span className="thinking-orbit inner"/><span className="thinking-core"/></span>
    <span className="thinking-label">{reconnecting?t('progress.connectingShort'):t('progress.thinkingShort')}<span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span></span>
  </div>
}
