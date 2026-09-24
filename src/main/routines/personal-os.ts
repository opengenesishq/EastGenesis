import type { Routine, RoutineRunRecord, StartSuggestion } from '../../shared/types'

export type PersonalOsRoutineState =
  | 'paused'
  | 'scheduled'
  | 'due'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'exhausted'

export type PersonalOsStatus = 'idle' | 'attention' | 'active'

export interface PersonalOsSettings {
  notificationsEnabled?: boolean
  preventDisplaySleep?: boolean
}

export interface PersonalOsSnapshotInput {
  routines: readonly Routine[]
  routineRuns?: readonly RoutineRunRecord[]
  suggestions?: readonly StartSuggestion[]
  settings?: PersonalOsSettings
  now?: number
}

export interface PersonalOsRoutineSummary {
  id: string
  name: string
  enabled: boolean
  state: PersonalOsRoutineState
  projectId?: string
  projectCwd?: string
  schedule: string
  timeZone?: string
  scheduleState?: Routine['scheduleState']
  nextRunAt: number | null
  lastRunAt: number | null
  latestRunStatus?: RoutineRunRecord['status']
  latestRunId?: string
  lastError?: string
}

export interface PersonalOsNotificationPlan {
  enabled: boolean
  routineFailures: number
  routineSuccesses: number
  overdueRoutines: number
}

export interface RoutineRunNotificationPayload {
  kind: 'complete' | 'failure' | 'approval'
  title: string
  body: string
  sessionId: string
}

export interface PersonalOsPowerPlan {
  enabled: boolean
  active: boolean
  reason?: string
}

export interface PersonalOsSnapshot {
  status: PersonalOsStatus
  routines: PersonalOsRoutineSummary[]
  totals: {
    routines: number
    enabled: number
    due: number
    running: number
    failed: number
    suggestions: number
  }
  nextRoutineAt: number | null
  notificationPlan: PersonalOsNotificationPlan
  powerPlan: PersonalOsPowerPlan
  suggestions: StartSuggestion[]
}

export interface PowerSaveBlockerAdapter {
  start(type: 'prevent-display-sleep'): number
  stop(id: number): void
  isStarted(id: number): boolean
}

export interface PersonalOsPowerBlockerOptions {
  adapter: PowerSaveBlockerAdapter
  enabled: boolean
  reason?: string
  onError?: (error: unknown) => void
}

const DUE_GRACE_MS = 60_000

export function buildPersonalOsSnapshot(input: PersonalOsSnapshotInput): PersonalOsSnapshot {
  const now = normalizeTimestamp(input.now) ?? Date.now()
  const runs = [...(input.routineRuns ?? [])]
  const latestRunByRoutine = latestRuns(runs)
  const routines = input.routines.map((routine) => summarizeRoutine(routine, latestRunByRoutine.get(routine.id), now))
  const suggestions = [...(input.suggestions ?? [])]
  const enabled = routines.filter((routine) => routine.enabled).length
  const due = routines.filter((routine) => routine.state === 'due').length
  const running = routines.filter((routine) => routine.state === 'queued' || routine.state === 'running').length
  const failed = routines.filter((routine) => routine.state === 'failed').length
  const nextRoutineAt = routines
    .filter((routine) => routine.enabled && routine.nextRunAt !== null && routine.nextRunAt > now)
    .map((routine) => routine.nextRunAt as number)
    .sort((a, b) => a - b)[0] ?? null
  const notificationEnabled = input.settings?.notificationsEnabled !== false
  const preventDisplaySleep = input.settings?.preventDisplaySleep !== false
  const status: PersonalOsStatus = running > 0 ? 'active' : due > 0 || failed > 0 ? 'attention' : 'idle'

  return {
    status,
    routines,
    totals: {
      routines: routines.length,
      enabled,
      due,
      running,
      failed,
      suggestions: suggestions.length
    },
    nextRoutineAt,
    notificationPlan: {
      enabled: notificationEnabled,
      routineFailures: notificationEnabled ? failed : 0,
      routineSuccesses: notificationEnabled
        ? routines.filter((routine) => routine.state === 'succeeded').length
        : 0,
      overdueRoutines: notificationEnabled ? due : 0
    },
    powerPlan: {
      enabled: preventDisplaySleep,
      active: preventDisplaySleep && running > 0,
      reason: preventDisplaySleep && running > 0 ? 'routine-run' : undefined
    },
    suggestions
  }
}

export function startPersonalOsPowerBlocker(options: PersonalOsPowerBlockerOptions): () => void {
  if (!options.enabled) return noop
  let blockerId: number | null = null
  try {
    blockerId = options.adapter.start('prevent-display-sleep')
  } catch (error) {
    options.onError?.(error)
    return noop
  }

  return () => {
    if (blockerId === null) return
    const id = blockerId
    blockerId = null
    try {
      if (options.adapter.isStarted(id)) options.adapter.stop(id)
    } catch (error) {
      options.onError?.(error)
    }
  }
}

export function buildRoutineRunNotification(
  routine: Routine,
  record: RoutineRunRecord,
  settings: PersonalOsSettings = {}
): RoutineRunNotificationPayload | null {
  if (settings.notificationsEnabled === false) return null
  const notification = routine.notification
  if (!notification?.enabled) return null
  if (record.status === 'succeeded' && !notification.onSuccess) return null
  if (record.status !== 'succeeded' && !notification.onFailure) return null

  return {
    title: record.status === 'succeeded' ? `Routine 待验收: ${routine.name}`
      : record.heartbeat?.phase === 'needs_reconciliation' ? `定时继续待核对: ${routine.name}` : `Routine 失败: ${routine.name}`,
    body: record.status === 'succeeded'
      ? (record.resultText ?? 'Agent 已完成本轮执行，结果已进入待验收。')
      : (record.error ?? '执行失败'),
    sessionId: record.sessionId ?? routine.id,
    kind: record.status === 'succeeded' ? 'complete' : record.heartbeat?.phase === 'needs_reconciliation' ? 'approval' : 'failure'
  }
}

export async function runWithPersonalOsPowerBlocker<T>(
  options: PersonalOsPowerBlockerOptions,
  task: () => Promise<T>
): Promise<T> {
  const release = startPersonalOsPowerBlocker(options)
  try {
    return await task()
  } finally {
    release()
  }
}

function summarizeRoutine(
  routine: Routine,
  latestRun: RoutineRunRecord | undefined,
  now: number
): PersonalOsRoutineSummary {
  const nextRunAt = normalizeTimestamp(routine.nextRunAt) ?? null
  const lastRunAt = normalizeTimestamp(routine.lastRunAt) ?? null
  const lastError = typeof routine.lastError === 'string' && routine.lastError.trim()
    ? routine.lastError
    : latestRun?.error
  const runState = typeof routine.runState === 'string' ? routine.runState : undefined
  const state = routine.scheduleState === 'exhausted' && latestRun?.status !== 'running' && latestRun?.status !== 'queued'
    ? 'exhausted' : routine.scheduleState === 'invalid' ? 'failed' : routineState(routine.enabled, nextRunAt, lastError, runState, latestRun, now)

  return {
    id: routine.id,
    name: routine.name,
    enabled: routine.enabled,
    state,
    projectId: routine.projectId,
    projectCwd: routine.projectCwd,
    schedule: routine.schedule,
    timeZone: routine.timeZone,
    scheduleState: routine.scheduleState,
    nextRunAt,
    lastRunAt,
    latestRunStatus: latestRun?.status,
    latestRunId: latestRun?.id,
    lastError
  }
}

function routineState(
  enabled: boolean,
  nextRunAt: number | null,
  lastError: string | undefined,
  runState: string | undefined,
  latestRun: RoutineRunRecord | undefined,
  now: number
): PersonalOsRoutineState {
  if (!enabled) return 'paused'
  if (latestRun?.status === 'queued') return 'queued'
  if (latestRun?.status === 'running') return 'running'
  if (lastError || latestRun?.status === 'failed' || runState === 'failed') return 'failed'
  if (nextRunAt !== null && nextRunAt <= now + DUE_GRACE_MS) return 'due'
  if (latestRun?.status === 'succeeded' || runState === 'succeeded') return 'succeeded'
  return 'scheduled'
}

function latestRuns(runs: RoutineRunRecord[]): Map<string, RoutineRunRecord> {
  const byRoutine = new Map<string, RoutineRunRecord>()
  for (const run of runs.sort((a, b) => b.startedAt - a.startedAt)) {
    if (!byRoutine.has(run.routineId)) byRoutine.set(run.routineId, run)
  }
  return byRoutine
}

function normalizeTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function noop(): void {}
