import type { WatercolorCharacterRole } from '../../../../shared/watercolor-character'
import { stableWatercolorRole } from '../../../../shared/watercolor-character'
import type { OfficeBusinessView } from './officeReturnContext'
import type { SessionState } from '../../store'
import { resolveBusinessLineId } from '../../../../shared/business-line-types'

export function sceneForTheme(spaceTheme: string, light: boolean): { bg: string } {
  if (spaceTheme === 'creative-studio') return { bg: light ? '#e5e8db' : '#303b35' }
  if (spaceTheme === 'quiet-library') return { bg: light ? '#ede7d8' : '#343931' }
  return { bg: light ? '#eeeadd' : '#303a37' }
}

type OfficeSessions = Record<string, SessionState>

export function businessSessionIds(view: OfficeBusinessView, ids: string[], sessions: OfficeSessions): string[] {
  if (view === 'all') return ids
  const lineId = view === 'project' ? 'studio' : view
  return ids.filter((id) => sessions[id] && resolveBusinessLineId(sessions[id].meta) === lineId)
}

export function watercolorRoleForSession(
  session: OfficeSessions[string] | undefined,
  fallbackId: string,
  roles: Record<string, WatercolorCharacterRole>
): WatercolorCharacterRole {
  const binding = session?.meta.digitalWorkerBinding
  if (binding?.kind === 'assigned') return roles[binding.workerId] ?? stableWatercolorRole(binding.workerId)
  return stableWatercolorRole(session?.meta.id ?? fallbackId)
}
