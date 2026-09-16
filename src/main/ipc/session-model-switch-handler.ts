import type { Engine } from '../engine'
import { assertSessionModelSwitchAllowed } from '../session-model-switch-policy'
import { randomUUID } from 'node:crypto'
import type { SessionMeta, TaskRunRecord } from '../../shared/types'
import { prepareSessionModelHandoff } from '../agent/session-model-handoff'
import { assertSessionModelChange, sealSessionModelChange } from '../session-model-change'
import { isTaskRunTerminal } from '../task/task-run'
import { runHasUnresolvedEffects } from '../task/effect-runtime'
import { resolveRuntimeSessionRoute } from '../model/session-runtime-routing'

export interface SessionModelSwitchContext {
  rootDir: string
  getRun(): TaskRunRecord | undefined
  isCurrent(session: Engine): boolean
  assertRecoveryAllowed(): Promise<void>
  persist(): Promise<void>
  prepareHandoff?: typeof prepareSessionModelHandoff
  validateTarget?: (meta: SessionMeta) => void
}

export async function applySessionModelSwitch(
  session: Engine | undefined,
  requestedModel: unknown,
  context: SessionModelSwitchContext
): Promise<void> {
  if (!session) throw new Error('当前任务已关闭或不存在，请重新打开原任务。')
  const sourceRun = context.getRun()
  const validate = () => {
    if (!context.isCurrent(session) || context.getRun()?.id !== sourceRun?.id ||
        context.getRun()?.revision !== sourceRun?.revision) throw new Error('任务状态已变化，请重新选择模型。')
    const decision = assertSessionModelSwitchAllowed({ currentModel: session.meta.model,
      pendingPermissionCount: session.pendingPermissions().length, status: session.meta.status }, requestedModel)
    if ((sourceRun && !isTaskRunTerminal(sourceRun.status)) || runHasUnresolvedEffects(sourceRun) ||
        sourceRun?.toolExecutions?.some(item => item.status === 'unknown_outcome')) {
      throw new Error('请先暂停当前执行，并核对未决操作后切换模型。')
    }
    return decision
  }
  let decision = validate()
  const previous = assertSessionModelChange(session.meta)
  if (!decision.changed && previous?.state !== 'prepared') return
  if (previous?.state === 'prepared' && previous.to.model !== decision.model) {
    throw new Error('上次切换的保存状态尚未确认，请先重新选择同一模型完成交接。')
  }
  if (previous?.state === 'prepared' && (previous.sourceRunId !== sourceRun?.id ||
      previous.sourcePolicyDigest !== sourceRun?.routingPolicy?.policyDigest ||
      previous.to.providerId !== session.meta.providerId)) {
    throw new Error('未完成的模型切换与当前运行不一致，请恢复原任务记录。')
  }
  await context.assertRecoveryAllowed()
  decision = validate()
  const targetMeta: SessionMeta = { ...session.meta, model: decision.model,
    routingScope: decision.model === 'auto' ? (session.meta.routingScope === 'global' ? 'global' : 'provider') : 'fixed' }
  ;(context.validateTarget ?? validateFixedTarget)(targetMeta)
  const handoff = previous?.state === 'prepared' ? previous.handoff
    : await (context.prepareHandoff ?? prepareSessionModelHandoff)(session.meta, sourceRun, context.rootDir)
  validate()
  await context.assertRecoveryAllowed()
  validate()
  const prepared = previous?.state === 'prepared' ? previous : sealSessionModelChange({
    schemaVersion: 1, id: randomUUID(), state: 'prepared', sessionId: session.meta.id,
    projectId: session.meta.workspaceId ?? session.meta.projectId, goalId: session.meta.goalId, workItemId: session.meta.workItemId,
    sourceRunId: sourceRun?.id, sourcePolicyDigest: sourceRun?.routingPolicy?.policyDigest,
    from: { providerId: session.meta.providerId, model: session.meta.model, routingScope: session.meta.routingScope },
    to: { providerId: targetMeta.providerId, model: targetMeta.model, routingScope: targetMeta.routingScope! },
    handoff, createdAt: Date.now()
  })
  session.meta.modelChange = prepared
  try {
    // A durable prepared record blocks ordinary sends after any incomplete change.
    await context.persist()
    validate()
    await session.setModel(prepared.to.model)
    validate()
    if (session.meta.model !== prepared.to.model || session.meta.providerId !== prepared.to.providerId ||
        session.meta.routingScope !== prepared.to.routingScope) {
      throw new Error('执行器未采用已选择的模型，切换尚未完成。')
    }
    session.meta.modelChange = sealSessionModelChange({ ...prepared, state: 'committed' })
    await context.persist()
    session.emitSyntheticEvent?.({ kind: 'hook-event', event: 'session-model-changed',
      detail: JSON.stringify({ changeId: prepared.id, sourceRunId: sourceRun?.id,
        fromModel: prepared.from.model, toModel: prepared.to.model, handoffDigest: handoff.digest,
        note: '用户明确选择后续模型；沿用目标、资料版本和既有权限，未发送新请求。' }) })
  } catch (error) {
    session.meta.modelChange = prepared
    // The engine may already hold the new model. Keep it blocked instead of
    // guessing whether a failed durable write committed the new projection.
    throw error
  }
}

function validateFixedTarget(meta: SessionMeta): void {
  if (meta.model === 'auto') return
  resolveRuntimeSessionRoute({ meta, payload: { text: '' } })
}
