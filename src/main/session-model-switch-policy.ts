import type { SessionStatus } from '../shared/types'

export type SessionModelSwitchBlockReason = 'active-run' | 'pending-permission' | 'closed-session'

export interface SessionModelSwitchState {
  currentModel: string
  pendingPermissionCount: number
  status: SessionStatus
}

export interface SessionModelSwitchDecision {
  allowed: boolean
  changed: boolean
  model: string
  reason?: SessionModelSwitchBlockReason
  message?: string
}

export class SessionModelSwitchPolicyError extends Error {
  readonly code = 'SESSION_MODEL_SWITCH_BLOCKED'

  constructor(readonly decision: SessionModelSwitchDecision) {
    super(decision.message ?? '当前会话不允许切换模型')
    this.name = 'SessionModelSwitchPolicyError'
  }
}

export function evaluateSessionModelSwitch(
  state: SessionModelSwitchState,
  requestedModel: unknown
): SessionModelSwitchDecision {
  const model = normalizeRequestedModel(requestedModel)
  if (state.status === 'starting' || state.status === 'running') {
    return blocked(model, 'active-run', '任务正在运行，已阻止切换模型；请先等待完成或中断任务。')
  }
  if (state.pendingPermissionCount > 0) {
    return blocked(model, 'pending-permission', '当前任务仍在等待权限处理，已阻止切换模型。')
  }
  if (state.status === 'closed') {
    return blocked(model, 'closed-session', '会话已关闭，无法切换模型。')
  }
  return { allowed: true, changed: model !== state.currentModel, model }
}

export function assertSessionModelSwitchAllowed(
  state: SessionModelSwitchState,
  requestedModel: unknown
): SessionModelSwitchDecision {
  const decision = evaluateSessionModelSwitch(state, requestedModel)
  if (!decision.allowed) throw new SessionModelSwitchPolicyError(decision)
  return decision
}

function normalizeRequestedModel(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('模型必须是字符串')
  const model = value.trim()
  if (!model || model.length > 240 || /[\u0000-\u001f\u007f]/.test(model)) throw new TypeError('请选择有效模型')
  return model
}

function blocked(
  model: string,
  reason: SessionModelSwitchBlockReason,
  message: string
): SessionModelSwitchDecision {
  return { allowed: false, changed: false, model, reason, message }
}
