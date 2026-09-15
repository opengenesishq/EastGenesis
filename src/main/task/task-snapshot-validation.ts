import type {
  AgentEvent, EngineKind, SessionMeta, SessionStatus,
  TaskDagExecutionView, TaskDagFinalizationRecord, TaskDagRuntimeSnapshot,
  TaskSnapshotExecutionPosition, TaskSnapshotReason, TaskSnapshotRecord,
  TaskSnapshotReplayCandidate, TaskSnapshotSubtaskState, TaskSnapshotSubtaskStatus,
  TaskSnapshotWorktreeInfo, TranscriptEntry, UsageTotals
} from '../../shared/types'
import { isTaskRunRecord } from './task-run'
import { hasConsistentTaskSnapshotIdentity } from './task-snapshot-identity'

type Validator = (value: unknown) => boolean

const SESSION_STATUSES = new Set<unknown>(['starting', 'running', 'idle', 'error', 'closed'])
// Legacy Claude snapshots remain readable so recovery can migrate them to native Anthropic.
const ENGINE_KINDS = new Set<unknown>(['claude', 'anthropic', 'gemini', 'openai'])
const SNAPSHOT_REASONS = new Set<unknown>(['created', 'important-event', 'event-batch', 'shutdown', 'recovered'])
const SUBTASK_STATUSES = new Set<unknown>(['pending', 'running', 'success', 'failed', 'closed'])
const DAG_TASK_STATUSES = new Set<unknown>(['waiting', 'running', 'success', 'failed'])
const DAG_FINALIZATION_PHASES = new Set<unknown>([
  'prepared', 'merging', 'verifying', 'rollback_pending', 'merge_settled',
  'summary_pending', 'summary_delivered', 'waiting_reconciliation', 'completed'
])
const EFFECT_STATUSES = new Set<unknown>([
  'prepared', 'executing', 'waiting_reconciliation', 'confirmed',
  'failed', 'compensated', 'abandoned'
])
const AUTO_MERGE_STATUSES = new Set<unknown>(['running', 'success', 'partial', 'failed', 'rolled-back'])
const AUTO_MERGE_ENTRY_STATUSES = new Set<unknown>(['merged', 'skipped', 'blocked', 'failed', 'rolled-back'])
const AUTO_MERGE_VERIFICATION_STATUSES = new Set<unknown>(['passed', 'failed', 'skipped', 'not-run'])
const AGENT_EVENT_KINDS = new Set<unknown>([
  'status', 'init', 'meta', 'user-message', 'checkpoint', 'checkpoint-restore',
  'routing', 'failover', 'provider-key-failover', 'provider-model-failover',
  'provider-protocol-failover', 'provider-recovery-exhausted', 'text-delta', 'thinking-delta',
  'tool-start', 'assistant-message', 'tool-result', 'permission-request',
  'permission-resolved', 'turn-result', 'subagent-result', 'task-dag-update', 'hook-event'
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function hasShape(value: unknown, fields: Readonly<Record<string, Validator>>): value is Record<string, unknown> {
  const record = asRecord(value)
  return Boolean(record && Object.entries(fields).every(([key, validate]) => validate(record[key])))
}

function optional(validate: Validator): Validator {
  return (value) => value === undefined || validate(value)
}

function nullable(validate: Validator): Validator {
  return (value) => value === null || validate(value)
}

function arrayOf(validate: Validator): Validator {
  return (value) => Array.isArray(value) && value.every(validate)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isTrue(value: unknown): value is true {
  return value === true
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return SESSION_STATUSES.has(value)
}

function isEngineKind(value: unknown): boolean {
  return ENGINE_KINDS.has(value)
}

function isUsageTotals(value: unknown): value is UsageTotals {
  return hasShape(value, {
    input: isNumber,
    output: isNumber,
    cacheRead: isNumber,
    cacheCreation: isNumber
  })
}

function isSessionMeta(value: unknown): value is SessionMeta {
  return hasShape(value, {
    id: isString,
    title: isString,
    cwd: isString,
    model: isString,
    providerId: isString,
    status: isSessionStatus,
    taskStrategy: optional(isString),
    taskExecutionAuthorityRequired: optional((value: unknown) => value === true),
    permissionMode: isString,
    usage: isUsageTotals,
    costUsd: isNumber,
    contextTokens: isNumber,
    createdAt: isNumber,
    engine: optional(isEngineKind)
  })
}

function isTaskSnapshotReason(value: unknown): value is TaskSnapshotReason {
  return SNAPSHOT_REASONS.has(value)
}

function isAgentEventKind(value: unknown): value is AgentEvent['kind'] {
  return AGENT_EVENT_KINDS.has(value)
}

function isAgentEvent(value: unknown): value is AgentEvent {
  const record = asRecord(value)
  return Boolean(record && isAgentEventKind(record.kind))
}

export function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  return hasShape(value, {
    seq: isNumber,
    ledgerVersion: optional((candidate) => candidate === 1),
    previousDigest: optional(isString),
    digest: optional(isString),
    eventId: optional(isString),
    occurredAt: optional(isFiniteNumber),
    streamId: optional(isString),
    causationId: optional(isString),
    correlationId: optional(isString),
    event: isAgentEvent
  })
}

function isEventCursor(value: unknown): boolean {
  return hasShape(value, {
    seq: (candidate) => isNumber(candidate) && Number.isInteger(candidate) && candidate >= 0,
    eventId: optional(isString)
  })
}

function isExecutionPosition(value: unknown): value is TaskSnapshotExecutionPosition {
  return hasShape(value, {
    status: isSessionStatus,
    lastSeq: isNumber,
    cursor: optional(isEventCursor),
    lastEventId: optional(isString),
    lastEventAt: isNumber,
    lastEventKind: optional(isAgentEventKind),
    sdkSessionId: optional(isString),
    resumeSessionAt: optional(isString),
    lastCheckpointMessageId: optional(isString),
    lastUserMessageId: optional(isString)
  })
}

function isReplayCandidate(value: unknown): value is TaskSnapshotReplayCandidate {
  return hasShape(value, {
    messageId: isString,
    text: isString,
    seq: isNumber,
    capturedAt: isNumber,
    reason: (candidate) => candidate === 'running-user-message'
  })
}

function isWorktreeInfo(value: unknown): value is TaskSnapshotWorktreeInfo {
  return hasShape(value, {
    isolated: optional(isBoolean),
    sourceCwd: optional(isString),
    repoRoot: optional(isString),
    worktreePath: optional(isString),
    branch: optional(isString),
    baseBranch: optional(nullable(isString)),
    baseSha: optional(isString),
    state: optional((candidate) => candidate === 'active' || candidate === 'removed')
  })
}

function isSubtaskStatus(value: unknown): value is TaskSnapshotSubtaskStatus {
  return SUBTASK_STATUSES.has(value)
}

export function isSubtaskState(value: unknown): value is TaskSnapshotSubtaskState {
  return hasShape(value, {
    sessionId: isString,
    status: isSubtaskStatus,
    taskId: optional(isString),
    role: optional(isString),
    resultText: optional(isString),
    costUsd: optional(isFiniteNumber),
    branch: optional(isString),
    worktreePath: optional(isString)
  })
}

function isTaskDagTask(value: unknown): boolean {
  return hasShape(value, {
    id: isString,
    title: isString,
    description: isString,
    dependencies: arrayOf(isString),
    role: isString,
    prompt: isString,
    workItemId: optional(isString)
  })
}

function isTaskDag(value: unknown): boolean {
  return hasShape(value, {
    id: isString,
    title: isString,
    source: isString,
    complexity: (candidate) => candidate === 'single' || candidate === 'multi',
    createdAt: isNumber,
    tasks: arrayOf(isTaskDagTask)
  })
}

function isTaskDagTaskStatus(value: unknown): boolean {
  return DAG_TASK_STATUSES.has(value)
}

function isTaskDagExecutionTask(value: unknown): boolean {
  return hasShape(value, {
    task: isTaskDagTask,
    status: isTaskDagTaskStatus,
    attempts: isNumber,
    sessionIds: arrayOf(isString),
    startedAt: optional(isFiniteNumber),
    completedAt: optional(isFiniteNumber),
    resultText: optional(isString),
    error: optional(isString)
  })
}

export function isTaskDagExecutionView(value: unknown): value is TaskDagExecutionView {
  return hasShape(value, {
    id: isString,
    parentSessionId: isString,
    dag: isTaskDag,
    status: isTaskDagTaskStatus,
    maxRetries: isNumber,
    startedAt: isNumber,
    completedAt: optional(isFiniteNumber),
    layers: arrayOf(arrayOf(isString)),
    tasks: arrayOf(isTaskDagExecutionTask),
    summary: optional(isString),
    error: optional(isString),
    autoMerge: optional(isTaskDagAutoMergeView),
    finalization: optional(isTaskDagFinalizationView)
  })
}

function isEffectStatus(value: unknown): boolean {
  return EFFECT_STATUSES.has(value)
}

function isTaskDagAutoMergeVerification(value: unknown): boolean {
  return hasShape(value, {
    status: (candidate) => AUTO_MERGE_VERIFICATION_STATUSES.has(candidate),
    command: optional(isString),
    cwd: optional(isString),
    exitCode: optional(nullable(isNumber)),
    durationMs: optional(isFiniteNumber),
    output: optional(isString),
    error: optional(isString)
  })
}

function isTaskDagAutoMergeEntry(value: unknown): boolean {
  return hasShape(value, {
    taskId: isString,
    status: (candidate) => AUTO_MERGE_ENTRY_STATUSES.has(candidate),
    sessionId: optional(isString),
    branch: optional(isString),
    worktreePath: optional(isString),
    changedFiles: optional(isFiniteNumber),
    insertions: optional(isFiniteNumber),
    deletions: optional(isFiniteNumber),
    conflictRisk: optional(isString),
    patchSha256: optional(isString),
    patchPath: optional(isString),
    commitSha: optional(isString),
    effectStatus: optional(isEffectStatus),
    operationId: optional(isString),
    reconciliationRequired: optional(isBoolean),
    error: optional(isString),
    conflicts: optional(isArray),
    resolverPrompt: optional(isString)
  })
}

function isTaskDagAutoMergeRollbackEntry(value: unknown): boolean {
  return hasShape(value, {
    taskId: isString,
    status: (candidate) => candidate === 'rolled-back' || candidate === 'failed',
    effectStatus: optional(isEffectStatus),
    operationId: optional(isString),
    reconciliationRequired: optional(isBoolean),
    error: optional(isString)
  })
}

function isTaskDagAutoMergeRollback(value: unknown): boolean {
  return hasShape(value, {
    attempted: isBoolean,
    ok: isBoolean,
    entries: optional(arrayOf(isTaskDagAutoMergeRollbackEntry)),
    error: optional(isString)
  })
}

function isTaskDagAutoMergeView(value: unknown): boolean {
  return hasShape(value, {
    enabled: isTrue,
    status: (candidate) => AUTO_MERGE_STATUSES.has(candidate),
    startedAt: isNumber,
    completedAt: optional(isFiniteNumber),
    repoRoot: optional(isString),
    entries: arrayOf(isTaskDagAutoMergeEntry),
    mergedCount: isNumber,
    blockedCount: isNumber,
    skippedCount: isNumber,
    verification: optional(isTaskDagAutoMergeVerification),
    rollback: optional(isTaskDagAutoMergeRollback),
    summary: optional(isString),
    error: optional(isString)
  })
}

function isTaskDagFinalizationPhase(value: unknown): boolean {
  return DAG_FINALIZATION_PHASES.has(value)
}

function isTaskDagFinalizationView(value: unknown): boolean {
  return hasShape(value, {
    executionId: isString,
    phase: isTaskDagFinalizationPhase,
    revision: isNumber,
    updatedAt: isNumber,
    summaryMessageId: optional(isString),
    deliveredAt: optional(isFiniteNumber),
    error: optional(isString)
  })
}

function isTaskDagFinalizationSummary(value: unknown): boolean {
  return hasShape(value, {
    messageId: isString,
    text: isString,
    digest: isString,
    deliveryAttempts: isNumber,
    lastAttemptAt: optional(isFiniteNumber),
    deliveredEventId: optional(isString),
    deliveredEventSeq: optional(isFiniteNumber),
    deliveredAt: optional(isFiniteNumber)
  })
}

function isTaskDagFinalizationVerification(value: unknown): boolean {
  return hasShape(value, {
    status: (candidate) => candidate === 'not_started' || candidate === 'started' || candidate === 'settled',
    command: optional(isString),
    startedAt: optional(isFiniteNumber),
    result: optional(isTaskDagAutoMergeVerification)
  })
}

function isTaskDagFinalizationPatchPlan(value: unknown): boolean {
  return hasShape(value, {
    executionId: isString,
    taskId: isString,
    sourceSessionId: isString,
    repoRoot: isString,
    worktreePath: isString,
    baseSha: isString,
    headSha: isString,
    patchPath: isString,
    patchSha256: isString,
    patchText: isString
  })
}

export function isTaskDagFinalizationRecord(value: unknown): value is TaskDagFinalizationRecord {
  return hasShape(value, {
    schemaVersion: (candidate) => candidate === 1,
    executionId: isString,
    parentSessionId: isString,
    revision: isNumber,
    phase: isTaskDagFinalizationPhase,
    terminalExecution: isTaskDagExecutionView,
    autoMergeOptions: optional(isTaskDagRuntimeAutoMergeOptions),
    mergeSessions: arrayOf(isTaskDagRuntimeMergeSession),
    patchOperationIds: arrayOf(isString),
    rollbackOperationIds: arrayOf(isString),
    rollbackPatches: optional(arrayOf(isTaskDagFinalizationPatchPlan)),
    verification: isTaskDagFinalizationVerification,
    autoMergeResult: optional(isTaskDagAutoMergeView),
    summary: optional(isTaskDagFinalizationSummary),
    error: optional(isString),
    createdAt: isNumber,
    updatedAt: isNumber
  })
}

function isTaskDagRuntimeDispatchOptions(value: unknown): boolean {
  return hasShape(value, {
    cwd: optional(isString),
    isolated: optional(isBoolean),
    driveMode: optional(isString),
    model: optional(isString),
    providerId: optional(isString),
    engine: optional(isEngineKind),
    permissionMode: optional(isString),
    taskTimeoutMs: isNumber
  })
}

function isTaskDagRuntimeRunningTask(value: unknown): boolean {
  return hasShape(value, { taskId: isString, sessionId: isString })
}

function isTaskDagRuntimeAutoMergeOptions(value: unknown): boolean {
  return hasShape(value, {
    enabled: isBoolean,
    verificationCommand: optional(isString)
  })
}

function isTaskDagRuntimeMergeSession(value: unknown): boolean {
  return hasShape(value, {
    sessionId: isString,
    taskId: optional(isString),
    repoRoot: optional(isString),
    worktreePath: optional(isString),
    baseSha: optional(isString),
    branch: optional(isString),
    resultText: optional(isString)
  })
}

export function isTaskDagRuntimeSnapshot(value: unknown): value is TaskDagRuntimeSnapshot {
  if (!hasShape(value, {
    council: optional(isCouncilRuntimeBinding),
    executionId: isString,
    parentSessionId: isString,
    capturedAt: isNumber,
    dispatchOptions: isTaskDagRuntimeDispatchOptions,
    runningTasks: arrayOf(isTaskDagRuntimeRunningTask),
    recoveryBlockedError: optional(isString),
    mergeSessions: optional(arrayOf(isTaskDagRuntimeMergeSession)),
    autoMerge: optional(isTaskDagRuntimeAutoMergeOptions)
  })) return false
  const runtime = value as unknown as TaskDagRuntimeSnapshot
  return !runtime.council || (runtime.council.record.councilId === runtime.executionId &&
    runtime.council.record.sessionId === runtime.parentSessionId && runtime.dispatchOptions.taskTimeoutMs === runtime.council.record.limits.timeoutMs &&
    runtime.dispatchOptions.isolated === false && runtime.dispatchOptions.permissionMode === 'default' && !runtime.autoMerge?.enabled)
}

function isConversationLedgerIntegrityView(value: unknown): boolean {
  return hasShape(value, {
    schemaVersion: (candidate) => candidate === 1,
    valid: isBoolean,
    mode: (candidate) => candidate === 'empty' || candidate === 'legacy' || candidate === 'sealed',
    entryCount: (candidate) => isNumber(candidate) && Number.isInteger(candidate) && candidate >= 0,
    headDigest: optional(isString),
    error: optional(isString)
  })
}

export function isTaskSnapshotRecord(value: unknown): value is TaskSnapshotRecord {
  const record = asRecord(value)
  return Boolean(
    record &&
    hasShape(record, {
      id: isString,
      taskId: isString,
      sessionId: isString,
      title: isString,
      projectPath: isString,
      engine: optional(isEngineKind),
      model: isString,
      providerId: isString,
      createdAt: isNumber,
      updatedAt: isNumber,
      eventCount: isNumber,
      reason: isTaskSnapshotReason,
      meta: isSessionMeta,
      run: optional(isTaskRunRecord),
      execution: isExecutionPosition,
      conversationLedger: optional(isConversationLedgerIntegrityView),
      replayCandidate: optional(isReplayCandidate),
      worktree: optional(isWorktreeInfo),
      transcript: arrayOf(isTranscriptEntry),
      subtasks: arrayOf(isSubtaskState),
      dagExecutions: arrayOf(isTaskDagExecutionView),
      dagRuntimes: optional(arrayOf(isTaskDagRuntimeSnapshot))
    }) &&
    hasConsistentTaskSnapshotIdentity(record, isSessionMeta, isTaskRunRecord)
  )
}
import { isCouncilRuntimeBinding } from '../council/council-contract'
