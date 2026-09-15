import type {
  AgentEvent,
  AgentEventIdentity,
  EffectEvidenceRecord,
  EffectLease,
  EffectRecord,
  EffectStatus,
  TaskRunRecord,
  TaskStepRecord,
  TaskStepStatus,
  ToolExecutionRecord,
  ToolExecutionStatus
} from '../../shared/types'
import { isEffectTarget } from './effect-target-validation'
import {
  buildToolIdempotencyKey,
  normalizeToolName,
  stableValueDigest
} from './tool-idempotency'

const TERMINAL_STEP_STATUSES = new Set<TaskStepStatus>(['completed', 'failed', 'cancelled'])
const TERMINAL_TOOL_STATUSES = new Set<ToolExecutionStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'superseded',
  'unknown_outcome'
])

export function reduceTaskExecutionEvent(
  current: TaskRunRecord,
  event: AgentEvent,
  cwd: string,
  now = Date.now(),
  identity?: AgentEventIdentity
): TaskRunRecord {
  if (event.kind === 'status' && event.status !== 'running' && event.status !== 'error') return current
  if (
    event.kind !== 'user-message' &&
    event.kind !== 'status' &&
    event.kind !== 'permission-request' &&
    event.kind !== 'permission-resolved' &&
    event.kind !== 'tool-start' &&
    event.kind !== 'assistant-message' &&
    event.kind !== 'tool-result' &&
    event.kind !== 'turn-result'
  ) {
    return current
  }
  if (event.kind === 'assistant-message' && !event.blocks.some((block) => block.type === 'tool_use')) return current
  let steps = [...(current.steps ?? [])]
  let toolExecutions = [...(current.toolExecutions ?? [])]

  if (event.kind === 'user-message') {
    const recoveringIndex = steps.findIndex((step) => step.status === 'recovering')
    if (recoveringIndex >= 0) {
      const recovering = steps[recoveringIndex]
      steps[recoveringIndex] = {
        ...transitionStep(recovering, 'planning', event.kind, now, identity),
        messageId: recovering.messageId ?? event.messageId,
        requestText: recovering.requestText ?? event.text
      }
    } else {
      const sequence = steps.reduce((max, step) => Math.max(max, step.sequence), 0) + 1
      steps.push({
        id: `${current.id}:step:${sequence}`,
        runId: current.id,
        sessionId: current.sessionId,
        sequence,
        status: 'planning',
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        messageId: event.messageId,
        requestText: event.text,
        createdEventId: identity?.eventId,
        lastEventId: identity?.eventId,
        lastEventSeq: identity?.seq,
        lastEventKind: event.kind
      })
    }
  } else if (event.kind === 'status' && event.status === 'running') {
    steps = updateActiveStep(steps, (step) => transitionStep(step, 'executing', event.kind, now, identity))
  } else if (event.kind === 'permission-request') {
    const request = event.request
    steps = updateActiveStep(steps, (step) => ({
      ...transitionStep(step, 'waiting_approval', event.kind, now, identity),
      pendingPermissionRequestId: request.requestId
    }))
    if (request.toolUseId) {
      toolExecutions = upsertToolExecution(toolExecutions, current, cwd, {
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        status: 'waiting_approval',
        requestId: request.requestId,
        duplicateExecutionId: request.duplicateExecutionId,
        input: request.input,
        now,
        identity,
        eventPhase: 'approval-requested'
      })
    }
  } else if (event.kind === 'permission-resolved') {
    const resolvedExecution = toolExecutions.find((execution) => execution.requestId === event.requestId)
    toolExecutions = toolExecutions.map((execution) =>
      execution.requestId === event.requestId
        ? {
            ...execution,
            status: event.behavior === 'allow' ? 'approved' : 'cancelled',
            permissionDecision: event.behavior,
            approvalResolvedEventId: identity?.eventId ?? execution.approvalResolvedEventId,
            lastEventId: identity?.eventId ?? execution.lastEventId,
            lastEventSeq: identity?.seq ?? execution.lastEventSeq,
            updatedAt: now,
            finishedAt: event.behavior === 'deny' ? now : undefined
          }
        : execution
    )
    const stepIndex = resolvedExecution?.stepId
      ? steps.findIndex((step) => step.id === resolvedExecution.stepId)
      : steps.findIndex((step) => step.pendingPermissionRequestId === event.requestId)
    if (stepIndex >= 0) {
      const step = steps[stepIndex]
      const pending = toolExecutions.find(
        (execution) => execution.stepId === step.id && execution.status === 'waiting_approval'
      )
      steps[stepIndex] = pending
        ? {
            ...transitionStep(step, 'waiting_approval', event.kind, now, identity),
            pendingPermissionRequestId: pending.requestId,
            error: undefined
          }
        : {
            ...transitionStep(step, 'executing', event.kind, now, identity),
            pendingPermissionRequestId: undefined,
            error: undefined
          }
    }
  } else if (event.kind === 'tool-start') {
    steps = updateActiveStep(steps, (step) => transitionStep(step, 'executing', event.kind, now, identity))
    toolExecutions = upsertToolExecution(toolExecutions, current, cwd, {
      toolUseId: event.toolUseId,
      toolName: event.name,
      status: 'requested',
      now,
      identity,
      eventPhase: 'tool-start'
    })
  } else if (event.kind === 'assistant-message') {
    for (const block of event.blocks) {
      if (block.type !== 'tool_use') continue
      toolExecutions = upsertToolExecution(toolExecutions, current, cwd, {
        toolUseId: block.id,
        toolName: block.name,
        status: 'requested',
        input: block.input,
        now,
        identity,
        eventPhase: 'requested'
      })
    }
  } else if (event.kind === 'tool-result') {
    const completed = toolExecutions.find((execution) => execution.toolUseId === event.toolUseId)
    const effect = current.effects?.find((item) => item.toolUseId === event.toolUseId)
    const effectStatus = event.effectStatus ?? effect?.status
    toolExecutions = toolExecutions.map((execution) =>
      execution.toolUseId === event.toolUseId
        ? {
            ...execution,
            status: toolStatusFromEffect(effectStatus, event.isError),
            effectStatus: effectStatus ?? execution.effectStatus,
            outputDigest: stableValueDigest(event.content),
            resultEventId: identity?.eventId ?? execution.resultEventId,
            lastEventId: identity?.eventId ?? execution.lastEventId,
            lastEventSeq: identity?.seq ?? execution.lastEventSeq,
            updatedAt: now,
            finishedAt: now,
            error: event.isError ? '工具执行失败，详情见转录记录' : undefined
          }
        : execution
    )
    if (!event.isError && completed?.duplicateOfExecutionId) {
      toolExecutions = toolExecutions.map((execution) =>
        execution.id === completed.duplicateOfExecutionId && execution.status === 'unknown_outcome'
          ? {
              ...execution,
              status: 'superseded',
              supersededByExecutionId: completed.id,
              updatedAt: now,
              finishedAt: now,
              error: '未知结果已由用户确认后的成功重试取代'
            }
          : execution
      )
    }
    steps = updateActiveStep(steps, (step) => transitionStep(step, 'executing', event.kind, now, identity))
  } else if (event.kind === 'turn-result') {
    const interrupted = event.isError && /interrupt|cancel/i.test(event.subtype ?? '')
    steps = finishOldestStep(
      steps,
      interrupted ? 'cancelled' : event.isError ? 'failed' : 'completed',
      event.kind,
      now,
      identity,
      event.isError ? event.resultText ?? event.subtype : undefined
    )
    steps = updateActiveStep(steps, (step) =>
      step.status === 'planning'
        ? transitionStep(step, 'executing', event.kind, now, identity)
        : step
    )
  } else if (event.kind === 'status' && event.status === 'error') {
    steps = finishOldestStep(steps, 'failed', event.kind, now, identity, event.error)
  }

  return {
    ...current,
    revision: current.revision + 1,
    updatedAt: now,
    steps,
    toolExecutions
  }
}

export function recoverTaskExecutionState(current: TaskRunRecord, now = Date.now()): TaskRunRecord {
  const steps = (current.steps ?? []).map((step) =>
    TERMINAL_STEP_STATUSES.has(step.status) ||
    (step.status === 'recovering' && step.pendingPermissionRequestId === undefined)
      ? step
      : {
          ...step,
          status: 'recovering' as const,
          pendingPermissionRequestId: undefined,
          updatedAt: now,
          lastEventKind: current.lastEventKind
        }
  )
  const effects = (current.effects ?? []).map((effect) => {
    if (effect.status !== 'prepared' && effect.status !== 'executing') return effect
    return {
      ...effect,
      status: 'waiting_reconciliation' as const,
      revision: effect.revision + 1,
      lease: effect.lease && effect.lease.releasedAt === undefined
        ? { ...effect.lease, releasedAt: now }
        : effect.lease,
      updatedAt: now,
      error: '应用退出时外部副作用结果未持久化，正在等待真实状态对账'
    }
  })
  const toolExecutions = (current.toolExecutions ?? []).map((execution) => {
    const effect = effects.find((item) => item.id === execution.effectId || item.toolUseId === execution.toolUseId)
    if (effect?.status === 'confirmed') {
      return {
        ...execution,
        status: 'succeeded' as const,
        effectStatus: effect.status,
        updatedAt: Math.max(execution.updatedAt, effect.updatedAt),
        finishedAt: execution.finishedAt ?? effect.terminalAt ?? effect.updatedAt,
        error: undefined
      }
    }
    if (TERMINAL_TOOL_STATUSES.has(execution.status)) return execution
    const wasOnlyWaiting = execution.status === 'waiting_approval'
    return {
      ...execution,
      status: wasOnlyWaiting ? ('cancelled' as const) : ('unknown_outcome' as const),
      effectStatus: effect?.status ?? execution.effectStatus,
      permissionDecision: wasOnlyWaiting ? ('deny' as const) : execution.permissionDecision,
      updatedAt: now,
      finishedAt: now,
      error: wasOnlyWaiting
        ? '恢复时旧审批已作废'
        : '应用退出时工具结果未持久化，副作用结果未知'
    }
  })
  return { ...current, steps, toolExecutions, effects }
}

export function hasPendingTaskSteps(run: TaskRunRecord): boolean {
  return (run.steps ?? []).some((step) => !TERMINAL_STEP_STATUSES.has(step.status))
}

export function isTaskStepRecord(value: unknown): value is TaskStepRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.runId === 'string' &&
    typeof record.sessionId === 'string' &&
    typeof record.sequence === 'number' &&
    Number.isInteger(record.sequence) &&
    record.sequence > 0 &&
    typeof record.status === 'string' &&
    ['queued', 'planning', 'executing', 'waiting_approval', 'waiting_reconciliation', 'verifying', 'recovering', 'completed', 'failed', 'cancelled'].includes(record.status) &&
    isFiniteNumber(record.createdAt) &&
    isFiniteNumber(record.updatedAt) &&
    isOptionalFiniteNumber(record.startedAt) &&
    isOptionalFiniteNumber(record.finishedAt) &&
    isOptionalString(record.messageId) &&
    isOptionalString(record.requestText) &&
    isOptionalString(record.pendingPermissionRequestId) &&
    isOptionalString(record.createdEventId) &&
    isOptionalString(record.lastEventId) &&
    isOptionalNonNegativeInteger(record.lastEventSeq) &&
    isOptionalString(record.lastEventKind) &&
    isOptionalString(record.error)
  )
}

export function isToolExecutionRecord(value: unknown): value is ToolExecutionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.runId === 'string' &&
    typeof record.sessionId === 'string' &&
    typeof record.toolUseId === 'string' &&
    typeof record.toolName === 'string' &&
    typeof record.status === 'string' &&
    ['requested', 'running', 'waiting_approval', 'approved', 'succeeded', 'failed', 'cancelled', 'superseded', 'unknown_outcome'].includes(record.status) &&
    isFiniteNumber(record.createdAt) &&
    isFiniteNumber(record.updatedAt) &&
    isOptionalString(record.stepId) &&
    isOptionalString(record.requestId) &&
    (record.permissionDecision === undefined || record.permissionDecision === 'allow' || record.permissionDecision === 'deny') &&
    isOptionalString(record.inputDigest) &&
    isOptionalString(record.outputDigest) &&
    isOptionalString(record.idempotencyKey) &&
    isOptionalString(record.effectId) &&
    isOptionalString(record.effectKey) &&
    (record.effectStatus === undefined || isEffectStatus(record.effectStatus)) &&
    isOptionalString(record.duplicateOfExecutionId) &&
    isOptionalString(record.supersededByExecutionId) &&
    isOptionalString(record.requestedEventId) &&
    isOptionalString(record.approvalRequestedEventId) &&
    isOptionalString(record.approvalResolvedEventId) &&
    isOptionalString(record.toolStartEventId) &&
    isOptionalString(record.resultEventId) &&
    isOptionalString(record.lastEventId) &&
    isOptionalNonNegativeInteger(record.lastEventSeq) &&
    isOptionalFiniteNumber(record.startedAt) &&
    isOptionalFiniteNumber(record.finishedAt) &&
    isOptionalString(record.error)
  )
}

export function isEffectRecord(value: unknown): value is EffectRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.schemaVersion === 1 &&
    isString(record.id) &&
    isString(record.effectKey) &&
    isString(record.resourceKey) &&
    isString(record.sessionId) &&
    isString(record.runId) &&
    isOptionalString(record.stepId) &&
    isOptionalString(record.toolExecutionId) &&
    isString(record.toolUseId) &&
    isString(record.toolName) &&
    isPositiveInteger(record.generation) &&
    isPositiveInteger(record.revision) &&
    isEffectStatus(record.status) &&
    (record.reconcilability === 'queryable' || record.reconcilability === 'opaque') &&
    isEffectTarget(record.target) &&
    isString(record.targetDigest) &&
    isString(record.intentDigest) &&
    isString(record.inputDigest) &&
    (record.lease === undefined || isEffectLease(record.lease)) &&
    Array.isArray(record.evidence) &&
    record.evidence.every(isEffectEvidenceRecord) &&
    isOptionalString(record.compensationEffectId) &&
    isFiniteNumber(record.createdAt) &&
    isFiniteNumber(record.updatedAt) &&
    isOptionalFiniteNumber(record.terminalAt) &&
    isOptionalString(record.error)
  )
}

function updateActiveStep(
  steps: TaskStepRecord[],
  update: (step: TaskStepRecord) => TaskStepRecord
): TaskStepRecord[] {
  const index = steps.findIndex((step) => !TERMINAL_STEP_STATUSES.has(step.status))
  if (index < 0) return steps
  const next = [...steps]
  next[index] = update(next[index])
  return next
}

function finishOldestStep(
  steps: TaskStepRecord[],
  status: Extract<TaskStepStatus, 'completed' | 'failed' | 'cancelled'>,
  eventKind: AgentEvent['kind'],
  now: number,
  identity?: AgentEventIdentity,
  error?: string
): TaskStepRecord[] {
  return updateActiveStep(steps, (step) => ({
    ...transitionStep(step, status, eventKind, now, identity),
    error: status === 'failed' ? error ?? '任务步骤失败' : undefined
  }))
}

function transitionStep(
  step: TaskStepRecord,
  status: TaskStepStatus,
  eventKind: AgentEvent['kind'],
  now: number,
  identity?: AgentEventIdentity
): TaskStepRecord {
  return {
    ...step,
    status,
    updatedAt: now,
    startedAt: step.startedAt ?? (status === 'planning' || status === 'executing' ? now : undefined),
    finishedAt: TERMINAL_STEP_STATUSES.has(status) ? now : undefined,
    lastEventId: identity?.eventId ?? step.lastEventId,
    lastEventSeq: identity?.seq ?? step.lastEventSeq,
    lastEventKind: eventKind,
    pendingPermissionRequestId: status === 'waiting_approval' ? step.pendingPermissionRequestId : undefined
  }
}

function upsertToolExecution(
  executions: ToolExecutionRecord[],
  run: TaskRunRecord,
  cwd: string,
  input: {
    toolUseId: string
    toolName: string
    status: ToolExecutionStatus
    requestId?: string
    duplicateExecutionId?: string
    input?: unknown
    now: number
    identity?: AgentEventIdentity
    eventPhase?: 'requested' | 'tool-start' | 'approval-requested'
  }
): ToolExecutionRecord[] {
  const index = executions.findIndex((execution) => execution.toolUseId === input.toolUseId)
  const toolName = normalizeToolName(input.toolName)
  const inputDigest = input.input === undefined ? undefined : stableValueDigest(input.input)
  const idempotencyKey = input.input === undefined
    ? undefined
    : buildToolIdempotencyKey({ scopeId: run.sessionId, cwd, toolName, toolInput: input.input })
  const duplicate = idempotencyKey
    ? executions.find((execution) => execution.idempotencyKey === idempotencyKey && execution.toolUseId !== input.toolUseId)
    : undefined
  const duplicateExecutionId = input.duplicateExecutionId ?? duplicate?.id
  const activeStep = [...(run.steps ?? [])].reverse().find((step) => !TERMINAL_STEP_STATUSES.has(step.status))
  if (index < 0) {
    return [
      ...executions,
      {
        id: `${run.id}:tool:${input.toolUseId}`,
        runId: run.id,
        stepId: activeStep?.id,
        sessionId: run.sessionId,
        toolUseId: input.toolUseId,
        toolName,
        status: input.status,
        requestId: input.requestId,
        inputDigest,
        idempotencyKey,
        duplicateOfExecutionId: duplicateExecutionId,
        requestedEventId: input.eventPhase === 'requested' ? input.identity?.eventId : undefined,
        toolStartEventId: input.eventPhase === 'tool-start' ? input.identity?.eventId : undefined,
        approvalRequestedEventId:
          input.eventPhase === 'approval-requested' ? input.identity?.eventId : undefined,
        lastEventId: input.identity?.eventId,
        lastEventSeq: input.identity?.seq,
        createdAt: input.now,
        updatedAt: input.now,
        startedAt: input.status === 'running' || input.status === 'approved' ? input.now : undefined
      }
    ]
  }
  const current = executions[index]
  const status = mergeToolExecutionStatus(current.status, input.status)
  const next = [...executions]
  next[index] = {
    ...current,
    toolName,
    status,
    requestId: input.requestId ?? current.requestId,
    inputDigest: inputDigest ?? current.inputDigest,
    idempotencyKey: idempotencyKey ?? current.idempotencyKey,
    duplicateOfExecutionId: duplicateExecutionId ?? current.duplicateOfExecutionId,
    requestedEventId:
      input.eventPhase === 'requested' ? input.identity?.eventId ?? current.requestedEventId : current.requestedEventId,
    toolStartEventId:
      input.eventPhase === 'tool-start' ? input.identity?.eventId ?? current.toolStartEventId : current.toolStartEventId,
    approvalRequestedEventId:
      input.eventPhase === 'approval-requested'
        ? input.identity?.eventId ?? current.approvalRequestedEventId
        : current.approvalRequestedEventId,
    lastEventId: input.identity?.eventId ?? current.lastEventId,
    lastEventSeq: input.identity?.seq ?? current.lastEventSeq,
    updatedAt: input.now,
    startedAt: current.startedAt ?? (status === 'running' || status === 'approved' ? input.now : undefined)
  }
  return next
}

function mergeToolExecutionStatus(
  current: ToolExecutionStatus,
  incoming: ToolExecutionStatus
): ToolExecutionStatus {
  if (TERMINAL_TOOL_STATUSES.has(current)) return current
  if (incoming === 'requested' && current !== 'requested') return current
  return incoming
}

function toolStatusFromEffect(
  status: EffectStatus | undefined,
  isError: boolean
): ToolExecutionStatus {
  if (status === 'confirmed') return 'succeeded'
  if (status === 'waiting_reconciliation' || status === 'prepared' || status === 'executing') {
    return 'unknown_outcome'
  }
  if (status === 'abandoned') return 'cancelled'
  if (status === 'failed') return 'failed'
  if (status === 'compensated') return 'succeeded'
  return isError ? 'failed' : 'succeeded'
}

function isEffectStatus(value: unknown): value is EffectStatus {
  return (
    value === 'prepared' ||
    value === 'executing' ||
    value === 'waiting_reconciliation' ||
    value === 'confirmed' ||
    value === 'failed' ||
    value === 'compensated' ||
    value === 'abandoned'
  )
}

function isEffectLease(value: unknown): value is EffectLease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    isString(record.id) &&
    isString(record.ownerId) &&
    isPositiveInteger(record.fencingToken) &&
    isFiniteNumber(record.acquiredAt) &&
    isFiniteNumber(record.expiresAt) &&
    isOptionalFiniteNumber(record.releasedAt)
  )
}

function isEffectEvidenceRecord(value: unknown): value is EffectEvidenceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    isString(record.id) &&
    (record.kind === 'prepared' ||
      record.kind === 'executing' ||
      record.kind === 'execution_result' ||
      record.kind === 'reconciliation' ||
      record.kind === 'retry_authorized' ||
      record.kind === 'manual_confirmation' ||
      record.kind === 'compensation') &&
    isString(record.digest) &&
    isFiniteNumber(record.observedAt) &&
    isString(record.verifier) &&
    isPositiveInteger(record.generation)
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value)
}

function isOptionalNonNegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
