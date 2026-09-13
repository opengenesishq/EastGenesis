import PersonalTaskRecoveryPanel from '../experience/PersonalTaskRecoveryPanel'
import { businessLineSubmissionKey } from '../../store/business-line-task-start'
import { lazy, Suspense, useState } from 'react'
import { Plus } from 'lucide-react'
import { getBusinessLineWorkSurfaces, resolveBusinessLineId, type BusinessLineDefinition } from '../../../../shared/business-line-types'
import { useStore } from '../../store'
import WorkbenchRoot from '../workbench/WorkbenchRoot'
import { ExperienceProjectionProvider } from '../experience/ExperienceProjection'
import { businessLineLabel, routingPreferenceLabel } from './business-line-labels'
import { BusinessLinePlan, BusinessLineTaskHistory } from './BusinessLineOverviewContent'
import BusinessLineWorkspaceTabs from './BusinessLineWorkspaceTabs'
import { useBusinessLineWorkSurface } from './useBusinessLineWorkSurface'
import './business-lines.css'

const ResultPanel = lazy(() => import('../workbench/StudioResultPanel'))
const VideoWorkspace = lazy(() => import('../studio/VideoStudioView'))

export default function BusinessLineWorkbench({ line }: { line: BusinessLineDefinition }): React.JSX.Element {
  const language = useStore((state) => state.settings.language)
  const activeId = useStore((state) => state.activeId)
  const sessions = useStore((state) => state.sessions)
  const showNewSession = useStore((state) => state.showNewSession)
  const setShowNewSession = useStore((state) => state.setShowNewSession)
  const [surface, setSurface] = useBusinessLineWorkSurface(line)
  const active = activeId ? sessions[activeId] : undefined
  const hasTask = !showNewSession && active && resolveBusinessLineId(active.meta) === line.id
  const zh = language === 'zh'
  return <section className="business-line-workbench" data-business-line-workbench={line.id} data-business-line-surface={surface}>
    <header className="business-line-workbench-header">
      <div><strong>{businessLineLabel(line, language)}</strong><small>{routingPreferenceLabel(line.routingPreference, language)}</small></div>
      <BusinessLineWorkspaceTabs line={line} surface={surface} hasTask={Boolean(hasTask)} zh={zh} onChange={setSurface} onOverview={() => { setShowNewSession(true); setSurface(getBusinessLineWorkSurfaces(line)[0]) }} />
    </header>
    {surface === 'video' ? <Suspense fallback={<div className="studio-loading">{zh ? '加载视频工作面…' : 'Loading video workspace…'}</div>}><VideoWorkspace businessLineId={line.id} /></Suspense> : hasTask ? <ExperienceProjectionProvider mode="studio">
      <div className="business-line-active-task">
        {surface === 'tasks' ? <WorkbenchRoot key={activeId} /> : <Suspense fallback={<div className="studio-loading">{zh ? '加载成果…' : 'Loading results…'}</div>}><ResultPanel sessionId={activeId} standalone onOpenSessionSurface={() => setSurface('tasks')} /></Suspense>}
      </div>
    </ExperienceProjectionProvider> : surface === 'results' ? <ExperienceProjectionProvider mode="studio">
      <div className="business-line-empty-results">
        <Suspense fallback={<div className="studio-loading">{zh ? '加载成果…' : 'Loading results…'}</div>}><ResultPanel sessionId={null} standalone onOpenSessionSurface={() => setSurface('tasks')} /></Suspense>
      </div>
    </ExperienceProjectionProvider> : <BusinessLineOverview line={line} />}
  </section>
}

function BusinessLineOverview({ line }: { line: BusinessLineDefinition }): React.JSX.Element {
  const language = useStore((state) => state.settings.language)
  const history = useStore((state) => state.history)
  const sessions = useStore((state) => state.sessions)
  const selectSession = useStore((state) => state.selectSession)
  const resume = useStore((state) => state.resumeFromHistory)
  const startTask = useStore((state) => state.startBusinessLineTask)
  const setSettings = useStore((state) => state.setShowSettings)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const zh = language === 'zh'
  const active = Object.values(sessions).filter((session) => resolveBusinessLineId(session.meta) === line.id)
  const activeIds = new Set(active.flatMap((session) => [session.meta.id, session.meta.sdkSessionId]))
  const past = history.filter((item) => resolveBusinessLineId(item) === line.id && !activeIds.has(item.id) && !activeIds.has(item.sdkSessionId))
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <div className="business-line-overview">
    <div className="business-line-intro"><span className="business-line-eyebrow">{zh ? '业务工作台' : 'Business workspace'}</span><h1>{businessLineLabel(line, language)}</h1><p>{line.objective || (zh ? '为这条业务线创建任务，跟进执行与成果。' : 'Create tasks and follow execution and results for this business line.')}</p></div>
    <form className="business-line-task-composer" onSubmit={(event) => { event.preventDefault(); void run(() => startTask(line.id, prompt)) }}>
      <label htmlFor="business-line-task-input">{zh ? '需要完成什么？' : 'What needs to be done?'}</label>
      <textarea id="business-line-task-input" className="input" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} maxLength={20000} placeholder={zh ? '描述任务，系统会按照这条业务线的目标和流程执行。' : 'Describe a task. The line’s objective and workflow guide execution.'} />
      <div><small>{zh ? `跨厂商智能路由 · ${routingPreferenceLabel(line.routingPreference, language)}` : `Cross-provider routing · ${routingPreferenceLabel(line.routingPreference, language)}`}</small><button type="submit" className="btn btn-primary" disabled={busy || !prompt.trim()} data-business-line-start><Plus size={15} />{busy ? (zh ? '启动中…' : 'Starting…') : (zh ? '开始任务' : 'Start task')}</button></div>
      {error && <div role="alert" className="business-line-error"><p>{error}</p><button type="button" className="btn btn-secondary btn-sm" onClick={() => setSettings(true)}>{zh ? '检查模型连接' : 'Check model connections'}</button></div>}
    </form>
    <PersonalTaskRecoveryPanel storageKey={businessLineSubmissionKey(line.id)} refreshKey={busy} />
    <BusinessLinePlan line={line} zh={zh} />
    <BusinessLineTaskHistory zh={zh} active={active} past={past} busy={busy} onSelect={selectSession} onResume={(entry) => void run(() => resume(entry))} />
  </div>
}
