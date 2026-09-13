let pending: string | null = null
let pendingSurface: { businessLineId: string; surface: 'tasks' | 'results' } | null = null
export const BUSINESS_LINE_NEW_TASK_EVENT = 'caogen:business-line-new-task'
export const BUSINESS_LINE_SURFACE_EVENT = 'caogen:business-line-surface'

/** Retain an explicit task destination until its lazy workspace subscribes. */
export function requestBusinessLineTaskNavigation(businessLineId: string): void {
  if (!businessLineId.startsWith('business-line:')) return
  pending = businessLineId
  window.dispatchEvent(new CustomEvent(BUSINESS_LINE_NEW_TASK_EVENT, { detail: { businessLineId } }))
}

export function hasBusinessLineTaskNavigation(businessLineId: string): boolean { return pending === businessLineId }
export function takeBusinessLineTaskNavigation(businessLineId: string): boolean {
  if (pending !== businessLineId) return false
  pending = null
  return true
}
export function requestBusinessLineSurfaceNavigation(businessLineId: string, surface: 'tasks' | 'results'): void {
  pendingSurface = { businessLineId, surface }
  window.dispatchEvent(new CustomEvent(BUSINESS_LINE_SURFACE_EVENT, { detail: pendingSurface }))
}
export function takeBusinessLineSurfaceNavigation(businessLineId: string): 'tasks' | 'results' | null {
  if (pendingSurface?.businessLineId !== businessLineId) return null
  const surface = pendingSurface.surface
  pendingSurface = null
  return surface
}
