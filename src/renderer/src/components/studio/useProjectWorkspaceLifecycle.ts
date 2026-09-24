import { useCallback, useEffect, useState } from 'react'
import type {
  ProjectAggregateExportBundle,
  ProjectConnectorMutation,
  ProjectKnowledgePreview,
  ProjectKnowledgeSearchResult,
  ProjectResourceInput,
  ProjectWorkspace,
  ProjectWorkspacePatch
} from '../../../../shared/types'
import { errorText, TEXT, type ProjectLifecycleMutation } from './projectWorkspaceStudioModel'
import { clearDeletedTaskLocalData } from '../../store/task-local-data-cleanup'

interface LifecycleOptions {
  project: ProjectWorkspace
  refreshContents: () => Promise<void>
  refreshProjects: (preferredId?: string) => Promise<void>
  onMutationSuccess: () => void
}

interface LifecycleActions {
  announcement: string
  busy: ProjectLifecycleMutation | null
  error: string
  manifest: ProjectAggregateExportBundle | null
  clearFeedback: () => void
  updateProject: (patch: ProjectWorkspacePatch) => Promise<void>
  addResource: (resource: ProjectResourceInput) => Promise<void>
  removeResource: (resourceId: string) => Promise<void>
  mutateConnector: (resourceId: string, mutation: ProjectConnectorMutation) => Promise<void>
  archiveProject: () => Promise<void>
  restoreProject: () => Promise<void>
  exportManifest: () => Promise<void>
  closeManifest: () => void
  copyManifest: () => Promise<void>
  softDeleteProject: () => Promise<void>
  purgeProject: () => Promise<void>
  knowledge: ProjectKnowledgePreview | null
  knowledgeLoading: boolean
  knowledgeError: string
  refreshKnowledge: () => Promise<void>
  knowledgeSearch: ProjectKnowledgeSearchResult | null
  knowledgeSearchLoading: boolean
  knowledgeSearchError: string
  searchKnowledge: (query: string) => Promise<void>
}

type MutationRunner = <T>(
  kind: ProjectLifecycleMutation,
  action: () => Promise<T>,
  after: (result: T) => Promise<void>,
  successMessage: string
) => Promise<void>

export function useProjectWorkspaceLifecycle(options: LifecycleOptions): LifecycleActions {
  const { onMutationSuccess, project, refreshContents, refreshProjects } = options
  const feedback = useLifecycleFeedback(project.id, onMutationSuccess)
  const [manifest, setManifest] = useState<ProjectAggregateExportBundle | null>(null)
  const [knowledge, setKnowledge] = useState<ProjectKnowledgePreview | null>(null)
  const [knowledgeLoading, setKnowledgeLoading] = useState(false)
  const [knowledgeError, setKnowledgeError] = useState('')
  const [knowledgeSearch, setKnowledgeSearch] = useState<ProjectKnowledgeSearchResult | null>(null)
  const [knowledgeSearchLoading, setKnowledgeSearchLoading] = useState(false)
  const [knowledgeSearchError, setKnowledgeSearchError] = useState('')
  const refreshProject = useCallback(async (updated: ProjectWorkspace): Promise<void> => {
    await refreshProjects(updated.id)
  }, [refreshProjects])
  const projectMutations = useProjectMutations(project, refreshProject, feedback.run)
  const statusMutations = useProjectStatusMutations({
    project,
    refreshContents,
    refreshProject,
    refreshProjects,
    run: feedback.run
  })

  useEffect(() => {
    setManifest(null)
    setKnowledgeSearch(null)
    setKnowledgeSearchError('')
  }, [project.id])

  const refreshKnowledge = useCallback(async (): Promise<void> => {
    if (project.status !== 'active') {
      setKnowledge(null)
      setKnowledgeError('')
      return
    }
    setKnowledgeLoading(true)
    setKnowledgeError('')
    try {
      setKnowledge(await window.agentDesk.previewProjectKnowledge(project.id))
    } catch (cause) {
      setKnowledgeError(errorText(cause))
    } finally {
      setKnowledgeLoading(false)
    }
  }, [project.id, project.status])

  useEffect(() => { void refreshKnowledge() }, [project.revision, refreshKnowledge])

  const searchKnowledge = useCallback(async (query: string): Promise<void> => {
    setKnowledgeSearchLoading(true)
    setKnowledgeSearchError('')
    try {
      setKnowledgeSearch(await window.agentDesk.searchProjectKnowledge({ projectId: project.id, query, limit: 8 }))
    } catch (cause) {
      setKnowledgeSearchError(errorText(cause))
    } finally {
      setKnowledgeSearchLoading(false)
    }
  }, [project.id])

  const exportManifest = useCallback(async (): Promise<void> => {
    feedback.begin('export')
    try {
      const exported = await window.agentDesk.exportProjectWorkspaceData(project.id)
      setManifest(exported.bundle)
      feedback.succeed(`${TEXT.exportManifest} · ${exported.exportDigest.slice(0, 12)}`)
    } catch (cause) {
      feedback.fail(cause)
    } finally {
      feedback.finish()
    }
  }, [feedback, project.id])

  const copyManifest = useCallback(async (): Promise<void> => {
    if (!manifest) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(manifest, null, 2))
      feedback.succeed(TEXT.manifestCopied)
    } catch (cause) {
      feedback.fail(cause)
    }
  }, [feedback, manifest])

  const closeManifest = useCallback(() => setManifest(null), [])
  return {
    announcement: feedback.announcement,
    busy: feedback.busy,
    error: feedback.error,
    manifest,
    clearFeedback: feedback.clear,
    ...projectMutations,
    ...statusMutations,
    exportManifest,
    closeManifest,
    copyManifest,
    knowledge,
    knowledgeLoading,
    knowledgeError,
    refreshKnowledge,
    knowledgeSearch,
    knowledgeSearchLoading,
    knowledgeSearchError,
    searchKnowledge
  }
}

function useLifecycleFeedback(projectId: string, onSuccess: () => void) {
  const [busy, setBusy] = useState<ProjectLifecycleMutation | null>(null)
  const [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    setError('')
    setAnnouncement('')
  }, [projectId])
  const begin = useCallback((kind: ProjectLifecycleMutation): void => {
    setBusy(kind)
    setError('')
    setAnnouncement('')
  }, [])
  const finish = useCallback(() => setBusy(null), [])
  const fail = useCallback((cause: unknown) => setError(errorText(cause)), [])
  const succeed = useCallback((message: string) => setAnnouncement(message), [])
  const clear = useCallback(() => {
    setError('')
    setAnnouncement('')
  }, [])
  const run = useCallback<MutationRunner>(async (kind, action, after, successMessage) => {
    begin(kind)
    try {
      const result = await action()
      await after(result)
      succeed(successMessage)
      onSuccess()
    } catch (cause) {
      fail(cause)
    } finally {
      finish()
    }
  }, [begin, fail, finish, onSuccess, succeed])
  return { announcement, busy, error, begin, finish, fail, succeed, clear, run }
}

function useProjectMutations(
  project: ProjectWorkspace,
  refreshProject: (updated: ProjectWorkspace) => Promise<void>,
  run: MutationRunner
) {
  const updateProject = useCallback((patch: ProjectWorkspacePatch) => run(
    'update',
    () => window.agentDesk.updateProjectWorkspace(project.id, patch, { expectedRevision: project.revision }),
    refreshProject,
    TEXT.projectUpdated
  ), [project.id, project.revision, refreshProject, run])
  const addResource = useCallback((resource: ProjectResourceInput) => run(
    'resource',
    () => window.agentDesk.updateProjectWorkspace(
      project.id,
      { resources: [...project.resources, resource] },
      { expectedRevision: project.revision }
    ),
    refreshProject,
    TEXT.resourceAdded
  ), [project.id, project.resources, project.revision, refreshProject, run])
  const removeResource = useCallback((resourceId: string) => run(
    'resource',
    () => window.agentDesk.updateProjectWorkspace(
      project.id,
      { resources: project.resources.filter((resource) => resource.id !== resourceId),
        ...(project.primaryResourceId === resourceId ? { primaryResourceId: null } : {}) },
      { expectedRevision: project.revision }
    ),
    refreshProject,
    TEXT.resourceRemoved
  ), [project.id, project.resources, project.revision, project.primaryResourceId, refreshProject, run])
  const mutateConnector = useCallback((resourceId: string, mutation: ProjectConnectorMutation) => run(
    'resource',
    () => window.agentDesk.mutateProjectConnector(project.id, resourceId, mutation, { expectedRevision: project.revision }),
    refreshProject,
    connectorMutationMessage(mutation)
  ), [project.id, project.revision, refreshProject, run])
  return { updateProject, addResource, removeResource, mutateConnector }
}

function connectorMutationMessage(mutation: ProjectConnectorMutation): string {
  if (mutation.kind === 'bind_authorization') return '连接器授权账户已更新，旧缓存已清理'
  if (mutation.kind === 'set_auto_refresh') return mutation.intervalMs === 0 ? '连接器自动刷新已关闭' : '连接器自动刷新周期已更新'
  if (mutation.kind === 'request_refresh') return TEXT.connectorRefreshRequested
  if (mutation.kind === 'purge_cache') return TEXT.connectorCachePurged
  if (mutation.kind === 'set_authorization') return mutation.status === 'active'
    ? TEXT.connectorAuthorizationRestored
    : TEXT.connectorAuthorizationRevoked
  if (mutation.kind === 'set_enabled') return mutation.enabled ? TEXT.connectorEnabled : TEXT.connectorDisabled
  return TEXT.projectUpdated
}

function useProjectStatusMutations({
  project,
  refreshContents,
  refreshProject,
  refreshProjects,
  run
}: {
  project: ProjectWorkspace
  refreshContents: () => Promise<void>
  refreshProject: (updated: ProjectWorkspace) => Promise<void>
  refreshProjects: (preferredId?: string) => Promise<void>
  run: MutationRunner
}) {
  const archiveProject = useCallback(() => run(
    'archive',
    () => window.agentDesk.archiveProjectWorkspace(project.id, { expectedRevision: project.revision }),
    refreshProject,
    TEXT.projectArchived
  ), [project.id, project.revision, refreshProject, run])
  const restoreProject = useCallback(() => run(
    'restore',
    () => window.agentDesk.restoreProjectWorkspace(project.id, { expectedRevision: project.revision }),
    async (updated) => {
      await refreshProject(updated)
      await refreshContents()
    },
    TEXT.projectRestored
  ), [project.id, project.revision, refreshContents, refreshProject, run])
  const softDeleteProject = useCallback(() => run(
    'delete',
    () => window.agentDesk.deleteProjectWorkspace(project.id, { expectedRevision: project.revision }),
    async (updated) => {
      if (updated) await refreshProject(updated)
    },
    TEXT.deletedProjectNotice
  ), [project.id, project.revision, refreshProject, run])
  const purgeProject = useCallback(() => run(
    'purge',
    () => window.agentDesk.purgeProjectWorkspace(project.id, { expectedRevision: project.revision }),
    async (result) => {
      clearDeletedTaskLocalData(result.sessionIds, result.projectId)
      await refreshProjects()
    },
    TEXT.purgeProject
  ), [project.id, project.revision, refreshProjects, run])
  return { archiveProject, restoreProject, softDeleteProject, purgeProject }
}
