import type { ToolSemanticCapability } from '../../shared/types'
import { isReadOnlyToolCall, normalizeToolName } from '../task/tool-idempotency'

export const TOOL_SEMANTIC_CAPABILITIES: readonly ToolSemanticCapability[] = [
  'workspaceRead',
  'workspaceWrite',
  'terminal',
  'browser',
  'network'
]

const COMPOSITE_TOOL_CAPABILITIES: ToolSemanticCapability[] = [...TOOL_SEMANTIC_CAPABILITIES]
const SCOPED_TOOL_CAPABILITIES: Record<string, ToolSemanticCapability[] | undefined> = {
  create_document: ['workspaceWrite'], create_spreadsheet: ['workspaceWrite'], create_presentation: ['workspaceWrite'], create_pdf: ['workspaceWrite'],
  inspect_office_artifact: ['workspaceRead'], plan_office_revision: ['workspaceRead'], revise_office_artifact: ['workspaceRead', 'workspaceWrite'],
  project_knowledge_search: ['workspaceRead', 'network'], inspect_media: ['workspaceRead'],
  create_video_production: ['workspaceWrite'], submit_media_job: ['network', 'workspaceWrite'],
  advance_media_job: ['network', 'workspaceWrite'], reconcile_media_job: ['network', 'workspaceWrite']
}

const INTERACTIVE_GUI_TOOLS = new Set([
  'gui_activate_window',
  'gui_click',
  'gui_type',
  'gui_scroll',
  'gui_hotkey'
])

const NETWORK_TOOLS = new Set([
  'web_fetch',
  'web_search',
  'mcp_discover',
  'mcp_builtin_servers',
  'china_notify',
  'gitee_prepare',
  'git_push',
  'git_create_pr',
  'git_create_issue',
  'send_notification'
])

const WORKSPACE_WRITE_TOOLS = new Set([
  'artifact_register',
  'write_file',
  'edit_file',
  'memory_add',
  'optimize_skill',
  'git_stage',
  'git_stage_all',
  'git_commit',
  'git_merge',
  'code_forge_delivery',
  'task_dispatch_dag',
  'task_decompose_and_dispatch_dag',
  'genesis_orchestrate'
])

export function classifyToolCapabilities(
  toolName: string,
  toolInput: Record<string, unknown>
): ToolSemanticCapability[] {
  const normalized = normalizeToolName(toolName)
  const scoped = SCOPED_TOOL_CAPABILITIES[normalized]
  if (scoped) return [...scoped]
  if (normalized === 'bash' || normalized === 'mcp_call_tool' || normalized.toLowerCase().startsWith('mcp__')) {
    return [...COMPOSITE_TOOL_CAPABILITIES]
  }
  if (normalized.startsWith('browser_')) return ['browser', 'network']
  if (normalized === 'gui_list_windows') return ['browser']
  if (normalized === 'gui_screenshot') return ['browser', 'workspaceWrite']
  if (INTERACTIVE_GUI_TOOLS.has(normalized)) return [...COMPOSITE_TOOL_CAPABILITIES]
  if (normalized.startsWith('gui_')) return []
  if (NETWORK_TOOLS.has(normalized)) return ['network']
  if (normalized === 'search_replace') {
    return isReadOnlyToolCall(normalized, toolInput) ? ['workspaceRead'] : ['workspaceWrite']
  }
  if (WORKSPACE_WRITE_TOOLS.has(normalized)) return ['workspaceWrite']
  if (isReadOnlyToolCall(normalized, toolInput)) return ['workspaceRead']
  return []
}
