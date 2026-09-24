import type { McpOAuthBinding } from '../../shared/mcp-oauth-types'
import type { McpServerConfig } from './mcp-client'

const bindings = new WeakMap<McpServerConfig, McpOAuthBinding>()
const contexts = new WeakMap<McpServerConfig, string | undefined>()
let resolver: ((binding: McpOAuthBinding, config: McpServerConfig) => Promise<string | undefined>) | undefined
let rejected: ((binding: McpOAuthBinding, config: McpServerConfig) => void) | undefined
let context: ((binding: McpOAuthBinding, config: McpServerConfig) => string | undefined) | undefined

export function configureMcpOAuthRuntime(
  resolve: typeof resolver,
  reject: typeof rejected,
  identity?: typeof context
): void { resolver = resolve; rejected = reject; context = identity }

export function bindMcpOAuthRuntime(config: McpServerConfig, binding: McpOAuthBinding): void {
  bindings.set(config, Object.freeze({ ...binding }))
  contexts.set(config, context?.(binding, config))
}

export function mcpAuthorizationContext(config: McpServerConfig): string | undefined { return contexts.get(config) }

export async function mcpRuntimeHeaders(config: McpServerConfig): Promise<Record<string, string>> {
  const headers = { ...config.headers }, binding = bindings.get(config)
  if (!binding || !resolver || config.command || !config.url) return headers
  if (contexts.get(config) !== context?.(binding, config)) throw new Error('MCP 连接账号已变化，请重新发现工具并确认任务。')
  const token = await resolver(binding, config)
  if (contexts.get(config) !== context?.(binding, config)) throw new Error('MCP 连接账号已变化，请重新发现工具并确认任务。')
  if (!token) return headers
  if (Object.keys(headers).some(key => key.toLowerCase() === 'authorization')) {
    throw new Error('MCP 同时配置了静态 Authorization 和 OAuth，请移除静态凭据后重新批准插件。')
  }
  return { ...headers, Authorization: `Bearer ${token}` }
}

export async function assertMcpHttpAuthorized(config: McpServerConfig, response: Response): Promise<void> {
  if (response.status !== 401 && response.status !== 403) return
  const binding = bindings.get(config)
  if (binding) rejected?.(binding, config)
  await response.body?.cancel().catch(() => undefined)
  throw new Error(`MCP HTTP ${response.status}：服务需要授权，请在插件详情连接或重新授权；本次调用未自动重放。`)
}
