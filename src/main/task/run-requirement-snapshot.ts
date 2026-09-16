import type { TaskRunRecord } from '../../shared/types'
import type { WorkflowProjectionContext } from '../../shared/workflow-types'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { readVerifiedCanonicalProjectWorkspaceViewFromDatabase } from '../project-workspace/ledger-canonical-view'
import { digest } from './workflow-ledger-codec'
import { approvedRequirementArtifactAccess } from './requirement-artifact-access'

/** Captured only for a new live Run, before any tool/output exists. Historical
 * imports and old Runs must not acquire today's requirements retroactively. */
export function captureRunRequirements(db: WorkflowLedgerDatabase, run: TaskRunRecord, context: WorkflowProjectionContext) {
  if (!context.canonicalSourceAuthority || !context.projectId || !context.workItemId ||
      !['queued', 'planning', 'executing'].includes(run.status) || (run.toolExecutions?.length ?? 0) || (run.effects?.length ?? 0)) return undefined
  const view = readVerifiedCanonicalProjectWorkspaceViewFromDatabase(db, context.projectId)
  const item = view.workItems.find(item => item.id === context.workItemId)
  if (!item || item.goalId !== context.goalId) throw new Error('运行交付要求与工作项归属不一致')
  const goal = view.goals.find(goal => goal.id === item.goalId)
  const criteria = (item.acceptanceSpec.length ? item.acceptanceSpec : goal?.contract.acceptance ?? []).map(item => item.criterion)
  if (!criteria.length) return undefined
  const revisionAccess = goal ? approvedRequirementArtifactAccess(db, item, goal) : undefined
  return { schemaVersion: 1, projectId: item.projectId, goalId: item.goalId, workItemId: item.id,
    workItemRevision: item.revision, goalRevision: goal?.revision, criteria, criteriaDigest: digest(criteria),
    ...(revisionAccess ? { revisionAccess } : {}) }
}
