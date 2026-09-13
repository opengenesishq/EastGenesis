import { useCallback, useEffect, useState } from 'react'
import type {
  WorkflowAcceptanceRecord,
  WorkflowEvidenceRecord,
  WorkflowLedgerRendererSelection,
  WorkflowLedgerVerification,
  WorkflowWorkItemRecord
} from '../../../shared/types'
import {
  WorkflowAcceptanceAuthoring,
  useWorkflowAcceptanceAuthoring
} from './WorkflowAcceptanceAuthoring'
import { WorkflowAcceptanceRow } from './WorkflowAcceptanceRow'
import { useT } from '../i18n'

const EMPTY_SCOPE = { limit: 25 }

interface WorkflowLedgerState {
  ledger: WorkflowLedgerRendererSelection | null
  verification: WorkflowLedgerVerification | null
  evidence: WorkflowEvidenceRecord[]
  loading: boolean
  error: string
  selectedWorkItemId: string
  setSelectedWorkItemId: React.Dispatch<React.SetStateAction<string>>
  refresh: () => Promise<void>
}

function useWorkflowLedger(): WorkflowLedgerState {
  const [ledger, setLedger] = useState<WorkflowLedgerRendererSelection | null>(null)
  const [verification, setVerification] = useState<WorkflowLedgerVerification | null>(null)
  const [evidence, setEvidence] = useState<WorkflowEvidenceRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedWorkItemId, setSelectedWorkItemId] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const [nextLedger, nextVerification, nextEvidence] = await Promise.all([
        window.agentDesk.listWorkflowLedger(EMPTY_SCOPE),
        window.agentDesk.verifyWorkflowLedger(),
        window.agentDesk.queryWorkflowEvidence({ limit: 100 })
      ])
      setLedger(nextLedger)
      setVerification(nextVerification)
      setEvidence(nextEvidence.items)
      setSelectedWorkItemId((current) => {
        if (current && nextLedger.workItems.items.some((item) => item.id === current)) return current
        return nextLedger.workItems.items[0]?.id ?? ''
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return {
    ledger,
    verification,
    evidence,
    loading,
    error,
    selectedWorkItemId,
    setSelectedWorkItemId,
    refresh
  }
}

export default function WorkflowLedgerPanel(): React.JSX.Element {
  const state = useWorkflowLedger()
  const workItems = state.ledger?.workItems.items ?? []
  const acceptances = state.ledger?.acceptances.items ?? []
  const authoring = useWorkflowAcceptanceAuthoring({
    workItems,
    selectedWorkItemId: state.selectedWorkItemId,
    setSelectedWorkItemId: state.setSelectedWorkItemId,
    onRefresh: state.refresh
  })

  return (
    <section className="control-section workflow-ledger-panel" aria-labelledby="workflow-ledger-title">
      <WorkflowLedgerHeader
        authoring={authoring.authoring}
        loading={state.loading}
        hasWorkItems={workItems.length > 0}
        onToggleAuthoring={authoring.toggleAuthoring}
        onRefresh={state.refresh}
      />
      {state.error && <div className="notice notice-error">{state.error}</div>}
      <WorkflowLedgerSummary ledger={state.ledger} verification={state.verification} />
      {authoring.authoring && <WorkflowAcceptanceAuthoring workItems={workItems} controller={authoring} />}
      <WorkflowWorkItemList workItems={workItems} />
      {acceptances.length > 0 && (
        <WorkflowAcceptanceList
          acceptances={acceptances}
          evidence={state.evidence}
          onRefresh={state.refresh}
        />
      )}
    </section>
  )
}

function WorkflowLedgerHeader({
  authoring,
  loading,
  hasWorkItems,
  onToggleAuthoring,
  onRefresh
}: {
  authoring: boolean
  loading: boolean
  hasWorkItems: boolean
  onToggleAuthoring: () => void
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="settings-section-head">
      <div>
        <h3 id="workflow-ledger-title" className="settings-h3">{t('workflowLedgerTitle')}</h3>
        <p className="settings-hint">{t('workflowLedgerSubtitle')}</p>
      </div>
      <div className="workflow-ledger-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onToggleAuthoring}
          disabled={!hasWorkItems}
          title={t('workflowLedgerCreateAcceptanceTitle')}
        >
          {authoring ? t('workflowLedgerCloseAuthoring') : t('workflowLedgerNewAcceptance')}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void onRefresh()}
          disabled={loading}
          title={t('workflowLedgerRefreshTitle')}
        >
          {loading ? t('workflowLedgerRefreshing') : t('refresh')}
        </button>
      </div>
    </div>
  )
}

function WorkflowLedgerSummary({
  ledger,
  verification
}: {
  ledger: WorkflowLedgerRendererSelection | null
  verification: WorkflowLedgerVerification | null
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="workflow-ledger-summary" aria-live="polite">
      <span>{t('workflowLedgerGoals')} {ledger?.goals.total ?? 0}</span>
      <span>{t('workflowLedgerWorkItems')} {ledger?.workItems.total ?? 0}</span>
      <span>{t('workflowLedgerRuns')} {ledger?.runs.total ?? 0}</span>
      <span>{t('workflowLedgerArtifacts')} {ledger?.artifacts.total ?? 0}</span>
      <span>{t('workflowLedgerAcceptance')} {ledger?.acceptances.total ?? 0}</span>
      <span>{t('workflowLedgerEvents')} {verification?.events ?? ledger?.events.total ?? 0}</span>
      <span className={verification ? 'workflow-ledger-valid' : 'workflow-ledger-pending'}>
        {verification ? t('workflowLedgerChainValid') : t('workflowLedgerAwaitingVerification')}
      </span>
    </div>
  )
}

function WorkflowWorkItemList({ workItems }: { workItems: WorkflowWorkItemRecord[] }): React.JSX.Element {
  const t = useT()
  if (workItems.length === 0) {
    return <p className="settings-hint workflow-ledger-empty">{t('workflowLedgerNoWorkItems')}</p>
  }
  return (
    <div className="workflow-ledger-list">
      {workItems.map((item) => <WorkflowWorkItemRow key={item.id} item={item} />)}
    </div>
  )
}

function WorkflowWorkItemRow({ item }: { item: WorkflowWorkItemRecord }): React.JSX.Element {
  const t = useT()
  return (
    <div className="workflow-ledger-row">
      <div className="workflow-ledger-row-main">
        <strong>{item.title}</strong>
        <span className="workflow-ledger-meta">{item.id}</span>
      </div>
      <div className="workflow-ledger-row-side">
        <span className={`workflow-ledger-status workflow-ledger-status-${item.status}`}>{item.status}</span>
        <span className="workflow-ledger-meta">
          {t('workflowLedgerRevisionRuns', { revision: item.revision, count: item.runIds.length })}
        </span>
      </div>
    </div>
  )
}

function WorkflowAcceptanceList({
  acceptances,
  evidence,
  onRefresh
}: {
  acceptances: WorkflowAcceptanceRecord[]
  evidence: WorkflowEvidenceRecord[]
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="workflow-acceptance-list" aria-label={t('workflowLedgerAcceptanceList')}>
      <div className="workflow-acceptance-list-head">
        <h4>{t('workflowLedgerAcceptancePolicies')}</h4>
        <span className="workflow-ledger-meta">{t('workflowLedgerSavedRecordsReadonly')}</span>
      </div>
      {acceptances.map((acceptance) => (
        <WorkflowAcceptanceRow
          key={acceptance.id}
          acceptance={acceptance}
          evidence={evidence.filter((record) =>
            record.projectId === acceptance.projectId &&
            record.workItemId === acceptance.workItemId
          )}
          onRefresh={onRefresh}
        />
      ))}
    </div>
  )
}
