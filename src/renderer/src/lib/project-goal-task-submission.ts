import type { ProjectGoalTaskPrepareInput, ProjectGoalTaskPrepared, ProjectGoalTaskStartInput, ProjectGoalTaskStarted } from '../../../shared/types'
import type { SessionInputRecord } from '../../../shared/session-input-types'

export type GoalPlanningTemplate = 'auto' | 'product-launch'
export interface ProjectGoalDraft {
  projectId: string
  objective: string
  template: GoalPlanningTemplate
  mode?: 'auto' | 'plan'
}
interface PendingGoal extends ProjectGoalDraft {
  requestId: string
  sessionId?: string
  sessionCreationClaimed?: boolean
}
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export interface ProjectGoalSubmissionHost {
  prepare(input: ProjectGoalTaskPrepareInput): Promise<ProjectGoalTaskPrepared>
  start?(input: ProjectGoalTaskStartInput): Promise<ProjectGoalTaskStarted>
}
export interface ProjectGoalSubmissionResult {
  sessionId: string
  requestId: string
  kind: 'plan' | 'direct'
  inputPhase?: SessionInputRecord['phase']
  message?: string
}
const STORAGE_KEY = 'caogen.project-goal-submissions.v1'
const inFlight = new WeakMap<DraftStorage, Map<string, Promise<ProjectGoalSubmissionResult>>>()

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
    async submit(draft: ProjectGoalDraft): Promise<ProjectGoalSubmissionResult> {
      const input = { ...draft, mode: draft.mode ?? 'auto', objective: draft.objective.trim() }
      if (!input.projectId || !input.objective || input.objective.length > 20_000 ||
          !['auto', 'product-launch'].includes(input.template) || !['auto', 'plan'].includes(input.mode)) throw new Error('请填写有效的任务目标。')
      const records = read()
      const pending = records.find((item) => item.projectId === input.projectId &&
        item.objective === input.objective && item.template === input.template) ?? {
        ...input, requestId: globalThis.crypto.randomUUID()
      }
      if (pending.mode !== undefined && pending.mode !== input.mode) {
        throw new Error('上次提交已固定开始方式，请先继续原任务；不能在重试时改换为自动执行或计划。')
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

  async function run(pending: PendingGoal): Promise<ProjectGoalSubmissionResult> {
    const request = {
      requestId: pending.requestId, projectId: pending.projectId, objective: pending.objective, template: pending.template,
      legacySessionId: pending.sessionId, legacyCreationClaimed: pending.sessionCreationClaimed
    }
    // An older pending preparation never becomes an execution request on reload.
    const result = host.start && pending.mode !== undefined
      ? await host.start({ ...request, mode: pending.mode })
      : { ...await host.prepare(request), kind: 'plan' as const }
    if (result.requestId !== pending.requestId || result.goal.projectId !== pending.projectId ||
        result.workItem.projectId !== pending.projectId || result.workItem.goalId !== result.goal.id) {
      throw new Error('任务回执与原提交身份不一致，已停止创建会话。')
    }
    const { sessionId } = result
    if (!sessionId || (pending.sessionId && pending.sessionId !== sessionId)) {
      throw new Error('任务会话回执无效，原提交身份已保留。')
    }
    if (result.kind === 'direct') {
      const receipt = result.input
      if (result.decision.kind !== 'direct' || result.decision.taskStrategy !== 'view' || result.decision.mode !== 'auto' ||
          receipt.sessionId !== sessionId || receipt.workspaceId !== pending.projectId ||
          receipt.goalId !== result.goal.id || receipt.workItemId !== result.workItem.id ||
          receipt.messageId !== `session-input:${sessionId}:${receipt.id}` || !receipt.id.startsWith('goal-start-') ||
          receipt.payload.text !== pending.objective ||
          !['queued', 'dispatching', 'applied', 'needs_reconciliation', 'cancelled'].includes(receipt.phase)) {
        throw new Error('执行回执与原任务身份不一致，原提交身份已保留。')
      }
    } else {
      const binding = result.plan?.currentVersion?.binding
      if (!binding) throw new Error('任务会话回执无效，原提交身份已保留。')
      if (binding.sessionId !== sessionId || binding.workspaceId !== result.goal.projectId ||
          binding.goalId !== result.goal.id || binding.workItemId !== result.workItem.id) {
        throw new Error('计划与原任务身份不一致，已停止提交。')
      }
    }
    pending.sessionId = sessionId
    save(pending)
    return { sessionId, requestId: pending.requestId, kind: result.kind,
      ...(result.kind === 'direct' ? { inputPhase: result.input.phase, message: result.input.error } : {}) }
  }
}

function validPending(value: unknown): value is PendingGoal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.projectId === 'string' && Boolean(item.projectId) &&
    typeof item.objective === 'string' && Boolean(item.objective.trim()) && item.objective.length <= 20_000 &&
    typeof item.requestId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,199}$/.test(item.requestId) &&
    (item.template === 'auto' || item.template === 'product-launch') &&
    (item.mode === undefined || item.mode === 'auto' || item.mode === 'plan') &&
    (item.sessionId === undefined || (typeof item.sessionId === 'string' && Boolean(item.sessionId))) &&
    (item.sessionCreationClaimed === undefined || typeof item.sessionCreationClaimed === 'boolean')
}
