import type { EngineKind, ProviderView } from '../../shared/types'
import type { FrozenNativeProtocol } from '../../shared/frozen-routing-types'
import {
  ANTHROPIC_NATIVE_RUNTIME_ADAPTER, GOOGLE_NATIVE_RUNTIME_ADAPTER, OPENAI_NATIVE_RUNTIME_ADAPTER
} from '../native-runtime-contract'
import { resolveOpenAIProtocol, resolveProviderRuntimeTarget } from '../provider/providerRuntimeTarget'
import { findConfiguredModelProfile } from './configured-model-profile'
import type { ModelProfile } from './model-profile'
import { ModelRouteError } from './model-route-error'

/** Local implementation capability only. This is not Provider health or a successful model probe. */
export function nativeExecutorCapabilities(engine: unknown) {
  if (engine === 'openai') return OPENAI_NATIVE_RUNTIME_ADAPTER
  if (engine === 'anthropic') return ANTHROPIC_NATIVE_RUNTIME_ADAPTER
  if (engine === 'gemini') return GOOGLE_NATIVE_RUNTIME_ADAPTER
  return undefined
}

/** Use the same endpoint/app binding as the physical request, including OpenAI's default protocol. */
export function resolveNativeExecutorProtocol(provider: ProviderView, model: string): FrozenNativeProtocol {
  if (!nativeExecutorCapabilities(provider.engine)) {
    throw new ModelRouteError('ROUTING_CAPABILITY_UNAVAILABLE', '执行器能力未知或尚未实现，不能派发原生任务。')
  }
  const target = resolveProviderRuntimeTarget(provider, { appId: provider.engine, model })
  if (provider.engine === 'anthropic') return 'anthropic.messages'
  if (provider.engine === 'gemini') return 'google.generative-language'
  return resolveOpenAIProtocol(target) === 'responses' ? 'openai.responses' : 'openai.chat-completions'
}

export interface ExecutorCompatibilityRequirements {
  requiresTools?: boolean
  requiresVision?: boolean
  minContextTokens?: number
}

/** Check model declarations and local executor support separately before scoring or dispatch. */
export function evaluateNativeExecutorCompatibility(input: {
  provider: ProviderView
  profile: ModelProfile
  /** Fixed routes check the actual mapped model while resolving the original user input exactly once. */
  requestedModel?: string
  requirements: ExecutorCompatibilityRequirements
  expectedEngine?: EngineKind
  expectedProtocol?: FrozenNativeProtocol
}): { compatible: boolean; modelReasons: string[]; executorReasons: string[]; protocol?: FrozenNativeProtocol } {
  const { provider, profile, requirements } = input
  const modelReasons: string[] = []
  const executorReasons: string[] = []
  const executor = nativeExecutorCapabilities(provider.engine)
  if (!executor) executorReasons.push('执行器能力未知或尚未实现。')
  if (input.expectedEngine && provider.engine !== input.expectedEngine) executorReasons.push('当前执行器不能直接切换协议引擎，需先交接并创建兼容执行器。')
  if (profile.engine && profile.engine !== provider.engine) executorReasons.push('模型配置与所选执行器的协议引擎不匹配。')
  if (requirements.requiresTools && executor && !['request', 'result', 'effect'].every((capability) => executor.capabilities.tool.includes(capability))) {
    executorReasons.push('执行器缺少完整的工具请求、结果或操作记录能力。')
  }
  let protocol: FrozenNativeProtocol | undefined
  try {
    const requestedModel = input.requestedModel ?? profile.model
    protocol = resolveNativeExecutorProtocol(provider, requestedModel)
    if (input.expectedProtocol && protocol !== input.expectedProtocol) executorReasons.push('有效连接协议与已选择的执行协议不匹配。')
    const target = resolveProviderRuntimeTarget(provider, { appId: provider.engine, model: requestedModel })
    const canonical = findConfiguredModelProfile(profile.model, provider.advancedConfig?.modelProfiles)?.model ?? profile.model
    const normalize = (model: string) => provider.engine === 'gemini' ? model.replace(/^models\//, '') : model
    if (normalize(target.model) !== normalize(canonical)) modelReasons.push('连接映射改变了候选模型，需按实际模型重新检查能力。')
  } catch {
    executorReasons.push('执行器无法解析有效连接与协议。')
  }
  if (profile.supportsText === false) modelReasons.push('指定模型仅声明媒体输出，不能执行文本任务。')
  // Unknown tool/vision capability is never promoted from the executor's support.
  if (requirements.requiresTools && !profile.supportsTools) modelReasons.push('模型尚未声明所需的工具调用能力。')
  if (requirements.requiresVision && !profile.supportsVision) modelReasons.push('模型尚未声明所需的图片理解能力。')
  if (requirements.minContextTokens !== undefined && profile.contextWindowTokens < requirements.minContextTokens) {
    modelReasons.push(`模型上下文不足 ${requirements.minContextTokens} tokens。`)
  }
  return { compatible: modelReasons.length === 0 && executorReasons.length === 0, modelReasons, executorReasons, protocol }
}
