import { randomUUID } from 'node:crypto'
import type { DigitalWorkerBinding } from '../../shared/digital-worker-types'
import type {
  AgentEvent,
  AgentEventIdentity,
  EffectRecord,
  InteractiveOperationKind,
  SessionMeta,
  TaskRunRecord,
  TaskRunContinuation,
  TaskRunOperationMetadata,
  TaskRunStatus,
  TaskStepRecord,
  ToolExecutionRecord
} from '../../shared/types'
import { isEffectRecord, isTaskStepRecord, isToolExecutionRecord } from './task-execution'
import { isFrozenRoutingPolicyForRun, mergeFrozenRoutingPolicy } from './frozen-routing-policy'
import { canonicalJson } from './workflow-ledger-canonical'

const TERMINAL_STATUSES = new Set<TaskRunStatus>(['completed', 'failed', 'cancelled'])
const SNAPSHOT_OPTIONAL_QUARANTINE_STATUSES = new Set<TaskRunStatus>([
  'recovering',
  'waiting_reconciliation'
])
const RECENT_EVENT_IDS_LIMIT = 128

const ALLOWED_TRANSITIONS: Record<TaskRunStatus, ReadonlySet<TaskRunStatus>> = {
  queued: new Set(['planning', 'executing', 'waiting_reconciliation', 'recovering', 'completed', 'failed', 'cancelled']),
  planning: new Set(['executing', 'waiting_approval', 'waiting_reconciliation', 'recovering', 'completed', 'failed', 'cancelled']),
  executing: new Set(['waiting_approval', 'waiting_reconciliation', 'verifying', 'recovering', 'completed', 'failed', 'cancelled']),
  waiting_approval: new Set(['executing', 'waiting_reconciliation', 'recovering', 'failed', 'cancelled']),
  waiting_reconciliation: new Set(['executing', 'recovering', 'failed', 'cancelled']),
  verifying: new Set(['executing', 'waiting_approval', 'waiting_reconciliation', 'recovering', 'completed', 'failed', 'cancelled']),
  recovering: new Set(['planning', 'executing', 'waiting_approval', 'waiting_reconciliation', 'verifying', 'completed', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(['waiting_reconciliation', 'recovering']),
  cancelled: new Set()
}

export interface CreateTaskRunInput {
  sessionId: string
  taskId: string
  now?: number
  id?: string
  continuation?: TaskRunContinuation
  operation?: TaskRunOperationMetadata
  digitalWorkerBinding?: DigitalWorkerBinding
}

export interface TaskRunTransitionOptions {
  now?: number
  lastEventKind?: AgentEvent['kind']
  messageId?: string
  pendingPermissionRequestId?: string
  error?: string
}

export function createTaskRun(input: CreateTaskRunInput): TaskRunRecord {
  const now = input.now ?? Date.now()
  return {
    schemaVersion: 1,
    id: input.id ?? randomUUID(),
    sessionId: input.sessionId,
    taskId: input.taskId,
    ...(input.digitalWorkerBinding
      ? { digitalWorkerBinding: cloneDigitalWorkerBinding(input.digitalWorkerBinding) }
      : {}),
    status: 'queued',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: now,
    updatedAt: now,
    ...(input.continuation ? { continuation: { ...input.continuation } } : {}),
    ...(input.operation ? { operation: { ...input.operation } } : {}),
    steps: [],
    toolExecutions: [],
    effects: []
  }
}

export function createSessionTaskRun(
  meta: Pick<SessionMeta,
    'id' | 'childTaskId' | 'digitalWorkerBinding' | 'conversationForkSourceSdkSessionId' |
    'conversationForkCheckpointId' | 'conversationForkSourceSessionId' | 'conversationForkSourceRunId'>
): TaskRunRecord {
  return createTaskRun({
    sessionId: meta.id,
    taskId: meta.childTaskId ?? meta.id,
    digitalWorkerBinding: meta.digitalWorkerBinding,
    continuation: sessionTaskRunContinuation(meta)
  })
}

function sessionTaskRunContinuation(
  meta: Pick<SessionMeta,
    'conversationForkSourceSdkSessionId' | 'conversationForkSourceSessionId' |
    'conversationForkCheckpointId' | 'conversationForkSourceRunId'>
): TaskRunContinuation | undefined {
  const values = [
    meta.conversationForkSourceSdkSessionId,
    meta.conversationForkSourceSessionId,
    meta.conversationForkSourceRunId
  ]
  if (values.every((value) => value === undefined)) return undefined
  if (meta.conversationForkSourceRunId === undefined) return undefined
  if (!values.every((value) => typeof value === 'string' && value.trim().length > 0)) {
    throw new Error('conversation fork Run lineage is incomplete')
  }
  return {
    schemaVersion: 1,
    kind: 'conversation_fork',
    sourceSdkSessionId: meta.conversationForkSourceSdkSessionId!,
    sourceSessionId: meta.conversationForkSourceSessionId!,
    sourceRunId: meta.conversationForkSourceRunId!,
    sourceCheckpointId: meta.conversationForkCheckpointId
  }
}

export function isTaskRunTerminal(status: TaskRunStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** Quarantined Runs remain inspectable, but cannot be replayed without an explicit recovery Snapshot. */
export function taskRunRequiresRecoverySnapshot(status: TaskRunStatus): boolean {
  return !isTaskRunTerminal(status) && !SNAPSHOT_OPTIONAL_QUARANTINE_STATUSES.has(status)
}

export function hasTaskRunAppliedEvent(current: TaskRunRecord, identity: AgentEventIdentity): boolean {
  if (current.recentEventIds?.includes(identity.eventId)) return true
  return typeof current.lastAppliedEventSeq === 'number' && identity.seq <= current.lastAppliedEventSeq
}

export function recordTaskRunEvent(
  current: TaskRunRecord,
  identity: AgentEventIdentity,
  bumpRevision = false
): TaskRunRecord {
  const recentEventIds = [...(current.recentEventIds ?? []), identity.eventId].slice(-RECENT_EVENT_IDS_LIMIT)
  return {
    ...current,
    revision: bumpRevision ? current.revision + 1 : current.revision,
    lastAppliedEventId: identity.eventId,
    lastAppliedEventSeq: identity.seq,
    recentEventIds
  }
}

/**
 * Merge concurrent mutations of one TaskRun. Event progress and the external
 * effect ledger have independent revision domains, so neither may replace the
 * other through whole-record freshness ordering.
 */
export function mergeTaskRunRecords(
  current: TaskRunRecord,
  incoming: TaskRunRecord
): TaskRunRecord {
  const routingPolicy = mergeFrozenRoutingPolicy(current, incoming)
  if (current.id !== incoming.id || current.sessionId !== incoming.sessionId) return incoming
  const preferred = compareTaskRunFreshness(current, incoming) >= 0 ? current : incoming
  const other = preferred === current ? incoming : current
  const effects = mergeEffects(preferred.effects ?? [], other.effects ?? [])
  const continuation = mergeRunContinuation(current.continuation, incoming.continuation)
  const operation = mergeOperationMetadata(current.operation, incoming.operation)
  const digitalWorkerBinding = mergeDigitalWorkerBinding(
    current.digitalWorkerBinding,
    incoming.digitalWorkerBinding
  )
  const merged: TaskRunRecord = {
    ...preferred,
    revision: Math.max(current.revision, incoming.revision),
    updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
    recentEventIds: mergeRecentEventIds(other.recentEventIds, preferred.recentEventIds),
    steps: mergeRecords(
      preferred.steps ?? [],
      other.steps ?? [],
      (left, right) => compareEventRecordFreshness(left, right) >= 0 ? left : right
    ),
    toolExecutions: mergeRecords(
      preferred.toolExecutions ?? [],
      other.toolExecutions ?? [],
      (left, right) => mergeToolExecutions(left, right, effects)
    ),
    effects,
    ...(routingPolicy ? { routingPolicy } : {}),
    ...(continuation ? { continuation } : {}),
    ...(operation ? { operation } : {}),
    ...(digitalWorkerBinding ? { digitalWorkerBinding } : {})
  }
  return projectUnresolvedEffectState(merged)
}

function mergeRunContinuation(
  current: TaskRunContinuation | undefined,
  incoming: TaskRunContinuation | undefined
): TaskRunContinuation | undefined {
  if (!current) return incoming
  if (!incoming) return current
  if (canonicalJson(current) !== canonicalJson(incoming)) {
    throw new Error('TaskRun continuation lineage is immutable')
  }
  return current
}

function mergeOperationMetadata(
  current: TaskRunOperationMetadata | undefined,
  incoming: TaskRunOperationMetadata | undefined
): TaskRunOperationMetadata | undefined {
  if (!current) return incoming
  if (!incoming) return current
  if (
    current.schemaVersion !== incoming.schemaVersion ||
    current.operationId !== incoming.operationId ||
    current.source !== incoming.source ||
    current.kind !== incoming.kind ||
    current.sourceSessionId !== incoming.sourceSessionId ||
    current.projectId !== incoming.projectId ||
    current.title !== incoming.title
  ) {
    throw new Error('TaskRun operation 元数据发生不可变字段冲突')
  }
  return current
}

export function compareTaskRunFreshness(left: TaskRunRecord, right: TaskRunRecord): number {
  const leftSeq = left.lastAppliedEventSeq ?? 0
  const rightSeq = right.lastAppliedEventSeq ?? 0
  if (leftSeq !== rightSeq) return leftSeq - rightSeq
  if (left.revision !== right.revision) return left.revision - right.revision
  return left.updatedAt - right.updatedAt
}

function mergeEffects(preferred: EffectRecord[], other: EffectRecord[]): EffectRecord[] {
  return mergeRecords(preferred, other, (left, right) => {
    const selected = compareEffectFreshness(left, right) >= 0 ? left : right
    return {
      ...selected,
      revision: Math.max(left.revision, right.revision),
      updatedAt: Math.max(left.updatedAt, right.updatedAt),
      evidence: mergeEffectEvidence(left, right)
    }
  })
}

function compareEffectFreshness(left: EffectRecord, right: EffectRecord): number {
  if (left.revision !== right.revision) return left.revision - right.revision
  const phase = effectStatusPhase(left.status) - effectStatusPhase(right.status)
  if (phase !== 0) return phase
  return left.updatedAt - right.updatedAt
}

function effectStatusPhase(status: EffectRecord['status']): number {
  if (status === 'compensated') return 5
  if (status === 'confirmed' || status === 'failed' || status === 'abandoned') return 4
  if (status === 'waiting_reconciliation') return 3
  if (status === 'executing') return 2
  return 1
}

function projectUnresolvedEffectState(run: TaskRunRecord): TaskRunRecord {
  const effects = run.effects ?? []
  const waiting = effects.some((effect) => effect.status === 'waiting_reconciliation')
  const inFlight = effects.some(
    (effect) => effect.status === 'prepared' || effect.status === 'executing'
  )
  if (!waiting && !(inFlight && isTaskRunTerminal(run.status))) return run
  if (run.status === 'waiting_reconciliation' && run.finishedAt === undefined && run.error === undefined) {
    return run
  }
  return {
    ...run,
    status: 'waiting_reconciliation',
    revision: run.revision + 1,
    finishedAt: undefined
  }
}

function mergeEffectEvidence(left: EffectRecord, right: EffectRecord): EffectRecord['evidence'] {
  const byId = new Map(left.evidence.map((item) => [item.id, item]))
  for (const item of right.evidence) {
    if (!byId.has(item.id)) byId.set(item.id, item)
  }
  return [...byId.values()].sort((a, b) => a.observedAt - b.observedAt)
}

function mergeToolExecutions(
  left: ToolExecutionRecord,
  right: ToolExecutionRecord,
  effects: EffectRecord[]
): ToolExecutionRecord {
  const preferred = compareEventRecordFreshness(left, right) >= 0 ? left : right
  const other = preferred === left ? right : left
  let merged: ToolExecutionRecord = {
    ...preferred,
    stepId: preferred.stepId ?? other.stepId,
    requestId: preferred.requestId ?? other.requestId,
    permissionDecision: preferred.permissionDecision ?? other.permissionDecision,
    inputDigest: preferred.inputDigest ?? other.inputDigest,
    outputDigest: preferred.outputDigest ?? other.outputDigest,
    idempotencyKey: preferred.idempotencyKey ?? other.idempotencyKey,
    effectId: preferred.effectId ?? other.effectId,
    effectKey: preferred.effectKey ?? other.effectKey,
    effectStatus: preferred.effectStatus ?? other.effectStatus,
    duplicateOfExecutionId: preferred.duplicateOfExecutionId ?? other.duplicateOfExecutionId,
    supersededByExecutionId: preferred.supersededByExecutionId ?? other.supersededByExecutionId,
    requestedEventId: preferred.requestedEventId ?? other.requestedEventId,
    approvalRequestedEventId:
      preferred.approvalRequestedEventId ?? other.approvalRequestedEventId,
    approvalResolvedEventId:
      preferred.approvalResolvedEventId ?? other.approvalResolvedEventId,
    toolStartEventId: preferred.toolStartEventId ?? other.toolStartEventId,
    resultEventId: preferred.resultEventId ?? other.resultEventId,
    startedAt: minDefined(preferred.startedAt, other.startedAt),
    finishedAt: maxDefined(preferred.finishedAt, other.finishedAt),
    updatedAt: Math.max(preferred.updatedAt, other.updatedAt)
  }
  const effect = effects.find(
    (item) => item.id === merged.effectId || item.toolUseId === merged.toolUseId
  )
  if (effect) merged = projectEffectToToolExecution(merged, effect)
  return merged
}

function projectEffectToToolExecution(
  execution: ToolExecutionRecord,
  effect: EffectRecord
): ToolExecutionRecord {
  let status = execution.status
  if (status !== 'superseded') {
    if (effect.status === 'confirmed' || effect.status === 'compensated') status = 'succeeded'
    if (effect.status === 'waiting_reconciliation') status = 'unknown_outcome'
    if (effect.status === 'failed') status = 'failed'
    if (effect.status === 'abandoned') status = 'cancelled'
  }
  const terminal =
    effect.status === 'confirmed' ||
    effect.status === 'failed' ||
    effect.status === 'compensated' ||
    effect.status === 'abandoned'
  return {
    ...execution,
    status,
    effectId: effect.id,
    effectKey: effect.effectKey,
    effectStatus: effect.status,
    updatedAt: Math.max(execution.updatedAt, effect.updatedAt),
    finishedAt: terminal
      ? maxDefined(execution.finishedAt, effect.terminalAt ?? effect.updatedAt)
      : execution.finishedAt,
    error:
      execution.status === 'superseded'
        ? execution.error
        : effect.status === 'confirmed' || effect.status === 'compensated'
        ? undefined
        : effect.error ?? execution.error
  }
}

function compareEventRecordFreshness(
  left: TaskStepRecord | ToolExecutionRecord,
  right: TaskStepRecord | ToolExecutionRecord
): number {
  const leftSeq = left.lastEventSeq ?? 0
  const rightSeq = right.lastEventSeq ?? 0
  if (leftSeq !== rightSeq) return leftSeq - rightSeq
  return left.updatedAt - right.updatedAt
}

function mergeRecords<T extends { id: string }>(
  preferred: T[],
  other: T[],
  merge: (left: T, right: T) => T
): T[] {
  const otherById = new Map(other.map((item) => [item.id, item]))
  const merged = preferred.map((item) => {
    const counterpart = otherById.get(item.id)
    otherById.delete(item.id)
    return counterpart ? merge(item, counterpart) : item
  })
  return [...merged, ...otherById.values()]
}

function mergeRecentEventIds(
  earlier: string[] | undefined,
  later: string[] | undefined
): string[] | undefined {
  const merged = [...new Set([...(earlier ?? []), ...(later ?? [])])].slice(-RECENT_EVENT_IDS_LIMIT)
  return merged.length > 0 ? merged : undefined
}

function minDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.min(left, right)
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.max(left, right)
}

export function transitionTaskRun(
  current: TaskRunRecord,
  status: TaskRunStatus,
  options: TaskRunTransitionOptions = {}
): TaskRunRecord {
  const now = options.now ?? Date.now()
  if (status !== current.status && !ALLOWED_TRANSITIONS[current.status].has(status)) {
    throw new Error(`非法 TaskRun 状态转换:${current.status} -> ${status}`)
  }
  const recoveringAgain = status === 'recovering' && current.status !== 'recovering'
  const terminal = isTaskRunTerminal(status)
  return {
    ...current,
    status,
    revision: current.revision + 1,
    attempt: recoveringAgain ? current.attempt + 1 : current.attempt,
    recoveryCount: recoveringAgain ? current.recoveryCount + 1 : current.recoveryCount,
    updatedAt: now,
    startedAt: current.startedAt ?? (status === 'planning' || status === 'executing' ? now : undefined),
    finishedAt: terminal ? now : undefined,
    lastEventKind: options.lastEventKind ?? current.lastEventKind,
    messageId: options.messageId ?? current.messageId,
    pendingPermissionRequestId:
      status === 'waiting_approval'
        ? options.pendingPermissionRequestId ?? current.pendingPermissionRequestId
        : undefined,
    error: status === 'failed' ? options.error ?? current.error ?? '任务执行失败' : undefined
  }
}

export function reduceTaskRunEvent(current: TaskRunRecord, event: AgentEvent, now = Date.now()): TaskRunRecord {
  if (event.kind === 'user-message' && current.status === 'queued') {
    return transitionTaskRun(current, 'planning', {
      now,
      lastEventKind: event.kind,
      messageId: event.messageId
    })
  }
  if (
    event.kind === 'status' &&
    event.status === 'running' &&
    (current.status === 'queued' || current.status === 'planning' || current.status === 'recovering')
  ) {
    return transitionTaskRun(current, 'executing', { now, lastEventKind: event.kind })
  }
  if (
    event.kind === 'tool-start' &&
    (current.status === 'queued' || current.status === 'planning' || current.status === 'recovering')
  ) {
    return transitionTaskRun(current, 'executing', { now, lastEventKind: event.kind })
  }
  if (event.kind === 'permission-request' && !isTaskRunTerminal(current.status)) {
    return transitionTaskRun(current, 'waiting_approval', {
      now,
      lastEventKind: event.kind,
      pendingPermissionRequestId: event.request.requestId
    })
  }
  if (event.kind === 'permission-resolved' && current.status === 'waiting_approval') {
    const pending = current.toolExecutions?.find((execution) => execution.status === 'waiting_approval')
    if (pending) {
      return transitionTaskRun(current, 'waiting_approval', {
        now,
        lastEventKind: event.kind,
        pendingPermissionRequestId: pending.requestId
      })
    }
    return transitionTaskRun(current, 'executing', { now, lastEventKind: event.kind })
  }
  if (event.kind === 'turn-result' && !isTaskRunTerminal(current.status)) {
    if (current.effects?.some((effect) =>
      effect.status === 'prepared' ||
      effect.status === 'executing' ||
      effect.status === 'waiting_reconciliation'
    )) {
      return current.status === 'waiting_reconciliation'
        ? current
        : transitionTaskRun(current, 'waiting_reconciliation', {
            now,
            lastEventKind: event.kind,
            error: '任务包含尚未完成真实状态对账的外部副作用'
          })
    }
    const interrupted = event.isError && /interrupt|cancel/i.test(event.subtype ?? '')
    return transitionTaskRun(current, interrupted ? 'cancelled' : event.isError ? 'failed' : 'completed', {
      now,
      lastEventKind: event.kind,
      error: event.isError ? event.resultText ?? event.subtype : undefined
    })
  }
  if (event.kind === 'status' && event.status === 'error' && !isTaskRunTerminal(current.status)) {
    if (current.effects?.some((effect) =>
      effect.status === 'prepared' ||
      effect.status === 'executing' ||
      effect.status === 'waiting_reconciliation'
    )) {
      return current.status === 'waiting_reconciliation'
        ? current
        : transitionTaskRun(current, 'waiting_reconciliation', {
            now,
            lastEventKind: event.kind,
            error: event.error ?? '执行器异常退出，外部副作用尚未完成真实状态对账'
          })
    }
    return transitionTaskRun(current, 'failed', {
      now,
      lastEventKind: event.kind,
      error: event.error
    })
  }
  return current
}

export function isTaskRunRecord(value: unknown): value is TaskRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return [
    isTaskRunIdentity(record),
    isTaskRunCounters(record),
    isTaskRunTiming(record),
    isTaskRunEventCursor(record),
    isTaskRunOptionalFields(record),
    isTaskRunCollections(record)
  ].every(Boolean)
}

function isTaskRunIdentity(record: Record<string, unknown>): boolean {
  return [
    record.schemaVersion === 1,
    typeof record.id === 'string',
    typeof record.sessionId === 'string',
    typeof record.taskId === 'string',
    isTaskRunStatus(record.status)
  ].every(Boolean)
}

function isTaskRunStatus(value: unknown): boolean {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, value)
}

function isTaskRunCounters(record: Record<string, unknown>): boolean {
  return [
    isPositiveInteger(record.revision),
    isPositiveInteger(record.attempt),
    isNonNegativeInteger(record.recoveryCount)
  ].every(Boolean)
}

function isTaskRunTiming(record: Record<string, unknown>): boolean {
  return [
    isFiniteNumber(record.createdAt),
    isFiniteNumber(record.updatedAt),
    isOptionalFiniteNumber(record.startedAt),
    isOptionalFiniteNumber(record.finishedAt)
  ].every(Boolean)
}

function isTaskRunEventCursor(record: Record<string, unknown>): boolean {
  return [
    isOptionalNonNegativeInteger(record.lastAppliedEventSeq),
    isOptionalRecentEventIds(record.recentEventIds)
  ].every(Boolean)
}

function isTaskRunOptionalFields(record: Record<string, unknown>): boolean {
  return [
    isOptionalString(record.messageId),
    isOptionalString(record.pendingPermissionRequestId),
    isOptionalString(record.lastAppliedEventId),
    isOptionalString(record.lastEventKind),
    isOptionalString(record.error),
    isFrozenRoutingPolicyForRun(record),
    record.continuation === undefined || isTaskRunContinuation(record.continuation),
    isOptionalDigitalWorkerBinding(record.digitalWorkerBinding),
    record.operation === undefined || isTaskRunOperationMetadata(record.operation)
  ].every(Boolean)
}

function isTaskRunContinuation(value: unknown): value is TaskRunContinuation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) return false
  if (record.kind === 'conversation_fork') {
    return isNonEmptyString(record.sourceSessionId) && isNonEmptyString(record.sourceRunId) &&
      isNonEmptyString(record.sourceSdkSessionId) &&
      (record.sourceCheckpointId === undefined || isNonEmptyString(record.sourceCheckpointId))
  }
  return record.kind === 'work_item_transfer' &&
    isNonEmptyString(record.requestId) && isNonEmptyString(record.assignmentId) &&
    (record.sourceSessionId === undefined || isNonEmptyString(record.sourceSessionId)) &&
    (record.sourceRunId === undefined || isNonEmptyString(record.sourceRunId))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isTaskRunCollections(record: Record<string, unknown>): boolean {
  return [
    isOptionalRecordArray(record.steps, isTaskStepRecord),
    isOptionalRecordArray(record.toolExecutions, isToolExecutionRecord),
    isOptionalRecordArray(record.effects, isEffectRecord)
  ].every(Boolean)
}

function isOptionalRecordArray<T>(
  value: unknown,
  predicate: (item: unknown) => item is T
): boolean {
  return value === undefined || (Array.isArray(value) && value.every(predicate))
}

function isOptionalRecentEventIds(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length > RECENT_EVENT_IDS_LIMIT) return false
  return value.every((eventId) => typeof eventId === 'string')
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value)
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalDigitalWorkerBinding(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (record.kind === 'unscoped' && Object.keys(record).length === 1) || (
    record.kind === 'assigned' && Object.keys(record).length === 3 &&
    typeof record.workerId === 'string' && Boolean(record.workerId.trim()) &&
    typeof record.assignmentId === 'string' && Boolean(record.assignmentId.trim())
  )
}

function mergeDigitalWorkerBinding(
  current: DigitalWorkerBinding | undefined,
  incoming: DigitalWorkerBinding | undefined
): DigitalWorkerBinding | undefined {
  if (!current) return incoming ? cloneDigitalWorkerBinding(incoming) : undefined
  if (!incoming) return cloneDigitalWorkerBinding(current)
  if (current.kind !== incoming.kind || (current.kind === 'assigned' && (
    incoming.kind !== 'assigned' || current.workerId !== incoming.workerId ||
    current.assignmentId !== incoming.assignmentId
  ))) {
    throw new Error('TaskRun DigitalWorker identity binding conflict')
  }
  return cloneDigitalWorkerBinding(current)
}

function cloneDigitalWorkerBinding(binding: DigitalWorkerBinding): DigitalWorkerBinding {
  return binding.kind === 'unscoped'
    ? { kind: 'unscoped' }
    : { kind: 'assigned', workerId: binding.workerId, assignmentId: binding.assignmentId }
}

const interactiveOperationKinds = new Set<InteractiveOperationKind>([
  'file_write',
  'attachment_write',
  'mcp_probe',
  'migration_import',
  'terminal_action',
  'browser_navigation',
  'plugin_install',
  'plugin_uninstall',
  'workspace_hunk_discard',
  'git_commit',
  'git_index_update',
  'workspace_handoff',
  'task_handoff',
  'managed_worktree_create',
  'managed_worktree_remove',
  'worktree_patch_apply',
  'git_push',
  'pull_request_create',
  'issue_create',
  'checkpoint_restore',
  'provider_operation',
  'migration_apply',
  'migration_rollback',
  'project_export',
  'project_import',
  'project_delete',
  'media_generation'
])

function isTaskRunOperationMetadata(value: unknown): value is TaskRunOperationMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.schemaVersion === 1 &&
    (record.source === 'renderer' || record.source === 'dag' || record.source === 'session_lifecycle') &&
    typeof record.operationId === 'string' &&
    interactiveOperationKinds.has(record.kind as InteractiveOperationKind) &&
    typeof record.sourceSessionId === 'string' &&
    (record.projectId === undefined || typeof record.projectId === 'string') &&
    typeof record.title === 'string'
  )
}
