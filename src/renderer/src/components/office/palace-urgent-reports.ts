import type { SessionMeta, WorkflowRunSummary } from '../../../../shared/types'
import type { CrossProjectWorkInboxItem } from '../studio/workInboxNavigation'

export interface PalaceUrgentReport {
  id: string
  item?: CrossProjectWorkInboxItem
  permissions: { sessionId: string; title: string; count: number }[]
}

/** Aggregate presentation only. Each permission keeps the exact session that
 * requested it, including older executions; a current Run cannot inherit it. */
export function palaceUrgentReports(
  items: readonly CrossProjectWorkInboxItem[],
  sessions: readonly { meta: SessionMeta; pendingPermissions: readonly { requestId: string }[] }[],
  runs: readonly WorkflowRunSummary[]
): PalaceUrgentReport[] {
  const reports = items.map(item => ({ id: item.id, item, permissions: [] } as PalaceUrgentReport))
  for (const session of sessions) {
    const count = new Set(session.pendingPermissions.map(request => request.requestId)).size
    if (!count) continue
    const { meta } = session
    const matches = reports.filter(({ item }) => {
      if (!item || !item.projectId || item.projectId !== meta.workspaceId || item.goalId !== meta.goalId) return false
      if (item.workItemId) return item.workItemId === meta.workItemId
      // Legacy Run rows have no WorkItem projection. Match their recorded
      // session and ownership, never a title or the globally selected task.
      const run = runs.find(run => run.id === item.runId)
      return Boolean(run && run.sessionId === meta.id && run.projectId === meta.workspaceId &&
        run.goalId === meta.goalId && run.workItemId === meta.workItemId)
    })
    const permission = { sessionId: meta.id, title: meta.title, count }
    if (matches.length === 1) matches[0].permissions.push(permission)
    else reports.push({ id: `permission-session:${meta.id}`, permissions: [permission] })
  }
  const urgentLanes = ['needs_confirmation', 'blocked', 'ready_for_delivery']
  const priority = (report: PalaceUrgentReport): number => report.permissions.length ? 0 : urgentLanes.indexOf(report.item!.lane) + 1
  return reports.filter(report => report.permissions.length || (report.item && urgentLanes.includes(report.item.lane)))
    .sort((left, right) => priority(left) - priority(right) || (right.item?.updatedAt ?? 0) - (left.item?.updatedAt ?? 0) || left.id.localeCompare(right.id))
}
