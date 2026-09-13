export interface VideoProductionNavigation { projectId: string; productionId: string; businessLineId?: string; action?: 'new-project' }

let pending: VideoProductionNavigation | null = null

/** Keep navigation until the lazy video workspace mounts and subscribes. */
export function requestVideoProductionNavigation(target: VideoProductionNavigation): void {
  pending = target
  window.dispatchEvent(new CustomEvent('caogen:video-select-production', { detail: target }))
}

export function peekVideoProductionNavigation(): VideoProductionNavigation | null { return pending }

export function requestNewVideoProjectNavigation(businessLineId = 'video'): void {
  requestVideoProductionNavigation({ projectId: '', productionId: '', businessLineId, action: 'new-project' })
}

export function takeVideoProductionNavigation(businessLineId = 'video'): VideoProductionNavigation | null {
  if (pending && (pending.businessLineId ?? 'video') !== businessLineId) return null
  const target = pending
  pending = null
  return target
}
