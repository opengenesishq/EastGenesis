import { getBusinessLines, type BusinessLineDefinition } from '../shared/business-line-types'
import type { CreateSessionOptions, ProviderView, SessionMeta, TaskStrategy } from '../shared/types'
import { buildModelProfiles } from './model/model-profile'
import { getSettings } from './settings'

const STRATEGY_LEVEL = { view: 0, plan: 1, execute: 2 }

export function applyBusinessLineCreationPolicy(options: CreateSessionOptions, line: BusinessLineDefinition): void {
  if (line.taskBudgetUsd !== undefined) {
    if (options.budgetUsd !== undefined && (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0 || options.budgetUsd > line.taskBudgetUsd)) throw new Error('任务预算必须为正数且不能超过业务线预算上限')
    options.budgetUsd = options.budgetUsd ?? line.taskBudgetUsd
  }
  if (!line.toolScope) return
  requireWithinScope(options.taskStrategy ?? line.toolScope, line.toolScope)
  options.taskStrategy = options.taskStrategy ?? line.toolScope
}

export function assertBusinessLineTaskStrategy(meta: Pick<SessionMeta, 'businessLineId'>, strategy: TaskStrategy): void {
  if (!meta.businessLineId) return
  const line = getBusinessLines(getSettings()).find((item) => item.id === meta.businessLineId)
  if (line?.toolScope) requireWithinScope(strategy, line.toolScope)
}

function requireWithinScope(requested: TaskStrategy, allowed: TaskStrategy): void {
  if (STRATEGY_LEVEL[requested] > STRATEGY_LEVEL[allowed]) throw new Error('任务策略超出业务线工具范围，请先编辑业务线范围')
}

export function filterBusinessLineModels(providers: ProviderView[], line?: BusinessLineDefinition): ProviderView[] {
  const capabilities = line?.requiredCapabilities
  if (!capabilities?.length) return providers
  return providers.flatMap((provider) => {
    const profiles = buildModelProfiles({ providerId: provider.id, providerName: provider.name, models: provider.models, engine: provider.engine, modelProfiles: provider.advancedConfig?.modelProfiles })
    const models = profiles.filter((profile) => capabilities.every((capability) => capability === 'tools' ? profile.supportsTools : profile.supportsVision)).map((profile) => profile.model)
    return models.length ? [{ ...provider, models }] : []
  })
}
