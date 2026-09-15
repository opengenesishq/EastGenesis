import type { AppSettings } from '../../shared/types'
import { isReadOnlyToolCall, normalizeToolName } from '../task/tool-idempotency'
import { evaluateToolPermission } from './tool-permission'

const FILE_TOOLS = new Set(['write_file', 'edit_file', 'search_replace', 'create_document', 'create_spreadsheet', 'create_presentation', 'create_pdf', 'revise_office_artifact'])
const UNSCOPED_READ_ALIASES = new Set(['run_skill', 'genesis_orchestrate'])
const EXTRA_READ_TOOLS = new Set(['web_fetch', 'web_search', 'project_knowledge_search', 'browser_wait_for', 'gui_list_windows'])

/** This is an additional admission boundary; ordinary deny rules and Effect approval still apply. */
export function limitedFileExecutionPolicyError(settings: AppSettings, name: string, input: Record<string, unknown>, cwd: string): string | undefined {
  if (!settings.limitedFileExecutionEnabled) return undefined
  const toolName = normalizeToolName(name)
  if (!UNSCOPED_READ_ALIASES.has(toolName) && (isReadOnlyToolCall(toolName, input) || EXTRA_READ_TOOLS.has(toolName))) return undefined
  if (!FILE_TOOLS.has(toolName)) return '限定文件执行已阻止此工具：命令、桌面、连接器、委派及其他副作用没有可核验的文件路径范围。'
  // Only explicit structured tool AND path selectors confer write authority.
  // Existing rule disable/delete/expiry is revocation, and deny keeps precedence.
  const scoped = {
    ...settings,
    allowedTools: '', permissionAllowlist: '', permissionTemporaryAllowlist: '',
    permissionRules: settings.permissionRules.filter((rule) => rule.effect === 'deny' || Boolean(rule.toolPattern.trim() && rule.pathPattern.trim()))
  }
  const decision = evaluateToolPermission(scoped, { toolName, input, cwd })
  if (decision.kind === 'allow') return undefined
  return decision.kind === 'deny' ? decision.reason : '限定文件执行：此工具和目标路径未获得有效允许规则；请在权限设置中配置范围。'
}

/** Capture limited mode, but never capture authority: every commit reads current rules. */
export function createLimitedFileWriteGuard(readSettings: () => AppSettings, name: string, input: Record<string, unknown>, cwd: string): () => void {
  const startedLimited = readSettings().limitedFileExecutionEnabled
  return () => {
    const current = readSettings()
    const error = limitedFileExecutionPolicyError({ ...current, limitedFileExecutionEnabled: startedLimited || current.limitedFileExecutionEnabled }, name, input, cwd)
    if (error) throw new Error(error)
  }
}
