import { createHash } from 'node:crypto'
import type {
  TaskDag,
  TaskDagRole,
  TaskDagTask,
  TaskPlanDraftInput,
  TaskPlanProjectionReceipt,
  TaskPlanRiskLevel,
  TaskPlanVersion
} from '../../shared/types'
import { institutionResponsibilityLines } from './task-plan-institutions'

const DEFAULT_ARTIFACT = '可审查的任务产物、变更摘要与验收证据'
const PROVIDER_EGRESS = '已选 Provider：目标、必要项目上下文与上游步骤结果'

export function taskDagToPlanDraft(
  dag: TaskDag,
  options: { warnings?: readonly string[]; reason?: string } = {}
): TaskPlanDraftInput {
  const riskLevel = riskForDag(dag)
  const expectedArtifacts = [DEFAULT_ARTIFACT]
  const dataEgress = [PROVIDER_EGRESS]
  return {
    objective: dag.source,
    steps: dag.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      executionRole: task.role,
      dependsOn: task.dependencies,
      expectedArtifacts: [artifactForRole(task.role)],
      dataEgress,
      estimatedCostUsd: null,
      riskLevel
    })),
    expectedArtifacts,
    dataEgress,
    estimatedCostUsd: null,
    riskLevel,
    acceptanceCriteria: [
      '所有必需步骤按依赖顺序完成，且没有未解决的失败或未知结果',
      '每个步骤交付预期产物、变更摘要和可追溯验收证据',
      '父任务汇总已完成项、未完成项、成本和剩余风险',
      ...(options.reason ? [`拆解依据：${options.reason}`] : []),
      ...(options.warnings ?? []).map((warning) => `规划提示：${warning}`)
    ],
    source: 'genesis'
  }
}

export function approvedTaskPlanToDag(
  sessionId: string,
  version: TaskPlanVersion,
  projection?: TaskPlanProjectionReceipt
): TaskDag {
  const workItemIds = projectedWorkItemIds(projection)
  return {
    id: approvedPlanDagId(sessionId, version.version, version.digest),
    title: planTitle(version.objective),
    source: version.objective,
    complexity: version.steps.length > 1 ? 'multi' : 'single',
    createdAt: version.createdAt,
    tasks: version.steps.map((step) => ({
      ...taskFromPlanStep(version, step),
      ...(workItemIds?.[step.id] ? { workItemId: workItemIds[step.id] } : {})
    }))
  }
}

export function projectedWorkItemIds(
  projection: TaskPlanProjectionReceipt | undefined
): Record<string, string> | undefined {
  if (projection?.mode !== 'canonical') return undefined
  return Object.fromEntries(projection.steps.map((step) => [step.stepId, step.workItemId]))
}

function taskFromPlanStep(
  version: TaskPlanVersion,
  step: TaskPlanVersion['steps'][number]
): TaskDagTask {
  const expectedArtifacts = step.expectedArtifacts.length > 0
    ? step.expectedArtifacts
    : version.expectedArtifacts
  return {
    id: step.id,
    title: step.title,
    description: step.description,
    dependencies: step.dependsOn,
    role: step.executionRole ?? roleForStep(step.id, step.title, step.description),
    prompt: [
      '你是 CaoGen 已批准工作流的执行 Agent。',
      '',
      `父目标：${version.objective}`,
      `当前步骤：${step.title}`,
      ...(step.role ? [`岗位：${step.role}`] : []),
      ...(step.workItemType ? [`任务类型：${step.workItemType}`] : []),
      ...institutionResponsibilityLines(version, step.institution),
      `步骤说明：${step.description || '按已批准计划完成该步骤'}`,
      `依赖步骤：${step.dependsOn.join(', ') || '无'}`,
      `预期产物：${expectedArtifacts.join('；') || DEFAULT_ARTIFACT}`,
      `数据外发：${step.dataEgress.join('；') || '无额外外发'}`,
      `风险等级：${step.riskLevel}`,
      ...(step.acceptanceSpec ? ['当前步骤验收条件：', ...step.acceptanceSpec.map((entry) =>
        `- [${entry.id}] ${entry.criterion}${entry.required === false ? '（可选）' : '（必需）'}`)] : []),
      '',
      '执行要求：',
      '1. 严格在当前步骤的范围和 canonical WorkItem 归属内执行。',
      '2. 保留产物、Effect、验证结果和剩余风险的可追溯记录。',
      '3. 结束时给出已完成项、未完成项和下游交接信息。'
    ].join('\n')
  }
}

function approvedPlanDagId(sessionId: string, version: number, digest: string): string {
  const hash = createHash('sha256')
    .update(`caogen.approved-task-plan-dag.v1\0${sessionId}\0${version}\0${digest}`)
    .digest('hex')
    .slice(0, 32)
  return `plan-dag-${hash}`
}

function planTitle(objective: string): string {
  const clean = objective.replace(/\s+/g, ' ').trim()
  return clean.length <= 42 ? clean : `${clean.slice(0, 41)}…`
}

function riskForDag(dag: TaskDag): TaskPlanRiskLevel {
  if (dag.tasks.some((task) => task.role === 'devops')) return 'high'
  return dag.complexity === 'multi' ? 'medium' : 'low'
}

function artifactForRole(role: TaskDagRole): string {
  if (role === 'qa') return '验证报告、失败证据与回归结果'
  if (role === 'docs') return '可审查文档与交付说明'
  if (role === 'review') return '影响面、决策记录与风险清单'
  if (role === 'devops') return '可回滚的发布或基础设施变更及证据'
  return DEFAULT_ARTIFACT
}

function roleForStep(id: string, title: string, description: string): TaskDagRole {
  const text = `${id} ${title} ${description}`
  if (/测试|验证|验收|qa|test|e2e|smoke/i.test(text)) return 'qa'
  if (/前端|界面|交互|ui|react|renderer/i.test(text)) return 'frontend'
  if (/后端|主进程|api|ipc|数据库|server/i.test(text)) return 'backend'
  if (/发布|部署|打包|基础设施|devops|ci|cd/i.test(text)) return 'devops'
  if (/文档|说明|docs?|readme/i.test(text)) return 'docs'
  if (/审查|架构|评审|review|audit/i.test(text)) return 'review'
  return 'general'
}
