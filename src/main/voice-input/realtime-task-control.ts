import type { SessionMeta } from '../../shared/types'
import type { SupervisorRunRecord } from '../../shared/supervisor-types'
import type { SupervisorSessionControlRequest } from '../task/supervisor-session-control'

export interface RealtimeTaskControlHost {
  session(id: string): SessionMeta | undefined
  runId(id: string): string | undefined
  pauseContinuations(id: string): Promise<void>
  getRun(id: string): Promise<SupervisorRunRecord | undefined>
  claimLease(id: string, revision: number): Promise<SupervisorRunRecord>
  control(request: SupervisorSessionControlRequest): Promise<{ sessionId: string } | null>
  interrupt(id: string): Promise<void>
}

/** Pause automatic prompts first; canonical tasks retain distinct Supervisor controls. */
export async function controlRealtimeVoiceTask(host: RealtimeTaskControlHost, sessionId: string, action: 'pause' | 'cancel'): Promise<void> {
  const meta = host.session(sessionId)
  if (!meta || meta.status === 'closed') throw new Error('当前任务已关闭。')
  await host.pauseContinuations(sessionId)
  const id = host.runId(sessionId)
  const run = id ? await host.getRun(id) : undefined
  if (!run) {
    if (meta.workspaceId || meta.workItemId || meta.goalId) {
      if (['running', 'starting'].includes(host.session(sessionId)?.status ?? '')) throw new Error('当前任务缺少可核验的运行控制记录；自动续跑已暂停，请到任务恢复中心核对。')
      return // An idle canonical task has no current Run; its continuation is now paused.
    }
    await host.interrupt(sessionId) // Legacy unscoped Sessions have no Supervisor row.
    return
  }
  if (run.projectId !== meta.workspaceId || run.workItemId !== meta.workItemId || run.goalId !== meta.goalId || host.runId(sessionId) !== run.id) throw new Error('语音控制的原任务运行身份已变化。')
  if (['completed', 'failed', 'cancelled'].includes(run.status) || (action === 'pause' && run.status === 'paused')) return
  if (action === 'pause' && !['running', 'waiting_approval'].includes(run.status)) throw new Error('当前运行状态无法暂停；自动续跑已停止，请在任务恢复中心核对。')
  const leased = action === 'pause' ? await host.claimLease(run.id, run.revision) : run
  if (host.runId(sessionId) !== run.id) throw new Error('语音控制的运行身份已变化。')
  const result = await host.control(action === 'pause'
    ? { action, runId: run.id, options: { ownerId: leased.lease!.ownerId, leaseId: leased.lease!.id, fencingToken: leased.lease!.fencingToken, expectedRevision: leased.revision, actorId: 'local-operator' } }
    : { action, runId: run.id, options: { expectedRevision: run.revision, actorId: 'local-operator' } })
  if (!result || result.sessionId !== sessionId) throw new Error('运行控制未返回原任务确认。')
}
