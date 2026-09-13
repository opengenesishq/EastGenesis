import type { SessionState } from '../../store'
import { officeActivityForSessionId, type OfficeSessionActivity } from './model'
import type { OfficeOperationalActor } from './operationalActors'
import { shouldProjectOfficeWorker } from './sessionProjection'

export interface OfficeTaskLabel {
  id: string
  kind: 'session' | 'operational'
  title: string
  activity: OfficeSessionActivity
  status: string
  selected: boolean
  detailsOnly?: boolean
  position?: [number, number, number]
}

export function officeTaskLabels(input: {
  sessionIds: string[]; sessions: Readonly<Record<string, SessionState>>; actors: OfficeOperationalActor[]
  selectedSessionId: string | null; selectedActorId: string | null
  positionedIds: string[]; positions: Array<[number, number, number]>
}): OfficeTaskLabel[] {
  const positions = new Map(input.positionedIds.map((id, index) => [id, input.positions[index]]))
  const sessions: OfficeTaskLabel[] = input.sessionIds.filter((id) => input.sessions[id]).map((id) => {
    const session = input.sessions[id]
    const activity = officeActivityForSessionId(id, input.sessions)
    return { id, kind: 'session', title: session.meta.title, activity, status: session.pendingPermissions.length ? 'waiting_approval' : activity, selected: id === input.selectedSessionId, position: positions.get(id), detailsOnly: !shouldProjectOfficeWorker(session) }
  })
  const actors: OfficeTaskLabel[] = input.actors.map((actor) => ({ id: actor.id, kind: 'operational', title: actor.title, activity: actor.activity, status: actor.status, selected: actor.id === input.selectedActorId, position: positions.get(actor.id) }))
  return [...sessions, ...actors]
}

const STATUS_LABELS: Record<string, [string, string]> = {
  idle: ['待命', 'Ready'], working: ['执行中', 'Working'], awaiting: ['等待处理', 'Awaiting action'], completed: ['已完成', 'Completed'], error: ['执行失败', 'Failed'],
  waiting_approval: ['等待审批', 'Awaiting approval'], blocked: ['任务受阻', 'Blocked'], waiting_reconciliation: ['等待对账', 'Awaiting reconciliation'],
  requested: ['准备提交', 'Preparing'], submitting: ['提交中', 'Submitting'], running: ['执行中', 'Working'], downloading: ['下载成果', 'Downloading'], verifying: ['核验中', 'Verifying'],
  succeeded: ['已完成', 'Completed'], done: ['已完成', 'Completed'], failed: ['执行失败', 'Failed'], cancelled: ['已取消', 'Cancelled'], ready: ['待执行', 'Ready'], backlog: ['待安排', 'Backlog']
}

export function taskLabelStatus(label: Pick<OfficeTaskLabel, 'status' | 'activity'>, zh: boolean): string {
  return (STATUS_LABELS[label.status] ?? STATUS_LABELS[label.activity])[zh ? 0 : 1]
}

export function taskLabelPriority(label: OfficeTaskLabel): number {
  if (label.selected) return 1000
  if (label.activity === 'error') return 800
  if (label.activity === 'awaiting') return 700
  return label.activity === 'working' ? 300 : label.activity === 'completed' ? 100 : 0
}

export function shortTaskTitle(value: string): string {
  const chars = Array.from(value.trim().replace(/\s+/g, ' '))
  return chars.length > 16 ? `${chars.slice(0, 15).join('')}…` : chars.join('')
}
