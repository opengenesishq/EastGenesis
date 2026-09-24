import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { listRoutines, markRun, updateRoutine, type Routine } from '../routineStore'
import { writeDurableFile } from '../durable-file'
import { goalModeGeneration } from './goal-mode-generation'
import type { RoutineHeartbeatRun } from '../../shared/routine-heartbeat-types'
import { normalizeRoutineSessionTarget, sameRoutineSessionTarget } from './routine-heartbeat-target'

export type RoutineRunStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type RoutineDispatchState = 'preparing' | 'session_created' | 'prompt_accepted'
export type RoutineReviewDecision = 'accepted' | 'rejected'

export interface RoutineRunRecord {
  heartbeat?: RoutineHeartbeatRun
  id: string
  routineId: string
  routineName: string
  projectId?: string
  goalId?: string
  workItemId?: string
  projectCwd: string
  startedAt: number
  finishedAt?: number
  status: RoutineRunStatus
  inboxStatus: 'running' | 'waiting_approval' | 'needs_review' | 'accepted' | 'rejected' | 'failed'
  dispatchState: RoutineDispatchState
  sessionId?: string
  workflowRunId?: string
  artifactId?: string
  evidenceId?: string
  resultObservedAt?: number
  nextRunAt?: number | null
  resultText?: string
  error?: string
  reviewDecision?: RoutineReviewDecision
  reviewNote?: string
  reviewedAt?: number
}

export interface RoutineRunCallbackResult {
  sessionId?: string
  projectId?: string
  goalId?: string
  workItemId?: string
  projectCwd?: string
  workflowRunId?: string
  dispatchState?: RoutineDispatchState
  /** The callback dispatched durable work; completion will arrive through Session events. */
  pending?: boolean
}

export interface RoutineRunFinalizationInput {
  status: 'succeeded' | 'failed'
  workflowRunId?: string
  artifactId?: string
  evidenceId?: string
  resultObservedAt?: number
  resultText?: string
  error?: string
  finishedAt?: number
}

export interface RoutineRunResultDraft {
  workflowRunId?: string
  resultText?: string
  resultObservedAt: number
}

export interface RoutineRunExecutionBinding {
  projectId?: string
  goalId?: string
  workItemId?: string
  projectCwd: string
}

export type RoutineRunCallback = (
  routine: Routine,
  run: Readonly<RoutineRunRecord>
) => Promise<RoutineRunCallbackResult | void>

interface RoutineRunsFile {
  version: 1
  runs: RoutineRunRecord[]
}

const RUNS_FILE = 'routine-runs.json'
const MAX_RUNS = 500
const runStoreWriteQueues = new Map<string, Promise<void>>()

export async function listRoutineRuns(rootDir: string, routineId?: string): Promise<RoutineRunRecord[]> {
  const file = await readRuns(rootDir)
  return file.runs
    .filter((run) => !routineId || run.routineId === routineId)
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** Reserve one outstanding occurrence per plan. The original Session remains its execution owner. */
export async function reserveRoutineHeartbeat(
  rootDir: string, routine: Routine, id: string, scheduledAt: number, nextRunAt: number | null
): Promise<RoutineRunRecord> {
  const target = routine.executionTarget
  if (!target) throw new Error('定时继续缺少原任务绑定。')
  const result = await withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const existing = file.runs.find((run) => run.id === id)
    if (existing) {
      if (existing.routineId !== routine.id || !sameRoutineSessionTarget(existing.heartbeat?.target, target)) {
        throw new Error('定时继续发生编号或任务绑定冲突。')
      }
      return { record: existing, advance: false }
    }
    const pending = file.runs.find((run) => run.routineId === routine.id && run.heartbeat &&
      !isTerminalRun(run) && sameRoutineSessionTarget(run.heartbeat.target, target))
    if (pending) return { record: pending, advance: true }
    const inputRequestId = `routine-${id}`
    const record: RoutineRunRecord = { id, routineId: routine.id, routineName: routine.name,
      projectId: target.workspaceId, goalId: target.goalId, workItemId: target.workItemId,
      sessionId: target.sessionId, projectCwd: target.cwd, startedAt: Date.now(), nextRunAt,
      status: 'queued', inboxStatus: 'running', dispatchState: 'preparing',
      heartbeat: { target: structuredClone(target), scheduledAt, inputRequestId,
        ...(routine.goalContinuation ? { goalModeGeneration: goalModeGeneration(routine) } : {}),
        messageId: `session-input:${target.sessionId}:${inputRequestId}`, prompt: routine.prompt, phase: 'queued' } }
    await writeRuns(rootDir, retainPendingRuns([record, ...file.runs]))
    return { record, advance: true }
  })
  if (result.advance) {
    await markRun(rootDir, routine.id, { ranAt: result.record.startedAt, nextRunAt, expectedSchedule: routine })
    await updateRoutine(rootDir, routine.id, { runState: result.record.status, lastError: result.record.error ?? null })
  }
  return result.record
}

export async function patchRoutineHeartbeat(rootDir: string, id: string, patch: {
  phase?: RoutineHeartbeatRun['phase']; status?: 'queued' | 'running'; workflowRunId?: string
  inboxStatus?: RoutineRunRecord['inboxStatus']; error?: string | null
}): Promise<RoutineRunRecord> {
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === id)
    if (!current?.heartbeat) throw new Error('定时继续记录不存在。')
    if (isTerminalRun(current)) return current
    if (current.workflowRunId && patch.workflowRunId && current.workflowRunId !== patch.workflowRunId) throw new Error('定时继续的运行身份冲突。')
    const { phase, error, ...fields } = patch
    const updated: RoutineRunRecord = { ...current, ...fields, error: error === null ? undefined : error ?? current.error,
      heartbeat: { ...current.heartbeat, ...(phase ? { phase } : {}) } }
    await writeRuns(rootDir, retainPendingRuns(file.runs.map((run) => run.id === id ? updated : run)))
    return updated
  })
}

function retainPendingRuns(runs: RoutineRunRecord[]): RoutineRunRecord[] {
  let terminalCount = 0
  return runs.filter((run) => !isTerminalRun(run) || terminalCount++ < MAX_RUNS)
}

export async function runRoutineWithHistory(
  rootDir: string,
  routine: Routine,
  callback: RoutineRunCallback,
  nextRunAt: number | null,
  runId?: string
): Promise<RoutineRunRecord> {
  const startedAt = Date.now()
  let record: RoutineRunRecord = {
    id: runId?.trim() || randomUUID(),
    routineId: routine.id,
    routineName: routine.name,
    projectId: routine.projectId,
    projectCwd: routine.projectCwd ?? '',
    startedAt,
    status: 'running',
    inboxStatus: 'running',
    dispatchState: 'preparing',
    nextRunAt
  }
  const reservation = await reserveRun(rootDir, record)
  if (!reservation.created) return reservation.record
  try {
    const result = await callback(routine, record)
    const metadata = result && typeof result === 'object'
      ? {
          sessionId: result.sessionId,
          projectId: result.projectId ?? record.projectId,
          goalId: result.goalId,
          workItemId: result.workItemId,
          projectCwd: result.projectCwd ?? record.projectCwd,
          workflowRunId: result.workflowRunId,
          dispatchState: result.dispatchState ?? record.dispatchState
        }
      : {}
    if (result && typeof result === 'object' && result.pending === true) {
      record = { ...record, ...metadata, status: 'running', inboxStatus: 'running' }
      await replaceRun(rootDir, record)
      await markRun(rootDir, routine.id, { ranAt: startedAt, nextRunAt, expectedSchedule: routine })
      await updateRoutine(rootDir, routine.id, { lastError: null, runState: 'running' })
      return record
    }
    const finishedAt = Date.now()
    record = {
      ...record,
      ...metadata,
      finishedAt,
      status: 'succeeded',
      inboxStatus: 'needs_review'
    }
    await replaceRun(rootDir, record)
    await markRun(rootDir, routine.id, { ranAt: startedAt, nextRunAt, expectedSchedule: routine })
    await updateRoutine(rootDir, routine.id, { lastError: null, runState: 'succeeded' })
    return record
  } catch (error) {
    const finishedAt = Date.now()
    const message = error instanceof Error ? error.message : String(error)
    record = { ...record, finishedAt, status: 'failed', inboxStatus: 'failed', error: message }
    await replaceRun(rootDir, record)
    await markRun(rootDir, routine.id, { ranAt: startedAt, nextRunAt, expectedSchedule: routine })
    await updateRoutine(rootDir, routine.id, { lastError: message, runState: 'failed' })
    return record
  }
}

export async function settleRoutineRun(
  rootDir: string,
  runId: string,
  input: RoutineRunFinalizationInput
): Promise<RoutineRunRecord | null> {
  const result = await withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === runId)
    if (!current) return { record: null, changed: false }
    if (current.status === 'succeeded' || current.status === 'failed') {
      return { record: current, changed: false }
    }
    const status = input.status
    const record: RoutineRunRecord = {
      ...current,
      status,
      inboxStatus: status === 'succeeded' ? 'needs_review' : 'failed',
      finishedAt: input.finishedAt ?? Date.now(),
      workflowRunId: input.workflowRunId ?? current.workflowRunId,
      artifactId: input.artifactId ?? current.artifactId,
      evidenceId: input.evidenceId ?? current.evidenceId,
      resultObservedAt: current.resultObservedAt ?? input.resultObservedAt,
      resultText: cleanOptionalText(input.resultText) ?? current.resultText,
      error: status === 'failed' ? cleanOptionalText(input.error) ?? 'Routine execution failed' : undefined
    }
    await writeRuns(rootDir, retainPendingRuns([record, ...file.runs.filter((run) => run.id !== runId)]))
    return { record, changed: true }
  })
  if (result.record && result.changed) {
    if (result.record.heartbeat) {
      const routine = (await listRoutines(rootDir)).find((item) => item.id === result.record!.routineId)
      if (!sameRoutineSessionTarget(routine?.executionTarget, result.record.heartbeat.target)) return result.record
    }
    await updateRoutine(rootDir, result.record.routineId, {
      lastError: result.record.error ?? null,
      runState: result.record.status
    })
  }
  return result.record
}

export async function stageRoutineRunResult(
  rootDir: string,
  runId: string,
  input: RoutineRunResultDraft
): Promise<RoutineRunRecord | null> {
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === runId)
    if (!current) return null
    if (current.status !== 'running') return current
    const record: RoutineRunRecord = {
      ...current,
      workflowRunId: input.workflowRunId ?? current.workflowRunId,
      resultText: cleanOptionalText(input.resultText) ?? current.resultText,
      resultObservedAt: current.resultObservedAt ?? input.resultObservedAt
    }
    await writeRuns(rootDir, retainPendingRuns([record, ...file.runs.filter((run) => run.id !== runId)]))
    return record
  })
}

export async function recordRoutineRunFinalizationError(
  rootDir: string,
  runId: string,
  error: string
): Promise<RoutineRunRecord | null> {
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === runId)
    if (!current) return null
    if (current.status !== 'running') return current
    const record: RoutineRunRecord = {
      ...current,
      inboxStatus: 'failed',
      error: cleanOptionalText(error) ?? 'Routine result finalization failed'
    }
    await writeRuns(rootDir, retainPendingRuns([record, ...file.runs.filter((run) => run.id !== runId)]))
    return record
  })
}

export async function setRoutineRunInboxStatus(
  rootDir: string,
  runId: string,
  inboxStatus: RoutineRunRecord['inboxStatus']
): Promise<RoutineRunRecord | null> {
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === runId)
    if (!current) return null
    if (current.status !== 'running' || current.inboxStatus === inboxStatus) return current
    const record = { ...current, inboxStatus }
    await writeRuns(rootDir, retainPendingRuns([record, ...file.runs.filter((run) => run.id !== runId)]))
    return record
  })
}

export async function setRoutineRunDispatchState(
  rootDir: string,
  runId: string,
  dispatchState: RoutineDispatchState,
  workflowRunId?: string,
  sessionId?: string
): Promise<RoutineRunRecord | null> {
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === runId)
    if (!current) return null
    if (dispatchPhase(current.dispatchState) > dispatchPhase(dispatchState)) return current
    const record: RoutineRunRecord = {
      ...current,
      dispatchState,
      workflowRunId: workflowRunId ?? current.workflowRunId,
      sessionId: sessionId ?? current.sessionId
    }
    await writeRuns(rootDir, retainPendingRuns([record, ...file.runs.filter((run) => run.id !== runId)]))
    return record
  })
}

export async function setRoutineRunExecutionBinding(
  rootDir: string,
  runId: string,
  binding: RoutineRunExecutionBinding
): Promise<RoutineRunRecord | null> {
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === runId)
    if (!current) return null
    if (current.status !== 'running' || current.dispatchState !== 'preparing') {
      throw new Error(`Routine Run ${runId} cannot change its execution binding`)
    }
    const record: RoutineRunRecord = { ...current, ...binding }
    await writeRuns(rootDir, retainPendingRuns([record, ...file.runs.filter((run) => run.id !== runId)]))
    return record
  })
}

export async function reviewRoutineRunRecord(
  rootDir: string,
  runId: string,
  decision: RoutineReviewDecision,
  note?: string,
  reviewedAt = Date.now()
): Promise<RoutineRunRecord | null> {
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === runId)
    if (!current) return null
    if (current.reviewDecision) {
      if (current.reviewDecision !== decision) throw new Error(`Routine Run ${runId} was already reviewed`)
      return current
    }
    if (current.status !== 'succeeded' || current.inboxStatus !== 'needs_review') {
      throw new Error(`Routine Run ${runId} is not ready for review`)
    }
    const reviewNote = cleanOptionalText(note)
    const record: RoutineRunRecord = {
      ...current,
      inboxStatus: decision,
      reviewDecision: decision,
      ...(reviewNote ? { reviewNote } : {}),
      reviewedAt
    }
    await writeRuns(rootDir, retainPendingRuns([record, ...file.runs.filter((run) => run.id !== runId)]))
    return record
  })
}

export async function importProjectRoutineRuns(
  rootDir: string,
  projectId: string,
  values: readonly RoutineRunRecord[]
): Promise<number> {
  const expectedProjectId = requiredProjectId(projectId)
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const incoming = values.map((value) => normalizeRunRecord(structuredClone(value)))
    if (incoming.some((value) => value === null)) throw new Error('Project import contains an invalid Routine Run')
    let imported = 0
    for (const run of incoming as RoutineRunRecord[]) {
      if (run.projectId !== expectedProjectId) {
        throw new Error(`Routine Run ${run.id} is not owned by Project ${expectedProjectId}`)
      }
      const existing = file.runs.find((candidate) => candidate.id === run.id)
      if (existing) {
        if (!isDeepStrictEqual(existing, run)) throw new Error(`Routine Run import identity conflict: ${run.id}`)
        continue
      }
      file.runs.push(run)
      imported += 1
    }
    if (file.runs.length > MAX_RUNS) {
      throw new Error(`Routine Run import exceeds bounded history capacity (${MAX_RUNS})`)
    }
    if (imported > 0) {
      await writeRuns(rootDir, file.runs.sort((left, right) => right.startedAt - left.startedAt))
    }
    return imported
  })
}

export async function purgeProjectRoutineRuns(
  rootDir: string,
  projectId: string,
  routineIds: ReadonlySet<string> = new Set()
): Promise<number> {
  const expectedProjectId = requiredProjectId(projectId)
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const next = file.runs.filter((run) =>
      run.projectId !== expectedProjectId && !(run.projectId === undefined && routineIds.has(run.routineId)))
    const removed = file.runs.length - next.length
    if (removed > 0) await writeRuns(rootDir, next)
    return removed
  })
}

export async function countProjectRoutineRuns(rootDir: string, projectId: string): Promise<number> {
  const expectedProjectId = requiredProjectId(projectId)
  return (await listRoutineRuns(rootDir)).filter((run) => run.projectId === expectedProjectId).length
}

async function reserveRun(rootDir: string, record: RoutineRunRecord): Promise<{ record: RoutineRunRecord; created: boolean }> {
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const existing = file.runs.find((run) => run.id === record.id)
    if (existing) {
      if (existing.routineId !== record.routineId || existing.projectId !== record.projectId) {
        throw new Error(`Routine Run identity conflict: ${record.id}`)
      }
      return { record: existing, created: false }
    }
    await writeRuns(rootDir, retainPendingRuns([record, ...file.runs]))
    return { record, created: true }
  })
}

async function replaceRun(rootDir: string, record: RoutineRunRecord): Promise<void> {
  await withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === record.id)
    const replacement = current && isTerminalRun(current) && !isTerminalRun(record)
      ? current
      : { ...current, ...record }
    const next = retainPendingRuns([replacement, ...file.runs.filter((run) => run.id !== record.id)])
    await writeRuns(rootDir, next)
  })
}

async function withRunStoreWriteLock<T>(rootDir: string, operation: () => Promise<T>): Promise<T> {
  const key = runsPath(rootDir)
  const previous = runStoreWriteQueues.get(key) ?? Promise.resolve()
  let value!: T
  const operationPromise = previous
    .catch(() => undefined)
    .then(async () => {
      value = await operation()
    })
  const queueTail = operationPromise.then(() => undefined, () => undefined)
  runStoreWriteQueues.set(key, queueTail)
  try {
    await operationPromise
    return value
  } finally {
    if (runStoreWriteQueues.get(key) === queueTail) runStoreWriteQueues.delete(key)
  }
}

async function readRuns(rootDir: string): Promise<RoutineRunsFile> {
  try {
    const raw = await readFile(runsPath(rootDir), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { runs?: unknown }).runs)) {
      return { version: 1, runs: [] }
    }
    return {
      version: 1,
      runs: (parsed as { runs: unknown[] }).runs
        .map(normalizeRunRecord)
        .filter((run): run is RoutineRunRecord => run !== null)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, runs: [] }
    throw new Error(`Routine run store is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function writeRuns(rootDir: string, runs: RoutineRunRecord[]): Promise<void> {
  const filePath = runsPath(rootDir)
  await writeDurableFile(filePath, `${JSON.stringify({ version: 1, runs }, null, 2)}\n`)
}

function runsPath(rootDir: string): string {
  if (!rootDir.trim()) throw new Error('rootDir 不能为空')
  return path.join(path.resolve(rootDir), RUNS_FILE)
}

function normalizeRunRecord(value: unknown): RoutineRunRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.heartbeat) {
    const heartbeat = record.heartbeat as RoutineHeartbeatRun
    try {
      const target = normalizeRoutineSessionTarget(heartbeat.target)
      if (!target || record.sessionId !== target.sessionId || typeof heartbeat.scheduledAt !== 'number' ||
          typeof heartbeat.inputRequestId !== 'string' || typeof heartbeat.prompt !== 'string' ||
          heartbeat.messageId !== `session-input:${target.sessionId}:${heartbeat.inputRequestId}` ||
          !['queued', 'dispatching', 'accepted', 'needs_reconciliation'].includes(heartbeat.phase)) return null
    } catch { return null }
  }
  if (!(
    typeof record.id === 'string' &&
    typeof record.routineId === 'string' &&
    typeof record.routineName === 'string' &&
    typeof record.projectCwd === 'string' &&
    typeof record.startedAt === 'number' &&
    (record.status === 'queued' || record.status === 'running' || record.status === 'succeeded' || record.status === 'failed')
  )) return null
  const status = record.status
  const inboxStatus = record.inboxStatus === 'running' || record.inboxStatus === 'waiting_approval' ||
    record.inboxStatus === 'needs_review' || record.inboxStatus === 'accepted' ||
    record.inboxStatus === 'rejected' || record.inboxStatus === 'failed'
    ? record.inboxStatus
    : status === 'failed'
      ? 'failed'
      : status === 'succeeded'
        ? 'needs_review'
        : 'running'
  const dispatchState = record.dispatchState === 'preparing' || record.dispatchState === 'session_created' ||
    record.dispatchState === 'prompt_accepted'
    ? record.dispatchState
    : record.sessionId
      ? 'prompt_accepted'
      : 'preparing'
  return { ...record, status, inboxStatus, dispatchState } as unknown as RoutineRunRecord
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const clean = value?.trim()
  return clean ? clean.slice(0, 20_000) : undefined
}

function isTerminalRun(record: Pick<RoutineRunRecord, 'status'>): boolean {
  return record.status === 'succeeded' || record.status === 'failed'
}

function dispatchPhase(state: RoutineDispatchState): number {
  if (state === 'prompt_accepted') return 3
  if (state === 'session_created') return 2
  return 1
}

function requiredProjectId(value: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error('projectId is required')
  }
  return value.trim()
}
