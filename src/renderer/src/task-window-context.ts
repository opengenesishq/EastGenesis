/** A renderer's task binding is immutable and validated against main-process state at startup. */
export function taskWindowSessionId(): string | null {
  if (typeof window === 'undefined') return null
  const id = window.agentDesk?.taskWindowSessionId
  return id && id.length <= 200 ? id : null
}
