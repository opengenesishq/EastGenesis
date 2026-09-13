/**
 * Workbench panel identifiers and opening context live in a type-only module.
 * Keeping these types separate prevents consumers such as the renderer store
 * from pulling the lazy panel registry (and its heavy editor dependencies)
 * into focused type-checks.
 */
export type PanelId =
  | 'result'
  | 'diff'
  | 'terminal'
  | 'browser'
  | 'files'
  | 'preview'
  | 'worktree'
  | 'pluginRegistry'
  | 'subagent'
  | 'routine'
  | 'memory'

export interface PanelOpenContext {
  url?: string
  path?: string
}
