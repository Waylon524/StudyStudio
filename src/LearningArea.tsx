import React, { memo, useMemo, useState } from 'react'
import {
  AlignLeft,
  BookOpen,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock3,
  FolderOpen,
  Layers,
  ListChecks,
  PenLine,
  SlidersHorizontal,
  Sparkles,
  Tag,
  X,
} from 'lucide-react'
import {
  CanvasCard,
  QuestionCard,
  StudyProvider,
  latestFor,
  notifyStudyChanged,
  studyApi,
  useCourseLearning,
} from './StudyComponents'
import type { CanvasSpec, OpenCanvasMeta, SavedCanvas, StudyQuestion, StudyType } from './study-types'
import { useI18n } from './i18n'
import './study.css'

type Filter = 'all' | 'unanswered' | 'pending' | 'answered' | 'canvas'

const TYPE_ORDER: StudyType[] = ['choice', 'true_false', 'fill_blank', 'short_answer', 'flashcard']

function typeIcon(type: StudyType) {
  switch (type) {
    case 'choice':
      return <ListChecks size={14} />
    case 'true_false':
      return <CheckSquare size={14} />
    case 'fill_blank':
      return <PenLine size={14} />
    case 'short_answer':
      return <AlignLeft size={14} />
    case 'flashcard':
      return <Layers size={14} />
    default:
      return <BookOpen size={14} />
  }
}

type KpGroup = {
  key: string
  knowledgePoint: string
  items: StudyQuestion[]
}

type UnitGroup = {
  key: string
  unit: string
  uncategorized: boolean
  kpGroups: KpGroup[]
  count: number
}

const FENCED_BLOCK_RE = /```[a-zA-Z0-9_-]*[^\n]*\n[\s\S]*?```/g
const HAS_MARKDOWN_OR_MATH_RE = /[$\\`*_[\]<>#]/

function previewPromptSource(prompt: string, isEn: boolean): string {
  // 1-line collapsed previews clip to 2.2em; avoid mounting heavy RDKit/SVG blocks inside them.
  const cleaned = prompt
    .replace(FENCED_BLOCK_RE, match => {
      const lang = /^```([a-zA-Z0-9_-]+)/.exec(match)?.[1]?.toLowerCase() || ''
      if (lang === 'molecule' || lang === 'smiles') return isEn ? ' [Structure] ' : ' [结构式] '
      if (lang === 'reaction' || lang === 'equation' || lang === 'formula') return isEn ? ' [Reaction] ' : ' [反应式] '
      if (lang === 'mechanism') return isEn ? ' [Mechanism] ' : ' [机理图] '
      return ' '
    })
    .replace(/\s+/g, ' ')
    .trim()
  return !HAS_MARKDOWN_OR_MATH_RE.test(cleaned) && cleaned.length > 260 ? cleaned.slice(0, 260) + '…' : cleaned
}

const PromptPreview = memo(function PromptPreview({
  prompt,
  isEn,
  render,
}: {
  prompt: string
  isEn: boolean
  render: (text: string) => React.ReactNode
}) {
  const source = useMemo(() => previewPromptSource(prompt, isEn), [prompt, isEn])
  if (!HAS_MARKDOWN_OR_MATH_RE.test(source)) return <>{source}</>
  return <>{render(source)}</>
})

export const LearningArea = memo(function LearningArea({
  courseId,
  threadId,
  onAskAgent,
  onOpenCanvas,
  onManagePractice,
  onChanged,
  revision,
  renderMarkdown,
  compact = false,
}: {
  courseId: string
  threadId?: string | null
  onAskAgent?: (text: string) => void
  onOpenCanvas?: (canvas: CanvasSpec, meta?: OpenCanvasMeta) => void
  onManagePractice?: () => void
  onChanged?: () => void
  revision?: number
  compact?: boolean
  renderMarkdown?: (text: string) => React.ReactNode
}) {
  const { locale, t, collator, questionTypeLabel } = useI18n()
  const { data, loading, error } = useCourseLearning(courseId, revision)
  const [filter, setFilter] = useState<Filter>('all')
  const [opened, setOpened] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const [organizing, setOrganizing] = useState(false)
  const [organizeNotice, setOrganizeNotice] = useState('')
  const [organizeError, setOrganizeError] = useState('')

  const items = data.items || []
  const canvases = data.canvases || []
  const visible = useMemo(
    () =>
      items.filter(q => {
        const a = latestFor(q, data.attempts)
        return (
          filter === 'all' ||
          (filter === 'unanswered' && !a) ||
          (filter === 'answered' && Boolean(a)) ||
          (filter === 'pending' && a?.grade?.status === 'pending_feedback' && !a.feedback)
        )
      }),
    [items, data.attempts, filter]
  )
  const visibleCanvases = filter === 'all' || filter === 'canvas' ? canvases : []
  const render = renderMarkdown || ((text: string) => <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>)
  const hasRecords = items.length > 0 || canvases.length > 0

  const typeGroups = useMemo(() => {
    const byType = new Map<StudyType, StudyQuestion[]>()
    for (const q of visible) {
      const bucket = byType.get(q.type)
      if (bucket) bucket.push(q)
      else byType.set(q.type, [q])
    }
    const groups: Array<{
      type: StudyType
      items: StudyQuestion[]
      hasSubcategories: boolean
      units: UnitGroup[]
    }> = []

    for (const type of TYPE_ORDER) {
      const list = byType.get(type)
      if (!list?.length) continue
      const hasSubcategories = list.some(
        q => Boolean((q.unit || '').trim() || (q.knowledgePoint || '').trim())
      )
      if (!hasSubcategories) {
        groups.push({ type, items: list, hasSubcategories: false, units: [] })
        continue
      }

      const unitMap = new Map<string, { unit: string; uncategorized: boolean; kpMap: Map<string, StudyQuestion[]> }>()
      for (const q of list) {
        const unit = (q.unit || '').trim()
        const kp = (q.knowledgePoint || '').trim()
        const uncategorized = !unit && !kp
        const unitKey = uncategorized ? '__uncategorized__' : unit || '__no_unit__'
        let unitBucket = unitMap.get(unitKey)
        if (!unitBucket) {
          unitBucket = { unit, uncategorized, kpMap: new Map() }
          unitMap.set(unitKey, unitBucket)
        }
        const kpKey = kp || '__general__'
        const kpList = unitBucket.kpMap.get(kpKey)
        if (kpList) kpList.push(q)
        else unitBucket.kpMap.set(kpKey, [q])
      }

      const units: UnitGroup[] = [...unitMap.entries()]
        .map(([unitKey, bucket]) => {
          const kpGroups: KpGroup[] = [...bucket.kpMap.entries()]
            .map(([kpKey, kpItems]) => ({
              key: `${type}:${unitKey}:${kpKey}`,
              knowledgePoint: kpKey === '__general__' ? '' : kpKey,
              items: kpItems,
            }))
            .sort((a, b) => {
              if (!a.knowledgePoint && b.knowledgePoint) return 1
              if (a.knowledgePoint && !b.knowledgePoint) return -1
              return collator.compare(a.knowledgePoint, b.knowledgePoint)
            })
          const count = kpGroups.reduce((sum, g) => sum + g.items.length, 0)
          return {
            key: `${type}:${unitKey}`,
            unit: bucket.unit,
            uncategorized: bucket.uncategorized,
            kpGroups,
            count,
          }
        })
        .sort((a, b) => {
          if (a.uncategorized !== b.uncategorized) return a.uncategorized ? 1 : -1
          if (!a.unit && b.unit) return 1
          if (a.unit && !b.unit) return -1
          return collator.compare(a.unit, b.unit)
        })

      groups.push({ type, items: list, hasSubcategories: true, units })
    }
    return groups
  }, [visible, collator])

  function toggleGroup(key: string) {
    setCollapsedGroups(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function openCanvas(canvas: SavedCanvas) {
    setOpened(opened === canvas.id ? null : canvas.id)
    if (opened === canvas.id) return
    void studyApi('/courses/' + encodeURIComponent(courseId) + '/canvas/activity', {
      canvasId: canvas.id,
      kind: 'opened',
    })
      .then(() => {
        notifyStudyChanged(courseId)
        onChanged?.()
      })
      .catch(() => {})
  }

  async function handleOrganize() {
    if (organizing || !items.length) return
    setOrganizing(true)
    setOrganizeError('')
    setOrganizeNotice('')
    try {
      const result = await studyApi('/courses/' + encodeURIComponent(courseId) + '/practice/organize', {
        mode: 'smart',
        locale,
      })
      notifyStudyChanged(courseId)
      onChanged?.()
      const count = typeof result?.organizedCount === 'number' ? result.organizedCount : 0
      setOrganizeNotice(count > 0 ? t('practice.organizeSuccess', { count }) : t('practice.organizeNoItems'))
    } catch (err: any) {
      setOrganizeError(err?.message || t('practice.organizeFailed'))
    } finally {
      setOrganizing(false)
    }
  }

  function renderQuestionItem(q: StudyQuestion, index: number) {
    const attempt = latestFor(q, data.attempts)
    const itemKey = q.id || String(index)
    const expanded = opened === itemKey
    const statusTone = !attempt
      ? 'is-unanswered'
      : attempt.grade?.status === 'pending_feedback' && !attempt.feedback
      ? 'is-pending'
      : attempt.grade?.correct === true
      ? 'is-correct'
      : attempt.grade?.correct === false
      ? 'is-incorrect'
      : 'is-done'
    const statusLabel = !attempt
      ? t('practice.status.unanswered')
      : attempt.grade?.status === 'self_assessed'
      ? t('practice.status.selfAssessed')
      : attempt.grade?.status === 'pending_feedback' && !attempt.feedback
      ? t('practice.status.pending')
      : attempt.grade?.correct === true
      ? t('practice.status.correct')
      : attempt.grade?.correct === false
      ? t('practice.status.incorrect')
      : t('practice.status.feedback')

    return (
      <div className={'learning-item' + (expanded ? ' is-expanded' : '')} key={itemKey}>
        <button
          type="button"
          className="learning-item-toggle"
          aria-expanded={expanded}
          onClick={() => setOpened(expanded ? null : itemKey)}
        >
          <span className={'learning-item-icon ' + statusTone}>
            {q.type === 'flashcard' ? (
              <Layers size={14} />
            ) : attempt?.grade?.status === 'pending_feedback' && !attempt.feedback ? (
              <Clock3 size={14} />
            ) : attempt ? (
              <CheckCircle2 size={14} />
            ) : (
              <BookOpen size={14} />
            )}
          </span>
          <span className="learning-item-text">
            <span className="learning-item-kind">
              {questionTypeLabel(q.type)}
              {q.multiple ? t('practice.multipleTag') : ''}
            </span>
            <span className="learning-prompt-preview">
              <PromptPreview prompt={q.prompt} isEn={locale === 'en'} render={render} />
            </span>
          </span>
          <span className={'learning-item-status ' + statusTone}>{statusLabel}</span>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {expanded && (
          <StudyProvider
            value={{
              courseId,
              threadId: q.threadId || threadId,
              itemId: q.itemId,
              onAskAgent,
              onLearningChange: onChanged,
              renderMarkdown,
            }}
          >
            <QuestionCard question={q} latestAttempt={attempt} onAskAgent={onAskAgent} />
          </StudyProvider>
        )}
      </div>
    )
  }

  return (
    <div className={'learning-area' + (compact ? ' is-compact' : '')}>
      {!compact && (
        <div className="learning-heading">
          <h2>{t('practice.title')}</h2>
        </div>
      )}

      <div className="practice-toolbar">
        <button
          type="button"
          className="practice-organize-button"
          disabled={organizing || loading || !items.length}
          title={t('practice.organizeTitle')}
          onClick={() => void handleOrganize()}
        >
          {organizing ? <span className="spinner" /> : <Sparkles size={14} />}
          <span>{organizing ? t('practice.organizingBtn') : t('practice.organizeBtn')}</span>
        </button>
        {onManagePractice && (
          <button
            type="button"
            className="context-manage-button"
            aria-label={t('practice.manageBtn')}
            title={t('practice.manageBtn')}
            onClick={onManagePractice}
          >
            <SlidersHorizontal size={14} />
          </button>
        )}
      </div>

      {organizeNotice && (
        <div className="practice-notice" role="status">
          <Check size={13} />
          <span>{organizeNotice}</span>
          <button type="button" aria-label={t('app.closeNotice')} onClick={() => setOrganizeNotice('')}>
            <X size={12} />
          </button>
        </div>
      )}
      {organizeError && (
        <p className="study-error" role="alert">
          {organizeError}
        </p>
      )}

      <div className="learning-filters" role="group" aria-label={t('practice.filterAria')}>
        {(
          [
            { id: 'all', text: t('practice.filter.all') },
            ...(canvases.length ? [{ id: 'canvas' as Filter, text: t('practice.filter.canvas') }] : []),
            { id: 'unanswered', text: t('practice.filter.unanswered') },
            { id: 'pending', text: t('practice.filter.pending') },
            { id: 'answered', text: t('practice.filter.answered') },
          ] as { id: Filter; text: string }[]
        ).map(item => (
          <button
            key={item.id}
            type="button"
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
            className={filter === item.id ? 'active' : ''}
          >
            {item.text}
          </button>
        ))}
      </div>

      {error && (
        <p className="study-error" role="alert">
          {error}
        </p>
      )}

      {loading && !hasRecords ? (
        <div className="study-component-loading">
          <span className="spinner" />
          {t('practice.loading')}
        </div>
      ) : !hasRecords ? (
        <div className="learning-empty">
          <div>
            <BookOpen size={22} />
          </div>
          <h3>{t('practice.emptyTitle')}</h3>
          <p>{t('practice.emptyDesc')}</p>
        </div>
      ) : !visible.length && !visibleCanvases.length ? (
        <p className="learning-no-results">{t('practice.noResults')}</p>
      ) : (
        <div className="practice-groups">
          {typeGroups.map(group => {
            const typeKey = 'type:' + group.type
            const typeCollapsed = collapsedGroups.has(typeKey)
            return (
              <section key={group.type} className="practice-type-group">
                <button
                  type="button"
                  className="practice-type-heading"
                  aria-expanded={!typeCollapsed}
                  onClick={() => toggleGroup(typeKey)}
                >
                  {typeCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  <span className="practice-type-glyph">{typeIcon(group.type)}</span>
                  <span className="practice-type-title">{questionTypeLabel(group.type)}</span>
                  <small>{group.items.length}</small>
                </button>
                {!typeCollapsed && (
                  <div className="practice-type-body">
                    {!group.hasSubcategories ? (
                      <div className="learning-item-list">
                        {group.items.map((q, index) => renderQuestionItem(q, index))}
                      </div>
                    ) : (
                      <div className="practice-unit-list">
                        {group.units.map(unitGroup => {
                          const unitCollapsed = collapsedGroups.has(unitGroup.key)
                          const unitLabel = unitGroup.uncategorized
                            ? t('practice.uncategorized')
                            : unitGroup.unit || t('practice.generalPoint')
                          const showKpSubheadings =
                            !unitGroup.uncategorized &&
                            (unitGroup.kpGroups.length > 1 || Boolean(unitGroup.kpGroups[0]?.knowledgePoint))
                          return (
                            <div key={unitGroup.key} className="practice-unit-group">
                              <button
                                type="button"
                                className={'practice-unit-heading' + (unitGroup.uncategorized ? ' is-muted' : '')}
                                aria-expanded={!unitCollapsed}
                                onClick={() => toggleGroup(unitGroup.key)}
                              >
                                {unitCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                                <span title={unitLabel}>{unitLabel}</span>
                                <small>{unitGroup.count}</small>
                              </button>
                              {!unitCollapsed && (
                                <div className="practice-unit-body">
                                  {showKpSubheadings ? (
                                    unitGroup.kpGroups.map(kpGroup => {
                                      const kpCollapsed = collapsedGroups.has(kpGroup.key)
                                      const kpLabel = kpGroup.knowledgePoint || t('practice.generalPoint')
                                      return (
                                        <div key={kpGroup.key} className="practice-kp-group">
                                          <button
                                            type="button"
                                            className="practice-kp-heading"
                                            aria-expanded={!kpCollapsed}
                                            onClick={() => toggleGroup(kpGroup.key)}
                                          >
                                            {kpCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                                            <Tag size={11} className="practice-kp-icon" />
                                            <span title={kpLabel}>{kpLabel}</span>
                                            <small>{kpGroup.items.length}</small>
                                          </button>
                                          {!kpCollapsed && (
                                            <div className="learning-item-list">
                                              {kpGroup.items.map((q, index) => renderQuestionItem(q, index))}
                                            </div>
                                          )}
                                        </div>
                                      )
                                    })
                                  ) : (
                                    <div className="learning-item-list">
                                      {unitGroup.kpGroups.flatMap(g => g.items).map((q, index) => renderQuestionItem(q, index))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </section>
            )
          })}

          {visibleCanvases.length > 0 && (
            <section className="practice-type-group">
              <button
                type="button"
                className="practice-type-heading"
                aria-expanded={!collapsedGroups.has('type:canvas')}
                onClick={() => toggleGroup('type:canvas')}
              >
                {collapsedGroups.has('type:canvas') ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <span className="practice-type-glyph is-canvas">
                  <Layers size={14} />
                </span>
                <span className="practice-type-title">{t('practice.canvasSection')}</span>
                <small>{visibleCanvases.length}</small>
              </button>
              {!collapsedGroups.has('type:canvas') && (
                <div className="practice-type-body">
                  <div className="learning-item-list">
                    {visibleCanvases.map(canvas => (
                      <div className={'learning-item' + (opened === canvas.id ? ' is-expanded' : '')} key={canvas.id}>
                        <button
                          type="button"
                          className="learning-item-toggle"
                          aria-expanded={opened === canvas.id}
                          onClick={() => openCanvas(canvas)}
                        >
                          <span className="learning-item-icon is-canvas">
                            <Layers size={14} />
                          </span>
                          <span className="learning-item-text">
                            <span className="learning-item-kind">{t('practice.canvasSection')}</span>
                            <span className="learning-prompt-preview">{canvas.title}</span>
                          </span>
                          <span className="learning-item-status is-canvas">
                            {canvas.lastOpenedAt ? t('practice.canvasOpened') : t('practice.canvasSaved')}
                          </span>
                          {opened === canvas.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        {opened === canvas.id && (
                          <StudyProvider
                            value={{
                              courseId,
                              threadId: canvas.threadId,
                              itemId: canvas.itemId,
                              revision,
                              onLearningChange: onChanged,
                              onOpenCanvas,
                            }}
                          >
                            <CanvasCard
                              canvas={{
                                id: canvas.sourceId,
                                title: canvas.title,
                                html: canvas.html,
                                height: canvas.height,
                              }}
                              savedCanvas={canvas}
                            />
                          </StudyProvider>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {!compact && (data.workspacePath || data.importantInfo || data.progress) && (
        <div className="learning-course-records">
          {data.workspacePath && (
            <details>
              <summary>
                <FolderOpen size={15} />
                {t('practice.courseWorkspace')}
              </summary>
              <p className="learning-workspace-path">{data.workspacePath}</p>
            </details>
          )}
          {data.importantInfo && (
            <details>
              <summary>{t('practice.courseImportantInfo')}</summary>
              <div className="learning-notes">{render(data.importantInfo)}</div>
            </details>
          )}
          {typeof data.progress === 'string' && data.progress && (
            <details>
              <summary>{t('practice.learningProgress')}</summary>
              <div className="learning-notes">{render(data.progress)}</div>
            </details>
          )}
        </div>
      )}
    </div>
  )
})
