export const REQUIREMENTS_CHANGED_EVENT = 'caogen:task-requirements-changed'

export function announceRequirementRevision(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(REQUIREMENTS_CHANGED_EVENT, { detail: { sessionId } }))
}
