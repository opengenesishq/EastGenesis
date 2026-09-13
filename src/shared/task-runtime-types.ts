import type { AgentEvent } from './types'
import type { DigitalWorkerBinding } from './digital-worker-types'
import type { EffectRecord, EffectStatus, TaskRunOperationMetadata } from './effect-types'
import type { FrozenRunRoutingPolicyV1 } from './frozen-routing-types'

export type TaskRunStatus =
  | 'queued'
  | 'planning'
  | 'executing'
  | 'waiting_approval'
  | 'waiting_reconciliation'
  | 'verifying'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type TaskStepStatus = TaskRunStatus

export type TaskRunContinuation =
  | {
      schemaVersion: 1
      kind: 'conversation_fork'
      sourceSessionId: string
      sourceRunId: string
      sourceSdkSessionId: string
      sourceCheckpointId?: string
    }
  | {
      schemaVersion: 1
      kind: 'work_item_transfer'
      requestId: string
      assignmentId: string
      sourceSessionId?: string
      sourceRunId?: string
    }

export interface TaskStepRecord {
  id: string
  runId: string
  sessionId: string
  sequence: number
  status: TaskStepStatus
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  messageId?: string
  requestText?: string
  pendingPermissionRequestId?: string
  createdEventId?: string
  lastEventId?: string
  lastEventSeq?: number
  lastEventKind?: AgentEvent['kind']
  error?: string
}

export type ToolExecutionStatus =
  | 'requested'
  | 'running'
  | 'waiting_approval'
  | 'approved'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'superseded'
  | 'unknown_outcome'

export interface ToolExecutionRecord {
  id: string
  runId: string
  stepId?: string
  sessionId: string
  toolUseId: string
  toolName: string
  status: ToolExecutionStatus
  requestId?: string
  permissionDecision?: 'allow' | 'deny'
  inputDigest?: string
  outputDigest?: string
  idempotencyKey?: string
  effectId?: string
  effectKey?: string
  effectStatus?: EffectStatus
  duplicateOfExecutionId?: string
  supersededByExecutionId?: string
  requestedEventId?: string
  approvalRequestedEventId?: string
  approvalResolvedEventId?: string
  /** tool-start 表示模型已提出调用,不等于副作用已开始。 */
  toolStartEventId?: string
  resultEventId?: string
  lastEventId?: string
  lastEventSeq?: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  error?: string
}

export interface TaskRunRecord {
  schemaVersion: 1
  id: string
  sessionId: string
  taskId: string
  digitalWorkerBinding?: DigitalWorkerBinding
  /** Immutable policy bound by main before this Run may dispatch a model request. */
  routingPolicy?: FrozenRunRoutingPolicyV1
  status: TaskRunStatus
  revision: number
  attempt: number
  recoveryCount: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  messageId?: string
  pendingPermissionRequestId?: string
  lastAppliedEventId?: string
  lastAppliedEventSeq?: number
  recentEventIds?: string[]
  lastEventKind?: AgentEvent['kind']
  error?: string
  /** 新会话的逻辑前驱；Run/Session 身份保持独立，业务 WorkItem 继续承接。 */
  continuation?: TaskRunContinuation
  operation?: TaskRunOperationMetadata
  steps?: TaskStepRecord[]
  toolExecutions?: ToolExecutionRecord[]
  effects?: EffectRecord[]
}
