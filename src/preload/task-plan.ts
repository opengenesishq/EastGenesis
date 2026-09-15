import type {
  TaskPlanApi,
  TaskPlanApprovalInput,
  TaskPlanDraftInput,
  TaskPlanGenerateInput,
  TaskPlanMissionCompileInput,
  TaskStrategy
} from '../shared/types'
import { invokeAppFeature } from './app-feature'

function invoke<T>(action: string, sessionId: string, payload?: unknown): Promise<T> {
  return invokeAppFeature('task-plan', action, sessionId, payload)
}

export const taskPlanApi: TaskPlanApi = {
  setTaskStrategy: (sessionId: string, strategy: TaskStrategy) =>
    invoke('strategy', sessionId, strategy),
  getTaskPlan: (sessionId: string) => invoke('get', sessionId),
  generateTaskPlan: (sessionId: string, input: TaskPlanGenerateInput) =>
    invoke('generate', sessionId, input),
  compileMissionTaskPlan: (sessionId: string, input: TaskPlanMissionCompileInput) =>
    invoke('compile-mission', sessionId, input),
  createTaskPlanVersion: (sessionId: string, draft: TaskPlanDraftInput) =>
    invoke('create-version', sessionId, draft),
  approveTaskPlan: (sessionId: string, input: TaskPlanApprovalInput) =>
    invoke('approve', sessionId, input),
  dispatchApprovedTaskPlan: (sessionId: string, input: TaskPlanApprovalInput) =>
    invoke('dispatch', sessionId, input),
  revokeTaskPlanApproval: (sessionId: string, input: TaskPlanApprovalInput) =>
    invoke('revoke', sessionId, input)
}
