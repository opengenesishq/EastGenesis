import type { Engine } from '../engine'
import { assertSessionModelSwitchAllowed } from '../session-model-switch-policy'
import { randomUUID } from 'node:crypto'
import type { SessionMeta, TaskRunRecord } from '../../shared/types'
import { prepareSessionModelHandoff } from '../agent/session-model-handoff'
import { assertSessionModelChange, sealSessionModelChange } from '../session-model-change'
import { isTaskRunTerminal } from '../task/task-run'
import { runHasUnresolvedEffects } from '../task/effect-runtime'
import { sessionRoutingControl } from '../../shared/session-routing-control-types'
import { normalizeSessionRoutingControl, routingControlProjection, validateSessionRoutingControl } from '../session-routing-control'
import { digest } from '../task/workflow-ledger-canonical'

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
  const decision = assertSessionModelSwitchAllowed({ currentModel: session.meta.model,
    pendingPermissionCount: session.pendingPermissions().length, status: session.meta.status }, requestedModel)
  return applySessionRoutingControl(session, decision.model === 'auto'
    ? { kind: 'auto' } : { kind: 'locked', target: { providerId: session.meta.providerId, model: decision.model } }, context)
}

export async function applySessionRoutingControl(
  session: Engine | undefined,
  requestedControl: unknown,
  context: SessionModelSwitchContext
): Promise<void> {
  if (!session) throw new Error('当前任务已关闭或不存在，请重新打开原任务。')
  const control = normalizeSessionRoutingControl(requestedControl, session.meta)
  const targetMeta = routingControlProjection(session.meta, control)
  const sourceRun = context.getRun()
  const validate = () => {
    if (!context.isCurrent(session) || context.getRun()?.id !== sourceRun?.id ||
        context.getRun()?.revision !== sourceRun?.revision) throw new Error('任务状态已变化，请重新选择路由。')
    assertSessionModelSwitchAllowed({ currentModel: session.meta.model,
      pendingPermissionCount: session.pendingPermissions().length, status: session.meta.status }, targetMeta.model)
    if ((sourceRun && !isTaskRunTerminal(sourceRun.status)) || runHasUnresolvedEffects(sourceRun) ||
        sourceRun?.toolExecutions?.some(item => item.status === 'unknown_outcome')) {
      throw new Error('请先暂停当前执行，并核对未决操作后切换路由。')
    }
  }
  validate()
  const previous = assertSessionModelChange(session.meta)
  if (digest(sessionRoutingControl(session.meta)) === digest(control) && previous?.state !== 'prepared') return
  if (previous?.state === 'prepared' && digest(sessionRoutingControl(previous.to)) !== digest(control)) {
    throw new Error('上次切换的保存状态尚未确认，请先重新选择同一模型或路由完成交接。')
  }
  if (previous?.state === 'prepared' && (previous.sourceRunId !== sourceRun?.id ||
      previous.sourcePolicyDigest !== sourceRun?.routingPolicy?.policyDigest ||
      ![previous.from.providerId, previous.to.providerId].includes(session.meta.providerId))) {
    throw new Error('未完成的模型切换与当前运行不一致，请恢复原任务记录。')
  }
  await context.assertRecoveryAllowed()
  validate()
  if (context.validateTarget) context.validateTarget(targetMeta)
  else validateSessionRoutingControl(targetMeta, session.meta)
  const handoff = previous?.state === 'prepared' ? previous.handoff
    : await (context.prepareHandoff ?? prepareSessionModelHandoff)(session.meta, sourceRun, context.rootDir)
  validate()
  await context.assertRecoveryAllowed()
  validate()
  const prepared = previous?.state === 'prepared' ? previous : sealSessionModelChange({
    schemaVersion: 1, id: randomUUID(), state: 'prepared', sessionId: session.meta.id,
    projectId: session.meta.workspaceId ?? session.meta.projectId, goalId: session.meta.goalId, workItemId: session.meta.workItemId,
    sourceRunId: sourceRun?.id, sourcePolicyDigest: sourceRun?.routingPolicy?.policyDigest,
    from: { providerId: session.meta.providerId, model: session.meta.model, routingScope: session.meta.routingScope ?? (session.meta.model === 'auto' ? 'provider' : 'fixed'),
      routingControl: structuredClone(sessionRoutingControl(session.meta)) },
    to: { providerId: targetMeta.providerId, model: targetMeta.model, routingScope: targetMeta.routingScope!, routingControl: structuredClone(control) },
    handoff, createdAt: Date.now()
  })
  session.meta.modelChange = prepared
  try {
    // No effective model/provider change precedes the durable prepared boundary.
    await context.persist()
    validate()
    await session.setModel(prepared.to.model, prepared.to.providerId)
    validate()
    if (session.meta.model !== prepared.to.model) throw new Error('执行器未采用已选择的模型，切换尚未完成。')
    Object.assign(session.meta, { providerId: prepared.to.providerId, routingScope: prepared.to.routingScope,
      routingControl: structuredClone(sessionRoutingControl(prepared.to)), modelRoutingDecision: undefined })
    session.meta.modelChange = sealSessionModelChange({ ...prepared, state: 'committed' })
    await context.persist()
    session.emitSyntheticEvent?.({ kind: 'hook-event', event: 'session-model-changed',
      detail: JSON.stringify({ changeId: prepared.id, sourceRunId: sourceRun?.id,
        fromModel: prepared.from.model, toModel: prepared.to.model, routingControl: prepared.to.routingControl,
        handoffDigest: handoff.digest, note: '用户明确选择后续路由；沿用目标、资料版本和既有权限，未发送新请求。' }) })
  } catch (error) {
    session.meta.modelChange = prepared
    // An uncertain durable write is resumed through the same prepared decision.
    throw error
  }
}
