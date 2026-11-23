import { createChemistryRenderQueue } from '../shared/chemistry-render-queue.mjs'
import { tCurrent } from './i18n'

export type ChemistryRequestKind = 'molecule' | 'reaction' | 'mechanism' | 'equation' | 'formula'
export type FigureResult = {
  status: string
  svg?: string
  warnings?: string[]
  validation?: unknown
  trace?: unknown
  error?: string
}

export const chemistryRenderQueue = createChemistryRenderQueue<FigureResult>(async (kind: string, source: string) => {
  const input = ['molecule', 'reaction', 'mechanism'].includes(kind) && source.trim().startsWith('{')
    ? JSON.parse(source)
    : source
  const res = await fetch('/api/chem/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, source: input }),
  })
  const result = await res.json()
  if (!res.ok) throw new Error(result.error || result.warnings?.[0] || tCurrent('md.renderRequestFailed'))
  return result
})
