import type { GoalBudget } from './project-workspace-types'
import type { TaskRunStatus, UsageTotals } from './types'

export const SUPERVISOR_SCHEMA_VERSION = 1 as const
export type SupervisorRunOrigin = 'manual' | 'task_run'

/** Persistent state owned by the local Supervisor. */
export type SupervisorRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_reconciliation'
  | 'paused'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled'

export interface SupervisorLease {
  id: string
  ownerId: string
  acquiredAt: number
  heartbeatAt: number
  expiresAt: number
  fencingToken: number
}

export interface SupervisorApproval {
  id: string
  requestedAt: number
  requestedBy: string
  reason?: string
}

export interface SupervisorRunAccountingBase {
  usage: UsageTotals
  costUsd: number
}

/**
 * The canonical WorkItem execution lease captured when a Supervisor Run is
 * reserved.  A Supervisor row is durable and may outlive the in-memory
 * Session, so it must retain the WorkItem fencing identity it was admitted
 * under.  A later lease takeover then fails closed instead of silently
 * allowing the old Run to execute under a new owner.
 */
export interface SupervisorWorkItemLeaseBinding {
  id: string
  ownerId: string
  fencingToken: number
}

export interface SupervisorRunUsage extends UsageTotals {
  costUsd: number
  turns: number
}

export interface SupervisorRunObservationInput {
  taskRunStatus: TaskRunStatus
  sourceEventId: string
  /** Usage attributed to this event. Applied to Run totals only for a completed turn. */
  usage: UsageTotals
  /** Session-cumulative USD cost at this event. */
  costUsd: number
  turnCompleted?: boolean
  observedAt?: number
}

export interface SupervisorRunRecord {
  schemaVersion: typeof SUPERVISOR_SCHEMA_VERSION
  id: string
  projectId: string
  goalId?: string
  workItemId: string
  /** Distinguishes renderer-created coordination rows from TaskRun reservations. */
  origin?: SupervisorRunOrigin
  status: SupervisorRunStatus
  revision: number
  /** Highest fencing token ever issued for this Run; never decreases on release/expiry. */
  fencingToken: number
  retryCount: number
  maxRetries: number
  /** Immutable Goal budget snapshot inherited by the WorkItem when this Run was created. */
  budget?: GoalBudget
  /** Canonical WorkItem execution lease captured at Run reservation time. */
  workItemLease?: SupervisorWorkItemLeaseBinding
  /** Session accounting at Run creation; cumulative USD cost is measured from this base. */
  accountingBase?: SupervisorRunAccountingBase
  /** Durable usage attributable only to this Run. */
  usage?: SupervisorRunUsage
  createdAt: number
  updatedAt: number
  lease?: SupervisorLease
  approval?: SupervisorApproval
  error?: string
}

export type SupervisorEventKind =
  | 'run.created'
  | 'run.started'
  | 'run.paused'
  | 'run.resumed'
  | 'run.blocked'
  | 'run.waiting_approval'
  | 'run.approval_resolved'
  | 'run.waiting_reconciliation'
  | 'run.failed'
  | 'run.completed'
  | 'run.cancelled'
  | 'run.retry_authorized'
  | 'run.observed'
  | 'run.accounting'
  | 'lease.acquired'
  | 'lease.heartbeat'
  | 'lease.reassigned'
  | 'lease.expired'
  | 'lease.released'

export interface SupervisorEvent {
  schemaVersion: typeof SUPERVISOR_SCHEMA_VERSION
  id: string
  seq: number
  runId: string
  kind: SupervisorEventKind
  fromStatus?: SupervisorRunStatus
  toStatus?: SupervisorRunStatus
  actorId: string
  fencingToken?: number
  occurredAt: number
  payload: Record<string, unknown>
}

export interface SupervisorStateDocument {
  schemaVersion: typeof SUPERVISOR_SCHEMA_VERSION
  revision: number
  runs: SupervisorRunRecord[]
  events: SupervisorEvent[]
}

export interface SupervisorRunInput {
  id?: string
  projectId: string
  goalId?: string
  workItemId: string
  origin?: SupervisorRunOrigin
  maxRetries?: number
  budget?: GoalBudget
  /** Main-process derived; renderer create requests may not provide this. */
  workItemLease?: SupervisorWorkItemLeaseBinding
  accountingBase?: SupervisorRunAccountingBase
  createdAt?: number
}

/** Renderer-facing create shape. Policy/accounting are derived in main from the canonical WorkItem. */
export type SupervisorRunCreateInput = Omit<SupervisorRunInput, 'budget' | 'accountingBase' | 'origin' | 'workItemLease'>

export interface SupervisorMutationOptions {
  expectedRevision?: number
  expectedStoreRevision?: number
  actorId?: string
  now?: number
}

export interface SupervisorLeaseOptions extends SupervisorMutationOptions {
  ownerId: string
  leaseId?: string
  fencingToken?: number
  ttlMs?: number
}

export interface SupervisorApprovalInput extends SupervisorMutationOptions {
  approvalId: string
  approved: boolean
  reason?: string
}

export interface SupervisorRecoveryResult {
  expiredRunIds: string[]
  blockedRunIds: string[]
}

export interface SupervisorStateApi {
  listSupervisorRuns(options?: { projectId?: string; status?: SupervisorRunStatus }): Promise<SupervisorRunRecord[]>
  getSupervisorRun(id: string): Promise<SupervisorRunRecord | undefined>
  listSupervisorEvents(runId?: string): Promise<SupervisorEvent[]>
  createSupervisorRun(input: SupervisorRunCreateInput, options?: SupervisorMutationOptions): Promise<SupervisorRunRecord>
  /** Claims a short-lived local operator lease for a TaskRun-backed control action. */
  claimSupervisorControlLease(id: string, expectedRevision: number): Promise<SupervisorRunRecord>
  acquireSupervisorLease(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  heartbeatSupervisorLease(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  releaseSupervisorLease(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  startSupervisorRun(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  pauseSupervisorRun(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  resumeSupervisorRun(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  requestSupervisorApproval(
    id: string,
    approval: { id: string; reason?: string },
    options: SupervisorLeaseOptions
  ): Promise<SupervisorRunRecord>
  resolveSupervisorApproval(id: string, input: SupervisorApprovalInput): Promise<SupervisorRunRecord>
  blockSupervisorRun(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  reconcileSupervisorRun(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  failSupervisorRun(id: string, error: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  completeSupervisorRun(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  cancelSupervisorRun(id: string, options?: SupervisorMutationOptions): Promise<SupervisorRunRecord>
  retrySupervisorRun(id: string, options?: SupervisorMutationOptions): Promise<SupervisorRunRecord>
  reassignSupervisorLease(id: string, ownerId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  recoverSupervisorLeases(now?: number): Promise<SupervisorRecoveryResult>
}
