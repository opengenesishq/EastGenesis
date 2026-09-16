import { useCallback, useEffect, useRef, useState } from 'react'
import type { SendMessagePayload } from '../../../../shared/types'
import type { SessionInputRecord } from '../../../../shared/session-input-types'
import { useStore } from '../../store'
import { COMPOSER_DRAFTS_DELETED_EVENT, isDeletedComposerDraft } from '../../store/composer-draft-persistence'
import { REQUIREMENTS_CHANGED_EVENT, announceRequirementRevision } from '../experience/requirement-revision-events'

export function useSessionInputs(sessionId: string | null, running: boolean) {
  const [state, setState] = useState<{ sessionId: string | null; records: SessionInputRecord[] }>({ sessionId, records: [] })
  const [errorState, setErrorState] = useState<{ sessionId: string | null; message: string }>({ sessionId, message: '' })
  const [busy, setBusy] = useState<string | null>(null)
  const [loadedGeneration, setLoadedGeneration] = useState(-1)
  const operation = useRef(false)
  const refreshSequence = useRef(0)
  const currentSessionId = useRef(sessionId)
  const sessionGeneration = useRef(0)
  if (currentSessionId.current !== sessionId) sessionGeneration.current++
  currentSessionId.current = sessionId
  const records = state.sessionId === sessionId ? state.records : []
  const error = errorState.sessionId === sessionId ? errorState.message : ''
  const refresh = useCallback(async () => {
    if (!sessionId) return
    const sequence = ++refreshSequence.current
    try {
      const records = await window.agentDesk.listSessionInputs(sessionId)
      if (currentSessionId.current !== sessionId || sequence !== refreshSequence.current) return
      setState({ sessionId, records })
      setLoadedGeneration(sessionGeneration.current)
      setErrorState({ sessionId, message: '' })
    } catch (cause) {
      if (currentSessionId.current === sessionId && sequence === refreshSequence.current) {
        setErrorState({ sessionId, message: errorText(cause) })
      }
      throw cause
    }
  }, [sessionId])

  useEffect(() => {
    void refresh().catch(() => undefined)
    const changed = (event: Event): void => { if ((event as CustomEvent<{ sessionId: string }>).detail?.sessionId === sessionId) void refresh().catch(() => undefined) }
    window.addEventListener(REQUIREMENTS_CHANGED_EVENT, changed)
    return () => window.removeEventListener(REQUIREMENTS_CHANGED_EVENT, changed)
  }, [refresh, running, sessionId])

  useEffect(() => {
    const clear = (): void => {
      if (!sessionId || !isDeletedComposerDraft(sessionId)) return
      refreshSequence.current++
      setState({ sessionId, records: [] })
      setLoadedGeneration(-1)
    }
    window.addEventListener(COMPOSER_DRAFTS_DELETED_EVENT, clear)
    return () => window.removeEventListener(COMPOSER_DRAFTS_DELETED_EVENT, clear)
  }, [sessionId])

  const queueRecord = async (payload: SendMessagePayload): Promise<SessionInputRecord> => {
    if (!sessionId) throw new Error('请先选择当前任务')
    if (isDeletedComposerDraft(sessionId)) throw new Error('当前任务已删除')
    const key = `caogen.session-input-request.v1:${sessionId}`
    const serialized = JSON.stringify(payload)
    const raw = window.localStorage.getItem(key)
    let pending: { id: string; payload: string } | null = raw ? JSON.parse(raw) : null
    if (pending && (typeof pending.id !== 'string' || typeof pending.payload !== 'string')) throw new Error('补充要求的提交记录无效')
    if (pending && pending.payload !== serialized) {
      const saved = await window.agentDesk.listSessionInputs(sessionId)
      if (!saved.some((record) => record.id === pending!.id)) throw new Error('上一次补充要求的保存结果尚未确认，请先恢复原文重试')
      pending = null
    }
    pending ??= { id: crypto.randomUUID(), payload: serialized }
    // Preserve the same request identity if IPC response or renderer is lost.
    if (isDeletedComposerDraft(sessionId)) throw new Error('当前任务已删除')
    window.localStorage.setItem(key, JSON.stringify(pending))
    const record = await window.agentDesk.queueSessionInput(sessionId, pending.id, payload)
    if (record.sessionId !== sessionId || record.id !== pending.id) throw new Error('补充要求回执身份不一致')
    if (currentSessionId.current === sessionId && !isDeletedComposerDraft(sessionId)) {
      refreshSequence.current++
      setState((current) => ({ sessionId, records: [...(current.sessionId === sessionId ? current.records : []).filter((item) => item.id !== record.id), record] }))
    }
    window.localStorage.removeItem(key)
    if (currentSessionId.current === sessionId) void refresh().catch(() => undefined)
    return record
  }

  const queue = async (payload: SendMessagePayload): Promise<void> => { await queueRecord(payload) }

  const act = async (record: SessionInputRecord, action: 'apply' | 'cancel'): Promise<void> => {
    if (operation.current || record.sessionId !== sessionId) return
    operation.current = true
    setBusy(record.id)
    setErrorState({ sessionId, message: '' })
    try {
      const updated = action === 'apply'
        ? await window.agentDesk.applySessionInput(record.sessionId, record.id)
        : await window.agentDesk.cancelSessionInput(record.sessionId, record.id)
      if (currentSessionId.current === record.sessionId) refreshSequence.current++
      if (updated.sessionId !== record.sessionId || updated.id !== record.id) throw new Error('补充要求回执身份不一致')
      setState((current) => currentSessionId.current === record.sessionId && current.sessionId === record.sessionId
        ? { sessionId: current.sessionId, records: current.records.map((item) => item.id === updated.id ? updated : item) }
        : current)
      if (action === 'apply') await useStore.getState().syncSession(record.sessionId)
      if (updated.phase === 'requirements_applied') announceRequirementRevision(record.sessionId)
    } catch (cause) {
      if (currentSessionId.current === sessionId) setErrorState({ sessionId, message: errorText(cause) })
    } finally {
      operation.current = false
      setBusy(null)
    }
  }

  return { records, queue, queueRecord, busy, error, ready: loadedGeneration === sessionGeneration.current && state.sessionId === sessionId, refresh,
    apply: (record: SessionInputRecord) => act(record, 'apply'), cancel: (record: SessionInputRecord) => act(record, 'cancel') }
}

function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
