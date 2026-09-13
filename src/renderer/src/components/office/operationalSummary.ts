import type { MediaJobStatus, MediaStudioSnapshot } from '../../../../shared/media-types'
import type { ProjectWorkspace, WorkItem } from '../../../../shared/project-workspace-types'

export const EMPTY_MEDIA_SNAPSHOT: MediaStudioSnapshot = {
  schemaVersion: 12,
  revision: 0,
  productions: [],
  jobs: [],
  providers: [],
  projectStorage: [],
  snapshotDigest: ''
}

export interface MediaOperationalSummary {
  productions: number
  jobs: number
  running: number
  failed: number
  waitingReconciliation: number
  succeeded: number
  estimatedUsd: number
  actualUsd: number
  unknownEstimatedCostCount: number
  unknownActualCostCount: number
}

export interface ProjectOperationalSummary {
  projects: number
  workItems: number
  running: number
  approvals: number
  blocked: number
  failed: number
}

const RUNNING_MEDIA_STATUSES = new Set<MediaJobStatus>(['requested', 'submitting', 'running', 'downloading'])

export function summarizeMedia(snapshot: MediaStudioSnapshot): MediaOperationalSummary {
  return snapshot.jobs.reduce<MediaOperationalSummary>((summary, job) => {
    summary.jobs += 1
    if (RUNNING_MEDIA_STATUSES.has(job.status)) summary.running += 1
    if (job.status === 'failed') summary.failed += 1
    if (job.status === 'waiting_reconciliation') summary.waitingReconciliation += 1
    if (job.status === 'succeeded') summary.succeeded += 1
    summary.estimatedUsd += job.cost.estimatedUsd ?? 0
    if (job.cost.estimatedUsd === undefined) summary.unknownEstimatedCostCount += 1
    if (job.cost.actualUsd === undefined) summary.unknownActualCostCount += 1
    summary.actualUsd += job.cost.actualUsd ?? 0
    return summary
  }, {
    productions: snapshot.productions.length,
    jobs: 0,
    running: 0,
    failed: 0,
    waitingReconciliation: 0,
    succeeded: 0,
    estimatedUsd: 0,
    actualUsd: 0,
    unknownEstimatedCostCount: 0,
    unknownActualCostCount: 0
  })
}

export function summarizeProjects(projects: ProjectWorkspace[], workItems: WorkItem[]): ProjectOperationalSummary {
  return workItems.reduce<ProjectOperationalSummary>((summary, item) => {
    summary.workItems += 1
    if (item.status === 'running' || item.status === 'verifying') summary.running += 1
    if (item.status === 'waiting_approval') summary.approvals += 1
    if (item.status === 'blocked') summary.blocked += 1
    if (item.status === 'failed') summary.failed += 1
    return summary
  }, {
    projects: projects.filter((project) => project.status === 'active').length,
    workItems: 0,
    running: 0,
    approvals: 0,
    blocked: 0,
    failed: 0
  })
}
