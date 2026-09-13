import type {
  OpenAIProtocol,
  Provider,
  ProviderAdvancedConfig,
  ProviderAppBinding,
  ProviderEndpointProfile,
  ProviderModelProfile
} from '../../shared/types'

export interface ProviderRuntimeTarget {
  baseUrl: string
  model: string
  protocol?: OpenAIProtocol
  endpointId?: string
  appBindingId?: string
  accountId?: string
  region?: string
  domain?: string
  permissionTags?: string[]
}

/** Resolve the effective OpenAI wire protocol without exposing or mutating Provider configuration. */
export function resolveOpenAIProtocol(
  target: Pick<ProviderRuntimeTarget, 'baseUrl' | 'protocol'>
): OpenAIProtocol {
  if (target.protocol === 'chat' || target.protocol === 'responses') return target.protocol
  const baseUrl = target.baseUrl.trim()
  if (!baseUrl) return 'responses'
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.openai.com' ? 'responses' : 'chat'
  } catch {
    return 'chat'
  }
}

/** Resolve the non-secret endpoint/model portion of a saved Provider for one application surface. */
export function resolveProviderRuntimeTarget(
  provider: Pick<Provider, 'baseUrl' | 'models' | 'openaiProtocol' | 'advancedConfig'>,
  input: { appId?: string; model?: string }
): ProviderRuntimeTarget {
  const bindingMatch = findAppBinding(provider.advancedConfig?.appBindings, input.appId)
  const endpoint = selectEndpoint(provider.advancedConfig?.endpoints, bindingMatch?.binding.endpointId)
  const requestedModel = requestedProviderModel(input.model, provider.models)
  const mappedModel = mapModel(requestedModel, bindingMatch?.binding.modelMap)
  const model = resolveModelAlias(mappedModel, provider.advancedConfig?.modelProfiles)

  return {
    baseUrl: endpoint?.url ?? provider.baseUrl,
    model,
    protocol: endpoint?.protocol ?? provider.openaiProtocol,
    endpointId: endpoint?.id,
    appBindingId: bindingMatch?.id,
    accountId: bindingMatch?.binding.accountId,
    // Keep optional routing metadata absent when it was not configured. This
    // preserves the legacy runtime-target shape while exposing metadata for
    // endpoints that opt into region/domain/permission policy checks.
    ...(endpoint?.region ? { region: endpoint.region } : {}),
    ...(endpoint?.domain ? { domain: endpoint.domain } : {}),
    ...(endpoint?.permissionTags?.length ? { permissionTags: [...endpoint.permissionTags] } : {})
  }
}

function findAppBinding(
  bindings: ProviderAdvancedConfig['appBindings'],
  appId: string | undefined
): { id: string; binding: ProviderAppBinding } | undefined {
  if (!bindings) return undefined
  const candidates = [appId, 'caogen', 'default'].filter((item, index, list): item is string =>
    Boolean(item) && list.indexOf(item) === index
  )
  for (const candidate of candidates) {
    const exact = Object.entries(bindings).find(([id]) => id.toLowerCase() === candidate.toLowerCase())
    if (exact) return { id: exact[0], binding: exact[1] }
  }
  return undefined
}

function selectEndpoint(
  endpoints: ProviderEndpointProfile[] | undefined,
  endpointId: string | undefined
): ProviderEndpointProfile | undefined {
  if (!endpoints?.length) return undefined
  if (endpointId) {
    const bound = endpoints.find((endpoint) => endpoint.id.toLowerCase() === endpointId.toLowerCase())
    if (!bound || bound.enabled === false) throw new Error(`Provider endpoint binding is unavailable: ${endpointId}`)
    return bound
  }
  return endpoints
    .map((endpoint, index) => ({ endpoint, index }))
    .filter(({ endpoint }) => endpoint.enabled !== false)
    .sort((left, right) => (left.endpoint.priority ?? 0) - (right.endpoint.priority ?? 0) || left.index - right.index)[0]
    ?.endpoint
}

function requestedProviderModel(requested: string | undefined, models: string[]): string {
  const explicit = requested?.trim()
  const model = explicit && explicit !== 'auto' ? explicit : models.find((item) => item.trim())?.trim()
  return model ?? ''
}

function mapModel(model: string, modelMap: Record<string, string> | undefined): string {
  if (!model || !modelMap) return model
  const match = Object.entries(modelMap).find(([source]) => source.toLowerCase() === model.toLowerCase())
  return match?.[1]?.trim() || model
}

function resolveModelAlias(model: string, profiles: ProviderModelProfile[] | undefined): string {
  if (!model || !profiles) return model
  const normalized = model.toLowerCase()
  const profile = profiles.find((candidate) =>
    candidate.model.toLowerCase() === normalized
    || (candidate.aliases ?? []).some((alias) => alias.toLowerCase() === normalized)
  )
  return profile?.model ?? model
}
