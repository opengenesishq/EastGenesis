import { useState } from 'react'
import type {
  WorkflowAcceptanceRecord,
  WorkflowAcceptanceReviewDecision,
  WorkflowAcceptanceReviewResult,
  WorkflowArtifactRecord,
  WorkflowEvidenceKind,
  WorkflowEvidenceRecord
} from '../../../shared/types'
import { EVIDENCE_KINDS, errorMessage, newWorkflowId } from './workflow-ledger-ui'
import { useT } from '../i18n'

type Translate = ReturnType<typeof useT>

interface ReviewState {
  addingEvidence: boolean
  setAddingEvidence: React.Dispatch<React.SetStateAction<boolean>>
  evidenceKind: WorkflowEvidenceKind
  setEvidenceKind: React.Dispatch<React.SetStateAction<WorkflowEvidenceKind>>
  evidenceTitle: string
  setEvidenceTitle: React.Dispatch<React.SetStateAction<string>>
  evidenceSummary: string
  setEvidenceSummary: React.Dispatch<React.SetStateAction<string>>
  selectedEvidence: Record<number, string[]>
  setSelectedEvidence: React.Dispatch<React.SetStateAction<Record<number, string[]>>>
  waiverReason: string
  setWaiverReason: React.Dispatch<React.SetStateAction<string>>
  busy: boolean
  setBusy: React.Dispatch<React.SetStateAction<boolean>>
  error: string
  setError: React.Dispatch<React.SetStateAction<string>>
  success: string
  setSuccess: React.Dispatch<React.SetStateAction<string>>
}

function useReviewState(acceptance: WorkflowAcceptanceRecord): ReviewState {
  const [addingEvidence, setAddingEvidence] = useState(false)
  const [evidenceKind, setEvidenceKind] = useState<WorkflowEvidenceKind>(
    acceptance.criterionPolicies?.[0]?.evidenceKind ?? 'test_result'
  )
  const [evidenceTitle, setEvidenceTitle] = useState('')
  const [evidenceSummary, setEvidenceSummary] = useState('')
  const [selectedEvidence, setSelectedEvidence] = useState<Record<number, string[]>>({})
  const [waiverReason, setWaiverReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  return {
    addingEvidence, setAddingEvidence, evidenceKind, setEvidenceKind,
    evidenceTitle, setEvidenceTitle, evidenceSummary, setEvidenceSummary,
    selectedEvidence, setSelectedEvidence, waiverReason, setWaiverReason,
    busy, setBusy, error, setError, success, setSuccess
  }
}

export function WorkflowAcceptanceRow({
  acceptance,
  evidence,
  artifact,
  onRefresh,
  repairWorkItemId,
  onOpenRepair,
  onRepairReported
}: {
  acceptance: WorkflowAcceptanceRecord
  evidence: WorkflowEvidenceRecord[]
  artifact?: WorkflowArtifactRecord
  onRefresh: () => Promise<void>
  /** ART-005 (T06) additive:来自 reviewWorkflowAcceptance 返回的 repair.workItemId,回填映射提供 */
  repairWorkItemId?: string
  /** ART-005 (T06) additive:点击 repair 入口时跳转(openTool('tasks')/openSubagentPanel) */
  onOpenRepair?: (workItemId: string) => Promise<void> | void
  /** ART-005 (T06) additive:review 成功且有 repair 时上报父层,用于回填 repairByAcceptanceId */
  onRepairReported?: (repair: NonNullable<WorkflowAcceptanceReviewResult['repair']>) => void
}): React.JSX.Element {
  const t = useT()
  const state = useReviewState(acceptance)
  const reviewable = acceptance.status === 'pending' || acceptance.status === 'verifying'
  const onAddEvidence = (event: React.FormEvent<HTMLFormElement>): void => {
    void addEvidence(event, acceptance, state, onRefresh, t, artifact)
  }
  const onReview = (decision: WorkflowAcceptanceReviewDecision): void => {
    void reviewAcceptance(decision, acceptance, state, onRefresh, t, onRepairReported)
  }

  return (
    <div className="workflow-acceptance-row" data-acceptance-review={acceptance.id}>
      <div className="workflow-ledger-row-main">
        <strong>{acceptance.status} · {acceptance.id}</strong>
        <span className="workflow-ledger-meta">
          {t('workflowLedgerCriteriaRevision', {
            count: acceptance.criteria.length,
            revision: acceptance.revision
          })}
        </span>
      </div>
      <AcceptancePolicyList acceptance={acceptance} />
      {reviewable && (
        <AcceptanceReviewPanel
          acceptance={acceptance}
          evidence={evidence}
          artifactId={artifact?.id}
          state={state}
          onAddEvidence={onAddEvidence}
          onReview={onReview}
        />
      )}
      {acceptance.status === 'failed' && (
        <FailedAcceptanceReview state={state} onReview={onReview} />
      )}
      {acceptance.status === 'failed' && repairWorkItemId && onOpenRepair && (
        <div className="workflow-acceptance-repair" data-acceptance-repair-wrap>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            data-acceptance-repair
            onClick={() => void openRepair(repairWorkItemId, state, onOpenRepair, t)}
            disabled={state.busy}
          >
            {state.busy ? t('workflowLedgerRepairStarting') : t('workflowLedgerStartRepair')}
          </button>
        </div>
      )}
    </div>
  )
}

async function openRepair(
  workItemId: string,
  state: ReviewState,
  onOpenRepair: (workItemId: string) => Promise<void> | void,
  t: Translate
): Promise<void> {
  state.setError('')
  state.setSuccess('')
  state.setBusy(true)
  try {
    await onOpenRepair(workItemId)
    state.setSuccess(t('workflowLedgerRepairStarted'))
  } catch (cause) {
    state.setError(errorMessage(cause))
  } finally {
    state.setBusy(false)
  }
}

function AcceptancePolicyList({ acceptance }: { acceptance: WorkflowAcceptanceRecord }): React.JSX.Element {
  const t = useT()
  return (
    <div className="workflow-acceptance-policy-list">
      {acceptance.criterionPolicies?.map((policy) => (
        <span className="workflow-acceptance-policy" key={`${acceptance.id}:${policy.criterionId}`}>
          {policy.criterionIndex + 1}: {policy.evidenceKind} / {policy.allowedSources.join(', ')}
        </span>
      )) ?? <span className="workflow-ledger-meta">{t('workflowLedgerLegacyPolicy')}</span>}
    </div>
  )
}

function AcceptanceReviewPanel({
  acceptance,
  evidence,
  artifactId,
  state,
  onAddEvidence,
  onReview
}: {
  acceptance: WorkflowAcceptanceRecord
  evidence: WorkflowEvidenceRecord[]
  artifactId?: string
  state: ReviewState
  onAddEvidence: (event: React.FormEvent<HTMLFormElement>) => void
  onReview: (decision: WorkflowAcceptanceReviewDecision) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="workflow-acceptance-review">
      <div className="workflow-acceptance-review-head">
        <strong>{t('workflowLedgerReviewEvidence')}</strong>
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          data-acceptance-add-evidence
          onClick={() => toggleEvidenceAuthoring(state)}
          disabled={state.busy}
        >
          {state.addingEvidence ? t('workflowLedgerCancelEvidence') : t('workflowLedgerAddEvidence')}
        </button>
      </div>
      {state.addingEvidence && <EvidenceAuthoringForm state={state} onSubmit={onAddEvidence} />}
      <CriterionReviewList acceptance={acceptance} evidence={evidence} artifactId={artifactId} state={state} />
      <label className="field-label workflow-waiver-field">
        {t('workflowLedgerWaiverReason')}
        <input
          className="input"
          value={state.waiverReason}
          onChange={(event) => state.setWaiverReason(event.target.value)}
          disabled={state.busy}
          placeholder={t('workflowLedgerWaiverPlaceholder')}
          data-acceptance-waiver-reason
        />
      </label>
      <ReviewActions busy={state.busy} onReview={onReview} />
      {state.error && <div className="notice notice-error">{state.error}</div>}
      {state.success && <div className="notice notice-success">{state.success}</div>}
    </div>
  )
}

function EvidenceAuthoringForm({
  state,
  onSubmit
}: {
  state: ReviewState
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <form className="workflow-evidence-authoring" onSubmit={onSubmit}>
      <label className="field-label">
        {t('workflowLedgerEvidenceKind')}
        <select
          className="select select-block"
          value={state.evidenceKind}
          onChange={(event) => state.setEvidenceKind(event.target.value as WorkflowEvidenceKind)}
          disabled={state.busy}
          data-acceptance-evidence-kind
        >
          {EVIDENCE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select>
      </label>
      <label className="field-label">
        {t('workflowLedgerEvidenceTitle')}
        <input
          className="input"
          value={state.evidenceTitle}
          onChange={(event) => state.setEvidenceTitle(event.target.value)}
          disabled={state.busy}
          required
          data-acceptance-evidence-title
        />
      </label>
      <label className="field-label">
        {t('workflowLedgerEvidenceSummary')}
        <textarea
          className="input workflow-evidence-summary-input"
          value={state.evidenceSummary}
          onChange={(event) => state.setEvidenceSummary(event.target.value)}
          disabled={state.busy}
          rows={2}
          data-acceptance-evidence-summary
        />
      </label>
      <button type="submit" className="btn btn-primary btn-xs" disabled={state.busy} data-acceptance-save-evidence>
        {state.busy ? t('workflowLedgerSaving') : t('workflowLedgerSaveEvidence')}
      </button>
    </form>
  )
}

function CriterionReviewList({
  acceptance,
  evidence,
  artifactId,
  state
}: {
  acceptance: WorkflowAcceptanceRecord
  evidence: WorkflowEvidenceRecord[]
  artifactId?: string
  state: ReviewState
}): React.JSX.Element {
  return (
    <div className="workflow-criterion-review-list">
      {acceptance.criteria.map((criterion, criterionIndex) => (
        <CriterionReview
          key={`${acceptance.id}:review:${criterionIndex}`}
          acceptance={acceptance}
          criterion={criterion}
          criterionIndex={criterionIndex}
          evidence={evidence}
          artifactId={artifactId}
          state={state}
        />
      ))}
    </div>
  )
}

function CriterionReview({
  acceptance,
  criterion,
  criterionIndex,
  evidence,
  artifactId,
  state
}: {
  acceptance: WorkflowAcceptanceRecord
  criterion: string
  criterionIndex: number
  evidence: WorkflowEvidenceRecord[]
  artifactId?: string
  state: ReviewState
}): React.JSX.Element {
  const t = useT()
  const policy = policyFor(acceptance, criterionIndex)
  const candidates = eligibleEvidence(evidence, policy, artifactId)
  const selected = state.selectedEvidence[criterionIndex] ?? []
  return (
    <fieldset className="workflow-criterion-review">
      <legend>Criterion {criterionIndex + 1}: {criterion}</legend>
      {candidates.length === 0 ? (
        <span className="workflow-ledger-meta">
          {t('workflowLedgerNoMatchingEvidence', {
            kind: policy?.evidenceKind ?? t('workflowLedgerAnyKind'),
            source: policy?.allowedSources.join(', ') ?? t('workflowLedgerAnySource')
          })}
        </span>
      ) : candidates.map((record) => (
        <label className="workflow-evidence-option" key={record.evidenceId}>
          <input
            type="checkbox"
            checked={selected.includes(record.evidenceId)}
            onChange={() => toggleSelectedEvidence(state, criterionIndex, record.evidenceId)}
            disabled={state.busy}
            data-acceptance-evidence-id={record.evidenceId}
          />
          <span>{record.title} · {record.kind} · {record.source}</span>
        </label>
      ))}
    </fieldset>
  )
}

function ReviewActions({
  busy,
  onReview
}: {
  busy: boolean
  onReview: (decision: WorkflowAcceptanceReviewDecision) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="workflow-acceptance-review-actions">
      <button type="button" className="btn btn-primary btn-xs" onClick={() => onReview('passed')} disabled={busy} data-acceptance-decision="passed">{t('workflowLedgerPass')}</button>
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => onReview('failed')} disabled={busy} data-acceptance-decision="failed">{t('workflowLedgerMarkFailed')}</button>
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => onReview('waived')} disabled={busy} data-acceptance-decision="waived">{t('workflowLedgerWaive')}</button>
    </div>
  )
}

function FailedAcceptanceReview({
  state,
  onReview
}: {
  state: ReviewState
  onReview: (decision: WorkflowAcceptanceReviewDecision) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="workflow-acceptance-review workflow-acceptance-retest">
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => onReview('retest')} disabled={state.busy} data-acceptance-decision="retest">{t('workflowLedgerStartRetest')}</button>
      {state.error && <div className="notice notice-error">{state.error}</div>}
      {state.success && <div className="notice notice-success">{state.success}</div>}
    </div>
  )
}

function toggleEvidenceAuthoring(state: ReviewState): void {
  state.setAddingEvidence((current) => !current)
  state.setError('')
}

function toggleSelectedEvidence(state: ReviewState, criterionIndex: number, evidenceId: string): void {
  state.setSelectedEvidence((current) => {
    const selected = current[criterionIndex] ?? []
    const next = selected.includes(evidenceId)
      ? selected.filter((id) => id !== evidenceId)
      : [...selected, evidenceId]
    return { ...current, [criterionIndex]: next }
  })
}

function policyFor(acceptance: WorkflowAcceptanceRecord, criterionIndex: number) {
  return acceptance.criterionPolicies?.find((policy) => policy.criterionIndex === criterionIndex)
}

function eligibleEvidence(
  evidence: WorkflowEvidenceRecord[],
  policy: ReturnType<typeof policyFor>,
  artifactId?: string
): WorkflowEvidenceRecord[] {
  return evidence.filter((record) =>
    (!policy || record.kind === policy.evidenceKind) &&
    (!policy || policy.allowedSources.includes(record.source)) &&
    (!artifactId || record.artifactId === artifactId)
  )
}

async function addEvidence(
  event: React.FormEvent<HTMLFormElement>,
  acceptance: WorkflowAcceptanceRecord,
  state: ReviewState,
  onRefresh: () => Promise<void>,
  t: Translate,
  artifact?: WorkflowArtifactRecord
): Promise<void> {
  event.preventDefault()
  state.setError('')
  state.setSuccess('')
  const title = state.evidenceTitle.trim()
  const summary = state.evidenceSummary.trim()
  if (!title || !acceptance.projectId) {
    state.setError(t('workflowLedgerEvidenceTitleProjectRequired'))
    return
  }
  state.setBusy(true)
  try {
    await window.agentDesk.createWorkflowEvidence({
      evidenceId: newWorkflowId('evidence'),
      projectId: acceptance.projectId,
      ...(acceptance.goalId === undefined ? {} : { goalId: acceptance.goalId }),
      ...(acceptance.workItemId === undefined ? {} : { workItemId: acceptance.workItemId }),
      ...(artifact?.goalId === undefined ? {} : { goalId: artifact.goalId }),
      ...(artifact?.workItemId === undefined ? {} : { workItemId: artifact.workItemId }),
      ...(artifact?.runId === undefined ? {} : { runId: artifact.runId }),
      ...(artifact === undefined ? {} : { artifactId: artifact.id }),
      kind: state.evidenceKind,
      title,
      ...(summary ? { summary } : {}),
      contentDigest: artifact?.digest ?? await sha256(`${title}\n${summary}`)
    })
    state.setEvidenceTitle('')
    state.setEvidenceSummary('')
    state.setAddingEvidence(false)
    state.setSuccess(t('workflowLedgerEvidenceRecorded'))
    await onRefresh()
  } catch (cause) {
    state.setError(errorMessage(cause))
  } finally {
    state.setBusy(false)
  }
}

async function reviewAcceptance(
  decision: WorkflowAcceptanceReviewDecision,
  acceptance: WorkflowAcceptanceRecord,
  state: ReviewState,
  onRefresh: () => Promise<void>,
  t: Translate,
  onRepairReported?: (repair: NonNullable<WorkflowAcceptanceReviewResult['repair']>) => void
): Promise<void> {
  state.setError('')
  state.setSuccess('')
  if (decision === 'waived' && !state.waiverReason.trim()) {
    state.setError(t('workflowLedgerWaiverReasonRequired'))
    return
  }
  const criterionEvidence = acceptance.criteria.map((_, criterionIndex) => ({
    criterionIndex,
    evidenceRefs: [...new Set(state.selectedEvidence[criterionIndex] ?? [])]
  }))
  if (requiresEvidence(decision) && criterionEvidence.some((item) => item.evidenceRefs.length === 0)) {
    state.setError(t('workflowLedgerCriterionEvidenceRequired'))
    return
  }
  state.setBusy(true)
  try {
    const result = await window.agentDesk.reviewWorkflowAcceptance({
      acceptanceId: acceptance.id,
      criterionEvidence: decision === 'waived' || decision === 'retest' ? [] : criterionEvidence,
      decision,
      ...(decision === 'waived' ? { waiverReason: state.waiverReason.trim() } : {})
    })
    state.setSuccess(t('workflowLedgerAcceptanceReviewed', { decision: reviewDecisionLabel(decision, t) }))
    state.setSelectedEvidence({})
    state.setWaiverReason('')
    await onRefresh()
    // ART-005 (T06):review 成功且产生 repair,上报父层回填 repairByAcceptanceId 映射
    if (result.repair) onRepairReported?.(result.repair)
  } catch (cause) {
    state.setError(errorMessage(cause))
  } finally {
    state.setBusy(false)
  }
}

function requiresEvidence(decision: WorkflowAcceptanceReviewDecision): boolean {
  return decision === 'passed' || decision === 'failed'
}

function reviewDecisionLabel(decision: WorkflowAcceptanceReviewDecision, t: Translate): string {
  if (decision === 'passed') return t('workflowLedgerDecisionPassed')
  if (decision === 'failed') return t('workflowLedgerDecisionFailed')
  if (decision === 'retest') return t('workflowLedgerDecisionRetest')
  return t('workflowLedgerDecisionWaived')
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const result = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
