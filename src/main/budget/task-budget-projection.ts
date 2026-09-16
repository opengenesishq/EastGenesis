import type { TaskBudgetView } from '../../shared/task-budget-types'
import { canonicalRequestBudgets, type BudgetOwner } from './canonical-request-budget'
import { requestBudgetSnapshot } from './request-budget-accounting'
import { readBudgetDocument } from './request-budget-store'

/** Pure read boundary: neither new reservations nor Provider/balance calls. */
export function readTaskBudget(meta: BudgetOwner, observations: BudgetOwner[], rootDir: string, now = Date.now()): TaskBudgetView {
  const base = { schemaVersion: 1 as const, sessionId: meta.id, observedAt: now, source: 'request_budget_ledger' as const }
  if (!meta.goalId) return { ...base, state: 'unbound', remainingState: 'unknown' }
  try {
    const canonical = canonicalRequestBudgets(meta, observations, rootDir, true)
    const goal = canonical.goal
    if (!goal || canonical.budgets.length !== 1) throw new Error('Missing Goal budget scope')
    const snapshot = requestBudgetSnapshot(readBudgetDocument(rootDir), {
      sessionId: meta.id, sdkSessionId: meta.sdkSessionId, sessionTextCostUsd: meta.costUsd,
      monthlyTextSpentUsd: 0, aggregateBudgetIds: canonical.ids, aggregateBudgets: canonical.budgets,
      observedSessions: [...observations, meta].map(entry => ({ id: entry.id, sdkSessionId: entry.sdkSessionId, costUsd: entry.costUsd }))
    }, now)
    const usage = snapshot.aggregateUsage![0]
    const unknown = usage.uncertainCount > 0 || goal.missingUsageRunCount > 0
    return {
      ...base, state: 'ready', goal: { id: goal.id, projectId: goal.projectId, title: goal.title },
      limitUsd: goal.effectiveLimitUsd, goalLimitUsd: goal.goalLimitUsd, frozenRunLimitUsd: goal.runLimitUsd,
      recordedSpentUsd: usage.recordedSpentUsd, reservedUsd: usage.reservedUsd, reservedCount: usage.reservedCount,
      unpricedReservedCount: usage.unpricedReservedCount,
      uncertainHeldUsd: usage.uncertainHeldUsd, uncertainCount: usage.uncertainCount, missingUsageRunCount: goal.missingUsageRunCount,
      remainingUsd: unknown ? undefined : usage.remainingUsd,
      remainingState: unknown ? 'unknown' : goal.effectiveLimitUsd === undefined ? 'unlimited' :
        (usage.remainingUsd ?? 0) <= 0 ? 'exhausted' : 'available'
    }
  } catch {
    // Never turn corrupt/unsupported ownership, currency or accounting into a
    // zero balance or a fabricated allowance. No raw private paths cross IPC.
    return { ...base, state: 'unavailable', remainingState: 'unknown', errorCode: 'BUDGET_UNAVAILABLE' }
  }
}
