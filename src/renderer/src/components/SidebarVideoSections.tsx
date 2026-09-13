import { useEffect, useMemo, useState } from 'react'
import type * as React from 'react'
import { Film, LoaderCircle, Plus } from 'lucide-react'
import type { MediaStudioSnapshot } from '../../../shared/media-types'
import type { ProjectWorkspace } from '../../../shared/project-workspace-types'
import { useT } from '../i18n'
import { businessLineVideoSnapshot } from './studio/businessLineVideoSnapshot'

interface Props {
  active: boolean
  query: string
  projects: ProjectWorkspace[]
  onNewVideo: () => void
}

export default function SidebarVideoSections({ active, query, projects, onNewVideo }: Props): React.JSX.Element {
  const t = useT()
  const [snapshot, setSnapshot] = useState<MediaStudioSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setLoading(true)
    void window.agentDesk.getMediaStudio()
      .then((next) => { if (!cancelled) setSnapshot(businessLineVideoSnapshot(next)) })
      .catch(() => { if (!cancelled) setSnapshot(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [active])

  const productions = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const all = snapshot?.productions ?? []
    if (!normalized) return all
    return all.filter((production) => `${production.title}\n${projectNames.get(production.projectId) ?? ''}`
      .toLowerCase().includes(normalized))
  }, [projectNames, query, snapshot?.productions])
  return (
    <section className="sidebar-section sidebar-video-section" data-sidebar-video-section>
      <div className="sidebar-projects-toolbar">
        <div className="sidebar-projects-toggle" aria-label={t('videoProjects')}>
          <Film size={14} aria-hidden="true" />
          <span className="sidebar-projects-title">{t('videoProjects')}</span>
          <span className="sidebar-projects-count">{productions.length}</span>
        </div>
        <button
          type="button"
          className="sidebar-projects-action"
          aria-label={t('newVideo')}
          title={t('newVideo')}
          onClick={onNewVideo}
        >
          <Plus size={15} aria-hidden="true" />
        </button>
      </div>
      {loading ? (
        <div className="sidebar-empty" role="status"><LoaderCircle size={14} className="welcome-send-spinner" />{t('loading')}</div>
      ) : productions.length === 0 ? (
        <div className="sidebar-empty">{query.trim() ? t('noMatchingVideos') : t('noVideoProductions')}</div>
      ) : productions.map((production) => (
        <button
          key={production.id}
          type="button"
          className="sidebar-video-entry"
          data-sidebar-video-production-id={production.id}
          onClick={() => window.dispatchEvent(new CustomEvent('caogen:video-select-production', {
            detail: { projectId: production.projectId, productionId: production.id }
          }))}
        >
          <Film size={14} aria-hidden="true" />
          <span className="sidebar-video-entry-body">
            <strong>{production.title}</strong>
            <small>{projectNames.get(production.projectId) ?? t('project')} · {production.shots.length} {t('videoShots')}</small>
          </span>
        </button>
      ))}
    </section>
  )
}
