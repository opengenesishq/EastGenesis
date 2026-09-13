import { useCallback, useEffect, useRef, useState } from 'react'
import type { MediaJobRecord, MediaStudioSnapshot } from '../../../../shared/media-types'
import type { ProjectWorkspace, WorkItem } from '../../../../shared/project-workspace-types'
import { EMPTY_MEDIA_SNAPSHOT } from './operationalSummary'
import { createOfficeOperationRefresh, type OfficeOperationDomain, type OfficeOperationStatus } from './officeOperationRefresh'

/** Canonical domains load independently; a slow media service cannot hide project tasks. */
export function useOfficeOperations() {
  const [mediaSnapshot, setMediaSnapshot] = useState<MediaStudioSnapshot>(EMPTY_MEDIA_SNAPSHOT)
  const [projectSnapshot, setProjectSnapshot] = useState<{ projects: ProjectWorkspace[]; workItems: WorkItem[] }>({ projects: [], workItems: [] })
  const [operationStatus, setOperationStatus] = useState<Record<OfficeOperationDomain, OfficeOperationStatus>>({
    media: { state: 'loading' }, projects: { state: 'loading' }, workItems: { state: 'loading' }
  })
  const refreshRef = useRef<ReturnType<typeof createOfficeOperationRefresh> | null>(null)
  const onJobChanged = useCallback((job: MediaJobRecord): void => {
    refreshRef.current?.invalidate('media')
    setMediaSnapshot((snapshot) => ({ ...snapshot, jobs: snapshot.jobs.map((item) => item.id === job.id ? job : item) }))
  }, [])
  useEffect(() => {
    const controller = createOfficeOperationRefresh((domain, status) => setOperationStatus((current) => ({ ...current, [domain]: status })))
    refreshRef.current = controller
    const refresh = (): void => {
      void controller.read('media', () => window.agentDesk.getMediaStudio(), setMediaSnapshot)
      void controller.read('projects', () => window.agentDesk.listProjectWorkspaces({ includeArchived: true }),
        (projects) => setProjectSnapshot((current) => ({ ...current, projects })))
      void controller.read('workItems', () => window.agentDesk.listProjectWorkItems(),
        (workItems) => setProjectSnapshot((current) => ({ ...current, workItems })))
    }
    refresh()
    const timer = window.setInterval(refresh, 5_000)
    window.addEventListener('focus', refresh)
    return () => {
      controller.dispose()
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [])
  const operationalDataReady = Object.values(operationStatus).every((status) => status.state === 'ready')
  return { mediaSnapshot, projectSnapshot, operationalDataReady, operationStatus, onJobChanged }
}
