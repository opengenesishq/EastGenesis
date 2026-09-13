import type { TaskSnapshotRecord } from '../../../../shared/types'
import type { ModelAttemptReconciliationView } from '../../../../shared/model-attempt-types'
import type { SessionState } from '../../store'

export function officeSessionNeedsRecovery(id: string, snapshots: TaskSnapshotRecord[], attempts: ModelAttemptReconciliationView[]): boolean {
  if (attempts.some((item) => item.sessionId === id)) return true
  return snapshots.filter((item) => item.sessionId === id || item.run?.operation?.sourceSessionId === id).some((snapshot) => {
    const run = snapshot.run
    if (snapshot.dagExecutions?.some((execution) => execution.finalization?.phase === 'waiting_reconciliation' ||
      (execution.finalization?.phase === 'summary_pending' && Boolean(execution.finalization.error)))) return true
    if (!run) return false
    if (['waiting_approval', 'waiting_reconciliation', 'recovering'].includes(run.status) || run.pendingPermissionRequestId) return true
    if (run.effects?.some((effect) => ['prepared', 'executing', 'waiting_reconciliation'].includes(effect.status))) return true
    return Boolean(run.toolExecutions?.some((tool) => tool.status === 'unknown_outcome'))
  })
}

export function officeSessionCanContinue(session: SessionState | undefined): boolean {
  if (!session || !['idle', 'error'].includes(session.meta.status)) return false
  return session.pendingPermissions.length === 0 && Object.keys(session.runningTools).length === 0
}

export function officeSessionCanStop(session: SessionState): boolean {
  return ['running', 'starting'].includes(session.meta.status) || session.pendingPermissions.length > 0 || Object.keys(session.runningTools).length > 0
}
