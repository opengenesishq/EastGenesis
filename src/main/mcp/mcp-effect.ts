import type { EffectTarget } from '../../shared/types'
import { looksLikeProviderCredentialValue } from '../providerCredentialBroker'
import { confirmed, unresolved, type EffectReconciliationResult } from '../task/effect-reconciliation-result'
import { stableValueDigest } from '../task/tool-idempotency'
import { mcpAuthorizationContext } from './mcp-oauth-runtime'
import {
  callMcpTool,
  discoverMcpServer,
  type McpCallToolResult,
  type McpDiscoveryResult,
  type McpServerConfig,
  type McpToolDefinition,
  type McpTransport
} from './mcp-client'
import {
  authorizeMcpRuntimeBinding,
  authorizeMcpRuntimeConfig,
  publicMcpRuntimeConfig,
  type PluginRuntimeBinding
} from '../plugin/plugin-runtime-authorization'

type McpEffectTarget = Extract<EffectTarget, { kind: 'mcp_tool_call' }>

interface ApprovedDiscovery {
  discovery: McpDiscoveryResult
  discoveryDigest: string
  binding: PluginRuntimeBinding
}

interface McpReconciliationInput {
  toolName: string
  arguments: Record<string, unknown>
  jsonPointer: string
  expectedValue: unknown
}

export interface McpEffectExecutionResult {
  ok: boolean
  existing?: boolean
  result?: McpCallToolResult
  error?: string
}

const approvedDiscoveries = new Map<string, ApprovedDiscovery>()
const MAX_CONFIG_TEXT = 8_192
const MAX_QUERY_JSON = 64 * 1024
const SENSITIVE_FIELD = /(?:^|[-_.])(?:api.?key|authorization|cookie|credential|password|private.?key|secret|signature|token)(?:$|[-_.])/i

export function mcpServerConfigFromToolInput(input: Record<string, unknown>): McpServerConfig {
  if (Object.hasOwn(input, 'env') || Object.hasOwn(input, 'headers')) {
    throw new Error('模型 MCP 调用不允许传入 env 或 headers；请使用受管 MCP 配置')
  }
  const command = optionalText(input.command)
  const url = optionalText(input.url)
  const transport = mcpTransport(input.transport, command, url)
  const args = stringArray(input.args)
  const config: McpServerConfig = {
    ...(command ? { command } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(url ? { url } : {}),
    transport
  }
  assertEffectSafeConfig(config)
  return config
}

export function recordApprovedMcpDiscovery(
  config: McpServerConfig,
  binding: PluginRuntimeBinding,
  discovery: McpDiscoveryResult
): void {
  const normalized = effectSafeConfig(publicMcpRuntimeConfig(config))
  const serverIdentityDigest = mcpServerIdentityDigest(normalized)
  approvedDiscoveries.set(serverIdentityDigest, {
    discovery: cloneDiscovery(discovery),
    discoveryDigest: mcpDiscoveryDigest(discovery),
    binding: { ...binding }
  })
}

export function buildMcpEffectTarget(
  input: Record<string, unknown>,
  projectRoot?: string
): McpEffectTarget | undefined {
  const raw = input.reconciliation
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new Error('MCP reconciliation 必须是对象')
  const requestedConfig = input.command !== undefined || input.url !== undefined
    ? mcpServerConfigFromToolInput(input)
    : undefined
  const authorized = authorizeMcpRuntimeConfig({
    projectRoot,
    serverId: requiredText(input.serverId, 'MCP serverId'),
    requestedConfig
  })
  const config = authorized.publicConfig
  const serverIdentityDigest = mcpServerIdentityDigest(config)
  const approved = approvedDiscoveries.get(serverIdentityDigest)
  if (!approved) {
    throw new Error('可查询 MCP 调用要求先对同一服务器显式执行 mcp_discover 并获得批准')
  }
  if (
    approved.binding.registryItemKey !== authorized.binding.registryItemKey ||
    approved.binding.contentDigest !== authorized.binding.contentDigest ||
    approved.binding.capabilityDigest !== authorized.binding.capabilityDigest ||
    approved.discovery.authorizationContext !== mcpAuthorizationContext(authorized.config)
  ) {
    throw new Error('MCP Plugin Registry approval changed after discovery')
  }
  const toolName = requiredText(input.toolName, 'MCP toolName')
  requireDiscoveredTool(approved.discovery, toolName, false)
  const reconciliation = reconciliationInput(raw)
  if (reconciliation.toolName === toolName) {
    throw new Error('MCP 副作用工具和只读对账工具必须不同')
  }
  requireDiscoveredTool(approved.discovery, reconciliation.toolName, true)
  const toolArguments = record(input.arguments)
  assertSafeStoredValue(reconciliation.arguments, 'reconciliation.arguments')
  return {
    kind: 'mcp_tool_call',
    ...persistedConfig(config),
    serverIdentityDigest,
    pluginRegistryItemKey: approved.binding.registryItemKey,
    pluginContentDigest: approved.binding.contentDigest,
    pluginCapabilityDigest: approved.binding.capabilityDigest,
    pluginServerId: approved.binding.serverId,
    discoveryDigest: approved.discoveryDigest,
    toolName,
    toolArgumentsDigest: stableValueDigest(toolArguments),
    queryToolName: reconciliation.toolName,
    queryArguments: cloneRecord(reconciliation.arguments),
    queryArgumentsDigest: stableValueDigest(reconciliation.arguments),
    jsonPointer: reconciliation.jsonPointer,
    expectedValueDigest: stableValueDigest(reconciliation.expectedValue)
  }
}

export async function executeMcpEffectTarget(
  target: McpEffectTarget,
  input: Record<string, unknown>,
  timeoutMs?: number
): Promise<McpEffectExecutionResult> {
  try {
    assertMcpExecutionMatchesTarget(target, input)
    const config = authorizedConfigFromTarget(target)
    const before = await observeMcpEffectTarget(target, timeoutMs)
    if (!before.complete) return { ok: false, error: before.error ?? 'MCP 前置对账失败' }
    if (before.matches) return { ok: true, existing: true, result: before.result }
    const result = await callMcpTool(
      config,
      target.toolName,
      record(input.arguments),
      timeoutMs
    )
    return { ok: result.isError !== true, result, ...(result.isError === true ? { error: 'MCP tool returned isError=true' } : {}) }
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}

export async function reconcileMcpEffectTarget(
  target: McpEffectTarget
): Promise<EffectReconciliationResult> {
  const observation = await observeMcpEffectTarget(target)
  const payload = {
    kind: target.kind,
    serverIdentityDigest: target.serverIdentityDigest,
    discoveryDigest: target.discoveryDigest,
    toolName: target.toolName,
    queryToolName: target.queryToolName,
    queryArgumentsDigest: target.queryArgumentsDigest,
    jsonPointer: target.jsonPointer,
    observedValueDigest: observation.observedValueDigest
  }
  if (!observation.complete) {
    return unresolved({ ...payload, reason: observation.error ?? 'MCP 对账查询不完整' })
  }
  if (observation.matches) {
    return confirmed(payload, 'MCP 只读查询返回冻结的预期后置条件，已确认副作用发生')
  }
  return unresolved({
    ...payload,
    reason: 'MCP 只读查询未返回预期后置条件；无法证明历史上从未执行，禁止自动重放'
  })
}

async function observeMcpEffectTarget(
  target: McpEffectTarget,
  timeoutMs?: number
): Promise<{
  complete: boolean
  matches: boolean
  observedValueDigest?: string
  result?: McpCallToolResult
  error?: string
}> {
  try {
    const config = authorizedConfigFromTarget(target)
    const discovery = await discoverMcpServer(config, timeoutMs)
    if (mcpDiscoveryDigest(discovery) !== target.discoveryDigest) {
      return { complete: false, matches: false, error: 'MCP server capability snapshot 已变化，拒绝运行旧对账查询' }
    }
    requireDiscoveredTool(discovery, target.queryToolName, true)
    const result = await callMcpTool(config, target.queryToolName, cloneRecord(target.queryArguments), timeoutMs)
    if (result.isError === true) {
      return { complete: false, matches: false, result, error: 'MCP 只读对账工具返回 isError=true' }
    }
    const observed = resolveJsonPointer(mcpObservationRoot(result), target.jsonPointer)
    if (!observed.found) {
      return { complete: false, matches: false, result, error: `MCP 对账结果缺少 JSON Pointer ${target.jsonPointer}` }
    }
    const observedValueDigest = stableValueDigest(observed.value)
    return {
      complete: true,
      matches: observedValueDigest === target.expectedValueDigest,
      observedValueDigest,
      result
    }
  } catch (error) {
    return { complete: false, matches: false, error: errorText(error) }
  }
}

function assertMcpExecutionMatchesTarget(target: McpEffectTarget, input: Record<string, unknown>): void {
  assertRuntimeBoundTarget(target)
  if (requiredText(input.serverId, 'MCP serverId') !== target.pluginServerId) {
    throw new Error('MCP serverId 已偏离效果审批时 Plugin Registry 身份')
  }
  const requestedConfig = input.command !== undefined || input.url !== undefined
    ? mcpServerConfigFromToolInput(input)
    : undefined
  const authorized = authorizeMcpRuntimeBinding({
    binding: {
      registryItemKey: target.pluginRegistryItemKey,
      contentDigest: target.pluginContentDigest,
      capabilityDigest: target.pluginCapabilityDigest,
      serverId: target.pluginServerId
    },
    requestedConfig
  })
  if (mcpServerIdentityDigest(authorized.publicConfig) !== target.serverIdentityDigest) {
    throw new Error('MCP server 配置已偏离效果审批时身份')
  }
  if (requiredText(input.toolName, 'MCP toolName') !== target.toolName) {
    throw new Error('MCP toolName 已偏离效果审批时意图')
  }
  if (stableValueDigest(record(input.arguments)) !== target.toolArgumentsDigest) {
    throw new Error('MCP arguments 已偏离效果审批时意图')
  }
  if (!isRecord(input.reconciliation)) throw new Error('MCP reconciliation contract 已缺失')
  const reconciliation = reconciliationInput(input.reconciliation)
  if (
    reconciliation.toolName !== target.queryToolName ||
    stableValueDigest(reconciliation.arguments) !== target.queryArgumentsDigest ||
    reconciliation.jsonPointer !== target.jsonPointer ||
    stableValueDigest(reconciliation.expectedValue) !== target.expectedValueDigest
  ) {
    throw new Error('MCP reconciliation contract 已偏离效果审批时意图')
  }
}

function reconciliationInput(input: Record<string, unknown>): McpReconciliationInput {
  if (!Object.hasOwn(input, 'expectedValue')) throw new Error('MCP reconciliation 缺少 expectedValue')
  const jsonPointer = requiredText(input.jsonPointer, 'MCP reconciliation.jsonPointer')
  validateJsonPointer(jsonPointer)
  const args = record(input.arguments)
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_QUERY_JSON) {
    throw new Error(`MCP reconciliation.arguments 超过 ${MAX_QUERY_JSON} bytes`)
  }
  return {
    toolName: requiredText(input.toolName, 'MCP reconciliation.toolName'),
    arguments: args,
    jsonPointer,
    expectedValue: input.expectedValue
  }
}

function requireDiscoveredTool(
  discovery: McpDiscoveryResult,
  toolName: string,
  requireReadOnly: boolean
): McpToolDefinition {
  const matches = discovery.tools.filter((tool) => tool.name === toolName)
  if (matches.length !== 1) throw new Error(`MCP discovery 未唯一找到工具 ${toolName}`)
  const tool = matches[0]
  if (requireReadOnly && tool.annotations?.readOnlyHint !== true) {
    throw new Error(`MCP 对账工具 ${toolName} 未声明 annotations.readOnlyHint=true`)
  }
  return tool
}

function effectSafeConfig(config: McpServerConfig): McpServerConfig {
  assertEffectSafeConfig(config)
  const transport = mcpTransport(config.transport, config.command, config.url)
  return {
    ...(config.command ? { command: config.command.trim() } : {}),
    ...(config.args?.length ? { args: [...config.args] } : {}),
    ...(config.url ? { url: config.url.trim() } : {}),
    transport
  }
}

function assertEffectSafeConfig(config: McpServerConfig): void {
  if (config.env && Object.keys(config.env).length > 0) throw new Error('可查询 MCP Effect 不持久化 env')
  if (config.headers && Object.keys(config.headers).length > 0) throw new Error('可查询 MCP Effect 不持久化 headers')
  const command = config.command?.trim()
  const url = config.url?.trim()
  if (Boolean(command) === Boolean(url)) throw new Error('MCP server 必须且只能配置 command 或 url')
  if (command && config.transport !== 'stdio') throw new Error('MCP command 只支持 stdio transport')
  if (url && config.transport === 'stdio') throw new Error('MCP URL 不支持 stdio transport')
  if (url && (config.args?.length ?? 0) > 0) throw new Error('MCP URL 配置不接受 command args')
  if (command) assertSafeConfigText(command, 'command')
  for (const [index, value] of (config.args ?? []).entries()) {
    assertSafeConfigText(value, `args[${index}]`)
    if (/^(?:-H|--header|-e|--env|--env-file)$/i.test(value.trim()) ||
        /^--?(?:api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|signature|token)(?:=|$)/i.test(value.trim())) {
      throw new Error(`MCP args[${index}] 可能承载凭据，不能写入 EffectTarget`)
    }
  }
  if (url) {
    assertSafeConfigText(url, 'url')
    const parsed = new URL(url)
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('可查询 MCP Effect 的 URL 不允许 userinfo、query 或 fragment')
    }
  }
}

function assertSafeConfigText(value: string, field: string): void {
  if (!value || value.length > MAX_CONFIG_TEXT || /[\0\r\n]/.test(value)) {
    throw new Error(`MCP ${field} 为空、过长或包含控制字符`)
  }
  if (looksLikeProviderCredentialValue(value) || /(?:token|secret|password|api.?key)\s*[:=]/i.test(value)) {
    throw new Error(`MCP ${field} 疑似包含凭据，不能写入 EffectTarget`)
  }
}

function assertSafeStoredValue(value: unknown, field: string, depth = 0): void {
  if (depth > 16) throw new Error(`${field} 嵌套过深`)
  if (typeof value === 'string') {
    if (value.length > MAX_CONFIG_TEXT || looksLikeProviderCredentialValue(value)) {
      throw new Error(`${field} 疑似包含凭据或超长字符串`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeStoredValue(item, `${field}[${index}]`, depth + 1))
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(key)) throw new Error(`${field}.${key} 是敏感字段，不能写入 EffectTarget`)
    assertSafeStoredValue(item, `${field}.${key}`, depth + 1)
  }
}

function mcpServerIdentityDigest(config: McpServerConfig): string {
  return stableValueDigest(effectSafeConfig(config))
}

function mcpDiscoveryDigest(discovery: McpDiscoveryResult): string {
  return stableValueDigest({
    ...(discovery.authorizationContext ? { authorizationContext: discovery.authorizationContext } : {}),
    serverInfo: discovery.serverInfo,
    tools: [...discovery.tools]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations
      }))
  })
}

function cloneDiscovery(discovery: McpDiscoveryResult): McpDiscoveryResult {
  return JSON.parse(JSON.stringify(discovery)) as McpDiscoveryResult
}

function persistedConfig(config: McpServerConfig): Pick<
  McpEffectTarget,
  'transport' | 'command' | 'commandArgs' | 'url'
> {
  const normalized = effectSafeConfig(config)
  return {
    transport: normalized.transport as McpTransport,
    ...(normalized.command ? { command: normalized.command } : {}),
    ...(normalized.args?.length ? { commandArgs: [...normalized.args] } : {}),
    ...(normalized.url ? { url: normalized.url } : {})
  }
}

function publicConfigFromTarget(target: McpEffectTarget): McpServerConfig {
  const config: McpServerConfig = {
    ...(target.command ? { command: target.command } : {}),
    ...(target.commandArgs?.length ? { args: [...target.commandArgs] } : {}),
    ...(target.url ? { url: target.url } : {}),
    transport: target.transport
  }
  if (mcpServerIdentityDigest(config) !== target.serverIdentityDigest) {
    throw new Error('MCP EffectTarget server identity digest 不匹配')
  }
  return config
}

function authorizedConfigFromTarget(target: McpEffectTarget): McpServerConfig {
  assertRuntimeBoundTarget(target)
  const publicConfig = publicConfigFromTarget(target)
  return authorizeMcpRuntimeBinding({
    binding: {
      registryItemKey: target.pluginRegistryItemKey,
      contentDigest: target.pluginContentDigest,
      capabilityDigest: target.pluginCapabilityDigest,
      serverId: target.pluginServerId
    },
    requestedConfig: publicConfig
  }).config
}

function assertRuntimeBoundTarget(target: McpEffectTarget): asserts target is McpEffectTarget & {
  pluginRegistryItemKey: string
  pluginContentDigest: string
  pluginCapabilityDigest: string
  pluginServerId: string
} {
  if (
    !target.pluginRegistryItemKey || !target.pluginContentDigest ||
    !target.pluginCapabilityDigest || !target.pluginServerId
  ) {
    throw new Error('Legacy MCP Effect lacks a Plugin Registry runtime binding; automatic replay is blocked')
  }
}

function mcpObservationRoot(result: McpCallToolResult): Record<string, unknown> {
  return {
    isError: result.isError === true,
    content: result.content.map((item) => parsedContentItem(item)),
    ...(Object.hasOwn(result, 'structuredContent') ? { structuredContent: result.structuredContent } : {})
  }
}

function parsedContentItem(value: unknown): unknown {
  if (!isRecord(value) || typeof value.text !== 'string') return value
  try {
    return { ...value, parsed: JSON.parse(value.text) as unknown }
  } catch {
    return value
  }
}

function resolveJsonPointer(root: unknown, pointer: string): { found: true; value: unknown } | { found: false } {
  validateJsonPointer(pointer)
  let current = root
  if (pointer === '') return { found: true, value: current }
  for (const raw of pointer.slice(1).split('/')) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) return { found: false }
      const index = Number(segment)
      if (index >= current.length) return { found: false }
      current = current[index]
      continue
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return { found: false }
    current = current[segment]
  }
  return { found: true, value: current }
}

function validateJsonPointer(value: string): void {
  if (value === '') return
  if (!value.startsWith('/') || value.split('/').length > 32 || /~(?:[^01]|$)/.test(value)) {
    throw new Error('MCP reconciliation.jsonPointer 不是有效的 RFC 6901 pointer')
  }
}

function mcpTransport(
  value: unknown,
  command?: string,
  url?: string
): McpTransport {
  if (value === 'stdio' || value === 'http' || value === 'sse') {
    if (command && value !== 'stdio') throw new Error('MCP command 只支持 stdio transport')
    if (url && value === 'stdio') throw new Error('MCP URL 不支持 stdio transport')
    return value
  }
  if (command) return 'stdio'
  if (url) return 'http'
  throw new Error('MCP server 需要 command 或 url')
}

function stringArray(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('MCP args 必须是字符串数组')
  }
  return value as string[]
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) {
    throw new Error(`${field} 不能为空或包含控制字符`)
  }
  return value.trim()
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
