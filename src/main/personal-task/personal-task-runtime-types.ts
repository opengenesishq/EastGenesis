import type { CreateSessionOptions, SendMessagePayload, SessionMeta, TaskPlanDraftInput, TaskPlanStateView, TaskRunRecord } from '../../shared/types'
import type { ManagedSessionCreationOptions } from '../session-manager-support'

/** Only main-process coordinators receive the reserved identity and persistence barrier. */
export interface PersonalTaskRuntime {
  whenInitialized(): Promise<void>
  get(sessionId: string): { meta: SessionMeta } | undefined
  createManaged(options: CreateSessionOptions, lifecycle: ManagedSessionCreationOptions): Promise<SessionMeta>
  send(sessionId: string, payload: SendMessagePayload): Promise<boolean>
  persistTaskRunLifecycleBarrier(sessionId: string): Promise<TaskRunRecord | undefined>
  getTaskPlan(sessionId: string): TaskPlanStateView
  createTaskPlanVersion(sessionId: string, draft: TaskPlanDraftInput): Promise<TaskPlanStateView>
}
