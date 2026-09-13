import type { ProjectWorkspace } from '../../shared/project-workspace-types'
import { prewarmProjectWorkspaceCanonicalRead } from '../project-workspace/canonical-read-service'

export function prewarmFirstActiveProject(workspaces: readonly ProjectWorkspace[], rootDir: string): void {
  const project = workspaces.find((workspace) => workspace.status === 'active')
  if (project) void prewarmProjectWorkspaceCanonicalRead(project.id, rootDir).catch(() => undefined)
}
