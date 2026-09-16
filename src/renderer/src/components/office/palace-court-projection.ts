import type { ProjectWorkspace, SessionMeta, WorkflowLedgerRendererSelection, WorkflowRunSummary } from '../../../../shared/types'
import { adaptCrossProjectWorkInbox, type CrossProjectWorkInboxItem } from '../studio/workInboxNavigation'
import { summarizeOfficeCosts } from './businessOperationalSummary'
import { palaceUrgentReports, type PalaceUrgentReport } from './palace-urgent-reports'

export interface PalaceCourtRow {
  item: CrossProjectWorkInboxItem
  permissions: PalaceUrgentReport['permissions']
  run?: WorkflowRunSummary
  overdue: boolean
  missingRun: boolean
}
export interface PalaceCourtGroup {
  id: string
  title?: string
  projectName: string
  rows: PalaceCourtRow[]
}

/** A court reports each current WorkItem once. An old Run's late update must
 * not replace its successor's status, resource count, or navigation identity. */
export function palaceCourtProjection(ledger: WorkflowLedgerRendererSelection, projects: readonly ProjectWorkspace[],
  sessions: readonly { meta: SessionMeta; pendingPermissions: readonly { requestId: string }[] }[], now: number) {
  const currentRuns: WorkflowRunSummary[] = []
  const missingRunWork = new Set<string>()
  const workById = new Map(ledger.workItems.items.map(item => [item.id, item]))
  for (const work of ledger.workItems.items) {
    const runId = work.currentRunId ?? work.runIds.at(-1)
    if (!runId) continue
    const candidates = ledger.runs.items.filter(run => run.id === runId && work.runIds.includes(runId) &&
      run.projectId === work.projectId && run.goalId === work.goalId && run.workItemId === work.id)
    if (candidates.length === 1) currentRuns.push(candidates[0])
    else missingRunWork.add(work.id)
  }
  // Unbound legacy execution remains visible as its real Run, without a
  // synthetic task. Runs belonging to known tasks are represented above.
  currentRuns.push(...ledger.runs.items.filter(run => !workById.has(run.workItemId)))
  const inbox = adaptCrossProjectWorkInbox({ ...ledger, runs: { ...ledger.runs, items: currentRuns } }, projects)
  const urgent = palaceUrgentReports(inbox.items, sessions, currentRuns)
  const permissionByItem = new Map(urgent.filter(report => report.item).map(report => [report.item!.id, report.permissions]))
  const rows: PalaceCourtRow[] = inbox.items.map(item => {
    const goal = ledger.goals.items.find(goal => goal.id === item.goalId && goal.projectId === item.projectId)
    const work = item.workItemId ? workById.get(item.workItemId) : undefined
    const dueDates = [work?.dueAt, goal?.dueAt].filter((dueAt): dueAt is number => dueAt !== undefined)
    return { item, permissions: permissionByItem.get(item.id) ?? [], run: currentRuns.find(run => run.id === item.runId),
      overdue: item.lane !== 'completed' && item.status !== 'cancelled' && dueDates.some(dueAt => dueAt < now),
      missingRun: Boolean(item.workItemId && missingRunWork.has(item.workItemId)) }
  })
  const groups = new Map<string, PalaceCourtGroup>()
  for (const row of rows) {
    const { item } = row
    const key = JSON.stringify([item.projectId, item.goalId])
    const goal = ledger.goals.items.find(goal => goal.id === item.goalId && goal.projectId === item.projectId)
    const group = groups.get(key) ?? { id: key, title: goal?.title, projectName: item.projectName, rows: [] }
    group.rows.push(row); groups.set(key, group)
  }
  const boundSessions = new Map<string, SessionMeta>()
  const unknownSessions = new Set<string>()
  for (const run of currentRuns) {
    const matches = sessions.filter(({ meta }) => meta.id === run.sessionId && meta.workspaceId === run.projectId &&
      meta.goalId === run.goalId && meta.workItemId === run.workItemId)
    if (matches.length === 1) boundSessions.set(run.sessionId, matches[0].meta)
    else unknownSessions.add(run.sessionId || run.id)
  }
  const costs = summarizeOfficeCosts([...boundSessions.values()], [])
  return { rows, groups: [...groups.values()], unboundPermissions: urgent.filter(report => !report.item),
    resources: { activeRuns: currentRuns.filter(run => ['planning', 'executing', 'verifying'].includes(run.status)).length,
      queuedRuns: currentRuns.filter(run => run.status === 'queued').length,
      waitingApproval: currentRuns.filter(run => run.status === 'waiting_approval').length,
      reconciliation: currentRuns.filter(run => run.status === 'waiting_reconciliation').length,
      knownSessionCostUsd: costs.knownUsd, costSessions: costs.sources, unknownCostSessions: costs.unknownCount + unknownSessions.size }
  }
}

export function palaceCourtNeedsDecision(row: PalaceCourtRow): boolean {
  return row.permissions.length > 0 || row.item.lane === 'needs_confirmation' || row.item.lane === 'ready_for_delivery'
}
export function palaceCourtHasRisk(row: PalaceCourtRow): boolean {
  return row.item.lane === 'blocked' || row.overdue || row.missingRun
}
