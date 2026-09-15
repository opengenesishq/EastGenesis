import type { TaskPlanApprovalInput, TaskPlanDraftInput, TaskPlanGenerateInput, TaskPlanMissionCompileInput } from '../../shared/types'
import { sessionManager } from '../sessionManager'

type TaskPlanAction = 'strategy' | 'get' | 'generate' | 'compile-mission' | 'create-version' | 'approve' | 'dispatch' | 'revoke'

export function handleTaskPlanIpc(event: unknown, action: unknown, rawSessionId: unknown, payload: unknown) {
  if (!isTaskPlanAction(action)) throw new Error('任务计划操作无效')
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId : ''
  if (action === 'strategy') return sessionManager.setTaskStrategy(sessionId, payload)
  if (action === 'get') return sessionManager.getTaskPlan(sessionId)
  if (action === 'generate') {
    return sessionManager.generateTaskPlan(sessionId, payload as TaskPlanGenerateInput)
  }
  if (action === 'compile-mission') {
    return sessionManager.compileMissionTaskPlan(sessionId, payload as TaskPlanMissionCompileInput)
  }
  if (action === 'create-version') {
    return sessionManager.createTaskPlanVersion(sessionId, payload as TaskPlanDraftInput)
  }
  if (action === 'approve') {
    return sessionManager.approveTaskPlan(sessionId, payload as TaskPlanApprovalInput, trustedActorId(event))
  }
  if (action === 'dispatch') {
    return sessionManager.dispatchApprovedTaskPlan(sessionId, payload as TaskPlanApprovalInput)
  }
  return sessionManager.revokeTaskPlanApproval(sessionId, payload as TaskPlanApprovalInput, trustedActorId(event))
}

function trustedActorId(event: unknown): string {
  if (!event || typeof event !== 'object' || !('sender' in event)) {
    throw new Error('计划审批主体身份不可用')
  }
  const sender = (event as { sender?: { id?: unknown } }).sender
  if (!sender || !Number.isSafeInteger(sender.id) || Number(sender.id) <= 0) {
    throw new Error('计划审批主体身份不可用')
  }
  return `local-user:webcontents-${sender.id}`
}

function isTaskPlanAction(value: unknown): value is TaskPlanAction {
  return value === 'strategy' || value === 'get' || value === 'generate' || value === 'compile-mission' || value === 'create-version' ||
    value === 'approve' || value === 'dispatch' || value === 'revoke'
}
