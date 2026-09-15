import { canonicalJson, digest } from './workflow-ledger-codec'
import type {
  WorkflowAcceptanceRecord,
  WorkflowGoalRecord,
  WorkflowWorkItemRecord,
  WorkflowWorkItemType,
} from '../../shared/workflow-types'
import type { BusinessLineDefinition } from '../../shared/business-line-types'
import type { TaskPlanDraftInput, TaskPlanRiskLevel, TaskPlanStepInput } from '../../shared/task-plan-types'
import type { TaskDagRole } from '../../shared/types'

export interface MissionCompilerMaterial {
  id: string
  title: string
  uri?: string
}

export interface MissionCompilerInput {
  projectId: string
  goalId: string
  objective: string
  constraints: readonly string[]
  deliverables: readonly string[]
  materials?: readonly MissionCompilerMaterial[]
  businessLineId?: string
  businessLineName?: string
  now?: number
}

export interface MissionDependency {
  fromWorkItemId: string
  toWorkItemId: string
}

export interface MissionCompilation {
  schemaVersion: 1
  digest: string
  businessLine: BusinessLineDefinition
  goal: WorkflowGoalRecord
  roles: readonly { id: string; label: string; purpose: string }[]
  workItems: readonly WorkflowWorkItemRecord[]
  dependencies: readonly MissionDependency[]
  acceptances: readonly WorkflowAcceptanceRecord[]
}

/**
 * Convert a compiled mission into a TaskPlan draft.
 *
 * This is deliberately a pure, main-process mapping: it creates no TaskPlan
 * version, approval event, canonical projection, provider route, or execution
 * authorization. Callers must pass the returned draft to the normal
 * `createTaskPlanVersion` flow, which starts in `pending` approval state.
 */
export function missionCompilationToTaskPlanDraft(compilation: MissionCompilation): TaskPlanDraftInput {
  if (!compilation || compilation.schemaVersion !== 1) throw new Error('mission compilation schema is unsupported')
  if (!compilation.goal?.objective?.trim()) throw new Error('mission compilation goal objective is required')
  if (!Array.isArray(compilation.workItems) || compilation.workItems.length < 1) {
    throw new Error('mission compilation must contain work items')
  }
  if (!Array.isArray(compilation.acceptances) || compilation.acceptances.length < 1) {
    throw new Error('mission compilation must contain pending acceptances')
  }
  if (compilation.acceptances.some((acceptance) => acceptance.status !== 'pending')) {
    throw new Error('mission compilation acceptances must remain pending')
  }

  const workItemIds = new Set(compilation.workItems.map((item) => item.id))
  if (workItemIds.size !== compilation.workItems.length || [...workItemIds].some((id) => !id.trim())) {
    throw new Error('mission compilation work item ids must be unique and non-empty')
  }
  if (compilation.acceptances.length !== compilation.workItems.length) {
    throw new Error('mission compilation acceptances must bind each work item exactly once')
  }
  const acceptanceWorkItemIds = new Set<string>()
  const acceptanceByWorkItem = new Map<string, WorkflowAcceptanceRecord>(
    compilation.acceptances.map((acceptance) => [acceptance.workItemId, acceptance])
  )
  for (const acceptance of compilation.acceptances) {
    if (!workItemIds.has(acceptance.workItemId) || acceptanceWorkItemIds.has(acceptance.workItemId)) {
      throw new Error('mission compilation acceptances must bind each work item exactly once')
    }
    acceptanceWorkItemIds.add(acceptance.workItemId)
  }
  const dependenciesByWorkItem = new Map<string, string[]>()
  for (const item of compilation.workItems) dependenciesByWorkItem.set(item.id, [])
  const dependencyKeys = new Set<string>()
  for (const dependency of compilation.dependencies ?? []) {
    if (!workItemIds.has(dependency.fromWorkItemId) || !workItemIds.has(dependency.toWorkItemId)) {
      throw new Error('mission compilation dependency references an unknown work item')
    }
    if (dependency.fromWorkItemId === dependency.toWorkItemId) throw new Error('mission compilation dependency cannot self-reference')
    const key = `${dependency.fromWorkItemId}->${dependency.toWorkItemId}`
    if (dependencyKeys.has(key)) continue
    dependencyKeys.add(key)
    dependenciesByWorkItem.get(dependency.toWorkItemId)!.push(dependency.fromWorkItemId)
  }

  const riskLevel: TaskPlanRiskLevel = compilation.workItems.length > 1 ? 'medium' : 'low'
  const expectedArtifacts = uniqueStrings(compilation.businessLine?.deliverables ?? [])
  const steps: TaskPlanStepInput[] = compilation.workItems.map((item) => {
    const role = ROLE_TEMPLATES.find((candidate) => candidate.id === item.role)
    if (!role || role.type !== item.type) throw new Error('mission compilation work item role/type is invalid')
    const acceptance = acceptanceByWorkItem.get(item.id)!
    const artifacts = artifactsForWorkItem(item.type)
    return {
      id: item.id,
      title: item.title,
      description: item.description,
      role: role.id,
      executionRole: role.executionRole,
      workItemType: role.type,
      dependsOn: uniqueStrings(dependenciesByWorkItem.get(item.id) ?? []),
      expectedArtifacts: artifacts,
      acceptanceSpec: [
        ...artifacts.map((artifact, index) => ({ id: `artifact-${index + 1}`, criterion: `产出并提供证据：${artifact}`, required: true })),
        ...acceptance.criteria.map((criterion, index) => ({ id: `${acceptance.id}:criterion:${index + 1}`, criterion, required: true }))
      ],
      // Mission compilation does not grant a provider route or external egress.
      dataEgress: [],
      estimatedCostUsd: null,
      riskLevel
    }
  })
  const acceptanceCriteria = uniqueStrings([
    '该草稿必须先由用户确认；确认前不得执行、生成 canonical 投影或向外部 Provider 外发数据',
    ...compilation.acceptances.flatMap((acceptance) => acceptance.criteria),
  ])

  return {
    objective: compilation.goal.objective.trim(),
    steps,
    expectedArtifacts,
    dataEgress: [],
    estimatedCostUsd: null,
    riskLevel,
    acceptanceCriteria,
    changeReason: `Mission Compiler 编译摘要：${compilation.digest}`,
    source: 'genesis'
  }
}

const ROLE_TEMPLATES = [
  { id: 'research', label: '礼部', purpose: '整理资料、来源和事实边界', type: 'research', executionRole: 'general' },
  { id: 'build', label: '工部', purpose: '实现可运行的最小交付', type: 'coding', executionRole: 'general' },
  { id: 'document', label: '文书', purpose: '形成使用说明和交付文档', type: 'documentation', executionRole: 'docs' },
  { id: 'verify', label: '都察院', purpose: '独立验证、风险检查和 Proof Pack', type: 'testing', executionRole: 'qa' },
] as const satisfies readonly { id: string; label: string; purpose: string; type: WorkflowWorkItemType; executionRole: TaskDagRole }[]

export function compileMission(input: MissionCompilerInput): MissionCompilation {
  const projectId = required(input.projectId, 'projectId')
  const goalId = required(input.goalId, 'goalId')
  const objective = required(input.objective, 'objective')
  const constraints = textList(input.constraints, 'constraints')
  const deliverables = textList(input.deliverables, 'deliverables')
  const materials = normalizeMaterials(input.materials ?? [])
  const now = input.now === undefined ? Date.now() : input.now
  if (!Number.isFinite(now)) throw new Error('now must be finite')
  const businessLineId = input.businessLineId?.trim() || `business-line:mission-${slug(goalId)}`
  const businessLineName = input.businessLineName?.trim() || '产品发布府'
  const seed = { projectId, goalId, objective, constraints, deliverables, materials, businessLineId, businessLineName }
  const missionDigest = digest(canonicalJson(seed))
  const line: BusinessLineDefinition = {
    schemaVersion: 1, id: businessLineId, origin: 'custom', name: businessLineName,
    objective, workflow: ['确认目标', '并行执行', '独立验证', '交付复盘'], deliverables,
    routingPreference: 'balanced', enabled: true, order: 0, workSurfaces: ['tasks', 'results'],
  }
  const goal: WorkflowGoalRecord = {
    schemaVersion: 1, id: goalId, projectId, title: objective.slice(0, 80), objective,
    status: 'waiting_approval', revision: 1, source: 'explicit', createdAt: now, updatedAt: now,
  }
  const workItems = ROLE_TEMPLATES.map((role) => ({
    schemaVersion: 1 as const, id: `work-item:${missionDigest.slice(0, 20)}:${role.id}`, projectId, goalId,
    type: role.type, title: `${role.label}：${deliverables.join('、')}`.slice(0, 240),
    description: `${role.purpose}。目标：${objective}`.slice(0, 2000), role: role.id,
    businessLineId, status: 'backlog' as const, revision: 1, source: 'explicit' as const,
    runIds: [], createdAt: now, updatedAt: now,
  }))
  const byRole = new Map(workItems.map((item) => [item.role, item.id]))
  const dependencies: MissionDependency[] = [
    { fromWorkItemId: byRole.get('research')!, toWorkItemId: byRole.get('build')! },
    { fromWorkItemId: byRole.get('research')!, toWorkItemId: byRole.get('document')! },
    { fromWorkItemId: byRole.get('build')!, toWorkItemId: byRole.get('verify')! },
    { fromWorkItemId: byRole.get('document')!, toWorkItemId: byRole.get('verify')! },
  ]
  const acceptances = workItems.map((item) => ({
    schemaVersion: 1 as const, id: `acceptance:mission:${item.id}`, projectId, goalId, workItemId: item.id,
    criteria: [`${item.title} 产出可追溯并符合目标约束`, ...constraints], status: 'pending' as const,
    evidenceRefs: [], revision: 1, createdAt: now, updatedAt: now,
  }))
  return { schemaVersion: 1, digest: missionDigest, businessLine: line, goal, roles: ROLE_TEMPLATES.map(({ id, label, purpose }) => ({ id, label, purpose })), workItems, dependencies, acceptances }
}

function required(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${field} must be non-empty text`)
  return value.trim()
}
function textList(values: readonly string[], field: string): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 32) throw new Error(`${field} must contain 1-32 entries`)
  return values.map((value, index) => required(value, `${field}[${index}]`)).filter((value, index, all) => all.indexOf(value) === index)
}
function normalizeMaterials(values: readonly MissionCompilerMaterial[]): MissionCompilerMaterial[] {
  if (!Array.isArray(values) || values.length > 128) throw new Error('materials must contain at most 128 entries')
  const seen = new Set<string>()
  return values.map((material, index) => {
    const id = required(material.id, `materials[${index}].id`)
    const title = required(material.title, `materials[${index}].title`)
    if (seen.has(id)) throw new Error(`duplicate material id: ${id}`)
    seen.add(id)
    return { id, title, ...(material.uri?.trim() ? { uri: material.uri.trim() } : {}) }
  }).sort((left, right) => left.id.localeCompare(right.id))
}
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'goal'
}

function uniqueStrings(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
}

function artifactsForWorkItem(type: WorkflowWorkItemType): string[] {
  if (type === 'research') return ['资料、来源清单与事实边界']
  if (type === 'coding') return ['可运行的最小实现与变更摘要']
  if (type === 'documentation') return ['可审查的使用说明与交付文档']
  if (type === 'testing') return ['验证报告、失败证据与 Proof Pack']
  return ['可审查的任务产物与验收证据']
}
