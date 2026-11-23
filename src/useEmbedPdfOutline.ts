import { useCallback, useEffect, useRef, useState } from 'react'
import type { Viewer } from '@embedpdf/viewer-react'
import type { OutlineItem, OutlineItemRef } from '@embedpdf/engine-core'
import { HistoryToken } from '@embedpdf/react/history'
import { OutlineToken } from '@embedpdf/react/outline'
import {
  stableOutlineSignature,
  type PdfOutlineGenerationState,
  type PdfOutlineNode,
} from '../shared/pdf-outline.mjs'
import { tCurrent } from './i18n'

export type EmbedPdfOutlineUpdate = { sourceId: string; revision: number }
type Props = {
  viewer: Viewer | null
  courseId: string
  sourceId: string
  locale?: string
  readyForWrites: boolean
  outlineUpdates?: EmbedPdfOutlineUpdate
}
type OutlineSyncState = {
  hasCustomOutline: boolean
  customItems: PdfOutlineNode[] | null
  fallbackNeeded: boolean
  generation: PdfOutlineGenerationState
}
export type UseEmbedPdfOutlineResult = OutlineSyncState & {
  regenerate: () => Promise<void>
  dismissError: () => void
}

const IDLE_GENERATION: PdfOutlineGenerationState = { status: 'idle', error: null }

function normalizeGeneration(raw: unknown): PdfOutlineGenerationState {
  if (!raw || typeof raw !== 'object') return IDLE_GENERATION
  const value = raw as Record<string, unknown>
  const status = value.status
  if (status !== 'idle' && status !== 'generating' && status !== 'ready' && status !== 'failed') {
    return IDLE_GENERATION
  }
  return {
    status,
    requestId: typeof value.requestId === 'string' ? value.requestId : null,
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    error: typeof value.error === 'string' && value.error ? value.error : null,
  }
}

function outlineItemsToNodes(
  viewer: Viewer,
  docId: string,
  items: readonly OutlineItem[]
): PdfOutlineNode[] {
  const byParent = new Map<number | null, OutlineItem[]>()
  for (const item of items) {
    const key = item.parent ? item.parent.objectNumber : null
    let bucket = byParent.get(key)
    if (!bucket) {
      bucket = []
      byParent.set(key, bucket)
    }
    bucket.push(item)
  }
  const build = (parentKey: number | null): PdfOutlineNode[] => {
    const list = byParent.get(parentKey) || []
    return list.map(item => {
      let page = 1
      if (item.target?.kind === 'goto') {
        const idx = viewer.documents.getPageIndex(item.target.destination.page, docId)
        if (idx >= 0) page = idx + 1
      }
      const children = build(item.ref.objectNumber)
      return children.length ? { title: item.title, page, children } : { title: item.title, page }
    })
  }
  return build(null)
}

export function useEmbedPdfOutline({
  viewer,
  courseId,
  sourceId,
  locale = 'zh-CN',
  readyForWrites,
  outlineUpdates,
}: Props): UseEmbedPdfOutlineResult {
  const [state, setState] = useState<OutlineSyncState>({
    hasCustomOutline: false,
    customItems: null,
    fallbackNeeded: false,
    generation: IDLE_GENERATION,
  })
  const [pollTick, setPollTick] = useState(0)
  const originalSnapshotRef = useRef<PdfOutlineNode[] | null>(null)
  const appliedCustomRef = useRef(false)
  const applyQueueRef = useRef<Promise<void>>(Promise.resolve())
  const dismissedErrorKeyRef = useRef<string | null>(null)
  const scopeKeyRef = useRef(`${courseId}:${sourceId}`)
  const revision = outlineUpdates?.sourceId === sourceId ? outlineUpdates.revision : 0

  useEffect(() => {
    scopeKeyRef.current = `${courseId}:${sourceId}`
    originalSnapshotRef.current = null
    appliedCustomRef.current = false
    dismissedErrorKeyRef.current = null
    setPollTick(0)
    setState({
      hasCustomOutline: false,
      customItems: null,
      fallbackNeeded: false,
      generation: IDLE_GENERATION,
    })
  }, [courseId, sourceId])

  useEffect(() => {
    if (state.generation.status !== 'generating') return
    const timer = window.setTimeout(() => setPollTick(n => n + 1), 1500)
    return () => window.clearTimeout(timer)
  }, [state.generation.status, pollTick])

  useEffect(() => {
    if (!viewer || !readyForWrites) return
    let alive = true
    const abort = new AbortController()
    const currentScopeKey = `${courseId}:${sourceId}`

    async function sync() {
      const active = viewer!.documents.getActive()
      if (!active || active.status !== 'ready') return
      const docId = active.id
      const response = await fetch(
        `/api/courses/${encodeURIComponent(courseId)}/pdf-outline?` +
          new URLSearchParams({ sourceId }),
        { signal: abort.signal }
      )
      if (!response.ok || !alive) return
      const data = await response.json()
      if (!alive || scopeKeyRef.current !== currentScopeKey) return

      const hasCustom = Boolean(data?.hasCustomOutline && Array.isArray(data?.items))
      const customItems: PdfOutlineNode[] | null = hasCustom ? data.items : null
      let generation = normalizeGeneration(data?.generation)
      const errorKey =
        generation.status === 'failed'
          ? `${generation.requestId || ''}:${generation.updatedAt || ''}:${generation.error || ''}`
          : null
      if (errorKey && dismissedErrorKeyRef.current === errorKey) {
        generation = { ...generation, error: null }
      }

      const applyTask = applyQueueRef.current
        .catch(() => {})
        .then(async () => {
          if (!alive || abort.signal.aborted || scopeKeyRef.current !== currentScopeKey) return
          const scope = viewer!.forDocument(docId)
          const outline = scope.tryGet(OutlineToken)
          if (!outline) {
            if (alive) {
              setState({
                hasCustomOutline: hasCustom,
                customItems,
                fallbackNeeded: hasCustom,
                generation,
              })
            }
            return
          }
          await outline.ensureLoaded({ signal: abort.signal })
          if (!alive || abort.signal.aborted) return

          if (originalSnapshotRef.current === null) {
            originalSnapshotRef.current = outlineItemsToNodes(viewer!, docId, outline.list())
          }

          if (!hasCustom && !appliedCustomRef.current) {
            if (alive) {
              setState({
                hasCustomOutline: false,
                customItems: null,
                fallbackNeeded: false,
                generation,
              })
            }
            return
          }

          const targetItems = hasCustom ? customItems! : originalSnapshotRef.current || []
          if (!outline.canEdit()) {
            if (alive) {
              setState({
                hasCustomOutline: hasCustom,
                customItems,
                fallbackNeeded: hasCustom,
                generation,
              })
            }
            return
          }

          const currentNodes = outlineItemsToNodes(viewer!, docId, outline.list())
          if (stableOutlineSignature(currentNodes) === stableOutlineSignature(targetItems)) {
            appliedCustomRef.current = hasCustom
            if (alive) {
              setState({
                hasCustomOutline: hasCustom,
                customItems,
                fallbackNeeded: false,
                generation,
              })
            }
            return
          }

          const topLevel = outline.getChildren(null)
          if (topLevel.length) {
            await outline.delete(
              topLevel.map(item => item.ref),
              { signal: abort.signal }
            )
          }
          if (!alive || abort.signal.aborted) return

          const createdParentsToExpand: OutlineItemRef[] = []
          const insertNodes = async (
            nodes: readonly PdfOutlineNode[],
            parent: OutlineItemRef | null,
            depth: number
          ) => {
            for (const node of nodes) {
              if (!alive || abort.signal.aborted) return
              const clampedIndex = Math.max(0, Math.min(active.pageCount - 1, (node.page || 1) - 1))
              const pageInfo = viewer!.documents.getPage(clampedIndex, docId)
              const target = pageInfo
                ? { kind: 'goto' as const, destination: { kind: 'fit' as const, page: pageInfo.ref } }
                : null
              const { item } = await outline.create(
                { title: node.title, parent, target },
                { signal: abort.signal }
              )
              if (Array.isArray(node.children) && node.children.length) {
                await insertNodes(node.children, item.ref, depth + 1)
                if (depth === 0) createdParentsToExpand.push(item.ref)
              }
            }
          }

          await insertNodes(targetItems, null, 0)
          if (!alive || abort.signal.aborted) return
          for (const ref of createdParentsToExpand) {
            outline.expand(ref)
          }
          scope.tryGet(HistoryToken)?.clear()
          appliedCustomRef.current = hasCustom
          if (alive) {
            setState({
              hasCustomOutline: hasCustom,
              customItems,
              fallbackNeeded: false,
              generation,
            })
          }
        })
      applyQueueRef.current = applyTask
      await applyTask
    }

    const run = () => {
      void sync().catch(() => {})
    }
    const stopOpened = viewer.documents.onOpened(run)
    run()
    return () => {
      alive = false
      abort.abort()
      stopOpened()
    }
  }, [viewer, courseId, sourceId, readyForWrites, revision, pollTick])

  const regenerate = useCallback(async () => {
    const requestScope = `${courseId}:${sourceId}`
    dismissedErrorKeyRef.current = null
    setState(previous => ({
      ...previous,
      generation: {
        status: 'generating',
        requestId: previous.generation.requestId ?? null,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: null,
      },
    }))
    try {
      const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/pdf-outline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'regenerate', sourceId, locale }),
      })
      const data = await response.json().catch(() => ({}))
      if (scopeKeyRef.current !== requestScope) return
      if (!response.ok) {
        throw new Error(data?.error || tCurrent('pdf.regenerateBookmarksFailed'))
      }
      const nextGeneration = normalizeGeneration(data?.generation)
      setState(previous => ({
        ...previous,
        generation: nextGeneration.status === 'idle' ? { status: 'generating', error: null } : nextGeneration,
      }))
      setPollTick(n => n + 1)
    } catch (error) {
      if (scopeKeyRef.current !== requestScope) return
      const message =
        error instanceof Error && error.message
          ? error.message
          : tCurrent('pdf.regenerateBookmarksFailed')
      setState(previous => ({
        ...previous,
        generation: {
          status: 'failed',
          updatedAt: new Date().toISOString(),
          error: message,
        },
      }))
    }
  }, [courseId, sourceId, locale])

  const dismissError = useCallback(() => {
    setState(previous => {
      if (previous.generation.status !== 'failed') return previous
      dismissedErrorKeyRef.current = `${previous.generation.requestId || ''}:${previous.generation.updatedAt || ''}:${previous.generation.error || ''}`
      return {
        ...previous,
        generation: { ...previous.generation, error: null },
      }
    })
  }, [])

  return { ...state, regenerate, dismissError }
}
