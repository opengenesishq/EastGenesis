import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { TextDecoder } from 'node:util'
import {
  authorizeMcpNetworkUrl,
  mcpNetworkErrorMessage,
  requestAuthorizedMcpUrl,
  requestMcpNetworkUrl,
  resolveMcpSseEndpoint,
  type AuthorizedMcpNetworkTarget
} from './mcp-network-policy'
import { buildAuthorizedSubprocessEnv } from '../security/subprocess-environment'

declare const __CAOGEN_APP_VERSION__: string

export type McpTransport = 'stdio' | 'sse' | 'http'

export interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  transport?: McpTransport
  headers?: Record<string, string>
}

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

export interface McpResourceDefinition {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export interface McpPromptDefinition {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

export interface McpDiscoveryResult {
  serverInfo?: { name?: string; version?: string }
  tools: McpToolDefinition[]
  resources: McpResourceDefinition[]
  prompts: McpPromptDefinition[]
}

export interface McpCallToolResult {
  content: unknown[]
  isError?: boolean
  structuredContent?: unknown
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  id?: number
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface McpClient {
  request(method: string, params?: unknown): Promise<unknown>
  close(): Promise<void>
}

interface SseEvent {
  event: string
  data: string
}

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_MCP_HTTP_RESPONSE_BYTES = 1024 * 1024
const MAX_MCP_SSE_EVENT_CHARS = 256 * 1024
const CLIENT_VERSION =
  typeof __CAOGEN_APP_VERSION__ === 'string'
    ? __CAOGEN_APP_VERSION__
    : process.env.CAOGEN_APP_VERSION || process.env.npm_package_version || '0.0.0'
const CLIENT_INFO = { name: 'caogen', version: CLIENT_VERSION }

export async function discoverMcpServer(config: McpServerConfig, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<McpDiscoveryResult> {
  const client = createClient(config, timeoutMs)
  try {
    const initialize = await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO
    })
    const [tools, resources, prompts] = await Promise.all([
      client.request('tools/list').catch(() => ({ tools: [] })),
      client.request('resources/list').catch(() => ({ resources: [] })),
      client.request('prompts/list').catch(() => ({ prompts: [] }))
    ])
    return {
      serverInfo: readServerInfo(initialize),
      tools: readArrayField(tools, 'tools').filter(isMcpTool),
      resources: readArrayField(resources, 'resources').filter(isMcpResource),
      prompts: readArrayField(prompts, 'prompts').filter(isMcpPrompt)
    }
  } finally {
    await client.close()
  }
}

export async function callMcpTool(
  config: McpServerConfig,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<McpCallToolResult> {
  const client = createClient(config, timeoutMs)
  try {
    await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO
    })
    const result = await client.request('tools/call', { name, arguments: args })
    if (!isRecord(result)) return { content: [{ type: 'text', text: String(result) }] }
    const content = Array.isArray(result.content) ? result.content : []
    return {
      content,
      isError: result.isError === true,
      ...(Object.hasOwn(result, 'structuredContent') ? { structuredContent: result.structuredContent } : {})
    }
  } finally {
    await client.close()
  }
}

export function builtinMcpServerTemplates(): Record<string, McpServerConfig> {
  return {
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      transport: 'stdio'
    },
    git: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-git'],
      transport: 'stdio'
    },
    memory: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      transport: 'stdio'
    },
    sequentialThinking: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      transport: 'stdio'
    }
  }
}

function createClient(config: McpServerConfig, timeoutMs: number): McpClient {
  if (config.command) return createStdioClient(config, timeoutMs)
  if (config.url && config.transport === 'sse') return createSseClient(config, timeoutMs)
  if (config.url) return createHttpClient(config, timeoutMs)
  throw new Error('MCP server 需要 command 或 url')
}

function createHttpClient(config: McpServerConfig, timeoutMs: number): McpClient {
  let id = 0
  const url = config.url
  if (!url) throw new Error('MCP HTTP URL 不能为空')
  return {
    async request(method: string, params?: unknown): Promise<unknown> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const requestId = ++id
        const body: JsonRpcRequest = { jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) }
        const { response } = await requestMcpNetworkUrl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(config.headers ?? {}) },
          body: JSON.stringify(body),
          signal: controller.signal
        })
        if (!response.ok) throw new Error(`MCP HTTP ${response.status}`)
        if (isEventStreamResponse(response)) return await readSseResponse(response, requestId, controller)
        return decodeResponse(await readJsonResponse(response), requestId)
      } finally {
        clearTimeout(timer)
      }
    },
    async close(): Promise<void> {
      return undefined
    }
  }
}

function createSseClient(config: McpServerConfig, timeoutMs: number): McpClient {
  const url = config.url
  if (!url) throw new Error('MCP SSE URL 不能为空')

  let id = 0
  let target: AuthorizedMcpNetworkTarget | null = null
  let endpoint: URL | null = null
  let streamError: Error | null = null
  let closed = false
  const controller = new AbortController()
  const pending = new Map<number, PendingRequest>()
  let endpointReadyResolve: (() => void) | null = null
  let endpointReadyReject: ((error: Error) => void) | null = null
  let endpointReadySettled = false
  const endpointReady = new Promise<void>((resolveReady, rejectReady) => {
    endpointReadyResolve = resolveReady
    endpointReadyReject = rejectReady
  })
  const failStream = (error: unknown): void => {
    const safe = safeMcpNetworkError(error)
    streamError = safe
    if (!endpointReadySettled) {
      endpointReadySettled = true
      endpointReadyReject?.(safe)
    }
    rejectPending(pending, safe)
    if (!controller.signal.aborted) controller.abort()
  }
  const ready = (async () => {
    target = await authorizeMcpNetworkUrl(url)
    const opened = await openSseStream(target, config.headers, controller)
    void consumeSseStream(opened.response, opened.finalUrl, target, (event, streamUrl, authorizedTarget) => {
      if (event.event === 'endpoint') {
        const resolved = resolveMcpSseEndpoint(authorizedTarget, streamUrl, event.data)
        if (endpoint && endpoint.href !== resolved.href) throw new Error('MCP SSE endpoint changed')
        endpoint = resolved
        if (!endpointReadySettled) {
          endpointReadySettled = true
          endpointReadyResolve?.()
        }
        return
      }
      resolveSseMessage(event, pending)
    }).catch(failStream)
  })()

  return {
    async request(method: string, params?: unknown): Promise<unknown> {
      if (closed) throw new Error('MCP SSE client 已关闭')
      await waitForSseStartup(ready, timeoutMs, controller)
      await waitForSseStartup(endpointReady, timeoutMs, controller)
      if (streamError) throw streamError
      if (!target || !endpoint) throw new Error('MCP SSE server 未返回 endpoint 事件')

      const requestId = ++id
      const payload: JsonRpcRequest = { jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) }
      return await new Promise<unknown>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          rejectPromise(new Error(`MCP SSE 请求超时: ${method}`))
        }, timeoutMs)
        pending.set(requestId, { resolve: resolvePromise, reject: rejectPromise, timer })
        void requestAuthorizedMcpUrl(target as AuthorizedMcpNetworkTarget, endpoint as URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(config.headers ?? {}) },
          body: JSON.stringify(payload),
          signal: controller.signal
        }).then(async ({ response }) => {
          if (!response.ok) throw new Error(`MCP SSE POST ${response.status}`)
          await response.body?.cancel()
        }).catch((error) => {
          pending.delete(requestId)
          clearTimeout(timer)
          rejectPromise(safeMcpNetworkError(error))
        })
      })
    },
    async close(): Promise<void> {
      closed = true
      controller.abort()
      rejectPending(pending, new Error('MCP SSE client 已关闭'))
    }
  }
}

function resolveSseMessage(event: SseEvent, pending: Map<number, PendingRequest>): void {
  const message = parseJsonRpcEvent(event.data)
  if (!message || typeof message.id !== 'number') return
  const item = pending.get(message.id)
  if (!item) return
  pending.delete(message.id)
  clearTimeout(item.timer)
  try {
    item.resolve(decodeResponse(message, message.id))
  } catch (error) {
    item.reject(error instanceof Error ? error : new Error('MCP SSE response failed'))
  }
}

function createStdioClient(config: McpServerConfig, timeoutMs: number): McpClient {
  const args = Array.isArray(config.args) ? config.args : []
  const child = spawn(config.command as string, args, {
    env: buildMcpProcessEnv(config.env),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let id = 0
  let buffer = ''
  const pending = new Map<number, PendingRequest>()

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let message: JsonRpcResponse
      try {
        message = JSON.parse(trimmed) as JsonRpcResponse
      } catch {
        continue
      }
      if (typeof message.id !== 'number') continue
      const item = pending.get(message.id)
      if (!item) continue
      pending.delete(message.id)
      clearTimeout(item.timer)
      try {
        item.resolve(decodeResponse(message, message.id))
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
  })

  child.on('error', (error) => rejectAll(child, pending, error))
  child.on('exit', (code) => rejectAll(child, pending, new Error(`MCP stdio 进程退出: ${code ?? 'null'}`)))

  return {
    request(method: string, params?: unknown): Promise<unknown> {
      const requestId = ++id
      const payload: JsonRpcRequest = { jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) }
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          rejectPromise(new Error(`MCP 请求超时: ${method}`))
        }, timeoutMs)
        pending.set(requestId, { resolve: resolvePromise, reject: rejectPromise, timer })
        child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8')
      })
    },
    async close(): Promise<void> {
      for (const item of pending.values()) clearTimeout(item.timer)
      pending.clear()
      if (!child.killed) child.kill()
    }
  }
}

function mcpTransport(config: McpServerConfig): McpTransport {
  if (config.command) return 'stdio'
  return config.transport === 'sse' ? 'sse' : 'http'
}

export function buildMcpProcessEnv(configEnv: Record<string, string> | undefined): NodeJS.ProcessEnv {
  return buildAuthorizedSubprocessEnv(configEnv ?? {})
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

function rejectAll(child: ChildProcessWithoutNullStreams, pending: Map<number, PendingRequest>, error: Error): void {
  rejectPending(pending, error)
  if (!child.killed) child.kill()
}

function rejectPending(pending: Map<number, PendingRequest>, error: Error): void {
  for (const item of pending.values()) {
    clearTimeout(item.timer)
    item.reject(error)
  }
  pending.clear()
}

function decodeResponse(value: unknown, id: number): unknown {
  if (!isRecord(value)) throw new Error(`MCP 响应不是对象: ${id}`)
  if (isRecord(value.error)) {
    const code = typeof value.error.code === 'number' ? ` (${value.error.code})` : ''
    throw new Error(`MCP server returned an error${code}`)
  }
  return value.result
}

async function readJsonResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('MCP HTTP response body is missing')
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_HTTP_RESPONSE_BYTES) {
    await response.body.cancel().catch(() => undefined)
    throw new Error('MCP HTTP response exceeded the size limit')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_MCP_HTTP_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('MCP HTTP response exceeded the size limit')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'MCP HTTP response exceeded the size limit') throw error
    throw new Error('MCP HTTP response could not be read')
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8')) as unknown
  } catch {
    throw new Error('MCP HTTP response is not valid JSON')
  }
}

async function readSseResponse(response: Response, id: number, controller: AbortController): Promise<unknown> {
  if (!response.body) throw new Error('MCP SSE 响应缺少 body')
  for await (const event of iterateSseEvents(response.body)) {
    const message = parseJsonRpcEvent(event.data)
    if (!message || message.id !== id) continue
    controller.abort()
    return decodeResponse(message, id)
  }
  throw new Error(`MCP SSE 响应未包含请求 ${id}`)
}

async function openSseStream(
  target: AuthorizedMcpNetworkTarget,
  headers: Record<string, string> | undefined,
  controller: AbortController
): Promise<{ response: Response; finalUrl: URL }> {
  const opened = await requestAuthorizedMcpUrl(target, target.url, {
    method: 'GET',
    headers: { accept: 'text/event-stream', ...(headers ?? {}) },
    signal: controller.signal
  })
  const { response } = opened
  if (!response.ok) throw new Error(`MCP SSE GET ${response.status}`)
  if (!response.body) throw new Error('MCP SSE stream 缺少 body')
  return opened
}

async function consumeSseStream(
  response: Response,
  streamUrl: URL,
  target: AuthorizedMcpNetworkTarget,
  onEvent: (event: SseEvent, streamUrl: URL, target: AuthorizedMcpNetworkTarget) => void
): Promise<void> {
  if (!response.body) throw new Error('MCP SSE stream 缺少 body')
  for await (const event of iterateSseEvents(response.body)) onEvent(event, streamUrl, target)
}

async function waitForSseStartup(
  promise: Promise<void>,
  timeoutMs: number,
  controller: AbortController
): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('MCP SSE startup timed out'))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function safeMcpNetworkError(error: unknown): Error {
  const networkMessage = mcpNetworkErrorMessage(error)
  if (networkMessage !== 'MCP network request failed') return new Error(networkMessage)
  const message = error instanceof Error ? error.message : ''
  if (
    /^MCP SSE (?:GET|POST) \d+$/.test(message) ||
    message === 'MCP SSE startup timed out' ||
    message === 'MCP SSE endpoint changed' ||
    message === 'MCP SSE event exceeded the size limit' ||
    message === 'MCP SSE stream 缺少 body' ||
    message === 'MCP SSE server 未返回 endpoint 事件'
  ) {
    return new Error(message)
  }
  return new Error(networkMessage)
}

async function* iterateSseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split(/\r?\n\r?\n/)
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        if (part.length > MAX_MCP_SSE_EVENT_CHARS) throw new Error('MCP SSE event exceeded the size limit')
        const event = parseSseEvent(part)
        if (event) yield event
      }
      if (buffer.length > MAX_MCP_SSE_EVENT_CHARS) throw new Error('MCP SSE event exceeded the size limit')
    }
    buffer += decoder.decode()
    if (buffer.length > MAX_MCP_SSE_EVENT_CHARS) throw new Error('MCP SSE event exceeded the size limit')
    const event = parseSseEvent(buffer)
    if (event) yield event
  } finally {
    reader.releaseLock()
  }
}

function parseSseEvent(raw: string): SseEvent | null {
  const lines = raw.split(/\r?\n/)
  let event = 'message'
  const data: string[] = []
  for (const line of lines) {
    if (line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '')
    if (field === 'event') event = value || 'message'
    if (field === 'data') data.push(value)
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}

function parseJsonRpcEvent(data: string): JsonRpcResponse | null {
  try {
    const parsed = JSON.parse(data) as unknown
    return isRecord(parsed) ? (parsed as JsonRpcResponse) : null
  } catch {
    return null
  }
}

function isEventStreamResponse(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')
}

function readServerInfo(value: unknown): { name?: string; version?: string } | undefined {
  if (!isRecord(value) || !isRecord(value.serverInfo)) return undefined
  return {
    name: typeof value.serverInfo.name === 'string' ? value.serverInfo.name : undefined,
    version: typeof value.serverInfo.version === 'string' ? value.serverInfo.version : undefined
  }
}

function readArrayField(value: unknown, key: string): unknown[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return []
  return value[key]
}

function isMcpTool(value: unknown): value is McpToolDefinition {
  return isRecord(value) && typeof value.name === 'string'
}

function isMcpResource(value: unknown): value is McpResourceDefinition {
  return isRecord(value) && typeof value.uri === 'string'
}

function isMcpPrompt(value: unknown): value is McpPromptDefinition {
  return isRecord(value) && typeof value.name === 'string'
}

export function normalizeMcpServerConfig(value: unknown): McpServerConfig | null {
  if (!isRecord(value)) return null
  const command = typeof value.command === 'string' && value.command.trim() ? value.command.trim() : undefined
  const url = typeof value.url === 'string' && value.url.trim() ? value.url.trim() : undefined
  const transport =
    value.transport === 'stdio' || value.transport === 'sse' || value.transport === 'http'
      ? value.transport
      : url
        ? 'http'
        : command
          ? 'stdio'
          : undefined
  if (!command && !url) return null
  const env = isStringRecord(value.env)
  const headers = isStringRecord(value.headers)
  return {
    ...(command ? { command } : {}),
    ...(Array.isArray(value.args) ? { args: value.args.filter((item): item is string => typeof item === 'string') } : {}),
    ...(env ? { env } : {}),
    ...(url ? { url } : {}),
    ...(transport ? { transport } : {}),
    ...(headers ? { headers } : {})
  }
}

function isStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
