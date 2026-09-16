import { monthKeyFor } from '../../shared/budget'
import { ModelRouteError } from '../model/model-route-error'
import type { BudgetSession, RequestBudgetDocument, RequestBudgetReservation, RequestBudgetScope, RequestBudgetSnapshot } from './request-budget-types'

export function requestBudgetSnapshot(document: RequestBudgetDocument, scope: RequestBudgetScope, now = Date.now()): RequestBudgetSnapshot {
  let monthlySpentUsd = scope.monthlyTextSpentUsd
  let sessionSpentUsd = scope.sessionTextCostUsd
  let monthlyUnknown = false
  let sessionUnknown = false
  let actualTextCostUsd: number | undefined
  const aggregates = (scope.aggregateBudgets ?? []).map((budget) => ({ ...budget, spent: budget.textSpentUsd, pending: 0, unknown: false,
    recorded: budget.textSpentUsd, reservedUsd: 0, reservedCount: 0, unpricedReservedCount: 0, uncertainHeldUsd: 0, uncertainCount: 0,
    floors: (budget.textCostFloors ?? []).map((floor) => ({ ...floor, spent: floor.observedUsd, recorded: floor.observedUsd })) }))
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
    const unpricedText = entries.filter((entry) => entry.kind === 'model' && entry.status === 'settled' &&
      entry.actualUsd === undefined && entry.estimatedUsd === undefined)
    const media = entries.filter((entry) => entry.kind === 'media')
    const monthlyMedia = media.filter((entry) => entry.status !== 'settled' || monthKeyFor(entry.createdAt) === month)
    const unknown = [...pendingText, ...monthlyMedia, ...unpricedText].some(unknownCharge)
    monthlySpentUsd += unreflected + sumCharges(pendingText) + sumCharges(monthlyMedia)
    monthlyUnknown ||= unknown
    for (const aggregate of aggregates) {
      if (!session.aggregateBudgetIds?.includes(aggregate.id) && !(own && scope.aggregateBudgetIds?.includes(aggregate.id)) &&
          !session.sessionIds.some((id) => aggregate.sessionIds.includes(id))) continue
      // A sibling may not have a history row yet, or its row may have been
      // deleted. Its durable observed cost still belongs to the canonical Goal.
      const projected = Math.max(0, ...scope.observedSessions.filter((entry) =>
        aggregate.sessionIds.includes(entry.id) && sameBudgetSession(session, { sessionId: entry.id, sdkSessionId: entry.sdkSessionId }))
        .map((entry) => entry.costUsd))
      const unprojected = Math.max(0, observed + unreflected - projected)
      aggregate.spent += unprojected
      const recordedText = Math.max(observed, session.baselineTextUsd + entries.filter(entry => entry.kind === 'model' && entry.status === 'settled')
        .reduce((sum, entry) => sum + (entry.actualUsd ?? 0), 0))
      const recordedDelta = Math.max(0, recordedText - projected)
      aggregate.recorded += recordedDelta + media.filter(entry => entry.status === 'settled').reduce((sum, entry) => sum + (entry.actualUsd ?? 0), 0)
      const reserved = entries.filter(entry => entry.status === 'reserved')
      const uncertain = entries.filter(entry => entry.status === 'unknown' ||
        (entry.status === 'settled' && entry.actualUsd === undefined) || unknownCharge(entry))
      aggregate.reservedUsd += sumCharges(reserved)
      aggregate.reservedCount += reserved.length
      aggregate.unpricedReservedCount += reserved.filter(entry => entry.actualUsd === undefined && entry.estimatedUsd === undefined).length
      aggregate.uncertainHeldUsd += sumCharges(uncertain.filter(entry => entry.status !== 'reserved'))
      aggregate.uncertainCount += uncertain.length
      for (const floor of aggregate.floors) {
        if (session.aggregateBudgetIds?.includes(floor.id) || (own && scope.aggregateBudgetIds?.includes(floor.id)) ||
            session.sessionIds.some((id) => floor.sessionIds.includes(id))) {
          floor.spent += unprojected
          floor.recorded += recordedDelta
        }
      }
      aggregate.pending += sumCharges(pendingText) + sumCharges(media)
      aggregate.unknown ||= [...pendingText, ...media, ...unpricedText].some(unknownCharge)
    }
    if (own) {
      const completed = entries.filter((entry) => entry.kind === 'model' && entry.status === 'settled')
      actualTextCostUsd = completed.every((entry) => entry.actualUsd !== undefined)
        ? Math.max(observed, session.baselineTextUsd + completed.reduce((sum, entry) => sum + (entry.actualUsd ?? 0), 0)) : undefined
      sessionSpentUsd = observed + unreflected + sumCharges(pendingText) + sumCharges(media)
      sessionUnknown = [...pendingText, ...media, ...unpricedText].some(unknownCharge)
    }
  }
  return {
    ...(aggregates.length ? { aggregateRemainingUsd: aggregates.filter(budget => budget.limitUsd !== undefined).map((budget) => remaining(budget.limitUsd,
      budget.spent + budget.floors.reduce((sum, floor) => sum + Math.max(0, floor.minimumUsd - floor.spent), 0) + budget.pending,
      budget.unknown)!), aggregateUsage: aggregates.map(budget => ({
        id: budget.id,
        recordedSpentUsd: budget.recorded + budget.floors.reduce((sum, floor) => sum + Math.max(0, floor.minimumUsd - floor.recorded), 0),
        accountedUsd: budget.spent + budget.floors.reduce((sum, floor) => sum + Math.max(0, floor.minimumUsd - floor.spent), 0) + budget.pending,
        reservedUsd: budget.reservedUsd, reservedCount: budget.reservedCount,
        unpricedReservedCount: budget.unpricedReservedCount,
        uncertainHeldUsd: budget.uncertainHeldUsd, uncertainCount: budget.uncertainCount,
        remainingUsd: budget.uncertainCount ? undefined : remaining(budget.limitUsd,
          budget.spent + budget.floors.reduce((sum, floor) => sum + Math.max(0, floor.minimumUsd - floor.spent), 0) + budget.pending, false),
        admissionBlocked: budget.limitUsd !== undefined && budget.unknown
      })) } : {}),
    actualTextCostUsd, sessionSpentUsd, monthlySpentUsd, sessionUnknown, monthlyUnknown,
    sessionRemainingUsd: remaining(scope.sessionLimitUsd, sessionSpentUsd, sessionUnknown),
    monthlyRemainingUsd: remaining(scope.monthlyLimitUsd, monthlySpentUsd, monthlyUnknown)
  }
}

export function assertRequestBudget(snapshot: RequestBudgetSnapshot, estimatedUsd: number | undefined): void {
  for (const remaining of [snapshot.sessionRemainingUsd, snapshot.monthlyRemainingUsd, ...(snapshot.aggregateRemainingUsd ?? [])]) {
    if (remaining === undefined) continue
    if (remaining <= 0) throw new ModelRouteError('ROUTING_BUDGET_EXHAUSTED', '任务、目标或月度预算已耗尽，或存在费用待对账的请求。')
    if (estimatedUsd === undefined || estimatedUsd > remaining) {
      throw new ModelRouteError('ROUTING_BUDGET_UNAFFORDABLE', '请求未定价或超过任务、目标或月度剩余预算，未发送请求。')
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
