import type { SessionMeta, TaskRunRecord } from '../shared/types'
import type { SessionModelChange } from '../shared/session-model-change-types'
import { digest } from './task/workflow-ledger-canonical'
import { assertSessionModelHandoff } from './agent/session-model-handoff'
import { normalizeSessionRoutingControl } from '../shared/session-routing-control'
import { sessionRoutingControl } from '../shared/session-routing-control-types'
import { frozenRoutingPolicyForRun } from './task/frozen-routing-policy'

export function sealSessionModelChange(input: Omit<SessionModelChange, 'digest'> & { digest?: string }): SessionModelChange {
  const { digest: _previous, ...body } = structuredClone(input)
  return { ...body, digest: digest(body) }
}

export function assertSessionModelChange(meta: SessionMeta): SessionModelChange | undefined {
  const record = meta.modelChange
  if (!record) return undefined
  const { digest: saved, ...body } = record
  if (record.schemaVersion !== 1 || !record.id || !['prepared', 'committed'].includes(record.state) ||
      record.sessionId !== meta.id || record.projectId !== (meta.workspaceId ?? meta.projectId) ||
      record.goalId !== meta.goalId || record.workItemId !== meta.workItemId ||
      !record.from?.providerId || !record.to?.providerId || !record.to.model ||
      !['fixed', 'provider', 'global'].includes(record.to.routingScope) ||
      !Number.isFinite(record.createdAt) || saved !== digest(body)) {
    throw new Error('模型切换记录与当前任务不一致，请恢复原任务记录。')
  }
  for (const projection of [record.from, record.to]) {
    if (!projection.routingControl) continue
    const control = normalizeSessionRoutingControl(projection.routingControl, projection)
    if (digest(control) !== digest(projection.routingControl) ||
        (control.kind === 'locked' && (projection.model !== control.target.model || projection.providerId !== control.target.providerId || projection.routingScope !== 'fixed')) ||
        (control.kind === 'preferred' && (projection.model !== 'auto' || projection.routingScope !== 'global')) ||
        (control.kind === 'auto' && (projection.model !== 'auto' || (control.scope?.kind === 'provider'
          ? projection.routingScope !== 'provider' || projection.providerId !== control.scope.providerId : projection.routingScope !== 'global')))) {
      throw new Error('模型切换记录的路由控制与目标不一致，请恢复原任务记录。')
    }
  }
  assertSessionModelHandoff(record.handoff, meta)
  if (record.sourceRunId !== record.handoff.sourceRunId) {
    throw new Error('模型切换与交接的来源运行不一致，请恢复原任务记录。')
  }
  return record
}

export function assertSessionModelChangeReady(meta: SessionMeta): void {
  if (assertSessionModelChange(meta)?.state === 'prepared') {
    throw new Error('模型切换尚未确认保存，请重新选择同一模型完成切换后继续。')
  }
}

/** Terminal recovery snapshots may be pruned; their canonical Runs remain. */
export function restoreModelChangeSourceRun(meta: SessionMeta, persisted: TaskRunRecord[]): TaskRunRecord | undefined {
  const record = assertSessionModelChange(meta)
  if (record?.state !== 'prepared' || !record.sourceRunId) return undefined
  const run = persisted.find(item => item.id === record.sourceRunId)
  const policy = run && frozenRoutingPolicyForRun(run)
  if (!run || run.sessionId !== meta.id || run.taskId !== (meta.childTaskId ?? meta.id) ||
      policy?.policyDigest !== record.sourcePolicyDigest ||
      (policy && (policy.owner.projectId !== (meta.workspaceId ?? meta.projectId) ||
        policy.owner.goalId !== meta.goalId || policy.owner.workItemId !== meta.workItemId)) ||
      persisted.some(item => item.sessionId === meta.id && item.id !== run.id && item.createdAt >= run.createdAt)) {
    throw new Error('未完成模型切换的来源运行缺失或已被后续运行替代，请从恢复中心核对。')
  }
  return structuredClone(run)
}

/** Only the next Run following this explicit decision can replace the old frozen route. */
export function hasExplicitModelChange(meta: SessionMeta, previousRun: TaskRunRecord | undefined): boolean {
  const record = assertSessionModelChange(meta)
  if (!record) return false
  assertSessionModelChangeReady(meta)
  if (record.sourceRunId !== previousRun?.id) return false
  if (record.sourcePolicyDigest !== previousRun?.routingPolicy?.policyDigest ||
      record.to.model !== meta.model || record.to.providerId !== meta.providerId || record.to.routingScope !== meta.routingScope ||
      digest(sessionRoutingControl(record.to)) !== digest(sessionRoutingControl(meta))) {
    throw new Error('明确选择的模型与当前运行交接不一致，已阻止沿用或替换路由。')
  }
  return true
}
