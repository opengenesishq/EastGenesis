import { useCallback, useEffect, useMemo, useState } from 'react'
import { ClipboardCheck, ExternalLink, PlayCircle, RefreshCw } from 'lucide-react'
import type { SupervisorRunRecord, WorkItem } from '../../../../shared/types'
import { useStore } from '../../store'
import { requestProjectWorkspaceNavigation } from './projectWorkspaceNavigation'
import { requestStudioSectionNavigation } from '../work-os-navigation'

export type WorkOsRunReviewView = 'runs' | 'review'
interface Props { active: boolean; view: WorkOsRunReviewView }

/** Global Runs/Review projection from canonical Supervisor TaskRun and WorkItem records. */
export default function WorkOsRunReviewPanel({ active, view }: Props): React.JSX.Element {
  const language = useStore((state) => state.settings.language)
  const [runs, setRuns] = useState<SupervisorRunRecord[]>([])
  const [workItems, setWorkItems] = useState<WorkItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const refresh = useCallback(async (): Promise<void> => {
    if (!active) return
    setLoading(true); setError('')
    const [runsResult, workItemsResult] = await Promise.allSettled([
      window.agentDesk.listSupervisorRuns(),
      window.agentDesk.listProjectWorkItems(undefined, { includeArchived: true })
    ])
    if (runsResult.status === 'fulfilled') setRuns(runsResult.value.filter((run) => run.origin === 'task_run').sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)))
    if (workItemsResult.status === 'fulfilled') setWorkItems(workItemsResult.value)
    const failures = [runsResult.status === 'rejected' ? `Runs: ${errorMessage(runsResult.reason)}` : '', workItemsResult.status === 'rejected' ? `Review: ${errorMessage(workItemsResult.reason)}` : ''].filter(Boolean)
    if (failures.length) setError(failures.join('\n'))
    setLoading(false)
}, [active])
  useEffect(() => { void refresh() }, [refresh])
  const workItemById = useMemo(() => new Map(workItems.map((item) => [item.id, item])), [workItems])
  const reviewItems = useMemo(() => workItems.filter((item) => item.acceptance?.status === 'failed' || item.status === 'verifying').sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)), [workItems])
  const zh = language === 'zh'
  return <section className="pws-section work-os-run-review-panel" data-work-os-run-review data-work-os-view={view} aria-labelledby="work-os-run-review-title">
    <div className="pws-section-header"><div className="pws-section-title">{view === 'runs' ? <PlayCircle size={18} aria-hidden="true" /> : <ClipboardCheck size={18} aria-hidden="true" />}<h2 id="work-os-run-review-title">{view === 'runs' ? (zh ? '运行' : 'Runs') : (zh ? '审查' : 'Review')}</h2><span data-work-os-count>{view === 'runs' ? runs.length : reviewItems.length}</span></div><button type="button" className="btn btn-ghost btn-icon-sm" data-work-os-refresh onClick={() => void refresh()} disabled={loading} aria-label={zh ? '刷新' : 'Refresh'}><RefreshCw size={14} className={loading ? 'pws-supervisor-spin' : undefined} aria-hidden="true" /></button></div>
    {error && <p className="pws-error" role="alert" data-work-os-error>{error}</p>}
    {view === 'runs' ? (runs.length === 0 && !loading ? <p className="pws-muted" data-work-os-empty>{zh ? '暂无 canonical TaskRun。' : 'No canonical TaskRuns yet.'}</p> : <div className="work-os-run-list" role="list" data-work-os-runs>{runs.map((run) => <RunRow key={run.id} run={run} workItem={workItemById.get(run.workItemId)} language={language} />)}</div>) : (reviewItems.length === 0 && !loading ? <p className="pws-muted" data-work-os-empty>{zh ? '暂无需要审查的验收项。' : 'No acceptance items need review.'}</p> : <div className="work-os-review-list" role="list" data-work-os-review>{reviewItems.map((item) => <ReviewRow key={item.id} item={item} language={language} />)}</div>)}
  </section>
}
function RunRow({ run, workItem, language }: { run: SupervisorRunRecord; workItem?: WorkItem; language: 'zh' | 'en' }): React.JSX.Element { const zh = language === 'zh'; return <article className="work-os-run-row" role="listitem" data-work-os-run-id={run.id} data-status={run.status}><div><strong>{workItem?.title ?? run.workItemId}</strong><span className="pws-status">{statusLabel(run.status, language)}</span></div><small>{run.projectId} · {run.id} · {formatTime(run.updatedAt)}</small><button type="button" className="btn btn-ghost btn-sm" data-work-os-open-project onClick={() => openWorkItem(run.projectId, run.workItemId)}><ExternalLink size={13} aria-hidden="true" />{zh ? '打开项目' : 'Open project'}</button></article> }
function ReviewRow({ item, language }: { item: WorkItem; language: 'zh' | 'en' }): React.JSX.Element { const zh = language === 'zh'; return <article className="work-os-review-row" role="listitem" data-work-os-review-work-item-id={item.id} data-acceptance-status={item.acceptance?.status ?? 'missing'}><div><strong>{item.title}</strong><span className="pws-status">{item.acceptance?.status === 'failed' ? (zh ? '验收失败' : 'Acceptance failed') : (zh ? '验证中' : 'Verifying')}</span></div><small>{item.projectId} · {item.id} · {formatTime(item.updatedAt)}</small><button type="button" className="btn btn-ghost btn-sm" data-work-os-open-delivery onClick={() => openDelivery(item.projectId, item.id)}><ExternalLink size={13} aria-hidden="true" />{zh ? '打开交付验收' : 'Open delivery'}</button></article> }
function openWorkItem(projectId: string, workItemId: string): void { requestStudioSectionNavigation('work'); requestProjectWorkspaceNavigation(projectId, 'work-item', workItemId) }
function openDelivery(projectId: string, workItemId: string): void { requestStudioSectionNavigation('work'); requestProjectWorkspaceNavigation(projectId, 'delivery', workItemId) }
function statusLabel(status: SupervisorRunRecord['status'], language: 'zh' | 'en'): string { const zh = language === 'zh'; const labels: Record<SupervisorRunRecord['status'], string> = { queued: zh ? '待执行' : 'Queued', running: zh ? '运行中' : 'Running', waiting_approval: zh ? '待审批' : 'Awaiting approval', waiting_reconciliation: zh ? '待对账' : 'Awaiting reconciliation', paused: zh ? '已暂停' : 'Paused', blocked: zh ? '受阻' : 'Blocked', failed: zh ? '失败' : 'Failed', completed: zh ? '已完成' : 'Completed', cancelled: zh ? '已取消' : 'Cancelled' }; return labels[status] }
function formatTime(value: number): string { return new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value) }
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
