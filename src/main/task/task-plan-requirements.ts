import type { SessionMeta } from '../../shared/types'
import type { TaskPlanDraftInput, TaskPlanVersion } from '../../shared/task-plan-types'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { createProjectWorkspaceReadService } from '../project-workspace/canonical-read-service'
import { digest } from '../project-workspace/codec'
import { readTaskSnapshotDatabase } from './task-snapshot'
import { readArtifactLifecycles, findArtifactPurge } from './artifact-lifecycle-store'
import { findWorkflowArtifact } from './workflow-ledger-store'

export async function currentTaskRequirementSource(meta: Pick<SessionMeta, 'workspaceId' | 'goalId' | 'workItemId'>, root: string) {
  if (!meta.workspaceId || !meta.goalId || !meta.workItemId) return undefined
  const state = await (await openProjectWorkspaceStore(root)).getState()
  const event = state.events.filter(event => event.kind === 'goal.requirements_revised' &&
    event.projectId === meta.workspaceId && event.entityId === meta.goalId).at(-1)
  if (!event) return undefined
  const reads = createProjectWorkspaceReadService(root, 'canonical')
  const [goal, item] = await Promise.all([reads.getGoal(meta.goalId), reads.getWorkItem(meta.workItemId)])
  if (!goal || !item || goal.projectId !== meta.workspaceId || item.projectId !== meta.workspaceId || item.goalId !== goal.id) {
    throw new Error('交付要求与原任务身份不一致')
  }
  return { goal, item, source: { eventId: event.id, goalRevision: goal.revision, contractDigest: digest(goal.contract) } }
}

export async function assertTaskPlanRequirementsCurrent(meta: Pick<SessionMeta, 'workspaceId' | 'goalId' | 'workItemId'>,
  version: TaskPlanVersion, root: string): Promise<void> {
  const current = await currentTaskRequirementSource(meta, root)
  if (!current) {
    if (version.requirementSource) throw new Error('计划引用的交付要求修订记录缺失')
    return
  }
  if (version.requirementSource?.eventId !== current.source.eventId ||
      version.requirementSource?.contractDigest !== current.source.contractDigest) {
    throw new Error('交付要求已更新，请在原任务中更新并确认计划后继续')
  }
}

/** A continuation performs only the amendment. Previous child work and files
 * stay in the canonical task history and are not dispatched again. */
export async function requirementContinuationDraft(meta: SessionMeta, expectedRevision: number, root: string): Promise<TaskPlanDraftInput> {
  const current = await currentTaskRequirementSource(meta, root)
  if (!current || current.goal.revision !== expectedRevision) throw new Error('目标要求版本已变化，请刷新后更新计划')
  const { goal, source } = current
  const items = await createProjectWorkspaceReadService(root, 'canonical').listWorkItems(goal.projectId)
  const family = new Set(items.filter(item => item.id === current.item.id || item.parentId === current.item.id).map(item => item.id))
  const artifacts = await readTaskSnapshotDatabase(root, db => {
    const records = readArtifactLifecycles(db).filter(record => record.projectId === goal.projectId && record.goalId === goal.id)
    return records.filter(record => family.has(record.workItemId) && !findArtifactPurge(db, record.artifactId) &&
      ['document', 'spreadsheet', 'presentation'].includes(record.kind) &&
      !records.some(next => next.lineageId === record.lineageId && next.version > record.version)).map(record => ({
        artifactId: record.artifactId, workItemId: record.workItemId, lineageId: record.lineageId,
        digest: record.digest, version: record.version, title: findWorkflowArtifact(db, record.artifactId)?.title ?? record.artifactId
      })).sort((a, b) => a.artifactId.localeCompare(b.artifactId))
  })
  const acceptance = goal.contract.acceptance
  return {
    objective: goal.objective,
    steps: [{ id: `requirement-change-${digest({ eventId: source.eventId, artifacts }).slice(-20)}`, title: '按新要求修订现有成果',
      workItemType: 'custom', executionRole: 'general', dependsOn: [],
      description: '先读取原任务已有成果、人工修改、来源和检查记录，只修改新要求影响的内容。已有文件以新版本交付，保留人工内容及未受影响的工作；没有现成成果时完成当前目标。不得重发已执行的外部操作，未知结果先核对。',
      expectedArtifacts: ['满足当前交付要求的新版本成果、受影响内容和检查记录'],
      acceptanceSpec: acceptance, riskLevel: goal.contract.riskLevel,
      dataEgress: ['已选 Provider：当前目标要求、必要原成果与修改记录'], estimatedCostUsd: null }],
    expectedArtifacts: ['保留原版本和人工修改的修订成果'],
    acceptanceCriteria: acceptance.map(item => item.criterion.length <= 2_000 ? item.criterion : `完整满足步骤验收 [${item.id}] 中保存的交付要求`),
    riskLevel: goal.contract.riskLevel, estimatedCostUsd: null,
    changeReason: `根据已确认的交付要求修订更新计划（目标 v${goal.revision}）`,
    source: 'genesis', requirementSource: { ...source, artifacts }
  }
}
