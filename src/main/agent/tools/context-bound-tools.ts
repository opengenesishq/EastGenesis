import { isOfficeArtifactTool } from './office-artifact'
import { executeOfficeCreationTool } from './office-creation-tools'
import { OFFICE_REVISION_TOOL_NAMES, executeOfficeRevisionTool } from './office-revision-tools'
import type { ToolExecutionOptions } from '../../openaiTools'
import type { ToolExecResult } from './tool-types'
import { executeMediaTool, isMediaToolName } from './media-tools'
import { executeBrowserTool, isBrowserToolName } from './browser-tools'
import { executeGuiTool, isGuiToolName } from './gui-tools'

/** These gateways need the native session identity or its execution context;
 * dispatch them before the filesystem-only coding tools. */
export function executeContextBoundTool(name: string, args: Record<string, unknown>, cwd: string, options: ToolExecutionOptions): Promise<ToolExecResult> | undefined {
  if (isOfficeArtifactTool(name)) return executeOfficeCreationTool(name, args, cwd, options)
  if (OFFICE_REVISION_TOOL_NAMES.has(name)) return executeOfficeRevisionTool(name, args, options)
  if (isMediaToolName(name)) return executeMediaTool(name, args, options)
  if (isBrowserToolName(name)) return executeBrowserTool(name, args, options.sessionId)
  if (isGuiToolName(name)) return executeGuiTool(name, args, cwd, options.signal)
  return undefined
}
