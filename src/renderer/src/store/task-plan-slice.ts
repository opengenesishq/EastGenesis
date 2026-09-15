import type {
  TaskPlanApprovalInput,
  TaskPlanDispatchResult,
  TaskPlanDraftInput,
  TaskPlanGenerateInput,
  TaskPlanMissionCompileInput,
  TaskPlanStateView,
  TaskStrategy
} from '../../../shared/types'

export interface TaskPlanSlice {
  taskPlans: Record<string, TaskPlanStateView | undefined>
  taskPlanBusy: Record<string, boolean | undefined>
  taskPlanErrors: Record<string, string | undefined>
  refreshTaskPlan(sessionId: string): Promise<TaskPlanStateView | undefined>
  generateTaskPlan(sessionId: string, input: TaskPlanGenerateInput): Promise<TaskPlanStateView | undefined>
  compileMissionTaskPlan(sessionId: string, input: TaskPlanMissionCompileInput): Promise<TaskPlanStateView | undefined>
  createTaskPlanVersion(sessionId: string, draft: TaskPlanDraftInput): Promise<TaskPlanStateView | undefined>
  approveTaskPlan(sessionId: string, input: TaskPlanApprovalInput): Promise<TaskPlanStateView | undefined>
  dispatchApprovedTaskPlan(sessionId: string, input: TaskPlanApprovalInput): Promise<TaskPlanDispatchResult | undefined>
  revokeTaskPlanApproval(sessionId: string, input: TaskPlanApprovalInput): Promise<TaskPlanStateView | undefined>
  setTaskStrategy(strategy: TaskStrategy): Promise<void>
  setTaskPlanError(sessionId: string, error?: string): void
}

type TaskPlanSliceUpdate = Partial<Pick<TaskPlanSlice, 'taskPlans' | 'taskPlanBusy' | 'taskPlanErrors'>>
type TaskPlanSliceSet = (
  update: TaskPlanSliceUpdate | ((state: TaskPlanSlice) => TaskPlanSliceUpdate)
) => void

interface TaskPlanSliceContext extends TaskPlanSlice {
  activeId: string | null
}

export function createTaskPlanSlice(
  set: TaskPlanSliceSet,
  get: () => TaskPlanSliceContext
): TaskPlanSlice {
  const run = async (
    sessionId: string,
    operation: () => Promise<TaskPlanStateView>
  ): Promise<TaskPlanStateView | undefined> => {
    set((state) => ({
      taskPlanBusy: { ...state.taskPlanBusy, [sessionId]: true },
      taskPlanErrors: { ...state.taskPlanErrors, [sessionId]: undefined }
    }))
    try {
      const plan = await operation()
      set((state) => ({
        taskPlans: { ...state.taskPlans, [sessionId]: plan },
        taskPlanBusy: { ...state.taskPlanBusy, [sessionId]: false }
      }))
      return plan
    } catch (error) {
      set((state) => ({
        taskPlanBusy: { ...state.taskPlanBusy, [sessionId]: false },
        taskPlanErrors: { ...state.taskPlanErrors, [sessionId]: errorMessage(error) }
      }))
      return undefined
    }
  }

  return {
    taskPlans: {},
    taskPlanBusy: {},
    taskPlanErrors: {},
    refreshTaskPlan: (sessionId) => run(sessionId, () => window.agentDesk.getTaskPlan(sessionId)),
    generateTaskPlan: (sessionId, input) =>
      run(sessionId, () => window.agentDesk.generateTaskPlan(sessionId, input)),
    compileMissionTaskPlan: (sessionId, input) =>
      run(sessionId, () => window.agentDesk.compileMissionTaskPlan(sessionId, input)),
    createTaskPlanVersion: (sessionId, draft) =>
      run(sessionId, () => window.agentDesk.createTaskPlanVersion(sessionId, draft)),
    approveTaskPlan: (sessionId, input) =>
      run(sessionId, () => window.agentDesk.approveTaskPlan(sessionId, input)),
    async dispatchApprovedTaskPlan(sessionId, input) {
      set((state) => ({
        taskPlanBusy: { ...state.taskPlanBusy, [sessionId]: true },
        taskPlanErrors: { ...state.taskPlanErrors, [sessionId]: undefined }
      }))
      try {
        const result = await window.agentDesk.dispatchApprovedTaskPlan(sessionId, input)
        set((state) => ({ taskPlanBusy: { ...state.taskPlanBusy, [sessionId]: false } }))
        return result
      } catch (error) {
        set((state) => ({
          taskPlanBusy: { ...state.taskPlanBusy, [sessionId]: false },
          taskPlanErrors: { ...state.taskPlanErrors, [sessionId]: errorMessage(error) }
        }))
        return undefined
      }
    },
    revokeTaskPlanApproval: (sessionId, input) =>
      run(sessionId, () => window.agentDesk.revokeTaskPlanApproval(sessionId, input)),
    async setTaskStrategy(strategy) {
      const sessionId = get().activeId
      if (!sessionId) return
      try {
        await window.agentDesk.setTaskStrategy(sessionId, strategy)
        get().setTaskPlanError(sessionId, undefined)
      } catch (error) {
        get().setTaskPlanError(sessionId, errorMessage(error))
        throw error
      }
    },
    setTaskPlanError(sessionId, error) {
      set((state) => ({ taskPlanErrors: { ...state.taskPlanErrors, [sessionId]: error } }))
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
