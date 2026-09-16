import {
  decryptProviderToken,
  getProvider,
  providerAuthMode,
  providerCredentialHeaders
} from '../providers'
import { resolveProviderRuntimeTarget } from '../provider/providerRuntimeTarget'
import { getSettings } from '../settings'
import type { OpenAIProtocol, TaskDagRole, TaskDecomposeInput } from '../../shared/types'
import type { ModelDagDecomposer, ModelDagPayload, ModelDagTaskPayload } from './task-decomposer'
import { createNativeModelExecutorReceipt } from '../task/model-attempt-executor'
import {
  classifyRuntimeModelFailure,
  executePersistedModelAttempt,
  modelAttemptUsage,
  ModelAttemptPersistenceError,
  type RuntimeModelAttemptDependencies
} from '../task/model-attempt-runtime'

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com'
const MODEL_TIMEOUT_MS = 45_000

interface ProviderModelConfig {
  providerId: string
  baseUrl: string
  token: string
  headers: Record<string, string>
  model: string
  protocol: OpenAIProtocol
}

export interface ModelDagAttemptContext {
  runId: string
  requestId: string
  stepId?: string
}

export interface ModelDagRuntimeDependencies {
  fetch: typeof fetch
  attempt?: Partial<RuntimeModelAttemptDependencies>
  preflight?: (input: ModelDagOutboundPreflightInput) => void | Promise<void>
}

export interface ModelDagOutboundPreflightInput {
  url: string
  providerId: string
  model: string
  protocol: OpenAIProtocol
  body: Record<string, unknown>
}

const DEFAULT_RUNTIME_DEPENDENCIES: ModelDagRuntimeDependencies = { fetch }

const TASK_ROLES: readonly TaskDagRole[] = [
  'frontend',
  'backend',
  'qa',
  'docs',
  'devops',
  'review',
  'general'
]

function parseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const name = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (name && value) headers[name] = value
  }
  return headers
}

function protocolFor(baseUrl: string, protocol: OpenAIProtocol | undefined): OpenAIProtocol {
  if (protocol === 'chat' || protocol === 'responses') return protocol
  try {
    return new URL(baseUrl).host === 'api.openai.com' ? 'responses' : 'chat'
  } catch {
    return 'chat'
  }
}

function configFromInput(input: TaskDecomposeInput): ProviderModelConfig {
  const settings = getSettings()
  const requestedModel = input.model?.trim()
  if (!requestedModel || requestedModel === 'auto') {
    throw new Error('DAG 拆解需要 canonical Run 提供具体冻结模型，禁止自动回退到 Provider 首个模型。')
  }
  const providerId = input.providerId?.trim() || settings.defaultProviderId
  const provider = providerId ? getProvider(providerId) : undefined
  const runtimeTarget = provider
    ? resolveProviderRuntimeTarget(provider, { appId: 'caogen', model: requestedModel })
    : undefined
  const protocol = runtimeTarget?.protocol ?? protocolFor(runtimeTarget?.baseUrl ?? provider?.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL, provider?.openaiProtocol)
  const rawBaseUrl = (runtimeTarget?.baseUrl || provider?.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '')
  const baseUrl = protocol === 'chat' ? rawBaseUrl.replace(/\/anthropic$/, '') : rawBaseUrl
  const token = provider ? decryptProviderToken(provider) : process.env.OPENAI_API_KEY || ''
  if (!token && providerAuthMode(provider) !== 'none') {
    throw new Error(`${provider?.name ?? 'OpenAI'} 缺少 API Key,已回退本地 DAG 拆解`)
  }
  return {
    providerId: providerId || 'openai',
    baseUrl,
    token,
    headers: {
      ...parseHeaders(provider?.customHeaders),
      ...providerCredentialHeaders(provider, token)
    },
    model: runtimeTarget?.model || requestedModel,
    protocol
  }
}

function systemPrompt(): string {
  return [
    '你是 CaoGen 的任务拆解器,只输出 JSON,不要输出 Markdown。',
    '请把复杂软件开发需求拆成 DAG 子任务。',
    '输出格式:{"title":"...","tasks":[{"id":"kebab-id","title":"...","description":"...","dependencies":["id"],"role":"frontend|backend|qa|docs|devops|review|general"}]}。',
    '约束:任务数 1-33;id 必须唯一;dependencies 只能引用已存在任务 id;避免循环依赖;QA/验证任务通常依赖实现任务。'
  ].join('\n')
}

function userPrompt(input: TaskDecomposeInput): string {
  return [
    `需求: ${input.request}`,
    input.cwd ? `项目目录: ${input.cwd}` : '',
    '',
    '请按现有项目边界拆解,每个任务要能交给独立子 Agent 和 Git worktree 执行。'
  ]
    .filter(Boolean)
    .join('\n')
}

function isRole(value: string): value is TaskDagRole {
  return TASK_ROLES.includes(value as TaskDagRole)
}

function sanitizeTask(value: unknown): ModelDagTaskPayload | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  const rawRole = typeof record.role === 'string' ? record.role.trim() : 'general'
  const role = isRole(rawRole) ? rawRole : 'general'
  const dependencies = Array.isArray(record.dependencies)
    ? record.dependencies
        .filter((dep): dep is string => typeof dep === 'string')
        .map((dep) => dep.trim())
        .filter(Boolean)
    : []
  if (!id || !title || !description) return null
  return { id, title, description, dependencies, role }
}

function parseDagPayload(text: string): ModelDagPayload {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const jsonText = fenced ? fenced[1] : trimmed
  const parsed = JSON.parse(jsonText) as unknown
  if (!parsed || typeof parsed !== 'object') throw new Error('模型未返回 JSON 对象')
  const record = parsed as Record<string, unknown>
  const tasks = Array.isArray(record.tasks)
    ? record.tasks.map(sanitizeTask).filter((task): task is ModelDagTaskPayload => Boolean(task))
    : []
  if (tasks.length === 0) throw new Error('模型未返回有效 tasks')
  return {
    title: typeof record.title === 'string' ? record.title.trim() : undefined,
    tasks
  }
}

function extractChatText(json: unknown): string {
  if (!json || typeof json !== 'object') return ''
  const choices = (json as Record<string, unknown>).choices
  if (!Array.isArray(choices)) return ''
  const first = choices[0]
  if (!first || typeof first !== 'object') return ''
  const message = (first as Record<string, unknown>).message
  if (!message || typeof message !== 'object') return ''
  const content = (message as Record<string, unknown>).content
  return typeof content === 'string' ? content : ''
}

function extractResponseText(json: unknown): string {
  if (!json || typeof json !== 'object') return ''
  const direct = (json as Record<string, unknown>).output_text
  if (typeof direct === 'string') return direct
  const output = (json as Record<string, unknown>).output
  if (!Array.isArray(output)) return ''
  const chunks: string[] = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const text = (part as Record<string, unknown>).text
      if (typeof text === 'string') chunks.push(text)
    }
  }
  return chunks.join('').trim()
}

async function fetchJson(
  url: string,
  config: ProviderModelConfig,
  body: Record<string, unknown>,
  attemptContext: ModelDagAttemptContext | undefined,
  parse: (json: unknown) => ModelDagPayload,
  runtime: ModelDagRuntimeDependencies
): Promise<ModelDagPayload> {
  if (!attemptContext) {
    throw new ModelAttemptPersistenceError(
      'start', false, undefined, new Error('DAG model request is missing canonical Run context')
    )
  }
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, MODEL_TIMEOUT_MS)
  try {
    await runtime.preflight?.({
      url,
      providerId: config.providerId,
      model: config.model,
      protocol: config.protocol,
      body
    })
    const result = await executePersistedModelAttempt({
      ...attemptContext,
      providerId: config.providerId,
      model: config.model,
      protocol: config.protocol === 'chat' ? 'openai.chat-completions' : 'openai.responses',
      adapterVersion: 'model-dag-decomposer-v1',
      executorReceipt: createNativeModelExecutorReceipt('model_dag_decomposer', {
        providerId: config.providerId, model: config.model,
        protocol: config.protocol === 'chat' ? 'openai.chat-completions' : 'openai.responses', adapterVersion: 'model-dag-decomposer-v1'
      }),
      context: { url, body },
      routeReason: 'DAG decomposer selected configured reasoning model',
      keyIdentity: { providerId: config.providerId, token: config.token }
    }, async () => {
      const res = await runtime.fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          ...config.headers
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!res.ok) throw new Error(`模型拆解请求失败:${res.status} ${await res.text()}`)
      const json = await res.json()
      return { payload: parse(json), usage: extractAttemptUsage(json, config.protocol) }
    }, {
      success: (value) => ({ usage: value.usage }),
      failure: (error) => classifyRuntimeModelFailure(error, { timedOut }),
      dependencies: runtime.attempt
    })
    return result.payload
  } finally {
    clearTimeout(timeout)
  }
}

async function callChat(
  input: TaskDecomposeInput,
  config: ProviderModelConfig,
  attemptContext: ModelDagAttemptContext | undefined,
  runtime: ModelDagRuntimeDependencies
): Promise<ModelDagPayload> {
  return fetchJson(`${config.baseUrl}/v1/chat/completions`, config, {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userPrompt(input) }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1
  }, attemptContext, (json) => parseDagResponse(json, extractChatText, 'content'), runtime)
}

async function callResponses(
  input: TaskDecomposeInput,
  config: ProviderModelConfig,
  attemptContext: ModelDagAttemptContext | undefined,
  runtime: ModelDagRuntimeDependencies
): Promise<ModelDagPayload> {
  return fetchJson(`${config.baseUrl}/v1/responses`, config, {
    model: config.model,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: systemPrompt() }] },
      { role: 'user', content: [{ type: 'input_text', text: userPrompt(input) }] }
    ],
    text: { format: { type: 'json_object' } },
    temperature: 0.1
  }, attemptContext, (json) => parseDagResponse(json, extractResponseText, 'output_text'), runtime)
}

export function createModelDagDecomposer(
  input: TaskDecomposeInput,
  attemptContext?: ModelDagAttemptContext,
  runtime: ModelDagRuntimeDependencies = DEFAULT_RUNTIME_DEPENDENCIES
): ModelDagDecomposer {
  return {
    async decompose() {
      const config = configFromInput(input)
      return config.protocol === 'chat'
        ? callChat(input, config, attemptContext, runtime)
        : callResponses(input, config, attemptContext, runtime)
    }
  }
}

function parseDagResponse(
  json: unknown,
  extract: (value: unknown) => string,
  field: string
): ModelDagPayload {
  const text = extract(json)
  if (!text) throw new Error(`模型响应缺少 ${field}`)
  return parseDagPayload(text)
}

function extractAttemptUsage(json: unknown, protocol: OpenAIProtocol) {
  if (!json || typeof json !== 'object') return undefined
  const usage = (json as Record<string, unknown>).usage as Record<string, unknown> | undefined
  if (!usage) return undefined
  const input = protocol === 'chat' ? usage.prompt_tokens : usage.input_tokens
  const output = protocol === 'chat' ? usage.completion_tokens : usage.output_tokens
  const detailsKey = protocol === 'chat' ? 'prompt_tokens_details' : 'input_tokens_details'
  const details = usage[detailsKey] as Record<string, unknown> | undefined
  return modelAttemptUsage({
    input: numericUsage(input),
    output: numericUsage(output),
    cacheRead: numericUsage(details?.cached_tokens)
  })
}

function numericUsage(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
