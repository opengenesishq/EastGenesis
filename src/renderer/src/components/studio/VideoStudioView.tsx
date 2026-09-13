import { useEffect, useMemo, useState } from 'react'
import { Film, FolderKanban, LoaderCircle, Plus } from 'lucide-react'
import { useStore } from '../../store'
import { videoStudioText } from '../../i18n/studioTranslations'
import { VideoStudioPanel } from './VideoStudioPanel'
import VideoQuickStart from './VideoQuickStart'
import { takeVideoProductionNavigation, type VideoProductionNavigation } from './videoProductionNavigation'
import './video-studio-view.css'

export default function VideoStudioView({ active = true, businessLineId = 'video' }: { active?: boolean; businessLineId?: string }): React.JSX.Element {
  const language = useStore((state) => state.settings.language)
  const text = videoStudioText(language)
  const projects = useStore((state) => state.projectWorkspaces)
  const loading = useStore((state) => state.projectWorkspacesLoading)
  const loadError = useStore((state) => state.projectWorkspacesError)
  const preferredProjectId = useStore((state) => state.preferredProjectWorkspaceId)
  const refreshProjects = useStore((state) => state.refreshProjectWorkspaces)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [name, setName] = useState('')
  const [script, setScript] = useState('')
  const [creating, setCreating] = useState(false)
  const [showQuickStart, setShowQuickStart] = useState(false)
  const [selectedProductionId, setSelectedProductionId] = useState('')
  const [error, setError] = useState('')

  const availableProjects = useMemo(
    () => projects.filter((project) => project.status === 'active'),
    [projects]
  )

  useEffect(() => {
    if (!active || loaded) return
    let cancelled = false
    void refreshProjects()
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [active, loaded, refreshProjects])

  useEffect(() => {
    setSelectedProjectId((current) => {
      if (availableProjects.some((project) => project.id === current)) return current
      if (preferredProjectId && availableProjects.some((project) => project.id === preferredProjectId)) {
        return preferredProjectId
      }
      return availableProjects[0]?.id ?? ''
    })
  }, [availableProjects, preferredProjectId])

  useEffect(() => {
    return bindVideoSidebarEvents(businessLineId, setShowQuickStart, setSelectedProjectId, setSelectedProductionId)
  }, [businessLineId])

  const createVideoProject = async (draft?: { name?: string; script?: string }): Promise<void> => {
    const projectName = (draft?.name ?? name).trim()
    const productionScript = (draft?.script ?? script).trim()
    if (!projectName || !productionScript || creating) return
    setCreating(true)
    setError('')
    try {
      const created = await window.agentDesk.createProjectWorkspace({ name: projectName, kind: 'custom' })
      await window.agentDesk.createVideoProduction({
        businessLineId,
        projectId: created.id,
        title: projectName,
        script: productionScript,
        autoStructure: true
      })
      await refreshProjects()
      setSelectedProjectId(created.id)
      setShowQuickStart(false)
      setName('')
      setScript('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="video-studio-view" data-video-studio-view data-video-business-line={businessLineId} data-language={language} aria-label={text.studioLabel}>
      <header className="video-studio-shell-header">
        <div>
          <span className="video-studio-shell-icon"><Film size={17} aria-hidden="true" /></span>
          <span><strong>{text.studioTitle}</strong><small>{text.studioSubtitle}</small></span>
        </div>
        {availableProjects.length > 0 && (
          <label className="video-studio-project-picker">
            <FolderKanban size={14} aria-hidden="true" />
            <span>{text.projectLabel}</span>
            <select
              className="input"
              value={selectedProjectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
              aria-label={text.projectPickerLabel}
            >
              {availableProjects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="btn btn-secondary btn-sm" data-video-new-project onClick={() => { setShowQuickStart(true); setSelectedProductionId('') }}><Plus size={14} />{language === 'zh' ? '新建视频项目' : 'New video project'}</button>
      </header>

      {(error || loadError) && <p className="video-studio-shell-error" role="alert">{error || loadError}</p>}
      {(!loaded || loading) && availableProjects.length === 0 ? (
        <div className="video-studio-shell-state" role="status"><LoaderCircle className="video-studio-shell-spinner" size={20} />{text.loadingProjects}</div>
      ) : selectedProjectId && !showQuickStart ? (
        <VideoStudioPanel active={active} projectId={selectedProjectId} productionId={selectedProductionId} businessLineId={businessLineId} />
      ) : (
        <VideoQuickStart
          name={name}
          script={script}
          creating={creating}
          onNameChange={setName}
          onScriptChange={setScript}
          onSubmit={(draft) => void createVideoProject(draft)}
        />
      )}
    </section>
  )
}

function bindVideoSidebarEvents(
  businessLineId: string,
  setQuickStart: (value: boolean) => void,
  setProjectId: (value: string) => void,
  setProductionId: (value: string) => void
): () => void {
  const onNew = (): void => { setQuickStart(true); setProductionId('') }
  const onSelect = (event: Event): void => {
    const detail = (event as CustomEvent<VideoProductionNavigation>).detail
    if (!detail || (detail.businessLineId ?? 'video') !== businessLineId) return
    takeVideoProductionNavigation(businessLineId)
    if (detail.action === 'new-project') { onNew(); return }
    if (!detail.projectId) return
    setQuickStart(false)
    setProjectId(detail.projectId)
    setProductionId(detail.productionId ?? '')
  }
  window.addEventListener('caogen:video-new', onNew)
  window.addEventListener('caogen:video-select-production', onSelect)
  const pending = takeVideoProductionNavigation(businessLineId)
  if (pending) onSelect(new CustomEvent('caogen:video-select-production', { detail: pending }))
  return () => {
    window.removeEventListener('caogen:video-new', onNew)
    window.removeEventListener('caogen:video-select-production', onSelect)
  }
}
