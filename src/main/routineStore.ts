import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { calculateRoutineSchedule, isRRuleSchedule, normalizeRoutineStartAt, normalizeRoutineTimeZone, type RoutineScheduleState, type RoutineScheduleDefinition } from '../shared/routine-schedule'
import { writeDurableFile } from './durable-file'
import type { EngineKind, PermissionModeId, RoutineNotificationOptions, ProviderReasoningEffort } from '../shared/types'
import { normalizeRoutineGoalContinuation, type RoutineSessionTarget, type RoutineGoalContinuation, type RoutineGoalContinuationState } from '../shared/routine-heartbeat-types'
import { normalizeTaskReasoning } from '../shared/task-reasoning'
import { normalizeRoutineSessionTarget } from './routines/routine-heartbeat-target'

export type RoutinePermissionMode = PermissionModeId

export interface Routine extends Record<string, unknown> {
  executionTarget?: RoutineSessionTarget
  goalContinuation?: RoutineGoalContinuation
  goalContinuationState?: RoutineGoalContinuationState
  id: string
  name: string
  prompt: string
  content?: string
  /** Canonical Project ownership. Legacy path-only routines omit this field. */
  projectId?: string
  /** Source Goal whose contract is copied into a fresh Goal for each run. */
  goalTemplateId?: string
  /** Optional native DigitalWorker assigned to each generated WorkItem. */
  digitalWorkerId?: string
  /** Optional execution resource root. Canonical Projects can resolve it automatically. */
  projectCwd?: string
  schedule: string
  timeZone?: string
  startAt?: number
  scheduleState?: RoutineScheduleState
  scheduleError?: string
  frequency?: string
  providerId: string
  model: string
  engine?: EngineKind
  reasoningEffort?: ProviderReasoningEffort
  executionLocation?: 'local' | 'worktree'
  permissionMode: RoutinePermissionMode
  budgetUsd: number
  notification: RoutineNotificationOptions
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
  nextRunAt?: number
}

export type CreateRoutineInput = {
  goalContinuation?: RoutineGoalContinuation | null
  executionTarget?: { kind: 'existing_session'; sessionId: string } | null
  id?: string
  name: string
  prompt?: string
  content?: string
  projectId?: string
  goalTemplateId?: string
  digitalWorkerId?: string
  projectCwd?: string
  schedule?: string
  timeZone?: string
  startAt?: number
  scheduleState?: RoutineScheduleState
  scheduleError?: string
  frequency?: string
  providerId?: string
  model?: string
  engine?: EngineKind
  reasoningEffort?: ProviderReasoningEffort
  executionLocation?: 'local' | 'worktree'
  permissionMode?: RoutinePermissionMode
  budgetUsd?: number
  notification?: RoutineNotificationOptions
  enabled?: boolean
  createdAt?: number
  updatedAt?: number
  lastRunAt?: number | null
  nextRunAt?: number | null
} & Record<string, unknown>

export type UpdateRoutineInput = {
  goalContinuation?: RoutineGoalContinuation | null
  executionTarget?: { kind: 'existing_session'; sessionId: string } | null
  name?: string
  prompt?: string
  content?: string
  projectId?: string | null
  goalTemplateId?: string | null
  digitalWorkerId?: string | null
  projectCwd?: string
  schedule?: string
  timeZone?: string
  startAt?: number
  scheduleState?: RoutineScheduleState
  scheduleError?: string
  frequency?: string
  providerId?: string
  model?: string
  engine?: EngineKind
  reasoningEffort?: ProviderReasoningEffort
  executionLocation?: 'local' | 'worktree'
  permissionMode?: RoutinePermissionMode
  budgetUsd?: number
  notification?: RoutineNotificationOptions
  enabled?: boolean
  lastRunAt?: number | null
  nextRunAt?: number | null
} & Record<string, unknown>

export interface MarkRunOptions {
  ranAt?: number
  nextRunAt?: number | null
  expectedSchedule?: RoutineScheduleDefinition
}

interface RoutineFile {
  version: 1
  routines: Routine[]
}

export class RoutineStoreValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RoutineStoreValidationError'
  }
}

const ROUTINES_FILE = 'routines.json'
const STORE_VERSION = 1
const routineStoreWriteQueues = new Map<string, Promise<void>>()
const PERMISSION_MODES = new Set<RoutinePermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions'
])
const ENGINE_KINDS = new Set<EngineKind>(['anthropic', 'gemini', 'openai'])
const DEFAULT_NOTIFICATION: RoutineNotificationOptions = {
  enabled: false,
  onSuccess: true,
  onFailure: true
}
const SCHEMA_KEYS = new Set([
  'goalContinuation',
  'executionTarget',
  'id',
  'name',
  'prompt',
  'content',
  'projectId',
  'goalTemplateId',
  'digitalWorkerId',
  'projectCwd',
  'schedule',
  'timeZone',
  'startAt',
  'scheduleState',
  'scheduleError',
  'frequency',
  'providerId',
  'model',
  'engine',
  'reasoningEffort',
  'executionLocation',
  'permissionMode',
  'budgetUsd',
  'notification',
  'enabled',
  'createdAt',
  'updatedAt',
  'lastRunAt',
  'nextRunAt'
])

export function getRoutineStorePath(rootDir: string): string {
  return path.join(resolveRootDir(rootDir), ROUTINES_FILE)
}

export async function listRoutines(rootDir: string): Promise<Routine[]> {
  const file = await readStore(rootDir)
  return file.routines
}

export async function createRoutine(rootDir: string, input: CreateRoutineInput): Promise<Routine> {
  return withRoutineStoreWriteLock(rootDir, async () => {
    const file = await readStore(rootDir)
    const now = Date.now()
    const id = normalizeOptionalString(input.id, 'id') || randomUUID()

    if (file.routines.some((routine) => routine.id === id)) {
      throw new RoutineStoreValidationError(`Routine already exists: ${id}`)
    }

    const createdAt = normalizeOptionalTimestamp(input.createdAt, 'createdAt') ?? now
    const updatedAt = normalizeOptionalTimestamp(input.updatedAt, 'updatedAt') ?? createdAt
    const prompt = normalizeRequiredString(input.prompt ?? input.content, 'prompt')
    const schedule = normalizeRequiredString(input.schedule ?? input.frequency, 'schedule')
    const projectId = normalizeOptionalId(input.projectId, 'projectId')
    const projectCwd = normalizeOptionalString(input.projectCwd, 'projectCwd')?.trim() || undefined
    if (!projectId && !projectCwd) {
      throw new RoutineStoreValidationError('projectId or projectCwd is required')
    }
    const routine: Routine = {
      ...copyUnknownFields(input),
      executionTarget: normalizeRoutineSessionTarget(input.executionTarget),
      goalContinuation: normalizeRoutineGoalContinuation(input.goalContinuation),
      id,
      name: normalizeRequiredString(input.name, 'name'),
      prompt,
      content: normalizeOptionalString(input.content, 'content') ?? prompt,
      projectId,
      goalTemplateId: normalizeOptionalId(input.goalTemplateId, 'goalTemplateId'),
      digitalWorkerId: normalizeOptionalId(input.digitalWorkerId, 'digitalWorkerId'),
      projectCwd,
      schedule,
      timeZone: normalizeRoutineTimeZone(input.timeZone),
      startAt: normalizeRoutineStartAt(input.startAt),
      frequency: normalizeOptionalString(input.frequency, 'frequency') ?? schedule,
      providerId: normalizeOptionalString(input.providerId, 'providerId') ?? '',
      model: normalizeOptionalString(input.model, 'model') ?? '',
      engine: normalizeOptionalEngine(input.engine),
      reasoningEffort: normalizeTaskReasoning(input.reasoningEffort),
      executionLocation: executionLocation(input.executionLocation),
      permissionMode: normalizePermissionMode(input.permissionMode ?? 'default'),
      budgetUsd: normalizeBudget(input.budgetUsd ?? 0),
      notification: normalizeNotificationOptions(input.notification),
      enabled: normalizeOptionalBoolean(input.enabled, 'enabled') ?? true,
      createdAt,
      updatedAt,
      lastRunAt: normalizeNullableTimestamp(input.lastRunAt, 'lastRunAt') ?? null
    }
    if (isRRuleSchedule(schedule) && routine.startAt === undefined) routine.startAt = normalizeRoutineStartAt(createdAt)
    const timing = calculateRoutineSchedule(routine, now)
    if (timing.state === 'invalid') throw new RoutineStoreValidationError(timing.error!)
    routine.scheduleState = timing.state
    const nextRunAt = normalizeNullableTimestamp(input.nextRunAt, 'nextRunAt')
    if (nextRunAt !== null) routine.nextRunAt = nextRunAt
    else if (routine.enabled && !hasOwn(input, 'nextRunAt')) {
      if (timing.nextRunAt !== null) routine.nextRunAt = timing.nextRunAt
    }

    file.routines.push(routine)
    await writeStore(rootDir, file.routines)
    return routine
  })
}

export async function updateRoutine(
  rootDir: string,
  id: string,
  inputPatch: UpdateRoutineInput,
  expectedSchedule?: RoutineScheduleDefinition
): Promise<Routine | null> {
  return withRoutineStoreWriteLock(rootDir, async () => {
    const file = await readStore(rootDir)
    const index = file.routines.findIndex((routine) => routine.id === id)
    if (index === -1) return null

  const current = file.routines[index]
  const patch = { ...inputPatch }
  if (expectedSchedule && (expectedSchedule.schedule !== current.schedule || expectedSchedule.timeZone !== current.timeZone || expectedSchedule.startAt !== current.startAt)) {
    // A finished old run cannot overwrite the next time chosen by a concurrent schedule edit.
    delete patch.nextRunAt
    delete patch.scheduleState
    delete patch.scheduleError
  }
  const prompt = hasOwn(patch, 'prompt')
    ? normalizeRequiredString(patch.prompt, 'prompt')
    : hasOwn(patch, 'content')
      ? normalizeRequiredString(patch.content, 'content')
      : current.prompt
  const schedule = hasOwn(patch, 'schedule')
    ? normalizeRequiredString(patch.schedule, 'schedule')
    : hasOwn(patch, 'frequency')
      ? normalizeRequiredString(patch.frequency, 'frequency')
      : current.schedule
  const projectId = hasOwn(patch, 'projectId')
    ? normalizeOptionalId(patch.projectId, 'projectId')
    : current.projectId
  const projectCwd = hasOwn(patch, 'projectCwd')
    ? normalizeOptionalString(patch.projectCwd, 'projectCwd')?.trim() || undefined
    : current.projectCwd
  if (!projectId && !projectCwd) {
    throw new RoutineStoreValidationError('projectId or projectCwd is required')
  }
  const routine: Routine = {
    ...copyUnknownFields(current),
    ...copyUnknownFields(patch),
    executionTarget: hasOwn(patch, 'executionTarget') ? normalizeRoutineSessionTarget(patch.executionTarget) : current.executionTarget,
    goalContinuation: hasOwn(patch, 'goalContinuation') ? normalizeRoutineGoalContinuation(patch.goalContinuation) : current.goalContinuation,
    id: current.id,
    name: hasOwn(patch, 'name') ? normalizeRequiredString(patch.name, 'name') : current.name,
    prompt,
    content: hasOwn(patch, 'content')
      ? normalizeOptionalString(patch.content, 'content')
      : hasOwn(patch, 'prompt')
        ? prompt
        : (current.content ?? current.prompt),
    projectId,
    goalTemplateId: hasOwn(patch, 'goalTemplateId')
      ? normalizeOptionalId(patch.goalTemplateId, 'goalTemplateId')
      : current.goalTemplateId,
    digitalWorkerId: hasOwn(patch, 'digitalWorkerId')
      ? normalizeOptionalId(patch.digitalWorkerId, 'digitalWorkerId')
      : current.digitalWorkerId,
    projectCwd,
    schedule,
    timeZone: hasOwn(patch, 'timeZone') ? normalizeRoutineTimeZone(patch.timeZone) : current.timeZone,
    startAt: hasOwn(patch, 'startAt') ? normalizeRoutineStartAt(patch.startAt) : current.startAt,
    scheduleState: current.scheduleState,
    scheduleError: current.scheduleError,
    frequency: hasOwn(patch, 'frequency')
      ? normalizeOptionalString(patch.frequency, 'frequency')
      : hasOwn(patch, 'schedule')
        ? schedule
        : (current.frequency ?? current.schedule),
    providerId: hasOwn(patch, 'providerId')
      ? (normalizeOptionalString(patch.providerId, 'providerId') ?? '')
      : current.providerId,
    model: hasOwn(patch, 'model') ? (normalizeOptionalString(patch.model, 'model') ?? '') : current.model,
    engine: hasOwn(patch, 'engine') ? normalizeOptionalEngine(patch.engine) : current.engine,
    reasoningEffort: hasOwn(patch, 'reasoningEffort') ? normalizeTaskReasoning(patch.reasoningEffort) : current.reasoningEffort,
    executionLocation: hasOwn(patch, 'executionLocation') ? executionLocation(patch.executionLocation) : current.executionLocation,
    permissionMode: hasOwn(patch, 'permissionMode')
      ? normalizePermissionMode(patch.permissionMode)
      : current.permissionMode,
    budgetUsd: hasOwn(patch, 'budgetUsd') ? normalizeBudget(patch.budgetUsd) : current.budgetUsd,
    notification: hasOwn(patch, 'notification')
      ? normalizeNotificationOptions(patch.notification, current.notification)
      : (current.notification ?? DEFAULT_NOTIFICATION),
    enabled: hasOwn(patch, 'enabled') ? normalizeBoolean(patch.enabled, 'enabled') : current.enabled,
    createdAt: current.createdAt,
    updatedAt: Date.now(),
    lastRunAt: hasOwn(patch, 'lastRunAt')
      ? normalizeNullableTimestamp(patch.lastRunAt, 'lastRunAt')
      : current.lastRunAt
  }

  const timingChanged = routine.schedule !== current.schedule || routine.timeZone !== current.timeZone || routine.startAt !== current.startAt
  if (timingChanged || (patch.enabled === true && !current.enabled)) {
    if (isRRuleSchedule(routine.schedule) && routine.startAt === undefined) routine.startAt = normalizeRoutineStartAt(current.createdAt)
    const timing = calculateRoutineSchedule(routine, Date.now())
    if (timing.state === 'invalid') throw new RoutineStoreValidationError(timing.error!)
    routine.scheduleState = timing.state
    routine.scheduleError = undefined
    if (timing.nextRunAt !== null) routine.nextRunAt = timing.nextRunAt
  } else if (hasOwn(patch, 'nextRunAt')) {
    const nextRunAt = normalizeNullableTimestamp(patch.nextRunAt, 'nextRunAt')
    if (nextRunAt !== null) { routine.nextRunAt = nextRunAt; routine.scheduleState = 'active'; routine.scheduleError = undefined }
    else if (isRRuleSchedule(routine.schedule)) {
      const timing = calculateRoutineSchedule(routine, routine.lastRunAt ?? Date.now())
      routine.scheduleState = timing.state
      routine.scheduleError = timing.error
    }
  } else if (current.nextRunAt !== undefined) {
    routine.nextRunAt = current.nextRunAt
  }

  if (patch.scheduleState === 'invalid') { routine.scheduleState = 'invalid'; routine.scheduleError = typeof patch.scheduleError === 'string' ? patch.scheduleError.slice(0, 2000) : '计划时间需要修正'; delete routine.nextRunAt }
  if (patch.scheduleState === 'exhausted' && isRRuleSchedule(routine.schedule) && !timingChanged) { routine.scheduleState = 'exhausted'; routine.scheduleError = undefined; delete routine.nextRunAt }

    file.routines[index] = routine
    await writeStore(rootDir, file.routines)
    return routine
  })
}

export async function deleteRoutine(rootDir: string, id: string): Promise<boolean> {
  return withRoutineStoreWriteLock(rootDir, async () => {
    const file = await readStore(rootDir)
    const nextRoutines = file.routines.filter((routine) => routine.id !== id)
    if (nextRoutines.length === file.routines.length) return false
    await writeStore(rootDir, nextRoutines)
    return true
  })
}

export async function importProjectRoutineDefinitions(
  rootDir: string,
  projectId: string,
  values: readonly Routine[]
): Promise<number> {
  const expectedProjectId = normalizeOptionalId(projectId, 'projectId')
  if (!expectedProjectId) throw new RoutineStoreValidationError('projectId is required')
  return withRoutineStoreWriteLock(rootDir, async () => {
    const file = await readStore(rootDir)
    const incoming = values.map((value) => normalizeStoredRoutine(structuredClone(value)))
    if (incoming.some((value) => value === null)) {
      throw new RoutineStoreValidationError('Project import contains an invalid Routine definition')
    }
    let imported = 0
    for (const routine of incoming as Routine[]) {
      if (routine.projectId !== expectedProjectId) {
        throw new RoutineStoreValidationError(`Routine ${routine.id} is not owned by Project ${expectedProjectId}`)
      }
      const existing = file.routines.find((candidate) => candidate.id === routine.id)
      if (existing) {
        if (!isDeepStrictEqual(existing, routine)) {
          throw new RoutineStoreValidationError(`Routine import identity conflict: ${routine.id}`)
        }
        continue
      }
      file.routines.push(routine)
      imported += 1
    }
    if (imported > 0) await writeStore(rootDir, file.routines)
    return imported
  })
}

export async function purgeProjectRoutineDefinitions(rootDir: string, projectId: string): Promise<number> {
  const expectedProjectId = normalizeOptionalId(projectId, 'projectId')
  if (!expectedProjectId) throw new RoutineStoreValidationError('projectId is required')
  return withRoutineStoreWriteLock(rootDir, async () => {
    const file = await readStore(rootDir)
    const next = file.routines.filter((routine) => routine.projectId !== expectedProjectId)
    const removed = file.routines.length - next.length
    if (removed > 0) await writeStore(rootDir, next)
    return removed
  })
}

export async function countProjectRoutineDefinitions(rootDir: string, projectId: string): Promise<number> {
  const expectedProjectId = normalizeOptionalId(projectId, 'projectId')
  if (!expectedProjectId) throw new RoutineStoreValidationError('projectId is required')
  return (await listRoutines(rootDir)).filter((routine) => routine.projectId === expectedProjectId).length
}

export async function markRun(
  rootDir: string,
  id: string,
  options: MarkRunOptions = {}
): Promise<Routine | null> {
  const patch: UpdateRoutineInput = {
    lastRunAt: normalizeOptionalTimestamp(options.ranAt, 'ranAt') ?? Date.now()
  }
  if (hasOwn(options, 'nextRunAt')) patch.nextRunAt = options.nextRunAt ?? undefined
  return updateRoutine(rootDir, id, patch, options.expectedSchedule)
}

export {
  createRoutine as create,
  deleteRoutine as delete,
  listRoutines as list,
  updateRoutine as update
}

async function readStore(rootDir: string): Promise<RoutineFile> {
  try {
    const raw = await readFile(getRoutineStorePath(rootDir), 'utf8')
    return normalizeStore(JSON.parse(raw))
  } catch (error) {
    if (error instanceof RoutineStoreValidationError) throw error
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { version: STORE_VERSION, routines: [] }
    }
    throw new RoutineStoreValidationError(`Routine store is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function writeStore(rootDir: string, routines: Routine[]): Promise<void> {
  const dir = resolveRootDir(rootDir)
  const filePath = path.join(dir, ROUTINES_FILE)
  const payload: RoutineFile = { version: STORE_VERSION, routines }
  await writeDurableFile(filePath, `${JSON.stringify(payload, null, 2)}\n`)
}

async function withRoutineStoreWriteLock<T>(rootDir: string, operation: () => Promise<T>): Promise<T> {
  const key = getRoutineStorePath(rootDir)
  const previous = routineStoreWriteQueues.get(key) ?? Promise.resolve()
  let value!: T
  const operationPromise = previous
    .catch(() => undefined)
    .then(async () => {
      value = await operation()
    })
  const queueTail = operationPromise.then(() => undefined, () => undefined)
  routineStoreWriteQueues.set(key, queueTail)
  try {
    await operationPromise
    return value
  } finally {
    if (routineStoreWriteQueues.get(key) === queueTail) routineStoreWriteQueues.delete(key)
  }
}

function normalizeStore(value: unknown): RoutineFile {
  const rawRoutines =
    Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.routines) ? value.routines : []
  return {
    version: STORE_VERSION,
    routines: rawRoutines.map(normalizeStoredRoutine).filter((routine): routine is Routine => routine !== null)
  }
}

function normalizeStoredRoutine(value: unknown): Routine | null {
  if (!isRecord(value)) return null

  try {
    const id = normalizeRequiredString(value.id, 'id')
    const projectId = normalizeOptionalId(value.projectId, 'projectId')
    const projectCwd = normalizeOptionalString(value.projectCwd, 'projectCwd')?.trim() || undefined
    if (!projectId && !projectCwd) return null
    let timeZone: string | undefined
    let startAt: number | undefined
    let timingError: string | undefined
    try {
      timeZone = normalizeRoutineTimeZone(value.timeZone)
      startAt = normalizeRoutineStartAt(value.startAt)
    } catch (error) {
      timeZone = typeof value.timeZone === 'string' ? value.timeZone.slice(0, 100) : undefined
      timingError = error instanceof Error ? error.message : '计划时区或起始时间无效'
    }
    const routine: Routine = {
      ...copyUnknownFields(value),
      executionTarget: normalizeRoutineSessionTarget(value.executionTarget),
      goalContinuation: normalizeRoutineGoalContinuation(value.goalContinuation),
      id,
      name: normalizeRequiredString(value.name, 'name'),
      prompt: normalizeRequiredString(value.prompt ?? value.content, 'prompt'),
      content: normalizeOptionalString(value.content, 'content') ?? normalizeRequiredString(value.prompt ?? value.content, 'prompt'),
      projectId,
      goalTemplateId: normalizeOptionalId(value.goalTemplateId, 'goalTemplateId'),
      digitalWorkerId: normalizeOptionalId(value.digitalWorkerId, 'digitalWorkerId'),
      projectCwd,
      schedule: normalizeRequiredString(value.schedule ?? value.frequency, 'schedule'),
      timeZone,
      startAt,
      scheduleState: timingError ? 'invalid' : value.scheduleState === 'exhausted' || value.scheduleState === 'invalid' ? value.scheduleState : 'active',
      scheduleError: timingError ?? (typeof value.scheduleError === 'string' ? value.scheduleError.slice(0, 2000) : undefined),
      frequency: normalizeOptionalString(value.frequency, 'frequency') ?? normalizeRequiredString(value.schedule ?? value.frequency, 'schedule'),
      providerId: normalizeOptionalString(value.providerId, 'providerId') ?? '',
      model: normalizeOptionalString(value.model, 'model') ?? '',
      engine: normalizeOptionalEngine(value.engine),
      reasoningEffort: normalizeTaskReasoning(value.reasoningEffort),
      executionLocation: executionLocation(value.executionLocation),
      permissionMode: isPermissionMode(value.permissionMode) ? value.permissionMode : 'default',
      budgetUsd: isNonNegativeNumber(value.budgetUsd) ? value.budgetUsd : 0,
      notification: normalizeNotificationOptions(value.notification),
      enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
      createdAt: normalizeOptionalTimestamp(value.createdAt, 'createdAt') ?? 0,
      updatedAt: normalizeOptionalTimestamp(value.updatedAt, 'updatedAt') ?? 0,
      lastRunAt: normalizeNullableTimestamp(value.lastRunAt, 'lastRunAt') ?? null
    }
    const nextRunAt = normalizeNullableTimestamp(value.nextRunAt, 'nextRunAt')
    if (nextRunAt !== null && !timingError) routine.nextRunAt = nextRunAt
    return routine
  } catch {
    return null
  }
}

function resolveRootDir(rootDir: string): string {
  if (typeof rootDir !== 'string' || rootDir.trim() === '') {
    throw new RoutineStoreValidationError('rootDir is required')
  }
  return path.resolve(rootDir)
}

function copyUnknownFields(value: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!SCHEMA_KEYS.has(key) && fieldValue !== undefined) fields[key] = fieldValue
  }
  return fields
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RoutineStoreValidationError(`${field} is required`)
  }
  return value
}

function normalizeOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new RoutineStoreValidationError(`${field} must be a string`)
  }
  return value
}

function normalizeOptionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const id = normalizeRequiredString(value, field).trim()
  if (id.length > 256 || /[\0-\x1f\x7f]/.test(id)) {
    throw new RoutineStoreValidationError(`${field} is invalid`)
  }
  return id
}

function normalizePermissionMode(value: unknown): RoutinePermissionMode {
  if (!isPermissionMode(value)) {
    throw new RoutineStoreValidationError('permissionMode must be one of: default, acceptEdits, plan, bypassPermissions')
  }
  return value
}

function normalizeOptionalEngine(value: unknown): EngineKind | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (!isEngineKind(value)) {
    throw new RoutineStoreValidationError('engine must be one of: anthropic, gemini, openai')
  }
  return value
}

function normalizeBudget(value: unknown): number {
  if (!isNonNegativeNumber(value)) {
    throw new RoutineStoreValidationError('budgetUsd must be a non-negative number')
  }
  return value
}

function normalizeNotificationOptions(
  value: unknown,
  fallback: RoutineNotificationOptions = DEFAULT_NOTIFICATION
): RoutineNotificationOptions {
  if (value === undefined || value === null) return { ...fallback }
  if (!isRecord(value)) {
    throw new RoutineStoreValidationError('notification must be an object')
  }
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : fallback.enabled,
    onSuccess: typeof value.onSuccess === 'boolean' ? value.onSuccess : fallback.onSuccess,
    onFailure: typeof value.onFailure === 'boolean' ? value.onFailure : fallback.onFailure
  }
}

function normalizeBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new RoutineStoreValidationError(`${field} must be a boolean`)
  }
  return value
}

function normalizeOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  return normalizeBoolean(value, field)
}

function normalizeOptionalTimestamp(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!isNonNegativeNumber(value)) {
    throw new RoutineStoreValidationError(`${field} must be a non-negative timestamp`)
  }
  return value
}

function normalizeNullableTimestamp(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (!isNonNegativeNumber(value)) {
    throw new RoutineStoreValidationError(`${field} must be a non-negative timestamp or null`)
  }
  return value
}

function isPermissionMode(value: unknown): value is RoutinePermissionMode {
  return typeof value === 'string' && PERMISSION_MODES.has(value as RoutinePermissionMode)
}

function isEngineKind(value: unknown): value is EngineKind {
  return typeof value === 'string' && ENGINE_KINDS.has(value as EngineKind)
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function executionLocation(value: unknown): 'local' | 'worktree' {
  if (value === undefined || value === null || value === 'local') return 'local'
  if (value === 'worktree') return value
  throw new RoutineStoreValidationError('执行位置须为本地或 Worktree。')
}
