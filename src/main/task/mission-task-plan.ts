import type { SessionMeta } from '../../shared/types'
import type { TaskPlanDraftInput, TaskPlanMissionCompileInput } from '../../shared/task-plan-types'
import { assertActiveBusinessLine } from '../business-line-registry-reader'
import { assertSameBusinessLine, storedBusinessLineId } from '../business-line-ownership'
import { createProjectWorkspaceReadService } from '../project-workspace/canonical-read-service'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { compileMission, missionCompilationToTaskPlanDraft } from './mission-compiler'
import { digest } from './workflow-ledger-codec'
import { bindTaskPlanInstitutions } from './task-plan-institutions'

/** Host-owned enrichment: preserve the generated step count and existing runtime roles. */
export async function enrichCanonicalTaskPlanInstitutions(
  meta: Pick<SessionMeta, 'workspaceId' | 'goalId' | 'workItemId'>,
  draft: TaskPlanDraftInput,
  rootDir: string
): Promise<TaskPlanDraftInput> {
  if (!meta.workspaceId) return bindTaskPlanInstitutions(draft)
  const store = await openProjectWorkspaceStore(rootDir)
  const workspace = await store.getWorkspace(meta.workspaceId)
  if (!workspace || workspace.status !== 'active') throw new Error('计划所属项目不存在或不可用')
  if (workspace.institutionTemplate?.templateId !== 'cabinet-six-ministries') return bindTaskPlanInstitutions(draft)
  const parent = meta.workItemId ? await createProjectWorkspaceReadService(rootDir, 'canonical').getWorkItem(meta.workItemId) : undefined
  if (!parent || parent.projectId !== meta.workspaceId || (meta.goalId !== undefined && parent.goalId !== meta.goalId)) {
    throw new Error('机构计划与当前项目任务归属不一致')
  }
  return bindTaskPlanInstitutions(draft, workspace.institutionTemplate)
}

/** Read host-owned inputs only. Compilation never opens resources or starts a Runtime. */
export async function buildCanonicalMissionTaskPlan(
  meta: Pick<SessionMeta, 'workspaceId' | 'goalId' | 'workItemId' | 'businessLineId'>,
  input: TaskPlanMissionCompileInput,
  rootDir: string,
  options: { legacyInstitutions?: boolean } = {}
): Promise<TaskPlanDraftInput> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'expectedGoalRevision') ||
      !Number.isSafeInteger(input.expectedGoalRevision) || input.expectedGoalRevision < 1) {
    throw new Error('Mission 编译必须提供有效的 Goal revision，且不能覆盖 canonical 输入')
  }
  const { workspaceId, goalId, workItemId } = meta
  if (!workspaceId || !goalId || !workItemId) {
    throw new Error('Mission 编译需要同一 Project 的 Goal 和父 WorkItem 绑定')
  }
  const reads = createProjectWorkspaceReadService(rootDir, 'canonical')
  const [goal, parent, workspace] = await Promise.all([
    reads.getGoal(goalId),
    reads.getWorkItem(workItemId),
    openProjectWorkspaceStore(rootDir).then((store) => store.getWorkspace(workspaceId))
  ])
  if (!workspace || workspace.status !== 'active') throw new Error('Mission 所属 Project 不存在或不可用')
  if (!goal || goal.projectId !== workspaceId || goal.revision !== input.expectedGoalRevision) {
    throw new Error('Mission Goal 归属或 revision 已变化，请刷新后重新生成计划')
  }
  if (['completed', 'failed', 'cancelled', 'archived'].includes(goal.status) || goal.archivedAt !== undefined) {
    throw new Error('已结束或归档的 Goal 不能生成 Mission 计划')
  }
  if (!parent || parent.projectId !== workspaceId || parent.goalId !== goalId ||
      ['done', 'failed', 'cancelled'].includes(parent.status)) {
    throw new Error('Mission 父 WorkItem 不存在、归属冲突或已经结束')
  }
  const businessLineId = storedBusinessLineId(parent.businessLineId) ?? 'studio'
  assertSameBusinessLine(meta.businessLineId, businessLineId)
  assertActiveBusinessLine(businessLineId, rootDir)
  const contract = goal.contract
  const institutionTemplate = !options.legacyInstitutions && workspace.institutionTemplate?.templateId === 'cabinet-six-ministries'
    ? workspace.institutionTemplate : undefined
  const constraints = [...new Set([
    '计划须由用户确认；编译不执行任务，不授予外发或工具权限',
    ...contract.constraints,
    ...contract.forbiddenActions.map((action) => `禁止：${action}`)
  ])]
  const declared = contract.successCriteria.filter((entry) => entry.startsWith('交付物：'))
    .map((entry) => entry.slice('交付物：'.length).trim()).filter(Boolean)
  const deliverables = declared.length ? declared : contract.successCriteria.length
    ? contract.successCriteria : contract.acceptance.map((entry) => entry.criterion)
  // Resource identities are enough for a local plan. Contents and connector
  // authorization remain behind their existing resource/Provider boundaries.
  const materials = workspace.resources.map((resource) => ({
    id: resource.id,
    title: resource.label || resource.id
  }))
  const mission = compileMission({
    projectId: workspaceId,
    goalId,
    objective: contract.objective,
    constraints,
    deliverables: deliverables.length ? deliverables : ['目标要求的成果和可核验交付证据'],
    materials,
    businessLineId,
    businessLineName: '产品发布府',
    ...(institutionTemplate ? { institutionTemplate } : {})
  })
  const draft = missionCompilationToTaskPlanDraft(mission)
  return {
    ...draft,
    riskLevel: contract.riskLevel,
    steps: draft.steps.map((step) => ({
      ...step,
      riskLevel: contract.riskLevel,
      acceptanceSpec: [
        ...(step.acceptanceSpec ?? []),
        // Final Goal acceptance is checked by the verification step. Requiring
        // the full delivery at research/build completion creates a dependency
        // on later steps; every child still inherits the complete GoalContract.
        ...(step.role === 'verify' ? contract.acceptance.map((entry) => ({ ...entry, id: `goal:${entry.id}` })) : [])
      ]
    })),
    acceptanceCriteria: [...new Set([
      ...draft.acceptanceCriteria,
      ...contract.successCriteria,
      ...contract.acceptance.map((entry) => entry.criterion),
      ...(contract.background ? [`背景：${contract.background}`] : []),
      ...(contract.budget ? [`目标预算上限：${JSON.stringify(contract.budget)}`] : []),
      ...(contract.dueAt ? [`目标截止时间：${new Date(contract.dueAt).toISOString()}`] : []),
      ...materials.map((material) => `资料引用：${material.title}（${material.id}）`)
    ])],
    missionSource: {
      goalRevision: goal.revision,
      missionDigest: mission.digest,
      inputDigest: digest({
        workspaceId, goalId, workItemId, businessLineId, goalRevision: goal.revision,
        contract, resources: workspace.resources, rulesRef: workspace.rulesRef,
        budgetPolicy: workspace.budgetPolicy, permissionPolicy: workspace.permissionPolicy,
        ...(institutionTemplate ? { institutionTemplate } : {})
      })
    }
  }
}
