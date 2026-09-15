import type { ProjectGoalTaskInput, ProjectGoalTaskResult, SessionMeta, TaskPlanStateView } from '../../../shared/types'

export type GoalPlanningTemplate = 'auto' | 'product-launch'
export interface ProjectGoalDraft {
  projectId: string
  objective: string
  template: GoalPlanningTemplate
}
interface PendingGoal extends ProjectGoalDraft {
  requestId: string
  sessionId?: string
  sessionCreationClaimed?: boolean
}
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export interface ProjectGoalSubmissionHost {
  createGoal(input: ProjectGoalTaskInput): Promise<ProjectGoalTaskResult>
  listSessions(): Promise<SessionMeta[]>
  createSession(result: ProjectGoalTaskResult): Promise<string>
  getPlan(sessionId: string): Promise<TaskPlanStateView | undefined>
  generatePlan(sessionId: string, goal: ProjectGoalTaskResult, template: GoalPlanningTemplate): Promise<TaskPlanStateView | undefined>
}
const STORAGE_KEY = 'caogen.project-goal-submissions.v1'
const inFlight = new WeakMap<DraftStorage, Map<string, Promise<{ sessionId: string; requestId: string }>>>()

/** A submission journal only. Goal, WorkItem, Session and plan stay in the canonical services. */
export function createProjectGoalSubmissionClient(storage: DraftStorage, host: ProjectGoalSubmissionHost) {
  const read = (): PendingGoal[] => {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return []
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new Error('任务提交记录无法读取，请先恢复原任务，已阻止重复创建。') }
    if (!Array.isArray(parsed) || !parsed.every(validPending)) throw new Error('任务提交记录无效，请先恢复原任务。')
    return parsed
  }
  const save = (pending: PendingGoal): void => {
    const records = read().filter((item) => item.requestId !== pending.requestId)
    records.push(pending)
    // Fail before any IPC if the identity cannot be durably saved.
    storage.setItem(STORAGE_KEY, JSON.stringify(records))
  }
  return {
    async submit(draft: ProjectGoalDraft): Promise<{ sessionId: string; requestId: string }> {
      const input = { ...draft, objective: draft.objective.trim() }
      if (!input.projectId || !input.objective || input.objective.length > 20_000 ||
          !['auto', 'product-launch'].includes(input.template)) throw new Error('请填写有效的任务目标。')
      const records = read()
      const pending = records.find((item) => item.projectId === input.projectId &&
        item.objective === input.objective && item.template === input.template) ?? {
        ...input, requestId: globalThis.crypto.randomUUID()
      }
      let calls = inFlight.get(storage)
      if (!calls) { calls = new Map(); inFlight.set(storage, calls) }
      const active = calls.get(pending.requestId)
      if (active) return active
      save(pending)
      const operation = run(pending).finally(() => calls!.delete(pending.requestId))
      calls.set(pending.requestId, operation)
      return operation
    },
    acknowledge(requestId: string): void {
      const remaining = read().filter((item) => item.requestId !== requestId)
      if (remaining.length) storage.setItem(STORAGE_KEY, JSON.stringify(remaining))
      else storage.removeItem(STORAGE_KEY)
    }
  }

  async function run(pending: PendingGoal): Promise<{ sessionId: string; requestId: string }> {
    const result = await host.createGoal({ requestId: pending.requestId, projectId: pending.projectId, objective: pending.objective })
    if (result.requestId !== pending.requestId || result.goal.projectId !== pending.projectId ||
        result.workItem.projectId !== pending.projectId || result.workItem.goalId !== result.goal.id) {
      throw new Error('任务回执与原提交身份不一致，已停止创建会话。')
    }
    const sessions = await host.listSessions()
    const matches = sessions.filter((session) => session.workspaceId === result.goal.projectId &&
      session.goalId === result.goal.id && session.workItemId === result.workItem.id && !session.parentSessionId)
    if (matches.length > 1) throw new Error('该任务存在多个会话，请从原任务选择要继续的会话。')
    let sessionId = pending.sessionId ?? matches[0]?.id
    if (sessionId && !matches.some((session) => session.id === sessionId)) {
      throw new Error('原任务会话暂不可用，请先从历史恢复；提交记录已保留。')
    }
    if (!sessionId) {
      if (pending.sessionCreationClaimed) throw new Error('原会话创建结果尚未核实，请先从任务历史恢复，已阻止重复创建。')
      pending.sessionCreationClaimed = true
      save(pending)
      sessionId = await host.createSession(result)
    }
    pending.sessionId = sessionId
    save(pending)
    const existing = await host.getPlan(sessionId)
    const plan = existing?.currentVersion ? existing : await host.generatePlan(sessionId, result, pending.template)
    if (!plan?.currentVersion) throw new Error('计划尚未生成，目标、输入与会话已保留；连接模型后可重试原提交。')
    const binding = plan.currentVersion.binding
    if (binding.sessionId !== sessionId || binding.workspaceId !== result.goal.projectId ||
        binding.goalId !== result.goal.id || binding.workItemId !== result.workItem.id) {
      throw new Error('计划与原任务身份不一致，已停止提交。')
    }
    return { sessionId, requestId: pending.requestId }
  }
}

function validPending(value: unknown): value is PendingGoal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.projectId === 'string' && Boolean(item.projectId) &&
    typeof item.objective === 'string' && Boolean(item.objective.trim()) && item.objective.length <= 20_000 &&
    typeof item.requestId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,199}$/.test(item.requestId) &&
    (item.template === 'auto' || item.template === 'product-launch') &&
    (item.sessionId === undefined || (typeof item.sessionId === 'string' && Boolean(item.sessionId))) &&
    (item.sessionCreationClaimed === undefined || typeof item.sessionCreationClaimed === 'boolean')
}
