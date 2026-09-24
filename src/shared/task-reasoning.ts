import type { Provider, ProviderReasoningEffort, ProviderRuntimeConfig } from './types'

export function normalizeTaskReasoning(value: unknown): ProviderReasoningEffort | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)) throw new Error('推理强度无效。')
  return value as ProviderReasoningEffort
}

/** Capabilities are declarations/configuration, not a successful model probe. */
export function taskReasoningOptions(provider: Pick<Provider, 'advancedConfig' | 'engine'> | undefined, model: string): ProviderReasoningEffort[] {
  if (!provider || !model || model === 'auto') return []
  const profile = provider.advancedConfig?.modelProfiles?.find(item => item.model === model || item.aliases?.includes(model))
  const runtime = provider.advancedConfig?.runtime
  const declared = profile?.capabilities?.some(value => ['reasoning', 'thinking'].includes(value.toLowerCase()))
  if (provider.engine === 'gemini') return declared || runtime?.gemini?.thinking?.level ? ['minimal', 'low', 'medium', 'high'] : []
  if (provider.engine === 'anthropic') return []
  return declared || runtime?.reasoningEffort ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] : []
}

export function withTaskReasoning<T extends Pick<Provider, 'advancedConfig'>>(provider: T, effort: ProviderReasoningEffort | undefined, engine: 'openai' | 'gemini' | 'anthropic'): T {
  if (!effort) return provider
  normalizeTaskReasoning(effort)
  const runtime: ProviderRuntimeConfig = { ...provider.advancedConfig?.runtime }
  if (engine === 'openai') runtime.reasoningEffort = effort
  else if (engine === 'gemini' && ['minimal', 'low', 'medium', 'high'].includes(effort)) {
    runtime.gemini = { ...runtime.gemini, thinking: { ...runtime.gemini?.thinking, budgetTokens: undefined, level: effort as 'minimal' | 'low' | 'medium' | 'high' } }
  } else throw new Error('当前模型协议不支持此任务的推理强度，请修改计划配置。')
  return { ...provider, advancedConfig: { ...provider.advancedConfig, runtime } }
}
