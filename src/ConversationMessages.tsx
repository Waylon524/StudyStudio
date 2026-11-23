import {memo,useMemo,type ReactNode} from 'react'
import {FileText} from 'lucide-react'
import {Markdown} from './Markdown'
import {StudyProvider} from './StudyComponents'
import {CourseAvatar} from './CourseAvatar'
import {useI18n} from './i18n'
import type {CanvasSpec,OpenCanvasMeta} from './study-types'

export type MessageAttachment={id:string;name:string;mime:string;url?:string;warning?:string}
export type ConversationMessage={id:string;role:'user'|'assistant';text:string;attachments?:MessageAttachment[];streaming?:boolean;incomplete?:boolean}
type Props={
  messages:ConversationMessage[]
  courseId:string
  threadId:string|null
  revision:number
  onLearningChange:()=>void
  onAskAgent:(text:string)=>void
  onOpenSource:(id:string,page?:number)=>void
  onOpenAttachment:(attachment:MessageAttachment)=>void
  onOpenCanvas?:(canvas:CanvasSpec,meta?:OpenCanvasMeta)=>void
  renderMarkdown:(text:string)=>ReactNode
}
type MessageProps=Omit<Props,'messages'>&{message:ConversationMessage}

// Existing message objects are retained when the live tail changes. Neither
// typing nor reader updates need to revisit the saved conversation subtree.
const Message=memo(function Message({message,courseId,threadId,revision,onLearningChange,onAskAgent,onOpenSource,onOpenAttachment,onOpenCanvas,renderMarkdown}:MessageProps){
  const {t}=useI18n()
  const context=useMemo(()=>({courseId,threadId:threadId||undefined,itemId:message.id,revision,onLearningChange,onAskAgent,onOpenCanvas,renderMarkdown}),[courseId,threadId,message.id,revision,onLearningChange,onAskAgent,onOpenCanvas,renderMarkdown])
  return <article className={'message '+message.role+(message.streaming?' is-streaming':'')} aria-busy={message.streaming||undefined} data-message-id={message.id}>{message.role==='user'?<div className="user-bubble">{message.text}{!!message.attachments?.length&&<div className="message-attachments">{message.attachments.map(attachment=><button key={attachment.id} type="button" aria-label={t('composer.viewAttachment',{name:attachment.name})} onClick={()=>onOpenAttachment(attachment)}>{attachment.mime?.startsWith('image/')?<img src={attachment.url||'/api/courses/'+encodeURIComponent(courseId)+'/attachments/'+encodeURIComponent(attachment.id)} alt={attachment.name}/>:<FileText size={18}/>}<span>{attachment.name}</span></button>)}</div>}</div>:<><div className="assistant-avatar"><CourseAvatar courseId={courseId} size={29}/></div><StudyProvider value={context}><Markdown text={message.text} streaming={message.streaming} incomplete={message.incomplete} allowStudy={!message.incomplete} onOpenSource={onOpenSource}/></StudyProvider>{message.incomplete&&<span className="answer-incomplete">{t('app.replyIncomplete')}</span>}</>}</article>
})

export const ConversationMessages=memo(function ConversationMessages({messages,...context}:Props){
  return <>{messages.map(message=><Message key={message.id} message={message} {...context}/>)}</>
})
