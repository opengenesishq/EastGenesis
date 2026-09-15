import type { CreateSessionOptions, HistoryEntry, SessionMeta, TaskPlanStateView } from '../../shared/types'
import { AUTO_MODEL, AUTO_PROVIDER_ID } from '../../shared/types'
import { MANAGED_PERSONAL_WORKSPACE_ID, type ProjectGoalTaskPrepareInput, type ProjectGoalTaskPrepared } from '../../shared/project-workspace-types'
import type { ManagedSessionCreationOptions } from '../session-manager-support'
import { withSessionOperationQueue } from '../session-operation-queue'
import { createProjectWorkspaceReadService } from './canonical-read-service'
import { createProjectGoalTask, goalTaskIds } from './goal-task-service'
import { resolveWorkspaceSessionCwd } from './workspace-session-cwd'
import { normalizeGoalPreparation, ProjectGoalSubmissionStore } from './goal-submission-store'
import { openProjectWorkspaceStore } from './store'

export type GoalSessionIdentity = Pick<SessionMeta | HistoryEntry,
  'id' | 'workspaceId' | 'goalId' | 'workItemId' | 'businessLineId' | 'parentSessionId' | 'personalWorkspaceId'>

export interface ProjectGoalSubmissionRuntime {
  whenInitialized(): Promise<void>
  get(id: string): { meta: SessionMeta } | undefined
  /** Active, historical, snapshot and pending journal identities, including inactive Sessions. */
  identities(): Promise<GoalSessionIdentity[]>
  createManaged(options: CreateSessionOptions, lifecycle: ManagedSessionCreationOptions): Promise<SessionMeta>
  getTaskPlan(id: string): TaskPlanStateView
  generateTaskPlan(id: string, input: { objective: string }): Promise<TaskPlanStateView>
  compileMissionTaskPlan(id: string, input: { expectedGoalRevision: number }): Promise<TaskPlanStateView>
}

export class ProjectGoalSubmissionService {
  private readonly store: ProjectGoalSubmissionStore
  constructor(private readonly rootDir: string, private readonly runtime: ProjectGoalSubmissionRuntime) {
    this.store = new ProjectGoalSubmissionStore(rootDir)
  }

  prepare(raw: ProjectGoalTaskPrepareInput): Promise<ProjectGoalTaskPrepared> {
    const input = normalizeGoalPreparation(raw)
    if (input.projectId === MANAGED_PERSONAL_WORKSPACE_ID) throw new Error('个人任务必须从个人任务入口提交')
    const ids = goalTaskIds(input.projectId, input.requestId)
    // Shared across service instances as well as browser windows.
    return withSessionOperationQueue(`project-goal:${this.rootDir}:${ids.goalId}`, () => this.perform(input))
  }

  private async perform(input: ProjectGoalTaskPrepareInput): Promise<ProjectGoalTaskPrepared> {
    await this.runtime.whenInitialized()
    const workspace = await (await openProjectWorkspaceStore(this.rootDir)).getWorkspace(input.projectId)
    if (!workspace || workspace.status !== 'active') throw new Error('项目不存在或已停用，已阻止创建任务提交记录')
    const ids = goalTaskIds(input.projectId, input.requestId)
    const prior = this.store.read(input)
    const identities = await this.runtime.identities()
    const matches = identities.filter((meta) => meta.workspaceId === input.projectId &&
      meta.goalId === ids.goalId && meta.workItemId === ids.workItemId && !meta.parentSessionId)
    const sessionIds = [...new Set(matches.map((meta) => meta.id))]
    if (sessionIds.length > 1) throw new Error('该任务存在多个会话，请从历史选择原任务')
    const existingId = sessionIds[0]
    if (prior && existingId && prior.sessionId !== existingId) throw new Error('任务会话与提交记录不一致')
    if (!prior && ((input.legacySessionId && input.legacySessionId !== existingId) ||
        (input.legacyCreationClaimed && !existingId))) {
      throw new Error('旧会话创建结果尚未核实，请先恢复原会话，已阻止重复创建')
    }
    let record = prior ?? this.store.reserve(input, existingId)
    const reads = createProjectWorkspaceReadService(this.rootDir, 'canonical')
    const [goal, workItem] = await Promise.all([reads.getGoal(ids.goalId), reads.getWorkItem(ids.workItemId)])
    if (record.phase !== 'reserved' && (!goal || !workItem)) throw new Error('已建立的任务记录缺失，请恢复原任务；不能重新创建已删除的任务')
    const created = await createProjectGoalTask(input, this.rootDir)
    if (record.phase === 'reserved') record = this.store.advance(record, 'task_created')
    for (const meta of identities.filter((candidate) => candidate.id === record.sessionId)) {
      assertGoalSessionIdentity(meta, input.projectId, ids, created.workItem.businessLineId)
    }
    let session = this.runtime.get(record.sessionId)?.meta
    if (!session) {
      if (identities.some((meta) => meta.id === record.sessionId) || record.phase === 'session_ready' || record.phase === 'ready') {
        throw new Error(`原任务会话 ${record.sessionId} 已保存，请先从任务历史恢复；已阻止重复创建`)
      }
      // createManaged writes its own journal before placement. Absence of all evidence
      // permits retry with the SAME reserved ID after a validation-only failure.
      record = this.store.advance(record, 'creating_session')
      const cwd = await resolveWorkspaceSessionCwd(input.projectId, this.rootDir)
      session = await this.runtime.createManaged({
        cwd, workspaceId: input.projectId, goalId: ids.goalId, workItemId: ids.workItemId,
        businessLineId: created.workItem.businessLineId, model: AUTO_MODEL, providerId: AUTO_PROVIDER_ID,
        routingScope: 'global', initialPrompt: input.objective, taskStrategy: 'plan', title: created.workItem.title
      }, { reservedSessionId: record.sessionId, awaitStart: true })
    }
    if (session.id !== record.sessionId) throw new Error('会话创建回执与预留身份不一致')
    assertGoalSessionIdentity(session, input.projectId, ids, created.workItem.businessLineId)
    if (record.phase !== 'ready') record = this.store.advance(record, 'session_ready')
    const current = this.runtime.getTaskPlan(session.id)
    if (record.phase === 'ready' && !current.currentVersion) throw new Error('原任务计划记录缺失，请恢复原计划')
    const plan = current.currentVersion ? current : input.template === 'product-launch'
      ? await this.runtime.compileMissionTaskPlan(session.id, { expectedGoalRevision: created.goal.revision })
      : await this.runtime.generateTaskPlan(session.id, { objective: input.objective })
    const binding = plan.currentVersion?.binding
    if (!binding || binding.sessionId !== session.id || binding.workspaceId !== input.projectId ||
        binding.goalId !== ids.goalId || binding.workItemId !== ids.workItemId) {
      throw new Error('计划未生成或与原任务身份不一致，原任务已保留')
    }
    if (record.phase !== 'ready') this.store.advance(record, 'ready')
    return { ...created, sessionId: session.id, plan }
  }
}

function assertGoalSessionIdentity(meta: GoalSessionIdentity, projectId: string,
  ids: { goalId: string; workItemId: string }, businessLineId: string | undefined): void {
  if (meta.workspaceId !== projectId || meta.goalId !== ids.goalId || meta.workItemId !== ids.workItemId ||
      meta.businessLineId !== businessLineId || meta.parentSessionId || meta.personalWorkspaceId) {
    throw new Error('会话与项目任务归属不一致，已停止提交')
  }
}
