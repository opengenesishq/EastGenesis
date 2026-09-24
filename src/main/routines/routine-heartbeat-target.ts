import type { RoutineSessionTarget } from '../../shared/routine-heartbeat-types'
import type { SessionMeta } from '../../shared/types'

function text(value: unknown, required = false): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error('定时继续的任务身份或目录无效。')
  return value
}

export function normalizeRoutineSessionTarget(raw: unknown): RoutineSessionTarget | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('定时继续的任务绑定无效。')
  const value = raw as Record<string, unknown>
  if (value.kind !== 'existing_session' || typeof value.sessionCreatedAt !== 'number' || !Number.isFinite(value.sessionCreatedAt)) {
    throw new Error('定时继续必须绑定主进程核实过的原任务。')
  }
  return { kind: 'existing_session', sessionId: text(value.sessionId, true)!, sessionCreatedAt: value.sessionCreatedAt,
    cwd: text(value.cwd, true)!, workspaceId: text(value.workspaceId), goalId: text(value.goalId),
    workItemId: text(value.workItemId), legacyProjectId: text(value.legacyProjectId) }
}

export function captureRoutineSessionTarget(meta: SessionMeta | undefined): RoutineSessionTarget {
  if (!meta || meta.status === 'closed') throw new Error('原任务已关闭或不存在，请先恢复原任务。')
  return normalizeRoutineSessionTarget({ kind: 'existing_session', sessionId: meta.id, sessionCreatedAt: meta.createdAt,
    cwd: meta.cwd, workspaceId: meta.workspaceId, goalId: meta.goalId, workItemId: meta.workItemId, legacyProjectId: meta.projectId })!
}

export function assertRoutineSessionTarget(target: RoutineSessionTarget, meta: SessionMeta | undefined): asserts meta is SessionMeta {
  const current = captureRoutineSessionTarget(meta)
  for (const key of ['sessionId', 'sessionCreatedAt', 'cwd', 'workspaceId', 'goalId', 'workItemId', 'legacyProjectId'] as const) {
    if (current[key] !== target[key]) throw new Error('原任务的目录或归属已变化，定时继续已暂停；请编辑计划重新绑定。')
  }
}

export function sameRoutineSessionTarget(left: RoutineSessionTarget | undefined, right: RoutineSessionTarget | undefined): boolean {
  return Boolean(left && right && (['sessionId', 'sessionCreatedAt', 'cwd', 'workspaceId', 'goalId', 'workItemId', 'legacyProjectId'] as const)
    .every((key) => left[key] === right[key]))
}
