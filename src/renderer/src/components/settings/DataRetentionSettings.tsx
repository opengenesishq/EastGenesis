import { useEffect, useMemo, useState } from 'react'
import {
  Clock3,
  Download,
  LockKeyhole,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Trash2,
  UnlockKeyhole
} from 'lucide-react'
import type {
  DataLegalHold,
  DataPurgeDecision,
  DataRetentionAuthorityView,
  DataRetentionPendingDeletionView,
  DataRetentionSubject,
  HistoryEntry,
  ProjectWorkspace
} from '../../../../shared/types'
import { useT } from '../../i18n'
import { useStore } from '../../store'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_DAYS = 36_500

type HoldScope = DataRetentionSubject['kind']

interface OverrideDraft {
  subjectKey: string
  days: string
}

export default function DataRetentionSettings(): React.JSX.Element {
  const t = useT()
  const projects = useStore((state) => state.projectWorkspaces)
  const history = useStore((state) => state.history)
  const [authority, setAuthority] = useState<DataRetentionAuthorityView>()
  const [pending, setPending] = useState<DataRetentionPendingDeletionView>({ generatedAt: 0, items: [] })
  const [projectDays, setProjectDays] = useState('0')
  const [sessionDays, setSessionDays] = useState('0')
  const [overrides, setOverrides] = useState<OverrideDraft[]>([])
  const [holdScope, setHoldScope] = useState<HoldScope>('application')
  const [holdTargetId, setHoldTargetId] = useState('')
  const [holdReason, setHoldReason] = useState('')
  const [releaseReasons, setReleaseReasons] = useState<Record<string, string>>({})
  const [showReleased, setShowReleased] = useState(false)
  const [purgeDecision, setPurgeDecision] = useState<DataPurgeDecision>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const subjectOptions = useMemo(
    () => retentionSubjectOptions(projects, history),
    [history, projects]
  )
  const scopedTargets = useMemo(
    () => subjectOptions.filter((option) => option.subject.kind === holdScope),
    [holdScope, subjectOptions]
  )
  const overrideKeys = useMemo(() => new Set(overrides.map((item) => item.subjectKey)), [overrides])
  const hasDuplicateOverride = overrideKeys.size !== overrides.length
  const policyValid = validDays(projectDays) && validDays(sessionDays) &&
    overrides.every((item) => parseSubjectKey(item.subjectKey) && validDays(item.days)) &&
    !hasDuplicateOverride

  const refresh = async (showLoading = true): Promise<void> => {
    if (showLoading) setLoading(true)
    setError('')
    try {
      const [next, pendingView] = await Promise.all([
        window.agentDesk.getDataRetentionAuthority(),
        window.agentDesk.getDataRetentionPendingDeletions()
      ])
      applyAuthority(next)
      setPending(pendingView)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      if (showLoading) setLoading(false)
    }
  }

  const applyAuthority = (next: DataRetentionAuthorityView): void => {
    setAuthority(next)
    setProjectDays(formatDays(next.policy.projectMinimumRetentionMs))
    setSessionDays(formatDays(next.policy.sessionMinimumRetentionMs))
    setOverrides(next.policy.subjectOverrides.map((item) => ({
      subjectKey: subjectKey(item.subject),
      days: formatDays(item.minimumRetentionMs)
    })))
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(false), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (holdScope === 'application') {
      setHoldTargetId('')
      return
    }
    if (!scopedTargets.some((option) => subjectId(option.subject) === holdTargetId)) {
      setHoldTargetId(scopedTargets[0] ? subjectId(scopedTargets[0].subject) : '')
    }
  }, [holdScope, holdTargetId, scopedTargets])

  useEffect(() => {
    const target = selectedPurgeTarget(holdScope, holdTargetId, projects, history)
    if (!target || !authority) {
      setPurgeDecision(undefined)
      return
    }
    let cancelled = false
    const relatedLegalHoldSubjects = target.subject.kind === 'session'
      ? historyProjectSubjects(history.find((entry) => entry.id === target.subject.id))
      : []
    void window.agentDesk.evaluateDataPurge({ targets: [target], relatedLegalHoldSubjects })
      .then((decision) => {
        if (!cancelled) setPurgeDecision(decision)
      })
      .catch(() => {
        if (!cancelled) setPurgeDecision(undefined)
      })
    return () => { cancelled = true }
  }, [authority, history, holdScope, holdTargetId, projects])

  const savePolicy = async (): Promise<void> => {
    if (!authority || !policyValid) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const next = await window.agentDesk.updateDataRetentionPolicy({
        requestId: mutationRequestId('retention-policy'),
        expectedRevision: authority.revision,
        projectMinimumRetentionMs: daysToMs(projectDays),
        sessionMinimumRetentionMs: daysToMs(sessionDays),
        subjectOverrides: overrides.map((item) => {
          const subject = parseSubjectKey(item.subjectKey)
          if (!subject || subject.kind === 'application' || !subject.id) {
            throw new Error(t('retentionSubjectUnavailable'))
          }
          return {
            subject: { kind: subject.kind, id: subject.id },
            minimumRetentionMs: daysToMs(item.days)
          }
        })
      })
      applyAuthority(next)
      setMessage(t('retentionPolicySaved'))
    } catch (reason) {
      await handleMutationError(reason)
    } finally {
      setBusy(false)
    }
  }

  const createHold = async (): Promise<void> => {
    if (!authority || !holdReason.trim() || (holdScope !== 'application' && !holdTargetId)) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const next = await window.agentDesk.createDataLegalHold({
        requestId: mutationRequestId('legal-hold-create'),
        expectedRevision: authority.revision,
        subject: holdScope === 'application'
          ? { kind: 'application' }
          : { kind: holdScope, id: holdTargetId },
        reason: holdReason.trim()
      })
      setAuthority(next)
      setHoldReason('')
      setMessage(t('legalHoldCreated'))
    } catch (reason) {
      await handleMutationError(reason)
    } finally {
      setBusy(false)
    }
  }

  const saveExport = async (): Promise<void> => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await window.agentDesk.saveDataRetentionAuthorityExport()
      if (!result.canceled) setMessage(t('retentionExported'))
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const releaseHold = async (hold: DataLegalHold): Promise<void> => {
    const reason = releaseReasons[hold.id]?.trim()
    if (!authority || !reason) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const next = await window.agentDesk.releaseDataLegalHold({
        requestId: mutationRequestId('legal-hold-release'),
        expectedRevision: authority.revision,
        holdId: hold.id,
        reason
      })
      setAuthority(next)
      setReleaseReasons((current) => ({ ...current, [hold.id]: '' }))
      setMessage(t('legalHoldReleasedMessage'))
    } catch (mutationError) {
      await handleMutationError(mutationError)
    } finally {
      setBusy(false)
    }
  }

  const handleMutationError = async (reason: unknown): Promise<void> => {
    setError(errorText(reason))
    if (errorText(reason).includes('stale_revision')) await refresh()
  }

  const addOverride = (): void => {
    const available = subjectOptions.find((option) => option.subject.kind !== 'application' &&
      !overrideKeys.has(option.value))
    if (!available) return
    setOverrides((current) => [...current, { subjectKey: available.value, days: '0' }])
  }

  const holds = (authority?.legalHolds ?? [])
    .filter((hold) => showReleased || hold.status === 'active')
    .slice()
    .sort((left, right) => statusRank(left) - statusRank(right) || right.createdAt - left.createdAt)

  if (loading && !authority) return <div className="retention-loading"><RefreshCw size={16} className="spin" />{t('retentionLoading')}</div>

  return <div className="data-retention-settings" data-data-retention-settings>
    <div className="retention-toolbar">
      <div>
        <h3 className="settings-h3">{t('retentionPolicyTitle')}</h3>
        {authority && <span>{t('retentionRevision', { revision: authority.revision })}</span>}
      </div>
      <div className="retention-toolbar-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !authority} onClick={() => void saveExport()}>
          <Download size={15} />{t('retentionExport')}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw size={15} />{t('retentionRefresh')}
        </button>
      </div>
    </div>

    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {message && <div className="notice notice-info" role="status">{message}</div>}

    <section className="settings-section retention-policy-section">
      <div className="settings-grid-2">
        <DurationField label={t('retentionProjectDefault')} value={projectDays} disabled={busy} onChange={setProjectDays} />
        <DurationField label={t('retentionSessionDefault')} value={sessionDays} disabled={busy} onChange={setSessionDays} />
      </div>
      <div className="settings-section-head retention-subsection-head">
        <h4 className="settings-h4">{t('retentionOverrides')}</h4>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || overrideKeys.size >= subjectOptions.length - 1} onClick={addOverride}>
          <Plus size={15} />{t('retentionOverrideAdd')}
        </button>
      </div>
      {overrides.length === 0 && <div className="settings-hint">{t('retentionOverrideEmpty')}</div>}
      <div className="retention-override-list">
        {overrides.map((item, index) => <div className="retention-override-row" key={`${index}-${item.subjectKey}`}>
          <select className="select" value={item.subjectKey} disabled={busy} aria-label={t('legalHoldTarget')} onChange={(event) => setOverrides((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, subjectKey: event.target.value } : candidate))}>
            {subjectOptions.filter((option) => option.subject.kind !== 'application').map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
          <div className="retention-duration-input">
            <input className="input" type="number" min={0} max={MAX_DAYS} step={1} value={item.days} disabled={busy} onChange={(event) => setOverrides((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, days: event.target.value } : candidate))} />
            <span>{t('retentionDays')}</span>
          </div>
          <button type="button" className="icon-btn" title={t('delete')} aria-label={t('delete')} disabled={busy} onClick={() => setOverrides((current) => current.filter((_, candidateIndex) => candidateIndex !== index))}><Trash2 size={16} /></button>
        </div>)}
      </div>
      {!policyValid && <p className="retention-validation" role="alert">{hasDuplicateOverride ? t('retentionDuplicateOverride') : t('retentionInvalidDays')}</p>}
      <div className="retention-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !authority || !policyValid} onClick={() => void savePolicy()}><Save size={16} />{t('retentionSavePolicy')}</button>
      </div>
    </section>

    <section className="settings-section retention-pending-section">
      <div className="settings-section-head"><h3 className="settings-h3">{t('retentionPendingTitle')}</h3></div>
      <p className="settings-hint">{t('retentionPendingHint')}</p>
      <div className="retention-pending-list">
        {pending.items.length === 0 && <div className="settings-hint">{t('retentionPendingEmpty')}</div>}
        {pending.items.map((item) => <article className="retention-pending-row" key={item.operationId}>
          <div>
            <strong>{subjectLabel({ kind: item.kind, id: item.id }, projects, history, t)}</strong>
            <small>{item.kind === 'project' ? t('legalHoldProject') : t('legalHoldSession')} · {item.phase}</small>
          </div>
          <div className={`retention-pending-state ${item.decision.allowed ? 'ready' : 'blocked'}`}>
            {item.decision.allowed
              ? t('retentionPendingReady')
              : item.decision.blockers.some((blocker) => blocker.kind === 'legal_hold')
                ? t('retentionPendingHeld')
                : t('retentionPendingUntil', {
                    date: formatDate(Math.max(...item.decision.blockers
                      .filter((blocker) => blocker.kind === 'minimum_retention')
                      .map((blocker) => blocker.earliestPurgeAt)))
                  })}
          </div>
        </article>)}
      </div>
    </section>

    <section className="settings-section legal-hold-section">
      <div className="settings-section-head"><h3 className="settings-h3">{t('legalHoldTitle')}</h3></div>
      <div className="legal-hold-scope" role="group" aria-label={t('legalHoldScope')}>
        {(['application', 'project', 'session'] as const).map((scope) => <button type="button" key={scope} className={holdScope === scope ? 'active' : ''} aria-pressed={holdScope === scope} disabled={busy} onClick={() => setHoldScope(scope)}>{scopeLabel(scope, t)}</button>)}
      </div>
      <div className="legal-hold-create-grid">
        {holdScope === 'application' ? <div className="legal-hold-application-target"><ShieldAlert size={17} />{t('retentionApplicationSubject')}</div> : <label className="field-label">{t('legalHoldTarget')}<select className="select select-block" value={holdTargetId} disabled={busy || scopedTargets.length === 0} onChange={(event) => setHoldTargetId(event.target.value)}>{scopedTargets.length === 0 && <option value="">{t('retentionSubjectUnavailable')}</option>}{scopedTargets.map((option) => <option value={subjectId(option.subject)} key={option.value}>{option.label}</option>)}</select></label>}
        <label className="field-label legal-hold-reason-field">{t('legalHoldReason')}<input className="input input-block" value={holdReason} maxLength={2_000} disabled={busy} placeholder={t('legalHoldReasonPlaceholder')} onChange={(event) => setHoldReason(event.target.value)} /></label>
        <button type="button" className="btn btn-primary legal-hold-create-button" disabled={busy || !authority || !holdReason.trim() || (holdScope !== 'application' && !holdTargetId)} onClick={() => void createHold()}><LockKeyhole size={16} />{t('legalHoldCreate')}</button>
      </div>
      {holdScope !== 'application' && <PurgeDecisionView decision={purgeDecision} t={t} />}

      <label className="settings-check retention-show-released"><input type="checkbox" checked={showReleased} onChange={(event) => setShowReleased(event.target.checked)} />{t('legalHoldShowReleased')}</label>
      <div className="legal-hold-list">
        {holds.length === 0 && <div className="settings-hint">{t('legalHoldEmpty')}</div>}
        {holds.map((hold) => <article className="legal-hold-row" key={hold.id}>
          <div className="legal-hold-row-main">
            <div className="legal-hold-row-title"><strong>{subjectLabel(hold.subject, projects, history, t)}</strong><span className={`retention-status ${hold.status}`}>{hold.status === 'active' ? t('legalHoldActive') : t('legalHoldReleased')}</span></div>
            <p>{hold.reason}</p>
            <small>{t('retentionCreatedAt', { date: formatDate(hold.createdAt) })}</small>
            {hold.releasedAt && <small>{t('retentionReleasedAt', { date: formatDate(hold.releasedAt) })} · {hold.releaseReason}</small>}
          </div>
          {hold.status === 'active' && <div className="legal-hold-release-controls">
            <input className="input" maxLength={2_000} value={releaseReasons[hold.id] ?? ''} disabled={busy} placeholder={t('legalHoldReleasePlaceholder')} aria-label={t('legalHoldReleaseReason')} onChange={(event) => setReleaseReasons((current) => ({ ...current, [hold.id]: event.target.value }))} />
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !releaseReasons[hold.id]?.trim()} onClick={() => void releaseHold(hold)}><UnlockKeyhole size={15} />{t('legalHoldRelease')}</button>
          </div>}
        </article>)}
      </div>
    </section>
  </div>
}

function DurationField({ label, value, disabled, onChange }: {
  label: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  const t = useT()
  return <label className="field-label">{label}<div className="retention-duration-input"><input className="input input-block" type="number" min={0} max={MAX_DAYS} step={1} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} /><span>{t('retentionDays')}</span></div></label>
}

function PurgeDecisionView({ decision, t }: {
  decision: DataPurgeDecision | undefined
  t: ReturnType<typeof useT>
}): React.JSX.Element | null {
  if (!decision) return null
  return <div className={`retention-purge-decision ${decision.allowed ? 'allowed' : 'blocked'}`}>
    {decision.allowed ? <Clock3 size={16} /> : <ShieldAlert size={16} />}
    <div><strong>{decision.allowed ? t('retentionPurgeAllowed') : t('retentionPurgeBlocked')}</strong>{decision.blockers.map((blocker, index) => <span key={`${blocker.kind}-${index}`}>{blocker.kind === 'legal_hold' ? t('retentionBlockedByHold', { id: blocker.holdId }) : t('retentionBlockedUntil', { date: formatDate(blocker.earliestPurgeAt) })}</span>)}</div>
  </div>
}

function retentionSubjectOptions(projects: ProjectWorkspace[], history: HistoryEntry[]) {
  return [
    { value: 'application', subject: { kind: 'application' as const }, label: 'EastGenesis' },
    ...projects.map((project) => ({ value: subjectKey({ kind: 'project', id: project.id }), subject: { kind: 'project' as const, id: project.id }, label: `Project · ${project.name}` })),
    ...history.map((entry) => ({ value: subjectKey({ kind: 'session', id: entry.id }), subject: { kind: 'session' as const, id: entry.id }, label: `Session · ${entry.title}` }))
  ]
}

function selectedPurgeTarget(scope: HoldScope, targetId: string, projects: ProjectWorkspace[], history: HistoryEntry[]) {
  if (scope === 'project') {
    const project = projects.find((item) => item.id === targetId)
    return project ? { subject: { kind: 'project' as const, id: project.id }, retentionAnchorAt: project.deletedAt ?? project.updatedAt } : undefined
  }
  if (scope === 'session') {
    const session = history.find((item) => item.id === targetId)
    return session ? { subject: { kind: 'session' as const, id: session.id }, retentionAnchorAt: session.updatedAt } : undefined
  }
  return undefined
}

function historyProjectSubjects(entry: HistoryEntry | undefined): DataRetentionSubject[] {
  if (!entry) return []
  return [...new Set([entry.workspaceId, entry.projectId, entry.personalWorkspaceId].filter((id): id is string => Boolean(id)))]
    .map((id) => ({ kind: 'project', id }))
}

function subjectLabel(subject: DataRetentionSubject, projects: ProjectWorkspace[], history: HistoryEntry[], t: ReturnType<typeof useT>): string {
  if (subject.kind === 'application') return t('retentionApplicationSubject')
  if (subject.kind === 'project') return projects.find((item) => item.id === subject.id)?.name ?? subject.id ?? ''
  return history.find((item) => item.id === subject.id)?.title ?? subject.id ?? ''
}

function scopeLabel(scope: HoldScope, t: ReturnType<typeof useT>): string {
  if (scope === 'application') return t('legalHoldApplication')
  return scope === 'project' ? t('legalHoldProject') : t('legalHoldSession')
}

function subjectKey(subject: DataRetentionSubject): string {
  return subject.kind === 'application' ? 'application' : `${subject.kind}|${encodeURIComponent(subject.id ?? '')}`
}

function subjectId(subject: DataRetentionSubject): string {
  return subject.kind === 'application' ? '' : subject.id ?? ''
}

function parseSubjectKey(value: string): DataRetentionSubject | undefined {
  if (value === 'application') return { kind: 'application' }
  const separator = value.indexOf('|')
  if (separator <= 0) return undefined
  const kind = value.slice(0, separator)
  const id = decodeURIComponent(value.slice(separator + 1))
  return (kind === 'project' || kind === 'session') && id ? { kind, id } : undefined
}

function validDays(value: string): boolean {
  const days = Number(value)
  return Number.isFinite(days) && days >= 0 && days <= MAX_DAYS
}

function daysToMs(value: string): number {
  return Math.round(Number(value) * DAY_MS)
}

function formatDays(value: number): string {
  const days = value / DAY_MS
  return Number.isInteger(days) ? String(days) : String(Math.round(days * 1_000) / 1_000)
}

function formatDate(value: number): string {
  return new Date(value).toLocaleString()
}

function mutationRequestId(prefix: string): string {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${suffix}`
}

function statusRank(hold: DataLegalHold): number {
  return hold.status === 'active' ? 0 : 1
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
