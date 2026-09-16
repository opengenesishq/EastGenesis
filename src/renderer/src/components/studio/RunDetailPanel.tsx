import { useMemo, useState } from 'react'
import type {
  RunDetailCanonicalInput,
  RunDetailProjection,
  RunDetailRoute,
  RunDetailSection
} from '../../../../shared/run-detail-projection'
import {
  createRunDetailRoute,
  projectRunDetail
} from '../../../../shared/run-detail-projection'
import TaskEffectRecoveryPanel from '../TaskEffectRecoveryPanel'
import { useStore } from '../../store'
import './run-detail-panel.css'

export interface RunDetailPanelProps {
  /** Current canonical Ledger selection; no renderer-created Run state is accepted. */
  input: RunDetailCanonicalInput
  route: string | RunDetailRoute
  onNavigate?: (route: string) => void
  /** Main/store-owned recovery action. This component never calls a Provider. */
  onRecover?: (runId: string) => void | Promise<void>
  /** Refresh the canonical selection after an Effect decision. */
  onRecoveryChanged?: () => void | Promise<void>
  /** Navigate to the project Delivery/Acceptance surface using canonical IDs. */
  onOpenDelivery?: (projectId: string, workItemId?: string) => void
}

/**
 * A single renderer-safe Run page for Run status, Acceptance Gate, and
 * Recovery. The parent owns Run fetching and recovery; the embedded Effect
 * panel reads and resolves only the same persisted Run's outstanding effects.
 */
export default function RunDetailPanel({ input, route, onNavigate, onRecover, onRecoveryChanged, onOpenDelivery }: RunDetailPanelProps): React.JSX.Element {
  const detail = useMemo(() => projectRunDetail(input, route), [input, route])
  if (!detail) {
    return <section className="run-detail-panel run-detail-panel-empty" data-run-detail-panel="missing" role="status">
      <strong>Run detail unavailable</strong>
      <span>The Run is no longer present in the canonical Ledger selection.</span>
    </section>
  }
  // A different canonical Run owns a different action state. Unmounting the
  // previous view also prevents its pending callback from updating this Run.
  return <RunDetailContent key={detail.run.id} detail={detail} onNavigate={onNavigate} onRecover={onRecover} onRecoveryChanged={onRecoveryChanged} onOpenDelivery={onOpenDelivery} />
}

function RunDetailContent({ detail, onNavigate, onRecover, onRecoveryChanged, onOpenDelivery }: {
  detail: RunDetailProjection
} & Pick<RunDetailPanelProps, 'onNavigate' | 'onRecover' | 'onRecoveryChanged' | 'onOpenDelivery'>): React.JSX.Element {
  const [recovering, setRecovering] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | undefined>()
  const [recoveryNotice, setRecoveryNotice] = useState<string | undefined>()
  const zh = useStore(state => state.settings.language) === 'zh'
  const activeSection = detail.route.section
  return <section className="run-detail-panel" data-run-detail-panel="true" data-run-id={detail.run.id} data-run-status={detail.run.status} data-run-section={activeSection} data-run-detail-section={activeSection} aria-labelledby="run-detail-title">
    <header className="run-detail-header">
      <div>
        <span className="run-detail-kicker">Run detail</span>
        <h2 id="run-detail-title">{detail.workItem?.title ?? `Run ${detail.run.id}`}</h2>
        <span className="run-detail-identity">{detail.run.id} · {detail.run.status} · attempt {detail.run.attempt}</span>
      </div>
      <span className={`run-detail-status run-detail-status-${detail.run.status}`}>{detail.run.status}</span>
    </header>

    <nav className="run-detail-nav" aria-label="Run detail sections">
      {(['run', 'acceptance', 'recovery'] as const).map((section) => <button
        key={section}
        type="button"
        data-run-detail-section={section}
        className={activeSection === section ? 'run-detail-nav-active' : ''}
        aria-current={activeSection === section ? 'page' : undefined}
        onClick={() => onNavigate?.(createRunDetailRoute(detail.run.id, section))}
        disabled={!onNavigate}
      >{sectionLabel(section)}</button>)}
    </nav>

    <div className="run-detail-grid">
      <article className="run-detail-card" data-run-detail-run>
        <h3>Run</h3>
        <dl>
          <div><dt>Status</dt><dd>{detail.run.status}</dd></div>
          <div><dt>Revision</dt><dd>{detail.run.revision}</dd></div>
          <div><dt>Session</dt><dd>{detail.run.sessionId}</dd></div>
          <div><dt>WorkItem</dt><dd>{detail.run.workItemId}</dd></div>
        </dl>
      </article>

      <article className="run-detail-card" data-run-detail-acceptance>
        <div className="run-detail-card-heading"><h3>Acceptance Gate</h3><span data-acceptance-gate-status={detail.acceptanceGate.status}>{detail.acceptanceGate.status}</span></div>
        {detail.acceptance ? <>
          <p className="run-detail-muted">{detail.acceptance.id} · revision {detail.acceptance.revision} · {detail.acceptance.criteria.length} criteria</p>
          <ul className="run-detail-criteria">{detail.acceptance.criteria.map((criterion, index) => <li key={`${detail.acceptance?.id}-criterion-${index}`}>{criterion}</li>)}</ul>
          {detail.acceptanceGate.missingEvidenceRefs.length > 0 && <p className="run-detail-blocker" role="alert">Evidence binding missing: {detail.acceptanceGate.missingEvidenceRefs.join(', ')}</p>}
          {detail.acceptanceGate.blockers.includes('acceptance_failed') && <p className="run-detail-blocker" role="alert">Acceptance failed and requires review.</p>}
          <div className="run-detail-evidence" data-evidence-link-count={detail.evidenceLinks.length}>
            <span>Canonical EvidenceLink bindings ({detail.evidenceLinks.length})</span>
            {detail.evidenceLinks.length > 0 ? <ul>{detail.evidenceLinks.map((link) => <li key={link.linkId}><code>{link.evidenceId}</code> · {link.relation}</li>)}</ul> : <small>No EvidenceLink binding is present.</small>}
          </div>
        </> : <p className="run-detail-blocker" role="alert">No canonical Acceptance is attached to this Run.</p>}
        {onOpenDelivery && detail.run.projectId && detail.run.workItemId && <button type="button" className="btn btn-ghost btn-sm" data-run-open-delivery onClick={() => onOpenDelivery(detail.run.projectId!, detail.run.workItemId)}>
          Open delivery review
        </button>}
      </article>

      <article className="run-detail-card" data-run-detail-recovery>
        <div className="run-detail-card-heading"><h3>{zh ? '运行恢复' : 'Recovery'}</h3><span data-recovery-state={detail.recovery.state}>{detail.recovery.state}</span></div>
        <p className="run-detail-muted">{recoveryDescription(detail.recovery.state, zh)}</p>
        <TaskEffectRecoveryPanel sessionId={detail.run.sessionId} runId={detail.run.id}
          taskId={detail.run.taskId} onChanged={onRecoveryChanged} />
        {detail.recovery.action !== 'none' && onRecover && <>
          <button type="button" className="btn btn-primary btn-sm" disabled={recovering} onClick={() => {
            setRecovering(true)
            setRecoveryError(undefined)
            setRecoveryNotice(undefined)
            void (async () => {
              try {
                await onRecover(detail.run.id)
                setRecoveryNotice(zh ? '恢复请求已处理，请查看最新运行状态。' : 'Recovery request processed. Check the latest Run status.')
              } catch (error: unknown) {
                setRecoveryError(error instanceof Error ? error.message : String(error))
              } finally {
                setRecovering(false)
              }
            })()
          }} data-run-recover>{recovering ? (zh ? '正在处理…' : 'Recovering…')
            : detail.recovery.action === 'reconcile' ? (zh ? '核对后继续' : 'Continue after checking')
              : (zh ? '恢复运行' : 'Recover Run')}</button>
        </>}
        {recoveryNotice && <p className="run-detail-success" role="status" data-run-recovery-result="completed">{recoveryNotice}</p>}
        {recoveryError && <p className="run-detail-blocker" role="alert" data-run-recovery-error>{recoveryError}</p>}
      </article>
    </div>
  </section>
}

function sectionLabel(section: RunDetailSection): string {
  return section === 'run' ? 'Run' : section === 'acceptance' ? 'Acceptance' : 'Recovery'
}

function recoveryDescription(state: 'available' | 'in_progress' | 'reconciliation_required' | 'unavailable', zh: boolean): string {
  if (zh) {
    if (state === 'available') return '可以从已保存的记录恢复这次失败的运行。'
    if (state === 'in_progress') return '运行正在恢复中。'
    if (state === 'reconciliation_required') return '先核对下方未决操作；全部处理后可继续。尚未核对的模型请求仍会阻止执行。'
    return '当前状态没有可用的恢复操作。'
  }
  if (state === 'available') return 'This failed Run can be recovered by the main process.'
  if (state === 'in_progress') return 'Recovery is already in progress.'
  if (state === 'reconciliation_required') return 'Check outstanding operations below before continuing. Unresolved model requests still block execution.'
  return 'No recovery action is available for this Run status.'
}
