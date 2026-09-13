import type { PersonalTaskSubmitInput } from '../../../shared/personal-task-types'

export type PersonalTaskDraftInput = Omit<PersonalTaskSubmitInput, 'clientRequestId'>
export type PersonalTaskDraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface PersonalTaskPendingDraft {
  clientRequestId: string
  input: PersonalTaskDraftInput
  createdAt: number
}

interface SubmissionJournal {
  schemaVersion: 1
  activeRequestId?: string
  pending: PersonalTaskPendingDraft[]
}

export class PersonalTaskSubmissionError extends Error {
  constructor(
    public readonly code: 'input_invalid' | 'storage_unavailable' | 'storage_invalid' | 'persistence_failed' | 'request_timed_out' | 'receipt_invalid' | 'receipt_pending',
    message: string,
    public readonly clientRequestId?: string
  ) {
    super(message)
    this.name = 'PersonalTaskSubmissionError'
  }
}

const INPUT_KEYS = new Set(['text', 'businessLineId', 'providerId', 'model', 'routingScope', 'driveMode', 'taskStrategy', 'budgetUsd'])
const INPUT_CHOICES = {
  routingScope: ['fixed', 'provider', 'global'],
  driveMode: ['spark', 'core', 'forge', 'command', 'genesis'],
  taskStrategy: ['view', 'plan', 'execute']
} as const

/** Preserve exact submitted text and target; only omitted optional fields are removed. */
export function freezePersonalTaskInput(value: PersonalTaskDraftInput): PersonalTaskDraftInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !INPUT_KEYS.has(key))) invalidInput()
  if (typeof value.text !== 'string' || !value.text.trim()) invalidInput()
  const input: PersonalTaskDraftInput = { text: value.text }
  copyStringFields(value, input)
  for (const [key, choices] of Object.entries(INPUT_CHOICES)) {
    const option = value[key as keyof typeof INPUT_CHOICES]
    if (option === undefined) continue
    if (typeof option !== 'string' || !(choices as readonly string[]).includes(option)) invalidInput()
    Object.assign(input, { [key]: option })
  }
  if (value.budgetUsd !== undefined) {
    if (typeof value.budgetUsd !== 'number' || !Number.isFinite(value.budgetUsd) || value.budgetUsd < 0) invalidInput()
    input.budgetUsd = value.budgetUsd
  }
  return Object.freeze(input)
}

function copyStringFields(value: Record<string, unknown>, input: PersonalTaskDraftInput): void {
  for (const key of ['businessLineId', 'providerId', 'model'] as const) {
    const field = value[key]
    if (field === undefined) continue
    if (typeof field !== 'string' || !field.trim()) invalidInput()
    input[key] = field
  }
}

function invalidInput(): never {
  throw new PersonalTaskSubmissionError('input_invalid', '任务输入或目标无效，未发起提交。')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(value)
}

function parsePendingDraft(value: unknown): PersonalTaskPendingDraft {
  if (!isRecord(value) || !validRequestId(value.clientRequestId) ||
      typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt <= 0) throw new Error('Invalid pending draft')
  return {
    clientRequestId: value.clientRequestId,
    createdAt: value.createdAt,
    input: freezePersonalTaskInput(value.input as PersonalTaskDraftInput)
  }
}

function parseJournal(raw: string): SubmissionJournal {
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.pending)) throw new Error('Unsupported submission journal')
  const pending = value.pending.map(parsePendingDraft)
  if (new Set(pending.map((draft) => draft.clientRequestId)).size !== pending.length) throw new Error('Duplicate pending request')
  if (value.activeRequestId !== undefined && !pending.some((draft) => draft.clientRequestId === value.activeRequestId)) throw new Error('Missing active request')
  return { schemaVersion: 1, pending, ...(value.activeRequestId ? { activeRequestId: String(value.activeRequestId) } : {}) }
}

/** Failure is blocking: never discard an unknown receipt or silently replace its identity. */
export function readPersonalTaskJournal(storage: PersonalTaskDraftStorage, storageKey: string): SubmissionJournal {
  let raw: string | null
  try { raw = storage.getItem(storageKey) }
  catch { throw new PersonalTaskSubmissionError('storage_unavailable', '无法读取任务提交记录，请保留输入并恢复本地存储后重试。') }
  if (raw === null) return { schemaVersion: 1, pending: [] }
  try { return parseJournal(raw) }
  catch { throw new PersonalTaskSubmissionError('storage_invalid', '任务提交记录无法解析；原记录已保留，尚未发起新的提交。') }
}

function persistJournal(storage: PersonalTaskDraftStorage, storageKey: string, journal: SubmissionJournal, requestId?: string): void {
  try {
    if (!journal.pending.length) {
      storage.removeItem(storageKey)
      if (storage.getItem(storageKey) !== null) throw new Error('Submission journal removal did not persist')
      return
    }
    const encoded = JSON.stringify(journal)
    storage.setItem(storageKey, encoded)
    if (storage.getItem(storageKey) !== encoded) throw new Error('Submission journal write did not persist')
  } catch {
    throw new PersonalTaskSubmissionError('persistence_failed', '任务提交记录未能保存；请保留输入，恢复本地存储后重试。', requestId)
  }
}

export function preparePersonalTaskDraft(options: {
  storage: PersonalTaskDraftStorage; storageKey: string; input: PersonalTaskDraftInput
  newRequest?: boolean; makeRequestId: () => string; now: () => number
}): PersonalTaskPendingDraft {
  const input = freezePersonalTaskInput(options.input)
  const journal = readPersonalTaskJournal(options.storage, options.storageKey)
  const active = journal.pending.find((draft) => draft.clientRequestId === journal.activeRequestId)
  if (!options.newRequest && active && JSON.stringify(active.input) === JSON.stringify(input)) {
    // Reconfirm persistence even when an earlier write succeeded in this renderer.
    persistJournal(options.storage, options.storageKey, journal, active.clientRequestId)
    return active
  }
  const clientRequestId = options.makeRequestId()
  if (!validRequestId(clientRequestId) || journal.pending.some((draft) => draft.clientRequestId === clientRequestId)) invalidInput()
  const draft = parsePendingDraft({ clientRequestId, input, createdAt: options.now() })
  persistJournal(options.storage, options.storageKey, {
    schemaVersion: 1, activeRequestId: clientRequestId, pending: [...journal.pending, draft]
  }, clientRequestId)
  return draft
}

export function confirmPersonalTaskDraft(storage: PersonalTaskDraftStorage, storageKey: string, requestId: string): PersonalTaskPendingDraft {
  const journal = readPersonalTaskJournal(storage, storageKey)
  const draft = journal.pending.find((item) => item.clientRequestId === requestId)
  if (!draft) throw new PersonalTaskSubmissionError('input_invalid', '此提交记录已不存在，请刷新任务回执。', requestId)
  persistJournal(storage, storageKey, journal, requestId)
  return draft
}

export function clearSubmittedPersonalTask(storage: PersonalTaskDraftStorage, storageKey: string, requestId: string): string | undefined {
  try {
    const journal = readPersonalTaskJournal(storage, storageKey)
    const pending = journal.pending.filter((draft) => draft.clientRequestId !== requestId)
    const activeRequestId = journal.activeRequestId === requestId ? undefined : journal.activeRequestId
    persistJournal(storage, storageKey, { schemaVersion: 1, pending, ...(activeRequestId ? { activeRequestId } : {}) }, requestId)
    return undefined
  } catch {
    return '任务已经提交，但本地待确认记录尚未清除。请查询同一提交回执，不要重复创建任务。'
  }
}
