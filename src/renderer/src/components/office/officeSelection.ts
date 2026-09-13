import type { SessionState } from '../../store'
import type { WatercolorCharacterRole } from '../../../../shared/watercolor-character'
import type { GitStatus } from '../../../../shared/types'
import { buildOfficeModel, officeActivityForSessionId, type OfficeModel } from './model'
import { watercolorRoleForSession } from './officeViewSupport'

export function officeSessionSelection(
  activeId: string | null, visibleIds: string[], operationalSelected: boolean,
  sessions: Record<string, SessionState>, officeModel: OfficeModel,
  roles: Record<string, WatercolorCharacterRole>, allowedSelectionIds: readonly string[] = visibleIds,
  gitStatuses: Record<string, GitStatus | undefined> = {}
) {
  const activeOfficeId = operationalSelected ? null
    : activeId && allowedSelectionIds.includes(activeId) ? activeId : visibleIds[0] ?? null
  const activeOfficeIndex = activeOfficeId ? visibleIds.indexOf(activeOfficeId) : -1
  const activeOfficeSession = activeOfficeId ? sessions[activeOfficeId] : undefined
  const activeOfficeActivity = activeOfficeSession ? officeActivityForSessionId(activeOfficeSession.meta.id, sessions) : undefined
  const activeOfficeModel = selectedOfficeModel(activeOfficeId, officeModel, sessions, gitStatuses)
  const activeOfficeSignal = activeOfficeModel?.signal
  const activeOfficeRole = activeOfficeSession
    ? watercolorRoleForSession(activeOfficeSession, activeOfficeSession.meta.id, roles) : undefined
  return { activeOfficeId, activeOfficeIndex, activeOfficeSession, activeOfficeActivity, activeOfficeModel, activeOfficeSignal, activeOfficeRole }
}

function selectedOfficeModel(id: string | null, model: OfficeModel, sessions: Record<string, SessionState>, gitStatuses: Record<string, GitStatus | undefined>) {
  if (!id) return undefined
  return model.sessions[id] ?? buildOfficeModel([id], sessions, gitStatuses).sessions[id]
}

export function officeSelectionPosition(
  positions: Array<[number, number, number]>, sessionIndex: number,
  sessionCount: number, actorIds: string[], selectedActorId?: string
): [number, number, number] | undefined {
  const actorIndex = selectedActorId ? actorIds.indexOf(selectedActorId) : -1
  if (actorIndex >= 0) return positions[sessionCount + actorIndex]
  return sessionIndex >= 0 ? positions[sessionIndex] : undefined
}
