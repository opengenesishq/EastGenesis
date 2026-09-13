import type { PersonalTaskApi, PersonalTaskSubmissionView } from '../../../shared/personal-task-types'
import {
  clearSubmittedPersonalTask,
  confirmPersonalTaskDraft,
  freezePersonalTaskInput,
  PersonalTaskSubmissionError,
  preparePersonalTaskDraft,
  readPersonalTaskJournal,
  type PersonalTaskDraftInput,
  type PersonalTaskDraftStorage,
  type PersonalTaskPendingDraft
} from './personal-task-submission-storage'

export { PersonalTaskSubmissionError }
export type { PersonalTaskDraftInput, PersonalTaskDraftStorage, PersonalTaskPendingDraft }

export interface PersonalTaskSubmissionResult {
  receipt: PersonalTaskSubmissionView
  /** A confirmed submission remains successful even if local cleanup must be retried. */
  pendingCleanupError?: string
}

export interface PersonalTaskSubmissionRecovery {
  draft: PersonalTaskPendingDraft
  receipt: PersonalTaskSubmissionView | null
  pendingCleanupError?: string
  error?: string
}

export interface PersonalTaskSubmissionClient {
  currentDraft(): PersonalTaskPendingDraft | null
  pendingDrafts(): PersonalTaskPendingDraft[]
  /** Call only for an explicit send action. An edited input or target receives a new ID. */
  submit(input: PersonalTaskDraftInput, options?: { newRequest?: boolean }): Promise<PersonalTaskSubmissionResult>
  /** Retry the exact saved input; it never takes replacement text or a replacement target. */
  retry(clientRequestId: string): Promise<PersonalTaskSubmissionResult>
  /** Safe on mount and after a timeout: queries receipts without submitting anything. */
  recover(): Promise<PersonalTaskSubmissionRecovery[]>
}

interface ClientOptions {
  storageKey: string
  api?: PersonalTaskApi
  storage?: PersonalTaskDraftStorage
  timeoutMs?: number
  makeRequestId?: () => string
  now?: () => number
}

interface ClientContext {
  storageKey: string
  api: PersonalTaskApi
  storage: PersonalTaskDraftStorage
  timeoutMs: number
}

const pendingCalls = new WeakMap<PersonalTaskDraftStorage, Map<string, Promise<PersonalTaskSubmissionResult>>>()
const SUBMISSION_STATUSES = new Set(['preparing', 'ready', 'submitted', 'not_sent', 'needs_reconciliation'])

/** Independent storageKey per surface. This client never changes navigation or starts a second execution engine. */
export function createPersonalTaskSubmissionClient(options: ClientOptions): PersonalTaskSubmissionClient {
  const context = resolveContext(options)
  return {
    currentDraft() {
      const journal = readPersonalTaskJournal(context.storage, context.storageKey)
      return journal.pending.find((draft) => draft.clientRequestId === journal.activeRequestId) ?? null
    },
    pendingDrafts() { return readPersonalTaskJournal(context.storage, context.storageKey).pending },
    async submit(input, requestOptions) {
      const draft = preparePersonalTaskDraft({
        ...context, input, newRequest: requestOptions?.newRequest,
        makeRequestId: options.makeRequestId ?? (() => globalThis.crypto.randomUUID()),
        now: options.now ?? Date.now
      })
      return submitPreparedDraft(context, draft)
    },
    async retry(clientRequestId) {
      return submitPreparedDraft(context, confirmPersonalTaskDraft(context.storage, context.storageKey, clientRequestId))
    },
    async recover() {
      const drafts = readPersonalTaskJournal(context.storage, context.storageKey).pending
      return Promise.all(drafts.map((draft) => recoverDraft(context, draft)))
    }
  }
}

function resolveContext(options: ClientOptions): ClientContext {
  if (!options.storageKey.trim()) throw new PersonalTaskSubmissionError('input_invalid', '任务提交区域缺少独立存储标识。')
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new PersonalTaskSubmissionError('input_invalid', '任务提交超时配置无效。')
  let storage: PersonalTaskDraftStorage
  try { storage = options.storage ?? window.localStorage }
  catch { throw new PersonalTaskSubmissionError('storage_unavailable', '本地任务存储不可用，请保留输入后重试。') }
  return { storageKey: options.storageKey, storage, timeoutMs, api: options.api ?? window.agentDesk }
}

function submitPreparedDraft(context: ClientContext, draft: PersonalTaskPendingDraft): Promise<PersonalTaskSubmissionResult> {
  let calls = pendingCalls.get(context.storage)
  if (!calls) { calls = new Map(); pendingCalls.set(context.storage, calls) }
  const key = `${context.storageKey}\0${draft.clientRequestId}`
  const existing = calls.get(key)
  if (existing) return existing
  const pending = queryThenSubmit(context, draft).finally(() => { calls!.delete(key) })
  calls.set(key, pending)
  return pending
}

async function queryThenSubmit(context: ClientContext, draft: PersonalTaskPendingDraft): Promise<PersonalTaskSubmissionResult> {
  const previous = await queryReceipt(context, draft.clientRequestId)
  if (previous && ['submitted', 'needs_reconciliation'].includes(previous.status)) return settleReceipt(context, previous)
  // Explicit retries hand preparing back to the backend owner gate; recovery never creates or sends.
  const receipt = await withSubmissionTimeout(
    context.api.submitPersonalTask({ ...freezePersonalTaskInput(draft.input), clientRequestId: draft.clientRequestId }),
    context.timeoutMs,
    draft.clientRequestId
  )
  assertReceipt(receipt, draft.clientRequestId)
  return settleReceipt(context, receipt)
}

async function queryReceipt(context: ClientContext, requestId: string): Promise<PersonalTaskSubmissionView | null> {
  const receipt = await withSubmissionTimeout(context.api.getPersonalTaskSubmission(requestId), context.timeoutMs, requestId)
  if (receipt) assertReceipt(receipt, requestId)
  return receipt
}

function settleReceipt(context: ClientContext, receipt: PersonalTaskSubmissionView): PersonalTaskSubmissionResult {
  if (receipt.status !== 'submitted') return { receipt }
  const pendingCleanupError = clearSubmittedPersonalTask(context.storage, context.storageKey, receipt.clientRequestId)
  return { receipt, ...(pendingCleanupError ? { pendingCleanupError } : {}) }
}

async function recoverDraft(context: ClientContext, draft: PersonalTaskPendingDraft): Promise<PersonalTaskSubmissionRecovery> {
  try {
    const receipt = await queryReceipt(context, draft.clientRequestId)
    const result = receipt ? settleReceipt(context, receipt) : { receipt: null }
    return { draft, ...result }
  } catch (error) {
    return { draft, receipt: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function assertReceipt(receipt: PersonalTaskSubmissionView, requestId: string): void {
  const identityMatches = receipt && receipt.clientRequestId === requestId &&
    Number.isSafeInteger(receipt.revision) && receipt.revision >= 0 && SUBMISSION_STATUSES.has(receipt.status)
  if (!identityMatches || (receipt.status === 'submitted' && !completeBinding(receipt))) {
    throw new PersonalTaskSubmissionError('receipt_invalid', '任务回执与提交身份不一致；待确认记录已保留。', requestId)
  }
}

function completeBinding(receipt: PersonalTaskSubmissionView): boolean {
  if (!receipt.binding || !receipt.messageId) return false
  return [receipt.binding.workspaceId, receipt.binding.goalId, receipt.binding.workItemId, receipt.binding.sessionId]
    .every((value) => typeof value === 'string' && value.trim().length > 0)
}

function withSubmissionTimeout<T>(operation: Promise<T>, timeoutMs: number, requestId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PersonalTaskSubmissionError(
      'request_timed_out', '任务回执尚未确认。提交记录已保留，请先查询回执或重试同一提交。', requestId
    )), timeoutMs)
    operation.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}
