import type { WatercolorCharacterRole } from '../../../../shared/watercolor-character'
import { resolveBusinessLineId } from '../../../../shared/business-line-types'
import type { ProviderView } from '../../../../shared/types'
import type { SessionState } from '../../store'
import { officeActivityForSessionId } from './model'
import { watercolorRoleForSession } from './officeViewSupport'
import type { AgentWalkerSpec, AgentWalkReason } from './kit/AgentWalkers'
import type { OfficeFacilitySpec } from './kit/facilityCatalog'
import { CONTROL_ROOM_LAYOUT, courtyardZoneLayout } from './kit/controlRoomLayout'

/** A figure may visit its visible business court or the shared approval desk. */
export function officeWalkers(input: {
  ids: string[]; positions: Array<[number, number, number]>; sessions: Record<string, SessionState>
  providers: ProviderView[]; roles: Record<string, WatercolorCharacterRole>; facilities: OfficeFacilitySpec[]; reducedMotion: boolean
}): AgentWalkerSpec[] {
  // A pending approval is handled in the council UI; it does not establish a
  // physical transfer. Resume courtyard walks only with an actual handoff
  // route including doors, stairs and the raised hall floors.
  if (input.reducedMotion || input.positions.some((position) => position[1] > 0)) return []
  const candidates = input.ids.flatMap((id, index) => {
    const session = input.sessions[id]
    const position = input.positions[index]
    if (!session || !position) return []
    const activity = officeActivityForSessionId(id, input.sessions)
    const destination = walkerDestination(activity, resolveBusinessLineId(session.meta), input.facilities)
    if (!destination) return []
    const provider = input.providers.find((item) => item.id === session.meta.providerId)
    return [{ id: `${id}:${destination.reason}`, sessionId: id,
      home: [position[0], 0, position[2] + 0.64] as [number, number, number],
      homeLookAt: [position[0], 0, position[2] - 0.48] as [number, number, number],
      ...destination, providerName: provider?.name, providerBaseUrl: provider?.baseUrl,
      modelName: session.meta.model, watercolorRole: watercolorRoleForSession(session, id, input.roles),
      phase: 8.4 + index * 4.5, holdAtTarget: activity === 'idle', departureDelay: activity === 'idle' ? 0.4 : 0 }]
  })
  return [...candidates.filter((item) => item.reason === 'approval').slice(0, 1),
    ...candidates.filter((item) => item.reason !== 'approval').slice(0, 1)]
}

function walkerDestination(activity: string, businessLineId: string, facilities: OfficeFacilitySpec[]): {
  target: [number, number, number]; targetLookAt: [number, number, number]; reason: AgentWalkReason
} | null {
  if (activity === 'awaiting') return { target: CONTROL_ROOM_LAYOUT.approvalApproach,
    targetLookAt: [CONTROL_ROOM_LAYOUT.approval[0], 0.82, CONTROL_ROOM_LAYOUT.approval[2]], reason: 'approval' }
  if (activity !== 'idle') return null
  const facility = facilities.find((item) => item.businessLineId === businessLineId)
  if (!facility) return null
  const zone = courtyardZoneLayout(facility.position)
  const reason = facility.variant === 'custom' ? 'business' : facility.variant ?? 'business'
  return { target: zone.approach, targetLookAt: zone.lookAt, reason }
}
