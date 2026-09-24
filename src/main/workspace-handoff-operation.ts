import type { SessionMeta } from '../shared/types'
import { handoffHash } from './git/workspace-handoff-files'
import { reconcileInteractiveOperationSnapshot } from './ipc/operation-snapshot'
import { effectRecordIntegrityMatches } from './task/effect-record-integrity'
import { getTaskSnapshot } from './task/task-snapshot'
import { executeInteractiveOperationEffectInSessionQueue } from './task/operation-effect-gateway'
import { executeWorkspaceHandoffTarget, prepareWorkspaceHandoff } from './workspace-handoff'

/** Caller holds the source Session queue and has stopped its engines and terminals. */
export async function executeWorkspaceHandoffOperation(meta: SessionMeta): Promise<void> {
  const target = prepareWorkspaceHandoff(meta)
  const interrupted = await getTaskSnapshot(`operation:${target.journalId}`)
  const previous = interrupted?.run?.effects?.find(effect => effect.target.kind === 'workspace_handoff' && effect.target.journalId === target.journalId)
  if (interrupted && previous) {
    if (!effectRecordIntegrityMatches(previous) || handoffHash(previous.target) !== handoffHash(target)) {
      throw new Error('原交接 Effect 与持久事务不一致，已阻止恢复。')
    }
    if (['executing', 'waiting_reconciliation', 'confirmed'].includes(previous.status)) {
      // Retry the journal's exact old/new-byte transaction under its original
      // executing Effect. No new lease and no second source copy are created.
      executeWorkspaceHandoffTarget(target)
      const unsettled = await reconcileInteractiveOperationSnapshot(interrupted)
      if (unsettled) throw new Error('交接文件已处理，但执行账本尚未确认，请继续核对本次交接。')
      return
    }
    // A prepared Effect has never crossed the physical execution barrier.
    // Settle it before acquiring a fresh generation for the same journal.
    const unsettled = await reconcileInteractiveOperationSnapshot(interrupted)
    if (unsettled) throw new Error('上次交接操作尚未停止，不能开始新的交接。')
  }
  const outcome = await executeInteractiveOperationEffectInSessionQueue({
    operationId: target.journalId, source: 'session_lifecycle', kind: 'workspace_handoff', title: '交接任务工作目录',
    sourceSessionId: meta.id, projectId: meta.workspaceId ?? meta.projectId,
    workspaceId: meta.workspaceId, goalId: meta.goalId, workItemId: meta.workItemId,
    cwd: meta.cwd, toolName: 'workspace_handoff', toolInput: { sessionId: meta.id, journalId: target.journalId },
    execute: effect => {
      if (effect.target.kind !== 'workspace_handoff') throw new Error('交接效果目标不一致。')
      return executeWorkspaceHandoffTarget(effect.target)
    }, isSuccess: result => result.ok, resultSummary: result => JSON.stringify(result)
  })
  if (outcome.status !== 'completed') throw new Error(outcome.error)
}
