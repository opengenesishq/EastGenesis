import { useEffect, useMemo, useRef, useState } from 'react'
import { AUTO_MODEL, AUTO_PROVIDER_ID } from '../../../../shared/types'
import type { PersonalTaskSubmissionView } from '../../../../shared/personal-task-types'
import { createPersonalTaskSubmissionClient, type PersonalTaskSubmissionRecovery, type PersonalTaskDraftInput } from '../../lib/personal-task-submission'
import { useStore } from '../../store'
import { publishOfficeActionFeedback } from './OfficeActionFeedback'
import { submitOfficeSessionInstruction } from './office-session-commands'

export type OfficeCommandTarget = { kind: 'session'; id: string; title: string } |
  { kind: 'business'; id: string; title: string } | { kind: 'unavailable'; id: string; title: string }

export function useOfficeCommand(target: OfficeCommandTarget, zh: boolean) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const [lastSessionId, setLastSessionId] = useState<string | null>(null)
  const [pending, setPending] = useState<PersonalTaskSubmissionRecovery[]>([])
  const inFlight = useRef(false)
  const current = useRef({ text, target })
  current.current = { text, target }
  const client = useMemo(() => {
    try { return { api: createPersonalTaskSubmissionClient({ storageKey: 'caogen.office.personal-task-submissions.v1' }) } }
    catch (cause) { return { error: String(cause) } }
  }, [])
  const recover = async (): Promise<void> => {
    if (!client.api) { setMessage(client.error ?? '本地任务存储不可用'); setError(true); return }
    try {
      const records = await client.api.recover()
      setPending(records.filter((item) => item.receipt?.status !== 'submitted' || item.pendingCleanupError))
      for (const item of records) {
        if (item.receipt?.status === 'submitted' && commandInputMatches(current.current, item.draft.input)) setText('')
        if (item.receipt?.binding?.sessionId) await useStore.getState().syncSession(item.receipt.binding.sessionId)
      }
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); setError(true) }
  }
  useEffect(() => { void recover() }, [client])
  const handleReceipt = async (receipt: PersonalTaskSubmissionView, cleanupError?: string): Promise<boolean> => {
    const id = receipt.binding?.sessionId
    let hydrationWarning: string | undefined
    if (id) {
      setLastSessionId(id)
      try { await useStore.getState().syncSession(id) }
      catch { hydrationWarning = zh ? '任务已保留，详情暂未刷新；可打开原任务查看。' : 'The task is saved; its details could not refresh. Open the original task.' }
    }
    const outcome = receiptMessage(receipt, zh)
    setMessage([outcome, cleanupError, hydrationWarning].filter(Boolean).join(' '))
    setError(receipt.status === 'needs_reconciliation' || receipt.status === 'not_sent')
    if (id) publishOfficeActionFeedback({ sessionId: id, title: receipt.session?.title ?? target.title, text: outcome })
    return receipt.status === 'submitted'
  }
  const dispatch = async (retryId?: string): Promise<boolean> => {
    if (retryId || target.kind === 'business') {
      if (!client.api) throw new Error(client.error ?? '本地任务存储不可用')
      const result = retryId ? await client.api.retry(retryId) : await client.api.submit({ text: text.trim(),
        businessLineId: target.id, providerId: AUTO_PROVIDER_ID, model: AUTO_MODEL, routingScope: 'global' })
      return handleReceipt(result.receipt, result.pendingCleanupError)
    }
    await submitOfficeSessionInstruction(target.id, text.trim(), zh)
    setLastSessionId(target.id)
    setMessage(zh ? '补充要求已提交，执行结果将在同一任务更新。' : 'Instruction submitted; this task will report its outcome.')
    return true
  }
  const send = async (retryId?: string): Promise<void> => {
    if (inFlight.current || (!retryId && (!text.trim() || target.kind === 'unavailable'))) return
    const captured = { text, target }
    inFlight.current = true; setBusy(true); setError(false); setMessage(''); setLastSessionId(null)
    try {
      const retryInput = retryId ? client.api?.pendingDrafts().find((draft) => draft.clientRequestId === retryId)?.input : undefined
      const accepted = await dispatch(retryId)
      if (accepted && shouldClearCommand(current.current, captured, retryId, retryInput)) setText('')
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); setError(true) }
    finally { inFlight.current = false; setBusy(false); void recover() }
  }
  return { text, setText, busy, message, error, lastSessionId, pending, recover, send }
}

function receiptMessage(receipt: PersonalTaskSubmissionView, zh: boolean): string {
  if (receipt.status === 'submitted') return zh ? '任务已接收，尚未代表完成；可留在场内观察或查看任务。' : 'Task accepted, with completion still pending. Watch here or open the task.'
  if (receipt.status === 'needs_reconciliation') return zh ? '首条指令的结果尚未确认，请先查询原提交回执。' : 'The first instruction has an unknown outcome. Check the original receipt.'
  if (receipt.status === 'not_sent') return receipt.error?.message ?? (zh ? '指令尚未发送，可重试原提交。' : 'The instruction was not sent. Retry the original submission.')
  return zh ? '任务正在准备，提交身份已保留；可查询或重试原提交。' : 'Task preparation is pending. Its identity is saved for inspection or retry.'
}

function commandInputMatches(current: { text: string; target: OfficeCommandTarget }, input: PersonalTaskDraftInput): boolean {
  return current.target.kind === 'business' && input.text === current.text.trim() && input.businessLineId === current.target.id &&
    input.providerId === AUTO_PROVIDER_ID && input.model === AUTO_MODEL && input.routingScope === 'global'
}

function shouldClearCommand(current: { text: string; target: OfficeCommandTarget }, captured: typeof current, retryId?: string, retryInput?: PersonalTaskDraftInput): boolean {
  if (retryId) return Boolean(retryInput && commandInputMatches(current, retryInput))
  return current.text === captured.text && current.target.kind === captured.target.kind && current.target.id === captured.target.id
}
