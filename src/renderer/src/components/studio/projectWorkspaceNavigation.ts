export type ProjectWorkspaceFocus = 'code' | 'diff' | 'work-item' | 'goal' | 'delivery'

export interface ProjectWorkspaceNavigation {
  projectId: string
  focus: ProjectWorkspaceFocus
  /** Canonical WorkItem to locate when the workspace is opened from a control surface. */
  workItemId?: string
}

export const PROJECT_WORKSPACE_NAVIGATION_EVENT = 'caogen:project-workspace-navigation'

let pending: ProjectWorkspaceNavigation | null = null

export function requestProjectWorkspaceNavigation(projectId: string, focus: ProjectWorkspaceFocus, workItemId?: string): void {
  pending = { projectId, focus, ...(workItemId ? { workItemId } : {}) }
  window.dispatchEvent(new CustomEvent<ProjectWorkspaceNavigation>(PROJECT_WORKSPACE_NAVIGATION_EVENT, { detail: pending }))
}

export function takeProjectWorkspaceNavigation(projectId: string): ProjectWorkspaceNavigation | null {
  if (pending?.projectId !== projectId) return null
  const next = pending
  pending = null
  return next
}
