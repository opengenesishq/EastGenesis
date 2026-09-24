import type {
  EngineKind,
  OpenAIProtocol,
  ProviderAuthMode,
  ProviderModelFailureReason,
  ProviderModelFetchAttempt,
  ProviderModelDiagnosticContext,
  ProviderModelErrorKind,
  ProviderModelFetchInput,
  ProviderModelFetchResult,
  ProviderModelSuggestedAction
} from '../../shared/types'
import { inspectProviderBaseUrl } from '../providerCredentialBroker'

interface ModelDiscoveryCredentials {
  token: string
  authMode: ProviderAuthMode
  credentialHeaderNames?: string[]
  customHeaderRejections: string[]
  headers: Record<string, string>
  source?: ProviderModelDiagnosticContext['credentialSource']
  label?: string
}

interface ModelDiscoveryHealth {
  success(providerId: string, latencyMs: number): void
  failure(providerId: string, message: string): void
}

interface ModelDiscoveryContext {
  startedAt: number
  providerId?: string
  base: string
  publicBaseUrl: string
  cacheKey: string
  rejectedBaseUrlNames: string[]
  requestedAuthMode: ProviderAuthMode
  requestedCredentialHeaderNames: string[]
  engine?: EngineKind
  openaiProtocol: OpenAIProtocol
}

interface ModelDiscoveryOutcome {
  models: string[] | null
  attempts: ProviderModelFetchAttempt[]
}

interface ModelFailureDiagnostic {
  reasonCode: ProviderModelFailureReason
  suggestedAction: ProviderModelSuggestedAction
  attempts?: ProviderModelFetchAttempt[]
  credentials?: ModelDiscoveryCredentials
}

type ResolveModelDiscoveryCredentials = (providerId: string | undefined) => ModelDiscoveryCredentials

const modelFetchCache = new Map<
  string,
  { models: string[]; fetchedAt: number; baseUrl: string; providerId?: string }
>()

export async function discoverProviderModels(
  opts: ProviderModelFetchInput,
  resolveCredentials: ResolveModelDiscoveryCredentials,
  health: ModelDiscoveryHealth
): Promise<ProviderModelFetchResult> {
  const context = createModelDiscoveryContext(opts)
  const invalidBase = invalidBaseUrlResult(context, health)
  if (invalidBase) return invalidBase

  const credentials = resolveCredentials(context.providerId)
  const invalidCredentials = invalidCredentialResult(context, credentials, health)
  if (invalidCredentials) return invalidCredentials

  const outcome = await fetchFirstModelList(context.base, credentials, context.engine)
  if (outcome.models) return successfulModelFetchResult(context, outcome.models, health)
  return failedOutcomeResult(context, credentials, outcome.attempts, health)
}

export function parseProviderHeaderLines(value: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of value.split(/\r?\n/)) {
    const colonIndex = line.indexOf(':')
    if (colonIndex <= 0) continue
    const name = line.slice(0, colonIndex).trim()
    const headerValue = line.slice(colonIndex + 1).trim()
    if (name) headers[name] = headerValue
  }
  return headers
}

function createModelDiscoveryContext(opts: ProviderModelFetchInput): ModelDiscoveryContext {
  const startedAt = Date.now()
  const rawBase = (opts.baseUrl || '').trim().replace(/\/+$/, '')
  const inspectedBase = inspectProviderBaseUrl(rawBase)
  const base = inspectedBase.safeValue.trim().replace(/\/+$/, '')
  const providerId = opts.providerId?.trim() || undefined
  return {
    startedAt,
    providerId,
    base,
    publicBaseUrl: redactBaseUrl(base),
    cacheKey: providerModelCacheKey(providerId, base, opts.openaiProtocol, opts.engine),
    rejectedBaseUrlNames: inspectedBase.rejectedNames,
    requestedAuthMode: opts.authMode ?? 'api-key',
    requestedCredentialHeaderNames: sanitizeHeaderNames(opts.credentialHeaderNames ?? []),
    engine: opts.engine,
    openaiProtocol: opts.openaiProtocol === 'chat' ? 'chat' : 'responses'
  }
}

function invalidBaseUrlResult(
  context: ModelDiscoveryContext,
  health: ModelDiscoveryHealth
): ProviderModelFetchResult | null {
  if (context.rejectedBaseUrlNames.length > 0) {
    return failedModelFetchResult(
      context,
      'gateway',
      `Base URL 包含不允许的凭据或参数: ${context.rejectedBaseUrlNames.join(', ')}`,
      health,
      undefined,
      {
        reasonCode: 'base_url_invalid',
        suggestedAction: 'review_configuration'
      }
    )
  }
  return context.base
    ? null
    : failedModelFetchResult(context, 'not_found', '请先填写 Base URL', health, undefined, {
      reasonCode: 'base_url_invalid',
      suggestedAction: 'review_configuration'
    })
}

function invalidCredentialResult(
  context: ModelDiscoveryContext,
  credentials: ModelDiscoveryCredentials,
  health: ModelDiscoveryHealth
): ProviderModelFetchResult | null {
  if (/[\0-\x1F\x7F]/.test(credentials.token)) {
    return failedModelFetchResult(context, 'auth', 'API 密钥格式无效', health, undefined, {
      reasonCode: 'credentials_rejected',
      suggestedAction: 'review_credentials',
      credentials
    })
  }
  if (credentials.customHeaderRejections.length > 0) {
    return failedModelFetchResult(
      context,
      'gateway',
      `自定义请求头无效或包含凭据: ${credentials.customHeaderRejections.join(', ')}`,
      health,
      undefined,
      {
        reasonCode: 'base_url_invalid',
        suggestedAction: 'review_configuration',
        credentials
      }
    )
  }
  return credentials.token || credentials.authMode === 'none'
    ? null
    : failedModelFetchResult(context, 'auth', '请先填写 API 密钥', health, undefined, {
      reasonCode: 'credentials_missing',
      suggestedAction: 'enter_credentials',
      credentials
    })
}

async function fetchFirstModelList(
  base: string,
  credentials: ModelDiscoveryCredentials,
  engine?: EngineKind
): Promise<ModelDiscoveryOutcome> {
  const attempts: ProviderModelFetchAttempt[] = []
  for (const url of modelEndpointCandidates(base, engine)) {
    const result = await tryFetchModelsFrom(url, credentials.headers, engine)
    attempts.push(result.attempt)
    if (result.models) return { models: result.models, attempts }
  }
  return { models: null, attempts }
}

function modelEndpointCandidates(base: string, engine?: EngineKind): string[] {
  const candidates: string[] = []
  const addCandidates = (candidateBase: string): void => {
    if (/\/models$/i.test(candidateBase)) {
      candidates.push(candidateBase)
      return
    }
    if (/\/v1(?:beta)?$/i.test(candidateBase)) {
      candidates.push(`${candidateBase}/models`)
      if (engine !== 'gemini') candidates.push(`${candidateBase.replace(/\/v1$/i, '')}/models`)
      return
    }
    if (engine === 'gemini') {
      candidates.push(`${candidateBase}/v1beta/models`)
      return
    }
    candidates.push(`${candidateBase}/v1/models`)
    candidates.push(`${candidateBase}/models`)
  }
  // Presets and imported clients sometimes store the generation endpoint
  // itself (for example Perplexity's `/chat/completions`) as the base URL.
  // Model discovery must remove that suffix before appending `/models`; doing
  // so here keeps runtime generation URLs unchanged while preventing the
  // invalid `/chat/completions/v1/models` request.
  const catalogBase = base.replace(/\/v1\/chat\/completions$/i, '/v1').replace(/\/chat\/completions$/i, '')
  addCandidates(catalogBase)
  const withoutAnthropic = catalogBase.replace(/\/anthropic$/i, '')
  if (withoutAnthropic !== base) addCandidates(withoutAnthropic)
  return [...new Set(candidates)]
}

async function tryFetchModelsFrom(
  url: string,
  headers: Record<string, string>,
  engine?: EngineKind
): Promise<{ models: string[] | null; attempt: ProviderModelFetchAttempt }> {
  const endpointPath = safeEndpointPath(url)
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        ...(engine === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
        ...headers
      }
    })
  } catch {
    return { models: null, attempt: { endpointPath, result: 'network' } }
  }
  if (response.status === 401 || response.status === 403) {
    return { models: null, attempt: { endpointPath, result: 'auth', status: response.status } }
  }
  if (response.status === 429) {
    return { models: null, attempt: { endpointPath, result: 'rate_limit', status: response.status } }
  }
  if (response.status >= 500) {
    return { models: null, attempt: { endpointPath, result: 'server', status: response.status } }
  }
  if (response.status === 404) {
    return { models: null, attempt: { endpointPath, result: 'not_found', status: response.status } }
  }
  if (!response.ok) {
    return { models: null, attempt: { endpointPath, result: 'invalid_response', status: response.status } }
  }
  const json = await parseModelResponse(response)
  const models = modelIds(json, engine)
  return models
    ? { models, attempt: { endpointPath, result: 'success', status: response.status } }
    : { models: null, attempt: { endpointPath, result: 'invalid_response', status: response.status } }
}

async function parseModelResponse(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function modelIds(json: unknown, engine?: EngineKind): string[] | null {
  const envelope = json as Record<string, unknown> | null
  const records = Array.isArray(json) ? json
    : Array.isArray(envelope?.data) ? envelope.data as unknown[]
      : Array.isArray(envelope?.models) ? envelope.models as unknown[] : []
  const ids = records.map((record) => modelId(record, engine)).filter(Boolean)
  return ids.length > 0 ? uniqueCanonicalModelIds(ids, engine) : null
}

function modelId(model: unknown, engine?: EngineKind): string {
  if (typeof model === 'string') return canonicalModelId(model, engine)
  const record = model as Record<string, unknown> | null
  if (typeof record?.id === 'string') return canonicalModelId(record.id, engine)
  return typeof record?.name === 'string' ? canonicalModelId(record.name, engine) : ''
}

/**
 * Model catalogs are inconsistent across providers: Gemini commonly returns
 * `models/foo`, while OpenAI-compatible gateways may return whitespace and
 * duplicate records. Keep the first spelling for a stable user-visible list,
 * but remove transport-only prefixes and exact duplicates before saving it.
 */
function canonicalModelId(value: string, engine?: EngineKind): string {
  const trimmed = value.trim()
  return engine === 'gemini' ? trimmed.replace(/^models\//i, '') : trimmed
}

function uniqueCanonicalModelIds(ids: string[], engine?: EngineKind): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const id of ids) {
    const canonical = canonicalModelId(id, engine)
    if (!canonical || seen.has(canonical)) continue
    seen.add(canonical)
    unique.push(canonical)
  }
  return unique
}

function successfulModelFetchResult(
  context: ModelDiscoveryContext,
  models: string[],
  health: ModelDiscoveryHealth
): ProviderModelFetchResult {
  const fetchedAt = Date.now()
  const latencyMs = fetchedAt - context.startedAt
  modelFetchCache.set(context.cacheKey, {
    models,
    fetchedAt,
    baseUrl: context.publicBaseUrl,
    providerId: context.providerId
  })
  if (context.providerId) health.success(context.providerId, latencyMs)
  return {
    ok: true,
    providerId: context.providerId,
    baseUrl: context.publicBaseUrl,
    cacheKey: context.cacheKey,
    models,
    fetchedAt,
    latencyMs,
    stale: false
  }
}

function failedOutcomeResult(
  context: ModelDiscoveryContext,
  credentials: ModelDiscoveryCredentials,
  attempts: ProviderModelFetchAttempt[],
  health: ModelDiscoveryHealth
): ProviderModelFetchResult {
  const authAttempts = attempts.filter((attempt) => attempt.result === 'auth')
  if (authAttempts.length > 0) {
    const onlyAuthFailures = authAttempts.length === attempts.length
    return failedModelFetchResult(
      context,
      'auth',
      onlyAuthFailures
        ? '所有候选模型端点都拒绝了当前鉴权，请检查 API Key 和鉴权头'
        : 'Base URL 路径与鉴权结果不一致，请同时检查 Base URL、API Key 和鉴权头',
      health,
      authAttempts[0].status,
      {
        reasonCode: onlyAuthFailures ? 'credentials_rejected' : 'base_url_or_credentials_mismatch',
        suggestedAction: onlyAuthFailures ? 'review_credentials' : 'review_base_url_and_credentials',
        attempts,
        credentials
      }
    )
  }

  const rateLimit = attempts.find((attempt) => attempt.result === 'rate_limit')
  if (rateLimit) {
    return failedModelFetchResult(context, 'rate_limit', 'Provider 正在限流或账户额度不足，请稍后重试', health, rateLimit.status, {
      reasonCode: 'rate_limited',
      suggestedAction: 'retry_later',
      attempts,
      credentials
    })
  }

  const serverFailure = attempts.find((attempt) => attempt.result === 'server')
  if (serverFailure) {
    return failedModelFetchResult(context, 'server', 'Provider 网关或上游服务暂时不可用', health, serverFailure.status, {
      reasonCode: 'provider_unavailable',
      suggestedAction: 'retry_later',
      attempts,
      credentials
    })
  }

  if (attempts.some((attempt) => attempt.result === 'network')) {
    return failedModelFetchResult(context, 'network', '无法连接 Provider，请检查网络、代理和 Base URL', health, undefined, {
      reasonCode: 'network_unavailable',
      suggestedAction: 'check_network',
      attempts,
      credentials
    })
  }

  return failedModelFetchResult(
    context,
    'not_found',
    'Provider 未提供可用的模型列表；可以手动填写模型名，再测试实际生成请求',
    health,
    attempts.find((attempt) => attempt.status)?.status,
    {
      reasonCode: 'model_catalog_unavailable',
      suggestedAction: 'enter_models_manually',
      attempts,
      credentials
    }
  )
}

function failedModelFetchResult(
  context: ModelDiscoveryContext,
  kind: ProviderModelErrorKind,
  message: string,
  health: ModelDiscoveryHealth,
  status?: number,
  diagnostic: ModelFailureDiagnostic = {
    reasonCode: 'unknown',
    suggestedAction: 'review_configuration'
  }
): ProviderModelFetchResult {
  const latencyMs = Date.now() - context.startedAt
  if (context.providerId) health.failure(context.providerId, message)
  modelFetchCache.delete(context.cacheKey)
  return {
    ok: false,
    providerId: context.providerId,
    baseUrl: context.publicBaseUrl,
    cacheKey: context.cacheKey,
    models: [],
    latencyMs,
    stale: true,
    error: {
      kind,
      message,
      status,
      providerId: context.providerId,
      baseUrl: context.publicBaseUrl,
      reasonCode: diagnostic.reasonCode,
      suggestedAction: diagnostic.suggestedAction,
      credentialStyle: credentialStyle(context, diagnostic.credentials),
      diagnosticContext: diagnosticContext(context, diagnostic.credentials),
      attempts: diagnostic.attempts ?? []
    }
  }
}

function diagnosticContext(
  context: ModelDiscoveryContext,
  credentials?: ModelDiscoveryCredentials
): ProviderModelDiagnosticContext {
  const engine = context.engine ?? 'openai'
  const generationProtocol = engine === 'anthropic'
    ? 'anthropic-messages'
    : engine === 'gemini'
      ? 'google-generative-language'
      : context.openaiProtocol === 'chat'
        ? 'openai-chat-completions'
        : 'openai-responses'
  const credentialSource = credentials?.authMode === 'none' || context.requestedAuthMode === 'none'
    ? 'none'
    : credentials?.source ?? (context.providerId ? 'stored-active' : 'explicit')
  return {
    engine,
    generationProtocol,
    generationEndpointPath: generationEndpointPath(generationProtocol),
    credentialSource,
    credentialLabel: safeCredentialLabel(credentials?.label),
    catalogProbeOnly: true
  }
}

function generationEndpointPath(
  protocol: ProviderModelDiagnosticContext['generationProtocol']
): string {
  if (protocol === 'anthropic-messages') return '/v1/messages'
  if (protocol === 'google-generative-language') return '/v1beta/models/{model}:streamGenerateContent'
  if (protocol === 'openai-chat-completions') return '/v1/chat/completions'
  return '/v1/responses'
}

function safeCredentialLabel(value: string | undefined): string | undefined {
  const label = value?.trim()
  if (!label || label.length > 80 || /[\0-\x1f\x7f]/.test(label)) return undefined
  return label
}

function credentialStyle(
  context: ModelDiscoveryContext,
  credentials?: ModelDiscoveryCredentials
): { authMode: ProviderAuthMode; headerNames: string[] } {
  const headerNames = credentials?.credentialHeaderNames?.length
    ? credentials.credentialHeaderNames
    : credentialHeaderNamesFromHeaders(credentials?.headers ?? {})
  return {
    authMode: credentials?.authMode ?? context.requestedAuthMode,
    headerNames: sanitizeHeaderNames(
      headerNames.length > 0 ? headerNames : context.requestedCredentialHeaderNames
    )
  }
}

function credentialHeaderNamesFromHeaders(headers: Record<string, string>): string[] {
  return Object.keys(headers).filter((name) =>
    /authorization|api[-_]?key|token|subscription|rapidapi/i.test(name)
  )
}

function sanitizeHeaderNames(names: string[]): string[] {
  return [...new Set(names
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z0-9_-]{1,80}$/.test(name)))]
}

function safeEndpointPath(value: string): string {
  try {
    const url = new URL(value)
    return url.pathname || '/'
  } catch {
    const path = value.replace(/[?#].*$/, '').replace(/^https?:\/\/[^/]+/i, '')
    return path.startsWith('/') ? path : `/${path}`
  }
}

function providerModelCacheKey(
  providerId: string | undefined,
  baseUrl: string,
  protocol?: OpenAIProtocol,
  engine?: EngineKind
): string {
  const parts = [providerId || 'new-provider', normalizeCacheBaseUrl(baseUrl), protocol || 'default']
  if (engine) parts.push(engine)
  return parts.join('|')
}

function normalizeCacheBaseUrl(value: string): string {
  const clean = (value || '').trim().replace(/\/+$/, '')
  try {
    const url = new URL(clean)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return clean
  }
}

function redactBaseUrl(value: string): string {
  const clean = (value || '').trim().replace(/\/+$/, '')
  try {
    const url = new URL(clean)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return clean.replace(/([?&](?:key|token|api_key|apikey|access_token)=)[^&]+/gi, '$1[redacted]')
  }
}
