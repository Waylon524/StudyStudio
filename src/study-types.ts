import type { ReactNode } from 'react'

export type StudyType = 'true_false' | 'choice' | 'fill_blank' | 'short_answer' | 'flashcard'
export type StudyAnswer = boolean | string | string[]
export type StudyAnswerImage = { id:string; name:string; mime:string; size:number; url:string; width?:number; height?:number }
export type StudyAttempt = {
  id: string
  questionId: string
  answer: StudyAnswer
  images?: StudyAnswerImage[]
  hintUsed?: boolean
  revealed?: boolean
  createdAt: string
  grade: { status: 'graded' | 'pending_feedback' | 'self_assessed'; correct: boolean | null }
  feedback?: string | { feedback?: string; text?: string; correct?: boolean; score?: number; createdAt?: string } | null
}
export type StudyQuestion = {
  id?: string
  sourceId?: string
  setId?: string
  threadId?: string
  itemId?: string
  type: StudyType
  prompt: string
  options?: { id: string; text: string }[]
  multiple?: boolean
  answer?: StudyAnswer
  acceptedAnswers?: string[]
  explanation?: string
  tags?: string[]
  rubric?: string
  attempts?: StudyAttempt[]
  latestAttempt?: StudyAttempt | null
  reveals?: unknown[]
}
export type CanvasSpec = {id:string;title:string;html:string;height?:number}
export type SavedCanvas = CanvasSpec & {sourceId:string;threadId:string;itemId:string;savedAt:string;lastOpenedAt?:string;lastReport?:{label:string;value?:string;createdAt:string;source:'animation_report'}}
export type UIBlock = {type: string; id?:string; html?:string; height?:number; title?: string; text?: string; content?: string; tone?: string; columns?: string[]; rows?: string[][]; items?: {title?:string;text?:string}[]; tabs?: {label:string;blocks:UIBlock[]}[]; blocks?: UIBlock[]; labels?: string[]; values?: number[]; kind?: string; question?: StudyQuestion}
export type StudySpec = { id?: string; title?: string; items: StudyQuestion[]; blocks?: UIBlock[] }
export type LearningData = {
  items: StudyQuestion[]
  attempts: StudyAttempt[]
  canvases?: SavedCanvas[]
  workspacePath?: string
  importantInfo?: string
  progress?: string | Record<string, unknown>
}
export type StudyContextValue = {
  courseId?: string
  threadId?: string | null
  itemId?: string
  revision?: number
  onLearningChange?: () => void
  onAskAgent?: (text: string) => void
  renderMarkdown?: (text: string) => ReactNode
}
