import type { MediaJobRecord, MediaStudioSnapshot } from '../../../../shared/media-types'
import type { ProjectWorkspace, WorkItem } from '../../../../shared/project-workspace-types'
import { resolveBusinessLineId } from '../../../../shared/business-line-types'
import type { SessionState } from '../../store'
import type { OfficeSessionActivity } from './model'
import type { OfficeBusinessView } from './officeReturnContext'
import { shouldProjectOfficeWorker } from './sessionProjection'

/** A projection of a durable job/work item, never a synthetic chat session. */
export interface OfficeOperationalActor {
  id: string
  kind: 'media' | 'work-item'
  sourceId: string
  businessLineId: string
  projectId: string
  workItemId?: string
  productionId?: string
  runId?: string
  title: string
  status: string
  activity: OfficeSessionActivity
  providerId?: string
  providerName?: string
  model?: string
  actualUsd?: number
  estimatedUsd?: number
  artifactIds: string[]
  reason?: string
  simulated: boolean
  actionable: boolean
  updatedAt: number
}

export interface OfficeOperationsInput {
  media: MediaStudioSnapshot
  workItems: WorkItem[]
  projects: ProjectWorkspace[]
  sessions: Readonly<Record<string, SessionState>>
}

const MEDIA_ACTIVITY: Record<MediaJobRecord['status'], OfficeSessionActivity> = {
  requested: 'working', submitting: 'working', running: 'working', downloading: 'working',
  waiting_reconciliation: 'awaiting', succeeded: 'completed', failed: 'error', cancelled: 'idle'
}

export function officeViewForBusinessLine(id: string): Exclude<OfficeBusinessView, 'all'> {
  if (id === 'studio') return 'project'
  if (id === 'video') return 'video'
  if (id.startsWith('business-line:')) return id as `business-line:${string}`
  return 'assistant'
}

export function operationalActorMatchesView(actor: OfficeOperationalActor, view: OfficeBusinessView): boolean {
  return view === 'all' || officeViewForBusinessLine(actor.businessLineId) === view
}

export function buildOperationalActors(input: OfficeOperationsInput): OfficeOperationalActor[] {
  const sessions = Object.values(input.sessions)
  const lineByWorkItem = new Map(sessions.filter((s) => s.meta.workItemId)
    .map((s) => [s.meta.workItemId!, resolveBusinessLineId(s.meta)]))
  // A loaded Session remains the canonical owner for its WorkItem even after
  // it reaches an idle/completed state. This prevents the same execution from
  // being counted twice when the historical WorkItem snapshot is also loaded.
  const representedWorkItems = new Set(sessions.filter((s) => s.meta.workItemId)
    .map((s) => s.meta.workItemId))
  for (const job of input.media.jobs) {
    if (job.workItemId) representedWorkItems.add(job.workItemId)
  }
  const actors = input.media.jobs.map((job) => mediaActor(job, input.media, lineByWorkItem))
  for (const item of input.workItems) {
    if (!representedWorkItems.has(item.id)) actors.push(workItemActor(item, lineByWorkItem))
  }
  return actors.sort((a, b) => actorPriority(a) - actorPriority(b) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
}

function mediaActor(job: MediaJobRecord, snapshot: MediaStudioSnapshot, lines: Map<string, string>): OfficeOperationalActor {
  const production = snapshot.productions.find((p) => p.id === job.productionId)
  const shot = production?.shots.find((s) => s.id === job.shotId)
  const profile = snapshot.providers.find((p) => p.id === job.mediaProviderId || p.id === job.providerId)
  return {
    id: `media:${job.id}`, kind: 'media', sourceId: job.id,
    businessLineId: job.businessLineId || production?.businessLineId || (job.workItemId && lines.get(job.workItemId)) || 'video',
    projectId: job.projectId, workItemId: job.workItemId, productionId: job.productionId, runId: job.runId,
    title: [production?.title, shot?.title || job.operation].filter(Boolean).join(' · '),
    status: job.status, activity: MEDIA_ACTIVITY[job.status],
    providerId: profile?.providerId || (job.providerMode === 'remote' ? job.providerId : undefined),
    providerName: profile?.displayName, model: job.model || profile?.model,
    actualUsd: job.cost.actualUsd, estimatedUsd: job.cost.estimatedUsd,
    artifactIds: job.output?.artifactId ? [job.output.artifactId] : [], reason: job.error,
    simulated: job.providerMode === 'mock',
    actionable: job.status !== 'succeeded' && job.status !== 'cancelled', updatedAt: job.updatedAt
  }
}

function workItemActor(item: WorkItem, lines: Map<string, string>): OfficeOperationalActor {
  const activity: OfficeSessionActivity = item.status === 'running' || item.status === 'verifying' ? 'working'
    : item.status === 'failed' ? 'error'
      : item.status === 'waiting_approval' || item.status === 'blocked' ? 'awaiting'
        : item.status === 'done' ? 'completed' : 'idle'
  return {
    id: `work-item:${item.id}`, kind: 'work-item', sourceId: item.id,
    businessLineId: item.businessLineId || lines.get(item.id) || 'studio', projectId: item.projectId, workItemId: item.id,
    runId: item.runRefs.at(-1), title: item.title, status: item.status, activity,
    artifactIds: item.artifactRefs, simulated: false,
    actionable: activity === 'working' || activity === 'awaiting' || activity === 'error',
    updatedAt: item.updatedAt
  }
}

function actorPriority(actor: OfficeOperationalActor): number {
  return actor.activity === 'awaiting' ? 0 : actor.activity === 'error' ? 1 : actor.activity === 'working' ? 2 : 3
}

export function visibleOperationalActors(actors: OfficeOperationalActor[], selectedId: string | null, limit: number): OfficeOperationalActor[] {
  const candidates = actors.filter((actor) => actor.actionable || actor.id === selectedId)
  const selected = candidates.find((actor) => actor.id === selectedId)
  return (selected ? [selected, ...candidates.filter((actor) => actor !== selected)] : candidates)
    .slice(0, Math.max(0, Math.floor(limit)))
}
