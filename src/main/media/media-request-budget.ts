import type { MediaExecutionBinding, MediaJobRecord, VideoProduction } from '../../shared/media-types'
import { getBusinessLines } from '../../shared/business-line-types'
import { getSettings } from '../settings'
import { listProviders } from '../providers'
import { nativeBudgetScope } from '../model/native-request-budget'
import { readRequestBudgetSnapshot, reserveRequestBudget, settleRequestBudget } from '../budget/request-budget-store'
import type { RequestBudgetScope } from '../budget/request-budget-types'
import type { MediaAgentExecutionContext } from './media-agent-context'
import { assertMediaAgentOwnership, mediaAgentOrigin } from './media-agent-context'

export function mediaRequestBudgetScope(production: VideoProduction, context?: MediaAgentExecutionContext): RequestBudgetScope {
  if (context) {
    assertMediaAgentOwnership(mediaAgentOrigin(context), production)
    const provider = listProviders().find((item) => item.id === context.meta.providerId)
    return nativeBudgetScope(context.meta, { providerBudgetUsd: provider?.budgetUsd })
  }
  const settings = getSettings()
  const line = getBusinessLines(settings).find((item) => item.id === (production.businessLineId ?? 'video'))
  return nativeBudgetScope({ id: `media-production:${production.id}`, providerId: '', createdAt: production.createdAt,
    costUsd: 0, budgetUsd: line?.taskBudgetUsd }, { settings })
}

export function remainingRequestBudget(rootDir: string, scope: RequestBudgetScope): number | undefined {
  const budget = readRequestBudgetSnapshot(rootDir, scope)
  const limits = [budget.sessionRemainingUsd, budget.monthlyRemainingUsd, ...(budget.aggregateRemainingUsd ?? [])].filter((value): value is number => value !== undefined)
  return limits.length ? Math.min(...limits) : undefined
}

/** Reservation precedes the inner effect and network; any uncertainty retains
 * funds. The job stores its reservation ID so polling after restart can settle. */
export async function withMediaRequestBudget(input: {
  rootDir: string; jobId: string; scope: RequestBudgetScope; binding: MediaExecutionBinding
  execute: () => Promise<MediaJobRecord>; readJob: () => Promise<MediaJobRecord | undefined>
}): Promise<MediaJobRecord> {
  const reservationId = `media:${input.jobId}`
  const admission = reserveRequestBudget({ rootDir: input.rootDir, id: reservationId, kind: 'media', scope: input.scope,
    providerId: input.binding.profile.providerId ?? 'mock-local', model: input.binding.profile.model,
    estimatedUsd: input.binding.profile.endpointClass === 'mock' ? 0 : input.binding.decision.estimatedCostUsd })
  // A concurrent call (or a crash before job creation) must not reuse another
  // execution's funds and later release its still-live reservation on failure.
  if (admission.reused) throw new Error('该媒体请求已有预算预留；请恢复或对账原任务，不能重复提交。')
  input.binding.budgetReservationId = reservationId
  try {
    const job = await input.execute()
    reconcileMediaRequestBudget(job, input.rootDir)
    return job
  } catch (error) {
    const job = await input.readJob()
    settleRequestBudget({ rootDir: input.rootDir, id: reservationId,
      status: job ? 'unknown' : 'released', ...(job ? {} : { actualUsd: 0 }) })
    throw error
  }
}

export function reconcileMediaRequestBudget(job: MediaJobRecord, rootDir: string): void {
  const id = job.budgetReservationId ?? job.executionBinding?.budgetReservationId
  if (!id) return // Legacy jobs predate the shared request budget ledger.
  const unknown = job.status === 'waiting_reconciliation' || job.cost.status === 'unavailable'
  const settled = !unknown && (job.cost.actualUsd !== undefined || ['succeeded', 'failed', 'cancelled'].includes(job.status))
  settleRequestBudget({ rootDir, id, status: unknown ? 'unknown' : settled ? 'settled' : 'reserved', actualUsd: job.cost.actualUsd })
}
