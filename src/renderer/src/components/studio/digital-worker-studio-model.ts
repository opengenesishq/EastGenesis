import type {
  DigitalWorker,
  DigitalWorkerAssignment,
  DigitalWorkerRoleRecommendation,
  DigitalWorkerStatus,
  JsonObject,
  JsonValue,
  RoleTemplate,
  RoleTemplateInput
} from '../../../../shared/types'
import {
  WATERCOLOR_CHARACTER_ROLES,
  resolveWatercolorRole,
  type WatercolorCharacterRole,
  type WatercolorRoleResolution
} from '../../../../shared/watercolor-character'
import { useStore } from '../../store'

export interface DigitalWorkerStudioWorkItem {
  id: string
  title: string
  projectId?: string
  status?: string
}

export interface DigitalWorkerStudioProject {
  id: string
  name: string
}

export interface DigitalWorkerStudioProps {
  active?: boolean
  projectId?: string
  projects?: readonly DigitalWorkerStudioProject[]
  workItems?: readonly DigitalWorkerStudioWorkItem[]
  assignedBy?: string
  className?: string
  onProjectChange?: (projectId: string | undefined) => void
}

export type StudioTab = 'team' | 'roles'

export const WORKER_STATUS_LABELS: Record<DigitalWorkerStatus, string> = {
  get proposed() { return studioLocalized('待启用', 'Proposed') },
  get active() { return studioLocalized('工作中', 'Active') },
  get paused() { return studioLocalized('已暂停', 'Paused') },
  get retired() { return studioLocalized('已退休', 'Retired') }
}

export const WATERCOLOR_ROLE_LABELS: Record<WatercolorCharacterRole, string> = {
  get researcher() { return studioLocalized('研究', 'Research') },
  get planner() { return studioLocalized('策划', 'Planning') },
  get writer() { return studioLocalized('写作', 'Writing') },
  get designer() { return studioLocalized('设计', 'Design') },
  get developer() { return studioLocalized('开发', 'Development') },
  get 'review-test'() { return studioLocalized('审查/测试', 'Review / testing') },
  get operations() { return studioLocalized('运营', 'Operations') }
}

export const WATERCOLOR_ROLE_OPTIONS = WATERCOLOR_CHARACTER_ROLES.map((value) => ({
  value,
  get label() { return WATERCOLOR_ROLE_LABELS[value] }
}))

export function splitList(value: string): string[] {
  return [...new Set(value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean))]
}

export function workerInitials(name: string): string {
  return Array.from(name.trim()).slice(0, 2).join('').toUpperCase() || 'AI'
}

export function roleForWorker(worker: DigitalWorker, roles: readonly RoleTemplate[]): RoleTemplate | undefined {
  return roles.find((role) => role.id === worker.roleTemplateId)
}

export function watercolorRoleForWorker(
  worker: Pick<DigitalWorker, 'id' | 'avatarProfile'>,
  role?: Pick<RoleTemplate, 'name' | 'purpose'>
): WatercolorRoleResolution {
  return resolveWatercolorRole(worker, role)
}

export function suggestedWatercolorRole(
  roleId: string,
  roles: readonly RoleTemplate[]
): WatercolorCharacterRole {
  const role = roles.find((entry) => entry.id === roleId)
  return resolveWatercolorRole({ id: roleId || 'new-worker', avatarProfile: {} }, role).role
}

export function projectOptions(
  projects: readonly DigitalWorkerStudioProject[],
  projectId: string | undefined,
  workers: readonly DigitalWorker[],
  assignments: readonly DigitalWorkerAssignment[],
  workItems: readonly DigitalWorkerStudioWorkItem[]
): DigitalWorkerStudioProject[] {
  const labels = new Map(projects.map((project) => [project.id, project.name]))
  const ids = new Set<string>()
  if (projectId) ids.add(projectId)
  for (const worker of workers) ids.add(worker.projectId)
  for (const assignment of assignments) ids.add(assignment.projectId)
  for (const workItem of workItems) if (workItem.projectId) ids.add(workItem.projectId)
  for (const project of projects) ids.add(project.id)
  return [...ids]
    .map((id) => ({ id, name: labels.get(id) || compactId(id) }))
    .sort((left, right) => left.name.localeCompare(right.name, studioLocale()))
}

export function permissionsFor(worker: DigitalWorker): string[] {
  return toolPolicyLabels(worker.toolPolicy)
}

export function toolPolicyLabels(policy: JsonObject): string[] {
  const permissions: string[] = []
  appendPermission(permissions, policy.workspaceRead, studioLocalized('读取工作区', 'Read workspace'))
  appendPermission(permissions, policy.workspaceWrite, studioLocalized('修改工作区', 'Modify workspace'))
  appendPermission(permissions, policy.terminal, studioLocalized('终端操作', 'Terminal access'))
  appendPermission(permissions, policy.browser, studioLocalized('浏览器操作', 'Browser access'))
  appendPermission(permissions, policy.network, studioLocalized('网络访问', 'Network access'))
  const workspace = objectValue(policy.workspace)
  appendPermission(permissions, workspace?.read, studioLocalized('读取工作区', 'Read workspace'))
  appendPermission(permissions, workspace?.write, studioLocalized('修改工作区', 'Modify workspace'))
  const unique = [...new Set(permissions)]
  if (unique.length === 0 && Object.keys(policy).length > 0) return [studioLocalized('自定义权限策略', 'Custom permission policy')]
  return unique
}

export function recommendationDataLabels(recommendation: DigitalWorkerRoleRecommendation): string[] {
  const allowed = stringArrayValue(recommendation.dataScope.allowedDataClasses)
  const resources = stringArrayValue(recommendation.dataScope.allowedResourceIds)
  const labels = [
    ...(recommendation.dataScope.requireExplicitScope === true ? [studioLocalized('需显式范围', 'Explicit scope required')] : []),
    ...(allowed.length > 0 ? [studioLocalized(`数据 ${allowed.join(', ')}`, `Data ${allowed.join(', ')}`)] : []),
    ...(resources.length > 0 ? [`Resource ${resources.length}`] : [])
  ]
  return labels.length > 0 ? labels : [studioLocalized('项目范围', 'Project scope')]
}

export function recommendationBudgetLabel(recommendation: DigitalWorkerRoleRecommendation): string {
  const amount = numberValue(recommendation.budgetPolicy.maxAmount)
  const currency = stringValue(recommendation.budgetPolicy.currency) ?? 'USD'
  const runs = numberValue(recommendation.budgetPolicy.maxRuns)
  const tokens = numberValue(recommendation.budgetPolicy.maxTokens)
  if (amount !== undefined) return `${currency} ${formatNumber(amount)} / Goal`
  if (runs !== undefined) return `${formatNumber(runs)} Runs / Goal`
  if (tokens !== undefined) return `${formatNumber(tokens)} Tokens / Goal`
  return studioLocalized('继承 Goal 预算', 'Inherit Goal budget')
}

export function roleTemplateInputForRecommendation(
  recommendation: DigitalWorkerRoleRecommendation
): RoleTemplateInput {
  return {
    name: recommendation.name,
    purpose: recommendation.purpose,
    instructions: [
      studioLocalized('方法', 'Methods'),
      ...recommendation.methods.map((item) => `- ${item}`),
      '',
      studioLocalized('职责', 'Responsibilities'),
      ...recommendation.responsibilities.map((item) => `- ${item}`),
      '',
      studioLocalized('产出', 'Outputs'),
      ...recommendation.outputs.map((item) => `- ${item}`)
    ].join('\n'),
    capabilityRefs: recommendation.capabilityRefs,
    skillRefs: recommendation.skillRefs,
    toolPolicy: recommendation.toolPolicy,
    memoryPolicy: { scope: 'project', learning: 'user-confirmed' },
    routingRequirements: { providerNeutral: true },
    verificationPolicy: {
      acceptance: recommendation.acceptance,
      requiredOutputs: recommendation.outputs
    },
    escalationPolicy: recommendation.escalationPolicy,
    source: 'system'
  }
}

export function workerAllowedDataClasses(worker: DigitalWorker): string[] {
  return stringArrayValue(worker.dataScope.allowedDataClasses)
}

export function workerDeniedDataClasses(worker: DigitalWorker): string[] {
  return stringArrayValue(worker.dataScope.deniedDataClasses)
}

export function workerAllowedResourceIds(worker: DigitalWorker): string[] {
  return stringArrayValue(worker.dataScope.allowedResourceIds)
}

export function dataScopeLabels(worker: DigitalWorker): string[] {
  const allowed = workerAllowedDataClasses(worker)
  const denied = workerDeniedDataClasses(worker)
  const resources = workerAllowedResourceIds(worker)
  const labels: string[] = []
  if (worker.dataScope.requireExplicitScope === true) labels.push(studioLocalized('需显式声明', 'Explicit scope required'))
  if (allowed.length > 0) labels.push(studioLocalized(`允许: ${allowed.join(', ')}`, `Allowed: ${allowed.join(', ')}`))
  if (denied.length > 0) labels.push(studioLocalized(`禁止: ${denied.join(', ')}`, `Denied: ${denied.join(', ')}`))
  if (resources.length > 0) labels.push(`Resource: ${resources.join(', ')}`)
  return labels.length > 0 ? labels : [studioLocalized('未限制', 'Unrestricted')]
}

export function acceptancePolicyLabels(worker: DigitalWorker): string[] {
  const minimumEvidence = numberValue(worker.acceptancePolicy.minimumEvidenceCount) ?? 1
  return [
    `Evidence >= ${minimumEvidence}`,
    worker.acceptancePolicy.requireUserApproval === true
      ? studioLocalized('需用户确认', 'User approval required')
      : studioLocalized('按规则验收', 'Rule-based acceptance')
  ]
}

export function escalationPolicyLabels(worker: DigitalWorker): string[] {
  const target = stringValue(worker.escalationPolicy.target) ?? studioLocalized('未设置目标', 'No target set')
  const failures = numberValue(worker.escalationPolicy.afterFailures)
  return [target, failures === undefined
    ? studioLocalized('未设置阈值', 'No threshold set')
    : studioLocalized(`${failures} 次失败后升级`, `Escalate after ${failures} failures`)]
}

export function budgetLabel(policy: JsonObject): string {
  const monthlyUsd = numberValue(policy.monthlyUsd)
  if (monthlyUsd !== undefined) return studioLocalized(`$${formatNumber(monthlyUsd)} / 月`, `$${formatNumber(monthlyUsd)} / month`)
  const dailyUsd = numberValue(policy.dailyUsd)
  if (dailyUsd !== undefined) return studioLocalized(`$${formatNumber(dailyUsd)} / 日`, `$${formatNumber(dailyUsd)} / day`)
  const monthly = numberValue(policy.monthlyLimit)
  if (monthly !== undefined) return studioLocalized(`${formatNumber(monthly)} / 月`, `${formatNumber(monthly)} / month`)
  const daily = numberValue(policy.dailyLimit)
  if (daily !== undefined) return studioLocalized(`${formatNumber(daily)} / 日`, `${formatNumber(daily)} / day`)
  return Object.keys(policy).length > 0 ? studioLocalized('自定义', 'Custom') : studioLocalized('未设置', 'Not set')
}

export function performanceProfileLabels(worker: DigitalWorker): string[] {
  const profile = worker.performanceProfile
  if (numberValue(profile.schemaVersion) !== 1) return [studioLocalized('暂无绩效样本', 'No performance samples')]
  const totalRuns = numberValue(profile.totalRuns) ?? 0
  const acceptanceDecisions = numberValue(profile.acceptanceDecisions) ?? 0
  const acceptanceRate = numberValue(profile.acceptancePassRate) ?? 0
  const reliability = numberValue(profile.reliability) ?? 0
  const reworkRuns = numberValue(profile.reworkRuns) ?? 0
  const costUsd = numberValue(profile.costUsd) ?? 0
  const costCoverage = typeof profile.costCoverage === 'string' ? profile.costCoverage : 'complete'
  const unpricedAttempts = numberValue(profile.unpricedAttempts) ?? 0
  const averageDurationMs = numberValue(profile.averageDurationMs) ?? 0
  return [
    `Run ${formatNumber(totalRuns)}`,
    acceptanceDecisions > 0 ? `Acceptance ${Math.round(acceptanceRate * 100)}%` : studioLocalized('Acceptance 暂无', 'No acceptance data'),
    studioLocalized(`可靠性 ${Math.round(reliability * 100)}%`, `Reliability ${Math.round(reliability * 100)}%`),
    studioLocalized(`返工 ${formatNumber(reworkRuns)}`, `Rework ${formatNumber(reworkRuns)}`),
    costCoverage === 'complete'
      ? studioLocalized(`成本 $${formatNumber(costUsd)}`, `Cost $${formatNumber(costUsd)}`)
      : studioLocalized(`成本待核验 ${formatNumber(unpricedAttempts)} 次`, `${formatNumber(unpricedAttempts)} unpriced attempts`),
    studioLocalized(`平均 ${durationLabel(averageDurationMs)}`, `Average ${durationLabel(averageDurationMs)}`)
  ]
}

export function assignmentsForWorker(
  workerId: string,
  assignments: readonly DigitalWorkerAssignment[]
): DigitalWorkerAssignment[] {
  return assignments.filter(
    (assignment) =>
      assignment.status === 'active' &&
      assignment.assigneeKind === 'digital_worker' &&
      assignment.assigneeId === workerId
  )
}

export function workItemTitle(
  workItemId: string,
  workItems: readonly DigitalWorkerStudioWorkItem[]
): string {
  return workItems.find((item) => item.id === workItemId)?.title || compactId(workItemId)
}

export function compactId(id: string): string {
  if (id.length <= 24) return id
  return `${id.slice(0, 11)}...${id.slice(-8)}`
}

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message
  if (typeof cause === 'string' && cause.trim()) return cause
  return studioLocalized('操作失败，请重试。', 'The operation failed. Try again.')
}

function appendPermission(target: string[], value: JsonValue | undefined, label: string): void {
  if (value === true) target.push(label)
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArrayValue(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(studioLocale(), { maximumFractionDigits: 2 }).format(value)
}

function durationLabel(value: number): string {
  if (value < 1_000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${formatNumber(value / 1_000)}s`
  return `${formatNumber(value / 60_000)}m`
}

export function studioLocale(): string {
  return useStore.getState().settings.language === 'zh' ? 'zh-CN' : 'en-US'
}

export function studioLocalized(chinese: string, english: string): string {
  return useStore.getState().settings.language === 'en' ? english : chinese
}
