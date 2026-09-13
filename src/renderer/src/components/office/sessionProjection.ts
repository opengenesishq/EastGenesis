import type { SessionState } from '../../store'
import { MAX_ACTIVE_AGENT_COUNT } from '../../../../shared/agent-capacity-policy'

/**
 * The Office is a live control surface, not an unbounded session archive.
 * Keep active/attention sessions visible and bound the expensive historical
 * workstation projection to the desktop orchestration capacity.
 */
export const OFFICE_RENDER_SESSION_LIMIT = MAX_ACTIVE_AGENT_COUNT

const PINNED_SESSION_STATUSES = new Set(['starting', 'running', 'error'])

/**
 * A session is not a worker.  Keep draft/idle/completed history in the list,
 * but only project a character when there is an execution state worth taking
 * over in the Control Room.
 */
export function shouldProjectOfficeWorker(session: SessionState): boolean {
  if (session.pendingPermissions.length > 0) return true
  if (Object.keys(session.runningTools).length > 0) return true
  if (session.meta.status === 'starting' || session.meta.status === 'running' || session.meta.status === 'error') return true

  const execution = session.taskDagExecution
  if (!execution) return false
  if (execution.status === 'running') return true
  return execution.status === 'waiting' && execution.tasks.some((task) => task.status === 'waiting' || task.status === 'running')
}

export function projectOfficeSessionIds(
  order: readonly string[],
  sessions: Readonly<Record<string, SessionState>>,
  activeId: string | null,
  limit = OFFICE_RENDER_SESSION_LIMIT
): string[] {
  const candidates = order.filter((id) => Boolean(sessions[id]))
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : OFFICE_RENDER_SESSION_LIMIT
  if (candidates.length <= normalizedLimit) return [...candidates]

  const pinned = new Set(
    candidates.filter((id) => {
      const session = sessions[id]
      return id === activeId ||
        PINNED_SESSION_STATUSES.has(session.meta.status) ||
        session.pendingPermissions.length > 0
    })
  )
  const orderIndex = new Map(candidates.map((id, index) => [id, index] as const))
  const pinnedPriority = (id: string): number => {
    const session = sessions[id]
    if (id === activeId) return 0
    if (session.pendingPermissions.length > 0) return 1
    if (session.meta.status === 'error') return 2
    if (session.meta.status === 'starting') return 3
    return 4
  }
  const prioritizedPinned = candidates
    .filter((id) => pinned.has(id))
    .sort((left, right) => {
      return pinnedPriority(left) - pinnedPriority(right) ||
        sessions[right].meta.createdAt - sessions[left].meta.createdAt ||
        (orderIndex.get(right) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(left) ?? Number.MAX_SAFE_INTEGER)
    })
  const visiblePinned = prioritizedPinned.slice(0, normalizedLimit)
  const historical = candidates
    .filter((id) => !pinned.has(id))
    .sort((left, right) => {
      const rightCreatedAt = sessions[right].meta.createdAt
      const leftCreatedAt = sessions[left].meta.createdAt
      return rightCreatedAt - leftCreatedAt ||
        (orderIndex.get(right) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(left) ?? Number.MAX_SAFE_INTEGER)
    })
  const keep = new Set([
    ...visiblePinned,
    ...historical.slice(0, Math.max(0, normalizedLimit - visiblePinned.length))
  ])
  return candidates.filter((id) => keep.has(id))
}
