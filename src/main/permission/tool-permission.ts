import { fileURLToPath } from 'node:url'
import { isAbsolute, posix, relative, resolve } from 'node:path'
import type {
  AppSettings,
  PermissionRuleConfig,
  PermissionRuleEffect,
  ToolSemanticCapability,
  ToolRiskLevel
} from '../../shared/types'
import { normalizeGuiPostcondition } from '../gui/gui-postcondition'
import { classifyToolCapabilities, TOOL_SEMANTIC_CAPABILITIES } from './tool-capabilities'

export type ToolPermissionDecisionKind = 'allow' | 'deny' | 'neutral'

export interface ToolRiskAssessment {
  level: ToolRiskLevel
  reasons: string[]
  capabilities: ToolSemanticCapability[]
  path?: string
  paths?: string[]
  pathInsideCwd?: boolean
  invalidInput?: boolean
}

export interface ToolPermissionDecision {
  kind: ToolPermissionDecisionKind
  reason: string
  risk: ToolRiskAssessment
  matchedRule?: string
}

interface ToolPermissionRequest {
  toolName: string
  input: Record<string, unknown>
  cwd: string
  now?: number
}

interface PermissionRule {
  raw: string
  tool?: string
  path?: string
  commandPattern?: string
  networkHostPattern?: string
  guiApplicationPattern?: string
  guiWindowPattern?: string
  mcpToolPattern?: string
  mcpArgumentPointer?: string
  mcpArgumentPattern?: string
  capabilityScope?: ToolSemanticCapability[]
  requirePostcondition?: boolean
  risk?: ToolRiskLevel
  riskAtLeast?: ToolRiskLevel
  riskAtMost?: ToolRiskLevel
  until?: number
}

interface ExtractedPaths {
  values: string[]
  invalidReason?: string
}

interface ClassifiedPath {
  path: string
  inside: boolean
  sensitive: boolean
}

interface ClassifiedRequestPaths {
  states: ClassifiedPath[]
  rejection?: Omit<ToolRiskAssessment, 'capabilities'>
}

type PathRuleMatchMode = 'any' | 'all'

export interface PermissionRuleValidationIssue {
  index: number
  message: string
}

export interface PermissionRuleValidationResult {
  ok: boolean
  rules: PermissionRuleConfig[]
  issues: PermissionRuleValidationIssue[]
}

const RISK_ORDER: ToolRiskLevel[] = ['low', 'medium', 'high', 'critical']
const PERMISSION_RULE_LIMIT = 100
const TOOL_PATTERN = /^[A-Za-z0-9_.*-]+$/
const PERMISSION_RULE_FIELDS = new Set([
  'id', 'enabled', 'effect', 'toolPattern', 'pathPattern', 'commandPattern', 'networkHostPattern',
  'guiApplicationPattern', 'guiWindowPattern', 'mcpToolPattern', 'mcpArgumentPointer',
  'mcpArgumentPattern', 'capabilityScope', 'requirePostcondition',
  'riskLevel', 'riskOperator', 'expiresAt'
])
const READ_TOOLS = new Set(['read_file', 'view', 'list_dir', 'search_symbol', 'search_code', 'find_file', 'get_dependencies', 'task_decompose', 'browser_debug_snapshot'])
const EDIT_TOOLS = new Set([
  'artifact_register',
  'write_file',
  'search_replace',
  'edit_file',
  'create_document',
  'create_spreadsheet',
  'create_presentation',
  'create_pdf'
])
const FIXED_MUTATION_RISKS: Partial<Record<string, { level: ToolRiskLevel; reason: string }>> = {
  browser_debug_evaluate: { level: 'high', reason: '在页面主框架执行任意脚本，可读写页面状态并触发网络操作；每次需要明确审批' },
  git_stage: { level: 'medium', reason: '暂存指定 Git 文件' },
  git_stage_all: { level: 'high', reason: '暂存当前范围全部 Git 变更' },
  mcp_discover: { level: 'high', reason: 'MCP 连接可能启动本机进程或访问外部服务' },
  mcp_call_tool: { level: 'high', reason: 'MCP 连接可能启动本机进程或调用外部工具' },
  git_create_issue: { level: 'high', reason: '创建远端 Git Issue' },
  send_notification: { level: 'high', reason: '向外部消息渠道发送通知' }
}
const MCP_SENSITIVE_POINTER_SEGMENT = /^(?:api.?key|authorization|cookie|credential|password|private.?key|secret|signature|token)$/i
const BLOCKED_CODE_FORGE_MODES = new Set(['commit', 'pr'])
const CRITICAL_COMMAND_PATTERNS = [
  /\brm\s+-rf\s+(?:\/|\*)/i,
  /\bdel\s+\/[sq]\b/i,
  /\brmdir\s+\/s\b/i,
  /\bRemove-Item\b[\s\S]*\b-Recurse\b[\s\S]*\b-Force\b/i,
  /\bformat\b/i,
  /\bdiskpart\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\breg\s+delete\b/i
]
const HIGH_COMMAND_PATTERNS = [
  /\bsudo\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|powershell)\b/i,
  /\bInvoke-Expression\b/i,
  /\bpowershell\b[\s\S]*(?:-enc|-encodedcommand)\b/i
]

export function classifyToolRisk(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): ToolRiskAssessment {
  const reasons: string[] = []
  const capabilities = classifyToolCapabilities(toolName, input)
  const classifiedPaths = classifyRequestPaths(toolName, input, cwd)
  if (classifiedPaths.rejection) return { ...classifiedPaths.rejection, capabilities }
  const pathStates = classifiedPaths.states

  let level: ToolRiskLevel = 'medium'
  if (READ_TOOLS.has(toolName)) {
    level = 'low'
    reasons.push('只读工具')
  } else if (toolName === 'search_replace' && input.dry_run === true) {
    level = 'low'
    reasons.push('只读替换预览')
  } else if (EDIT_TOOLS.has(toolName)) {
    level = 'medium'
    reasons.push('文件写入工具')
  } else if (FIXED_MUTATION_RISKS[toolName]) {
    const fixedRisk = FIXED_MUTATION_RISKS[toolName] as { level: ToolRiskLevel; reason: string }
    level = fixedRisk.level
    reasons.push(fixedRisk.reason)
  } else if (toolName.toLowerCase().startsWith('mcp__')) {
    level = 'high'
    reasons.push('MCP 命名空间工具可能产生本机或外部副作用')
  } else if (toolName === 'bash') {
    const command = stringField(input.command)
    const commandRisk = classifyCommand(command)
    level = commandRisk.level
    reasons.push(commandRisk.reason)
  } else if (toolName.startsWith('gui_')) {
    level = 'high'
    reasons.push('GUI 自动化工具')
  } else if (toolName === 'task_dispatch_dag' || toolName === 'task_decompose_and_dispatch_dag') {
    level = 'high'
    reasons.push('多 Agent DAG 调度会创建子会话和 worktree')
  } else if (toolName === 'genesis_orchestrate') {
    level = 'high'
    reasons.push('Genesis 编排会规划多 Agent、隔离执行、验证 gate 和交付策略')
  } else if (toolName === 'code_forge_delivery') {
    const codeForge = classifyCodeForgeRisk(input)
    level = codeForge.level
    reasons.push(codeForge.reason)
  } else {
    level = 'medium'
    reasons.push('未知或扩展工具')
  }

  if (pathStates.some((state) => state.sensitive)) {
    level = maxRisk(level, 'high')
    reasons.push('敏感路径')
  }

  return {
    level,
    reasons,
    capabilities,
    path: pathStates[0]?.path,
    paths: pathStates.length > 0 ? pathStates.map((state) => state.path) : undefined,
    pathInsideCwd: pathStates.length > 0 ? true : undefined
  }
}

function classifyRequestPaths(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): ClassifiedRequestPaths {
  const extracted = extractPaths(toolName, input)
  if (extracted.invalidReason) {
    return {
      states: [],
      rejection: {
        level: 'critical',
        reasons: [extracted.invalidReason],
        pathInsideCwd: false,
        invalidInput: true
      }
    }
  }
  const states = extracted.values.map((value) => classifyPath(cwd, value))
  const outside = states.find((state) => !state.inside)
  if (!outside) return { states }
  return {
    states,
    rejection: {
      level: 'critical',
      reasons: ['路径越界'],
      path: outside.path,
      paths: states.map((state) => state.path),
      pathInsideCwd: false
    }
  }
}

function classifyCodeForgeRisk(input: Record<string, unknown>): { level: ToolRiskLevel; reason: string } {
  const mode = stringField(input.mode)
  if (BLOCKED_CODE_FORGE_MODES.has(mode)) {
    return { level: 'high', reason: '已停用的 Code Forge 复合持久交付请求' }
  }
  const legacyInput = input.createPatch === true ||
    input.verificationCommand !== undefined ||
    input.verificationCommands !== undefined ||
    ['repoRoot', 'worktreePath', 'baseSha', 'baseBranch', 'branch'].some((field) => input[field] !== undefined)
  if ((mode === '' || mode === 'report') && !legacyInput) {
    return { level: 'low', reason: '只读 Code Forge 交付报告' }
  }
  return { level: 'medium', reason: 'Code Forge 会生成可查询 patch artifact' }
}

export function evaluateToolPermission(
  settings: AppSettings,
  request: ToolPermissionRequest
): ToolPermissionDecision {
  const risk = classifyToolRisk(request.toolName, request.input, request.cwd)
  if (risk.invalidInput) {
    return { kind: 'deny', reason: `无效工具输入:${risk.reasons.join(',')}`, risk }
  }
  const structuredRules = activeStructuredRules(settings.permissionRules, request.now ?? Date.now())
  const legacyAllowEligible = risk.capabilities.length === 1
  const deny = findMatchingStructuredRule(structuredRules, 'deny', request, risk, 'any') ?? findMatchingRule(
    joinRules(settings.permissionDenylist, settings.disallowedTools),
    request,
    risk,
    'any'
  )
  if (deny) {
    return { kind: 'deny', reason: `命中黑名单:${deny.raw}`, risk, matchedRule: deny.raw }
  }

  const temporary = findMatchingStructuredRule(
    structuredRules.filter((rule) => rule.expiresAt !== undefined),
    'allow',
    request,
    risk,
    'all'
  ) ?? (legacyAllowEligible
    ? findMatchingRule(settings.permissionTemporaryAllowlist, request, risk, 'all')
    : undefined)
  if (temporary) {
    return { kind: 'allow', reason: `命中临时允许:${temporary.raw}`, risk, matchedRule: temporary.raw }
  }

  const allow = findMatchingStructuredRule(
    structuredRules.filter((rule) => rule.expiresAt === undefined),
    'allow',
    request,
    risk,
    'all'
  ) ?? (legacyAllowEligible
    ? findMatchingRule(
      joinRules(settings.permissionAllowlist, settings.allowedTools),
      request,
      risk,
      'all'
    )
    : undefined)
  if (allow) {
    return { kind: 'allow', reason: `命中白名单:${allow.raw}`, risk, matchedRule: allow.raw }
  }

  return { kind: 'neutral', reason: `风险等级:${risk.level};${risk.reasons.join(',')}`, risk }
}

export function validatePermissionRules(raw: unknown): PermissionRuleValidationResult {
  const issues: PermissionRuleValidationIssue[] = []
  const rules: PermissionRuleConfig[] = []
  if (raw === undefined) return { ok: true, rules, issues }
  if (!Array.isArray(raw)) {
    return { ok: false, rules, issues: [{ index: -1, message: '权限规则必须是数组' }] }
  }
  if (raw.length > PERMISSION_RULE_LIMIT) {
    issues.push({ index: -1, message: `权限规则最多 ${PERMISSION_RULE_LIMIT} 条` })
  }
  const ids = new Set<string>()
  for (const [index, value] of raw.slice(0, PERMISSION_RULE_LIMIT).entries()) {
    const normalized = normalizePermissionRule(value, index, ids, issues)
    if (normalized) rules.push(normalized)
  }
  return { ok: issues.length === 0, rules, issues }
}

export function normalizePermissionRules(raw: unknown, strict = true): PermissionRuleConfig[] {
  const result = validatePermissionRules(raw)
  if (strict && !result.ok) {
    throw new Error(result.issues.map((issue) =>
      issue.index >= 0 ? `规则 ${issue.index + 1}: ${issue.message}` : issue.message
    ).join('；'))
  }
  return result.rules
}

export function migrateLegacyPermissionRules(input: {
  allowedTools?: string
  disallowedTools?: string
  permissionAllowlist?: string
  permissionDenylist?: string
  permissionTemporaryAllowlist?: string
}, now = Date.now()): PermissionRuleConfig[] {
  const sources: Array<{ effect: PermissionRuleEffect; name: string; raw: string }> = [
    { effect: 'deny', name: 'deny', raw: joinRules(input.permissionDenylist ?? '', input.disallowedTools ?? '') },
    { effect: 'allow', name: 'temporary', raw: input.permissionTemporaryAllowlist ?? '' },
    { effect: 'allow', name: 'allow', raw: joinRules(input.permissionAllowlist ?? '', input.allowedTools ?? '') }
  ]
  const migrated: PermissionRuleConfig[] = []
  for (const source of sources) {
    const parsed = parseRules(source.raw, now)
    for (const [index, rule] of parsed.entries()) {
      migrated.push({
        id: `legacy-${source.name}-${index + 1}`,
        enabled: true,
        effect: source.effect,
        toolPattern: rule.tool ?? '',
        pathPattern: rule.path ?? '',
        commandPattern: '',
        networkHostPattern: '',
        guiApplicationPattern: '',
        guiWindowPattern: '',
        mcpToolPattern: '',
        mcpArgumentPointer: '',
        mcpArgumentPattern: '',
        capabilityScope: [],
        requirePostcondition: false,
        riskLevel: rule.risk ?? rule.riskAtLeast ?? rule.riskAtMost,
        riskOperator: rule.riskAtLeast ? 'atLeast' : rule.riskAtMost ? 'atMost' : 'exact',
        expiresAt: rule.until
      })
    }
  }
  return migrated
}

function normalizePermissionRule(
  value: unknown,
  index: number,
  ids: Set<string>,
  issues: PermissionRuleValidationIssue[]
): PermissionRuleConfig | undefined {
  const issue = (message: string): void => { issues.push({ index, message }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issue('规则必须是对象')
    return undefined
  }
  const record = value as Partial<PermissionRuleConfig>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const effect = record.effect
  const toolPattern = typeof record.toolPattern === 'string' ? record.toolPattern.trim() : ''
  const pathPattern = typeof record.pathPattern === 'string' ? record.pathPattern.trim() : ''
  const commandPattern = typeof record.commandPattern === 'string' ? record.commandPattern.trim() : ''
  const networkHostPattern = typeof record.networkHostPattern === 'string' ? record.networkHostPattern.trim() : ''
  const guiApplicationPattern = typeof record.guiApplicationPattern === 'string'
    ? record.guiApplicationPattern.trim()
    : ''
  const guiWindowPattern = typeof record.guiWindowPattern === 'string' ? record.guiWindowPattern.trim() : ''
  const mcpToolPattern = typeof record.mcpToolPattern === 'string' ? record.mcpToolPattern.trim() : ''
  const mcpArgumentPointer = typeof record.mcpArgumentPointer === 'string' ? record.mcpArgumentPointer.trim() : ''
  const mcpArgumentPattern = typeof record.mcpArgumentPattern === 'string' ? record.mcpArgumentPattern.trim() : ''
  const capabilityScope = normalizeCapabilityScope(record.capabilityScope, issue)
  const requirePostcondition = record.requirePostcondition === true
  const riskLevel = RISK_ORDER.includes(record.riskLevel as ToolRiskLevel)
    ? record.riskLevel as ToolRiskLevel
    : undefined
  const riskOperator = record.riskOperator === 'atLeast' || record.riskOperator === 'atMost'
    ? record.riskOperator
    : 'exact'
  const expiresAt = record.expiresAt === undefined
    ? undefined
    : typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) && record.expiresAt > 0
      ? Math.floor(record.expiresAt)
      : Number.NaN

  for (const key of Object.keys(record)) {
    if (!PERMISSION_RULE_FIELDS.has(key)) issue(`未知字段 ${key}`)
  }
  if (!id) issue('缺少规则 ID')
  else if (id.length > 120) issue('规则 ID 不能超过 120 字符')
  else if (ids.has(id)) issue('规则 ID 重复')
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') issue('启用状态必须是布尔值')
  if (effect !== 'allow' && effect !== 'deny') issue('动作必须是允许或拒绝')
  if (record.toolPattern !== undefined && typeof record.toolPattern !== 'string') issue('工具匹配必须是字符串')
  if (record.pathPattern !== undefined && typeof record.pathPattern !== 'string') issue('路径匹配必须是字符串')
  if (record.commandPattern !== undefined && typeof record.commandPattern !== 'string') issue('命令匹配必须是字符串')
  if (record.networkHostPattern !== undefined && typeof record.networkHostPattern !== 'string') issue('网络主机匹配必须是字符串')
  if (record.guiApplicationPattern !== undefined && typeof record.guiApplicationPattern !== 'string') issue('GUI 应用匹配必须是字符串')
  if (record.guiWindowPattern !== undefined && typeof record.guiWindowPattern !== 'string') issue('GUI 窗口匹配必须是字符串')
  if (record.mcpToolPattern !== undefined && typeof record.mcpToolPattern !== 'string') issue('MCP 工具匹配必须是字符串')
  if (record.mcpArgumentPointer !== undefined && typeof record.mcpArgumentPointer !== 'string') {
    issue('MCP 参数指针必须是字符串')
  }
  if (record.mcpArgumentPattern !== undefined && typeof record.mcpArgumentPattern !== 'string') {
    issue('MCP 参数值匹配必须是字符串')
  }
  if (record.requirePostcondition !== undefined && typeof record.requirePostcondition !== 'boolean') {
    issue('后置条件要求必须是布尔值')
  }
  if (record.riskLevel !== undefined && !RISK_ORDER.includes(record.riskLevel as ToolRiskLevel)) {
    issue('风险等级无效')
  }
  if (record.riskOperator !== undefined &&
    record.riskOperator !== 'exact' && record.riskOperator !== 'atLeast' && record.riskOperator !== 'atMost') {
    issue('风险比较方式无效')
  }
  if (toolPattern && (!TOOL_PATTERN.test(toolPattern) || toolPattern.length > 120)) {
    issue('工具匹配仅支持名称字符和 *，且不能超过 120 字符')
  }
  if (pathPattern && (pathPattern.length > 500 || /[\0\r\n]/.test(pathPattern))) {
    issue('路径匹配不能包含换行或 NUL，且不能超过 500 字符')
  }
  if (commandPattern && (commandPattern.length > 1_000 || /[\0\r\n]/.test(commandPattern))) {
    issue('命令匹配不能包含换行或 NUL，且不能超过 1000 字符')
  }
  if (networkHostPattern && (
    networkHostPattern.length > 253 || !/^[A-Za-z0-9.*:_-]+$/.test(networkHostPattern)
  )) {
    issue('网络主机匹配仅支持主机名、IP 和 *，且不能超过 253 字符')
  }
  if (guiApplicationPattern && (
    guiApplicationPattern.length > 200 || /[\0\r\n]/.test(guiApplicationPattern)
  )) {
    issue('GUI 应用匹配不能包含换行或 NUL，且不能超过 200 字符')
  }
  if (guiWindowPattern && (guiWindowPattern.length > 300 || /[\0\r\n]/.test(guiWindowPattern))) {
    issue('GUI 窗口匹配不能包含换行或 NUL，且不能超过 300 字符')
  }
  if (mcpToolPattern && (!TOOL_PATTERN.test(mcpToolPattern) || mcpToolPattern.length > 120)) {
    issue('MCP 工具匹配仅支持名称字符和 *，且不能超过 120 字符')
  }
  if (mcpArgumentPointer && !isSafeMcpArgumentPointer(mcpArgumentPointer)) {
    issue('MCP 参数指针必须是非敏感字段的有效 RFC 6901 pointer，且不能超过 500 字符')
  }
  if (mcpArgumentPattern && (mcpArgumentPattern.length > 500 || /[\0\r\n]/.test(mcpArgumentPattern))) {
    issue('MCP 参数值匹配不能包含换行或 NUL，且不能超过 500 字符')
  }
  if (Boolean(mcpArgumentPointer) !== Boolean(mcpArgumentPattern)) {
    issue('MCP 参数指针和值匹配必须同时填写')
  }
  if (!toolPattern && !pathPattern && !commandPattern && !networkHostPattern &&
    !guiApplicationPattern && !guiWindowPattern && !mcpToolPattern && !mcpArgumentPointer &&
    !mcpArgumentPattern && capabilityScope.length === 0 && !requirePostcondition && !riskLevel) {
    issue('至少选择工具、路径、语义范围或风险条件之一')
  }
  if (Number.isNaN(expiresAt)) issue('到期时间无效')
  if (issues.some((entry) => entry.index === index)) return undefined
  ids.add(id)
  return {
    id,
    enabled: record.enabled !== false,
    effect: effect as PermissionRuleEffect,
    toolPattern,
    pathPattern,
    commandPattern,
    networkHostPattern,
    guiApplicationPattern,
    guiWindowPattern,
    mcpToolPattern,
    mcpArgumentPointer,
    mcpArgumentPattern,
    capabilityScope,
    requirePostcondition,
    riskLevel,
    riskOperator,
    expiresAt
  }
}

function normalizeCapabilityScope(
  raw: unknown,
  issue: (message: string) => void
): ToolSemanticCapability[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    issue('能力范围必须是数组')
    return []
  }
  const selected = new Set<ToolSemanticCapability>()
  for (const value of raw) {
    if (!TOOL_SEMANTIC_CAPABILITIES.includes(value as ToolSemanticCapability)) {
      issue(`未知能力 ${String(value)}`)
      continue
    }
    if (selected.has(value as ToolSemanticCapability)) {
      issue(`能力范围重复 ${String(value)}`)
      continue
    }
    selected.add(value as ToolSemanticCapability)
  }
  return TOOL_SEMANTIC_CAPABILITIES.filter((capability) => selected.has(capability))
}

function activeStructuredRules(raw: unknown, now: number): PermissionRuleConfig[] {
  return normalizePermissionRules(raw, false).filter((rule) =>
    rule.enabled && (rule.expiresAt === undefined || rule.expiresAt > now)
  )
}

function findMatchingStructuredRule(
  rules: PermissionRuleConfig[],
  effect: PermissionRuleEffect,
  request: ToolPermissionRequest,
  risk: ToolRiskAssessment,
  pathMode: PathRuleMatchMode
): PermissionRule | undefined {
  for (const rule of rules) {
    if (rule.effect !== effect) continue
    if (!matchesCapabilityScope(rule.capabilityScope, risk.capabilities, effect)) continue
    const internal = structuredRule(rule)
    if (matchesRule(internal, request, risk, pathMode)) return internal
  }
  return undefined
}

function structuredRule(rule: PermissionRuleConfig): PermissionRule {
  return {
    raw: `规则 ${rule.id}`,
    tool: rule.toolPattern || undefined,
    path: rule.pathPattern || undefined,
    commandPattern: rule.commandPattern || undefined,
    networkHostPattern: rule.networkHostPattern || undefined,
    guiApplicationPattern: rule.guiApplicationPattern || undefined,
    guiWindowPattern: rule.guiWindowPattern || undefined,
    mcpToolPattern: rule.mcpToolPattern || undefined,
    mcpArgumentPointer: rule.mcpArgumentPointer || undefined,
    mcpArgumentPattern: rule.mcpArgumentPattern || undefined,
    capabilityScope: rule.capabilityScope.length > 0 ? rule.capabilityScope : undefined,
    requirePostcondition: rule.requirePostcondition || undefined,
    risk: rule.riskLevel && rule.riskOperator === 'exact' ? rule.riskLevel : undefined,
    riskAtLeast: rule.riskLevel && rule.riskOperator === 'atLeast' ? rule.riskLevel : undefined,
    riskAtMost: rule.riskLevel && rule.riskOperator === 'atMost' ? rule.riskLevel : undefined,
    until: rule.expiresAt
  }
}

function matchesCapabilityScope(
  scope: ToolSemanticCapability[],
  requested: ToolSemanticCapability[],
  effect: PermissionRuleEffect
): boolean {
  if (scope.length === 0) return effect === 'deny'
  if (requested.length === 0) return false
  const selected = new Set(scope)
  return effect === 'deny'
    ? requested.some((capability) => selected.has(capability))
    : requested.every((capability) => selected.has(capability))
}

function classifyCommand(command: string): { level: ToolRiskLevel; reason: string } {
  if (!command.trim()) return { level: 'medium', reason: '空 shell 命令' }
  if (CRITICAL_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    return { level: 'critical', reason: '高破坏性 shell 命令' }
  }
  if (HIGH_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    return { level: 'high', reason: '高风险 shell 命令' }
  }
  if (/^\s*(echo|pwd|cd|dir|ls|type|cat|node\s+-v|npm\s+--version|git\s+status)\b/i.test(command)) {
    return { level: 'low', reason: '低风险 shell 命令' }
  }
  return { level: 'medium', reason: '普通 shell 命令' }
}

function extractPath(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === 'browser_navigate') {
    const pathFromUrl = extractFileUrlPath(input.url)
    if (pathFromUrl) return pathFromUrl
  }
  if (
    toolName === 'task_decompose' ||
    toolName === 'task_dispatch_dag' ||
    toolName === 'task_decompose_and_dispatch_dag' ||
    toolName === 'genesis_orchestrate'
  ) {
    if (typeof input.cwd === 'string' && input.cwd.trim()) return input.cwd
  }
  const candidates = toolName === 'search_replace' || toolName === 'view'
    ? [input.file_path, input.path]
    : [input.path, input.file_path]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return undefined
}

function extractPaths(toolName: string, input: Record<string, unknown>): ExtractedPaths {
  if (toolName === 'git_stage') return extractGitStagePaths(input.paths)
  const pathValue = extractPath(toolName, input)
  return { values: pathValue ? [pathValue] : [] }
}

function extractGitStagePaths(value: unknown): ExtractedPaths {
  if (!Array.isArray(value) || value.length === 0) {
    return { values: [], invalidReason: 'git_stage paths 必须是非空数组' }
  }
  const paths: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      return { values: [], invalidReason: 'git_stage paths 只接受字符串路径' }
    }
    const normalized = candidate.trim()
    if (normalized !== candidate || !isValidGitStagePath(normalized)) {
      return { values: [], invalidReason: 'git_stage paths 包含空值、绝对路径、越界路径或 pathspec' }
    }
    paths.push(normalized)
  }
  return { values: paths }
}

function isValidGitStagePath(value: string): boolean {
  if (!value || value.includes('\0')) return false
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return false
  if (value.startsWith(':')) return false
  const normalized = posix.normalize(value.replace(/\\/g, '/'))
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../')
}

function extractFileUrlPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'file:') return undefined
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

function classifyPath(cwd: string, rawPath: string): ClassifiedPath {
  const target = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath)
  const rel = relative(resolve(cwd), target)
  const inside = !(rel.startsWith('..') || isAbsolute(rel))
  const normalized = rel.replace(/\\/g, '/')
  return {
    path: target,
    inside,
    sensitive: inside && /(^|\/)(\.env|id_rsa|id_ed25519|\.ssh|\.npmrc|\.pypirc)(\/|$)/i.test(normalized)
  }
}

function findMatchingRule(
  rawRules: string | undefined,
  request: ToolPermissionRequest,
  risk: ToolRiskAssessment,
  pathMode: PathRuleMatchMode
): PermissionRule | undefined {
  const rules = parseRules(rawRules, request.now ?? Date.now())
  return rules.find((rule) => matchesRule(rule, request, risk, pathMode))
}

function parseRules(rawRules: string | undefined, now: number): PermissionRule[] {
  return (rawRules ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => parseRule(line))
    .filter((rule): rule is PermissionRule => rule !== null && (!rule.until || rule.until > now))
}

function parseRule(line: string): PermissionRule | null {
  const rule: PermissionRule = { raw: line }
  const tokens = line.split(/[,\s]+/).filter(Boolean)
  if (tokens.length === 1 && !tokens[0].includes('=')) {
    rule.tool = tokens[0]
    return rule
  }

  for (const token of tokens) {
    const splitAt = token.indexOf('=')
    if (splitAt <= 0) continue
    const key = token.slice(0, splitAt).trim()
    const value = token.slice(splitAt + 1).trim()
    if (!value) continue
    if (token.startsWith('risk>=')) rule.riskAtLeast = parseRisk(token.slice('risk>='.length))
    else if (token.startsWith('risk<=')) rule.riskAtMost = parseRisk(token.slice('risk<='.length))
    else if (key === 'tool') rule.tool = value
    else if (key === 'path') rule.path = value
    else if (key === 'risk') rule.risk = parseRisk(value)
    else if (key === 'until') rule.until = Number(value)
  }

  return rule.tool || rule.path || rule.risk || rule.riskAtLeast || rule.riskAtMost ? rule : null
}

function matchesRule(
  rule: PermissionRule,
  request: ToolPermissionRequest,
  risk: ToolRiskAssessment,
  pathMode: PathRuleMatchMode
): boolean {
  if (rule.tool && !wildcardMatch(rule.tool, request.toolName)) return false
  if (rule.path && !matchesRiskPaths(rule.path, risk, request.cwd, pathMode)) return false
  if (rule.commandPattern && !matchesSemanticPattern(rule.commandPattern, requestCommand(request))) return false
  if (rule.networkHostPattern && !matchesSemanticPattern(rule.networkHostPattern, requestNetworkHost(request))) return false
  if (rule.guiApplicationPattern && !matchesSemanticPattern(rule.guiApplicationPattern, requestGuiApplication(request))) return false
  if (rule.guiWindowPattern && !matchesSemanticPattern(rule.guiWindowPattern, requestGuiWindow(request))) return false
  if (rule.mcpToolPattern && !matchesSemanticPattern(rule.mcpToolPattern, requestMcpTool(request))) return false
  if (rule.mcpArgumentPointer && rule.mcpArgumentPattern &&
    !matchesMcpArgument(request, rule.mcpArgumentPointer, rule.mcpArgumentPattern)) return false
  if (rule.requirePostcondition && !requestHasValidGuiPostcondition(request)) return false
  if (rule.risk && risk.level !== rule.risk) return false
  if (rule.riskAtLeast && compareRisk(risk.level, rule.riskAtLeast) < 0) return false
  if (rule.riskAtMost && compareRisk(risk.level, rule.riskAtMost) > 0) return false
  return true
}

function matchesSemanticPattern(pattern: string, value: string | undefined): boolean {
  return value !== undefined && wildcardMatch(pattern, value)
}

function requestCommand(request: ToolPermissionRequest): string | undefined {
  if (request.toolName !== 'bash' && request.toolName !== 'mcp_call_tool') return undefined
  return optionalStringField(request.input.command)
}

function requestNetworkHost(request: ToolPermissionRequest): string | undefined {
  if (request.toolName === 'web_search') return 'www.bing.com'
  const raw = optionalStringField(request.input.url)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

function requestGuiApplication(request: ToolPermissionRequest): string | undefined {
  return guiActionUsesWindowTarget(request)
    ? optionalStringField(request.input.processName)
    : undefined
}

function requestGuiWindow(request: ToolPermissionRequest): string | undefined {
  return guiActionUsesWindowTarget(request)
    ? optionalStringField(request.input.title)
    : undefined
}

function requestMcpTool(request: ToolPermissionRequest): string | undefined {
  if (request.toolName === 'mcp_call_tool') return optionalStringField(request.input.toolName)
  return isDynamicMcpToolName(request.toolName) ? request.toolName : undefined
}

function matchesMcpArgument(request: ToolPermissionRequest, pointer: string, pattern: string): boolean {
  const root = request.toolName === 'mcp_call_tool'
    ? recordField(request.input.arguments)
    : isDynamicMcpToolName(request.toolName)
      ? request.input
      : undefined
  if (!root) return false
  const selected = resolveJsonPointer(root, pointer)
  if (!selected.found) return false
  const value = scalarString(selected.value)
  return value !== undefined && wildcardMatch(pattern, value)
}

function isDynamicMcpToolName(toolName: string): boolean {
  return /^mcp__[^\s]+__[^\s]+$/i.test(toolName)
}

function isSafeMcpArgumentPointer(pointer: string): boolean {
  if (!pointer || pointer.length > 500 || !pointer.startsWith('/') || /~(?:[^01]|$)/.test(pointer)) return false
  const segments = pointer.slice(1).split('/').map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
  return segments.length <= 32 && segments.every((segment) => segment && !MCP_SENSITIVE_POINTER_SEGMENT.test(segment))
}

function resolveJsonPointer(root: unknown, pointer: string): { found: true; value: unknown } | { found: false } {
  if (!isSafeMcpArgumentPointer(pointer)) return { found: false }
  let current: unknown = root
  for (const raw of pointer.slice(1).split('/')) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) return { found: false }
      const index = Number(segment)
      if (index >= current.length) return { found: false }
      current = current[index]
      continue
    }
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) return { found: false }
    current = (current as Record<string, unknown>)[segment]
  }
  return { found: true, value: current }
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean' || value === null) return JSON.stringify(value)
  return undefined
}

function requestHasValidGuiPostcondition(request: ToolPermissionRequest): boolean {
  if (!guiActionUsesWindowTarget(request)) return false
  try {
    const postcondition = normalizeGuiPostcondition(request.input.postcondition)
    return postcondition !== undefined && sharesExactWindowSelector(request.input, postcondition)
  } catch {
    return false
  }
}

function guiActionUsesWindowTarget(request: ToolPermissionRequest): boolean {
  if (!request.toolName.startsWith('gui_') || !hasWindowSelector(request.input)) return false
  if (request.toolName === 'gui_click') return hasElementSelector(request.input)
  if (request.toolName === 'gui_scroll') return !hasCoordinatePair(request.input)
  return request.toolName === 'gui_activate_window' ||
    request.toolName === 'gui_type' ||
    request.toolName === 'gui_hotkey'
}

function sharesExactWindowSelector(
  action: Record<string, unknown>,
  postcondition: NonNullable<ReturnType<typeof normalizeGuiPostcondition>>
): boolean {
  const stringKeys = ['windowId', 'title', 'processName'] as const
  for (const key of stringKeys) {
    const actionValue = optionalStringField(action[key])
    const postconditionValue = optionalStringField(postcondition[key])
    if (actionValue && postconditionValue && actionValue.toLowerCase() === postconditionValue.toLowerCase()) {
      return true
    }
  }
  return typeof action.pid === 'number' && Number.isInteger(action.pid) && action.pid > 0 &&
    action.pid === postcondition.pid
}

function hasWindowSelector(input: Record<string, unknown>): boolean {
  return ['windowId', 'title', 'processName'].some((key) => Boolean(optionalStringField(input[key]))) ||
    (typeof input.pid === 'number' && Number.isInteger(input.pid) && input.pid > 0)
}

function hasElementSelector(input: Record<string, unknown>): boolean {
  return ['elementId', 'elementName', 'automationId', 'className', 'controlType']
    .some((key) => Boolean(optionalStringField(input[key]))) ||
    (typeof input.elementIndex === 'number' && Number.isInteger(input.elementIndex) && input.elementIndex >= 0)
}

function hasCoordinatePair(input: Record<string, unknown>): boolean {
  return typeof input.x === 'number' && Number.isFinite(input.x) &&
    typeof input.y === 'number' && Number.isFinite(input.y)
}

function matchesRiskPaths(
  pattern: string,
  risk: ToolRiskAssessment,
  cwd: string,
  mode: PathRuleMatchMode
): boolean {
  const paths = risk.paths ?? (risk.path ? [risk.path] : [])
  if (paths.length === 0) return false
  const matches = (candidate: string): boolean => pathMatches(pattern, candidate, cwd)
  return mode === 'any' ? paths.some(matches) : paths.every(matches)
}

function wildcardMatch(pattern: string, value: string, relativeGlob = false): boolean {
  if (pattern === '*' && !relativeGlob) return true
  const doubleStarPlaceholder = '\u0000'
  const recursiveDirectoryPlaceholder = '\u0001'
  const escaped = (relativeGlob ? pattern.replace(/\*\*\//g, recursiveDirectoryPlaceholder) : pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, doubleStarPlaceholder)
    .replace(/\*/g, '[^/\\\\]*')
    .replaceAll(doubleStarPlaceholder, '.*')
    .replaceAll(recursiveDirectoryPlaceholder, '(?:.*/)?')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}

function pathMatches(pattern: string, absolutePath: string, cwd: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, '/')
  const normalizedAbsolute = absolutePath.replace(/\\/g, '/')
  const relativePath = relative(resolve(cwd), absolutePath).replace(/\\/g, '/')
  return wildcardMatch(normalizedPattern, normalizedAbsolute) || wildcardMatch(normalizedPattern, relativePath)
}

/** Task scopes match relative paths only; cwd names must never widen a glob. */
export function matchesRelativePermissionPathPattern(pattern: string, relativePath: string): boolean {
  return wildcardMatch(pattern, relativePath, true)
}

function parseRisk(value: string): ToolRiskLevel | undefined {
  return RISK_ORDER.find((risk) => risk === value)
}

function compareRisk(left: ToolRiskLevel, right: ToolRiskLevel): number {
  return RISK_ORDER.indexOf(left) - RISK_ORDER.indexOf(right)
}

function maxRisk(left: ToolRiskLevel, right: ToolRiskLevel): ToolRiskLevel {
  return compareRisk(left, right) >= 0 ? left : right
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function optionalStringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function joinRules(...parts: string[]): string {
  return parts.filter((part) => part.trim()).join('\n')
}
