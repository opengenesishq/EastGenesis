import { createHash } from 'node:crypto'
import type { SessionMeta } from '../../shared/types'
import { AUTO_MODEL, AUTO_PROVIDER_ID } from '../../shared/types'
import { MANAGED_PERSONAL_WORKSPACE_ID, type ProjectGoalTaskPrepareInput, type ProjectGoalTaskPrepared,
  type ProjectGoalTaskStartInput, type ProjectGoalTaskStarted, type Goal, type WorkItem } from '../../shared/project-workspace-types'
import { withDataLifecycleMutation } from '../data-lifecycle/data-lifecycle-mutation-lock'
import { assertSameBusinessLine } from '../business-line-ownership'
import { assertActiveBusinessLine } from '../business-line-registry-reader'
import { withSessionOperationQueue } from '../session-operation-queue'
import type { SessionInputService } from '../task/session-input-service'
import { createProjectWorkspaceReadService } from './canonical-read-service'
import { createProjectGoalTask, goalTaskIds } from './goal-task-service'
import type { GoalSessionIdentity, ProjectGoalSubmissionRuntime } from './goal-submission-service'
import { normalizeGoalPreparation, ProjectGoalSubmissionStore } from './goal-submission-store'
import { decideProjectGoalStart } from './goal-start-policy'
import { openProjectWorkspaceStore } from './store'
import { resolveWorkspaceSessionCwd } from './workspace-session-cwd'

export interface ProjectGoalStartRuntime extends ProjectGoalSubmissionRuntime {
  prepare(input: ProjectGoalTaskPrepareInput): Promise<ProjectGoalTaskPrepared>
  inputs: Pick<SessionInputService, 'queue' | 'apply' | 'list'>
  withTaskWriteAccess<T>(operation: () => Promise<T>): Promise<T>
}

type DirectStart = Omit<Extract<ProjectGoalTaskStarted, { kind: 'direct' }>, 'input'>
type PlanStart = Pick<Extract<ProjectGoalTaskStarted, { kind: 'plan' }>, 'kind' | 'decision'>

/** One start action owns one fixed Session and one input receipt; it never approves a TaskPlan. */
export class ProjectGoalStartService {
  private readonly store: ProjectGoalSubmissionStore
  constructor(private readonly rootDir: string, private readonly runtime: ProjectGoalStartRuntime) {
    this.store = new ProjectGoalSubmissionStore(rootDir)
  }

  async start(raw: ProjectGoalTaskStartInput): Promise<ProjectGoalTaskStarted> {
    if (!raw || (raw.mode !== 'auto' && raw.mode !== 'plan')) throw new Error('任务开始方式无效')
    const input = { ...normalizeGoalPreparation(raw), mode: raw.mode }
    if (input.projectId === MANAGED_PERSONAL_WORKSPACE_ID) throw new Error('个人任务必须从个人任务入口提交')
    const ids = goalTaskIds(input.projectId, input.requestId)
    // Same key as preparation. Persist the choice before releasing the queue for prepare().
    const selected = await withSessionOperationQueue(`project-goal:${this.rootDir}:${ids.goalId}`, async () => {
      const prepared = await this.runtime.withTaskWriteAccess(() =>
        withDataLifecycleMutation(this.rootDir, () => this.selectAndPrepare(input)))
      // Sending reacquires canonical assignment/lifecycle locks. Release preparation locks first.
      return prepared.kind === 'direct' ? this.dispatchDirect(input, prepared) : prepared
    })
    if (selected.kind === 'direct') return selected
    const prepared = await this.runtime.prepare(input)
    return { ...prepared, kind: 'plan', decision: selected.decision }
  }

  private async selectAndPrepare(input: ProjectGoalTaskStartInput): Promise<DirectStart | PlanStart> {
    await this.runtime.whenInitialized()
    const workspace = await (await openProjectWorkspaceStore(this.rootDir)).getWorkspace(input.projectId)
    if (!workspace || workspace.status !== 'active') throw new Error('项目不存在或已停用，已阻止开始任务')
    const ids = goalTaskIds(input.projectId, input.requestId)
    const prior = this.store.read(input)
    const identities = await this.runtime.identities()
    const matches = identities.filter((meta) => meta.workspaceId === input.projectId &&
      meta.goalId === ids.goalId && meta.workItemId === ids.workItemId && !meta.parentSessionId)
    const sessionIds = [...new Set(matches.map((meta) => meta.id))]
    if (sessionIds.length > 1) throw new Error('该任务存在多个会话，请从历史选择原任务')
    if (prior && sessionIds[0] && prior.sessionId !== sessionIds[0]) throw new Error('任务会话与提交记录不一致')
    if (prior?.startDecision && prior.startDecision.mode !== input.mode) throw new Error('此提交已选定开始方式，请继续原任务；不能用相同提交标识改换方式')
    const decision = prior?.startDecision ?? decideProjectGoalStart(input, Boolean(prior || sessionIds[0]))
    if (decision.kind === 'plan') {
      if (!prior && !input.legacyCreationClaimed && !input.legacySessionId) this.store.reserve(input, sessionIds[0], decision)
      return { kind: 'plan', decision }
    }
    let record = prior ?? this.store.reserve(input, undefined, decision)
    const reads = createProjectWorkspaceReadService(this.rootDir, 'canonical')
    const [goal, workItem] = await Promise.all([reads.getGoal(ids.goalId), reads.getWorkItem(ids.workItemId)])
    if (record.phase !== 'reserved' && (!goal || !workItem)) throw new Error('原任务记录缺失，已阻止重新创建被删除的任务')
    if (goal && workItem) assertExistingTask(goal, workItem, input, ids)
    const created = goal && workItem
      ? { requestId: input.requestId, goal, workItem, recovered: true }
      : await createProjectGoalTask(input, this.rootDir)
    for (const meta of identities.filter((candidate) => candidate.id === record.sessionId)) {
      assertOwnership(meta, input, ids, created.workItem.businessLineId)
    }
    const activeMeta = this.runtime.get(record.sessionId)?.meta
    if (activeMeta) assertOwnership(activeMeta, input, ids, created.workItem.businessLineId)
    const existingInput = (await this.runtime.inputs.list(record.sessionId)).find((entry) => entry.id === directGoalInputId(input.projectId, input.requestId))
    if (existingInput?.phase === 'applied') {
      assertInputReceipt(existingInput, record.sessionId, input, ids)
      return { ...created, sessionId: record.sessionId, kind: 'direct', decision }
    }
    if (['completed', 'failed', 'cancelled', 'archived'].includes(created.goal.status) ||
      ['done', 'failed', 'cancelled'].includes(created.workItem.status)) throw new Error('原任务已结束且缺少已接收证据，请核对原任务；不会重发')
    if (record.phase === 'reserved') record = this.store.advance(record, 'task_created')
    let session = this.runtime.get(record.sessionId)?.meta
    if (!session) {
      if (identities.some((meta) => meta.id === record.sessionId) || record.phase === 'session_ready' || record.phase === 'ready') {
        throw new Error(`原任务会话 ${record.sessionId} 已保存，请先恢复；不会重复创建或发送`)
      }
      record = this.store.advance(record, 'creating_session')
      const cwd = await resolveWorkspaceSessionCwd(input.projectId, this.rootDir)
      session = await this.runtime.createManaged({
        cwd, workspaceId: input.projectId, goalId: ids.goalId, workItemId: ids.workItemId,
        businessLineId: created.workItem.businessLineId, title: created.workItem.title,
        model: AUTO_MODEL, providerId: AUTO_PROVIDER_ID, routingScope: 'global',
        initialPrompt: input.objective, taskStrategy: 'view', permissionMode: 'default'
      }, { reservedSessionId: record.sessionId, awaitStart: true })
    }
    assertOwnership(session, input, ids, created.workItem.businessLineId)
    if (session.id !== record.sessionId) throw new Error('会话创建回执与预留身份不一致')
    this.assertDirectSession(session)
    if (record.phase !== 'session_ready') record = this.store.advance(record, 'session_ready')
    return { ...created, sessionId: session.id, kind: 'direct', decision }
  }

  private async dispatchDirect(input: ProjectGoalTaskStartInput, prepared: DirectStart): Promise<Extract<ProjectGoalTaskStarted, { kind: 'direct' }>> {
    const inputId = directGoalInputId(input.projectId, input.requestId)
    const previous = (await this.runtime.inputs.list(prepared.sessionId)).find((entry) => entry.id === inputId)
    if (previous) {
      assertInputReceipt(previous, prepared.sessionId, input, goalTaskIds(input.projectId, input.requestId))
      if (previous.phase === 'applied') return { ...prepared, input: previous }
    }
    const currentSession = () => {
      const session = this.runtime.get(prepared.sessionId)?.meta
      if (!session) throw new Error('原任务会话已关闭，请先恢复；不会重复创建或发送')
      assertOwnership(session, input, goalTaskIds(input.projectId, input.requestId), prepared.workItem.businessLineId)
      this.assertDirectSession(session)
      return session
    }
    const session = currentSession()
    const queued = await this.runtime.inputs.queue(session.id, inputId, { text: input.objective })
    // Reconciliation resolves an uncertain send from durable evidence; it never replays it.
    const current = queued.phase === 'queued' ? queued :
      (await this.runtime.inputs.list(session.id)).find((entry) => entry.id === inputId) ?? queued
    currentSession()
    const receipt = current.phase === 'queued' ? await this.runtime.inputs.apply(session.id, inputId) : current
    return { ...prepared, input: receipt }
  }

  private assertDirectSession(meta: SessionMeta): void {
    if (meta.taskStrategy !== 'view' || meta.permissionMode !== 'default' || meta.status === 'closed') {
      throw new Error('直接开始只支持原始只读会话，请继续原任务；不会自动修改现有授权')
    }
    if (!meta.businessLineId) throw new Error('直接开始缺少原始业务线身份')
    assertActiveBusinessLine(meta.businessLineId, this.rootDir)
    if (this.runtime.getTaskPlan(meta.id).currentVersion) throw new Error('当前任务已有计划，必须通过原计划入口继续；不能绕过计划审批')
  }
}

export function directGoalInputId(projectId: string, requestId: string): string {
  return `goal-start-${createHash('sha256').update(JSON.stringify([projectId, requestId])).digest('hex')}`
}

function assertOwnership(meta: GoalSessionIdentity, input: ProjectGoalTaskStartInput,
  ids: { goalId: string; workItemId: string }, businessLineId: string | undefined): void {
  if (meta.workspaceId !== input.projectId || meta.goalId !== ids.goalId || meta.workItemId !== ids.workItemId ||
    meta.businessLineId !== businessLineId || meta.parentSessionId || meta.personalWorkspaceId) {
    throw new Error('会话与项目任务归属不一致，已停止开始任务')
  }
}

function assertExistingTask(goal: Goal, workItem: WorkItem, input: ProjectGoalTaskStartInput,
  ids: { goalId: string; workItemId: string }): void {
  assertSameBusinessLine(input.businessLineId, workItem.businessLineId)
  const title = input.objective.replace(/\s+/g, ' ').trim()
  const expectedTitle = title.length <= 72 ? title : `${title.slice(0, 71)}…`
  if (goal.id !== ids.goalId || goal.projectId !== input.projectId || goal.objective !== input.objective || goal.title !== expectedTitle ||
      workItem.id !== ids.workItemId || workItem.projectId !== input.projectId || workItem.goalId !== goal.id ||
      workItem.description !== input.objective || workItem.title !== expectedTitle) throw new Error('直接任务的提交内容与原始任务不一致')
}

function assertInputReceipt(record: import('../../shared/session-input-types').SessionInputRecord, sessionId: string,
  input: ProjectGoalTaskStartInput, ids: { goalId: string; workItemId: string }): void {
  if (record.sessionId !== sessionId || record.workspaceId !== input.projectId || record.goalId !== ids.goalId ||
      record.workItemId !== ids.workItemId || record.payload.text !== input.objective || record.payload.documents?.length || record.payload.images?.length) {
    throw new Error('直接任务的接收回执与原提交不一致')
  }
}
