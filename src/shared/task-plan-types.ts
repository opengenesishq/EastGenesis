import type { AcceptanceSpec, WorkItemType } from './project-workspace-types'
import type { TaskDagRole } from './types'
import type { ProjectInstitutionTemplateRef } from './project-institution-template'

export const TASK_PLAN_SCHEMA_VERSION = 1 as const

export type TaskStrategy = 'view' | 'plan' | 'execute'
export type TaskPlanRiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type TaskPlanSource = 'manual' | 'genesis'
export type TaskPlanApprovalEventKind = 'approved' | 'revoked' | 'superseded'

/** Responsibility assigned to a plan step, not an Agent identity or a permission grant. */
export interface TaskPlanInstitutionResponsibility {
  id: string
  label: string
  duty: string
}

export interface TaskPlanStepInput {
  id: string
  title: string
  description?: string
  dependsOn?: string[]
  expectedArtifacts?: string[]
  dataEgress?: string[]
  estimatedCostUsd?: number | null
  riskLevel?: TaskPlanRiskLevel
  /** Stable work role and runtime role are separate from user-editable prose. */
  role?: string
  executionRole?: TaskDagRole
  workItemType?: WorkItemType
  acceptanceSpec?: AcceptanceSpec[]
  institution?: TaskPlanInstitutionResponsibility
}

export interface TaskPlanDraftInput {
  objective: string
  steps: TaskPlanStepInput[]
  expectedArtifacts?: string[]
  dataEgress?: string[]
  estimatedCostUsd?: number | null
  riskLevel?: TaskPlanRiskLevel
  acceptanceCriteria: string[]
  changeReason?: string
  source?: TaskPlanSource
  /** Host-derived canonical inputs. Included in the plan digest when present. */
  missionSource?: TaskPlanMissionSource
  /** Frozen with each step's responsibility and covered by the approval digest. */
  institutionTemplate?: ProjectInstitutionTemplateRef
}

export interface TaskPlanMissionSource {
  goalRevision: number
  inputDigest: string
  missionDigest: string
}

export interface TaskPlanMissionCompileInput {
  expectedGoalRevision: number
}

export interface TaskPlanSessionBinding {
  sessionId: string
  workspaceId?: string
  goalId?: string
  workItemId?: string
}

export interface TaskPlanStep {
  id: string
  title: string
  description: string
  dependsOn: string[]
  expectedArtifacts: string[]
  dataEgress: string[]
  estimatedCostUsd: number | null
  riskLevel: TaskPlanRiskLevel
  role?: string
  executionRole?: TaskDagRole
  workItemType?: WorkItemType
  acceptanceSpec?: AcceptanceSpec[]
  institution?: TaskPlanInstitutionResponsibility
}

export interface TaskPlanVersion {
  schemaVersion: typeof TASK_PLAN_SCHEMA_VERSION
  id: string
  binding: TaskPlanSessionBinding
  version: number
  digest: string
  objective: string
  steps: TaskPlanStep[]
  expectedArtifacts: string[]
  dataEgress: string[]
  estimatedCostUsd: number | null
  riskLevel: TaskPlanRiskLevel
  acceptanceCriteria: string[]
  changeReason: string
  source: TaskPlanSource
  missionSource?: TaskPlanMissionSource
  institutionTemplate?: ProjectInstitutionTemplateRef
  createdBy: 'local-user' | 'agent'
  createdAt: number
}

export interface TaskPlanProjectionStepReceipt {
  stepId: string
  workItemId: string
}

export interface TaskPlanProjectionReceipt {
  schemaVersion: typeof TASK_PLAN_SCHEMA_VERSION
  mode: 'conversation' | 'canonical'
  workspaceId?: string
  goalId?: string
  parentWorkItemId?: string
  steps: TaskPlanProjectionStepReceipt[]
  projectedAt: number
}

export interface TaskPlanApprovalEvent {
  schemaVersion: typeof TASK_PLAN_SCHEMA_VERSION
  id: string
  sessionId: string
  kind: TaskPlanApprovalEventKind
  version: number
  digest: string
  actor: 'local-user' | 'system'
  /** Stable host-assigned principal. Older records omit this field. */
  actorId?: string
  reason?: string
  projection?: TaskPlanProjectionReceipt
  occurredAt: number
}

export interface TaskPlanStateView {
  sessionId: string
  currentVersion?: TaskPlanVersion
  versions: TaskPlanVersion[]
  approvalEvents: TaskPlanApprovalEvent[]
  approvalStatus: 'not_created' | 'pending' | 'approved'
  approvedVersion?: number
  approvedDigest?: string
  projection?: TaskPlanProjectionReceipt
}

export interface TaskPlanApprovalInput {
  version: number
  digest: string
  reason?: string
}

export interface TaskPlanGenerateInput {
  objective: string
}

export interface TaskPlanDispatchResult {
  executionId: string
  status: 'waiting' | 'running' | 'success' | 'failed'
  taskCount: number
  reused: boolean
}

export interface TaskPlanExecutionAuthorization {
  required: boolean
  approved: boolean
  version?: number
  digest?: string
  reason?: string
}

export interface TaskPlanApi {
  setTaskStrategy(sessionId: string, strategy: TaskStrategy): Promise<void>
  getTaskPlan(sessionId: string): Promise<TaskPlanStateView>
  generateTaskPlan(sessionId: string, input: TaskPlanGenerateInput): Promise<TaskPlanStateView>
  compileMissionTaskPlan(sessionId: string, input: TaskPlanMissionCompileInput): Promise<TaskPlanStateView>
  createTaskPlanVersion(sessionId: string, draft: TaskPlanDraftInput): Promise<TaskPlanStateView>
  approveTaskPlan(sessionId: string, input: TaskPlanApprovalInput): Promise<TaskPlanStateView>
  dispatchApprovedTaskPlan(sessionId: string, input: TaskPlanApprovalInput): Promise<TaskPlanDispatchResult>
  revokeTaskPlanApproval(sessionId: string, input: TaskPlanApprovalInput): Promise<TaskPlanStateView>
}
