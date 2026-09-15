import { monthKeyFor } from '../../shared/budget'
import { ModelRouteError } from '../model/model-route-error'
import type { BudgetSession, RequestBudgetDocument, RequestBudgetReservation, RequestBudgetScope, RequestBudgetSnapshot } from './request-budget-types'

export function requestBudgetSnapshot(document: RequestBudgetDocument, scope: RequestBudgetScope, now = Date.now()): RequestBudgetSnapshot {
  let monthlySpentUsd = scope.monthlyTextSpentUsd
  let sessionSpentUsd = scope.sessionTextCostUsd
  let monthlyUnknown = false
  let sessionUnknown = false
  let actualTextCostUsd: number | undefined
  const aggregates = (scope.aggregateBudgets ?? []).map((budget) => ({ ...budget, spent: budget.textSpentUsd, unknown: false }))
  const month = monthKeyFor(now)
  for (const session of document.sessions) {
    const own = sameBudgetSession(session, scope)
    const entries = document.reservations.filter((entry) => entry.sessionKey === session.key && entry.status !== 'released')
    const observed = observedTextCost(session, scope, own)
    const settledText = entries.filter((entry) => entry.kind === 'model' && entry.status === 'settled')
      .reduce((sum, entry) => sum + (entry.actualUsd ?? entry.estimatedUsd ?? 0), 0)
    // Completion can reach this ledger before Session/history cost projection.
    // Retain only that unreflected delta, so a later projection is not charged twice.
    const unreflected = Math.max(0, session.baselineTextUsd + settledText - observed)
    const pendingText = entries.filter((entry) => entry.kind === 'model' && entry.status !== 'settled')
    const media = entries.filter((entry) => entry.kind === 'media')
    const monthlyMedia = media.filter((entry) => entry.status !== 'settled' || monthKeyFor(entry.createdAt) === month)
    const unknown = [...pendingText, ...monthlyMedia].some(unknownCharge)
    monthlySpentUsd += unreflected + sumCharges(pendingText) + sumCharges(monthlyMedia)
    monthlyUnknown ||= unknown
    for (const aggregate of aggregates) {
      if (!session.sessionIds.some((id) => aggregate.sessionIds.includes(id))) continue
      aggregate.spent += unreflected + sumCharges(pendingText) + sumCharges(media)
      aggregate.unknown ||= [...pendingText, ...media].some(unknownCharge)
    }
    if (own) {
      const completed = entries.filter((entry) => entry.kind === 'model' && entry.status === 'settled')
      actualTextCostUsd = completed.every((entry) => entry.actualUsd !== undefined)
        ? Math.max(observed, session.baselineTextUsd + completed.reduce((sum, entry) => sum + (entry.actualUsd ?? 0), 0)) : undefined
      sessionSpentUsd = observed + unreflected + sumCharges(pendingText) + sumCharges(media)
      sessionUnknown = [...pendingText, ...media].some(unknownCharge)
    }
  }
  return {
    ...(aggregates.length ? { aggregateRemainingUsd: aggregates.map((budget) => remaining(budget.limitUsd, budget.spent, budget.unknown)!) } : {}),
    actualTextCostUsd, sessionSpentUsd, monthlySpentUsd, sessionUnknown, monthlyUnknown,
    sessionRemainingUsd: remaining(scope.sessionLimitUsd, sessionSpentUsd, sessionUnknown),
    monthlyRemainingUsd: remaining(scope.monthlyLimitUsd, monthlySpentUsd, monthlyUnknown)
  }
}

export function assertRequestBudget(snapshot: RequestBudgetSnapshot, estimatedUsd: number | undefined): void {
  for (const remaining of [snapshot.sessionRemainingUsd, snapshot.monthlyRemainingUsd, ...(snapshot.aggregateRemainingUsd ?? [])]) {
    if (remaining === undefined) continue
    if (remaining <= 0) throw new ModelRouteError('ROUTING_BUDGET_EXHAUSTED', '会话或月度预算已耗尽，或存在费用待对账的请求。')
    if (estimatedUsd === undefined || estimatedUsd > remaining) {
      throw new ModelRouteError('ROUTING_BUDGET_UNAFFORDABLE', '请求未定价或超过会话/月度剩余预算，未发送请求。')
    }
  }
}

export function sameBudgetSession(session: BudgetSession, scope: Pick<RequestBudgetScope, 'sessionId' | 'sdkSessionId'>): boolean {
  return session.sessionIds.includes(scope.sessionId) || Boolean(scope.sdkSessionId && session.sdkSessionId === scope.sdkSessionId)
}

function observedTextCost(session: BudgetSession, scope: RequestBudgetScope, own: boolean): number {
  const costs = scope.observedSessions.filter((entry) => sameBudgetSession(session, { sessionId: entry.id, sdkSessionId: entry.sdkSessionId }))
    .map((entry) => entry.costUsd)
  return Math.max(session.observedTextUsd, own ? scope.sessionTextCostUsd : 0, ...costs)
}

function unknownCharge(entry: RequestBudgetReservation): boolean {
  return entry.status === 'unknown' || (entry.actualUsd === undefined && entry.estimatedUsd === undefined)
}

function sumCharges(entries: RequestBudgetReservation[]): number {
  return entries.reduce((sum, entry) => sum + (entry.actualUsd ?? entry.estimatedUsd ?? 0), 0)
}

function remaining(limit: number | undefined, spent: number, unknown: boolean): number | undefined {
  return limit === undefined ? undefined : unknown ? 0 : Math.max(0, limit - spent)
}
