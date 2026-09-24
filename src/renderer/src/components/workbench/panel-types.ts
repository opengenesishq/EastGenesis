/**
 * Workbench panel identifiers and opening context live in a type-only module.
 * Keeping these types separate prevents consumers such as the renderer store
 * from pulling the lazy panel registry (and its heavy editor dependencies)
 * into focused type-checks.
 */
export type PanelId =
  | 'result'
  | 'execution'
  | 'diff'
  | 'terminal'
  | 'browser'
  | 'files'
  | 'sources'
  | 'preview'
  | 'worktree'
  | 'pluginRegistry'
  | 'subagent'
  | 'sidechat'
  | 'routine'
  | 'memory'

export interface PanelOpenContext {
  url?: string
  path?: string
  memoryScope?: 'task' | 'project'
}
