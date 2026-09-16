import type { Engine } from '../engine'
import type {
  SessionMeta,
  TaskPlanApprovalInput,
  TaskPlanDraftInput,
  TaskPlanMissionCompileInput,
  TaskPlanStateView,
  TaskPlanVersion
} from '../../shared/types'
import { requireExecuteTaskStrategy, requireTaskStrategy } from './task-strategy'
import { assertBusinessLineTaskStrategy } from '../business-line-execution-policy'
import { TaskPlanContractStore } from './task-plan-contract-store'
import { TaskPlanCanonicalProjector } from './task-plan-canonical-projection'
import { reconcileTaskPlanLedger, syncTaskPlanLedger } from './task-plan-ledger'
import { buildCanonicalMissionTaskPlan, enrichCanonicalTaskPlanInstitutions } from './mission-task-plan'
import { readGoalInstitutionContext } from '../project-workspace/institution-goal-binding'
import { bindTaskPlanInstitutions } from './task-plan-institutions'
import { assertTaskPlanRequirementsCurrent, requirementContinuationDraft } from './task-plan-requirements'

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
    this.assertApprovalIdle(id)
    const session = this.requireSession(id)
    const strategy = requireTaskStrategy(value)
    assertBusinessLineTaskStrategy(session.meta, strategy)
    if (session.meta.taskStrategy === strategy) {
      if (strategy === 'execute') await this.assertExecution(session.meta, '继续执行')
      return
    }
    this.assertIdle(session.meta, '切换任务策略')
    if (strategy === 'execute') {
      await this.assertPlanExecutionCurrent(session.meta, session.meta.taskStrategy === 'plan')
      this.assertIdle(session.meta, '切换任务策略')
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
    return this.persistEnrichedVersion(id, session, {
      ...draft, source: 'manual', missionSource: this.store.get(id).currentVersion?.missionSource,
      requirementSource: this.store.get(id).currentVersion?.requirementSource
    }, 'local-user', true)
  }

  async createAgentVersion(id: string, draft: TaskPlanDraftInput): Promise<TaskPlanStateView> {
    this.assertApprovalIdle(id)
    const session = this.requireSession(id)
    if (session.meta.taskStrategy !== 'plan') throw new Error('Genesis 只能在规划策略中生成计划版本。')
    const current = this.store.get(id).currentVersion
    return this.persistEnrichedVersion(id, session, {
      ...draft,
      changeReason: current ? (draft.changeReason?.trim() || 'Genesis 重新生成结构化计划') : draft.changeReason,
      source: 'genesis',
      missionSource: current?.missionSource,
      requirementSource: current?.requirementSource
    }, 'agent', false)
  }

  async refreshRequirements(id: string, expectedGoalRevision: number): Promise<TaskPlanStateView> {
    this.assertApprovalIdle(id)
    const session = this.requireSession(id)
    this.assertIdle(session.meta, '更新要求计划')
    const draft = await requirementContinuationDraft(session.meta, expectedGoalRevision, this.userDataRoot())
    const current = this.store.get(id)
    if (current.currentVersion?.requirementSource?.eventId === draft.requirementSource?.eventId &&
        current.currentVersion?.requirementSource?.contractDigest === draft.requirementSource?.contractDigest) return current
    return this.persistEnrichedVersion(id, session, draft, 'local-user', true)
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
    return this.persistEnrichedVersion(id, session, { ...draft, source: 'genesis', missionSource: undefined }, 'agent', true)
  }

  private async persistEnrichedVersion(id: string, session: Engine, draft: TaskPlanDraftInput,
    actor: 'local-user' | 'agent', requireIdle: boolean): Promise<TaskPlanStateView> {
    this.approvalsInFlight.add(id)
    const originalBinding = binding(session.meta)
    try {
      const previous = this.store.get(id).currentVersion
      const enriched = previous && previous.institutionTemplate === undefined
        ? bindTaskPlanInstitutions(draft)
        : await enrichCanonicalTaskPlanInstitutions(session.meta, draft, this.userDataRoot())
      if (JSON.stringify(originalBinding) !== JSON.stringify(binding(session.meta))) throw new Error('计划所属任务在保存时变化')
      if (requireIdle) this.assertIdle(session.meta, '保存计划')
      if (session.meta.taskStrategy !== 'plan') throw new Error('保存计划前请保持规划策略')
      const next = this.store.createVersion(originalBinding, enriched, actor)
      await syncTaskPlanLedger(this.userDataRoot(), next)
      return next
    } finally { this.approvalsInFlight.delete(id) }
  }

  async compileMission(id: string, input: TaskPlanMissionCompileInput): Promise<TaskPlanStateView> {
    this.assertApprovalIdle(id)
    const session = this.requireSession(id)
    this.assertIdle(session.meta, '编译 Mission 计划')
    if (session.meta.taskStrategy !== 'plan') throw new Error('Mission 只能在规划策略中生成待确认计划')
    this.approvalsInFlight.add(id)
    try {
      const draft = await buildCanonicalMissionTaskPlan(session.meta, input, this.userDataRoot())
      const state = this.store.get(id)
      const current = state.currentVersion
      if (current && !current.missionSource) throw new Error('当前会话已有其他计划，请保留该计划或创建新的规划会话')
      if (current?.missionSource?.inputDigest === draft.missionSource?.inputDigest) {
        await syncTaskPlanLedger(this.userDataRoot(), state)
        return state
      }
      // A revision/resource change while reading cannot silently enter a new plan.
      const confirmed = await buildCanonicalMissionTaskPlan(session.meta, input, this.userDataRoot())
      if (draft.missionSource?.inputDigest !== confirmed.missionSource?.inputDigest) {
        throw new Error('Mission 输入在编译过程中变化，请刷新后重试')
      }
      this.assertIdle(session.meta, '保存 Mission 计划')
      if (session.meta.taskStrategy !== 'plan') throw new Error('Mission 会话已离开规划策略')
      const next = this.store.createVersion(binding(session.meta), draft, 'agent')
      await syncTaskPlanLedger(this.userDataRoot(), next)
      return next
    } finally {
      this.approvalsInFlight.delete(id)
    }
  }

  async requireApprovedVersion(
    id: string,
    input: TaskPlanApprovalInput
  ): Promise<{ version: TaskPlanVersion; projection: TaskPlanStateView['projection'] }> {
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
    await this.assertMissionSourceCurrent(session.meta, current)
    this.store.assertExecutionAuthorized(id, true)
    const latest = this.store.get(id)
    if (latest.currentVersion?.digest !== current.digest || latest.approvedDigest !== current.digest) {
      throw new Error('计划执行目标已变化，请重新审查当前版本')
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
      await this.assertMissionSourceCurrent(session.meta, current)
      const previousApproval = [...state.approvalEvents].reverse().find((event) => event.kind === 'approved')
      const reusePreviousReceipt = previousApproval?.version === current.version &&
        previousApproval.digest === current.digest
      const projection = await this.projector.project(
        current,
        previousApproval?.projection,
        reusePreviousReceipt
      )
      await this.assertMissionSourceCurrent(session.meta, current)
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

  async assertInteractiveExecution(id: string, action: string): Promise<void> {
    await this.assertExecution(this.requireSession(id).meta, action)
  }

  async assertExecution(meta: SessionMeta, action: string): Promise<void> {
    requireExecuteTaskStrategy(meta, action)
    await this.assertPlanExecutionCurrent(meta)
    requireExecuteTaskStrategy(this.requireSession(meta.id).meta, action)
  }

  async authorizeSend(session: Engine): Promise<boolean> {
    if (session.meta.taskStrategy !== 'execute') return true
    try {
      await this.assertExecution(session.meta, '发送执行请求')
      return true
    } catch (error) {
      session.meta.lastError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  private async assertPlanExecutionCurrent(meta: SessionMeta, requireOwnPlan = false): Promise<void> {
    if (requireOwnPlan) this.store.assertExecutionAuthorized(meta.id, true)
    const authorities = this.executionAuthorities(meta)
    const fingerprint = executionAuthorityFingerprint(authorities)
    for (const authority of authorities) {
      // A child WorkItem is not the Mission source. Validate the exact ancestor
      // that owns the approved plan, including when the child has its own plan.
      if (authority.version) await this.assertMissionSourceCurrent(authority.meta, authority.version)
    }
    const latest = this.executionAuthorities(this.requireSession(meta.id).meta)
    if (executionAuthorityFingerprint(latest) !== fingerprint) {
      throw new Error('任务计划或父会话归属在授权过程中变化，已阻止执行')
    }
  }

  private executionAuthorities(meta: SessionMeta): Array<{ meta: SessionMeta; version?: TaskPlanVersion }> {
    const visited = new Set<string>()
    const authorities: Array<{ meta: SessionMeta; version?: TaskPlanVersion }> = []
    let current = meta
    while (true) {
      if (visited.has(current.id)) throw new Error('任务计划父会话链形成循环，已阻止执行')
      visited.add(current.id)
      this.assertApprovalIdle(current.id)
      const version = this.store.get(current.id).currentVersion
      if (current.id !== meta.id && version?.missionSource) {
        requireExecuteTaskStrategy(current, '继续执行 Mission 子任务')
      }
      this.store.assertExecutionAuthorized(current.id, false)
      authorities.push({ meta: { ...current }, version })
      if (!current.parentSessionId) return authorities
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

  private async assertMissionSourceCurrent(meta: SessionMeta, version: TaskPlanVersion): Promise<void> {
    await assertTaskPlanRequirementsCurrent(meta, version, this.userDataRoot())
    if (version.institutionTemplate) {
      if (!meta.workspaceId || (!meta.goalId && !meta.workItemId)) throw new Error('计划机构职责缺少原项目或任务身份')
      const { template } = await readGoalInstitutionContext(this.userDataRoot(), meta.workspaceId, meta.goalId, meta.workItemId)
      if (template.templateId !== version.institutionTemplate.templateId ||
          template.templateVersion !== version.institutionTemplate.templateVersion) {
        throw new Error('计划机构模板与原目标的职责版本不一致，请核对原计划')
      }
    }
    if (!version.missionSource) return
    const current = await buildCanonicalMissionTaskPlan(meta, {
      expectedGoalRevision: version.missionSource.goalRevision
    }, this.userDataRoot(), { legacyInstitutions: version.institutionTemplate === undefined })
    if (current.missionSource?.inputDigest !== version.missionSource.inputDigest) {
      throw new Error('Mission 的目标、资料或策略已变化，请重新生成并确认计划')
    }
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

function executionAuthorityFingerprint(authorities: Array<{ meta: SessionMeta; version?: TaskPlanVersion }>): string {
  return JSON.stringify(authorities.map(({ meta, version }) => ({
    binding: binding(meta), parentSessionId: meta.parentSessionId, businessLineId: meta.businessLineId,
    taskStrategy: meta.taskStrategy, version: version?.version, digest: version?.digest
  })))
}
