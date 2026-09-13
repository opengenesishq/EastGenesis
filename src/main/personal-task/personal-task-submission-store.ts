import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MANAGED_PERSONAL_WORKSPACE_ID } from '../../shared/project-workspace-types'
import type { PersonalTaskBinding, PersonalTaskSubmitInput } from '../../shared/personal-task-types'
import { writeDurableFileSync } from '../durable-file'
import { goalTaskIds } from '../project-workspace/goal-task-service'
import { parsePersonalTaskExecution, type PersonalTaskExecutionContext } from './personal-task-execution'
import {
  normalizePersonalTaskInput, personalTaskCanonicalRequestId,
  personalTaskInputDigest, personalTaskRequestId, PersonalTaskSubmissionError
} from './personal-task-input'

export type PersonalTaskSubmissionPhase =
  | 'reserved' | 'task_created' | 'session_ready' | 'dispatching'
  | 'submitted' | 'not_sent' | 'needs_reconciliation'

/** An idempotency/recovery index. Goal, WorkItem, Run and transcript remain authoritative. */
export interface PersonalTaskSubmissionRecord {
  schemaVersion: 1
  clientRequestId: string
  input: PersonalTaskSubmitInput
  inputDigest: string
  execution: PersonalTaskExecutionContext
  binding: PersonalTaskBinding
  messageId: string
  phase: PersonalTaskSubmissionPhase
  revision: number
  createdAt: number
  updatedAt: number
  taskCreatedAt?: number
  sessionCreatedAt?: number
  dispatchClaimedAt?: number
  sdkSessionId?: string
  runId?: string
  error?: { code: string; message: string }
}

const PHASES: readonly PersonalTaskSubmissionPhase[] = [
  'reserved', 'task_created', 'session_ready', 'dispatching', 'submitted', 'not_sent', 'needs_reconciliation'
]

export class PersonalTaskSubmissionStore {
  constructor(private readonly rootDir: string) {}

  read(clientRequestId: string): PersonalTaskSubmissionRecord | null {
    const id = personalTaskRequestId(clientRequestId)
    let raw: string
    try { raw = readFileSync(this.path(id), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const record = parseRecord(JSON.parse(raw))
    if (record.clientRequestId !== id) corrupt('回执标识与文件不一致')
    return record
  }

  list(): PersonalTaskSubmissionRecord[] {
    let files: string[]
    try { files = readdirSync(join(this.rootDir, 'private', 'personal-task-submissions')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).map((file) => {
      const record = parseRecord(JSON.parse(readFileSync(join(this.rootDir, 'private', 'personal-task-submissions', file), 'utf8')))
      if (this.path(record.clientRequestId) !== join(this.rootDir, 'private', 'personal-task-submissions', file)) corrupt('回执文件身份不一致')
      return record
    })
  }

  reserve(input: PersonalTaskSubmitInput, execution: PersonalTaskExecutionContext): PersonalTaskSubmissionRecord {
    const existing = this.read(input.clientRequestId)
    if (existing) return assertMatchingPersonalTaskInput(existing, input)
    const now = Date.now()
    const sessionId = randomUUID()
    const record: PersonalTaskSubmissionRecord = {
      schemaVersion: 1, clientRequestId: input.clientRequestId, input,
      inputDigest: personalTaskInputDigest(input),
      execution,
      binding: {
        workspaceId: MANAGED_PERSONAL_WORKSPACE_ID,
        ...goalTaskIds(MANAGED_PERSONAL_WORKSPACE_ID, personalTaskCanonicalRequestId(input.clientRequestId)),
        sessionId
      },
      messageId: `personal-task:${sessionId}:first`, phase: 'reserved', revision: 1,
      createdAt: now, updatedAt: now
    }
    // No canonical creation or engine activation may precede this durable reservation.
    writeDurableFileSync(this.path(input.clientRequestId), JSON.stringify(record), { replace: false })
    return record
  }

  update(
    record: PersonalTaskSubmissionRecord,
    patch: Pick<PersonalTaskSubmissionRecord, 'phase'> & Partial<Pick<PersonalTaskSubmissionRecord,
      'sdkSessionId' | 'runId' | 'error' | 'taskCreatedAt' | 'sessionCreatedAt' | 'dispatchClaimedAt'>>
  ): PersonalTaskSubmissionRecord {
    const current = this.read(record.clientRequestId)
    if (!current || current.revision !== record.revision) {
      throw new PersonalTaskSubmissionError('PERSONAL_TASK_RECEIPT_CONFLICT', '提交回执已变化，请重新读取')
    }
    const next = parseRecord({ ...current, ...patch, revision: current.revision + 1, updatedAt: Date.now() })
    writeDurableFileSync(this.path(record.clientRequestId), JSON.stringify(next))
    return next
  }

  private path(clientRequestId: string): string {
    const key = personalTaskCanonicalRequestId(clientRequestId).slice('personal-task:'.length)
    return join(this.rootDir, 'private', 'personal-task-submissions', `${key}.json`)
  }
}

export function assertMatchingPersonalTaskInput(
  record: PersonalTaskSubmissionRecord, input: PersonalTaskSubmitInput
): PersonalTaskSubmissionRecord {
  if (record.inputDigest !== personalTaskInputDigest(input)) {
    throw new PersonalTaskSubmissionError('PERSONAL_TASK_REQUEST_CONFLICT', '相同提交标识不能用于不同任务内容或配置')
  }
  return record
}

function parseRecord(value: unknown): PersonalTaskSubmissionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) corrupt('回执不是对象')
  const record = value as Partial<PersonalTaskSubmissionRecord>
  const input = normalizePersonalTaskInput(record.input)
  if (record.schemaVersion !== 1 || record.clientRequestId !== input.clientRequestId ||
      record.inputDigest !== personalTaskInputDigest(input) || !PHASES.includes(record.phase!)) corrupt('回执内容不完整')
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 1 ||
      !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)) corrupt('回执版本无效')
  assertBinding(record.binding, input.clientRequestId)
  if (record.messageId !== `personal-task:${record.binding!.sessionId}:first`) corrupt('首条消息身份不一致')
  assertOptionalRecordFields(record)
  return { ...record, input, execution: parsePersonalTaskExecution(record.execution, input) } as PersonalTaskSubmissionRecord
}

function assertBinding(binding: PersonalTaskBinding | undefined, clientRequestId: string): void {
  const expected = goalTaskIds(MANAGED_PERSONAL_WORKSPACE_ID, personalTaskCanonicalRequestId(clientRequestId))
  if (!binding || binding.workspaceId !== MANAGED_PERSONAL_WORKSPACE_ID ||
      binding.goalId !== expected.goalId || binding.workItemId !== expected.workItemId ||
      !/^[a-f0-9-]{36}$/.test(binding.sessionId)) corrupt('任务归属不一致')
}

function assertOptionalRecordFields(record: Partial<PersonalTaskSubmissionRecord>): void {
  for (const key of ['taskCreatedAt', 'sessionCreatedAt', 'dispatchClaimedAt'] as const) {
    if (record[key] !== undefined && !Number.isFinite(record[key])) corrupt(`${key}无效`)
  }
  for (const key of ['sdkSessionId', 'runId'] as const) {
    if (record[key] !== undefined && (typeof record[key] !== 'string' || !record[key] || record[key]!.length > 200)) corrupt(`${key}无效`)
  }
  if (record.error && (typeof record.error.code !== 'string' || typeof record.error.message !== 'string')) corrupt('错误回执无效')
}

function corrupt(message: string): never {
  throw new PersonalTaskSubmissionError('PERSONAL_TASK_RECEIPT_CORRUPT', `个人任务回执损坏：${message}`)
}
