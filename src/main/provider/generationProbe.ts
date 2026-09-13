import type {
  EngineKind,
  OpenAIProtocol,
  ProviderDiagnosticCredentialSource,
  ProviderDiagnosticGenerationProtocol,
  ProviderGenerationProbeInput,
  ProviderGenerationProbeOutcome,
  ProviderGenerationProbeResult
} from '../../shared/types'
import { inspectProviderBaseUrl } from '../providerCredentialBroker'
import { openAiEndpoint } from './openai-provider-utils'
import { validateGenerationProbeResponse } from './generationProbeResponse'

export interface ProviderGenerationProbeCredentials {
  headers: Record<string, string>
  headerNames: string[]
  source: ProviderDiagnosticCredentialSource
  label?: string
  available: boolean
}

export async function executeProviderGenerationProbe(
  input: ProviderGenerationProbeInput,
  credentials: ProviderGenerationProbeCredentials,
  fetchImpl: typeof fetch = fetch
): Promise<ProviderGenerationProbeResult> {
  const startedAt = Date.now()
  const providerId = input.providerId?.trim() || undefined
  const engine = input.engine ?? 'openai'
  const protocol = generationProtocol(engine, input.openaiProtocol)
  const endpointPath = publicGenerationPath(protocol)
  const baseUrl = safeBaseUrl(input.baseUrl)
  const model = input.model.trim()
  if (!model) throw new Error('Generation probe requires a model')

  const request = generationRequest(baseUrl, model, protocol)
  if (!credentials.available) {
    return {
      ok: false,
      providerId,
      protocol,
      endpointPath,
      credentialSource: credentials.source,
      credentialLabel: credentials.label,
      credentialHeaderNames: credentials.headerNames,
      outcome: 'auth',
      latencyMs: Date.now() - startedAt,
      billableRequest: true
    }
  }
  let status: number | undefined
  let outcome: ProviderGenerationProbeOutcome
  try {
    const signal = AbortSignal.timeout(20_000)
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(protocol === 'anthropic-messages' ? { 'anthropic-version': '2023-06-01' } : {}),
        ...credentials.headers
      },
      body: JSON.stringify(request.body),
      signal
    })
    status = response.status
    outcome = classifyStatus(response.status)
    if (outcome === 'success') {
      if (!await validateGenerationProbeResponse(response, protocol, signal)) outcome = 'invalid_response'
    } else {
      void response.body?.cancel().catch(() => undefined)
    }
  } catch {
    outcome = 'network'
  }

  return {
    ok: outcome === 'success',
    providerId,
    protocol,
    endpointPath,
    credentialSource: credentials.source,
    credentialLabel: credentials.label,
    credentialHeaderNames: credentials.headerNames,
    outcome,
    status,
    latencyMs: Date.now() - startedAt,
    ...(outcome === 'success' ? { responseValidation: 'protocol-json-v1' as const } : {}),
    billableRequest: true
  }
}

function safeBaseUrl(value: string): string {
  const inspected = inspectProviderBaseUrl(value.trim())
  if (!inspected.safeValue || inspected.rejectedNames.length > 0) {
    throw new Error('Provider generation target is invalid')
  }
  return inspected.safeValue.replace(/\/+$/, '')
}

function generationProtocol(engine: EngineKind, protocol: OpenAIProtocol | undefined): ProviderDiagnosticGenerationProtocol {
  if (engine === 'anthropic') return 'anthropic-messages'
  if (engine === 'gemini') return 'google-generative-language'
  return protocol === 'chat' ? 'openai-chat-completions' : 'openai-responses'
}

function publicGenerationPath(protocol: ProviderDiagnosticGenerationProtocol): string {
  if (protocol === 'anthropic-messages') return '/v1/messages'
  if (protocol === 'google-generative-language') return '/v1beta/models/{model}:generateContent'
  if (protocol === 'openai-chat-completions') return '/v1/chat/completions'
  return '/v1/responses'
}

function generationRequest(
  baseUrl: string,
  model: string,
  protocol: ProviderDiagnosticGenerationProtocol
): { url: string; body: Record<string, unknown> } {
  if (protocol === 'anthropic-messages') {
    return {
      url: anthropicMessagesEndpoint(baseUrl),
      body: { model, max_tokens: 1, stream: false, messages: [{ role: 'user', content: 'OK' }] }
    }
  }
  if (protocol === 'google-generative-language') {
    return {
      url: googleGenerationEndpoint(baseUrl, model),
      body: {
        contents: [{ role: 'user', parts: [{ text: 'OK' }] }],
        generationConfig: { maxOutputTokens: 1 }
      }
    }
  }
  if (protocol === 'openai-chat-completions') {
    return {
      url: openAiEndpoint(baseUrl, 'chat/completions'),
      body: { model, max_tokens: 1, stream: false, messages: [{ role: 'user', content: 'OK' }] }
    }
  }
  return {
    url: openAiEndpoint(baseUrl, 'responses'),
    body: { model, max_output_tokens: 1, stream: false, input: 'OK' }
  }
}

function googleGenerationEndpoint(baseUrl: string, model: string): string {
  const url = new URL(baseUrl)
  let path = url.pathname.replace(/\/+$/, '')
  if (!/\/v1(?:beta)?$/i.test(path)) path = `${path}/v1beta`
  url.pathname = `${path}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`
  return url.toString().replace(/\/$/, '')
}

function anthropicMessagesEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = /\/v1\/messages$/i.test(path)
    ? path
    : /\/v1$/i.test(path) ? `${path}/messages` : `${path}/v1/messages`.replace(/^\/\//, '/')
  return url.toString().replace(/\/$/, '')
}

function classifyStatus(status: number): ProviderGenerationProbeOutcome {
  if (status >= 200 && status < 300) return 'success'
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server'
  return 'invalid_request'
}
