export const QUESTION_TYPES: readonly ['true_false', 'choice', 'fill_blank', 'short_answer', 'flashcard']
export const MAX_CATEGORY_LABEL_LENGTH: number

export function normalizeCategoryText(value: unknown): string
export function checkedCategory(
  input?: { unit?: unknown; knowledgePoint?: unknown },
  options?: { requireAny?: boolean }
): { unit: string; knowledgePoint: string }
export function categoryKey(unit?: string, knowledgePoint?: string): string
export function validateStudySpec<T>(spec: T): T
export function gradeAnswer(
  q: Record<string, unknown>,
  answer: unknown
): { status: 'graded' | 'pending_feedback' | 'self_assessed' | 'invalid'; correct?: boolean | null }
