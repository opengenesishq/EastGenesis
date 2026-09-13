import type { ModelProfile, TaskProfile } from './model-profile'
import type { ManualModelOverride, ModelRouteCandidate, ModelRouteRequest, ModelRouterBudget } from './model-router'
import { ModelRouteError } from './model-route-error'

export function eligibleRouteProfiles(
  profiles: ModelProfile[],
  task: TaskProfile,
  request: ModelRouteRequest
): ModelProfile[] {
  const excluded = new Set(request.excludedModels ?? [])
  const available = profiles.filter((profile) => !excluded.has(profile.model)
    && !excluded.has(`${profile.providerId}/${profile.model}`)
    && profile.verification !== 'failed')
  if (!available.length) throw new ModelRouteError('ROUTING_NO_CANDIDATES', '没有可路由的模型候选，请配置可用连接。')
  const manual = request.manualOverride
  const targeted = hasManualTarget(manual) ? available.filter((profile) => matchesManualTarget(profile, manual)) : available
  if (!targeted.length) {
    throw new ModelRouteError('ROUTING_MANUAL_TARGET_UNAVAILABLE', '指定的厂商或模型不可用，请检查固定目标。')
  }
  if (!targeted.some((profile) => isProfileViable(profile, task))) {
    const needs = ['文本输出', task.requiresTools ? '工具调用' : '', task.requiresVision ? '图片理解' : '', `${task.minContextTokens} token 上下文`].filter(Boolean)
    throw new ModelRouteError('ROUTING_CAPABILITY_UNAVAILABLE', `没有模型满足必需能力：${needs.join('、')}。`)
  }
  return available.filter((profile) => isProfileViable(profile, task))
}

interface CandidateSelection {
  selected: ModelRouteCandidate
  manualOverrideApplied: boolean
  warnings: string[]
}

export function selectConstrainedCandidate(
  candidates: ModelRouteCandidate[],
  budget: ModelRouterBudget | undefined,
  manual: ManualModelOverride | undefined
): CandidateSelection {
  const requested = hasManualTarget(manual)
    ? candidates.find((candidate) => matchesManualTarget(candidate.profile, manual)) : undefined
  const primary = requested ?? candidates[0]
  const remaining = budget?.remainingUsd
  if (remaining === undefined) return { selected: primary, manualOverrideApplied: Boolean(requested), warnings: [] }
  assertValidRemainingBudget(remaining)
  if (requested) return selectManualCandidate(requested, budget, manual)
  assertBudgetNotExhausted(budget)
  const affordable = candidates.find((candidate) => !isOverBudget(candidate, budget))
  if (!affordable && budget?.hardLimit) {
    throw new ModelRouteError('ROUTING_BUDGET_UNAFFORDABLE', '所有可用模型的估算成本均超过剩余硬预算。')
  }
  return {
    selected: affordable ?? primary,
    manualOverrideApplied: false,
    warnings: affordable ? [] : ['所有可用模型均超过软预算，保留自动选择。']
  }
}

function selectManualCandidate(
  requested: ModelRouteCandidate,
  budget: ModelRouterBudget | undefined,
  manual: ManualModelOverride | undefined
): CandidateSelection {
  if (manual?.allowBudgetOverflow) {
    return { selected: requested, manualOverrideApplied: true, warnings: isOverBudget(requested, budget) ? ['手动覆盖已明确允许越过预算。'] : [] }
  }
  assertBudgetNotExhausted(budget)
  if (budget?.hardLimit && isOverBudget(requested, budget)) {
    throw new ModelRouteError('ROUTING_BUDGET_UNAFFORDABLE', '指定模型的估算成本超过剩余硬预算，请调整固定目标或预算。')
  }
  return { selected: requested, manualOverrideApplied: true, warnings: isOverBudget(requested, budget) ? ['指定模型超过软预算，保留手动选择。'] : [] }
}

function assertValidRemainingBudget(remaining: number): void {
  if (!Number.isFinite(remaining) || remaining < 0) {
    throw new ModelRouteError('ROUTING_INVALID_BUDGET', '剩余预算必须是有限的非负金额。')
  }
}

function assertBudgetNotExhausted(budget: ModelRouterBudget | undefined): void {
  if (budget?.hardLimit && budget.remainingUsd === 0) {
    throw new ModelRouteError('ROUTING_BUDGET_EXHAUSTED', '可用预算已耗尽，请调整预算后继续。')
  }
}

function hasManualTarget(manual: ManualModelOverride | undefined): manual is ManualModelOverride {
  return Boolean(manual?.providerId || manual?.model)
}

function matchesManualTarget(profile: ModelProfile, manual: ManualModelOverride): boolean {
  return (!manual.providerId || profile.providerId === manual.providerId) && (!manual.model || profile.model === manual.model)
}

function isOverBudget(candidate: ModelRouteCandidate, budget: ModelRouterBudget | undefined): boolean {
  return budget?.remainingUsd !== undefined && candidate.estimatedCostUsd > budget.remainingUsd
}

function isProfileViable(profile: ModelProfile, task: TaskProfile): boolean {
  return profile.supportsText !== false && (!task.requiresTools || profile.supportsTools) && (!task.requiresVision || profile.supportsVision)
    && profile.contextWindowTokens >= task.minContextTokens
}
