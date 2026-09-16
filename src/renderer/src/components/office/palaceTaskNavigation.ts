import type { SessionMeta, WorkflowLedgerRendererSelection, WorkflowLedgerScope } from '../../../../shared/types'
import type { WorkInboxItem } from '../../../../shared/work-inbox-projection'
import { resolveInboxTaskDestination, type InboxTaskDestination } from '../studio/workInboxTaskNavigation'

/** Palace controls use the same current WorkItem/Run binding as the modern
 * inbox. Refreshing a session is read-only; it must never dispatch a task. */
export async function preparePalaceTaskNavigation(item: WorkInboxItem, host: {
  readLedger(scope: WorkflowLedgerScope): Promise<WorkflowLedgerRendererSelection>
  listSessions(): Promise<SessionMeta[]>
  syncSession(sessionId: string): Promise<boolean>
  session(sessionId: string): SessionMeta | undefined
  current(): boolean
}): Promise<InboxTaskDestination | null> {
  const target = await resolveInboxTaskDestination(item, host)
  if (!host.current()) return null
  if (!target.sessionId) return target
  if (!await host.syncSession(target.sessionId)) {
    return host.current() ? { runId: target.runId, reason: 'missing_session' } : null
  }
  if (!host.current()) return null
  const meta = host.session(target.sessionId)
  if (!meta || meta.status === 'closed') return { runId: target.runId, reason: 'missing_session' }
  if (!target.binding || meta.workspaceId !== target.binding.workspaceId || meta.goalId !== target.binding.goalId ||
    meta.workItemId !== target.binding.workItemId) return { runId: target.runId, reason: 'identity_conflict' }
  // A recovery or reassignment may have completed while the session loaded.
  const latest = await resolveInboxTaskDestination(item, host)
  if (!host.current()) return null
  if (latest.sessionId !== target.sessionId || latest.runId !== target.runId || latest.reason) {
    return { runId: latest.runId, reason: latest.reason ?? 'identity_conflict' }
  }
  return target
}
