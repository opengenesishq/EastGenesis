import { normalizeProviderMediaPricing } from '../media/media-pricing'
import type {
  ProviderAdvancedConfig,
  ProviderAuthorization,
  ProviderModelPricing,
  ProviderModelProfile
} from '../../shared/types'
import type { ProviderBalanceQueryConfig, ProviderBalanceResponseConfig } from '../../shared/provider-balance-types'
import type {
  ProviderBillingPeriodParameter,
  ProviderBillingQueryConfig,
  ProviderBillingQueryResponseConfig
} from '../../shared/provider-billing-query-types'

const MAX_CONFIG_BYTES = 256 * 1024
const MAX_ENDPOINTS = 32
const MAX_MODELS = 500
const MAX_APPS = 32
const MAX_BALANCE_HEADERS = 16
const MAX_BALANCE_QUERY = 32
const SECRET_KEY = /(?:api.?key|token|secret|password|credential|authorization|cookie|private.?key|encrypted)/i
const BALANCE_POINTER = /^(?:|(?:\/(?:[^~/]|~[01])*)+?)$/
const BALANCE_CREDENTIAL_VALUE = /(?:bearer\s+|sk[-_]|token\s*[:=]|api[-_]?key\s*[:=])/i
const REQUEST_PROTECTED_BODY_FIELDS = new Set([
  'model', 'input', 'messages', 'tools', 'tool_choice', 'max_tokens', 'stream', 'stream_options',
  'previous_response_id', 'instructions', 'system'
])

export function normalizeProviderAuthorization(value: unknown): ProviderAuthorization | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('Provider authorization must be an object')
  if (value.provider !== undefined && value.provider !== 'xai-oauth') return undefined
  const method = oneOf(value.method, ['api-key', 'oauth', 'device-code', 'none'] as const, 'authorization method')
  const status = oneOf(value.status, ['unconfigured', 'authorized', 'expired', 'revoked', 'error'] as const, 'authorization status')
  const result: ProviderAuthorization = {
    schemaVersion: 1,
    method,
    status,
    provider: value.provider === undefined
      ? undefined
      : oneOf(value.provider, ['xai-oauth'] as const, 'authorization provider'),
    accountId: optionalId(value.accountId, 'authorization account id'),
    accountLabel: optionalText(value.accountLabel, 160, 'authorization account label'),
    expiresAt: optionalTimestamp(value.expiresAt, 'authorization expiry'),
    lastAuthenticatedAt: optionalTimestamp(value.lastAuthenticatedAt, 'authorization timestamp'),
    lastErrorCode: optionalIdentifier(value.lastErrorCode, 'authorization error code'),
    accountRoutingMode: value.accountRoutingMode === undefined
      ? undefined
      : oneOf(value.accountRoutingMode, ['manual', 'preferred', 'automatic'] as const, 'authorization account routing mode')
  }
  return stripUndefined(result)
}

export function normalizeProviderAdvancedConfig(value: unknown): ProviderAdvancedConfig | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('Provider advanced config must be an object')
  const endpoints = optionalArray(value.endpoints, 'endpoints', MAX_ENDPOINTS)?.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Provider endpoint ${index + 1} must be an object`)
    const id = requiredId(item.id, `endpoint ${index + 1} id`)
    const url = normalizeEndpointUrl(item.url, `endpoint ${id} URL`)
    const protocol = item.protocol === undefined ? undefined : oneOf(item.protocol, ['responses', 'chat'] as const, `endpoint ${id} protocol`)
    const region = optionalText(item.region, 128, `endpoint ${id} region`)
    const domain = optionalText(item.domain, 253, `endpoint ${id} domain`)
    const permissionTags = optionalArray(item.permissionTags, `endpoint ${id} permission tags`, 32)?.map((tag, tagIndex) => {
      if (typeof tag !== 'string') throw new Error(`endpoint ${id} permission tag ${tagIndex + 1} must be text`)
      return tag.trim().toLowerCase()
    }).filter(Boolean)
    return stripUndefined({
      id,
      url,
      priority: optionalInteger(item.priority, `endpoint ${id} priority`),
      enabled: item.enabled === undefined ? true : booleanValue(item.enabled, `endpoint ${id} enabled`),
      protocol, region, domain, permissionTags
    })
  })
  const modelProfiles = optionalArray(value.modelProfiles, 'modelProfiles', MAX_MODELS)?.map((item, index) => normalizeModelProfile(item, index))
  assertUniqueEndpointIds(endpoints)
  assertUniqueModelNames(modelProfiles)
  const appBindings = normalizeAppBindings(value.appBindings)
  assertAppBindingEndpoints(appBindings, endpoints)
  const runtime = normalizeRuntime(value.runtime)
  const request = normalizeRequest(value.request)
  const balanceQuery = normalizeProviderBalanceQuery(value.balanceQuery)
  const billingQuery = normalizeProviderBillingQuery(value.billingQuery)
  const reliability = normalizeReliability(value.reliability)
  const metadata = normalizeStringMap(value.metadata, 'metadata', 64, 240)
  const result: ProviderAdvancedConfig = stripUndefined({
    schemaVersion: 1,
    endpoints,
    modelProfiles,
    appBindings,
    runtime,
    request,
    balanceQuery,
    billingQuery,
    reliability,
    metadata
  })
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_CONFIG_BYTES) {
    throw new Error(`Provider advanced config cannot exceed ${MAX_CONFIG_BYTES} bytes`)
  }
  return result
}

function normalizeReliability(value: unknown): ProviderAdvancedConfig['reliability'] | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('Provider reliability config must be an object')
  const circuit = value.circuitBreaker
  if (circuit !== undefined && circuit !== null && !isRecord(circuit)) {
    throw new Error('Provider circuit breaker config must be an object')
  }
  return stripUndefined({
    failoverEnabled: value.failoverEnabled === undefined
      ? undefined
      : booleanValue(value.failoverEnabled, 'Provider failover enabled'),
    maxRetries: optionalIntegerInRange(value.maxRetries, 0, 20, 'Provider maximum retries'),
    streamingFirstByteTimeoutSeconds: optionalIntegerInRange(
      value.streamingFirstByteTimeoutSeconds, 1, 3_600, 'Provider streaming first-byte timeout'
    ),
    streamingIdleTimeoutSeconds: optionalIntegerInRange(
      value.streamingIdleTimeoutSeconds, 1, 3_600, 'Provider streaming idle timeout'
    ),
    requestTimeoutSeconds: optionalIntegerInRange(
      value.requestTimeoutSeconds, 1, 3_600, 'Provider request timeout'
    ),
    circuitBreaker: !isRecord(circuit) ? undefined : {
      failureThreshold: requiredIntegerInRange(circuit.failureThreshold, 1, 20, 'Provider circuit failure threshold'),
      successThreshold: requiredIntegerInRange(circuit.successThreshold, 1, 10, 'Provider circuit success threshold'),
      timeoutSeconds: requiredIntegerInRange(circuit.timeoutSeconds, 0, 300, 'Provider circuit timeout'),
      errorRateThreshold: requiredNumberInRange(circuit.errorRateThreshold, 0.01, 1, 'Provider circuit error rate'),
      minRequests: requiredIntegerInRange(circuit.minRequests, 1, 100, 'Provider circuit minimum requests')
    }
  })
}

function normalizeRuntime(value: unknown): ProviderAdvancedConfig['runtime'] | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('Provider runtime config must be an object')
  const runtime = stripUndefined({
    reasoningEffort: value.reasoningEffort === undefined
      ? undefined
      : oneOf(value.reasoningEffort, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const, 'reasoning effort'),
    verbosity: value.verbosity === undefined
      ? undefined
      : oneOf(value.verbosity, ['low', 'medium', 'high'] as const, 'output verbosity'),
    temperature: optionalNumberInRange(value.temperature, 0, 2, 'temperature'),
    topP: optionalNumberInRange(value.topP, 0, 1, 'top P'),
    maxOutputTokens: optionalInteger(value.maxOutputTokens, 'maximum output tokens', 1),
    parallelToolCalls: value.parallelToolCalls === undefined
      ? undefined
      : booleanValue(value.parallelToolCalls, 'parallel tool calls'),
    storeResponses: value.storeResponses === undefined
      ? undefined
      : booleanValue(value.storeResponses, 'response storage'),
    serviceTier: value.serviceTier === undefined
      ? undefined
      : oneOf(value.serviceTier, ['auto', 'default', 'flex', 'priority'] as const, 'service tier'),
    anthropic: normalizeAnthropicRuntime(value.anthropic),
    gemini: normalizeGeminiRuntime(value.gemini)
  })
  const thinking = runtime.anthropic?.thinking
  if (
    thinking?.mode === 'enabled' &&
    runtime.maxOutputTokens !== undefined &&
    thinking.budgetTokens !== undefined &&
    thinking.budgetTokens >= runtime.maxOutputTokens
  ) {
    throw new Error('Anthropic thinking budget must be less than maximum output tokens')
  }
  return runtime
}

function normalizeGeminiRuntime(
  value: unknown
): NonNullable<ProviderAdvancedConfig['runtime']>['gemini'] | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('Gemini runtime config must be an object')
  return stripUndefined({
    topK: optionalIntegerInRange(value.topK, 1, 1_000_000, 'Gemini top K'),
    thinking: normalizeGeminiThinking(value.thinking)
  })
}

function normalizeGeminiThinking(
  value: unknown
): NonNullable<NonNullable<ProviderAdvancedConfig['runtime']>['gemini']>['thinking'] | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('Gemini thinking config must be an object')
  const budgetTokens = value.budgetTokens === undefined
    ? undefined
    : requiredIntegerInRange(value.budgetTokens, -1, 1_000_000, 'Gemini thinking budget')
  const level = value.level === undefined
    ? undefined
    : oneOf(value.level, ['minimal', 'low', 'medium', 'high'] as const, 'Gemini thinking level')
  if (budgetTokens !== undefined && level !== undefined) {
    throw new Error('Gemini thinking budget and thinking level cannot be configured together')
  }
  return stripUndefined({
    includeThoughts: value.includeThoughts === undefined
      ? undefined
      : booleanValue(value.includeThoughts, 'Gemini include thoughts'),
    budgetTokens,
    level
  })
}

function normalizeAnthropicRuntime(
  value: unknown
): NonNullable<ProviderAdvancedConfig['runtime']>['anthropic'] | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('Anthropic runtime config must be an object')
  const thinking = normalizeAnthropicThinking(value.thinking)
  const promptCaching = normalizeAnthropicPromptCaching(value.promptCaching)
  return stripUndefined({
    thinking,
    promptCaching,
    topK: optionalIntegerInRange(value.topK, 1, 1_000_000, 'Anthropic top K')
  })
}

function normalizeAnthropicThinking(
  value: unknown
): NonNullable<NonNullable<ProviderAdvancedConfig['runtime']>['anthropic']>['thinking'] | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('Anthropic thinking config must be an object')
  const mode = oneOf(value.mode, ['disabled', 'adaptive', 'enabled'] as const, 'Anthropic thinking mode')
  const budgetTokens = value.budgetTokens === undefined
    ? undefined
    : optionalIntegerInRange(value.budgetTokens, 1_024, 1_000_000, 'Anthropic thinking budget')
  const display = value.display === undefined
    ? undefined
    : oneOf(value.display, ['summarized', 'omitted'] as const, 'Anthropic thinking display')
  if (mode === 'enabled' && budgetTokens === undefined) {
    throw new Error('Anthropic enabled thinking requires a token budget')
  }
  if (mode !== 'enabled' && budgetTokens !== undefined) {
    throw new Error('Anthropic thinking budget requires enabled mode')
  }
  if (mode === 'disabled' && display !== undefined) {
    throw new Error('Anthropic disabled thinking cannot configure display')
  }
  return stripUndefined({ mode, budgetTokens, display })
}

function normalizeAnthropicPromptCaching(
  value: unknown
): NonNullable<NonNullable<ProviderAdvancedConfig['runtime']>['anthropic']>['promptCaching'] | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('Anthropic prompt caching config must be an object')
  const enabled = booleanValue(value.enabled, 'Anthropic prompt caching enabled')
  const ttl = value.ttl === undefined
    ? undefined
    : oneOf(value.ttl, ['5m', '1h'] as const, 'Anthropic prompt cache TTL')
  const strategy = value.strategy === undefined
    ? undefined
    : oneOf(
      value.strategy,
      ['automatic', 'system', 'tools', 'last-user'] as const,
      'Anthropic prompt cache strategy'
    )
  if (!enabled && (ttl !== undefined || strategy !== undefined)) {
    throw new Error('Disabled Anthropic prompt caching cannot configure TTL or strategy')
  }
  return stripUndefined({ enabled, ttl, strategy })
}

export function normalizeProviderBalanceQuery(value: unknown): ProviderBalanceQueryConfig | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('Provider balanceQuery must be an object')
  const path = requiredText(value.path, 512, 'balance query path')
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) {
    throw new Error('balance query path must be a relative path without query or fragment')
  }
  const method = value.method === undefined ? 'GET' : oneOf(value.method, ['GET', 'POST'] as const, 'balance query method')
  const credentialMode = value.credentialMode === undefined
    ? 'provider'
    : oneOf(value.credentialMode, ['provider', 'none'] as const, 'balance query credential mode')
  const keyLabel = optionalText(value.keyLabel, 160, 'balance query key label')
  if (credentialMode === 'none' && keyLabel) throw new Error('balance query key label requires provider credentials')
  const headers = normalizeBalanceHeaders(value.headers)
  const query = normalizeStringMap(value.query, 'balance query parameters', MAX_BALANCE_QUERY, 240)
  const body = value.body === undefined ? undefined : sanitizeJsonObject(value.body, 'balance query body', 0)
  assertNoBalanceCredentialValues(query, 'balance query parameters')
  assertNoBalanceCredentialValues(body, 'balance query body')
  const response = normalizeBalanceResponse(value.response)
  return stripUndefined({ path, method, credentialMode, keyLabel, headers, query, body, response })
}

export function normalizeProviderBillingQuery(value: unknown): ProviderBillingQueryConfig | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('Provider billingQuery must be an object')
  const path = requiredText(value.path, 512, 'billing query path')
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) {
    throw new Error('billing query path must be a relative path without query or fragment')
  }
  const method = value.method === undefined
    ? 'GET'
    : oneOf(value.method, ['GET', 'POST'] as const, 'billing query method')
  const credentialMode = value.credentialMode === undefined
    ? 'provider'
    : oneOf(value.credentialMode, ['provider', 'none'] as const, 'billing query credential mode')
  const keyLabel = optionalText(value.keyLabel, 160, 'billing query key label')
  if (credentialMode === 'none' && keyLabel) throw new Error('billing query key label requires provider credentials')
  const headers = normalizeBalanceHeaders(value.headers)
  const query = normalizeStringMap(value.query, 'billing query parameters', MAX_BALANCE_QUERY, 240)
  const body = value.body === undefined ? undefined : sanitizeJsonObject(value.body, 'billing query body', 0)
  assertNoBalanceCredentialValues(query, 'billing query parameters')
  assertNoBalanceCredentialValues(body, 'billing query body')
  const periodStart = normalizeBillingPeriodParameter(value.periodStart, method, 'start')
  const periodEnd = normalizeBillingPeriodParameter(value.periodEnd, method, 'end')
  if (billingPeriodIdentity(periodStart) === billingPeriodIdentity(periodEnd)) {
    throw new Error('billing query period parameters must use different names')
  }
  const response = normalizeBillingResponse(value.response)
  return stripUndefined({
    path, method, credentialMode, keyLabel, headers, query, body, periodStart, periodEnd, response
  })
}

function normalizeBillingPeriodParameter(
  value: unknown,
  method: ProviderBillingQueryConfig['method'],
  label: string
): ProviderBillingPeriodParameter {
  if (!isRecord(value)) throw new Error(`billing query ${label} period parameter must be an object`)
  const target = oneOf(value.target, ['query', 'body'] as const, `billing query ${label} target`)
  if (target === 'body' && method !== 'POST') {
    throw new Error('billing query body period parameters require POST')
  }
  const format = oneOf(
    value.format,
    ['unix-seconds', 'unix-ms', 'iso'] as const,
    `billing query ${label} period format`
  )
  if (target === 'query') {
    const name = requiredText(value.name, 80, `billing query ${label} parameter name`)
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || SECRET_KEY.test(name)) {
      throw new Error(`billing query ${label} parameter name is invalid`)
    }
    return { target, name, format }
  }
  const path = optionalBalancePointer(value.path, `billing query ${label} body path`)
  if (!path || path === '/' || path.split('/').some((segment) =>
    ['__proto__', 'prototype', 'constructor'].includes(segment.toLowerCase()))) {
    throw new Error(`billing query ${label} body path is invalid`)
  }
  return { target, path, format }
}

function billingPeriodIdentity(parameter: ProviderBillingPeriodParameter): string {
  return parameter.target === 'query' ? `query:${parameter.name}` : `body:${parameter.path}`
}

function normalizeBillingResponse(value: unknown): ProviderBillingQueryResponseConfig {
  if (!isRecord(value)) throw new Error('billing query response must be an object')
  const amountPath = optionalBalancePointer(value.amountPath, 'billing response amount path')
  if (!amountPath) throw new Error('billing response amountPath is required')
  const currencyPath = optionalBalancePointer(value.currencyPath, 'billing response currency path')
  const currency = value.currency === undefined
    ? undefined
    : oneOf(value.currency, ['USD'] as const, 'billing response currency')
  if (!currency && !currencyPath) throw new Error('billing response requires USD currency or currencyPath')
  return stripUndefined({
    itemsPath: optionalBalancePointer(value.itemsPath, 'billing response items path'),
    amountPath,
    currencyPath,
    currency,
    scale: value.scale === undefined ? undefined : positiveNumber(value.scale, 'billing response scale', 1_000_000)
  })
}

function normalizeBalanceResponse(value: unknown): ProviderBalanceResponseConfig {
  if (!isRecord(value)) throw new Error('balance query response must be an object')
  const result = stripUndefined({
    itemsPath: optionalBalancePointer(value.itemsPath, 'balance response items path'),
    labelPath: optionalBalancePointer(value.labelPath, 'balance response label path'),
    label: optionalText(value.label, 160, 'balance response label'),
    unitPath: optionalBalancePointer(value.unitPath, 'balance response unit path'),
    unit: optionalText(value.unit, 32, 'balance response unit'),
    remainingPath: optionalBalancePointer(value.remainingPath, 'balance response remaining path'),
    totalPath: optionalBalancePointer(value.totalPath, 'balance response total path'),
    usedPath: optionalBalancePointer(value.usedPath, 'balance response used path'),
    validPath: optionalBalancePointer(value.validPath, 'balance response valid path'),
    scale: value.scale === undefined ? undefined : positiveNumber(value.scale, 'balance response scale', 1_000_000)
  })
  if (!result.remainingPath && !result.totalPath && !result.usedPath) {
    throw new Error('balance response needs remainingPath, totalPath, or usedPath')
  }
  return result
}

function normalizeBalanceHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('balance query headers must be an object')
  const entries = Object.entries(value)
  if (entries.length > MAX_BALANCE_HEADERS) throw new Error('balance query has too many headers')
  const result: Record<string, string> = {}
  for (const [key, raw] of entries) {
    const normalized = key.trim().toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/.test(key) || SECRET_KEY.test(key)
      || !isBalanceMetadataHeader(normalized)) {
      throw new Error(`balance query header is not safe: ${key}`)
    }
    const valueText = requiredText(raw, 240, `balance query header ${key}`)
    if (BALANCE_CREDENTIAL_VALUE.test(valueText)) throw new Error(`balance query header value is credential-like: ${key}`)
    result[normalized] = valueText
  }
  return result
}

function isBalanceMetadataHeader(name: string): boolean {
  return new Set(['accept', 'accept-encoding', 'content-type', 'origin', 'referer', 'user-agent']).has(name)
    || /^(?:(?:x-)?(?:account|channel|correlation|debug|deployment|experiment|feature|gateway|meta|metadata|model|org|organization|project|provider|region|request|route|routing|source|tag|tenant|trace|vendor|version|workspace)(?:-|$)|helicone-property-)/i.test(name)
}

function optionalBalancePointer(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const pointer = requiredText(value, 240, label)
  if (!BALANCE_POINTER.test(pointer)) throw new Error(`${label} is not a valid JSON pointer`)
  return pointer
}

function positiveNumber(value: unknown, label: string, maximum: number): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0 || number > maximum) throw new Error(`${label} is invalid`)
  return number
}

function assertNoBalanceCredentialValues(value: unknown, label: string): void {
  if (typeof value === 'string') {
    if (BALANCE_CREDENTIAL_VALUE.test(value)) throw new Error(`${label} contains a credential-like value`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoBalanceCredentialValues(item, label))
    return
  }
  if (isRecord(value)) Object.values(value).forEach((item) => assertNoBalanceCredentialValues(item, label))
}

export function providerPricingForModel(
  config: ProviderAdvancedConfig | undefined,
  model: string
): ProviderModelPricing | undefined {
  const normalized = model.trim().toLowerCase()
  if (!normalized || !config?.modelProfiles) return undefined
  const profile = config.modelProfiles.find((candidate) =>
    candidate.model.toLowerCase() === normalized || (candidate.aliases ?? []).some((alias) => alias.toLowerCase() === normalized)
  )
  return profile?.pricing
}

export function estimateProviderCostUsd(
  pricing: ProviderModelPricing | undefined,
  usage: { input: number; output: number; cacheRead: number; cacheCreation: number }
): number | undefined {
  if (!pricing) return undefined
  const cost = (
    usage.input * pricing.inputPerMillion +
    usage.output * pricing.outputPerMillion +
    usage.cacheRead * (pricing.cacheReadPerMillion ?? pricing.inputPerMillion) +
    usage.cacheCreation * (pricing.cacheWritePerMillion ?? pricing.inputPerMillion)
  ) / 1_000_000
  return Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 1_000_000) / 1_000_000 : undefined
}

export function builtinOpenAiPricingForModel(model: string | undefined): ProviderModelPricing {
  const normalized = (model ?? '').toLowerCase()
  if (normalized.includes('gpt-4o-mini')) {
    return pricing(0.15, 0.6, 0.075)
  }
  if (normalized.includes('gpt-4o')) {
    return pricing(2.5, 10, 1.25)
  }
  if (normalized.includes('gpt-4.1-mini')) {
    return pricing(0.4, 1.6, 0.1)
  }
  if (normalized.includes('gpt-4.1-nano')) {
    return pricing(0.1, 0.4, 0.025)
  }
  return pricing(2, 8, 0.5)
}

function pricing(input: number, output: number, cacheRead: number): ProviderModelPricing {
  return {
    currency: 'USD',
    inputPerMillion: input,
    outputPerMillion: output,
    cacheReadPerMillion: cacheRead,
    cacheWritePerMillion: input,
    source: 'builtin'
  }
}

function normalizeModelProfile(value: unknown, index: number): ProviderModelProfile {
  if (!isRecord(value)) throw new Error(`Provider model profile ${index + 1} must be an object`)
  const model = requiredText(value.model, 240, `model profile ${index + 1} model`)
  const aliases = optionalStringArray(value.aliases, `model profile ${model} aliases`, 16, 240)
  const capabilities = optionalStringArray(value.capabilities, `model profile ${model} capabilities`, 32, 80)
  const pricing = value.pricing === undefined ? undefined : normalizePricing(value.pricing, model)
  const verification = normalizeModelVerification(value.verification, model)
  return stripUndefined({
    model,
    displayName: optionalText(value.displayName, 240, `model profile ${model} display name`),
    aliases,
    pricing,
    mediaPricing: normalizeProviderMediaPricing(value.mediaPricing),
    contextWindow: optionalInteger(value.contextWindow, `model profile ${model} context window`, 1),
    capabilities,
    verification
  })
}

function normalizeModelVerification(value: unknown, model: string): ProviderModelProfile['verification'] {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(`Verification for model ${model} must be an object`)
  const generation = oneOf(value.generation, ['passed', 'failed'] as const, `verification generation for ${model}`)
  const outcome = oneOf(value.outcome, ['success', 'auth', 'rate_limit', 'server', 'network', 'not_found', 'invalid_request', 'invalid_response'] as const, `verification outcome for ${model}`)
  const protocol = oneOf(value.protocol, ['openai-responses', 'openai-chat-completions', 'anthropic-messages', 'google-generative-language'] as const, `verification protocol for ${model}`)
  const verifiedAt = optionalTimestamp(value.verifiedAt, `verification timestamp for ${model}`)
  if (verifiedAt === undefined) throw new Error(`Verification timestamp for model ${model} is required`)
  const responseValidation = value.responseValidation === undefined ? undefined
    : oneOf(value.responseValidation, ['protocol-json-v1'] as const, `verification response validation for ${model}`)
  return { generation, outcome, protocol, verifiedAt, ...(responseValidation ? { responseValidation } : {}) }
}

function normalizePricing(value: unknown, model: string): ProviderModelPricing {
  if (!isRecord(value)) throw new Error(`Pricing for model ${model} must be an object`)
  const currency = value.currency === undefined ? 'USD' : value.currency
  if (currency !== 'USD') throw new Error(`Pricing for model ${model} must use USD`) 
  const source = oneOf(value.source ?? 'user', ['builtin', 'provider', 'catalog', 'user'] as const, `pricing source for ${model}`)
  return stripUndefined({
    currency: 'USD' as const,
    inputPerMillion: nonNegativeNumber(value.inputPerMillion, `input price for ${model}`),
    outputPerMillion: nonNegativeNumber(value.outputPerMillion, `output price for ${model}`),
    cacheReadPerMillion: optionalNonNegativeNumber(value.cacheReadPerMillion, `cache-read price for ${model}`),
    cacheWritePerMillion: optionalNonNegativeNumber(value.cacheWritePerMillion, `cache-write price for ${model}`),
    source,
    updatedAt: optionalTimestamp(value.updatedAt, `pricing timestamp for ${model}`)
  })
}

function normalizeEndpointUrl(value: unknown, label: string): string {
  const text = requiredText(value, 2048, label)
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new Error(`${label} is invalid`)
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
    throw new Error(`${label} is invalid`)
  }
  for (const key of parsed.searchParams.keys()) {
    if (SECRET_KEY.test(key)) throw new Error(`${label} contains a credential-like query field`)
  }
  return parsed.toString().replace(/\/$/, '')
}

function assertUniqueEndpointIds(endpoints: ProviderAdvancedConfig['endpoints']): void {
  const ids = new Set<string>()
  for (const endpoint of endpoints ?? []) {
    const normalized = endpoint.id.toLowerCase()
    if (ids.has(normalized)) throw new Error(`Provider endpoint id is duplicated: ${endpoint.id}`)
    ids.add(normalized)
  }
}

function assertUniqueModelNames(modelProfiles: ProviderAdvancedConfig['modelProfiles']): void {
  const names = new Set<string>()
  for (const profile of modelProfiles ?? []) {
    for (const name of [profile.model, ...(profile.aliases ?? [])]) {
      const normalized = name.toLowerCase()
      if (names.has(normalized)) throw new Error(`Provider model or alias is duplicated: ${name}`)
      names.add(normalized)
    }
  }
}

function normalizeAppBindings(value: unknown): Record<string, NonNullable<ProviderAdvancedConfig['appBindings']>[string]> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('Provider appBindings must be an object')
  const entries = Object.entries(value)
  if (entries.length > MAX_APPS) throw new Error(`Provider appBindings cannot exceed ${MAX_APPS} apps`)
  const result: Record<string, NonNullable<ProviderAdvancedConfig['appBindings']>[string]> = {}
  for (const [app, binding] of entries) {
    const appId = requiredText(app, 80, 'app binding id')
    if (!isRecord(binding)) throw new Error(`Provider app binding ${appId} must be an object`)
    const modelMap = normalizeStringMap(binding.modelMap, `model map for ${appId}`, 500, 240)
    result[appId] = stripUndefined({
      accountId: optionalId(binding.accountId, `account binding for ${appId}`),
      endpointId: optionalId(binding.endpointId, `endpoint binding for ${appId}`),
      modelMap
    })
  }
  return result
}

function assertAppBindingEndpoints(
  bindings: ProviderAdvancedConfig['appBindings'],
  endpoints: ProviderAdvancedConfig['endpoints']
): void {
  if (!bindings) return
  const ids = new Set((endpoints ?? []).map((endpoint) => endpoint.id.toLowerCase()))
  for (const [app, binding] of Object.entries(bindings)) {
    if (binding.endpointId && !ids.has(binding.endpointId.toLowerCase())) {
      throw new Error(`Provider app binding ${app} references an unknown endpoint: ${binding.endpointId}`)
    }
  }
}

function normalizeRequest(value: unknown): ProviderAdvancedConfig['request'] | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('Provider request overrides must be an object')
  const headers = normalizeStringMap(value.headers, 'request headers', 32, 240, true)
  const query = normalizeStringMap(value.query, 'request query', 32, 240)
  const body = value.body === undefined ? undefined : sanitizeJsonObject(value.body, 'request body', 0)
  for (const key of Object.keys(body ?? {})) {
    if (REQUEST_PROTECTED_BODY_FIELDS.has(key)) throw new Error(`request body cannot override protected field: ${key}`)
  }
  return stripUndefined({ headers, query, body })
}

function normalizeStringMap(
  value: unknown,
  label: string,
  maxEntries: number,
  maxValueLength: number,
  rejectCredentialHeaders = false
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  const entries = Object.entries(value)
  if (entries.length > maxEntries) throw new Error(`${label} has too many entries`)
  const result: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (!/^[-A-Za-z0-9_.]{1,120}$/.test(key) || SECRET_KEY.test(key) || (rejectCredentialHeaders && /^(authorization|proxy-authorization|x-api-key|api-key)$/i.test(key))) {
      throw new Error(`${label} contains a credential or invalid key: ${key}`)
    }
    result[key] = requiredText(raw, maxValueLength, `${label} ${key}`)
  }
  return result
}

function sanitizeJsonObject(value: unknown, label: string, depth: number): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  if (depth > 6) throw new Error(`${label} is nested too deeply`)
  const result: Record<string, unknown> = {}
  const entries = Object.entries(value)
  if (entries.length > 64) throw new Error(`${label} has too many fields`)
  for (const [key, child] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(key) || SECRET_KEY.test(key)) throw new Error(`${label} contains a credential-like key: ${key}`)
    result[key] = sanitizeJsonValue(child, `${label}.${key}`, depth + 1)
  }
  return result
}

function sanitizeJsonValue(value: unknown, label: string, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return requiredText(value, 4000, label)
  if (Array.isArray(value)) {
    if (value.length > 64) throw new Error(`${label} has too many items`)
    return value.map((item, index) => sanitizeJsonValue(item, `${label}[${index}]`, depth + 1))
  }
  return sanitizeJsonObject(value, label, depth)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredText(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  const text = value.trim()
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} is invalid`)
  return text
}

function optionalText(value: unknown, maxLength: number, label: string): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : requiredText(value, maxLength, label)
}

function requiredId(value: unknown, label: string): string {
  const id = requiredText(value, 120, label)
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error(`${label} is invalid`)
  return id
}

function optionalId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredId(value, label)
}

function optionalIdentifier(value: unknown, label: string): string | undefined {
  const text = optionalText(value, 120, label)
  if (text && !/^[A-Za-z0-9._:-]+$/.test(text)) throw new Error(`${label} is invalid`)
  return text
}

function optionalTimestamp(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  const timestamp = Number(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error(`${label} is invalid`)
  return timestamp
}

function optionalInteger(value: unknown, label: string, minimum = 0): number | undefined {
  if (value === undefined || value === null) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`${label} is invalid`)
  return number
}

function optionalIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string
): number | undefined {
  if (value === undefined || value === null) return undefined
  return requiredIntegerInRange(value, minimum, maximum, label)
}

function requiredIntegerInRange(value: unknown, minimum: number, maximum: number, label: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error(`${label} is invalid`)
  return number
}

function requiredNumberInRange(value: unknown, minimum: number, maximum: number, label: string): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${label} is invalid`)
  return number
}

function nonNegativeNumber(value: unknown, label: string): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1_000_000) throw new Error(`${label} is invalid`)
  return number
}

function optionalNonNegativeNumber(value: unknown, label: string): number | undefined {
  return value === undefined || value === null ? undefined : nonNegativeNumber(value, label)
}

function optionalNumberInRange(value: unknown, minimum: number, maximum: number, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${label} is invalid`)
  return number
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`)
  return value
}

function optionalArray(value: unknown, label: string, max: number): unknown[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} is invalid`)
  return value
}

function optionalStringArray(value: unknown, label: string, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} is invalid`)
  return [...new Set(value.map((item) => requiredText(item, maxLength, label)))]
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (!values.includes(value as T)) throw new Error(`${label} is invalid`)
  return value as T
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as T
}
