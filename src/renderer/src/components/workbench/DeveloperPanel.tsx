import { Bug, FilePenLine, FileText, FlaskConical, Globe2 } from 'lucide-react'
import { lazy, Suspense, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import { useLocalSitesNavigation } from '../../store/local-sites-navigation'

const FilePanel = lazy(() => import('./FilePanel'))
const TestPanel = lazy(() => import('./TestPanel'))
const DebugPanel = lazy(() => import('./DebugPanel'))
const RefactorPanel = lazy(() => import('./RefactorPanel'))
const LocalSitesPanel = lazy(() => import('./LocalSitesPanel'))

type DeveloperView = 'files' | 'tests' | 'debug' | 'refactor' | 'sites'
const DEVELOPER_VIEWS: DeveloperView[] = ['files', 'tests', 'debug', 'refactor', 'sites']

export default function DeveloperPanel(): React.JSX.Element {
  const t = useT()
  const zh = useStore(s => s.settings.language === 'zh')
  const [view, setView] = useState<DeveloperView>('files')
  const [testsVisited, setTestsVisited] = useState(false)
  const [debugVisited, setDebugVisited] = useState(false)
  const [refactorVisited, setRefactorVisited] = useState(false)
  const [sitesVisited, setSitesVisited] = useState(false)
  const activeId = useStore(state => state.activeId)
  const siteRequest = useLocalSitesNavigation(state => state.taskSitesRequest)
  useEffect(() => { if (siteRequest?.sessionId === activeId) setView(siteRequest.view) }, [activeId, siteRequest])
  const selectView = (next: DeveloperView): void => {
    if (next === 'tests') setTestsVisited(true)
    if (next === 'debug') setDebugVisited(true)
    if (next === 'refactor') setRefactorVisited(true)
    if (next === 'sites') setSitesVisited(true)
    setView(next)
  }
  return (
    <div className="developer-panel">
      <div className="developer-panel-tabs" role="tablist" aria-label={t('deskFiles')}>
        <DeveloperTab active={view === 'files'} label={t('deskFiles')} view="files" onSelect={selectView}>
          <FileText size={14} aria-hidden="true" />
        </DeveloperTab>
        <DeveloperTab active={view === 'tests'} label={t('deskTests')} view="tests" onSelect={selectView}>
          <FlaskConical size={14} aria-hidden="true" />
        </DeveloperTab>
        <DeveloperTab active={view === 'debug'} label={t('deskDebug')} view="debug" onSelect={selectView}>
          <Bug size={14} aria-hidden="true" />
        </DeveloperTab>
        <DeveloperTab active={view === 'refactor'} label={t('deskRefactor')} view="refactor" onSelect={selectView}>
          <FilePenLine size={14} aria-hidden="true" />
        </DeveloperTab>
        <DeveloperTab active={view === 'sites'} label={zh ? '网站' : 'Sites'} view="sites" onSelect={selectView}><Globe2 size={14} aria-hidden="true" /></DeveloperTab>
      </div>
      {sitesVisited && <div className="developer-panel-view" style={{ display: view === 'sites' ? 'flex' : 'none' }} aria-hidden={view !== 'sites'}><Suspense fallback={<p>{zh ? '加载网站…' : 'Loading sites…'}</p>}><LocalSitesPanel /></Suspense></div>}
      <div className="developer-panel-view" style={{ display: view === 'files' ? 'flex' : 'none' }} aria-hidden={view !== 'files'}>
        <Suspense fallback={<div className="workspace-diff-empty">{t('loadingDiff')}</div>}>
          <FilePanel />
        </Suspense>
      </div>
      {testsVisited && (
        <div className="developer-panel-view" style={{ display: view === 'tests' ? 'flex' : 'none' }} aria-hidden={view !== 'tests'}>
          <Suspense fallback={<div className="workspace-diff-empty">{t('loadingDiff')}</div>}>
            <TestPanel />
          </Suspense>
        </div>
      )}
      {debugVisited && (
        <div className="developer-panel-view" style={{ display: view === 'debug' ? 'flex' : 'none' }} aria-hidden={view !== 'debug'}>
          <Suspense fallback={<div className="workspace-diff-empty">{t('loadingDiff')}</div>}>
            <DebugPanel />
          </Suspense>
        </div>
      )}
      {refactorVisited && (
        <div className="developer-panel-view" style={{ display: view === 'refactor' ? 'flex' : 'none' }} aria-hidden={view !== 'refactor'}>
          <Suspense fallback={<div className="workspace-diff-empty">{t('loadingDiff')}</div>}>
            <RefactorPanel />
          </Suspense>
        </div>
      )}
    </div>
  )
}

function DeveloperTab(props: {
  active: boolean
  label: string
  view: DeveloperView
  onSelect(view: DeveloperView): void
  children: ReactNode
}): React.JSX.Element {
  return (
    <button id={`developer-panel-tab-${props.view}`} type="button" role="tab" aria-selected={props.active}
      tabIndex={props.active ? 0 : -1} data-developer-view={props.view}
      className={props.active ? 'developer-panel-tab-active' : ''} onClick={() => props.onSelect(props.view)}
      onKeyDown={(event) => handleDeveloperTabKeyDown(event, props.view, props.onSelect)}>
      {props.children}
      <span>{props.label}</span>
    </button>
  )
}

function handleDeveloperTabKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  current: DeveloperView,
  onSelect: (view: DeveloperView) => void
): void {
  let next: DeveloperView | undefined
  if (event.key === 'Home') next = DEVELOPER_VIEWS[0]
  else if (event.key === 'End') next = DEVELOPER_VIEWS.at(-1)
  else if (event.key === 'ArrowRight') next = DEVELOPER_VIEWS[(DEVELOPER_VIEWS.indexOf(current) + 1) % DEVELOPER_VIEWS.length]
  else if (event.key === 'ArrowLeft') next = DEVELOPER_VIEWS[(DEVELOPER_VIEWS.indexOf(current) - 1 + DEVELOPER_VIEWS.length) % DEVELOPER_VIEWS.length]
  if (!next) return
  event.preventDefault()
  onSelect(next)
  requestAnimationFrame(() => document.getElementById(`developer-panel-tab-${next}`)?.focus())
}
