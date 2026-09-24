import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Provider, ProviderView } from '../../shared/types'
import type {
  ProviderGatewayModelView,
  ProviderGatewayStatusView,
  ProviderGatewayUpdateInput,
  ProviderGatewayUsageRecord
} from '../../shared/provider-gateway-types'
import { PROVIDER_GATEWAY_HOST } from '../../shared/provider-gateway-types'
import { credentialFingerprint } from './providerCredentialIdentity'
import { googleGenerativeLanguageEndpoint } from './googleGenAiTarget'
import { openAiEndpoint, parseProviderHeaders } from './openai-provider-utils'
import { appendProviderRequestQuery } from './providerRequestOverrides'
import { resolveOpenAIProtocol, resolveProviderRuntimeTarget } from './providerRuntimeTarget'
import {
  appendProviderGatewayUsage,
  inspectProviderGatewayToken,
  readProviderGatewayConfig,
  resolveProviderGatewayToken,
  writeProviderGatewayConfig
} from './providerGatewayStore'
import {
  getProvider,
  issueProviderCredentialLease,
  listProviders,
  markProviderKeyUsed,
  providerIsReady,
  recordProviderKeySuccess,
  resolveProviderEngine
} from '../providers'
import { fetchWithProviderCredentialLease } from '../providerRuntimeAuth'
import {
  acquireProviderRequest,
  configureProviderReliabilityPolicy,
  recordFailure,
  recordSuccess,
  releaseProviderRequest
} from '../providerHealth'
import {
  ProviderRequestDeadline,
  providerRequestIsStreaming,
  providerRequestTimeouts
} from './providerRequestTimeout'
import {
  forwardAnthropicMessagesResponse,
  translateAnthropicMessagesRequest
} from './anthropicOpenAiGateway'
import { getSettings } from '../settings'
import {
  applyRoutingExpertPolicy,
  assertRoutingExpertTargetAllowed
} from '../model/routing-expert-policy'
import {
  discardGatewayUpstreamResponse,
  primeGatewayStreamingResponse,
  ProviderGatewayUsageScanner,
  streamGatewayResponse
} from './providerGatewayResponse'
import {
  boundedGatewayProviderFailure,
  gatewayClientDisconnected,
  gatewayErrorEnvelope,
  gatewayErrorOutcome,
  gatewayHttpError,
  publicGatewayError,
  publicGatewayFailureLabel,
  switchableGatewayFailure
} from './providerGatewayErrors'

const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const MAX_CONCURRENT_REQUESTS = 8
const UPSTREAM_TIMEOUT_MS = 120_000
const SAFE_RESPONSE_HEADERS = ['content-type', 'cache-control', 'x-request-id', 'openai-processing-ms'] as const

let server: Server | undefined
let state: ProviderGatewayStatusView['state'] = 'stopped'
let activeRequests = 0
let startedAt: number | undefined
let lastErrorCode: ProviderGatewayStatusView['lastErrorCode']
let lastError: string | undefined
let lifecycle = Promise.resolve()

export async function initializeProviderGateway(): Promise<ProviderGatewayStatusView> {
  return serializeLifecycle(async () => {
    const config = readProviderGatewayConfig()
    if (!config.enabled) return providerGatewayStatus()
    await startListener(config.port)
    return providerGatewayStatus()
  })
}

export async function updateProviderGateway(
  input: ProviderGatewayUpdateInput
): Promise<ProviderGatewayStatusView> {
  return serializeLifecycle(async () => {
    const current = readProviderGatewayConfig()
    const enabled = input.enabled ?? current.enabled
    const port = input.port ?? current.port
    const mustRestart = Boolean(server) && (port !== current.port || input.regenerateToken || !enabled)
    if (mustRestart) await stopListener()
    const next = writeProviderGatewayConfig({ enabled, port, regenerateToken: input.regenerateToken })
    if (enabled && !server) await startListener(next.port)
    if (!enabled) {
      if (server) await stopListener()
      else resetStoppedState()
    }
    return providerGatewayStatus()
  })
}

export async function stopProviderGateway(): Promise<void> {
  await serializeLifecycle(stopListener)
}

export function providerGatewayStatus(): ProviderGatewayStatusView {
  const config = readProviderGatewayConfig()
  const token = inspectProviderGatewayToken(config)
  return {
    enabled: config.enabled,
    host: PROVIDER_GATEWAY_HOST,
    port: config.port,
    tokenConfigured: token.configured,
    tokenStorage: token.storage,
    state,
    baseUrl: `http://${PROVIDER_GATEWAY_HOST}:${config.port}/v1`,
    googleBaseUrl: `http://${PROVIDER_GATEWAY_HOST}:${config.port}/v1beta`,
    activeRequests,
    startedAt,
    lastErrorCode,
    lastError
  }
}

export function listProviderGatewayModels(): ProviderGatewayModelView[] {
  return gatewayModelCatalog(listProviders())
}

async function startListener(port: number): Promise<void> {
  if (server) return
  state = 'starting'
  startedAt = undefined
  lastError = undefined
  lastErrorCode = undefined
  try {
    resolveProviderGatewayToken()
  } catch {
    state = 'blocked'
    lastErrorCode = 'credential_unavailable'
    lastError = 'Gateway token is unavailable; regenerate it to start the listener.'
    return
  }
  const next = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, gatewayErrorEnvelope('gateway_error', 'Local gateway request failed', undefined, 500))
      else response.destroy()
    })
  })
  next.requestTimeout = UPSTREAM_TIMEOUT_MS + 5_000
  next.headersTimeout = 15_000
  next.keepAliveTimeout = 5_000
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: NodeJS.ErrnoException): void => reject(error)
      next.once('error', fail)
      next.listen({ host: PROVIDER_GATEWAY_HOST, port, exclusive: true }, () => {
        next.off('error', fail)
        resolve()
      })
    })
    server = next
    next.on('error', () => {
      if (server !== next) return
      server = undefined
      state = 'error'
      startedAt = undefined
      lastErrorCode = 'listener_error'
      lastError = 'The local gateway listener stopped unexpectedly.'
    })
    state = 'running'
    startedAt = Date.now()
  } catch (error) {
    next.close()
    state = errorCode(error) === 'EADDRINUSE' ? 'blocked' : 'error'
    lastErrorCode = errorCode(error) === 'EADDRINUSE' ? 'port_in_use' : 'listener_error'
    lastError = errorCode(error) === 'EADDRINUSE'
      ? `Port ${port} is already in use. EastGenesis did not switch ports automatically.`
      : 'The local gateway listener could not start.'
  }
}

async function stopListener(): Promise<void> {
  const current = server
  server = undefined
  if (current) {
    current.closeIdleConnections()
    const closed = new Promise<void>((resolve) => current.close(() => resolve()))
    current.closeAllConnections()
    await closed
  }
  resetStoppedState()
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  applyGatewayResponseHeaders(response)
  const path = request.url?.split('?')[0] ?? ''
  if (request.method === 'GET' && path === '/health') {
    sendJson(response, 200, { status: 'ok', service: 'caogen-provider-gateway' })
    return
  }
  const hintedProtocol = requestProtocol(request.method, path)
  if (!authorizedGatewayRequest(request.headers)) {
    response.setHeader('www-authenticate', 'Bearer realm="EastGenesis local gateway"')
    sendJson(response, 401, gatewayErrorEnvelope('invalid_api_key', 'Invalid local gateway token', hintedProtocol, 401))
    return
  }
  if (request.method === 'GET' && path === '/v1/models') {
    const models = gatewayModelCatalog(listProviders(), 'openai').map((item) => ({
      id: item.id,
      object: 'model',
      created: 0,
      owned_by: item.providerName
    }))
    sendJson(response, 200, { object: 'list', data: models })
    return
  }
  if (request.method === 'GET' && path === '/v1beta/models') {
    const models = gatewayModelCatalog(listProviders(), 'gemini').map((item) => ({
      name: `models/${item.id}`,
      displayName: item.model,
      description: `Routed by EastGenesis through ${item.providerName}`,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent']
    }))
    sendJson(response, 200, { models })
    return
  }
  const protocol = hintedProtocol
  if (!protocol) {
    sendJson(response, 404, gatewayErrorEnvelope(
      'not_found',
      'Supported endpoints are /v1/models, /v1/chat/completions, /v1/responses, /v1/messages and Google Generative Language v1beta models endpoints',
      hintedProtocol
    ))
    return
  }
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    sendJson(response, 429, gatewayErrorEnvelope('gateway_busy', 'Local gateway concurrency limit reached', protocol, 429))
    return
  }
  activeRequests += 1
  try {
    await proxyProviderRequest(request, response, protocol)
  } finally {
    activeRequests = Math.max(0, activeRequests - 1)
  }
}

async function proxyProviderRequest(
  request: IncomingMessage,
  response: ServerResponse,
  protocol: ProviderGatewayUsageRecord['protocol']
): Promise<void> {
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(new Error('provider_timeout')), UPSTREAM_TIMEOUT_MS)
  const onClose = (): void => {
    if (!response.writableEnded) abort.abort(new Error('client_disconnected'))
  }
  response.once('close', onClose)
  try {
    const incomingBody = await readJsonBody(request)
    const google = protocol === 'gateway.google.generative-language'
      ? googleGatewayRequest(request.url ?? '')
      : undefined
    const anthropic = protocol === 'gateway.anthropic.messages'
      ? translateAnthropicMessagesRequest(incomingBody)
      : undefined
    const sourceBody = anthropic?.upstreamBody ?? incomingBody
    const requestedModel = google?.requestedModel ?? anthropic?.requestedModel ?? requiredModel(sourceBody)
    const routes = resolveGatewayRoutes(requestedModel, google ? 'gemini' : 'openai', protocol)
    await executeGatewayAttempts({
      requestId: randomUUID(), response, protocol, abort, sourceBody, requestedModel, routes, google, anthropic
    })
  } catch (error) {
    if (!response.headersSent) {
      const mapped = publicGatewayError(error, abort.signal)
      sendJson(response, mapped.status, gatewayErrorEnvelope(mapped.code, mapped.message, protocol, mapped.status))
    } else if (!response.writableEnded) {
      response.destroy()
    }
  } finally {
    clearTimeout(timeout)
    response.off('close', onClose)
  }
}

interface GatewayAttemptChainInput {
  requestId: string
  response: ServerResponse
  protocol: ProviderGatewayUsageRecord['protocol']
  abort: AbortController
  sourceBody: Record<string, unknown>
  requestedModel: string
  routes: GatewayRoute[]
  google?: ReturnType<typeof googleGatewayRequest>
  anthropic?: ReturnType<typeof translateAnthropicMessagesRequest>
}

interface GatewayAttemptRuntimeState {
  deadline?: ProviderRequestDeadline
  upstreamStatus?: number
  usage?: ProviderGatewayUsageRecord['usage']
  credentialKeyId?: string
  healthRecorded: boolean
}

async function executeGatewayAttempts(input: GatewayAttemptChainInput): Promise<void> {
  let failoverFromAttemptId: string | undefined
  let previousFailure = ''
  for (let ordinal = 0; ordinal < input.routes.length; ordinal += 1) {
    const route = input.routes[ordinal]
    const attemptId = randomUUID()
    const startedAt = Date.now()
    const state: GatewayAttemptRuntimeState = { healthRecorded: false }
    const routeReason = ordinal === 0 ? route.initialReason
      : `Automatic same-protocol failover after ${previousFailure || 'Provider unavailable'}`
    try {
      await executeGatewayUpstreamAttempt(input, route, attemptId, startedAt, state)
      persistGatewayAttempt({
        requestId: input.requestId, attemptId, ordinal, failoverFromAttemptId, routeReason, route,
        protocol: input.protocol, terminal: { status: 'succeeded', outcome: 'success' }, startedAt,
        usage: state.usage, upstreamStatus: state.upstreamStatus, credentialKeyId: state.credentialKeyId
      })
      return
    } catch (error) {
      recordGatewayAttemptFailure(route, state, error, input.abort.signal)
      persistGatewayAttempt({
        requestId: input.requestId, attemptId, ordinal, failoverFromAttemptId, routeReason, route,
        protocol: input.protocol, terminal: failureTerminal(error, input.abort.signal), startedAt,
        usage: state.usage, upstreamStatus: state.upstreamStatus, credentialKeyId: state.credentialKeyId
      })
      if (!shouldFailoverAttempt(input, route, ordinal, error)) throw error
      failoverFromAttemptId = attemptId
      previousFailure = publicGatewayFailureLabel(error, input.abort.signal)
    } finally {
      state.deadline?.finish()
      releaseProviderRequest(route.provider.id)
    }
  }
}

async function executeGatewayUpstreamAttempt(
  input: GatewayAttemptChainInput,
  route: GatewayRoute,
  attemptId: string,
  startedAt: number,
  state: GatewayAttemptRuntimeState
): Promise<void> {
  assertRoutingExpertTargetAllowed(
    route.provider.id,
    route.target.baseUrl,
    getSettings().routingExpertPolicy
  )
  configureProviderReliabilityPolicy(route.provider)
  if (!acquireProviderRequest(route.provider.id)) {
    throw gatewayHttpError(503, 'provider_circuit_open', 'Provider circuit is open')
  }
  const scope = {
    providerId: route.provider.id,
    projectId: 'gateway:local',
    sessionId: 'gateway',
    operationId: attemptId
  }
  const selection = issueProviderCredentialLease(route.provider, scope)
  if (!selection.available) {
    throw gatewayHttpError(503, 'provider_credential_unavailable', 'Provider credential is unavailable')
  }
  state.credentialKeyId = selection.keyId
  if (state.credentialKeyId) markProviderKeyUsed(route.provider.id, state.credentialKeyId)
  const body = input.google ? input.sourceBody : { ...input.sourceBody, model: route.target.model }
  const bodyText = JSON.stringify(body)
  const streaming = input.google?.method === 'streamGenerateContent' || providerRequestIsStreaming(bodyText)
  const endpoint = gatewayUpstreamEndpoint(route, input.protocol, input.google)
  state.deadline = new ProviderRequestDeadline(
    input.abort.signal, providerRequestTimeouts(route.provider), streaming
  )
  const rawUpstream = await fetchWithProviderCredentialLease({
    provider: route.provider,
    lease: selection.lease,
    scope,
    url: endpoint,
    init: {
      method: 'POST', redirect: 'manual', signal: state.deadline.signal,
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...parseProviderHeaders(route.provider.customHeaders),
        ...(route.provider.advancedConfig?.request?.headers ?? {})
      },
      body: bodyText
    }
  })
  let upstream = state.deadline.wrapResponse(rawUpstream)
  state.upstreamStatus = upstream.status
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => undefined)
    throw gatewayHttpError(502, 'provider_redirect_rejected', 'Provider redirect was rejected')
  }
  if (!upstream.ok) {
    state.usage = await discardGatewayUpstreamResponse(upstream, input.abort.signal)
    throw gatewayHttpError(upstream.status, 'provider_error', `Provider request failed with HTTP ${upstream.status}`)
  }
  if (streaming) upstream = await primeGatewayStreamingResponse(upstream, input.abort.signal)
  input.response.statusCode = upstream.status
  copySafeResponseHeaders(upstream.headers, input.response)
  state.usage = await forwardGatewaySuccess(input, upstream)
  recordSuccess(route.provider.id, Math.max(0, Date.now() - startedAt))
  state.healthRecorded = true
  if (state.credentialKeyId) recordProviderKeySuccess(route.provider.id, state.credentialKeyId)
}

function gatewayUpstreamEndpoint(
  route: GatewayRoute,
  protocol: ProviderGatewayUsageRecord['protocol'],
  google: GatewayAttemptChainInput['google']
): string {
  if (!google) {
    return openAiEndpoint(
      route.target.baseUrl,
      protocol === 'gateway.openai.responses' ? 'responses' : 'chat/completions'
    )
  }
  return appendProviderRequestQuery(
    googleGenerativeLanguageEndpoint(route.target.baseUrl, route.target.model, google.method),
    route.target.baseUrl,
    {
      ...(google.sse ? { alt: 'sse' } : {}),
      ...(route.provider.advancedConfig?.request?.query ?? {})
    }
  )
}

async function forwardGatewaySuccess(
  input: GatewayAttemptChainInput,
  upstream: Response
): Promise<ProviderGatewayUsageRecord['usage']> {
  if (input.anthropic) {
    return forwardAnthropicMessagesResponse(
      upstream, input.response, input.abort.signal, input.requestedModel, input.anthropic.stream
    )
  }
  const scan = new ProviderGatewayUsageScanner(upstream.headers.get('content-type') ?? '')
  await streamGatewayResponse(upstream, input.response, scan, input.abort.signal)
  return scan.usage()
}

function recordGatewayAttemptFailure(
  route: GatewayRoute,
  state: GatewayAttemptRuntimeState,
  error: unknown,
  signal: AbortSignal
): void {
  if (state.healthRecorded || gatewayClientDisconnected(signal)) return
  recordFailure(route.provider.id, boundedGatewayProviderFailure(error, signal, state.upstreamStatus))
  state.healthRecorded = true
}

function failureTerminal(
  error: unknown,
  signal: AbortSignal
): Pick<ProviderGatewayUsageRecord, 'status' | 'outcome'> {
  return gatewayClientDisconnected(signal)
    ? { status: 'cancelled', outcome: 'cancelled' }
    : { status: 'failed', outcome: gatewayErrorOutcome(error, signal) }
}

function shouldFailoverAttempt(
  input: GatewayAttemptChainInput,
  route: GatewayRoute,
  ordinal: number,
  error: unknown
): boolean {
  return !input.response.headersSent
    && ordinal + 1 < input.routes.length
    && canFailoverFrom(route, ordinal)
    && switchableGatewayFailure(error, input.abort.signal)
}

interface GatewayRoute {
  provider: Provider
  target: ReturnType<typeof resolveProviderRuntimeTarget>
  initialReason: string
}

function resolveGatewayRoutes(
  requestedModel: string,
  engine: 'openai' | 'gemini',
  protocol: ProviderGatewayUsageRecord['protocol']
): GatewayRoute[] {
  const settings = getSettings()
  const policyProviders = gatewayPolicyProviders(engine, settings.routingExpertPolicy)
  const initial = resolveGatewayRoute(requestedModel, engine, policyProviders)
  const expectedProtocol = protocol === 'gateway.openai.responses' ? 'responses' : 'chat'
  const fallbackProviderId = settings.fallbackProviderId.trim()
  const alternates = policyProviders.flatMap((view): GatewayRoute[] => {
    if (!view.ready || view.engine !== engine || view.id === initial.provider.id) return []
    const provider = getProvider(view.id)
    if (!provider || !providerIsReady(provider) || resolveProviderEngine(provider) !== engine) return []
    for (const model of providerModelNames(view)) {
      try {
        const target = resolveProviderRuntimeTarget(provider, { appId: 'gateway', model })
        if (!target.baseUrl || !target.model
          || target.model.toLowerCase() !== initial.target.model.toLowerCase()) continue
        if (engine === 'openai' && resolveOpenAIProtocol(target) !== expectedProtocol) continue
        return [{ provider, target, initialReason: 'Automatic same-protocol failover candidate' }]
      } catch {
        // A malformed candidate must not block a usable exact route.
      }
    }
    return []
  }).sort((left, right) => {
    const leftPreferred = left.provider.id === fallbackProviderId ? 0 : 1
    const rightPreferred = right.provider.id === fallbackProviderId ? 0 : 1
    return leftPreferred - rightPreferred || left.provider.createdAt - right.provider.createdAt
      || left.provider.id.localeCompare(right.provider.id)
  })
  return [initial, ...alternates].slice(0, 21)
}

function resolveGatewayRoute(
  requestedModel: string,
  engine: 'openai' | 'gemini',
  views = gatewayPolicyProviders(engine, getSettings().routingExpertPolicy)
): GatewayRoute {
  const explicit = views
    .filter((provider) => requestedModel.startsWith(`${provider.id}/`))
    .map((provider) => ({ provider, model: requestedModel.slice(provider.id.length + 1) }))
  const candidates = explicit.length > 0
    ? explicit
    : views.flatMap((provider) => providerModelNames(provider)
      .filter((model) => model.toLowerCase() === requestedModel.toLowerCase())
      .map((model) => ({ provider, model })))
  const unique = [...new Map(candidates.map((item) => [item.provider.id, item])).values()]
  if (unique.length === 0) throw gatewayHttpError(404, 'model_not_found', 'No ready Provider exposes this model')
  if (unique.length > 1) throw gatewayHttpError(409, 'model_ambiguous', 'Model is available from multiple Providers; use provider-id/model')
  const provider = getProvider(unique[0].provider.id)
  if (!provider || !providerIsReady(provider) || resolveProviderEngine(provider) !== engine) {
    throw gatewayHttpError(503, 'provider_unavailable', 'Selected Provider is unavailable')
  }
  const target = resolveProviderRuntimeTarget(provider, { appId: 'gateway', model: unique[0].model })
  if (!target.baseUrl || !target.model) throw gatewayHttpError(503, 'provider_unavailable', 'Selected Provider has no usable endpoint or model')
  assertRoutingExpertTargetAllowed(provider.id, target.baseUrl, getSettings().routingExpertPolicy)
  return {
    provider,
    target,
    initialReason: explicit.length > 0 ? 'Explicit local gateway Provider route' : 'Unique local gateway model route'
  }
}

interface PersistGatewayAttemptInput {
  requestId: string
  attemptId: string
  ordinal: number
  failoverFromAttemptId?: string
  routeReason: string
  route: GatewayRoute
  protocol: ProviderGatewayUsageRecord['protocol']
  terminal: Pick<ProviderGatewayUsageRecord, 'status' | 'outcome'>
  startedAt: number
  usage?: ProviderGatewayUsageRecord['usage']
  upstreamStatus?: number
  credentialKeyId?: string
}

function persistGatewayAttempt(input: PersistGatewayAttemptInput): void {
  const completedAt = Date.now()
  try {
    appendProviderGatewayUsage({
      schemaVersion: 1,
      id: input.attemptId,
      requestId: input.requestId,
      ordinal: input.ordinal,
      ...(input.failoverFromAttemptId ? { failoverFromAttemptId: input.failoverFromAttemptId } : {}),
      routeReason: input.routeReason,
      providerId: input.route.provider.id,
      model: input.route.target.model,
      ...(input.credentialKeyId
        ? { keyLabel: credentialFingerprint(input.route.provider.id, input.credentialKeyId) }
        : {}),
      protocol: input.protocol,
      ...input.terminal,
      startedAt: input.startedAt,
      completedAt,
      latencyMs: Math.max(0, completedAt - input.startedAt),
      usage: input.usage,
      upstreamStatus: input.upstreamStatus
    })
  } catch (error) {
    console.error('[caogen] Local gateway usage persistence failed:', error instanceof Error ? error.message : 'unknown error')
  }
}

function canFailoverFrom(route: GatewayRoute, retriesUsed: number): boolean {
  const settings = getSettings()
  const reliability = route.provider.advancedConfig?.reliability
  const enabled = reliability?.failoverEnabled ?? settings.failoverEnabled
  const maxRetries = reliability?.maxRetries ?? 20
  return enabled && retriesUsed < Math.min(20, maxRetries)
}

function gatewayModelCatalog(
  providers: ProviderView[],
  engine?: 'openai' | 'gemini'
): ProviderGatewayModelView[] {
  const compatible = providers.filter((provider) => provider.ready
    && (provider.engine === 'openai' || provider.engine === 'gemini')
    && (!engine || provider.engine === engine))
  const ready = applyRoutingExpertPolicy(compatible, getSettings().routingExpertPolicy).providers
  const counts = new Map<string, number>()
  for (const provider of ready) {
    for (const model of providerModelNames(provider)) {
      const key = `${provider.engine}:${model.toLowerCase()}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return ready.flatMap((provider) => provider.models.map((model) => ({
    id: (counts.get(`${provider.engine}:${model.toLowerCase()}`) ?? 0) > 1
      ? `${provider.id}/${model}`
      : model,
    providerId: provider.id,
    providerName: provider.name,
    model,
    engine: provider.engine as 'openai' | 'gemini'
  }))).sort((left, right) => left.id.localeCompare(right.id))
}

function gatewayPolicyProviders(
  engine: 'openai' | 'gemini',
  policy: ReturnType<typeof getSettings>['routingExpertPolicy']
): ProviderView[] {
  const compatible = listProviders().filter((provider) => provider.ready && provider.engine === engine)
  return applyRoutingExpertPolicy(compatible, policy).providers
}

function providerModelNames(provider: ProviderView): string[] {
  const names = [
    ...provider.models,
    ...(provider.advancedConfig?.modelProfiles ?? []).flatMap((profile) => [profile.model, ...(profile.aliases ?? [])])
  ].map((item) => item.trim()).filter(Boolean)
  return [...new Map(names.map((item) => [item.toLowerCase(), item])).values()]
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw gatewayHttpError(413, 'request_too_large', 'Request body exceeds 2 MiB')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_REQUEST_BYTES) throw gatewayHttpError(413, 'request_too_large', 'Request body exceeds 2 MiB')
    chunks.push(buffer)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch {
    throw gatewayHttpError(400, 'invalid_json', 'Request body must be valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw gatewayHttpError(400, 'invalid_request', 'Request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function authorizedGatewayRequest(headers: IncomingHttpHeaders): boolean {
  let expected: string
  try { expected = resolveProviderGatewayToken() } catch { return false }
  const authorization = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  const rawApiKey = headers['x-api-key']
  const rawGoogleApiKey = headers['x-goog-api-key']
  const presented = bearer
    ?? (Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey)
    ?? (Array.isArray(rawGoogleApiKey) ? rawGoogleApiKey[0] : rawGoogleApiKey)
    ?? ''
  const left = Buffer.from(presented)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function requiredModel(body: Record<string, unknown>): string {
  if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 512) {
    throw gatewayHttpError(400, 'model_required', 'A valid model is required')
  }
  return body.model.trim()
}

function requestProtocol(method: string | undefined, path: string): ProviderGatewayUsageRecord['protocol'] | undefined {
  if (path === '/v1beta/models') {
    return 'gateway.google.generative-language'
  }
  if (method !== 'POST') return undefined
  if (/^\/v1beta\/models\/.+:(?:generateContent|streamGenerateContent)$/.test(path)) {
    return 'gateway.google.generative-language'
  }
  if (path === '/v1/chat/completions') return 'gateway.openai.chat-completions'
  if (path === '/v1/responses') return 'gateway.openai.responses'
  if (path === '/v1/messages') return 'gateway.anthropic.messages'
  return undefined
}

function googleGatewayRequest(rawUrl: string): {
  requestedModel: string
  method: 'generateContent' | 'streamGenerateContent'
  sse: boolean
} {
  const url = new URL(rawUrl, `http://${PROVIDER_GATEWAY_HOST}`)
  const match = url.pathname.match(/^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/)
  if (!match) throw gatewayHttpError(404, 'not_found', 'Google Generative Language endpoint is invalid')
  let requestedModel: string
  try { requestedModel = decodeURIComponent(match[1]).trim() } catch {
    throw gatewayHttpError(400, 'invalid_model', 'Google model path is invalid')
  }
  if (!requestedModel || requestedModel.length > 512) {
    throw gatewayHttpError(400, 'model_required', 'A valid model is required')
  }
  const method = match[2] as 'generateContent' | 'streamGenerateContent'
  return { requestedModel, method, sse: method === 'streamGenerateContent' && url.searchParams.get('alt') === 'sse' }
}

function copySafeResponseHeaders(headers: Headers, response: ServerResponse): void {
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = headers.get(name)
    if (value) response.setHeader(name, value)
  }
}

function applyGatewayResponseHeaders(response: ServerResponse): void {
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('cache-control', 'no-store')
}

function resetStoppedState(): void {
  state = 'stopped'
  startedAt = undefined
  activeRequests = 0
  lastError = undefined
  lastErrorCode = undefined
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded) return
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(value))
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function serializeLifecycle<T>(operation: () => Promise<T> | T): Promise<T> {
  const next = lifecycle.then(operation, operation)
  lifecycle = next.then(() => undefined, () => undefined)
  return next
}
