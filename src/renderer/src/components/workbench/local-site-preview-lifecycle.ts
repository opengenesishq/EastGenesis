import { useStore } from '../../store'

// Keep cleanup alive when the Sites panel is hidden by its Browser preview.
const managedSessions = new Set<string>()
let current = useStore.getState().activeId
useStore.subscribe(state => {
  if (state.activeId === current) return
  const previous = current; current = state.activeId
  if (previous && managedSessions.delete(previous)) void window.agentDesk.stopLocalSitePreview(previous).catch(() => undefined)
})
export function trackLocalSitePreview(sessionId: string): void { managedSessions.add(sessionId) }
export function untrackLocalSitePreview(sessionId: string): void { managedSessions.delete(sessionId) }
