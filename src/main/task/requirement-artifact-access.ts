import type { Goal, WorkItem } from '../../shared/project-workspace-types'
import type { TaskPlanApprovalEvent, TaskPlanRevisionArtifact, TaskPlanVersion } from '../../shared/task-plan-types'
import type { ArtifactLifecycleRecord } from './artifact-lifecycle-types'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { readWorkflowEventChain } from './workflow-ledger-query'
import { digest } from './workflow-ledger-codec'
import { validateFrozenTaskPlanApproval, validateTaskPlanSessionRecord } from './task-plan-contract-store'

export interface RequirementArtifactAccess {
  approvalEventId: string
  planDigest: string
  parentWorkItemId: string
  artifacts: TaskPlanRevisionArtifact[]
  plan: TaskPlanVersion
  approval: TaskPlanApprovalEvent
}

/** Only the current, explicitly approved amendment grants its projected child
 * access to the exact file versions that appeared in that plan. */
export function approvedRequirementArtifactAccess(db: WorkflowLedgerDatabase, item: WorkItem, goal: Goal): RequirementArtifactAccess | undefined {
  if (!item.parentId) return undefined
  const events = readWorkflowEventChain(db).filter(event => event.projectId === item.projectId &&
    event.goalId === item.goalId && event.workItemId === item.parentId && event.kind.startsWith('workflow.task_plan.'))
  const sessions = [...new Set(events.map(event => event.sessionId).filter((id): id is string => !!id))]
  const matches: RequirementArtifactAccess[] = []
  for (const sessionId of sessions) {
    const history = events.filter(event => event.sessionId === sessionId)
    const versions = history.filter(event => event.kind === 'workflow.task_plan.version.created')
      .map(event => event.payload.version as unknown as TaskPlanVersion)
    const approvals = history.filter(event => event.kind.startsWith('workflow.task_plan.approval.'))
    const approvalEvents = approvals.map(event => event.payload.approval as unknown as TaskPlanApprovalEvent)
    validateTaskPlanSessionRecord(sessionId, { sessionId, versions, approvalEvents })
    const version = versions.at(-1), source = version?.requirementSource
    const event = approvals.at(-1), approval = approvalEvents.at(-1), projection = approval?.projection
    if (!source?.artifacts || !version || !event || approval?.kind !== 'approved' ||
        approval.version !== version.version || approval.digest !== version.digest ||
        source.contractDigest !== digest(goal.contract) || projection?.mode !== 'canonical' ||
        projection.parentWorkItemId !== item.parentId || projection.workspaceId !== item.projectId ||
        projection.goalId !== item.goalId || !projection.steps.some(step => step.workItemId === item.id)) continue
    matches.push({ approvalEventId: event.eventId, planDigest: version.digest,
      parentWorkItemId: item.parentId, artifacts: source.artifacts, plan: version, approval })
  }
  if (matches.length > 1) throw new Error('修订工作项关联了多个批准计划')
  return matches[0]
}

/** Historical Run authority is frozen before tools execute. It remains valid
 * for registering/reconciling that Run, even after a later plan amendment. */
export function runRequirementArtifactAccess(db: WorkflowLedgerDatabase, scope: {
  runId: string; projectId: string; goalId?: string; workItemId: string
}): RequirementArtifactAccess | undefined {
  const events = readWorkflowEventChain(db)
  const captured = events.find(event => event.eventId === `workflow:run:${scope.runId}:requirements`)
  if (!captured?.payload.revisionAccess) return undefined
  if (captured.kind !== 'workflow.run.requirements.captured' || captured.runId !== scope.runId ||
      captured.projectId !== scope.projectId || captured.goalId !== scope.goalId || captured.workItemId !== scope.workItemId ||
      captured.payload.projectId !== scope.projectId || captured.payload.goalId !== scope.goalId || captured.payload.workItemId !== scope.workItemId) {
    throw new Error('修订原稿的运行快照归属无效')
  }
  const access = captured.payload.revisionAccess as unknown as RequirementArtifactAccess
  const approvalEvent = events.find(event => event.eventId === access.approvalEventId)
  const { plan: version, approval } = access
  validateFrozenTaskPlanApproval(version, approval)
  if (approvalEvent && (approvalEvent.kind !== 'workflow.task_plan.approval.approved' ||
      approvalEvent.seq >= captured.seq || digest(approvalEvent.payload.approval) !== digest(approval))) {
    throw new Error('原始修订计划批准与运行快照不同')
  }
  // Session cleanup may remove its private plan history. The Run's sealed copy
  // continues to own registration/reconciliation, never permission for a new Run.
  if (approval.digest !== access.planDigest || version.digest !== access.planDigest || approval.kind !== 'approved' ||
      approval.projection?.mode !== 'canonical' || approval.projection.parentWorkItemId !== access.parentWorkItemId ||
      version.binding.workspaceId !== scope.projectId || version.binding.goalId !== scope.goalId ||
      version.binding.workItemId !== access.parentWorkItemId ||
      !approval.projection.steps.some(step => step.workItemId === scope.workItemId) ||
      digest(version.requirementSource?.artifacts) !== digest(access.artifacts)) throw new Error('修订原稿快照缺少匹配的批准计划')
  return access
}

export function accessIncludesArtifact(access: RequirementArtifactAccess | undefined, artifact: ArtifactLifecycleRecord): boolean {
  return !!access?.artifacts.some(file => file.artifactId === artifact.artifactId && file.digest === artifact.digest &&
    file.workItemId === artifact.workItemId && file.lineageId === artifact.lineageId && file.version === artifact.version)
}

export function hasApprovedArtifactSupersession(db: WorkflowLedgerDatabase, previous: ArtifactLifecycleRecord, next: ArtifactLifecycleRecord): boolean {
  if (previous.projectId !== next.projectId || previous.goalId !== next.goalId || !next.goalId) return false
  return accessIncludesArtifact(runRequirementArtifactAccess(db, next), previous)
}
