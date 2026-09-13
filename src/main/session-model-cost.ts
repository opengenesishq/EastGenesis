import type { AgentEvent, SessionMeta } from '../shared/types'
import { nativeBudgetSnapshot } from './model/native-request-budget'
import { estimateTurnCostUsd, normalizePositiveNumber } from './session-manager-support'

/** Project only settled text charges; media reservations and unknown outcomes are not reported as paid text cost. */
export function normalizeSessionTurnCost(meta: SessionMeta, event: AgentEvent): AgentEvent {
  if (event.kind !== 'turn-result') return event
  const budget = nativeBudgetSnapshot(meta)
  if (budget.actualTextCostUsd !== undefined) {
    meta.costUsd = Math.max(meta.costUsd, budget.actualTextCostUsd)
    return { ...event, costUsd: meta.costUsd }
  }
  if (budget.sessionUnknown) return event
  // Legacy transcripts predate the request ledger; use their existing explicit price path only.
  const reported = normalizePositiveNumber(event.costUsd)
  const estimated = reported === undefined ? estimateTurnCostUsd(meta, event) : undefined
  const turnCost = reported ?? estimated
  if (turnCost === undefined) return event
  const current = normalizePositiveNumber(meta.costUsd) ?? 0
  meta.costUsd = reported !== undefined && reported >= current ? reported : current + turnCost
  return { ...event, costUsd: meta.costUsd }
}
