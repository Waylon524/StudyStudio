import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  AlertCircle,
  AlignLeft,
  BookOpen,
  Check,
  CheckSquare,
  FolderPlus,
  Layers,
  ListChecks,
  Pencil,
  PenLine,
  RefreshCw,
  Search,
  Sparkles,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { CourseAvatar } from './CourseAvatar'
import type { ManagedCourse } from './settings-types'
import type { PracticeCategory, StudyAttempt, StudyQuestion, StudyType } from './study-types'
import { latestFor, notifyStudyChanged } from './StudyComponents'
import { categoryKey } from '../shared/study-schema.mjs'
import { useI18n } from './i18n'

type TypeFilter = 'all' | StudyType
type StatusFilter = 'all' | 'unanswered' | 'answered' | 'uncategorized'

type Props = {
  courses: ManagedCourse[]
  selectedCourseId: string
  onSelectCourse: (courseId: string) => void
  activeCourseId: string
  revision?: number
  onChanged?: (courseId: string) => void
}

const TYPE_ORDER: StudyType[] = ['choice', 'true_false', 'fill_blank', 'short_answer', 'flashcard']

async function apiJson(path: string, body?: unknown, signal?: AbortSignal) {
  const res = await fetch(
    path,
    body === undefined
      ? { signal }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }
  )
  const value = await res.json()
  if (!res.ok) throw new Error(value.error || 'Operation failed')
  return value
}

function questionIcon(type: StudyType) {
  switch (type) {
    case 'choice':
      return { tone: 'courseware', icon: <ListChecks size={15} /> }
    case 'true_false':
      return { tone: 'html', icon: <CheckSquare size={15} /> }
    case 'fill_blank':
      return { tone: 'markdown', icon: <PenLine size={15} /> }
    case 'short_answer':
      return { tone: 'pdf', icon: <AlignLeft size={15} /> }
    case 'flashcard':
      return { tone: 'book', icon: <Layers size={15} /> }
    default:
      return { tone: 'doc', icon: <BookOpen size={15} /> }
  }
}

function formatCategoryLabel(unit?: string, knowledgePoint?: string): string {
  const u = (unit || '').trim()
  const kp = (knowledgePoint || '').trim()
  if (u && kp) return `${u} · ${kp}`
  return u || kp
}

function stripMarkdownPreview(text: string): string {
  return String(text || '')
    .replace(/```(?:molecule|smiles)\b[\s\S]*?```/gi, ' [结构式] ')
    .replace(/```(?:reaction|equation|formula)\b[\s\S]*?```/gi, ' [反应式] ')
    .replace(/```mechanism\b[\s\S]*?```/gi, ' [反应机理] ')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/\$\$?\s*\\smiles\s*\{[^{}]*\}\s*\$\$?/g, ' [结构式] ')
    .replace(/\$\$?\s*\\reaction\s*\{[^{}]*\}\s*\$\$?/g, ' [反应式] ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' [math] ')
    .replace(/[#*_>`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function SettingsPractice({
  courses,
  selectedCourseId,
  onSelectCourse,
  activeCourseId,
  revision,
  onChanged,
}: Props) {
  const { locale, t, collator, courseDisplayName, questionTypeLabel } = useI18n()
  const [items, setItems] = useState<StudyQuestion[]>([])
  const [attempts, setAttempts] = useState<StudyAttempt[]>([])
  const [categories, setCategories] = useState<PracticeCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [localRev, setLocalRev] = useState(0)

  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('__all__')
  const [query, setQuery] = useState('')

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [batchCategoryKey, setBatchCategoryKey] = useState<string>('__uncategorized__')
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false)

  // Category creation / editing / deletion
  const [creatingCategory, setCreatingCategory] = useState(false)
  const [newUnit, setNewUnit] = useState('')
  const [newKp, setNewKp] = useState('')
  const [editingCategoryKey, setEditingCategoryKey] = useState<string | null>(null)
  const [editCatUnit, setEditCatUnit] = useState('')
  const [editCatKp, setEditCatKp] = useState('')
  const [confirmDeleteCatKey, setConfirmDeleteCatKey] = useState<string | null>(null)

  // Row-level categorize / edit / delete
  const [categorizingId, setCategorizingId] = useState<string | null>(null)
  const [rowUnit, setRowUnit] = useState('')
  const [rowKp, setRowKp] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editPrompt, setEditPrompt] = useState('')
  const [editUnit, setEditUnit] = useState('')
  const [editKp, setEditKp] = useState('')
  const [editExplanation, setEditExplanation] = useState('')
  const [editRubric, setEditRubric] = useState('')
  const [editBoolAnswer, setEditBoolAnswer] = useState(true)
  const [editTextAnswer, setEditTextAnswer] = useState('')
  const [editAccepted, setEditAccepted] = useState('')
  const [editMultiple, setEditMultiple] = useState(false)
  const [editOptions, setEditOptions] = useState<Array<{ id: string; text: string }>>([])
  const [editChoiceAnswers, setEditChoiceAnswers] = useState<string[]>([])
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const activeCourseRef = useRef(selectedCourseId)
  const requestSeq = useRef(0)
  const base = '/api/courses/' + encodeURIComponent(selectedCourseId)
  const selectedCourse = courses.find(c => c.id === selectedCourseId)

  useEffect(() => {
    activeCourseRef.current = selectedCourseId
    requestSeq.current++
    setItems([])
    setAttempts([])
    setCategories([])
    setError('')
    setNotice('')
    setTypeFilter('all')
    setStatusFilter('all')
    setCategoryFilter('__all__')
    setQuery('')
    setSelectedIds(new Set())
    setConfirmBatchDelete(false)
    setCreatingCategory(false)
    setNewUnit('')
    setNewKp('')
    setEditingCategoryKey(null)
    setConfirmDeleteCatKey(null)
    setCategorizingId(null)
    setEditingId(null)
    setConfirmDeleteId(null)
  }, [selectedCourseId])

  useEffect(() => {
    const controller = new AbortController()
    const seq = ++requestSeq.current
    setLoading(true)
    setError('')
    apiJson(base + '/learning', undefined, controller.signal)
      .then(data => {
        if (activeCourseRef.current !== selectedCourseId || seq !== requestSeq.current) return
        const nextItems = Array.isArray(data.items) ? (data.items as StudyQuestion[]) : []
        const nextAttempts = Array.isArray(data.attempts) ? (data.attempts as StudyAttempt[]) : []
        const nextCategories = Array.isArray(data.categories) ? (data.categories as PracticeCategory[]) : []
        setItems(nextItems)
        setAttempts(nextAttempts)
        setCategories(nextCategories)
        setSelectedIds(prev => {
          if (!prev.size) return prev
          const valid = new Set(nextItems.map(item => item.id).filter(Boolean) as string[])
          const filtered = new Set([...prev].filter(id => valid.has(id)))
          return filtered.size === prev.size ? prev : filtered
        })
      })
      .catch(err => {
        if (err.name !== 'AbortError' && activeCourseRef.current === selectedCourseId && seq === requestSeq.current) {
          setError(err.message)
        }
      })
      .finally(() => {
        if (activeCourseRef.current === selectedCourseId && seq === requestSeq.current) setLoading(false)
      })
    return () => controller.abort()
  }, [selectedCourseId, base, revision, localRev])

  const reload = useCallback(() => {
    setLocalRev(v => v + 1)
    notifyStudyChanged(selectedCourseId)
    onChanged?.(selectedCourseId)
  }, [onChanged, selectedCourseId])

  const normalizedCategories = useMemo(() => {
    const map = new Map<string, PracticeCategory>()
    for (const cat of categories) {
      const u = (cat.unit || '').trim()
      const kp = (cat.knowledgePoint || '').trim()
      if (!u && !kp) continue
      const key = categoryKey(u, kp)
      if (!map.has(key)) map.set(key, { unit: u, knowledgePoint: kp })
    }
    for (const item of items) {
      const u = (item.unit || '').trim()
      const kp = (item.knowledgePoint || '').trim()
      if (!u && !kp) continue
      const key = categoryKey(u, kp)
      if (!map.has(key)) map.set(key, { unit: u, knowledgePoint: kp })
    }
    return [...map.values()].sort((a, b) => collator.compare(a.unit, b.unit) || collator.compare(a.knowledgePoint, b.knowledgePoint))
  }, [categories, items, collator])

  const counts = useMemo(() => {
    const byType = new Map<StudyType, number>()
    const byCategory = new Map<string, number>()
    let categorized = 0
    let uncategorized = 0
    for (const item of items) {
      byType.set(item.type, (byType.get(item.type) || 0) + 1)
      const u = (item.unit || '').trim()
      const kp = (item.knowledgePoint || '').trim()
      if (u || kp) {
        categorized++
        const key = categoryKey(u, kp)
        byCategory.set(key, (byCategory.get(key) || 0) + 1)
      } else {
        uncategorized++
      }
    }
    return { total: items.length, categorized, uncategorized, byType, byCategory }
  }, [items])

  useEffect(() => {
    if (
      categoryFilter !== '__all__' &&
      categoryFilter !== '__uncategorized__' &&
      !normalizedCategories.some(c => categoryKey(c.unit, c.knowledgePoint) === categoryFilter)
    ) {
      setCategoryFilter('__all__')
    }
  }, [normalizedCategories, categoryFilter])

  const selectedCategoryObj = useMemo(() => {
    if (categoryFilter === '__all__' || categoryFilter === '__uncategorized__') return null
    return normalizedCategories.find(c => categoryKey(c.unit, c.knowledgePoint) === categoryFilter) || null
  }, [normalizedCategories, categoryFilter])

  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter(item => {
      if (typeFilter !== 'all' && item.type !== typeFilter) return false
      const u = (item.unit || '').trim()
      const kp = (item.knowledgePoint || '').trim()
      const hasCat = Boolean(u || kp)
      if (categoryFilter === '__uncategorized__' && hasCat) return false
      if (categoryFilter !== '__all__' && categoryFilter !== '__uncategorized__' && categoryKey(u, kp) !== categoryFilter) {
        return false
      }
      const attempt = latestFor(item, attempts)
      if (statusFilter === 'unanswered' && attempt) return false
      if (statusFilter === 'answered' && !attempt) return false
      if (statusFilter === 'uncategorized' && hasCat) return false
      if (q) {
        const hay = `${item.prompt} ${u} ${kp} ${item.explanation || ''} ${(item.tags || []).join(' ')}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [items, attempts, typeFilter, categoryFilter, statusFilter, query])

  const visibleIds = useMemo(() => visibleItems.map(i => i.id).filter(Boolean) as string[], [visibleItems])
  const selectedVisibleCount = useMemo(() => visibleIds.filter(id => selectedIds.has(id)).length, [visibleIds, selectedIds])
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length

  function stopEscape(event: KeyboardEvent, onCancel: () => void) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }

  function toggleSelect(id: string) {
    setConfirmBatchDelete(false)
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    setConfirmBatchDelete(false)
    if (allVisibleSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev)
        visibleIds.forEach(id => next.delete(id))
        return next
      })
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev)
        visibleIds.forEach(id => next.add(id))
        return next
      })
    }
  }

  async function runOrganize(mode: 'smart' | 'all') {
    if (busyKey || !items.length) return
    setBusyKey('organize-' + mode)
    setError('')
    setNotice('')
    try {
      const result = await apiJson(base + '/practice/organize', { mode, locale })
      setNotice(t('sp.noticeOrganized', { count: result.organizedCount || 0 }))
      reload()
    } catch (err: any) {
      setError(err.message || t('practice.organizeFailed'))
    } finally {
      setBusyKey(null)
    }
  }

  async function handleCreateCategory(event: FormEvent) {
    event.preventDefault()
    const u = newUnit.trim()
    const kp = newKp.trim()
    if (!u && !kp) {
      setError(t('sp.errCategoryRequired'))
      return
    }
    setBusyKey('cat-create')
    setError('')
    setNotice('')
    try {
      await apiJson(base + '/practice/categories', { unit: u, knowledgePoint: kp })
      setCreatingCategory(false)
      setNewUnit('')
      setNewKp('')
      setCategoryFilter(categoryKey(u, kp))
      setNotice(t('sp.noticeCategoryCreated', { label: formatCategoryLabel(u, kp) }))
      reload()
    } catch (err: any) {
      setError(err.message || t('app.operationFailed'))
    } finally {
      setBusyKey(null)
    }
  }

  async function handleRenameCategory(event: FormEvent) {
    event.preventDefault()
    if (!selectedCategoryObj) return
    const u = editCatUnit.trim()
    const kp = editCatKp.trim()
    if (!u && !kp) {
      setError(t('sp.errCategoryRequired'))
      return
    }
    setBusyKey('cat-rename')
    setError('')
    setNotice('')
    try {
      await apiJson(base + '/practice/categories/rename', {
        oldUnit: selectedCategoryObj.unit,
        oldKnowledgePoint: selectedCategoryObj.knowledgePoint,
        unit: u,
        knowledgePoint: kp,
      })
      setEditingCategoryKey(null)
      setCategoryFilter(categoryKey(u, kp))
      setNotice(t('sp.noticeCategoryRenamed', { label: formatCategoryLabel(u, kp) }))
      reload()
    } catch (err: any) {
      setError(err.message || t('app.operationFailed'))
    } finally {
      setBusyKey(null)
    }
  }

  async function handleDeleteCategory() {
    if (!selectedCategoryObj) return
    setBusyKey('cat-delete')
    setError('')
    setNotice('')
    try {
      const res = await apiJson(base + '/practice/categories/delete', {
        unit: selectedCategoryObj.unit,
        knowledgePoint: selectedCategoryObj.knowledgePoint,
      })
      setConfirmDeleteCatKey(null)
      setCategoryFilter('__all__')
      setNotice(
        t('sp.noticeCategoryDeleted', {
          label: formatCategoryLabel(selectedCategoryObj.unit, selectedCategoryObj.knowledgePoint),
          count: res.clearedQuestions || 0,
        })
      )
      reload()
    } catch (err: any) {
      setError(err.message || t('app.operationFailed'))
    } finally {
      setBusyKey(null)
    }
  }

  function openCategorizeDrawer(item: StudyQuestion) {
    if (!item.id) return
    if (categorizingId === item.id) {
      setCategorizingId(null)
      return
    }
    setCategorizingId(item.id)
    setRowUnit(item.unit || '')
    setRowKp(item.knowledgePoint || '')
    setEditingId(null)
    setConfirmDeleteId(null)
  }

  async function saveRowCategory(questionId: string, unit: string, knowledgePoint: string) {
    setBusyKey('cat:' + questionId)
    setError('')
    setNotice('')
    try {
      await apiJson(base + '/practice/questions/categorize', {
        questionIds: [questionId],
        unit: unit.trim(),
        knowledgePoint: knowledgePoint.trim(),
      })
      setCategorizingId(null)
      setNotice(t('sp.noticeQuestionsCategorized', { count: 1 }))
      reload()
    } catch (err: any) {
      setError(err.message || t('app.operationFailed'))
    } finally {
      setBusyKey(null)
    }
  }

  function openQuestionEditor(item: StudyQuestion) {
    if (!item.id) return
    if (editingId === item.id) {
      setEditingId(null)
      return
    }
    setEditingId(item.id)
    setEditPrompt(item.prompt || '')
    setEditUnit(item.unit || '')
    setEditKp(item.knowledgePoint || '')
    setEditExplanation(item.explanation || '')
    setEditRubric(item.rubric || '')
    setEditBoolAnswer(item.answer === true)
    setEditTextAnswer(typeof item.answer === 'string' ? item.answer : '')
    setEditAccepted(Array.isArray(item.acceptedAnswers) ? item.acceptedAnswers.join(', ') : '')
    setEditMultiple(Boolean(item.multiple))
    setEditOptions(Array.isArray(item.options) ? item.options.map(o => ({ ...o })) : [])
    setEditChoiceAnswers(
      Array.isArray(item.answer) ? item.answer : typeof item.answer === 'string' ? [item.answer] : []
    )
    setCategorizingId(null)
    setConfirmDeleteId(null)
  }

  async function saveQuestionEdit(event: FormEvent, item: StudyQuestion) {
    event.preventDefault()
    if (!item.id) return
    if (!editPrompt.trim()) {
      setError(t('sp.errPromptRequired'))
      return
    }
    const payload: Record<string, unknown> = {
      questionId: item.id,
      prompt: editPrompt.trim(),
      unit: editUnit.trim(),
      knowledgePoint: editKp.trim(),
      explanation: editExplanation.trim(),
    }
    if (item.type === 'true_false') {
      payload.answer = editBoolAnswer
    } else if (item.type === 'choice') {
      payload.options = editOptions
      payload.multiple = editMultiple
      payload.answer = editMultiple ? editChoiceAnswers : editChoiceAnswers[0] || editOptions[0]?.id || ''
    } else if (item.type === 'fill_blank') {
      payload.answer = editTextAnswer.trim()
      payload.acceptedAnswers = editAccepted
        .split(/[,，]/)
        .map(s => s.trim())
        .filter(Boolean)
    } else if (item.type === 'short_answer') {
      payload.answer = editTextAnswer.trim()
      payload.rubric = editRubric.trim()
    } else if (item.type === 'flashcard') {
      payload.answer = editTextAnswer.trim()
    }

    setBusyKey('edit:' + item.id)
    setError('')
    setNotice('')
    try {
      await apiJson(base + '/practice/questions/update', payload)
      setEditingId(null)
      setNotice(t('sp.noticeQuestionUpdated'))
      reload()
    } catch (err: any) {
      setError(err.message || t('app.operationFailed'))
    } finally {
      setBusyKey(null)
    }
  }

  async function deleteSingle(questionId: string) {
    setBusyKey('delete:' + questionId)
    setError('')
    setNotice('')
    try {
      await apiJson(base + '/practice/questions/delete', { questionIds: [questionId] })
      setConfirmDeleteId(null)
      setSelectedIds(prev => {
        const next = new Set(prev)
        next.delete(questionId)
        return next
      })
      setNotice(t('sp.noticeQuestionsDeleted', { count: 1 }))
      reload()
    } catch (err: any) {
      setError(err.message || t('app.operationFailed'))
    } finally {
      setBusyKey(null)
    }
  }

  async function batchCategorize() {
    const ids = [...selectedIds]
    if (!ids.length) return
    let unit = ''
    let knowledgePoint = ''
    if (batchCategoryKey !== '__uncategorized__') {
      const matched = normalizedCategories.find(c => categoryKey(c.unit, c.knowledgePoint) === batchCategoryKey)
      if (matched) {
        unit = matched.unit
        knowledgePoint = matched.knowledgePoint
      }
    }
    setBusyKey('batch-cat')
    setError('')
    setNotice('')
    try {
      const res = await apiJson(base + '/practice/questions/categorize', {
        questionIds: ids,
        unit,
        knowledgePoint,
      })
      setSelectedIds(new Set())
      setConfirmBatchDelete(false)
      setNotice(t('sp.noticeQuestionsCategorized', { count: res.updatedCount || ids.length }))
      reload()
    } catch (err: any) {
      setError(err.message || t('app.operationFailed'))
    } finally {
      setBusyKey(null)
    }
  }

  async function batchDelete() {
    const ids = [...selectedIds]
    if (!ids.length) return
    setBusyKey('batch-delete')
    setError('')
    setNotice('')
    try {
      const res = await apiJson(base + '/practice/questions/delete', { questionIds: ids })
      setSelectedIds(new Set())
      setConfirmBatchDelete(false)
      setNotice(t('sp.noticeQuestionsDeleted', { count: (res.deletedIds || ids).length }))
      reload()
    } catch (err: any) {
      setError(err.message || t('app.operationFailed'))
    } finally {
      setBusyKey(null)
    }
  }

  const organizing = busyKey === 'organize-smart' || busyKey === 'organize-all'

  return (
    <div className="sm-root sp-root">
      <div className="sm-course-strip" role="tablist" aria-label={t('sp.selectCourseAria')}>
        {courses.map(course => {
          const selected = course.id === selectedCourseId
          return (
            <button
              key={course.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={'sm-course-pill' + (selected ? ' is-active' : '')}
              onClick={() => onSelectCourse(course.id)}
            >
              <CourseAvatar courseId={course.id} size={18} interactive={false} />
              <span>{courseDisplayName(course)}</span>
              {course.id === activeCourseId && <em className="sm-pill-dot" title={t('settings.currentCourseDot')} />}
            </button>
          )
        })}
      </div>

      <div className="sm-overview-bar">
        <div className="sm-metrics">
          <span className="sm-metric">
            <strong>{counts.total}</strong> {t('sp.metricTotal', { count: '' }).trim()}
          </span>
          <span className="sm-metric-sep" aria-hidden="true">·</span>
          <span className="sm-metric">
            <strong>{counts.categorized}</strong> {t('sp.metricCategorized', { count: '' }).trim()}
          </span>
          <span className="sm-metric-sep" aria-hidden="true">·</span>
          <span className="sm-metric">
            <strong>{normalizedCategories.length}</strong> {t('sp.metricCategories', { count: '' }).trim()}
          </span>
        </div>
        <div className="sm-upload-actions">
          <button
            type="button"
            className="settings-btn-accent"
            disabled={!!busyKey || loading || !items.length}
            onClick={() => void runOrganize('smart')}
          >
            {organizing ? <span className="spinner" /> : <Sparkles size={14} />}
            {organizing ? t('sp.organizing') : t('sp.organizeSmart')}
          </button>
          {counts.categorized > 0 && counts.uncategorized > 0 && (
            <button
              type="button"
              className="settings-btn-secondary"
              disabled={!!busyKey || loading || !items.length}
              onClick={() => void runOrganize('all')}
            >
              <RefreshCw size={13} />
              {t('sp.organizeAll')}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="settings-alert is-error" role="alert">
          <AlertCircle size={15} />
          <span>{error}</span>
          <button type="button" aria-label={t('app.closeNotice')} onClick={() => setError('')}>
            <X size={13} />
          </button>
        </div>
      )}
      {notice && (
        <div className="settings-alert is-success" role="status">
          <Check size={14} />
          <span>{notice}</span>
          <button type="button" aria-label={t('app.closeNotice')} onClick={() => setNotice('')}>
            <X size={13} />
          </button>
        </div>
      )}

      <div className="sm-toolbar">
        <div className="sm-segmented sp-type-segmented" role="group" aria-label={t('sm.filterTypeAria')}>
          <button
            type="button"
            className={typeFilter === 'all' ? 'is-active' : ''}
            aria-pressed={typeFilter === 'all'}
            onClick={() => setTypeFilter('all')}
          >
            {t('practice.filter.all')}
            <small>{counts.total}</small>
          </button>
          {TYPE_ORDER.map(type => (
            <button
              key={type}
              type="button"
              className={typeFilter === type ? 'is-active' : ''}
              aria-pressed={typeFilter === type}
              onClick={() => setTypeFilter(type)}
            >
              {questionTypeLabel(type)}
              <small>{counts.byType.get(type) || 0}</small>
            </button>
          ))}
        </div>

        <label className="sm-search">
          <Search size={14} />
          <input
            type="search"
            aria-label={t('sp.searchAria')}
            placeholder={t('sp.searchPlaceholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
          {query && (
            <button type="button" aria-label={t('app.clearSearch')} onClick={() => setQuery('')}>
              <X size={13} />
            </button>
          )}
        </label>

        <select
          className="sm-sort"
          aria-label={t('sp.statusFilterAria')}
          value={statusFilter}
          onChange={event => setStatusFilter(event.target.value as StatusFilter)}
        >
          <option value="all">{t('sp.statusAll')}</option>
          <option value="unanswered">{t('sp.statusUnanswered')}</option>
          <option value="answered">{t('sp.statusAnswered')}</option>
          <option value="uncategorized">{t('sp.statusUncategorized')}</option>
        </select>
      </div>

      <div className="sm-folder-bar" aria-label={t('sp.categoryBarAria')}>
        <div className="sm-folder-chips">
          <button
            type="button"
            className={'sm-chip' + (categoryFilter === '__all__' ? ' is-active' : '')}
            onClick={() => {
              setCategoryFilter('__all__')
              setEditingCategoryKey(null)
              setConfirmDeleteCatKey(null)
            }}
          >
            {t('sp.allCategories')}
            <small>{counts.total}</small>
          </button>
          {counts.uncategorized > 0 && (
            <button
              type="button"
              className={'sm-chip' + (categoryFilter === '__uncategorized__' ? ' is-active' : '')}
              onClick={() => {
                setCategoryFilter('__uncategorized__')
                setEditingCategoryKey(null)
                setConfirmDeleteCatKey(null)
              }}
            >
              {t('sp.uncategorized')}
              <small>{counts.uncategorized}</small>
            </button>
          )}
          {normalizedCategories.map(cat => {
            const key = categoryKey(cat.unit, cat.knowledgePoint)
            const label = formatCategoryLabel(cat.unit, cat.knowledgePoint)
            return (
              <button
                key={key}
                type="button"
                className={'sm-chip' + (categoryFilter === key ? ' is-active' : '')}
                onClick={() => {
                  setCategoryFilter(key)
                  setEditingCategoryKey(null)
                  setConfirmDeleteCatKey(null)
                }}
              >
                <Tag size={11} />
                <span>{label}</span>
                <small>{counts.byCategory.get(key) || 0}</small>
              </button>
            )
          })}
          {!creatingCategory && (
            <button
              type="button"
              className="sm-chip sm-chip-add"
              disabled={!!busyKey}
              onClick={() => {
                setCreatingCategory(true)
                setEditingCategoryKey(null)
                setConfirmDeleteCatKey(null)
              }}
            >
              <FolderPlus size={12} />
              {t('sp.newCategory')}
            </button>
          )}
        </div>

        {selectedCategoryObj && (
          <div className="sm-folder-manage">
            {confirmDeleteCatKey === categoryFilter ? (
              <div className="sm-inline-confirm">
                <span>{t('sp.confirmDeleteCategory')}</span>
                <button
                  type="button"
                  className="is-danger"
                  disabled={!!busyKey}
                  onClick={() => void handleDeleteCategory()}
                >
                  {t('app.delete')}
                </button>
                <button type="button" onClick={() => setConfirmDeleteCatKey(null)}>
                  {t('app.cancel')}
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="sm-folder-action"
                  disabled={!!busyKey}
                  onClick={() => {
                    setEditingCategoryKey(categoryFilter)
                    setEditCatUnit(selectedCategoryObj.unit)
                    setEditCatKp(selectedCategoryObj.knowledgePoint)
                    setConfirmDeleteCatKey(null)
                    setCreatingCategory(false)
                  }}
                >
                  <Pencil size={12} />
                  {t('sp.renameCategory')}
                </button>
                <button
                  type="button"
                  className="sm-folder-action is-danger"
                  disabled={!!busyKey}
                  onClick={() => {
                    setConfirmDeleteCatKey(categoryFilter)
                    setEditingCategoryKey(null)
                  }}
                >
                  <Trash2 size={12} />
                  {t('sp.deleteCategory')}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {creatingCategory && (
        <form
          className="sp-category-form"
          onSubmit={event => void handleCreateCategory(event)}
          onKeyDown={event => stopEscape(event, () => setCreatingCategory(false))}
        >
          <input
            autoFocus
            aria-label={t('sp.unitLabel')}
            placeholder={t('sp.unitPlaceholder')}
            value={newUnit}
            maxLength={120}
            disabled={!!busyKey}
            onChange={event => setNewUnit(event.target.value)}
          />
          <input
            aria-label={t('sp.kpLabel')}
            placeholder={t('sp.kpPlaceholder')}
            value={newKp}
            maxLength={120}
            disabled={!!busyKey}
            onChange={event => setNewKp(event.target.value)}
          />
          <button type="submit" className="settings-btn-primary-xs" disabled={(!newUnit.trim() && !newKp.trim()) || !!busyKey}>
            {t('app.add')}
          </button>
          <button type="button" className="settings-btn-ghost-xs" onClick={() => setCreatingCategory(false)}>
            {t('app.cancel')}
          </button>
        </form>
      )}

      {editingCategoryKey && selectedCategoryObj && (
        <form
          className="sp-category-form"
          onSubmit={event => void handleRenameCategory(event)}
          onKeyDown={event => stopEscape(event, () => setEditingCategoryKey(null))}
        >
          <input
            autoFocus
            aria-label={t('sp.unitLabel')}
            placeholder={t('sp.unitPlaceholder')}
            value={editCatUnit}
            maxLength={120}
            disabled={!!busyKey}
            onChange={event => setEditCatUnit(event.target.value)}
          />
          <input
            aria-label={t('sp.kpLabel')}
            placeholder={t('sp.kpPlaceholder')}
            value={editCatKp}
            maxLength={120}
            disabled={!!busyKey}
            onChange={event => setEditCatKp(event.target.value)}
          />
          <button type="submit" className="settings-btn-primary-xs" disabled={(!editCatUnit.trim() && !editCatKp.trim()) || !!busyKey}>
            {t('app.save')}
          </button>
          <button type="button" className="settings-btn-ghost-xs" onClick={() => setEditingCategoryKey(null)}>
            {t('app.cancel')}
          </button>
        </form>
      )}

      {loading && !items.length ? (
        <div className="settings-state-loading" role="status">
          <span className="spinner" />
          {t('sp.loading')}
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="sm-empty">
          <div className="sm-empty-icon">
            <BookOpen size={24} />
          </div>
          {items.length === 0 ? (
            <>
              <h3>{t('sp.emptyCourseTitle', { course: courseDisplayName(selectedCourse) })}</h3>
              <p>{t('sp.emptyCourseDesc')}</p>
            </>
          ) : (
            <>
              <h3>{t('sp.emptyFilterTitle')}</h3>
              <p>{t('sp.emptyFilterDesc')}</p>
              <button
                type="button"
                className="settings-btn-secondary"
                onClick={() => {
                  setTypeFilter('all')
                  setCategoryFilter('__all__')
                  setStatusFilter('all')
                  setQuery('')
                }}
              >
                {t('sm.clearAllFilters')}
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="sm-list-wrap">
          <div className="sm-list-header sp-list-header">
            <label className="sm-checkbox-wrap">
              <input
                type="checkbox"
                aria-label={t('sp.selectAllAria')}
                checked={allVisibleSelected}
                ref={el => {
                  if (el) el.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected
                }}
                onChange={toggleSelectAll}
              />
              <span>{t('sp.colQuestion', { count: visibleItems.length })}</span>
            </label>
            <span className="sm-col-meta">{t('sp.colCategory')}</span>
            <span className="sm-col-actions">{t('sp.colActions')}</span>
          </div>

          <div className="sm-list" role="list">
            {visibleItems.map((item, idx) => {
              const id = item.id || String(idx)
              const visual = questionIcon(item.type)
              const attempt = latestFor(item, attempts)
              const checked = selectedIds.has(id)
              const isCategorizing = categorizingId === id
              const isEditing = editingId === id
              const isDeleting = confirmDeleteId === id
              const catLabel = formatCategoryLabel(item.unit, item.knowledgePoint)
              const preview = stripMarkdownPreview(item.prompt)
              const statusText = !attempt
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
                <div
                  key={id}
                  role="listitem"
                  className={'sm-row-wrap' + (checked ? ' is-selected' : '') + (isCategorizing || isEditing ? ' is-editing' : '')}
                >
                  <div className="sm-row sp-row">
                    <label className="sm-row-check">
                      <input
                        type="checkbox"
                        aria-label={t('sp.selectQuestionAria')}
                        checked={checked}
                        onChange={() => toggleSelect(id)}
                      />
                    </label>
                    <span className={'sm-file-icon is-' + visual.tone} aria-hidden="true">
                      {visual.icon}
                    </span>
                    <div className="sm-row-main">
                      <div className="sp-row-prompt" title={preview}>
                        {preview}
                      </div>
                      <div className="sm-row-tags">
                        <span className="sm-tag is-courseware">
                          {questionTypeLabel(item.type)}
                          {item.multiple ? t('practice.multipleTag') : ''}
                        </span>
                        <span className={'sm-tag ' + (attempt?.grade?.correct === true ? 'is-reading' : attempt?.grade?.correct === false ? 'is-warn' : 'is-folder')}>
                          {statusText}
                        </span>
                        {item.organizedBy === 'ai' && <span className="sm-tag is-subtle">{t('sp.aiBadge')}</span>}
                      </div>
                    </div>

                    <div className="sp-row-category">
                      {catLabel ? (
                        <>
                          {item.unit && <span className="sp-cat-unit" title={item.unit}>{item.unit}</span>}
                          {item.knowledgePoint && <small className="sp-cat-kp" title={item.knowledgePoint}>{item.knowledgePoint}</small>}
                        </>
                      ) : (
                        <small className="sp-cat-empty">{t('sp.uncategorized')}</small>
                      )}
                    </div>

                    <div className="sm-row-actions">
                      {isDeleting ? (
                        <div className="sm-inline-confirm" onKeyDown={event => stopEscape(event, () => setConfirmDeleteId(null))}>
                          <button
                            type="button"
                            className="is-danger"
                            disabled={!!busyKey}
                            onClick={() => void deleteSingle(id)}
                          >
                            {busyKey === 'delete:' + id ? t('app.deleting') : t('sp.confirmDeleteQuestion')}
                          </button>
                          <button type="button" onClick={() => setConfirmDeleteId(null)}>
                            {t('app.cancel')}
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={'sm-icon-btn' + (isCategorizing ? ' is-active' : '')}
                            title={t('sp.categorizeBtn')}
                            aria-label={t('sp.categorizeBtn')}
                            aria-expanded={isCategorizing}
                            disabled={!!busyKey}
                            onClick={() => openCategorizeDrawer(item)}
                          >
                            <Tag size={14} />
                          </button>
                          <button
                            type="button"
                            className={'sm-icon-btn' + (isEditing ? ' is-active' : '')}
                            title={t('sp.editBtn')}
                            aria-label={t('sp.editBtn')}
                            aria-expanded={isEditing}
                            disabled={!!busyKey}
                            onClick={() => openQuestionEditor(item)}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            className="sm-icon-btn is-danger"
                            title={t('sp.deleteBtn')}
                            aria-label={t('sp.deleteBtn')}
                            disabled={!!busyKey}
                            onClick={() => {
                              setConfirmDeleteId(id)
                              setCategorizingId(null)
                              setEditingId(null)
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {isCategorizing && (
                    <div className="sm-move-drawer sp-drawer" onKeyDown={event => stopEscape(event, () => setCategorizingId(null))}>
                      {normalizedCategories.length > 0 && (
                        <div className="sm-move-row">
                          <label className="sm-move-select-wrap">
                            <span>{t('sp.chooseExistingCategory')}</span>
                            <select
                              aria-label={t('sp.chooseExistingCategory')}
                              value={rowUnit.trim() || rowKp.trim() ? categoryKey(rowUnit, rowKp) : '__uncategorized__'}
                              disabled={!!busyKey}
                              onChange={event => {
                                const val = event.target.value
                                if (val === '__uncategorized__') {
                                  setRowUnit('')
                                  setRowKp('')
                                } else {
                                  const found = normalizedCategories.find(c => categoryKey(c.unit, c.knowledgePoint) === val)
                                  if (found) {
                                    setRowUnit(found.unit)
                                    setRowKp(found.knowledgePoint)
                                  }
                                }
                              }}
                            >
                              <option value="__uncategorized__">{t('sp.uncategorized')}</option>
                              {normalizedCategories.map(cat => {
                                const key = categoryKey(cat.unit, cat.knowledgePoint)
                                return (
                                  <option key={key} value={key}>
                                    {formatCategoryLabel(cat.unit, cat.knowledgePoint)}
                                  </option>
                                )
                              })}
                            </select>
                          </label>
                        </div>
                      )}
                      <form
                        className="sp-inline-cat-edit"
                        onSubmit={event => {
                          event.preventDefault()
                          void saveRowCategory(id, rowUnit, rowKp)
                        }}
                      >
                        <input
                          aria-label={t('sp.unitLabel')}
                          placeholder={t('sp.unitPlaceholder')}
                          value={rowUnit}
                          maxLength={120}
                          disabled={!!busyKey}
                          onChange={event => setRowUnit(event.target.value)}
                        />
                        <input
                          aria-label={t('sp.kpLabel')}
                          placeholder={t('sp.kpPlaceholder')}
                          value={rowKp}
                          maxLength={120}
                          disabled={!!busyKey}
                          onChange={event => setRowKp(event.target.value)}
                        />
                        <button type="submit" className="settings-btn-primary-xs" disabled={!!busyKey}>
                          {t('sp.applyCategory')}
                        </button>
                        {(item.unit || item.knowledgePoint) && (
                          <button
                            type="button"
                            className="settings-btn-secondary-xs"
                            disabled={!!busyKey}
                            onClick={() => void saveRowCategory(id, '', '')}
                          >
                            {t('sp.clearCategory')}
                          </button>
                        )}
                        <button type="button" className="settings-btn-ghost-xs" onClick={() => setCategorizingId(null)}>
                          {t('app.cancel')}
                        </button>
                      </form>
                    </div>
                  )}

                  {isEditing && (
                    <form
                      className="sm-move-drawer sp-edit-drawer"
                      onSubmit={event => void saveQuestionEdit(event, item)}
                      onKeyDown={event => stopEscape(event, () => setEditingId(null))}
                    >
                      <label className="sp-field">
                        <span>{t('sp.editPromptLabel')}</span>
                        <textarea
                          rows={3}
                          value={editPrompt}
                          maxLength={5000}
                          disabled={!!busyKey}
                          onChange={event => setEditPrompt(event.target.value)}
                        />
                      </label>

                      <div className="sp-field-grid">
                        <label className="sp-field">
                          <span>{t('sp.unitLabel')}</span>
                          <input
                            value={editUnit}
                            placeholder={t('sp.unitPlaceholder')}
                            maxLength={120}
                            disabled={!!busyKey}
                            onChange={event => setEditUnit(event.target.value)}
                          />
                        </label>
                        <label className="sp-field">
                          <span>{t('sp.kpLabel')}</span>
                          <input
                            value={editKp}
                            placeholder={t('sp.kpPlaceholder')}
                            maxLength={120}
                            disabled={!!busyKey}
                            onChange={event => setEditKp(event.target.value)}
                          />
                        </label>
                      </div>

                      {item.type === 'true_false' && (
                        <div className="sp-field">
                          <span>{t('sp.editAnswerLabel')}</span>
                          <div className="sp-bool-group">
                            <label>
                              <input
                                type="radio"
                                checked={editBoolAnswer}
                                onChange={() => setEditBoolAnswer(true)}
                              />
                              {t('study.true')}
                            </label>
                            <label>
                              <input
                                type="radio"
                                checked={!editBoolAnswer}
                                onChange={() => setEditBoolAnswer(false)}
                              />
                              {t('study.false')}
                            </label>
                          </div>
                        </div>
                      )}

                      {item.type === 'choice' && (
                        <div className="sp-field">
                          <div className="sp-options-head">
                            <span>{t('sp.editOptionsLabel')}</span>
                            <label className="sp-checkbox-inline">
                              <input
                                type="checkbox"
                                checked={editMultiple}
                                onChange={event => {
                                  const next = event.target.checked
                                  setEditMultiple(next)
                                  if (!next && editChoiceAnswers.length > 1) {
                                    setEditChoiceAnswers([editChoiceAnswers[0]])
                                  }
                                }}
                              />
                              {t('sp.editMultipleLabel')}
                            </label>
                          </div>
                          <div className="sp-options-list">
                            {editOptions.map((opt, optIdx) => {
                              const isCorrect = editChoiceAnswers.includes(opt.id)
                              return (
                                <div key={opt.id} className="sp-option-row">
                                  <input
                                    type={editMultiple ? 'checkbox' : 'radio'}
                                    name={`edit-choice-${id}`}
                                    checked={isCorrect}
                                    onChange={() => {
                                      if (editMultiple) {
                                        setEditChoiceAnswers(prev =>
                                          prev.includes(opt.id) ? prev.filter(x => x !== opt.id) : [...prev, opt.id]
                                        )
                                      } else {
                                        setEditChoiceAnswers([opt.id])
                                      }
                                    }}
                                  />
                                  <span className="sp-option-id">{opt.id.toUpperCase()}</span>
                                  <input
                                    type="text"
                                    value={opt.text}
                                    disabled={!!busyKey}
                                    onChange={event => {
                                      const val = event.target.value
                                      setEditOptions(prev =>
                                        prev.map((o, i) => (i === optIdx ? { ...o, text: val } : o))
                                      )
                                    }}
                                  />
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )}

                      {item.type === 'fill_blank' && (
                        <div className="sp-field-grid">
                          <label className="sp-field">
                            <span>{t('sp.editAnswerLabel')}</span>
                            <input
                              value={editTextAnswer}
                              disabled={!!busyKey}
                              onChange={event => setEditTextAnswer(event.target.value)}
                            />
                          </label>
                          <label className="sp-field">
                            <span>{t('sp.editAcceptedLabel')}</span>
                            <input
                              value={editAccepted}
                              disabled={!!busyKey}
                              onChange={event => setEditAccepted(event.target.value)}
                            />
                          </label>
                        </div>
                      )}

                      {(item.type === 'short_answer' || item.type === 'flashcard') && (
                        <label className="sp-field">
                          <span>{t('sp.editAnswerLabel')}</span>
                          <textarea
                            rows={2}
                            value={editTextAnswer}
                            disabled={!!busyKey}
                            onChange={event => setEditTextAnswer(event.target.value)}
                          />
                        </label>
                      )}

                      {item.type === 'short_answer' && (
                        <label className="sp-field">
                          <span>{t('sp.editRubricLabel')}</span>
                          <textarea
                            rows={2}
                            value={editRubric}
                            disabled={!!busyKey}
                            onChange={event => setEditRubric(event.target.value)}
                          />
                        </label>
                      )}

                      <label className="sp-field">
                        <span>{t('sp.editExplanationLabel')}</span>
                        <textarea
                          rows={2}
                          value={editExplanation}
                          disabled={!!busyKey}
                          onChange={event => setEditExplanation(event.target.value)}
                        />
                      </label>

                      <div className="sp-edit-actions">
                        <button type="submit" className="settings-btn-primary-xs" disabled={!!busyKey || !editPrompt.trim()}>
                          {busyKey === 'edit:' + id ? t('app.saving') : t('sp.saveQuestion')}
                        </button>
                        <button type="button" className="settings-btn-ghost-xs" onClick={() => setEditingId(null)}>
                          {t('app.cancel')}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="sm-batch-bar" role="region" aria-label={t('sm.batchAria')}>
          <span className="sm-batch-count">
            <strong>{t('sp.batchSelected', { count: selectedIds.size })}</strong>
          </span>
          <div className="sm-batch-controls">
            {confirmBatchDelete ? (
              <>
                <span className="sm-batch-warn">{t('sp.batchDeleteWarn')}</span>
                <button
                  type="button"
                  className="sm-batch-btn is-danger"
                  disabled={!!busyKey}
                  onClick={() => void batchDelete()}
                >
                  {busyKey === 'batch-delete' ? t('app.deleting') : t('sp.batchDeleteConfirm', { count: selectedIds.size })}
                </button>
                <button type="button" className="sm-batch-btn" onClick={() => setConfirmBatchDelete(false)}>
                  {t('app.cancel')}
                </button>
              </>
            ) : (
              <>
                <div className="sm-batch-move">
                  <select
                    aria-label={t('sp.batchCategorize')}
                    value={batchCategoryKey}
                    disabled={!!busyKey}
                    onChange={event => setBatchCategoryKey(event.target.value)}
                  >
                    <option value="__uncategorized__">{t('sp.uncategorized')}</option>
                    {normalizedCategories.map(cat => {
                      const key = categoryKey(cat.unit, cat.knowledgePoint)
                      return (
                        <option key={key} value={key}>
                          {formatCategoryLabel(cat.unit, cat.knowledgePoint)}
                        </option>
                      )
                    })}
                  </select>
                  <button
                    type="button"
                    className="sm-batch-btn"
                    disabled={!!busyKey}
                    onClick={() => void batchCategorize()}
                  >
                    {t('sp.batchCategorize')}
                  </button>
                </div>
                <button
                  type="button"
                  className="sm-batch-btn is-danger-soft"
                  disabled={!!busyKey}
                  onClick={() => setConfirmBatchDelete(true)}
                >
                  <Trash2 size={13} />
                  {t('app.delete')}
                </button>
                <button
                  type="button"
                  className="sm-batch-close"
                  aria-label={t('sm.clearSelection')}
                  onClick={() => setSelectedIds(new Set())}
                >
                  <X size={14} />
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
