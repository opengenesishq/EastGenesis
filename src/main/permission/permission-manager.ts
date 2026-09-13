import { createHash, randomUUID } from 'node:crypto'
import { isGuiToolName } from '../agent/tools/gui-tools'
import type {
  AppSettings,
  EffectTarget,
  GuiAutomationGrantView,
  PermissionEffectScopeView,
  ToolCapabilityGrantView,
  ToolRiskLevel
} from '../../shared/types'

export const GUI_TEMPORARY_GRANT_MESSAGE = 'gui-scoped-grant:5m'
export const TOOL_TEMPORARY_GRANT_MESSAGE = 'tool-scoped-grant:5m'
const GUI_TEMPORARY_GRANT_MS = 5 * 60 * 1000
const TOOL_TEMPORARY_GRANT_MS = 5 * 60 * 1000

const SCOPED_TOOL_GRANT_TOOLS = new Set([
  'write_file',
  'search_replace',
  'edit_file',
  'create_document',
  'create_spreadsheet',
  'create_presentation',
  'create_pdf',
  'bash',
  'git_stage',
  'git_commit'
])

interface GuiAutomationGrant extends GuiAutomationGrantView {
  cwdDigest: string
  inputDigest: string
}

interface ToolCapabilityGrant extends ToolCapabilityGrantView {
  cwdDigest: string
  inputDigest: string
}

const grants = new Map<string, GuiAutomationGrant>()
const toolGrants = new Map<string, ToolCapabilityGrant>()

export type GuiPermissionDecision =
  | { kind: 'not-gui' }
  | { kind: 'allow'; reason: string; grantId: string }
  | { kind: 'ask'; reason: string; temporaryScopeLabel?: string }
  | { kind: 'deny'; reason: string }

export type ToolCapabilityDecision =
  | { kind: 'none' }
  | { kind: 'allow'; reason: string; grantId: string }

export function decideGuiPermission(
  toolName: string,
  input: Record<string, unknown>,
  settings: AppSettings,
  context: { sessionId: string; cwd: string },
  now = Date.now()
): GuiPermissionDecision {
  if (!isGuiToolName(toolName)) return { kind: 'not-gui' }
  if (!settings.guiAutomationEnabled) {
    return {
      kind: 'deny',
      reason: 'GUI 自动化默认关闭。请先在设置 > 权限中启用 GUI 自动化。'
    }
  }
  const grant = matchingGrant(context.sessionId, context.cwd, toolName, input, now)
  if (grant) {
    return {
      kind: 'allow',
      grantId: grant.id,
      reason: `命中 GUI 作用域授权 ${grant.id}。授权不会跨会话、目标或重启。`
    }
  }
  return {
    kind: 'ask',
    reason: '高风险 GUI 自动化：该工具会操作真实桌面应用，需要用户逐次审批。',
    temporaryScopeLabel: temporaryGuiGrantScopeLabel(toolName, input)
  }
}

export function temporaryGuiGrantScopeLabel(
  toolName: string,
  input: Record<string, unknown>
): string | undefined {
  if (!isGuiToolName(toolName) || !hasStableGuiTarget(toolName, input)) return undefined
  const application = firstScope(input, ['processName', 'pid'])
  const window = firstScope(input, ['title', 'windowId'])
  const element = firstScope(input, [
    'automationId', 'elementId', 'elementName', 'controlType', 'className', 'elementIndex'
  ])
  const coordinates = finiteNumber(input.x) && finiteNumber(input.y)
    ? `坐标 ${input.x},${input.y}`
    : undefined
  const source = stringValue(input.sourceId) ? `截图源 ${stringValue(input.sourceId)}` : undefined
  const path = stringValue(input.savePath) ? `路径 ${stringValue(input.savePath)}` : undefined
  return [toolName, application, window, element, coordinates, source, path, '当前会话 / 精确输入']
    .filter(Boolean)
    .join(' · ')
}

export function grantTemporaryGuiAutomation(
  sessionId: string,
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
  now = Date.now()
): GuiAutomationGrantView {
  const scopeLabel = temporaryGuiGrantScopeLabel(toolName, input)
  if (!scopeLabel) throw new Error('该 GUI 操作缺少稳定窗口或目标，只能逐次批准')
  pruneExpiredGrants(now)
  const grant: GuiAutomationGrant = {
    id: randomUUID(),
    kind: 'gui',
    sessionId,
    toolName,
    scopeLabel,
    issuedAt: now,
    expiresAt: now + GUI_TEMPORARY_GRANT_MS,
    cwdDigest: digest(cwd),
    inputDigest: digest(input)
  }
  grants.set(grant.id, grant)
  return publicGrant(grant)
}

export function decideToolCapabilityPermission(
  toolName: string,
  input: Record<string, unknown>,
  context: { sessionId: string; cwd: string; effectTargetDigest?: string },
  now = Date.now()
): ToolCapabilityDecision {
  if (!context.effectTargetDigest) return { kind: 'none' }
  const grant = matchingToolGrant(context.sessionId, context.cwd, toolName, input, context.effectTargetDigest, now)
  return grant
    ? {
        kind: 'allow',
        grantId: grant.id,
        reason: `命中精确工具授权 ${grant.id}。授权不会跨会话、项目、输入或重启。`
      }
    : { kind: 'none' }
}

export function temporaryToolGrantScopeLabel(
  toolName: string,
  input: Record<string, unknown>,
  riskLevel: ToolRiskLevel | undefined,
  effectScope?: PermissionEffectScopeView
): string | undefined {
  if (!SCOPED_TOOL_GRANT_TOOLS.has(toolName)) return undefined
  if (riskLevel === 'high' || riskLevel === 'critical') return undefined
  const target = stableToolTarget(toolName, input)
  if (!target || !effectScope) return undefined
  return [
    toolName,
    target,
    effectScope.summary,
    `效果摘要 ${effectScope.targetDigest.slice(0, 12)}`,
    `输入摘要 ${digest(input).slice(0, 12)}`,
    '当前会话 / 当前项目 / 精确输入'
  ]
    .join(' · ')
}

export function grantTemporaryToolCapability(
  sessionId: string,
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
  riskLevel: ToolRiskLevel | undefined,
  effectScope: PermissionEffectScopeView | undefined,
  now = Date.now()
): ToolCapabilityGrantView {
  const scopeLabel = temporaryToolGrantScopeLabel(toolName, input, riskLevel, effectScope)
  if (!scopeLabel) throw new Error('该工具操作缺少稳定目标或风险过高，只能逐次批准')
  pruneExpiredToolGrants(now)
  const grant: ToolCapabilityGrant = {
    id: randomUUID(),
    kind: 'tool',
    sessionId,
    toolName,
    scopeLabel,
    issuedAt: now,
    expiresAt: now + TOOL_TEMPORARY_GRANT_MS,
    effectTargetDigest: effectScope?.targetDigest ?? '',
    cwdDigest: digest(cwd),
    inputDigest: digest(input)
  }
  toolGrants.set(grant.id, grant)
  return publicToolGrant(grant)
}

export function listGuiAutomationGrants(now = Date.now()): GuiAutomationGrantView[] {
  pruneExpiredGrants(now)
  return [...grants.values()]
    .sort((left, right) => left.expiresAt - right.expiresAt)
    .map(publicGrant)
}

export function listToolCapabilityGrants(now = Date.now()): ToolCapabilityGrantView[] {
  pruneExpiredToolGrants(now)
  return [...toolGrants.values()]
    .sort((left, right) => left.expiresAt - right.expiresAt)
    .map(publicToolGrant)
}

export function revokeGuiAutomationGrant(grantId: string): boolean {
  return grants.delete(grantId.trim())
}

export function revokeAllGuiAutomationGrants(): number {
  const count = grants.size
  grants.clear()
  return count
}

export function revokeToolCapabilityGrant(grantId: string): boolean {
  return toolGrants.delete(grantId.trim())
}

export function revokeAllToolCapabilityGrants(): number {
  const count = toolGrants.size
  toolGrants.clear()
  return count
}

export function revokeGuiAutomationGrantsForSession(sessionId: string): number {
  let count = 0
  for (const [id, grant] of grants) {
    if (grant.sessionId !== sessionId) continue
    grants.delete(id)
    count += 1
  }
  return count
}

export function revokeToolCapabilityGrantsForSession(sessionId: string): number {
  let count = 0
  for (const [id, grant] of toolGrants) {
    if (grant.sessionId !== sessionId) continue
    toolGrants.delete(id)
    count += 1
  }
  return count
}

function matchingGrant(
  sessionId: string,
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
  now: number
): GuiAutomationGrant | undefined {
  pruneExpiredGrants(now)
  const cwdDigest = digest(cwd)
  const inputDigest = digest(input)
  return [...grants.values()].find((grant) =>
    grant.sessionId === sessionId &&
    grant.toolName === toolName &&
    grant.cwdDigest === cwdDigest &&
    grant.inputDigest === inputDigest
  )
}

function matchingToolGrant(
  sessionId: string,
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
  effectTargetDigest: string,
  now: number
): ToolCapabilityGrant | undefined {
  pruneExpiredToolGrants(now)
  const cwdDigest = digest(cwd)
  const inputDigest = digest(input)
  return [...toolGrants.values()].find((grant) =>
    grant.sessionId === sessionId &&
    grant.toolName === toolName &&
    grant.cwdDigest === cwdDigest &&
    grant.inputDigest === inputDigest &&
    grant.effectTargetDigest === effectTargetDigest
  )
}

function hasStableGuiTarget(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === 'gui_list_windows' || toolName === 'gui_screenshot') return true
  const hasWindow = ['windowId', 'title', 'processName'].some((key) => Boolean(stringValue(input[key]))) ||
    finiteNumber(input.pid)
  if (!hasWindow) return false
  if (toolName === 'gui_activate_window' || toolName === 'gui_hotkey') return true
  const hasElement = ['elementId', 'elementName', 'automationId', 'className', 'controlType']
    .some((key) => Boolean(stringValue(input[key]))) || finiteNumber(input.elementIndex)
  if (toolName === 'gui_type') return hasElement
  return hasElement || (finiteNumber(input.x) && finiteNumber(input.y))
}

function publicGrant(grant: GuiAutomationGrant): GuiAutomationGrantView {
  const { cwdDigest: _cwdDigest, inputDigest: _inputDigest, ...view } = grant
  return view
}

function publicToolGrant(grant: ToolCapabilityGrant): ToolCapabilityGrantView {
  const { cwdDigest: _cwdDigest, inputDigest: _inputDigest, ...view } = grant
  return view
}

function pruneExpiredGrants(now: number): void {
  for (const [id, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(id)
  }
}

function pruneExpiredToolGrants(now: number): void {
  for (const [id, grant] of toolGrants) {
    if (grant.expiresAt <= now) toolGrants.delete(id)
  }
}

function stableToolTarget(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === 'bash') {
    return stringValue(input.command) ? '精确命令' : undefined
  }
  if (toolName === 'git_stage') {
    if (!Array.isArray(input.paths) || input.paths.length === 0) return undefined
    const paths = input.paths.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    return paths.length === input.paths.length ? `路径 ${paths.join(', ')}` : undefined
  }
  if (toolName === 'git_commit') {
    return stringValue(input.message) ? '当前仓库 / 精确提交参数' : undefined
  }
  const target = firstScope(input, ['path', 'file_path', 'outputPath', 'output_path'])
  return target ? `目标 ${target}` : undefined
}

export function permissionEffectScope(target: EffectTarget, targetDigest: string): PermissionEffectScopeView {
  let summary: string
  switch (target.kind) {
    case 'file_content':
      summary = `文件 ${target.relativePath} · ${target.preState} -> ${target.expectedBytes} bytes`
      break
    case 'git_commit':
      summary = `Git ${target.branch} · staged ${target.stagedDiffDigest.slice(0, 12)}`
      break
    case 'git_index_update':
      summary = `Git index ${target.operation} · ${target.paths.join(', ')}`
      break
    case 'office_artifact':
      summary = `Office ${target.artifactKind} · ${target.relativePath}`
      break
    case 'office_artifact_revision':
      summary = `Office ${target.title} · v${target.baseVersion} → v${target.baseVersion + 1} · ${target.operations.length}处选区：${target.operations.slice(0, 8).map((op) => op.kind === 'replaceParagraphText' ? op.paragraphId : `${op.sheetId}!${op.address}`).join(', ')} · 原稿 ${target.baseDigest.slice(0, 19)}`
      break
    default:
      summary = `效果 ${target.kind}`
  }
  return { targetKind: target.kind, targetDigest, summary }
}

function firstScope(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return `${key}=${value.trim()}`
    if (finiteNumber(value)) return `${key}=${value}`
  }
  return undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex')
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
    .join(',')}}`
}
