import { createHash } from 'node:crypto'
import {
  loadSkills,
  serializeSkill,
  type SkillDefinition,
  type SkillLoadDiagnostic,
  type SkillScope
} from './skill-loader'
import { SkillManager, type SkillMatch } from './skill-manager'
import { draftSkillFromSummary, type SkillDraft, type SkillLearningInput, type SkillLearnerOptions } from './skill-learner'
import { testSkillMarkdown, type SkillTestDiagnostic, type SkillTestResult } from './skill-tester'
import {
  callMcpTool,
  discoverMcpServer,
  type McpCallToolResult,
  type McpDiscoveryResult,
  type McpServerConfig,
  type McpToolDefinition
} from '../mcp/mcp-client'
import { mcpToolName } from '../mcp/mcp-tool-adapter'
import {
  authorizeMcpRuntimeConfig,
  authorizeSkillRuntime
} from '../plugin/plugin-runtime-authorization'

export type SkillFabricCapabilityKind = 'skill' | 'mcpTool'
export type SkillFabricLifecycleStatus = 'available' | 'configured' | 'disabled' | 'invalid' | 'unavailable' | 'blocked'
export type SkillFabricInvocationExecution = 'prompt-only' | 'tool-call' | 'blocked'

export interface SkillFabricMcpPermissionPolicy {
  defaultToolCall?: 'allow' | 'deny'
  allowedServers?: string[]
  deniedServers?: string[]
  allowedTools?: string[]
  deniedTools?: string[]
}

export interface SkillFabricOptions {
  projectRoot?: string
  skillsEnabled?: boolean
  mcpEnabled?: boolean
  mcpServers?: Record<string, McpServerConfig>
  mcpDiscoveryTimeoutMs?: number
  mcpPermissionPolicy?: SkillFabricMcpPermissionPolicy
  now?: () => number
}

export interface SkillFabricRefreshOptions {
  discoverMcp?: boolean
}

export interface SkillFabricMatchOptions {
  skillThreshold?: number
  mcpThreshold?: number
  maxResults?: number
  refresh?: boolean
}

export interface SkillFabricLifecycleEntry {
  id: string
  kind: 'skill' | 'mcpServer' | 'mcpTool'
  name: string
  status: SkillFabricLifecycleStatus
  updatedAt: number
  reason?: string
  source?: string
  serverId?: string
  toolName?: string
  diagnostics?: SkillTestDiagnostic[] | SkillLoadDiagnostic[]
}

export interface SkillFabricCapability {
  id: string
  kind: SkillFabricCapabilityKind
  name: string
  description: string
  status: SkillFabricLifecycleStatus
  invocation: SkillFabricInvocationDescriptor
  updatedAt: number
  reason?: string
  tags?: string[]
  source?: string
  serverId?: string
  toolName?: string
  inputSchema?: Record<string, unknown>
}

export type SkillFabricInvocationDescriptor =
  | {
      type: 'skillPrompt'
      skillId: string
      scope: SkillScope
    }
  | {
      type: 'mcpTool'
      serverId: string
      toolName: string
      caogenToolName: string
    }

export interface SkillFabricView {
  refreshedAt: number
  skillsEnabled: boolean
  mcpEnabled: boolean
  skillDiagnostics: SkillLoadDiagnostic[]
  lifecycle: SkillFabricLifecycleEntry[]
  capabilities: SkillFabricCapability[]
  mcpDiscoveries: Record<string, McpDiscoveryResult>
}

export interface SkillFabricMatch {
  capability: SkillFabricCapability
  score: number
  reasons: string[]
}

export type SkillFabricInvokeInput =
  | {
      capabilityId: string
      query?: string
      arguments?: Record<string, unknown>
    }
  | {
      kind: 'skill'
      skillId: string
      query?: string
    }
  | {
      kind: 'mcpTool'
      serverId: string
      toolName: string
      arguments?: Record<string, unknown>
    }

export interface SkillFabricInvokeResult {
  ok: boolean
  capabilityId?: string
  kind?: SkillFabricCapabilityKind
  execution: SkillFabricInvocationExecution
  output: string
  result?: McpCallToolResult
  error?: string
}

interface McpToolIndexEntry {
  capability: SkillFabricCapability
  config: McpServerConfig
  rawTool: McpToolDefinition
}

const DEFAULT_MCP_TIMEOUT_MS = 10_000
const DEFAULT_SKILL_THRESHOLD = 0.42
const DEFAULT_MCP_THRESHOLD = 0.24
const DEFAULT_MAX_RESULTS = 8
const MAX_PROMPT_BODY_CHARS = 6_000

export class SkillFabric {
  private readonly projectRoot?: string
  private readonly skillsEnabled: boolean
  private readonly mcpEnabled: boolean
  private readonly mcpServers: Record<string, McpServerConfig>
  private readonly mcpDiscoveryTimeoutMs: number
  private readonly mcpPermissionPolicy: SkillFabricMcpPermissionPolicy
  private readonly now: () => number
  private readonly manager: SkillManager
  private skillDiagnostics: SkillLoadDiagnostic[] = []
  private skills: SkillDefinition[] = []
  private lifecycle: SkillFabricLifecycleEntry[] = []
  private capabilities: SkillFabricCapability[] = []
  private mcpDiscoveries = new Map<string, McpDiscoveryResult>()
  private mcpToolIndex = new Map<string, McpToolIndexEntry>()
  private refreshedAt = 0

  constructor(options: SkillFabricOptions = {}) {
    this.projectRoot = options.projectRoot
    this.skillsEnabled = options.skillsEnabled ?? true
    this.mcpEnabled = options.mcpEnabled ?? true
    this.mcpServers = sanitizeMcpServers(options.mcpServers ?? {})
    this.mcpDiscoveryTimeoutMs = normalizeTimeout(options.mcpDiscoveryTimeoutMs)
    this.mcpPermissionPolicy = options.mcpPermissionPolicy ?? { defaultToolCall: 'deny' }
    this.now = options.now ?? (() => Date.now())
    this.manager = new SkillManager({ projectRoot: this.projectRoot })
  }

  async refresh(options: SkillFabricRefreshOptions = {}): Promise<SkillFabricView> {
    const discoverMcp = options.discoverMcp ?? true
    const lifecycle: SkillFabricLifecycleEntry[] = []
    const capabilities: SkillFabricCapability[] = []
    this.mcpDiscoveries.clear()
    this.mcpToolIndex.clear()

    if (this.skillsEnabled) {
      const result = this.manager.reload()
      this.skills = result.skills
      this.skillDiagnostics = result.diagnostics
      for (const skill of this.skills) {
        const tested = validateSkillDefinition(skill)
        const status: SkillFabricLifecycleStatus = tested.ok ? 'available' : 'invalid'
        const lifecycleEntry: SkillFabricLifecycleEntry = {
          id: skill.id,
          kind: 'skill',
          name: skill.name,
          status,
          updatedAt: skill.updatedAt,
          reason: tested.ok ? undefined : 'Skill validation failed.',
          source: skill.sourcePath,
          diagnostics: tested.diagnostics
        }
        lifecycle.push(lifecycleEntry)
        capabilities.push(skillCapability(skill, status, lifecycleEntry.reason))
      }
    } else {
      this.skills = []
      this.skillDiagnostics = []
      lifecycle.push({
        id: 'skills',
        kind: 'skill',
        name: 'Skills',
        status: 'disabled',
        updatedAt: this.now(),
        reason: 'Skill loading disabled for this fabric.'
      })
    }

    if (this.mcpEnabled) {
      for (const [serverId, config] of Object.entries(this.mcpServers)) {
        if (!discoverMcp) {
          lifecycle.push({
            id: mcpServerLifecycleId(serverId),
            kind: 'mcpServer',
            name: serverId,
            status: 'configured',
            updatedAt: this.now(),
            reason: 'MCP discovery was skipped.',
            serverId
          })
          continue
        }
        try {
          const authorized = authorizeMcpRuntimeConfig({
            projectRoot: this.projectRoot,
            serverId,
            requestedConfig: config
          })
          const discovery = await discoverMcpServer(authorized.config, this.mcpDiscoveryTimeoutMs)
          this.mcpDiscoveries.set(serverId, discovery)
          lifecycle.push({
            id: mcpServerLifecycleId(serverId),
            kind: 'mcpServer',
            name: discovery.serverInfo?.name ?? serverId,
            status: 'available',
            updatedAt: this.now(),
            serverId
          })
          for (const tool of discovery.tools) {
            const capability = mcpToolCapability(serverId, tool, this.mcpPermissionPolicy, this.now())
            lifecycle.push({
              id: capability.id,
              kind: 'mcpTool',
              name: capability.name,
              status: capability.status,
              updatedAt: capability.updatedAt,
              reason: capability.reason,
              serverId,
              toolName: tool.name
            })
            capabilities.push(capability)
            this.mcpToolIndex.set(capability.id, { capability, config: authorized.config, rawTool: tool })
            this.mcpToolIndex.set(mcpToolLookupKey(serverId, tool.name), { capability, config: authorized.config, rawTool: tool })
          }
        } catch (error) {
          lifecycle.push({
            id: mcpServerLifecycleId(serverId),
            kind: 'mcpServer',
            name: serverId,
            status: 'unavailable',
            updatedAt: this.now(),
            reason: error instanceof Error ? error.message : String(error),
            serverId
          })
        }
      }
    } else {
      lifecycle.push({
        id: 'mcp',
        kind: 'mcpServer',
        name: 'MCP',
        status: 'disabled',
        updatedAt: this.now(),
        reason: 'MCP runtime disabled for this fabric.'
      })
    }

    this.lifecycle = lifecycle
    this.capabilities = capabilities
    this.refreshedAt = this.now()
    return this.view()
  }

  view(): SkillFabricView {
    return {
      refreshedAt: this.refreshedAt,
      skillsEnabled: this.skillsEnabled,
      mcpEnabled: this.mcpEnabled,
      skillDiagnostics: [...this.skillDiagnostics],
      lifecycle: [...this.lifecycle],
      capabilities: [...this.capabilities],
      mcpDiscoveries: Object.fromEntries(this.mcpDiscoveries.entries())
    }
  }

  async match(query: string, options: SkillFabricMatchOptions = {}): Promise<SkillFabricMatch[]> {
    if (options.refresh === true || this.refreshedAt === 0) await this.refresh()
    const cleanQuery = query.trim()
    if (!cleanQuery) return []

    const skillThreshold = normalizeScoreThreshold(options.skillThreshold, DEFAULT_SKILL_THRESHOLD)
    const mcpThreshold = normalizeScoreThreshold(options.mcpThreshold, DEFAULT_MCP_THRESHOLD)
    const maxResults = normalizeMaxResults(options.maxResults)
    const matches: SkillFabricMatch[] = []

    if (this.skillsEnabled) {
      const skillMatches = this.manager.match(cleanQuery, Math.min(skillThreshold, 0.1))
      for (const match of skillMatches) {
        const capability = this.capabilities.find((item) => item.id === skillCapabilityId(match.skill.id))
        if (!capability || match.score < skillThreshold) continue
        matches.push({
          capability,
          score: match.score,
          reasons: match.reasons
        })
      }
    }

    for (const capability of this.capabilities) {
      if (capability.kind !== 'mcpTool') continue
      const scored = scoreMcpCapability(capability, cleanQuery)
      if (scored.score < mcpThreshold) continue
      matches.push(scored)
    }

    return matches
      .sort((a, b) => b.score - a.score || statusRank(a.capability.status) - statusRank(b.capability.status) || a.capability.name.localeCompare(b.capability.name))
      .slice(0, maxResults)
  }

  async invoke(input: SkillFabricInvokeInput): Promise<SkillFabricInvokeResult> {
    if (this.refreshedAt === 0) await this.refresh()
    const capability = this.resolveCapability(input)
    if (!capability) {
      return { ok: false, execution: 'blocked', output: '', error: 'Capability not found.' }
    }
    if (capability.kind === 'skill') return this.invokeSkill(capability, input)
    return await this.invokeMcpTool(capability, input)
  }

  draftSkill(input: SkillLearningInput, options: SkillLearnerOptions = {}): SkillDraft {
    return draftSkillFromSummary(input, options)
  }

  testSkill(markdown: string, options: { sourcePath?: string; scope?: SkillScope; requireTrigger?: boolean } = {}): SkillTestResult {
    return testSkillMarkdown(markdown, options)
  }

  async testMcpServer(serverId: string): Promise<SkillFabricLifecycleEntry> {
    const config = this.mcpServers[serverId]
    if (!config) {
      return {
        id: mcpServerLifecycleId(serverId),
        kind: 'mcpServer',
        name: serverId,
        status: 'unavailable',
        updatedAt: this.now(),
        reason: 'MCP server is not configured.',
        serverId
      }
    }
    try {
      const authorized = authorizeMcpRuntimeConfig({
        projectRoot: this.projectRoot,
        serverId,
        requestedConfig: config
      })
      const discovery = await discoverMcpServer(authorized.config, this.mcpDiscoveryTimeoutMs)
      return {
        id: mcpServerLifecycleId(serverId),
        kind: 'mcpServer',
        name: discovery.serverInfo?.name ?? serverId,
        status: 'available',
        updatedAt: this.now(),
        serverId
      }
    } catch (error) {
      return {
        id: mcpServerLifecycleId(serverId),
        kind: 'mcpServer',
        name: serverId,
        status: 'unavailable',
        updatedAt: this.now(),
        reason: error instanceof Error ? error.message : String(error),
        serverId
      }
    }
  }

  private resolveCapability(input: SkillFabricInvokeInput): SkillFabricCapability | undefined {
    if ('capabilityId' in input) return this.capabilities.find((item) => item.id === input.capabilityId)
    if (input.kind === 'skill') return this.capabilities.find((item) => item.id === skillCapabilityId(input.skillId))
    if (input.kind === 'mcpTool') {
      return this.mcpToolIndex.get(mcpToolLookupKey(input.serverId, input.toolName))?.capability
    }
    return undefined
  }

  private invokeSkill(capability: SkillFabricCapability, input: SkillFabricInvokeInput): SkillFabricInvokeResult {
    const descriptor = capability.invocation
    if (descriptor.type !== 'skillPrompt') {
      return { ok: false, capabilityId: capability.id, kind: capability.kind, execution: 'blocked', output: '', error: 'Capability is not a skill.' }
    }
    const skill = this.manager.list().find((item) => item.id === descriptor.skillId)
    if (!skill) {
      return { ok: false, capabilityId: capability.id, kind: capability.kind, execution: 'blocked', output: '', error: 'Skill is not loaded.' }
    }
    if (capability.status !== 'available') {
      return {
        ok: false,
        capabilityId: capability.id,
        kind: capability.kind,
        execution: 'blocked',
        output: '',
        error: capability.reason ?? `Skill is ${capability.status}.`
      }
    }
    try {
      authorizeSkillRuntime(this.projectRoot, skill)
    } catch (error) {
      return {
        ok: false,
        capabilityId: capability.id,
        kind: capability.kind,
        execution: 'blocked',
        output: '',
        error: error instanceof Error ? error.message : String(error)
      }
    }
    const query = 'query' in input && typeof input.query === 'string' ? input.query : undefined
    return {
      ok: true,
      capabilityId: capability.id,
      kind: capability.kind,
      execution: 'prompt-only',
      output: formatSkillInvocationPrompt(skill, query)
    }
  }

  private async invokeMcpTool(
    capability: SkillFabricCapability,
    input: SkillFabricInvokeInput
  ): Promise<SkillFabricInvokeResult> {
    const descriptor = capability.invocation
    if (descriptor.type !== 'mcpTool') {
      return { ok: false, capabilityId: capability.id, kind: capability.kind, execution: 'blocked', output: '', error: 'Capability is not an MCP tool.' }
    }
    const indexed = this.mcpToolIndex.get(capability.id)
    if (!indexed) {
      return { ok: false, capabilityId: capability.id, kind: capability.kind, execution: 'blocked', output: '', error: 'MCP tool is not discovered.' }
    }
    const permission = evaluateMcpPermission(this.mcpPermissionPolicy, descriptor.serverId, descriptor.toolName)
    if (!permission.allowed) {
      return {
        ok: false,
        capabilityId: capability.id,
        kind: capability.kind,
        execution: 'blocked',
        output: '',
        error: permission.reason
      }
    }
    const args = 'arguments' in input && isRecord(input.arguments) ? input.arguments : {}
    try {
      const authorized = authorizeMcpRuntimeConfig({
        projectRoot: this.projectRoot,
        serverId: descriptor.serverId,
        requestedConfig: indexed.config
      })
      const result = await callMcpTool(authorized.config, indexed.rawTool.name, args, this.mcpDiscoveryTimeoutMs)
      return {
        ok: result.isError !== true,
        capabilityId: capability.id,
        kind: capability.kind,
        execution: 'tool-call',
        output: stringifyMcpContent(result.content),
        result,
        error: result.isError === true ? 'MCP tool returned isError=true.' : undefined
      }
    } catch (error) {
      return {
        ok: false,
        capabilityId: capability.id,
        kind: capability.kind,
        execution: 'tool-call',
        output: '',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

export function skillCapabilityId(skillId: string): string {
  return `skill:${skillId}`
}

export function mcpToolCapabilityId(serverId: string, toolName: string): string {
  return `mcpTool:${mcpToolName(serverId, toolName)}`
}

export function evaluateMcpPermission(
  policy: SkillFabricMcpPermissionPolicy | undefined,
  serverId: string,
  toolName: string
): { allowed: boolean; reason?: string } {
  const normalized = normalizePolicy(policy)
  const canonical = mcpToolName(serverId, toolName)
  if (normalized.deniedServers.has(serverId)) return { allowed: false, reason: `MCP server denied by policy: ${serverId}` }
  if (normalized.deniedTools.has(canonical) || normalized.deniedTools.has(toolName)) {
    return { allowed: false, reason: `MCP tool denied by policy: ${canonical}` }
  }
  if (normalized.allowedTools.has(canonical) || normalized.allowedTools.has(toolName)) return { allowed: true }
  if (normalized.allowedServers.has(serverId)) return { allowed: true }
  if (normalized.defaultToolCall === 'allow') return { allowed: true }
  return { allowed: false, reason: `MCP tool call requires explicit allow policy: ${canonical}` }
}

function skillCapability(
  skill: SkillDefinition,
  status: SkillFabricLifecycleStatus,
  reason: string | undefined
): SkillFabricCapability {
  return {
    id: skillCapabilityId(skill.id),
    kind: 'skill',
    name: skill.name,
    description: skill.description,
    status,
    reason,
    tags: skill.tags,
    source: skill.sourcePath,
    updatedAt: skill.updatedAt,
    invocation: {
      type: 'skillPrompt',
      skillId: skill.id,
      scope: skill.scope
    }
  }
}

function mcpToolCapability(
  serverId: string,
  tool: McpToolDefinition,
  policy: SkillFabricMcpPermissionPolicy,
  updatedAt: number
): SkillFabricCapability {
  const permission = evaluateMcpPermission(policy, serverId, tool.name)
  const caogenToolName = mcpToolName(serverId, tool.name)
  return {
    id: mcpToolCapabilityId(serverId, tool.name),
    kind: 'mcpTool',
    name: caogenToolName,
    description: tool.description || `MCP tool ${tool.name} from ${serverId}`,
    status: permission.allowed ? 'available' : 'blocked',
    reason: permission.reason,
    serverId,
    toolName: tool.name,
    inputSchema: tool.inputSchema,
    updatedAt,
    invocation: {
      type: 'mcpTool',
      serverId,
      toolName: tool.name,
      caogenToolName
    }
  }
}

function validateSkillDefinition(skill: SkillDefinition): SkillTestResult {
  return testSkillMarkdown(serializeSkill(skill), {
    sourcePath: skill.sourcePath ?? `builtin/${skill.id}/SKILL.md`,
    scope: skill.scope
  })
}

function formatSkillInvocationPrompt(skill: SkillDefinition, query: string | undefined): string {
  const lines = [
    '## EastGenesis Skill Invocation',
    'This is a prompt-only Skill invocation. It provides reusable instructions; it does not execute shell commands or modify files by itself.',
    '',
    `### ${skill.name}`,
    `- scope: ${skill.scope}`,
    `- description: ${compact(skill.description, 800)}`,
    skill.trigger ? `- trigger: ${compact(skill.trigger, 240)}` : '',
    skill.tags.length > 0 ? `- tags: ${skill.tags.join(', ')}` : '',
    skill.sourcePath ? `- source: ${skill.sourcePath}` : '',
    query ? `- matched request: ${compact(query, 600)}` : '',
    '',
    '### Skill Body',
    compact(skill.body, MAX_PROMPT_BODY_CHARS)
  ]
  return lines.filter((line) => line.trim().length > 0).join('\n')
}

function scoreMcpCapability(capability: SkillFabricCapability, query: string): SkillFabricMatch {
  const queryTokens = tokenize(query)
  const haystack = [
    capability.name,
    capability.description,
    capability.serverId,
    capability.toolName,
    JSON.stringify(capability.inputSchema ?? {})
  ].join(' ')
  const haystackTokens = new Set(tokenize(haystack))
  const matched = queryTokens.filter((token) => haystackTokens.has(token))
  const exactTool = includesNormalized(query, capability.toolName ?? capability.name)
  const exactServer = capability.serverId ? includesNormalized(query, capability.serverId) : false
  const base = queryTokens.length === 0 ? 0 : matched.length / queryTokens.length
  const boosted = Math.min(1, base * 0.74 + (exactTool ? 0.22 : 0) + (exactServer ? 0.08 : 0))
  return {
    capability,
    score: Number(boosted.toFixed(3)),
    reasons: [
      exactTool ? 'tool name match' : '',
      exactServer ? 'server match' : '',
      matched.length > 0 ? `keywords ${matched.slice(0, 5).join(', ')}` : '',
      capability.status === 'blocked' ? 'blocked by permission policy' : ''
    ].filter(Boolean)
  }
}

function tokenize(value: string): string[] {
  const normalized = value
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  if (!normalized) return []
  const words = normalized.split(/\s+/).filter((item) => item.length > 1)
  const chinese = Array.from(normalized.matchAll(/[\u4e00-\u9fa5]{2,}/g)).flatMap((match) => ngrams(match[0], 2, 4))
  return [...new Set([...words, ...chinese])]
}

function ngrams(value: string, min: number, max: number): string[] {
  const out: string[] = []
  for (let size = min; size <= max; size++) {
    for (let index = 0; index + size <= value.length; index++) out.push(value.slice(index, index + size))
  }
  return out
}

function includesNormalized(left: string, right: string): boolean {
  const a = left.toLowerCase().replace(/\s+/g, '')
  const b = right.toLowerCase().replace(/\s+/g, '')
  return Boolean(a && b && (a.includes(b) || b.includes(a)))
}

function normalizePolicy(policy: SkillFabricMcpPermissionPolicy | undefined): RequiredPolicy {
  return {
    defaultToolCall: policy?.defaultToolCall === 'allow' ? 'allow' : 'deny',
    allowedServers: new Set(policy?.allowedServers?.filter(Boolean) ?? []),
    deniedServers: new Set(policy?.deniedServers?.filter(Boolean) ?? []),
    allowedTools: new Set(policy?.allowedTools?.filter(Boolean) ?? []),
    deniedTools: new Set(policy?.deniedTools?.filter(Boolean) ?? [])
  }
}

interface RequiredPolicy {
  defaultToolCall: 'allow' | 'deny'
  allowedServers: Set<string>
  deniedServers: Set<string>
  allowedTools: Set<string>
  deniedTools: Set<string>
}

function sanitizeMcpServers(value: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const [serverId, config] of Object.entries(value)) {
    const cleanId = sanitizeServerId(serverId)
    if (!cleanId || !isRecord(config)) continue
    out[cleanId] = config
  }
  return out
}

function sanitizeServerId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
}

function normalizeTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return DEFAULT_MCP_TIMEOUT_MS
  return Math.min(60_000, Math.max(500, Math.floor(value)))
}

function normalizeScoreThreshold(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback
  return Math.min(1, Math.max(0, value))
}

function normalizeMaxResults(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value < 1) return DEFAULT_MAX_RESULTS
  return Math.min(25, value)
}

function statusRank(status: SkillFabricLifecycleStatus): number {
  if (status === 'available') return 0
  if (status === 'configured') return 1
  if (status === 'blocked') return 2
  if (status === 'invalid') return 3
  if (status === 'unavailable') return 4
  return 5
}

function compact(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trim()}...`
}

function mcpServerLifecycleId(serverId: string): string {
  return `mcpServer:${serverId}`
}

function mcpToolLookupKey(serverId: string, toolName: string): string {
  const hash = createHash('sha256').update(`${serverId}\0${toolName}`).digest('hex').slice(0, 12)
  return `${serverId}:${toolName}:${hash}`
}

function stringifyMcpContent(content: unknown[]): string {
  return content.map((item) => {
    if (typeof item === 'string') return item
    if (isRecord(item) && typeof item.text === 'string') return item.text
    return JSON.stringify(item)
  }).join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function createSkillFabricView(options: SkillFabricOptions, refreshOptions: SkillFabricRefreshOptions = {}): Promise<SkillFabricView> {
  return new SkillFabric(options).refresh(refreshOptions)
}

export function loadSkillFabricSkills(projectRoot?: string): { skills: SkillDefinition[]; diagnostics: SkillLoadDiagnostic[] } {
  const result = new SkillManager({ projectRoot }).reload()
  return { skills: result.skills, diagnostics: result.diagnostics }
}

export function skillFabricSkillMatches(projectRoot: string | undefined, query: string, threshold = DEFAULT_SKILL_THRESHOLD): SkillMatch[] {
  return new SkillManager({ projectRoot }).match(query, threshold)
}
