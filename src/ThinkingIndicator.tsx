import './thinking-indicator.css'
import type {ReasoningEffort} from './EffortSlider'

type Props = {courseId:string;effort:ReasoningEffort;status?:string}

export function ThinkingIndicator({courseId,effort,status}:Props){
  const reconnecting = status==='reconnecting'
  return <div className="agent-thinking" data-effort={effort} role="status" aria-live="polite" aria-atomic="true">
    <span className="thinking-motion" key={courseId} aria-hidden="true"><span className="thinking-orbit outer"/><span className="thinking-orbit inner"/><span className="thinking-core"/></span>
    <span className="thinking-label">{reconnecting?'正在连接':'正在思考'}<span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span></span>
  </div>
}
