let pendingSessionId: string | null = null

export const TASK_PLAN_NAVIGATION_EVENT = 'caogen:task-plan-navigation'

/** Retain an explicit plan destination until its session workbench mounts. */
export function requestTaskPlanNavigation(sessionId: string): void {
  pendingSessionId = sessionId
  window.dispatchEvent(new CustomEvent(TASK_PLAN_NAVIGATION_EVENT, { detail: { sessionId } }))
}

export function takeTaskPlanNavigation(sessionId: string): boolean {
  if (pendingSessionId !== sessionId) return false
  pendingSessionId = null
  return true
}
