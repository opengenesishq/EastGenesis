import type { SessionMeta, WorkflowLedgerRendererSelection, WorkflowLedgerScope } from '../../../../shared/types'
import type { WorkInboxItem } from '../../../../shared/work-inbox-projection'

export type InboxTaskDestination = {
  sessionId?: string
  runId?: string
  binding?: Pick<SessionMeta, 'workspaceId' | 'goalId' | 'workItemId'>
  reason?: 'missing_task' | 'missing_run' | 'missing_session' | 'identity_conflict'
}

/** Resolve the current task at click time. An older Run's recent update is not
 * a reason to open its session, and navigation must never dispatch a new task. */
export async function resolveInboxTaskDestination(item: WorkInboxItem, host: {
  readLedger(scope: WorkflowLedgerScope): Promise<WorkflowLedgerRendererSelection>
  listSessions(): Promise<SessionMeta[]>
}): Promise<InboxTaskDestination> {
  let runId = item.runId
  const projectId = item.projectId
  const goalId = item.goalId
  let workItemId = item.workItemId
  if (workItemId) {
    const ledger = await host.readLedger({ workItemId, limit: 1 })
    const matches = ledger.workItems.items.filter(candidate => candidate.id === workItemId)
    if (matches.length !== 1) return { reason: 'missing_task' }
    const work = matches[0]
    if (work.projectId !== projectId || work.goalId !== goalId) return { reason: 'identity_conflict' }
    runId = work.currentRunId ?? work.runIds.at(-1)
    if (runId && !work.runIds.includes(runId)) return { reason: 'identity_conflict' }
  }
  let sessionId: string | undefined
  if (runId) {
    const ledger = await host.readLedger({ runId, limit: 1 })
    const matches = ledger.runs.items.filter(candidate => candidate.id === runId)
    if (matches.length !== 1) return { runId, reason: 'missing_run' }
    const run = matches[0]
    if (run.projectId !== projectId || run.goalId !== goalId || (workItemId && run.workItemId !== workItemId)) {
      return { runId, reason: 'identity_conflict' }
    }
    workItemId = run.workItemId
    sessionId = run.sessionId
    // A bound Run with a missing session cannot fall back to another session.
    if (!sessionId) return { runId, reason: 'missing_session' }
  } else if (!workItemId) {
    return { reason: 'missing_task' }
  }
  const sessions = await host.listSessions()
  const matches = sessions.filter(meta => meta.status !== 'closed' &&
    meta.workspaceId === projectId && meta.goalId === goalId && meta.workItemId === workItemId &&
    (!sessionId || meta.id === sessionId))
  if (matches.length !== 1) return { runId, reason: matches.length > 1 ? 'identity_conflict' : 'missing_session' }
  return { runId, sessionId: matches[0].id, binding: { workspaceId: projectId, goalId, workItemId } }
}
