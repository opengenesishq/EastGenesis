import type { ProjectWorkspace, WorkflowLedgerRendererSelection } from '../../../../shared/types'
import {
  projectWorkInbox,
  type WorkInboxItem,
  type WorkInboxLane,
  type WorkInboxLaneProjection,
  type WorkInboxProjection
} from '../../../../shared/work-inbox-projection'

export const CROSS_PROJECT_WORK_INBOX_LANE_ORDER: readonly WorkInboxLane[] = [
  'needs_confirmation', 'running', 'blocked', 'ready_for_delivery', 'completed'
]

export interface CrossProjectWorkInboxItem extends WorkInboxItem {
  projectName: string
  projectAvailable: boolean
}

export interface CrossProjectWorkInboxLaneProjection extends Omit<WorkInboxLaneProjection, 'items'> {
  items: CrossProjectWorkInboxItem[]
}

export interface CrossProjectWorkInboxProjection extends Omit<WorkInboxProjection, 'items' | 'lanes'> {
  items: CrossProjectWorkInboxItem[]
  lanes: Record<WorkInboxLane, CrossProjectWorkInboxLaneProjection>
}

/** Pure adapter from the shared Ledger projection to root Work Inbox rows. */
export function adaptCrossProjectWorkInbox(
  ledger: WorkflowLedgerRendererSelection,
  projects: readonly ProjectWorkspace[]
): CrossProjectWorkInboxProjection {
  const projection = projectWorkInbox({
    goals: ledger.goals.items,
    workItems: ledger.workItems.items,
    runs: ledger.runs.items,
    artifacts: ledger.artifacts.items,
    acceptances: ledger.acceptances.items
  })
  const projectNames = new Map(projects.filter((project) => project.status === 'active').map((project) => [project.id, project.name]))
  const enrich = (item: WorkInboxItem): CrossProjectWorkInboxItem => ({
    ...item,
    projectName: item.projectId ? (projectNames.get(item.projectId) ?? item.projectId) : 'Unknown project',
    projectAvailable: Boolean(item.projectId && projectNames.has(item.projectId))
  })
  const items = projection.items.map(enrich)
  const lanes = Object.fromEntries(CROSS_PROJECT_WORK_INBOX_LANE_ORDER.map((lane) => {
    const laneProjection = projection.lanes[lane]
    return [lane, { ...laneProjection, items: laneProjection.items.map(enrich) }]
  })) as Record<WorkInboxLane, CrossProjectWorkInboxLaneProjection>
  return { ...projection, items, lanes }
}

/** Merge pages returned by the single shared Ledger endpoint. */
export function mergeWorkflowLedgerPages(
  pages: readonly WorkflowLedgerRendererSelection[]
): WorkflowLedgerRendererSelection | null {
  const first = pages[0]
  if (!first) return null
  const merge = <T extends { id: string }>(values: T[]): T[] => {
    const byId = new Map<string, T>()
    values.forEach((value) => byId.set(value.id, value))
    return [...byId.values()]
  }
  const goals = merge(pages.flatMap((page) => page.goals.items))
  const workItems = merge(pages.flatMap((page) => page.workItems.items))
  const runs = merge(pages.flatMap((page) => page.runs.items))
  const artifacts = merge(pages.flatMap((page) => page.artifacts.items))
  const acceptances = merge(pages.flatMap((page) => page.acceptances.items))
  const evidenceLinks = merge(pages.flatMap((page) => page.evidenceLinks.items))
  const events = pages.flatMap((page) => page.events.items)
    .filter((event, index, values) => values.findIndex((candidate) => candidate.seq === event.seq) === index)
  return {
    ...first,
    goals: { ...first.goals, items: goals },
    workItems: { ...first.workItems, items: workItems },
    runs: { ...first.runs, items: runs },
    artifacts: { ...first.artifacts, items: artifacts },
    acceptances: { ...first.acceptances, items: acceptances },
    evidenceLinks: { ...first.evidenceLinks, items: evidenceLinks },
    events: { ...first.events, items: events }
  }
}
