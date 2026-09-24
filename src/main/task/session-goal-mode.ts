import { join } from 'node:path'
import type { SessionGoalModeClearResult } from '../../shared/session-goal-mode'
import { sessionManager } from '../sessionManager'
import { routineHeartbeatService } from '../routines/routine-heartbeat-runtime'
import { pauseSessionContinuations } from '../routines/pause-session-continuations'
import { runHasUnresolvedEffects } from './effect-runtime'
import { SupervisorStateStore } from './supervisor-state'

/** Clear means exit the bounded continuation mode, never delete the canonical Goal. */
export async function clearSessionGoalMode(sessionId: string, workspaceRoot: string): Promise<SessionGoalModeClearResult> {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) throw new Error('任务标识无效')
  const meta = sessionManager.get(sessionId)?.meta
  if (!meta?.workspaceId || !meta.goalId || !meta.workItemId || meta.parentSessionId) throw new Error('请先恢复原目标任务')
  const originalMeta = { ...meta }
  // Disable immediately, then interrupt in-flight work before waiting on its
  // heartbeat queue. An engine may keep send() pending for the whole turn.
  await pauseSessionContinuations(join(workspaceRoot, 'routines'), sessionId)
  let executionPaused = false, reason: string | undefined
  try {
    await sessionManager.persistTaskRunLifecycleBarrier(sessionId)
    const store = new SupervisorStateStore(workspaceRoot)
    const current = sessionManager.getTaskRun(sessionId)
    const supervisor = current && (await store.listRuns({ projectId: meta.workspaceId })).find(run =>
      run.id === current.id && run.workItemId === meta.workItemId && run.origin === 'task_run')
    if (supervisor && ['running', 'waiting_approval'].includes(supervisor.status)) {
      const leased = await sessionManager.claimSupervisorControlLease(store, supervisor.id, supervisor.revision)
      if (!leased.lease) throw new Error('执行控制租约不可用')
      const controlled = await sessionManager.controlSupervisorRun(store, { action: 'pause', runId: supervisor.id,
        options: { expectedRevision: leased.revision, ownerId: leased.lease.ownerId, leaseId: leased.lease.id, fencingToken: leased.lease.fencingToken } })
      if (!controlled || controlled.supervisorRun.status !== 'paused') throw new Error('执行仍需核对，请查看原任务的运行记录')
    } else if (meta.status === 'running' || meta.status === 'starting') {
      // The normal interrupt path preserves unknown external outcomes for reconciliation.
      await sessionManager.interrupt(sessionId)
    }
    const after = sessionManager.get(sessionId)?.meta
    const run = sessionManager.getTaskRun(sessionId)
    const pending = runHasUnresolvedEffects(run) || ['waiting_reconciliation', 'recovering'].includes(run?.status ?? '') ||
      ['waiting_reconciliation', 'blocked'].includes(supervisor?.status ?? '')
    executionPaused = Boolean(after) && !pending && after?.status !== 'running' && after?.status !== 'starting'
    if (pending) reason = '持续目标模式已退出；原执行有待核对结果，请在执行记录中处理。'
  } catch (error) {
    reason = `持续目标模式已退出；当前执行暂停结果待核对：${error instanceof Error ? error.message : String(error)}`
  }
  const result = await routineHeartbeatService(join(workspaceRoot, 'routines'), workspaceRoot).retireSessionGoalMode(sessionId, originalMeta)
  return { ...result, executionPaused, ...(reason ? { reason } : {}) }
}
