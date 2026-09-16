import type { TaskSnapshotRecord } from '../../shared/types'
import type { TaskEffectRecoveryView } from '../../shared/effect-recovery-types'
import { effectRecordIntegrityMatches } from './effect-record-integrity'

export function buildTaskEffectRecoveryView(snapshots: readonly TaskSnapshotRecord[], sessionId: string,
  runId?: string, taskId?: string, isActive: (snapshot: TaskSnapshotRecord) => boolean = () => false): TaskEffectRecoveryView {
  const view: TaskEffectRecoveryView = { sessionId, runId, taskId, snapshots: [] }
  const runs = new Set<string>()
  for (const snapshot of snapshots) {
    if (snapshot.sessionId !== sessionId) continue
    const run = snapshot.run
    if (!run) continue
    if (snapshot.taskId !== run.taskId || run.sessionId !== sessionId ||
      (run.effects ?? []).some(effect => effect.runId !== run.id || effect.sessionId !== sessionId || !effectRecordIntegrityMatches(effect))) {
      throw new Error('恢复记录身份或摘要冲突，请先修复原任务记录')
    }
    if ((runId && run.id !== runId) || (taskId && run.taskId !== taskId)) continue
    if (runs.has(run.id)) throw new Error('同一运行存在多个恢复快照，已停止展示歧义记录')
    runs.add(run.id)
    const canResolve = !isActive(snapshot)
    view.snapshots.push({ snapshotId: snapshot.id, runId: run.id, taskId: run.taskId,
      effects: run.effects ?? [], canResolve, ...(!canResolve ? { unavailableReason: 'active_execution' as const } : {}) })
  }
  return view
}
