import type { SessionMeta } from '../../../../shared/types'
import { resolveBusinessLineId } from '../../../../shared/business-line-types'
import { officeViewForBusinessLine, type OfficeOperationalActor, type OfficeOperationsInput } from './operationalActors'
import type { OfficeBusinessView } from './officeReturnContext'
import { summarizeMedia, summarizeProjects } from './operationalSummary'
import type { OfficeSessionActivity } from './model'

export interface OfficeExecutionActivitySummary extends Record<OfficeSessionActivity, number> {
  total: number
}

/**
 * Collapse Session, WorkItem and media actors into one status projection.
 * Session counts remain available for compatibility, while this summary is
 * the control-room truth for every durable execution identity.
 */
export function summarizeOfficeExecutionActivity(
  sessions: Record<OfficeSessionActivity, number> & { total: number },
  actors: OfficeOperationalActor[]
): OfficeExecutionActivitySummary {
  const summary: OfficeExecutionActivitySummary = {
    total: sessions.total + actors.length,
    idle: sessions.idle,
    working: sessions.working,
    awaiting: sessions.awaiting,
    completed: sessions.completed,
    error: sessions.error
  }
  for (const actor of actors) {
    summary[actor.activity] += 1
  }
  return summary
}

/** Restrict visible counters to the same business identities as the scene. */
export function summarizeOfficeBusiness(input: OfficeOperationsInput, view: OfficeBusinessView) {
  const fromSessions = new Map(Object.values(input.sessions).filter((session) => session.meta.workItemId)
    .map((session) => [session.meta.workItemId!, resolveBusinessLineId(session.meta)]))
  const belongs = (id: string): boolean => view === 'all' || officeViewForBusinessLine(id) === view
  const productions = input.media.productions.filter((production) => belongs(production.businessLineId || 'video'))
  const jobs = input.media.jobs.filter((job) => belongs(job.businessLineId
    || input.media.productions.find((production) => production.id === job.productionId)?.businessLineId
    || fromSessions.get(job.workItemId || '') || 'video'))
  const workItems = input.workItems.filter((item) => belongs(item.businessLineId || fromSessions.get(item.id) || 'studio'))
  const projectIds = new Set([...workItems.map((item) => item.projectId), ...productions.map((item) => item.projectId)])
  const projects = view === 'all' ? input.projects : input.projects.filter((project) => projectIds.has(project.id))
  return { media: summarizeMedia({ ...input.media, productions, jobs }), projects: summarizeProjects(projects, workItems) }
}

export interface OfficeCostSummary { knownUsd: number; unknownCount: number; sources: number }

/** Count text and media expenditure once; a work item without usage is unknown. */
export function summarizeOfficeCosts(sessions: Pick<SessionMeta, 'costUsd' | 'workItemId'>[], actors: OfficeOperationalActor[]): OfficeCostSummary {
  const represented = new Set(sessions.map((session) => session.workItemId).filter(Boolean))
  const amounts = [...sessions.map((session) => session.costUsd), ...actors
    .filter((actor) => actor.kind !== 'work-item' || !represented.has(actor.sourceId))
    .map((actor) => actor.actualUsd)]
  return amounts.reduce<OfficeCostSummary>((summary, amount) => {
    summary.sources++
    if (amount === undefined || !Number.isFinite(amount) || amount < 0) summary.unknownCount++
    else summary.knownUsd += amount
    return summary
  }, { knownUsd: 0, unknownCount: 0, sources: 0 })
}
