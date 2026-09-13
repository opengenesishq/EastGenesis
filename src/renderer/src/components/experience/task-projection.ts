import { resolveBusinessLineId, type BusinessLineTaskIdentity } from '../../../../shared/business-line-types'

/** Canonical task ownership does not choose a UI surface; an explicit business line does. */
export function deriveTaskProjection(input: {
  activeSession?: BusinessLineTaskIdentity
  hasActive: boolean
  newSessionProjectId: string | null
  showNewSession: boolean
  welcomeProjectChoice: string | null
}): { hasAssistantSession: boolean; hasProjectSession: boolean; hasProjectTask: boolean } {
  const lineId = input.activeSession ? resolveBusinessLineId(input.activeSession) : undefined
  const hasTask = input.hasActive && Boolean(input.activeSession) && !input.showNewSession
  const hasProjectTask = hasTask && lineId === 'studio'
  const persistedProjectDraft = !input.hasActive && Boolean(input.welcomeProjectChoice &&
    !['__unassigned__', '__new_project__'].includes(input.welcomeProjectChoice))
  return {
    hasProjectTask,
    hasProjectSession: hasProjectTask || Boolean(input.showNewSession && input.newSessionProjectId) || persistedProjectDraft,
    hasAssistantSession: hasTask && lineId === 'assistant'
  }
}
