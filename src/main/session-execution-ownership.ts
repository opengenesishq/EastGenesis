import type { SessionMeta } from '../shared/types'
import type { Goal, ProjectWorkspace, WorkItem } from '../shared/project-workspace-types'
import { newBusinessLineId } from './business-line-ownership'
import { assertSessionDomainOwnership } from './session-create-lifecycle'
import { createProjectWorkspaceReadService } from './project-workspace/canonical-read-service'
import { openProjectWorkspaceStore } from './project-workspace/store'

type ExecutionClaim = Pick<SessionMeta, 'workspaceId' | 'goalId' | 'workItemId' | 'businessLineId'>
type WorkspaceExecutionState = { workspace?: ProjectWorkspace; goals: Goal[]; workItems: WorkItem[] }

/** History activation remains readable; only starting execution requires live owners. */
export async function assertPersistedSessionExecutionAllowed(meta: ExecutionClaim, rootDir: string): Promise<void> {
  const ownership = assertSessionDomainOwnership(meta)
  if (!ownership.workspaceId) return
  const store = await openProjectWorkspaceStore(rootDir)
  const state = await store.getState()
  // Reject obvious stale identities from one source revision before a canonical
  // read can reconcile projections. Then verify the complete canonical view.
  assertExecutionOwner(meta, { ...state, workspace: state.workspaces.find((item) => item.id === ownership.workspaceId) })
  const canonical = await createProjectWorkspaceReadService(rootDir, 'canonical').getWorkspaceExecutionState(ownership.workspaceId)
  assertExecutionOwner(meta, canonical)
}

function assertExecutionOwner(meta: ExecutionClaim, state: WorkspaceExecutionState): void {
  const { workspace } = state
  if (!workspace) throw new Error(`canonical Workspace does not exist:${meta.workspaceId}`)
  if (workspace.status !== 'active') throw new Error(`canonical Workspace is not active:${workspace.id}:${workspace.status}`)
  const workItem = state.workItems.find((item) => item.id === meta.workItemId)
  if (!workItem) throw new Error(`canonical WorkItem does not exist:${meta.workItemId}`)
  if (workItem.projectId !== meta.workspaceId) throw new Error(`canonical WorkItem crosses Workspace boundary:${workItem.id}`)
  if (workItem.goalId !== meta.goalId) throw new Error(`canonical WorkItem crosses Goal boundary:${workItem.id}`)
  const goal = meta.goalId ? state.goals.find((item) => item.id === meta.goalId) : undefined
  if (meta.goalId && !goal) throw new Error(`canonical Goal does not exist:${meta.goalId}`)
  if (goal && goal.projectId !== meta.workspaceId) throw new Error(`canonical Goal crosses Workspace boundary:${goal.id}`)
  if (goal && ['completed', 'failed', 'cancelled', 'archived'].includes(goal.status)) {
    throw new Error(`目标已结束（${goal.status}），请从恢复入口处理或新建任务。canonical Goal:${goal.id}`)
  }
  if (['done', 'failed', 'cancelled'].includes(workItem.status)) {
    throw new Error(`任务已结束（${workItem.status}），请从恢复入口处理或新建任务。canonical WorkItem:${workItem.id}`)
  }
  if (workItem.status === 'running' &&
      (!workItem.lease || workItem.lease.expiresAt <= Date.now())) {
    throw new Error(`canonical WorkItem execution lease is missing or expired:${workItem.id}`)
  }
  if (newBusinessLineId(meta.businessLineId, workItem.businessLineId, 'studio') !== meta.businessLineId) {
    throw new Error('canonical WorkItem business line differs from the Session')
  }
}
