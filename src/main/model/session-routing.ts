import { AUTO_MODEL } from '../../shared/types'
import type {
  CaoGenDriveMode,
  ModelRoutingDecisionView,
  ModelRoutingRiskLevel,
  ModelRoutePlanView,
  EngineKind,
  ModelRoutingRule,
  ProviderView,
  RoutingExpertPolicy,
  SchedulerStrategy,
  SendMessagePayload
} from '../../shared/types'
import { routeModel } from './model-router'
import { ModelRouteError } from './model-route-error'
import type { ManualModelOverride } from './model-router'
import { inferTaskProfile, type TaskProfile } from './model-profile'
import { driveModeLabel, driveRiskAtLeast, driveRouteTuning } from './drive'
import { applyRoutingExpertPolicy } from './routing-expert-policy'
import { getHealth } from '../providerHealth'
import {
  readProjectModelDispatchHintsSync,
  type ProjectModelDispatchHints,
  type ProjectModelDispatchStrategy,
  type ProjectModelDispatchTarget
} from '../agent/context-loader'

export interface SessionRouteInput {
  enabled: boolean
  currentModel: string
  providerId: string
  providers: ProviderView[]
  engine?: EngineKind
  /** 仅用于会话创建前的首次选路;已运行会话不得跨引擎热切换。 */
  allowAnyEngine?: boolean
  driveMode?: CaoGenDriveMode
  payload: SendMessagePayload
  strategy: SchedulerStrategy
  businessLineStrategy?: SchedulerStrategy
  sessionCostUsd: number
  estimatedContextTokens?: number
  sessionBudgetUsd?: number
  settingsBudgetUsd: number
  monthlyBudgetRemainingUsd?: number
  manualOverride?: ManualModelOverride
  fallbackProviderId?: string
  fallbackModel?: string
  lowCostProviderId?: string
  lowCostModel?: string
  strongReasoningProviderId?: string
  strongReasoningModel?: string
  reviewProviderId?: string
  reviewModel?: string
  researchProviderId?: string
  researchModel?: string
  planningProviderId?: string
  planningModel?: string
  codingProviderId?: string
  codingModel?: string
  testingProviderId?: string
  testingModel?: string
  documentationProviderId?: string
  documentationModel?: string
  modelRoutingRules?: ModelRoutingRule[]
  routingExpertPolicy?: RoutingExpertPolicy
  projectPath?: string
}

export type SessionRouteResult =
  | { kind: 'disabled' }
  | {
      kind: 'routed'
      providerId: string
      providerName?: string
      model: string
      reason: string
      switchedProvider: boolean
      decision: ModelRoutingDecisionView
      crossValidationPlan: ModelRoutePlanView
      recoveryRuleTarget?: { providerId?: string; model?: string }
      recoveryCatalog?: Array<{ providerId: string; model: string }>
      recoveryTask?: Pick<TaskProfile, 'requiresTools' | 'requiresVision' | 'minContextTokens'>
    }

export function resolveSessionModelRoute(input: SessionRouteInput): SessionRouteResult {
  if (!input.enabled || input.currentModel !== AUTO_MODEL) return { kind: 'disabled' }
  const providerSelection = routeableProviders(
    input.providers,
    input.engine,
    input.allowAnyEngine === true,
    input.routingExpertPolicy
  )
  const providers = providerSelection.providers
  if (providers.length === 0) throw new ModelRouteError('ROUTING_NO_CANDIDATES', '当前策略与协议下没有可用模型，请检查连接和路由设置。')
  const prompt = input.payload.text
  const drive = driveRouteTuning(input.driveMode)
  const projectDispatch = input.projectPath ? readProjectModelDispatchHintsSync(input.projectPath) : {}
  const strategy = input.businessLineStrategy ?? projectDispatch.strategy ?? (drive.mode === 'core' ? input.strategy : drive.strategy)
  const budget = budgetForRoute(input)
  const attachments = input.payload.images?.map((image) => ({ mime: image.mime }))
  const riskLevel = driveRiskAtLeast(inferRouteRisk(prompt), drive.riskFloor)
  const inferredTask = inferTaskProfile({
    prompt,
    attachments,
    contextTokens: input.estimatedContextTokens,
    expectedOutputTokens: drive.expectedOutputTokens,
    strategy,
    riskLevel,
    requiresTools: true
  })
  const ruleOverride = input.manualOverride ? undefined : customRoutingRuleOverride(input.modelRoutingRules, {
    prompt, taskKinds: inferredTask.taskKinds, riskLevel: inferredTask.riskLevel, strategy: inferredTask.strategy
  })
  const decision = routeModel({
    providers,
    prompt,
    attachments,
    contextTokens: input.estimatedContextTokens,
    requestedTasks: drive.requestedTasks,
    expectedOutputTokens: drive.expectedOutputTokens,
    strategy,
    manualOverride:
      input.manualOverride ??
      ruleOverride ??
      projectModelRoleOverride(input, projectDispatch) ??
      modelRoleOverride(input),
    budget,
    providerHealth: Object.fromEntries(providers.map((provider) => {
      const health = getHealth(provider.id)
      return [provider.id, {
        healthy: health.healthy,
        circuitState: health.circuitState,
        latencyEmaMs: health.latencyEmaMs
      }]
    })),
    crossValidation: drive.crossValidation,
    riskLevel,
    requiresTools: true
  })
  const selected = decision.selected.profile
  const switchedProvider = selected.providerId !== input.providerId
  return {
    kind: 'routed',
    providerId: selected.providerId,
    providerName: selected.providerName,
    model: selected.model,
    switchedProvider,
    ...(ruleOverride ? { recoveryRuleTarget: { providerId: ruleOverride.providerId, model: ruleOverride.model } } : {}),
    recoveryCatalog: decision.candidates.map(({ profile }) => ({ providerId: profile.providerId, model: profile.model })),
    recoveryTask: { requiresTools: decision.task.requiresTools, requiresVision: decision.task.requiresVision, minContextTokens: decision.task.minContextTokens },
    decision: buildRoutingDecisionView(
      decision,
      switchedProvider,
      budget?.remainingUsd,
      providerSelection.warnings
    ),
    crossValidationPlan: decision.crossValidationPlan,
    reason: formatRouteReason(decision, drive.mode, projectDispatch, providerSelection.warnings)
  }
}

export function createLegacyRoutingDecisionView(input: {
  providerId: string
  providerName?: string
  model: string
  strategy: SchedulerStrategy
  complexity: 'simple' | 'medium' | 'complex'
  candidateCount: number
  switchedProvider: boolean
  reason: string
}): ModelRoutingDecisionView {
  return {
    providerId: input.providerId,
    providerName: input.providerName,
    model: input.model,
    strategy: input.strategy,
    taskKinds: ['chat'],
    complexity: input.complexity,
    riskLevel: input.complexity === 'complex' ? 'high' : input.complexity === 'medium' ? 'medium' : 'low',
    candidateCount: Math.max(1, input.candidateCount),
    manualOverrideApplied: false,
    selectionReason: input.reason,
    selectedReasons: [input.reason],
    budgetDowngraded: false,
    switchedProvider: input.switchedProvider,
    warnings: [],
    alternatives: [],
    createdAt: Date.now()
  }
}

function buildRoutingDecisionView(
  decision: ReturnType<typeof routeModel>,
  switchedProvider: boolean,
  remainingBudgetUsd: number | undefined,
  providerWarnings: string[]
): ModelRoutingDecisionView {
  const selected = decision.selected
  const alternatives = [...decision.candidates]
    .filter(
      (candidate) =>
        candidate.profile.providerId !== selected.profile.providerId || candidate.profile.model !== selected.profile.model
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((candidate) => ({
      providerId: candidate.profile.providerId,
      providerName: candidate.profile.providerName,
      model: candidate.profile.model,
      score: candidate.score,
      reliability: candidate.reliability,
      estimatedCostUsd: candidate.estimatedCostUsd,
      latencyEmaMs: candidate.latencyEmaMs,
      scoreBreakdown: candidate.scoreBreakdown
    }))
  return {
    providerId: selected.profile.providerId,
    providerName: selected.profile.providerName,
    model: selected.profile.model,
    strategy: decision.task.strategy,
    taskKinds: decision.task.taskKinds,
    riskLevel: decision.task.riskLevel,
    candidateCount: decision.candidates.length,
    score: selected.score,
    reliability: selected.reliability,
    estimatedCostUsd: selected.estimatedCostUsd,
    latencyEmaMs: selected.latencyEmaMs,
    scoreBreakdown: selected.scoreBreakdown,
    decisionDigest: decision.decisionDigest,
    remainingBudgetUsd,
    manualOverrideApplied: decision.manualOverrideApplied,
    selectionReason:
      decision.manualOverrideReason ??
      (decision.budgetDowngraded ? '预算约束后的最优候选' : `${strategyLabel(decision.task.strategy)}评分最优`),
    selectedReasons: selected.reasons,
    budgetDowngraded: decision.budgetDowngraded,
    switchedProvider,
    warnings: [...providerWarnings, ...decision.warnings],
    alternatives,
    createdAt: Date.now()
  }
}

function routeableProviders(
  providers: ProviderView[],
  engine: EngineKind | undefined,
  allowAnyEngine: boolean,
  expertPolicy?: RoutingExpertPolicy
): { providers: ProviderView[]; warnings: string[] } {
  const compatible = providers.filter((provider) => {
    if (!(provider.ready ?? provider.hasToken) || provider.models.length === 0) return false
    if (allowAnyEngine) return true
    return engine !== undefined && provider.engine === engine
  })
  const expert = expertPolicy
    ? applyRoutingExpertPolicy(compatible, expertPolicy)
    : { providers: compatible, warnings: [] }
  const healthy = expert.providers.filter((provider) => getHealth(provider.id).healthy)
  if (healthy.length > 0) {
    const excluded = expert.providers.length - healthy.length
    return {
      providers: healthy,
      warnings: [
        ...expert.warnings,
        ...(excluded > 0 ? [`已跳过 ${excluded} 个近期连续失败的 Provider。`] : [])
      ]
    }
  }
  return {
    providers: expert.providers,
    warnings: [
      ...expert.warnings,
      ...(expert.providers.length > 0 ? ['所有可路由 Provider 均标记为不健康，暂按全部候选继续。'] : [])
    ]
  }
}

function budgetForRoute(input: SessionRouteInput): { remainingUsd?: number; hardLimit: boolean } | undefined {
  const remainingLimits: number[] = []
  const sessionLimit = input.sessionBudgetUsd && input.sessionBudgetUsd > 0 ? input.sessionBudgetUsd : input.settingsBudgetUsd
  if (sessionLimit && sessionLimit > 0) remainingLimits.push(Math.max(0, sessionLimit - input.sessionCostUsd))
  if (typeof input.monthlyBudgetRemainingUsd === 'number' && Number.isFinite(input.monthlyBudgetRemainingUsd)) {
    remainingLimits.push(Math.max(0, input.monthlyBudgetRemainingUsd))
  }
  if (remainingLimits.length === 0) return undefined
  return { remainingUsd: Math.min(...remainingLimits), hardLimit: true }
}

function inferRouteRisk(prompt: string): 'low' | 'medium' | 'high' {
  const lower = prompt.toLowerCase()
  if (hasAny(lower, ['security', 'auth', 'payment', 'release', 'deploy', 'production', 'database', 'migration'])) return 'high'
  if (hasAny(lower, ['安全', '鉴权', '支付', '发布', '部署', '生产', '数据库', '迁移'])) return 'high'
  if (hasAny(lower, ['code', 'typescript', 'bug', 'refactor', 'test', 'review'])) return 'medium'
  if (hasAny(lower, ['代码', '修复', '实现', '重构', '测试', '审查'])) return 'medium'
  return 'low'
}

function modelRoleOverride(input: SessionRouteInput): ManualModelOverride | undefined {
  const prompt = input.payload.text.toLowerCase()
  const wantsResearch = hasAny(prompt, ['research', 'investigate', '调研', '调查', '资料搜集'])
  const wantsPlanning = hasAny(prompt, ['plan', 'proposal', 'roadmap', '策划', '方案', '路线图'])
  const wantsTesting = hasAny(prompt, ['test', 'testing', 'qa', '测试', '验收'])
  const wantsDocumentation = hasAny(prompt, ['documentation', 'readme', 'spec', '文档', '需求文档'])
  const wantsCoding = hasAny(prompt, ['code', 'coding', 'implement', 'typescript', 'refactor', '代码', '开发', '实现', '重构'])
  const wantsReview = hasAny(prompt, ['review', '审查', '复核', 'diff', '风险'])
  const wantsStrong =
    input.driveMode === 'forge' ||
    input.driveMode === 'command' ||
    input.driveMode === 'genesis' ||
    hasAny(prompt, ['reason', '推理', '架构', '规划', 'production', 'release', 'database', 'migration', '部署', '发布', '数据库', '迁移'])
  const wantsLow =
    input.driveMode === 'spark' ||
    input.strategy === 'cost' ||
    hasAny(prompt, ['quick', 'simple', 'summarize', '轻量', '快速', '简单', '总结'])

  if (wantsResearch) {
    const override = buildRoleOverride(input.researchProviderId, input.researchModel, '调研任务偏好')
    if (override) return override
  }
  if (wantsPlanning) {
    const override = buildRoleOverride(input.planningProviderId, input.planningModel, '策划任务偏好')
    if (override) return override
  }
  if (wantsTesting) {
    const override = buildRoleOverride(input.testingProviderId, input.testingModel, '测试任务偏好')
    if (override) return override
  }
  if (wantsDocumentation) {
    const override = buildRoleOverride(input.documentationProviderId, input.documentationModel, '文档任务偏好')
    if (override) return override
  }
  if (wantsCoding) {
    const override = buildRoleOverride(input.codingProviderId, input.codingModel, '开发任务偏好')
    if (override) return override
  }
  if (wantsReview) {
    const override = buildRoleOverride(input.reviewProviderId, input.reviewModel, '审查模型偏好')
    if (override) return override
  }
  if (wantsStrong) {
    const override = buildRoleOverride(input.strongReasoningProviderId, input.strongReasoningModel, '强推理模型偏好')
    if (override) return override
  }
  if (wantsLow) {
    const override = buildRoleOverride(input.lowCostProviderId, input.lowCostModel, '低成本模型偏好')
    if (override) return override
  }
  return undefined
}

function projectModelRoleOverride(input: SessionRouteInput, hints: ProjectModelDispatchHints): ManualModelOverride | undefined {
  const prompt = input.payload.text.toLowerCase()
  const wantsReview = hasAny(prompt, ['review', '审查', '复核', 'diff', '风险'])
  const wantsStrong =
    input.driveMode === 'forge' ||
    input.driveMode === 'command' ||
    input.driveMode === 'genesis' ||
    hasAny(prompt, ['reason', '推理', '架构', '规划', 'production', 'release', 'database', 'migration', '部署', '发布', '数据库', '迁移'])
  const wantsLow =
    input.driveMode === 'spark' ||
    (hints.strategy ?? input.strategy) === 'cost' ||
    hasAny(prompt, ['quick', 'simple', 'summarize', '轻量', '快速', '简单', '总结'])

  if (wantsReview) return buildProjectOverride(hints.review, '项目审查模型偏好')
  if (wantsStrong) return buildProjectOverride(hints.strongReasoning, '项目复杂/强推理模型偏好')
  if (wantsLow) return buildProjectOverride(hints.lowCost, '项目简单/低成本模型偏好')
  return undefined
}

function customRoutingRuleOverride(
  rules: ModelRoutingRule[] | undefined,
  context: Pick<TaskProfile, 'taskKinds' | 'riskLevel' | 'strategy'> & { prompt: string }
): ManualModelOverride | undefined {
  const rule = (rules ?? []).find((item) => item.enabled && ruleMatches(item, context))
  if (!rule) return undefined
  const override = buildRoleOverride(
    rule.providerId,
    rule.model,
    formatCustomRoutingRuleReason(rule)
  )
  if (!override) return undefined
  return { ...override, allowBudgetOverflow: false }
}

function ruleMatches(
  rule: ModelRoutingRule,
  context: Pick<TaskProfile, 'taskKinds' | 'riskLevel' | 'strategy'> & { prompt: string }
): boolean {
  const lowerPrompt = context.prompt.toLowerCase()
  const needles = rule.match
    .split(/[\n,，;；]+/g)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  const taskKinds = rule.taskKinds ?? []
  const hasCondition = needles.length > 0 || taskKinds.length > 0 || Boolean(rule.minRiskLevel) || Boolean(rule.whenStrategy)
  if (!hasCondition) return false
  const keywordsMatch =
    needles.length === 0 ||
    (rule.keywordMode === 'all'
      ? needles.every((needle) => lowerPrompt.includes(needle))
      : needles.some((needle) => lowerPrompt.includes(needle)))
  const tasksMatch = taskKinds.length === 0 || taskKinds.some((kind) => context.taskKinds.includes(kind))
  const riskMatches = !rule.minRiskLevel || riskRank(context.riskLevel) >= riskRank(rule.minRiskLevel)
  const strategyMatches = !rule.whenStrategy || context.strategy === rule.whenStrategy
  return keywordsMatch && tasksMatch && riskMatches && strategyMatches
}

function formatCustomRoutingRuleReason(rule: ModelRoutingRule): string {
  const base = `自定义调度规则${rule.name.trim() ? `:${rule.name.trim()}` : ''}`
  const conditions: string[] = []
  if (rule.keywordMode === 'all' && rule.match.trim()) conditions.push('关键词=全部')
  if ((rule.taskKinds ?? []).length > 0) conditions.push(`任务=${rule.taskKinds?.join('+')}`)
  if (rule.minRiskLevel) conditions.push(`风险>=${rule.minRiskLevel}`)
  if (rule.whenStrategy) conditions.push(`策略=${rule.whenStrategy}`)
  return conditions.length > 0 ? `${base} (${conditions.join(' · ')})` : base
}

function buildProjectOverride(target: ProjectModelDispatchTarget | undefined, reason: string): ManualModelOverride | undefined {
  if (!target) return undefined
  const override = buildRoleOverride(target.providerId, target.model, reason)
  if (!override) return undefined
  return { ...override, allowBudgetOverflow: false }
}

function buildRoleOverride(providerId: string | undefined, model: string | undefined, reason: string): ManualModelOverride | undefined {
  const cleanProviderId = providerId?.trim()
  const cleanModel = model?.trim()
  if (!cleanProviderId && !cleanModel) return undefined
  return { providerId: cleanProviderId, model: cleanModel, reason }
}

function formatRouteReason(
  decision: ReturnType<typeof routeModel>,
  driveMode: CaoGenDriveMode,
  projectDispatch: ProjectModelDispatchHints,
  providerWarnings: string[]
): string {
  const selected = decision.selected.profile
  const parts = [
    `Drive=${driveModeLabel(driveMode)}`,
    `智能调度选择 ${selected.providerName ?? selected.providerId}/${selected.model}`,
    `任务=${decision.task.taskKinds.join('+')}`,
    `策略=${decision.task.strategy}`,
    `估算=$${decision.selected.estimatedCostUsd.toFixed(4)}`
  ]
  if (projectDispatch.strategy) parts.push(`项目调度策略=${strategyLabel(projectDispatch.strategy)}`)
  if (decision.manualOverrideApplied) parts.push('手动覆盖')
  if (decision.manualOverrideReason) parts.push(decision.manualOverrideReason)
  if (decision.budgetDowngraded) parts.push('预算降级')
  if (decision.crossValidationPlan.enabled) {
    const validators = decision.crossValidationPlan.validators.map((item) => `${item.providerName ?? item.providerId}/${item.model}`)
    parts.push(`复核=${validators.join(',')}`)
  }
  for (const warning of providerWarnings) parts.push(warning)
  for (const warning of decision.warnings) parts.push(warning)
  return parts.join('；')
}

function strategyLabel(strategy: ProjectModelDispatchStrategy): string {
  if (strategy === 'cost') return '成本优先'
  if (strategy === 'quality') return '质量优先'
  if (strategy === 'speed') return '速度优先'
  return '均衡'
}

function riskRank(level: ModelRoutingRiskLevel): number {
  if (level === 'high') return 3
  if (level === 'medium') return 2
  return 1
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle))
}
