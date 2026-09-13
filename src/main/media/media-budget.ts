import type { MediaJobRecord, MediaProviderProfile, VideoProduction } from '../../shared/media-types'
import { ModelRouteError } from '../model/model-route-error'

export function remainingMediaBudget(production: VideoProduction, jobs: MediaJobRecord[]): number | undefined {
  const limit = production.budget.limitUsd
  if (limit === undefined || limit === 0) return undefined
  // A failed or cancelled generation may still have a provider charge. Keep its
  // reservation until a receipt explicitly settles it, including a zero refund.
  const billable = jobs.filter((job) => job.productionId === production.id && job.cost.billable)
  if (billable.some((job) => job.cost.status === 'unavailable')) {
    throw new ModelRouteError('ROUTING_BUDGET_UNAFFORDABLE', '已有媒体任务费用待核实，请先对账再使用有限预算。')
  }
  const committed = billable.reduce((sum, job) => sum + (job.cost.actualUsd ?? job.cost.estimatedUsd ?? 0), 0)
  return Math.max(0, limit - committed)
}

/** Called both before planning and inside the serialized job creation transaction. */
export function assertMediaSubmissionBudget(
  production: VideoProduction,
  jobs: MediaJobRecord[],
  profile: MediaProviderProfile | undefined
): void {
  if (!profile || profile.endpointClass === 'mock' || profile.endpointClass === 'local-ffmpeg') return
  const remaining = remainingMediaBudget(production, jobs)
  if (remaining === undefined) return
  if (remaining === 0) throw new ModelRouteError('ROUTING_BUDGET_EXHAUSTED', '媒体预算已耗尽。')
  if (profile.estimatedCostUsd === undefined) {
    throw new ModelRouteError('ROUTING_BUDGET_UNAFFORDABLE', '所选媒体模型未定价，无法保证有限预算。')
  }
  if (profile.estimatedCostUsd > remaining) {
    throw new ModelRouteError('ROUTING_BUDGET_UNAFFORDABLE', '媒体任务估算成本超过剩余预算。')
  }
}
