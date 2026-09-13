import { openProjectWorkspaceStore } from '../project-workspace'

export async function assertActiveProject(rootDir: string, projectId: string): Promise<void> {
  const store = await openProjectWorkspaceStore(rootDir)
  const project = await store.getWorkspace(projectId)
  if (!project || project.status !== 'active') {
    throw new Error(`DigitalWorker project is not active: ${projectId}`)
  }
}

export async function assertProjectWorkItem(
  rootDir: string,
  projectId: string,
  workItemId: string
): Promise<void> {
  const store = await openProjectWorkspaceStore(rootDir)
  const [project, workItem] = await Promise.all([
    store.getWorkspace(projectId),
    store.getWorkItem(workItemId)
  ])
  if (!project || project.status !== 'active') throw new Error(`Assignment project is not active: ${projectId}`)
  if (!workItem || workItem.projectId !== projectId) {
    throw new Error(`Assignment WorkItem does not belong to project: ${workItemId}`)
  }
}
