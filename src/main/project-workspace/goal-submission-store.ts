import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectGoalTaskPrepareInput, ProjectGoalTaskStartDecision } from '../../shared/project-workspace-types'
import { writeDurableFileSync } from '../durable-file'
import { goalTaskIds, normalizeProjectGoalTaskInput } from './goal-task-service'

/** Recovery index only. The canonical task, Session and plan own their content and state. */
export interface ProjectGoalSubmissionRecord {
  schemaVersion: 1
  input: ProjectGoalTaskPrepareInput
  digest: string
  sessionId: string
  startDecision?: ProjectGoalTaskStartDecision
  phase: 'reserved' | 'task_created' | 'creating_session' | 'session_ready' | 'ready'
  revision: number
  createdAt: number
  updatedAt: number
}

export function normalizeGoalPreparation(raw: ProjectGoalTaskPrepareInput): ProjectGoalTaskPrepareInput {
  const input = normalizeProjectGoalTaskInput(raw)
  if (raw.template !== 'auto' && raw.template !== 'product-launch') throw new Error('任务计划模板无效')
  if (raw.legacySessionId !== undefined && !/^[a-f0-9-]{36}$/.test(raw.legacySessionId)) throw new Error('原会话身份无效')
  if (raw.legacyCreationClaimed !== undefined && typeof raw.legacyCreationClaimed !== 'boolean') throw new Error('原会话创建记录无效')
  return { ...input, template: raw.template, legacySessionId: raw.legacySessionId, legacyCreationClaimed: raw.legacyCreationClaimed }
}

export function goalPreparationDigest(input: ProjectGoalTaskPrepareInput): string {
  // Migration hints may become more complete after a response is received.
  return createHash('sha256').update(JSON.stringify([
    input.projectId, input.requestId, input.objective, input.businessLineId ?? null, input.template
  ])).digest('hex')
}

export class ProjectGoalSubmissionStore {
  constructor(private readonly rootDir: string) {}

  read(input: ProjectGoalTaskPrepareInput): ProjectGoalSubmissionRecord | undefined {
    let raw: string
    try { raw = readFileSync(this.path(input), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const record = JSON.parse(raw) as ProjectGoalSubmissionRecord
    assertGoalStartDecision(record.startDecision)
    const normalized = normalizeGoalPreparation(record.input)
    if (record.schemaVersion !== 1 || record.digest !== goalPreparationDigest(normalized) ||
        !/^[a-f0-9-]{36}$/.test(record.sessionId) || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
        !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt) ||
        !['reserved', 'task_created', 'creating_session', 'session_ready', 'ready'].includes(record.phase) ||
        this.path(normalized) !== this.path(input)) throw new Error('项目任务提交记录损坏，已阻止重复创建')
    if (record.digest !== goalPreparationDigest(input) || (input.legacySessionId && input.legacySessionId !== record.sessionId)) {
      throw new Error('同一提交标识不能用于不同目标、模板或会话')
    }
    return record
  }

  reserve(input: ProjectGoalTaskPrepareInput, existingSessionId?: string, startDecision?: ProjectGoalTaskStartDecision): ProjectGoalSubmissionRecord {
    input = normalizeGoalPreparation(input)
    const prior = this.read(input)
    if (prior) return prior
    assertGoalStartDecision(startDecision)
    const now = Date.now()
    const record: ProjectGoalSubmissionRecord = {
      schemaVersion: 1, input, digest: goalPreparationDigest(input), sessionId: existingSessionId ?? randomUUID(),
      ...(startDecision ? { startDecision: structuredClone(startDecision) } : {}),
      phase: 'reserved', revision: 1, createdAt: now, updatedAt: now
    }
    writeDurableFileSync(this.path(input), JSON.stringify(record), { replace: false })
    return record
  }

  advance(record: ProjectGoalSubmissionRecord, phase: ProjectGoalSubmissionRecord['phase']): ProjectGoalSubmissionRecord {
    const current = this.read(record.input)
    if (!current || current.revision !== record.revision) throw new Error('项目任务提交记录已变化，请重试原提交')
    const next = { ...current, phase, revision: current.revision + 1, updatedAt: Date.now() }
    writeDurableFileSync(this.path(record.input), JSON.stringify(next))
    return next
  }

  private path(input: ProjectGoalTaskPrepareInput): string {
    return join(this.rootDir, 'private', 'project-goal-submissions', `${goalTaskIds(input.projectId, input.requestId).goalId}.json`)
  }
}

export function assertGoalStartDecision(value: unknown): asserts value is ProjectGoalTaskStartDecision | undefined {
  if (value === undefined) return
  const decision = value as ProjectGoalTaskStartDecision | null
  if (!decision || decision.schemaVersion !== 1 || !['auto', 'plan'].includes(decision.mode) ||
      !['direct', 'plan'].includes(decision.kind) || typeof decision.reason !== 'string' ||
      !decision.reason.trim() || decision.reason.length > 1000 ||
      (decision.kind === 'direct' ? decision.mode !== 'auto' || decision.taskStrategy !== 'view' : decision.taskStrategy !== 'plan')) {
    throw new Error('任务启动决策记录无效，已阻止改变原提交方式')
  }
}
