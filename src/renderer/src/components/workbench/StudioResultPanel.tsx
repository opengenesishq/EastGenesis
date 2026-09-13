import { artifactCategoryLabel, artifactVerificationStatus } from './studio-result-artifact-labels'
import OfficeArtifactRevision from './office-revision/OfficeArtifactRevision'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  StudioAuditTimelineItem,
  StudioAuditTimelinePage,
  StudioResultArtifact,
  StudioResultArtifactLocation,
  StudioResultIssue,
  StudioResultSnapshot,
  WorkflowAcceptanceRecord,
  WorkflowEvidenceRecord
} from '../../../../shared/types'
import type { DeliveryVerdictDetail } from '../../store/delivery-verdict'
import { useStore } from '../../store'
import { deriveDeliveryVerdict } from '../../store'
import { DeliveryVerdictBanner } from './DeliveryVerdictBanner'
import { AcceptanceSummary } from './AcceptanceSummary'
import { TraceabilityView } from './TraceabilityView'
import { HeaderIcon } from '../ChatHeaderIcons'
import { WorkflowAcceptanceRow } from '../WorkflowAcceptanceRow'
import {
  isActiveFirstTaskCandidate,
  isFirstTaskComplete,
  patchFirstTaskOnboardingRecord,
  readFirstTaskOnboardingRecord
} from '../experience/first-task-onboarding'

type ResultTab = 'summary' | 'artifacts' | 'evidence' | 'timeline'
type ResultTool = 'diff' | 'files' | 'preview' | 'browser' | 'terminal' | 'tasks'
type OpenResultTool = (tool: ResultTool, value?: string) => Promise<void>

interface StudioResultPanelProps {
  sessionId: string | null
  standalone?: boolean
  onOpenSessionSurface?: () => void
}

export default function StudioResultPanel({
  sessionId,
  standalone = false,
  onOpenSessionSurface
}: StudioResultPanelProps): React.JSX.Element {
  const language = useStore((state) => state.settings.language)
  const openDiffPanel = useStore((state) => state.openDiffPanel)
  const openFilesPanel = useStore((state) => state.openFilesPanel)
  const openPreviewPanel = useStore((state) => state.openPreviewPanel)
  const openBrowserPanel = useStore((state) => state.openBrowserPanel)
  const openTerminalPanel = useStore((state) => state.openTerminalPanel)
  const openSubagentPanel = useStore((state) => state.openSubagentPanel)
  const labels = language === 'zh' ? ZH : EN
  const [tab, setTab] = useState<ResultTab>('summary')
  const { snapshot, loading, error, message, refresh, save } = useStudioResult(sessionId, labels, language)
  const acceptanceReview = useResultAcceptanceReview(snapshot, refresh)

  const openTool: OpenResultTool = async (tool, value) => {
    if (tool === 'diff') await openDiffPanel()
    if (tool === 'files') await openFilesPanel()
    if (tool === 'preview') await openPreviewPanel(value)
    if (tool === 'browser') await openBrowserPanel(value)
    if (tool === 'terminal') await openTerminalPanel()
    if (tool === 'tasks') openSubagentPanel()
    onOpenSessionSurface?.()
  }

  const tabs = useMemo(() => [
    { id: 'summary' as const, label: labels.summary },
    { id: 'artifacts' as const, label: `${labels.artifacts}${snapshot ? ` ${snapshot.summary.currentArtifacts}/${snapshot.summary.artifacts}` : ''}` },
    { id: 'evidence' as const, label: `${labels.evidence}${snapshot ? ` ${snapshot.summary.evidence}` : ''}` },
    { id: 'timeline' as const, label: labels.timeline }
  ], [labels, snapshot])

  return (
    <article
      className={`studio-result-panel ${standalone ? 'studio-result-panel-standalone' : ''}`}
      data-studio-result-panel
      data-studio-result-session={sessionId ?? ''}
      data-studio-result-state={snapshot?.state ?? (loading ? 'loading' : 'empty')}
    >
      <header className="studio-result-header">
        <div className="studio-result-heading">
          <h2>{labels.title}</h2>
          <div className="studio-result-binding" title={bindingLabel(snapshot, labels)}>
            {bindingLabel(snapshot, labels)}
          </div>
        </div>
        <div className="studio-result-header-actions">
          <button
            type="button"
            className="studio-result-icon-button"
            aria-label={labels.refresh}
            title={labels.refresh}
            disabled={loading || !sessionId}
            onClick={() => void refresh()}
            data-studio-result-refresh
          >
            <span aria-hidden="true">↻</span>
          </button>
          <button
            type="button"
            className="studio-result-icon-button"
            aria-label={labels.export}
            title={labels.export}
            disabled={snapshot?.state !== 'ready'}
            onClick={() => void save()}
            data-studio-result-export
          >
            <span aria-hidden="true">↓</span>
          </button>
        </div>
      </header>

      {error && <div className="studio-result-notice studio-result-notice-error" role="alert">{labels.loadFailed}</div>}
      {message && <div className="studio-result-notice" role="status">{message}</div>}

      {!sessionId ? (
        <ResultEmpty title={labels.noConversation} detail={labels.noConversationDetail} />
      ) : loading && !snapshot ? (
        <div className="studio-result-loading">{labels.loading}</div>
      ) : snapshot?.state === 'unbound' ? (
        <ResultEmpty title={labels.unbound} detail={labels.unboundDetail} />
      ) : snapshot ? (
        <ReadyResult
          snapshot={snapshot}
          sessionId={sessionId}
          labels={labels}
          tabs={tabs}
          tab={tab}
          onTab={setTab}
          openTool={openTool}
          acceptanceReview={acceptanceReview}
          language={language}
        />
      ) : error ? (
        <ResultEmpty title={labels.unavailable} detail={labels.tryRefresh} />
      ) : null}
    </article>
  )
}

function useStudioResult(sessionId: string | null, labels: Labels, language: 'zh' | 'en') {
  const [snapshot, setSnapshot] = useState<StudioResultSnapshot>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState<string>()
  const refreshTimer = useRef<number | undefined>()
  const savedLabel = labels.saved
  const refresh = useCallback(async (): Promise<void> => {
    if (!sessionId) {
      setSnapshot(undefined)
      setError(undefined)
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      setSnapshot(await window.agentDesk.getStudioResultSnapshot(sessionId))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [sessionId])
  useEffect(() => {
    setMessage(undefined)
    void refresh()
  }, [refresh])

  // Repair/retest projections are emitted by the main process after the
  // Session event that started them. Keep the result surface on the same
  // canonical snapshot without refreshing on every streamed token.
  useEffect(() => {
    if (!sessionId) return
    const scheduleRefresh = (): void => {
      if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current)
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = undefined
        void refresh()
      }, 250)
    }
    const unsubscribe = window.agentDesk.onSessionEvent((eventSessionId, event) => {
      if (eventSessionId !== sessionId) return
      if (event.kind === 'turn-result' || event.kind === 'status' || event.kind === 'checkpoint-restore' || event.kind === 'meta') {
        scheduleRefresh()
      }
    })
    return () => {
      unsubscribe()
      if (refreshTimer.current !== undefined) {
        window.clearTimeout(refreshTimer.current)
        refreshTimer.current = undefined
      }
    }
  }, [refresh, sessionId])

  useEffect(() => {
    if (!sessionId || snapshot?.state !== 'ready') return
    const hasActiveWorkflow = snapshot.acceptances.some((acceptance) =>
      acceptance.deliveryScope !== 'historical' &&
      (acceptance.status === 'pending' || acceptance.status === 'verifying' || acceptance.status === 'failed')) ||
      snapshot.workItems.some((item) => !['done', 'failed', 'cancelled'].includes(item.status))
    if (!hasActiveWorkflow) return
    const interval = window.setInterval(() => { void refresh() }, 2500)
    return () => window.clearInterval(interval)
  }, [refresh, sessionId, snapshot])

  const save = useCallback(async (): Promise<void> => {
    if (!sessionId || snapshot?.state !== 'ready') return
    setMessage(undefined)
    setError(undefined)
    try {
      const result = await window.agentDesk.saveStudioResultSnapshot(sessionId)
      if (!result.canceled) {
        // ART-005 (T08/P1-2):导出始终可用;verdict≠verifiable 时显著标注未验收项与缺失 Evidence,不伪造完成
        const verdict = deriveDeliveryVerdict(snapshot)
        if (verdict.verdict === 'verifiable') {
          setMessage(savedLabel)
        } else {
          setMessage(
            language === 'en'
              ? `${savedLabel} (note: delivery not verified — pending ${verdict.pending} · verifying ${verdict.verifying} · failed ${verdict.failed}; see Evidence view)`
              : `${savedLabel}（注意：交付未通过验收 —— 待验收 ${verdict.pending} · 验收中 ${verdict.verifying} · 失败 ${verdict.failed}，详见证据视图）`
          )
        }
      }
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [labels, language, savedLabel, sessionId, snapshot?.state])
  useEffect(() => {
    const record = readFirstTaskOnboardingRecord()
    if (snapshot && isActiveFirstTaskCandidate(record, sessionId) && isFirstTaskComplete(snapshot, record)) {
      patchFirstTaskOnboardingRecord({ completedAt: Date.now() })
    }
  }, [sessionId, snapshot])
  return { snapshot, loading, error, message, refresh, save }
}

interface ResultAcceptanceReviewState {
  acceptances: WorkflowAcceptanceRecord[]
  evidence: WorkflowEvidenceRecord[]
  refresh: () => Promise<void>
}

function useResultAcceptanceReview(
  snapshot: StudioResultSnapshot | undefined,
  refreshSnapshot: () => Promise<void>
): ResultAcceptanceReviewState {
  const [acceptances, setAcceptances] = useState<WorkflowAcceptanceRecord[]>([])
  const [evidence, setEvidence] = useState<WorkflowEvidenceRecord[]>([])
  const acceptanceIds = snapshot?.acceptances.map((acceptance) => acceptance.id).join('\n') ?? ''
  const projectId = snapshot?.scope.workspaceId
  const refresh = useCallback(async (): Promise<void> => {
    const ids = new Set(acceptanceIds ? acceptanceIds.split('\n') : [])
    if (ids.size === 0 || !projectId) {
      setAcceptances([])
      setEvidence([])
      await refreshSnapshot()
      return
    }
    const [nextAcceptances, nextEvidence] = await Promise.all([
      loadResultAcceptances(projectId, ids),
      loadResultEvidence(projectId)
    ])
    setAcceptances(nextAcceptances)
    setEvidence(nextEvidence)
    await refreshSnapshot()
  }, [acceptanceIds, projectId, refreshSnapshot])
  useEffect(() => { void refresh() }, [refresh])
  return { acceptances, evidence, refresh }
}

async function loadResultAcceptances(
  projectId: string,
  ids: ReadonlySet<string>
): Promise<WorkflowAcceptanceRecord[]> {
  const found = new Map<string, WorkflowAcceptanceRecord>()
  let cursor: string | undefined
  do {
    const selection = await window.agentDesk.listWorkflowLedger({
      projectId,
      limit: 250,
      ...(cursor ? { cursor } : {})
    })
    for (const acceptance of selection.acceptances.items) {
      if (ids.has(acceptance.id)) found.set(acceptance.id, acceptance)
    }
    if (found.size === ids.size || !selection.acceptances.hasMore) break
    cursor = selection.acceptances.nextCursor
  } while (cursor)
  return [...found.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
}

async function loadResultEvidence(projectId: string): Promise<WorkflowEvidenceRecord[]> {
  const records: WorkflowEvidenceRecord[] = []
  let cursor: string | undefined
  do {
    const page = await window.agentDesk.queryWorkflowEvidence({
      projectId,
      limit: 500,
      ...(cursor ? { cursor } : {})
    })
    records.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return records
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function ReadyResult({
  snapshot,
  sessionId,
  labels,
  tabs,
  tab,
  onTab,
  openTool,
  acceptanceReview,
  language
}: {
  snapshot: StudioResultSnapshot
  labels: Labels
  tabs: Array<{ id: ResultTab; label: string }>
  tab: ResultTab
  onTab: (tab: ResultTab) => void
  openTool: OpenResultTool
  acceptanceReview: ResultAcceptanceReviewState
  sessionId: string | null
  language: 'zh' | 'en'
}): React.JSX.Element {
  const verdict = useMemo(() => deriveDeliveryVerdict(snapshot), [snapshot])
  const [evidenceDrill, setEvidenceDrill] = useState<{
    artifactId: string
    evidenceIds: string[]
    acceptanceIds: string[]
  } | undefined>()
  const [reportedRepairByAcceptanceId, setReportedRepairByAcceptanceId] = useState<Record<string, string>>({})
  const repairByAcceptanceId = useMemo(() => ({
    ...Object.fromEntries(snapshot.acceptances.flatMap((acceptance) =>
      acceptance.repairWorkItemId ? [[acceptance.id, acceptance.repairWorkItemId]] : [])),
    ...reportedRepairByAcceptanceId
  }), [reportedRepairByAcceptanceId, snapshot.acceptances])

  // T07:Artifact → Evidence 下钻:切到 evidence Tab 并高亮/滚动
  const handleDrillEvidence = useCallback((artifact: StudioResultArtifact) => {
    setEvidenceDrill({ artifactId: artifact.id, evidenceIds: artifact.evidenceIds, acceptanceIds: artifact.acceptanceIds })
    onTab('evidence')
  }, [onTab])

  // T06:review 产生 repair 时回填映射,供 failed 行渲染 repair 入口
  const handleRepairReported = useCallback((repair: { acceptanceId: string; workItemId: string }) => {
    setReportedRepairByAcceptanceId((prev) => ({ ...prev, [repair.acceptanceId]: repair.workItemId }))
  }, [])

  // T06:repair 入口跳转(复用 openTool('tasks')/openSubagentPanel 契约,不新增 IPC)
  const handleOpenRepair = useCallback(async (workItemId: string): Promise<void> => {
    const acceptanceId = Object.entries(repairByAcceptanceId)
      .find(([, candidateWorkItemId]) => candidateWorkItemId === workItemId)?.[0]
    const acceptance = acceptanceReview.acceptances.find((candidate) => candidate.id === acceptanceId)
    if (!acceptance) {
      throw new Error(language === 'en'
        ? 'The failed Acceptance is no longer available for this repair.'
        : '当前返工对应的失败 Acceptance 已不可用。')
    }
    const started = await window.agentDesk.startWorkflowAcceptanceRepair(acceptance.id)
    if (started.workItemId !== workItemId) {
      throw new Error(language === 'en'
        ? 'The repair WorkItem changed while it was starting.'
        : '返工任务在启动时发生了身份变化。')
    }
    await acceptanceReview.refresh()
  }, [acceptanceReview, language, repairByAcceptanceId])

  // T09(P1-1):把 Evidence 关联到 Artifact(复用 createWorkflowEvidence + createWorkflowEvidenceLink, relation=verifies)
  const evidenceProjectId = acceptanceReview.acceptances[0]?.projectId
  const handleAttachEvidence = useCallback(async (artifactId: string, payload: { title: string; summary?: string }): Promise<void> => {
    if (!evidenceProjectId) {
      throw new Error(language === 'en' ? 'Current result lacks Project ownership; cannot attach Evidence' : '当前结果缺少 Project 归属，无法关联 Evidence')
    }
    const evidenceId = `evidence-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    await window.agentDesk.createWorkflowEvidence({
      evidenceId,
      projectId: evidenceProjectId,
      ...(snapshot.scope.goalId ? { goalId: snapshot.scope.goalId } : {}),
      ...(snapshot.scope.workItemId ? { workItemId: snapshot.scope.workItemId } : {}),
      artifactId,
      kind: 'observation',
      title: payload.title,
      ...(payload.summary ? { summary: payload.summary } : {}),
      contentDigest: await sha256Rendered(`${payload.title}\n${artifactId}`)
    })
    await window.agentDesk.createWorkflowEvidenceLink({
      id: `link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      evidenceId,
      projectId: evidenceProjectId,
      artifactId,
      relation: 'verifies'
    })
    await acceptanceReview.refresh()
  }, [acceptanceReview, evidenceProjectId, language, snapshot.scope])

  return (
    <>
      {/* T03:交付判定横幅(头部下方、Tab 之上),取值仅由 acceptances 派生 */}
      <DeliveryVerdictBanner detail={verdict} language={language} />
      <nav className="studio-result-tabs" role="tablist" aria-label={labels.resultViews}>
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'active' : ''}
            onClick={() => onTab(item.id)}
            data-studio-result-tab={item.id}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="studio-result-quick-actions" aria-label={labels.quickActions}>
        <ResultToolButton tool="diff" icon="review" label={labels.changes} onClick={() => void openTool('diff')} />
        <ResultToolButton tool="files" icon="files" label={labels.workspaceFiles} onClick={() => void openTool('files')} />
        <ResultToolButton tool="preview" icon="summary" label={labels.preview} onClick={() => void openTool('preview')} />
        <ResultToolButton tool="browser" icon="browser" label={labels.browser} onClick={() => void openTool('browser')} />
        <ResultToolButton tool="terminal" icon="terminal" label={labels.terminal} onClick={() => void openTool('terminal')} />
        <ResultToolButton tool="tasks" icon="subagents" label={labels.tasks} onClick={() => void openTool('tasks')} />
      </div>
      {tab === 'summary' && <SummaryView snapshot={snapshot} labels={labels} verdict={verdict} />}
      {tab === 'artifacts' && (
        <ArtifactView
          snapshot={snapshot}
          labels={labels}
          language={language}
          evidenceProjectId={evidenceProjectId}
          onAttachEvidence={handleAttachEvidence}
          onDrillEvidence={handleDrillEvidence}
          onOpen={(location) => {
            void openLocation(location, openTool).then(async () => {
              const record = readFirstTaskOnboardingRecord()
              if (!sessionId || record.candidateSessionId !== sessionId) return
              patchFirstTaskOnboardingRecord({ artifactLocationIds: [location.id] })
              const latest = await window.agentDesk.getStudioResultSnapshot(sessionId)
              if (isFirstTaskComplete(latest, readFirstTaskOnboardingRecord())) {
                patchFirstTaskOnboardingRecord({ completedAt: Date.now() })
              }
            })
          }}
        />
      )}
      {tab === 'evidence' && (
        <EvidenceView
          snapshot={snapshot}
          labels={labels}
          language={language}
          acceptanceReview={acceptanceReview}
          verdict={verdict}
          drill={evidenceDrill}
          repairByAcceptanceId={repairByAcceptanceId}
          onRepairReported={handleRepairReported}
          onOpenRepair={handleOpenRepair}
        />
      )}
      {tab === 'timeline' && <TimelineView snapshot={snapshot} sessionId={sessionId} labels={labels} />}
      {/* T10(P1-4):跨实体追溯视图,挂在 evidence Tab 之下作为总览 */}
      {tab === 'evidence' && (
        <TraceabilityView
          snapshot={snapshot}
          language={language}
          onDrill={(kind) => onTab(kind === 'artifact' ? 'artifacts' : 'evidence')}
        />
      )}
    </>
  )
}

function ResultToolButton({
  tool,
  icon,
  label,
  onClick
}: {
  tool: ResultTool
  icon: 'review' | 'files' | 'summary' | 'browser' | 'terminal' | 'subagents'
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button type="button" className="studio-result-tool-button" title={label} onClick={onClick} data-studio-result-tool={tool}>
      <HeaderIcon name={icon} />
      <span>{label}</span>
    </button>
  )
}

function ResultEmpty({ title, detail }: { title: string; detail: string }): React.JSX.Element {
  return (
    <div className="studio-result-empty">
      <HeaderIcon name="summary" />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  )
}

function SummaryView({
  snapshot,
  labels,
  verdict,
  language
}: ResultViewProps & { verdict?: DeliveryVerdictDetail; language?: 'zh' | 'en' }): React.JSX.Element {
  const metrics = [
    [labels.runs, snapshot.summary.runs],
    [labels.deliveryReady, `${snapshot.summary.readyArtifacts}/${snapshot.summary.currentArtifacts}`],
    [labels.deliveryAttention, snapshot.summary.attentionArtifacts],
    [labels.evidence, snapshot.summary.evidence],
    [labels.acceptance, `${snapshot.summary.passedAcceptances}/${snapshot.summary.acceptances}`],
    [labels.tests, snapshot.summary.tests],
    [labels.cost, snapshot.cost.coverage === 'unavailable' ? labels.unknown : `$${snapshot.cost.knownUsd.toFixed(4)}`]
  ]
  return (
    <div className="studio-result-content" role="tabpanel" data-studio-result-view="summary">
      {/* T04:Goal 完成门禁小标(非交互)。verifiable 才满足 canMarkGoalComplete;not_done 不显示正向完成态 */}
      {verdict && (
        <section className="studio-result-verdict-summary" data-studio-result-verdict-summary>
          <span className={`studio-result-status status-${verdict.verdict === 'verifiable' ? 'good' : 'bad'}`}>
            {verdict.verdict === 'verifiable'
              ? (language === 'en' ? 'Verifiable — may mark Goal complete' : '可验收 — 可标记 Goal 完成')
              : (language === 'en' ? 'Not verified — Goal not complete' : '未验收 — Goal 未完成')}
          </span>
        </section>
      )}
      <section className="studio-result-scope">
        <div className="studio-result-kicker">{snapshot.workspace?.name}</div>
        <h3>{snapshot.goal?.title ?? labels.projectResult}</h3>
        {snapshot.goal?.objective && <p>{snapshot.goal.objective}</p>}
        {snapshot.workItems.map((item) => (
          <div key={item.id} className="studio-result-owned-item" data-studio-result-work-item={item.id}>
            <span className={`studio-result-status status-${statusTone(item.status)}`}>{item.status}</span>
            <strong>{item.title}</strong>
            {item.description && <span>{item.description}</span>}
          </div>
        ))}
      </section>
      <section className="studio-result-metrics" aria-label={labels.summary}>
        {metrics.map(([label, value]) => (
          <div key={label} className="studio-result-metric">
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </section>
      <IssueSection title={labels.risks} items={snapshot.risks} empty={labels.noRisks} />
      <IssueSection title={labels.openItems} items={snapshot.openItems} empty={labels.noOpenItems} />
      <IssueSection title={labels.approvals} items={snapshot.approvals} empty={labels.noApprovals} />
      <section className="studio-result-verification" data-studio-result-digest={snapshot.verification.resultDigest}>
        <span>{labels.canonicalVerified}</span>
        <code>{shortDigest(snapshot.verification.aggregateDigest)}</code>
      </section>
    </div>
  )
}

function IssueSection({ title, items, empty }: { title: string; items: StudioResultIssue[]; empty: string }): React.JSX.Element {
  return (
    <section className="studio-result-section">
      <h3>{title}</h3>
      {items.length === 0 ? <div className="studio-result-muted">{empty}</div> : (
        <div className="studio-result-issue-list">
          {items.map((item) => (
            <div key={item.id} className={`studio-result-issue severity-${item.severity}`}>
              <span className="studio-result-issue-marker" aria-hidden="true" />
              <strong>{item.title}</strong>
              <span>{item.status}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function ArtifactView({
  snapshot,
  labels,
  language,
  evidenceProjectId,
  onAttachEvidence,
  onDrillEvidence,
  onOpen
}: ResultViewProps & {
  language: 'zh' | 'en'
  evidenceProjectId?: string
  onAttachEvidence?: (artifactId: string, payload: { title: string; summary?: string }) => Promise<void>
  onDrillEvidence: (artifact: StudioResultArtifact) => void
  onOpen: (location: StudioResultArtifactLocation) => void
}): React.JSX.Element {
  const currentArtifacts = snapshot.artifacts.filter((artifact) => artifact.deliveryScope === 'current')
  const historicalArtifacts = snapshot.artifacts.filter((artifact) => artifact.deliveryScope === 'historical')
  return (
    <div className="studio-result-content" role="tabpanel" data-studio-result-view="artifacts">
      <OfficeArtifactRevision snapshot={snapshot} />
      {snapshot.artifacts.length === 0 ? <div className="studio-result-muted studio-result-list-empty">{labels.noArtifacts}</div> : (
        <>
          <section className="studio-result-section studio-result-current-artifacts" data-studio-result-current-artifacts>
            <h3>{language === 'en' ? 'Current deliverables' : '当前交付版本'}</h3>
            <div className="studio-result-artifact-list">
              {currentArtifacts.map((artifact) => (
                <ArtifactRow
                  key={artifact.id}
                  artifact={artifact}
                  labels={labels}
                  language={language}
                  evidenceProjectId={evidenceProjectId}
                  onAttachEvidence={onAttachEvidence}
                  onDrillEvidence={onDrillEvidence}
                  onOpen={onOpen}
                />
              ))}
            </div>
          </section>
          {historicalArtifacts.length > 0 && (
            <section className="studio-result-section studio-result-historical-artifacts" data-studio-result-historical-artifacts>
              <h3>{language === 'en' ? 'Historical versions' : '历史版本'}</h3>
              <div className="studio-result-artifact-list">
                {historicalArtifacts.map((artifact) => (
                  <ArtifactRow
                    key={artifact.id}
                    artifact={artifact}
                    labels={labels}
                    language={language}
                    evidenceProjectId={evidenceProjectId}
                    onAttachEvidence={onAttachEvidence}
                    onDrillEvidence={onDrillEvidence}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function ArtifactRow({
  artifact,
  labels,
  language,
  evidenceProjectId,
  onAttachEvidence,
  onDrillEvidence,
  onOpen
}: {
  artifact: StudioResultArtifact
  labels: Labels
  language: 'zh' | 'en'
  evidenceProjectId?: string
  onAttachEvidence?: (artifactId: string, payload: { title: string; summary?: string }) => Promise<void>
  onDrillEvidence: (artifact: StudioResultArtifact) => void
  onOpen: (location: StudioResultArtifactLocation) => void
}): React.JSX.Element {
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachTitle, setAttachTitle] = useState('')
  const [attachSummary, setAttachSummary] = useState('')
  const [attachBusy, setAttachBusy] = useState(false)
  const [attachError, setAttachError] = useState('')
  const verification = artifactVerificationStatus(artifact, language)

  const submitAttach = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!onAttachEvidence) return
    const title = attachTitle.trim()
    if (!title) {
      setAttachError(language === 'en' ? 'Evidence title is required' : 'Evidence 标题不能为空')
      return
    }
    setAttachBusy(true)
    setAttachError('')
    try {
      await onAttachEvidence(artifact.id, { title, summary: attachSummary.trim() || undefined })
      setAttachTitle('')
      setAttachSummary('')
      setAttachOpen(false)
    } catch (cause) {
      setAttachError(errorMessage(cause))
    } finally {
      setAttachBusy(false)
    }
  }

  return (
    <section
      className={`studio-result-artifact studio-result-artifact-${artifact.deliveryScope}`}
      data-studio-result-artifact={artifact.id}
      data-studio-result-artifact-scope={artifact.deliveryScope}
    >
      <div className="studio-result-row-head">
        <div>
          <div className="studio-result-artifact-badges">
            <span className="studio-result-artifact-category">{artifactCategoryLabel(artifact, language)}</span>
            <span className={`studio-result-status status-${verification.tone}`}>{verification.label}</span>
          </div>
          <h3>{artifact.title}</h3>
          <span>
            {artifact.kind} · v{artifact.version}
            {' · '}
            {artifact.deliveryScope === 'current'
              ? (language === 'en' ? 'current deliverable' : '当前可交付版本')
              : (language === 'en' ? 'superseded historical version' : '已被替代的历史版本')}
          </span>
        </div>
        <code>{shortDigest(artifact.digest)}</code>
      </div>
      {artifact.deliveryScope === 'historical' && artifact.currentArtifactIds.length > 0 && (
        <div className="studio-result-artifact-successor">
          {language === 'en' ? 'Replaced by' : '已由当前版本替代'}: {artifact.currentArtifactIds.map(shortId).join(', ')}
        </div>
      )}
      <div className="studio-result-location-list">
        {artifact.locations.length === 0 ? <span className="studio-result-muted">{labels.noLocation}</span> : artifact.locations.map((location) => (
          <div key={location.id} className="studio-result-location">
            <span className={`studio-result-status status-${statusTone(location.availability)}`}>{location.availability}</span>
            <span className="studio-result-location-value" title={location.path ?? location.uri}>{location.path ?? location.uri ?? location.kind}</span>
            {location.availability === 'available' && (location.path || location.uri) && (
              <button type="button" onClick={() => onOpen(location)}>{labels.open}</button>
            )}
          </div>
        ))}
      </div>
      {/* T07:Artifact → Evidence 可追溯;展示 evidence/acceptance 计数与验证状态 + 下钻 */}
      <div className="studio-result-artifact-evidence" data-studio-result-artifact-evidence={artifact.id}>
        <span>
          {language === 'en' ? 'Evidence' : '已挂 Evidence'} {artifact.evidenceIds.length}
          {' · '}
          {language === 'en' ? 'Acceptance' : '验证'} {artifact.acceptanceIds.length}
          {' · '}
          {language === 'en' ? 'Delivery' : '交付状态'}：{verification.label}
        </span>
        <button type="button" className="studio-result-icon-button" data-artifact-drill onClick={() => onDrillEvidence(artifact)}>
          {language === 'en' ? 'Drill down' : '下钻证据'}
        </button>
        {onAttachEvidence && evidenceProjectId && (
          <button type="button" className="studio-result-icon-button" data-artifact-attach onClick={() => setAttachOpen((v) => !v)}>
            {language === 'en' ? 'Attach Evidence' : '关联 Evidence'}
          </button>
        )}
      </div>
      {/* T09(P1-1):把 Evidence 关联到 Artifact 的内联表单,relation 默认 verifies */}
      {attachOpen && onAttachEvidence && (
        <form className="studio-result-artifact-attach" onSubmit={submitAttach}>
          <label className="field-label">
            {language === 'en' ? 'Evidence title' : 'Evidence 标题'}
            <input
              className="input"
              value={attachTitle}
              onChange={(event) => setAttachTitle(event.target.value)}
              disabled={attachBusy}
              required
              data-artifact-attach-title
            />
          </label>
          <label className="field-label">
            {language === 'en' ? 'Summary (optional)' : '摘要（可选）'}
            <textarea
              className="input"
              value={attachSummary}
              onChange={(event) => setAttachSummary(event.target.value)}
              disabled={attachBusy}
              rows={2}
              data-artifact-attach-summary
            />
          </label>
          <button type="submit" className="btn btn-primary btn-xs" disabled={attachBusy} data-artifact-attach-save>
            {attachBusy ? (language === 'en' ? 'Saving…' : '保存中…') : (language === 'en' ? 'Save Evidence' : '保存 Evidence')}
          </button>
          {attachError && <div className="notice notice-error">{attachError}</div>}
        </form>
      )}
    </section>
  )
}

function EvidenceView({
  snapshot,
  labels,
  language,
  acceptanceReview,
  verdict,
  drill,
  repairByAcceptanceId,
  onRepairReported,
  onOpenRepair
}: ResultViewProps & {
  language: 'zh' | 'en'
  acceptanceReview: ResultAcceptanceReviewState
  verdict: DeliveryVerdictDetail
  drill?: { artifactId: string; evidenceIds: string[]; acceptanceIds: string[] }
  repairByAcceptanceId: Record<string, string>
  onRepairReported: (repair: { acceptanceId: string; workItemId: string }) => void
  onOpenRepair: (workItemId: string) => Promise<void> | void
}): React.JSX.Element {
  const drillEvidenceSet = useMemo(() => new Set(drill?.evidenceIds ?? []), [drill])
  const drillAcceptanceSet = useMemo(() => new Set(drill?.acceptanceIds ?? []), [drill])
  const [highlightId, setHighlightId] = useState<string | undefined>()
  const acceptanceScope = useMemo(() => new Map(
    snapshot.acceptances.map((acceptance) => [acceptance.id, acceptance.deliveryScope])
  ), [snapshot.acceptances])
  useEffect(() => {
    if (!drill) return
    const target = drill.evidenceIds[0] ?? drill.acceptanceIds[0]
    if (!target) return
    const el = document.querySelector(
      `[data-studio-result-evidence="${target}"],[data-studio-result-acceptance="${target}"],[data-acceptance-review="${target}"]`
    )
    if (el) (el as HTMLElement).scrollIntoView({ block: 'center' })
    setHighlightId(target)
    const timer = window.setTimeout(() => setHighlightId(undefined), 2200)
    return () => window.clearTimeout(timer)
  }, [drill])

  const drillHighlight = (id: string, drilled: boolean): React.CSSProperties | undefined =>
    drilled ? { background: highlightId === id ? 'rgba(59,130,246,0.18)' : 'rgba(59,130,246,0.08)', borderRadius: 4, padding: '2px 4px' } : undefined

  return (
    <div className="studio-result-content" role="tabpanel" data-studio-result-view="evidence">
      <section className="studio-result-section">
        <h3>{labels.acceptance}</h3>
        {/* T05:Acceptance 聚合条(pending/verifying/passed/failed/waived 计数) */}
        <AcceptanceSummary detail={verdict} language={language} />
        {snapshot.acceptances.length === 0 ? <div className="studio-result-muted">{labels.noAcceptance}</div> : acceptanceReview.acceptances.length > 0 ? acceptanceReview.acceptances.map((acceptance) => (
          acceptanceScope.get(acceptance.id) === 'historical' ? (
            <HistoricalAcceptanceRow key={acceptance.id} id={acceptance.id} status={acceptance.status} language={language} />
          ) : (
            <WorkflowAcceptanceRow
              key={acceptance.id}
              acceptance={acceptance}
              evidence={acceptanceReview.evidence}
              onRefresh={acceptanceReview.refresh}
              repairWorkItemId={repairByAcceptanceId[acceptance.id]}
              onOpenRepair={onOpenRepair}
              onRepairReported={onRepairReported}
            />
          )
        )) : snapshot.acceptances.map((acceptance) => (
          <div
            key={acceptance.id}
            className="studio-result-evidence-row"
            data-studio-result-acceptance={acceptance.id}
            style={drillHighlight(acceptance.id, drillAcceptanceSet.has(acceptance.id))}
          >
            <span className={`studio-result-status status-${statusTone(acceptance.status)}`}>{acceptance.status}</span>
            <strong>{acceptance.criteria.length} {labels.criteria}</strong>
            <span>{acceptance.coveredCriteria}/{acceptance.criteria.length} {labels.covered}</span>
            {acceptance.deliveryScope === 'historical' && (
              <span>{language === 'en' ? 'historical superseded version' : '已被新版本取代的历史记录'}</span>
            )}
          </div>
        ))}
      </section>
      <section className="studio-result-section">
        <h3>{labels.evidence}</h3>
        {snapshot.evidence.length === 0 ? <div className="studio-result-muted">{labels.noEvidence}</div> : snapshot.evidence.map((evidence) => (
          <div
            key={`${evidence.origin}:${evidence.id}`}
            className="studio-result-evidence-row"
            data-studio-result-evidence={evidence.id}
            style={drillHighlight(evidence.id, drillEvidenceSet.has(evidence.id))}
          >
            <span>{evidence.kind ?? evidence.origin}</span>
            <strong>{evidence.title}</strong>
            <code>{shortDigest(evidence.contentDigest)}</code>
          </div>
        ))}
      </section>
      <section className="studio-result-section">
        <h3>{labels.tests}</h3>
        {snapshot.tests.length === 0 ? <div className="studio-result-muted">{labels.noTests}</div> : snapshot.tests.map((test) => (
          <div key={test.id} className="studio-result-evidence-row" data-studio-result-test={test.id}>
            <span className={`studio-result-status status-${statusTone(test.status)}`}>{test.status}</span>
            <strong>{test.title}</strong>
            <code>{shortDigest(test.digest)}</code>
          </div>
        ))}
      </section>
    </div>
  )
}

function HistoricalAcceptanceRow({
  id,
  status,
  language
}: {
  id: string
  status: string
  language: 'zh' | 'en'
}): React.JSX.Element {
  return (
    <div className="studio-result-evidence-row" data-studio-result-acceptance={id}>
      <span className={`studio-result-status status-${statusTone(status)}`}>{status}</span>
      <strong>{id}</strong>
      <span>{language === 'en' ? 'Historical superseded Artifact version' : '已被新 Artifact 版本取代，不阻塞当前交付'}</span>
    </div>
  )
}

function TimelineView({
  snapshot,
  sessionId,
  labels
}: ResultViewProps & { sessionId: string | null }): React.JSX.Element {
  const [runId, setRunId] = useState('')
  const [page, setPage] = useState<StudioAuditTimelinePage>()
  const [items, setItems] = useState<StudioAuditTimelineItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const requestRef = useRef(0)

  useEffect(() => {
    if (runId && !snapshot.runs.some((run) => run.id === runId)) setRunId('')
  }, [runId, snapshot.runs])

  useEffect(() => {
    if (!sessionId) return
    const request = ++requestRef.current
    setLoading(true)
    setFailed(false)
    setPage(undefined)
    setItems([])
    void window.agentDesk.queryStudioAuditTimeline(sessionId, {
      limit: 25,
      ...(runId ? { runId } : {})
    }).then((next) => {
      if (requestRef.current !== request) return
      setPage(next)
      setItems(next.items)
    }).catch(() => {
      if (requestRef.current === request) setFailed(true)
    }).finally(() => {
      if (requestRef.current === request) setLoading(false)
    })
    return () => {
      if (requestRef.current === request) requestRef.current += 1
    }
  }, [runId, sessionId, snapshot.verification.aggregateDigest])

  const loadMore = async (): Promise<void> => {
    if (!sessionId || page?.state !== 'ready' || !page.nextCursor || loadingMore) return
    const request = requestRef.current
    setLoadingMore(true)
    setFailed(false)
    try {
      const next = await window.agentDesk.queryStudioAuditTimeline(sessionId, {
        limit: 25,
        cursor: page.nextCursor,
        ...(runId ? { runId } : {})
      })
      if (requestRef.current !== request) return
      setPage(next)
      if (next.state !== 'ready') {
        setItems([])
        return
      }
      setItems((current) => {
        const ids = new Set(current.map((item) => item.id))
        return [...current, ...next.items.filter((item) => !ids.has(item.id))]
      })
    } catch {
      if (requestRef.current === request) setFailed(true)
    } finally {
      if (requestRef.current === request) setLoadingMore(false)
    }
  }

  const integrityMessage = page?.state === 'integrity_error'
    ? page.errorCode === 'PROJECT_INTEGRITY'
      ? labels.projectAuditIntegrityError
      : labels.modelAttemptAuditIntegrityError
    : undefined

  return (
    <div
      className="studio-result-content studio-result-audit"
      role="tabpanel"
      data-studio-result-view="timeline"
      data-studio-audit-state={failed ? 'failed' : page?.state ?? (loading ? 'loading' : 'empty')}
    >
      <div className="studio-result-audit-toolbar">
        <label htmlFor="studio-result-audit-run">{labels.filterRun}</label>
        <select
          id="studio-result-audit-run"
          className="input"
          value={runId}
          disabled={loading || loadingMore}
          onChange={(event) => setRunId(event.target.value)}
          data-studio-audit-run-filter
        >
          <option value="">{labels.allRuns}</option>
          {snapshot.runs.map((run) => (
            <option key={run.id} value={run.id}>{shortId(run.id)} · {run.status}</option>
          ))}
        </select>
        {page?.state === 'ready' && (
          <span className="studio-result-audit-count" data-studio-audit-total={page.total}>
            {items.length}/{page.total}
          </span>
        )}
      </div>

      {failed && <div className="studio-result-audit-alert" role="alert" data-studio-audit-error>{labels.auditLoadFailed}</div>}
      {integrityMessage && (
        <div className="studio-result-audit-alert" role="alert" data-studio-audit-integrity-state={page?.errorCode}>
          {integrityMessage}
        </div>
      )}
      {page?.state === 'ready' && page.integrity.missingReferences > 0 && (
        <div className="studio-result-audit-alert" role="status" data-studio-audit-missing-count={page.integrity.missingReferences}>
          {labels.missingReferences.replace('{count}', String(page.integrity.missingReferences))}
        </div>
      )}

      {loading ? <div className="studio-result-muted studio-result-list-empty">{labels.auditLoading}</div> :
        page?.state === 'unbound' ? <div className="studio-result-muted studio-result-list-empty">{labels.auditUnbound}</div> :
          page?.state === 'integrity_error' ? null :
            items.length === 0 ? <div className="studio-result-muted studio-result-list-empty">{labels.noTimeline}</div> : (
              <div className="studio-result-audit-list">
                {items.map((item) => <AuditTimelineRow key={item.id} item={item} labels={labels} />)}
              </div>
            )}

      {page?.state === 'ready' && page.hasMore && (
        <div className="studio-result-audit-more">
          <button type="button" className="btn btn-secondary btn-xs" disabled={loadingMore} onClick={() => void loadMore()} data-studio-audit-load-more>
            {loadingMore ? labels.auditLoading : labels.loadMore}
          </button>
        </div>
      )}
    </div>
  )
}

function AuditTimelineRow({ item, labels }: { item: StudioAuditTimelineItem; labels: Labels }): React.JSX.Element {
  return (
    <article
      className={`studio-result-audit-row category-${item.category} integrity-${item.integrity}`}
      data-studio-audit-item={item.id}
      data-studio-audit-category={item.category}
      data-studio-audit-integrity={item.integrity}
      data-studio-audit-run={item.runId}
    >
      <div className="studio-result-audit-head">
        <time dateTime={new Date(item.occurredAt).toISOString()}>{formatTime(item.occurredAt)}</time>
        <span className={`studio-result-status status-${statusTone(item.status)}`}>{item.status}</span>
        <strong>{item.action}</strong>
        <span
          className="studio-result-audit-actor"
          title={labels.actor}
          data-studio-audit-actor={item.actor.kind}
          data-studio-audit-role={item.actor.role}
        >
          {item.actor.label}{item.actor.role ? ` · ${item.actor.role}` : ''}
        </span>
      </div>
      <div className="studio-result-audit-meta">
        {item.runId && <code title={labels.run}>Run {shortId(item.runId)}</code>}
        {item.providerId && <span title={labels.provider} data-studio-audit-provider={item.providerId}>{item.providerId}</span>}
        {item.model && <span title={labels.model} data-studio-audit-model={item.model}>{item.model}</span>}
        {item.protocol && <span title={labels.protocol} data-studio-audit-protocol={item.protocol}>{item.protocol}</span>}
        {item.keyLabel && <code title={labels.keyLabel} data-studio-audit-key-label={item.keyLabel}>{item.keyLabel}</code>}
        {item.toolName && <span title={labels.tool} data-studio-audit-tool={item.toolName}>{item.toolName}</span>}
        {item.targetKind && <span title={labels.effectTarget} data-studio-audit-target={item.targetKind}>{item.targetKind}</span>}
        {item.evidenceId && <code title={labels.evidence}>Evidence {shortId(item.evidenceId)}</code>}
        {item.acceptanceId && <code title={labels.acceptance}>Acceptance {shortId(item.acceptanceId)}</code>}
        {item.entityId && <code title={item.entityType}>{item.entityType ?? 'entity'} {shortId(item.entityId)}</code>}
        {item.costUsd !== undefined && <span title={labels.cost} data-studio-audit-cost={item.costUsd}>${formatCost(item.costUsd)}</span>}
        {item.resultDigest && <code title={labels.resultDigest} data-studio-audit-digest={item.resultDigest}>{shortDigest(item.resultDigest)}</code>}
      </div>
      {item.reason && <p className="studio-result-audit-reason" data-studio-audit-reason>{item.reason}</p>}
    </article>
  )
}

async function openLocation(
  location: StudioResultArtifactLocation,
  openTool: (tool: 'diff' | 'files' | 'preview' | 'browser', value?: string) => Promise<void>
): Promise<void> {
  if (location.uri && ['url', 'external'].includes(location.kind)) return openTool('browser', location.uri)
  if (location.kind === 'git') return openTool('diff')
  if (location.path) return openTool('preview', location.path)
  return openTool('files')
}

function bindingLabel(snapshot: StudioResultSnapshot | undefined, labels: Labels): string {
  if (!snapshot) return labels.resultPending
  if (snapshot.state === 'unbound') return labels.conversation
  return [snapshot.workspace?.name, snapshot.goal?.title, snapshot.workItems[0]?.title].filter(Boolean).join(' / ')
}

function statusTone(status: string): 'good' | 'warn' | 'bad' | 'neutral' {
  if (['done', 'completed', 'passed', 'available', 'recorded'].includes(status)) return 'good'
  if (['failed', 'blocked', 'deleted', 'unavailable', 'waiting_reconciliation'].includes(status)) return 'bad'
  if (['waiting_approval', 'pending', 'verifying', 'waived', 'partial'].includes(status)) return 'warn'
  return 'neutral'
}

function shortDigest(value: string | undefined): string {
  if (!value) return '—'
  const normalized = value.replace(/^sha256:/, '')
  return `sha256:${normalized.slice(0, 12)}`
}

function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value
}

function formatCost(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, '') || '0'
}

async function sha256Rendered(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const result = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value)
}

interface ResultViewProps {
  snapshot: StudioResultSnapshot
  labels: Labels
}

interface Labels {
  title: string; refresh: string; export: string; saved: string; loading: string; loadFailed: string
  noConversation: string; noConversationDetail: string; unbound: string; unboundDetail: string
  unavailable: string; tryRefresh: string; resultViews: string; quickActions: string
  summary: string; artifacts: string; evidence: string; timeline: string; changes: string
  workspaceFiles: string; preview: string; browser: string; terminal: string; tasks: string; runs: string; acceptance: string
  tests: string; cost: string; unknown: string; projectResult: string; risks: string
  openItems: string; approvals: string; noRisks: string; noOpenItems: string; noApprovals: string
  canonicalVerified: string; noArtifacts: string; noLocation: string; open: string; criteria: string
  covered: string; noAcceptance: string; noEvidence: string; noTests: string; noTimeline: string
  resultPending: string; conversation: string; filterRun: string; allRuns: string; loadMore: string
  auditLoading: string; auditLoadFailed: string; auditUnbound: string; projectAuditIntegrityError: string
  modelAttemptAuditIntegrityError: string; missingReferences: string; actor: string; run: string
  provider: string; model: string; protocol: string; keyLabel: string; tool: string
  effectTarget: string; resultDigest: string
  deliveryReady: string; deliveryAttention: string
}

const ZH: Labels = {
  title: '结果', refresh: '刷新结果', export: '导出可移植交付包', saved: '可移植交付包已导出', loading: '正在校验结果…', loadFailed: '结果校验失败',
  noConversation: '没有当前对话', noConversationDetail: '选择一个对话后查看结果。', unbound: '当前是对话分组',
  unboundDetail: '该对话尚未绑定 canonical Project、Goal 或 WorkItem。', unavailable: '结果暂不可用', tryRefresh: '刷新后重试。',
  resultViews: '结果视图', quickActions: '结果工具', summary: '摘要', artifacts: '产物', evidence: '证据', timeline: '时间线',
  changes: '变更', workspaceFiles: '文件', preview: '预览', browser: '浏览器', terminal: '终端', tasks: '任务', runs: '运行', acceptance: '验收', tests: '测试',
  cost: '成本', unknown: '未知', projectResult: 'Project 结果', risks: '风险', openItems: '未完成', approvals: '审批',
  noRisks: '没有已记录风险', noOpenItems: '没有未完成项', noApprovals: '没有待处理审批', canonicalVerified: 'Canonical aggregate 已校验',
  noArtifacts: '当前范围没有 canonical Artifact', noLocation: '没有可用位置', open: '打开', criteria: '项标准', covered: '已覆盖',
  noAcceptance: '没有验收记录', noEvidence: '没有 Evidence', noTests: '没有测试证据', noTimeline: '没有审计事件',
  resultPending: '等待结果', conversation: '对话', filterRun: '运行筛选', allRuns: '全部运行', loadMore: '加载更多',
  auditLoading: '正在校验审计记录…', auditLoadFailed: '审计记录加载失败，请重新打开时间线。', auditUnbound: '当前对话没有可审计的 Project 归属。',
  projectAuditIntegrityError: 'Project 审计账本完整性校验失败。', modelAttemptAuditIntegrityError: '模型调用账本完整性校验失败。',
  missingReferences: '发现 {count} 条缺失引用', actor: '执行者', run: '运行', provider: 'Provider', model: '模型', protocol: '协议',
  keyLabel: 'Key 标签', tool: '工具', effectTarget: 'Effect 目标类型', resultDigest: '结果摘要', deliveryReady: '可交付产物', deliveryAttention: '需处理产物'
}

const EN: Labels = {
  title: 'Results', refresh: 'Refresh results', export: 'Export portable delivery package', saved: 'Portable delivery package exported', loading: 'Verifying results…', loadFailed: 'Result verification failed',
  noConversation: 'No active conversation', noConversationDetail: 'Select a conversation to inspect its results.', unbound: 'Conversation group',
  unboundDetail: 'This conversation is not bound to a canonical Project, Goal, or WorkItem.', unavailable: 'Results unavailable', tryRefresh: 'Refresh to try again.',
  resultViews: 'Result views', quickActions: 'Result tools', summary: 'Summary', artifacts: 'Artifacts', evidence: 'Evidence', timeline: 'Timeline',
  changes: 'Changes', workspaceFiles: 'Files', preview: 'Preview', browser: 'Browser', terminal: 'Terminal', tasks: 'Tasks', runs: 'Runs', acceptance: 'Acceptance', tests: 'Tests',
  cost: 'Cost', unknown: 'Unknown', projectResult: 'Project result', risks: 'Risks', openItems: 'Open items', approvals: 'Approvals',
  noRisks: 'No recorded risks', noOpenItems: 'No open items', noApprovals: 'No pending approvals', canonicalVerified: 'Canonical aggregate verified',
  noArtifacts: 'No canonical Artifacts in this scope', noLocation: 'No available location', open: 'Open', criteria: 'criteria', covered: 'covered',
  noAcceptance: 'No acceptance records', noEvidence: 'No Evidence', noTests: 'No test evidence', noTimeline: 'No audit events',
  resultPending: 'Results pending', conversation: 'Conversation', filterRun: 'Run filter', allRuns: 'All Runs', loadMore: 'Load more',
  auditLoading: 'Verifying audit records…', auditLoadFailed: 'Audit records failed to load. Reopen the timeline to retry.',
  auditUnbound: 'This conversation has no auditable Project ownership.', projectAuditIntegrityError: 'Project audit ledger integrity verification failed.',
  modelAttemptAuditIntegrityError: 'Model attempt ledger integrity verification failed.', missingReferences: '{count} missing references found',
  actor: 'Actor', run: 'Run', provider: 'Provider', model: 'Model', protocol: 'Protocol', keyLabel: 'Key label', tool: 'Tool',
  effectTarget: 'Effect target kind', resultDigest: 'Result digest', deliveryReady: 'Ready artifacts', deliveryAttention: 'Need attention'
}
