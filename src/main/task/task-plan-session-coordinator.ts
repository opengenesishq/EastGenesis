import type { Engine } from '../engine'
import type {
  SessionMeta,
  TaskPlanApprovalInput,
  TaskPlanDraftInput,
  TaskPlanStateView,
  TaskPlanVersion
} from '../../shared/types'
import { requireExecuteTaskStrategy, requireTaskStrategy } from './task-strategy'
import { assertBusinessLineTaskStrategy } from '../business-line-execution-policy'
import { TaskPlanContractStore } from './task-plan-contract-store'
import { TaskPlanCanonicalProjector } from './task-plan-canonical-projection'
import { reconcileTaskPlanLedger, syncTaskPlanLedger } from './task-plan-ledger'

export class TaskPlanSessionCoordinator {
  private readonly store: TaskPlanContractStore
  private readonly projector: TaskPlanCanonicalProjector
  private readonly approvalsInFlight = new Set<string>()

  constructor(
    private readonly findSession: (id: string) => Engine | undefined,
    private readonly userDataRoot: () => string
  ) {
    this.store = new TaskPlanContractStore(userDataRoot)
    this.projector = new TaskPlanCanonicalProjector(userDataRoot)
  }

  async setStrategy(id: string, value: unknown): Promise<void> {
    const session = this.requireSession(id)
    const strategy = requireTaskStrategy(value)
    assertBusinessLineTaskStrategy(session.meta, strategy)
    if (session.meta.taskStrategy === strategy) return
    this.assertIdle(session.meta, '切换任务策略')
    if (strategy === 'execute') {
      this.store.assertExecutionAuthorized(id, session.meta.taskStrategy === 'plan')
    }
    await session.setTaskStrategy(strategy)
  }

  async reconcileLedger(): Promise<void> {
    await reconcileTaskPlanLedger(this.userDataRoot(), this.store.listAll())
  }

  get(id: string): TaskPlanStateView {
    this.requireSession(id)
    return this.store.get(id)
  }

  async createManualVersion(id: string, draft: TaskPlanDraftInput): Promise<TaskPlanStateView> {
    this.assertApprovalIdle(id)
    const session = this.requireSession(id)
    this.assertIdle(session.meta, '修改计划')
    if (session.meta.taskStrategy !== 'plan') throw new Error('请先切换到规划，再创建计划版本。')
    const next = this.store.createVersion(binding(session.meta), { ...draft, source: 'manual' }, 'local-user')
    await syncTaskPlanLedger(this.userDataRoot(), next)
    return next
  }

  async createAgentVersion(id: string, draft: TaskPlanDraftInput): Promise<TaskPlanStateView> {
    this.assertApprovalIdle(id)
    const session = this.requireSession(id)
    if (session.meta.taskStrategy !== 'plan') throw new Error('Genesis 只能在规划策略中生成计划版本。')
    const current = this.store.get(id).currentVersion
    const next = this.store.createVersion(binding(session.meta), {
      ...draft,
      changeReason: current ? (draft.changeReason?.trim() || 'Genesis 重新生成结构化计划') : draft.changeReason,
      source: 'genesis'
    }, 'agent')
    await syncTaskPlanLedger(this.userDataRoot(), next)
    return next
  }

  async createGeneratedVersion(id: string, draft: TaskPlanDraftInput): Promise<TaskPlanStateView> {
    this.assertApprovalIdle(id)
    const session = this.requireSession(id)
    this.assertIdle(session.meta, '生成计划')
    if (session.meta.taskStrategy !== 'plan') throw new Error('只能在规划策略中生成工作流草案。')
    const state = this.store.get(id)
    if (state.currentVersion) {
      if (state.currentVersion.objective !== draft.objective.trim()) {
        throw new Error('当前会话已有另一个目标的计划，已阻止覆盖')
      }
      await syncTaskPlanLedger(this.userDataRoot(), state)
      return state
    }
    const next = this.store.createVersion(binding(session.meta), { ...draft, source: 'genesis' }, 'agent')
    await syncTaskPlanLedger(this.userDataRoot(), next)
    return next
  }

  requireApprovedVersion(
    id: string,
    input: TaskPlanApprovalInput
  ): { version: TaskPlanVersion; projection: TaskPlanStateView['projection'] } {
    const session = this.requireSession(id)
    this.assertIdle(session.meta, '执行计划')
    const state = this.store.get(id)
    const current = state.currentVersion
    if (!current || current.version !== input.version || current.digest !== input.digest) {
      throw new Error('计划执行目标已变化，请重新审查当前版本')
    }
    if (state.approvalStatus !== 'approved' || state.approvedVersion !== input.version ||
      state.approvedDigest !== input.digest) {
      throw new Error(`计划 v${input.version} 尚未批准或已被后续版本取代`)
    }
    return { version: current, projection: state.projection }
  }

  async approve(id: string, input: TaskPlanApprovalInput, actorId = 'local-user'): Promise<TaskPlanStateView> {
    const session = this.requireSession(id)
    this.assertIdle(session.meta, '审批计划')
    this.assertApprovalIdle(id)
    this.approvalsInFlight.add(id)
    try {
      const state = this.store.get(id)
      const current = state.currentVersion
      if (!current) throw new Error('当前会话还没有可审批的计划版本')
      if (current.version !== input.version || current.digest !== input.digest) {
        throw new Error('计划审批目标已变化，请刷新后重试')
      }
      const previousApproval = [...state.approvalEvents].reverse().find((event) => event.kind === 'approved')
      const reusePreviousReceipt = previousApproval?.version === current.version &&
        previousApproval.digest === current.digest
      const projection = await this.projector.project(
        current,
        previousApproval?.projection,
        reusePreviousReceipt
      )
      const next = this.store.approve(id, input, projection, actorId)
      await syncTaskPlanLedger(this.userDataRoot(), next)
      return next
    } finally {
      this.approvalsInFlight.delete(id)
    }
  }

  async revoke(id: string, input: TaskPlanApprovalInput, actorId = 'local-user'): Promise<TaskPlanStateView> {
    const session = this.requireSession(id)
    this.assertIdle(session.meta, '撤销计划审批')
    const next = this.store.revoke(id, input, actorId)
    await syncTaskPlanLedger(this.userDataRoot(), next)
    return next
  }

  assertInteractiveExecution(id: string, action: string): void {
    this.assertExecution(this.requireSession(id).meta, action)
  }

  assertExecution(meta: SessionMeta, action: string): void {
    requireExecuteTaskStrategy(meta, action)
    this.store.assertExecutionAuthorized(this.executionAuthoritySessionId(meta), false)
  }

  authorizeSend(session: Engine): boolean {
    if (session.meta.taskStrategy !== 'execute') return true
    try {
      this.store.assertExecutionAuthorized(this.executionAuthoritySessionId(session.meta), false)
      return true
    } catch (error) {
      session.meta.lastError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  private executionAuthoritySessionId(meta: SessionMeta): string {
    const visited = new Set<string>()
    let current = meta
    while (true) {
      if (visited.has(current.id)) throw new Error('任务计划父会话链形成循环，已阻止执行')
      visited.add(current.id)
      if (this.store.get(current.id).currentVersion) return current.id
      if (!current.parentSessionId) return current.id
      const parent = this.findSession(current.parentSessionId)
      if (!parent) throw new Error('任务计划父会话不可用，已阻止子任务执行')
      current = parent.meta
    }
  }

  private requireSession(id: string): Engine {
    const session = this.findSession(id)
    if (!session) throw new Error('会话不存在')
    return session
  }

  private assertIdle(meta: SessionMeta, action: string): void {
    if (meta.status === 'running' || meta.status === 'starting') {
      throw new Error(`任务正在运行，已阻止${action}；请先等待完成或中断任务。`)
    }
  }

  private assertApprovalIdle(id: string): void {
    if (this.approvalsInFlight.has(id)) throw new Error('计划审批正在投影 WorkItem，请稍后重试')
  }
}

function binding(meta: SessionMeta) {
  return {
    sessionId: meta.id,
    workspaceId: meta.workspaceId,
    goalId: meta.goalId,
    workItemId: meta.workItemId
  }
}
