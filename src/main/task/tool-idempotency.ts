import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { EFFECT_FREE_AGENT_TOOL_NAMES } from './effect-entry-inventory'
import { isDownstreamMediaEffectTool } from '../../shared/media-tool-contract'

export const OPENAI_PERMISSION_READ_ONLY_TOOLS = new Set([
  'inspect_media', 'inspect_office_artifact', 'plan_office_revision',
  'read_file',
  'view',
  'list_dir',
  'search_symbol',
  'search_code',
  'find_file',
  'get_dependencies',
  'task_decompose',
  'genesis_orchestrate',
  'list_skills',
  'load_skill',
  'run_skill',
  'draft_skill',
  'route_model',
  'china_notify',
  'gitee_prepare',
  'memory_search',
  'browser_automation_status',
  'browser_read',
  'git_status',
  'git_diff'
])

// Legacy strict-Docker migration is a fail-closed confirmation state, not the
// normal plan-mode readonly surface. Keep only product-controlled project
// inspection paths; exclude Git, skills, browser, MCP and orchestration entrypoints.
export const OPENAI_DISABLED_MODE_INSPECTION_TOOLS = new Set([
  'read_file',
  'view',
  'list_dir',
  'search_symbol',
  'search_code',
  'find_file'
])

const EFFECT_FREE_TOOLS = new Set([
  ...EFFECT_FREE_AGENT_TOOL_NAMES,
  'web_fetch',
  'web_search',
  'browser_wait_for',
  'browser_screenshot',
  'gui_list_windows',
  'gui_screenshot',
  // Canonical Artifact registration is an app-owned, deterministic local transaction.
  'artifact_register',
  // Knowledge search may append citation Evidence, but has no external side effect.
  'project_knowledge_search',
  // ProjectWorkspace owns deterministic comment idempotency and atomic recovery.
  'work_item_comment'
])

const DUPLICATE_CONFIRMATION_TOOLS = new Set([
  'bash',
  'gui_activate_window',
  'gui_click',
  'gui_type',
  'gui_scroll',
  'gui_hotkey',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_evaluate',
  'git_stage_all',
  'mcp_call_tool',
  'send_notification',
  'git_commit',
  'git_push',
  'git_create_pr',
  'git_create_issue',
  'git_merge',
  'task_dispatch_dag',
  'task_decompose_and_dispatch_dag',
  'genesis_orchestrate'
])

const TOOL_ALIASES: Record<string, string> = {
  Bash: 'bash',
  Edit: 'edit_file',
  MultiEdit: 'edit_file',
  NotebookEdit: 'edit_file',
  Read: 'read_file',
  Write: 'write_file',
  LS: 'list_dir',
  Glob: 'find_file',
  Grep: 'search_code',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search'
}

export function normalizeToolName(toolName: string): string {
  const trimmed = toolName.trim()
  return TOOL_ALIASES[trimmed] ?? trimmed
}

export function isSideEffectingTool(toolName: string): boolean {
  const name = normalizeToolName(toolName)
  return !isDownstreamMediaEffectTool(name) && !EFFECT_FREE_TOOLS.has(name)
}

export function isSideEffectingToolCall(toolName: string, toolInput: unknown): boolean {
  return !isReadOnlyToolCall(toolName, toolInput) && isSideEffectingTool(toolName)
}

export function isReadOnlyToolCall(toolName: string, toolInput: unknown): boolean {
  const normalized = normalizeToolName(toolName)
  if (OPENAI_PERMISSION_READ_ONLY_TOOLS.has(normalized)) return true
  if (
    normalized === 'search_replace' &&
    toolInput &&
    typeof toolInput === 'object' &&
    !Array.isArray(toolInput) &&
    (toolInput as Record<string, unknown>).dry_run === true
  ) {
    return true
  }
  if (normalized === 'code_forge_delivery') return isCodeForgeReportCall(toolInput)
  return false
}

function isCodeForgeReportCall(toolInput: unknown): boolean {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return false
  const input = toolInput as Record<string, unknown>
  const forbidden = [
    input.createPatch === true,
    input.verificationCommand !== undefined,
    input.verificationCommands !== undefined,
    ['repoRoot', 'worktreePath', 'baseSha', 'baseBranch', 'branch'].some((field) => input[field] !== undefined)
  ]
  return !forbidden.some(Boolean) && (input.mode === undefined || input.mode === 'report')
}

export function isDisabledModeInspectionToolCall(toolName: string): boolean {
  return OPENAI_DISABLED_MODE_INSPECTION_TOOLS.has(normalizeToolName(toolName))
}

export function requiresDuplicateConfirmation(toolName: string, toolInput: unknown): boolean {
  const normalized = normalizeToolName(toolName)
  if (DUPLICATE_CONFIRMATION_TOOLS.has(normalized)) return true
  if (normalized === 'code_forge_delivery' && toolInput && typeof toolInput === 'object') {
    const mode = (toolInput as Record<string, unknown>).mode
    return mode === 'commit' || mode === 'pr'
  }
  return false
}

export function stableValueDigest(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex')
}

export function buildToolIdempotencyKey(input: {
  scopeId: string
  cwd: string
  toolName: string
  toolInput: unknown
}): string | undefined {
  const toolName = normalizeToolName(input.toolName)
  if (!isSideEffectingToolCall(toolName, input.toolInput)) return undefined
  return `tool-v1:${stableValueDigest({
    scopeId: input.scopeId,
    cwd: resolve(input.cwd),
    toolName,
    input: canonicalToolInput(toolName, input.toolInput)
  })}`
}

function canonicalToolInput(toolName: string, input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const record = { ...(input as Record<string, unknown>) }
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'search_replace' ||
      toolName === 'read_file' || toolName === 'create_document' || toolName === 'create_spreadsheet' ||
      toolName === 'create_presentation' || toolName === 'create_pdf') {
    const path = record.path ?? record.file_path ?? record.notebook_path
    delete record.file_path
    delete record.notebook_path
    if (path !== undefined) record.path = path
  }
  return record
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`
}
