import type { WorkInboxLane } from '../../../../shared/work-inbox-projection'

/**
 * The renderer only receives legacy WorkItem/RoutineRun records here. Keep
 * their conversion explicit and pure instead of fabricating Workflow records
 * that require main-owned TaskRun payloads.
 */
export type RendererInboxState =
  | 'running'
  | 'waiting_approval'
  | 'needs_review'
  | 'failed'
  | 'ready_for_delivery'
  | 'completed'

export interface RendererInboxEntry {
  id: string
  title: string
  detail?: string
  state: RendererInboxState
  updatedAt: number
  sessionId?: string
  workItemId?: string
  routineRunId?: string
  reviewable?: boolean
}

export type RendererInboxLanes = Record<WorkInboxLane, RendererInboxEntry[]>

export const WORK_INBOX_LANE_ORDER: readonly WorkInboxLane[] = [
  'needs_confirmation',
  'running',
  'blocked',
  'ready_for_delivery',
  'completed'
]

export function adaptRendererInboxLanes(entries: readonly RendererInboxEntry[]): RendererInboxLanes {
  const lanes = Object.fromEntries(WORK_INBOX_LANE_ORDER.map((lane) => [lane, [] as RendererInboxEntry[]])) as RendererInboxLanes
  for (const entry of entries) lanes[rendererInboxLane(entry)].push(entry)
  return lanes
}

function rendererInboxLane(entry: RendererInboxEntry): WorkInboxLane {
  if (entry.state === 'waiting_approval') return 'needs_confirmation'
  if (entry.state === 'needs_review') return 'ready_for_delivery'
  if (entry.state === 'failed') return 'blocked'
  if (entry.state === 'ready_for_delivery') return 'ready_for_delivery'
  if (entry.state === 'completed') return 'completed'
  return 'running'
}
