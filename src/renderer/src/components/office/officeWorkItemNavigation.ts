import type { WorkItem } from '../../../../shared/project-workspace-types'
import { requestProjectWorkspaceNavigation } from '../studio/projectWorkspaceNavigation'

/** Enter the existing WorkItem surface; the office does not issue task writes. */
export function openOfficeWorkItem(item: Pick<WorkItem, 'id' | 'projectId'>, navigation: {
  openProjectWorkspace: (projectId: string) => void
  setView: (view: 'list') => void
}): void {
  if (!item.id.trim() || !item.projectId.trim()) throw new Error('Task and Project identities are required')
  navigation.openProjectWorkspace(item.projectId)
  requestProjectWorkspaceNavigation(item.projectId, 'work-item', item.id)
  navigation.setView('list')
}
