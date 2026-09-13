import { resolveBusinessLineId } from '../../../../shared/business-line-types'
import type { SessionState } from '../../store'
import type { OfficeOperationalActor } from './operationalActors'
import { shouldProjectOfficeWorker } from './sessionProjection'

export function officeFacilitySignals(sessions: Record<string, SessionState>, actors: OfficeOperationalActor[]): {
  counts: Record<string, number>; incidents: number
} {
  const counts: Record<string, number> = {}
  let incidents = 0
  for (const session of Object.values(sessions)) {
    if (!shouldProjectOfficeWorker(session)) continue
    const line = resolveBusinessLineId(session.meta)
    counts[line] = (counts[line] ?? 0) + 1
    if (session.meta.status === 'error' || session.pendingPermissions.length) incidents++
  }
  for (const actor of actors) {
    counts[actor.businessLineId] = (counts[actor.businessLineId] ?? 0) + 1
    if (actor.activity === 'error' || ['blocked', 'waiting_reconciliation', 'waiting_approval'].includes(actor.status)) incidents++
  }
  return { counts, incidents }
}
