import { CheckCircle2, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type {
  ProviderBillingReconciliationView,
  ProviderBillingStatementSource
} from '../../../../shared/provider-billing-types'
import type { ProviderBillingQueryCapabilityView } from '../../../../shared/provider-billing-query-types'
import type { ProviderView } from '../../../../shared/types'
import { formatUsageCost } from './provider-usage-cost-view'
import { useT } from '../../i18n'

type Props = {
  providerId: string
  providers: Array<Pick<ProviderView, 'id' | 'name'>>
  period: { from: number; to: number }
}

/** A provider switch starts a fresh editor and request state; late promises stay in the old scope. */
export default function ProviderBillingReconciliation(props: Props): React.JSX.Element {
  return <ProviderBillingScope key={props.providerId || 'all-providers'} {...props} />
}

function ProviderBillingScope({
  providerId,
  providers,
  period
}: Props): React.JSX.Element {
  const t = useT()
  const data = useBillingData(providerId, t)
  const editor = useBillingEditor({ providerId, period, data, t })
  const providerName = providers.find((provider) => provider.id === providerId)?.name ?? providerId

  return (
    <section className="provider-billing-reconciliation" data-provider-billing-reconciliation aria-label={t('providerBillingTitle')}>
      <BillingHeader providerId={providerId} providerName={providerName} period={period} data={data} editor={editor} />
      {editor.editing && providerId && <BillingForm editor={editor} loading={data.loading} />}
      {data.error && <div className="notice notice-error" role="alert">{data.error}</div>}
      {editor.notice && <div className="notice notice-success" role="status">{editor.notice}</div>}
      {providerId && data.capability && !data.capability.supported && !editor.editing && (
        <div className="field-hint">{t('providerBillingSyncNotConfigured')}</div>
      )}
      {providerId && !editor.editing && data.rows.length === 0 && !data.loading && (
        <div className="provider-billing-empty">{t('providerBillingEmpty')}</div>
      )}
      {data.rows.length > 0 && (
        <div className="provider-billing-list">
          {data.rows.map((row) => (
            <BillingReconciliationRow key={row.statement.id} row={row} disabled={data.loading} onRemove={editor.remove} />
          ))}
        </div>
      )}
    </section>
  )
}

type Translate = ReturnType<typeof useT>

function useBillingData(providerId: string, t: Translate) {
  const [rows, setRows] = useState<ProviderBillingReconciliationView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [capability, setCapability] = useState<ProviderBillingQueryCapabilityView | null>(null)
  const reload = useCallback(async (): Promise<void> => {
    if (!providerId) { setRows([]); return }
    setLoading(true); setError('')
    try {
      setRows(await window.agentDesk.reconcileProviderBilling(providerId))
    } catch {
      setError(t('providerBillingUnavailable'))
    } finally {
      setLoading(false)
    }
  }, [providerId, t])
  const inspectCapability = useCallback(async (): Promise<void> => {
    if (!providerId) { setCapability(null); return }
    try {
      setCapability(await window.agentDesk.inspectProviderBillingQuery(providerId))
    } catch {
      setCapability({ providerId, supported: false })
    }
  }, [providerId])
  useEffect(() => { void Promise.all([reload(), inspectCapability()]) }, [inspectCapability, reload])
  return { rows, loading, error, capability, setLoading, setError, reload }
}

type BillingData = ReturnType<typeof useBillingData>

function useBillingEditor({ providerId, period, data, t }: { providerId: string; period: { from: number; to: number }; data: BillingData; t: Translate }) {
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState('')
  const [periodStart, setPeriodStart] = useState(toLocalInput(period.from))
  const [periodEnd, setPeriodEnd] = useState(toLocalInput(Math.min(period.to, Date.now())))
  const [amount, setAmount] = useState('')
  const [source, setSource] = useState<ProviderBillingStatementSource>('provider-console')
  const numericAmount = Number(amount)
  const startTimestamp = new Date(periodStart).getTime()
  const endTimestamp = new Date(periodEnd).getTime()
  const valid = amount.trim() !== '' && Number.isFinite(numericAmount) && numericAmount >= 0 && numericAmount <= 1_000_000_000
    && Number.isFinite(startTimestamp) && Number.isFinite(endTimestamp) && endTimestamp > startTimestamp
  useEffect(() => {
    if (editing) return
    setPeriodStart(toLocalInput(period.from))
    setPeriodEnd(toLocalInput(Math.min(period.to, Date.now())))
  }, [editing, period.from, period.to])
  const prepare = (): void => { data.setLoading(true); data.setError(''); setNotice('') }
  const save = async (): Promise<void> => {
    if (!valid || data.loading) return
    prepare()
    try {
      await window.agentDesk.saveProviderBillingStatement({ providerId, periodStart: new Date(periodStart).getTime(), periodEnd: new Date(periodEnd).getTime(), billedCostUsd: Number(amount), source })
      setEditing(false); setAmount(''); await data.reload()
    } catch {
      data.setError(t('providerBillingSaveFailed'))
    } finally {
      data.setLoading(false)
    }
  }
  const remove = async (statementId: string): Promise<void> => {
    if (!window.confirm(t('providerBillingRemoveConfirm'))) return
    prepare()
    try {
      await window.agentDesk.removeProviderBillingStatement(providerId, statementId); await data.reload()
    } catch {
      data.setError(t('providerBillingRemoveFailed'))
    } finally {
      data.setLoading(false)
    }
  }
  const syncOfficialBill = async (): Promise<void> => {
    const syncEnd = Math.min(period.to, Date.now())
    if (!providerId || syncEnd <= period.from) return
    prepare()
    try {
      const result = await window.agentDesk.syncProviderBillingStatement({ providerId, periodStart: period.from, periodEnd: syncEnd })
      if (result.status === 'ready') { setNotice(t('providerBillingSyncReady')); await data.reload() }
      else if (result.status === 'expired') data.setError(t('providerBillingSyncExpired'))
      else data.setError(syncErrorMessage(result.errorCode, t))
    } catch {
      data.setError(t('providerBillingSyncUnavailable'))
    } finally {
      data.setLoading(false)
    }
  }
  return { editing, notice, periodStart, periodEnd, amount, source, valid, setEditing, setPeriodStart, setPeriodEnd, setAmount, setSource, save, remove, syncOfficialBill }
}

type BillingEditor = ReturnType<typeof useBillingEditor>

function BillingHeader({ providerId, providerName, period, data, editor }: { providerId: string; providerName: string; period: { from: number; to: number }; data: BillingData; editor: BillingEditor }): React.JSX.Element {
  const t = useT()
  return <div className="provider-billing-head">
    <div><h4>{t('providerBillingTitle')}</h4><p>{providerId ? providerName : t('providerBillingSelectProvider')}</p></div>
    <div className="provider-billing-actions">
      {data.capability?.supported && <button type="button" className="btn btn-secondary btn-sm provider-billing-sync" disabled={!providerId || data.loading || Math.min(period.to, Date.now()) <= period.from} onClick={() => void editor.syncOfficialBill()}><RefreshCw size={14} aria-hidden="true" className={data.loading ? 'provider-usage-spin' : ''} />{data.loading ? t('providerBillingSyncing') : t('providerBillingSync')}</button>}
      <button type="button" className="btn btn-ghost btn-icon-sm" aria-label={t('providerBillingRefresh')} title={t('providerBillingRefresh')} disabled={!providerId || data.loading} onClick={() => void data.reload()}><RefreshCw size={14} aria-hidden="true" className={data.loading ? 'provider-usage-spin' : ''} /></button>
      <button type="button" className="btn btn-ghost btn-icon-sm" aria-label={t('providerBillingAdd')} title={t('providerBillingAdd')} disabled={!providerId || data.loading} onClick={() => editor.setEditing((value) => !value)}><Plus size={14} aria-hidden="true" /></button>
    </div>
  </div>
}

function BillingForm({ editor, loading }: { editor: BillingEditor; loading: boolean }): React.JSX.Element {
  const t = useT()
  return <div className="provider-billing-form">
    <label><span>{t('providerBillingPeriodStart')}</span><input className="input" type="datetime-local" value={editor.periodStart} onChange={(event) => editor.setPeriodStart(event.target.value)} /></label>
    <label><span>{t('providerBillingPeriodEnd')}</span><input className="input" type="datetime-local" value={editor.periodEnd} onChange={(event) => editor.setPeriodEnd(event.target.value)} /></label>
    <label><span>{t('providerBillingAmount')}</span><input className="input" type="number" min="0" max="1000000000" step="0.000001" value={editor.amount} onChange={(event) => editor.setAmount(event.target.value)} /></label>
    <label><span>{t('providerBillingSource')}</span><select className="select" value={editor.source} onChange={(event) => editor.setSource(event.target.value as ProviderBillingStatementSource)}>{(['provider-api', 'provider-console', 'invoice', 'balance-export', 'other'] as const).map((value) => <option key={value} value={value} disabled={value === 'provider-api'}>{t(`providerBillingSource_${value}`)}</option>)}</select></label>
    <div className="provider-billing-form-actions">
      <button type="button" className="btn btn-ghost btn-sm" disabled={loading} onClick={() => editor.setEditing(false)}>{t('cancel')}</button>
      <button type="button" className="btn btn-primary btn-sm" disabled={loading || !editor.valid} onClick={() => void editor.save()}>{t('save')}</button>
    </div>
  </div>
}

function BillingReconciliationRow({
  row,
  disabled,
  onRemove
}: {
  row: ProviderBillingReconciliationView
  disabled: boolean
  onRemove: (statementId: string) => Promise<void>
}): React.JSX.Element {
  const t = useT()
  const StatusIcon = row.status === 'matched' ? CheckCircle2 : TriangleAlert
  return (
    <article className={`provider-billing-row is-${row.status}`} data-provider-billing-status={row.status}>
      <div className="provider-billing-row-status">
        <StatusIcon size={15} aria-hidden="true" />
        <strong>{t(`providerBillingStatus_${row.status}`)}</strong>
        <span>{t(`providerBillingSource_${row.statement.source}`)}</span>
      </div>
      <div className="provider-billing-period">
        {formatDateTime(row.statement.periodStart)} - {formatDateTime(row.statement.periodEnd)}
      </div>
      <div className="provider-billing-values">
        <BillingValue label={t('providerBillingOfficial')} value={formatUsageCost(row.statement.billedCostUsd)} />
        <BillingValue label={t('providerBillingLocal')} value={formatUsageCost(row.localCostUsd)} />
        <BillingValue label={t('providerBillingDifference')} value={signedCost(row.differenceUsd)} />
        <BillingValue label={t('providerBillingRequests')} value={String(row.localRequests)} />
      </div>
      {row.incompleteReasons.length > 0 && (
        <div className="provider-billing-reasons">
          {row.incompleteReasons.map((reason) => <span key={reason}>{t(`providerBillingReason_${reason}`)}</span>)}
        </div>
      )}
      <button
        type="button"
        className="icon-btn provider-billing-remove"
        aria-label={t('providerBillingRemove')}
        title={t('providerBillingRemove')}
        disabled={disabled}
        onClick={() => void onRemove(row.statement.id)}
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </article>
  )
}

function BillingValue({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

function toLocalInput(value: number): string {
  const date = new Date(value)
  return new Date(value - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function formatDateTime(value: number): string {
  return new Date(value).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
}

function signedCost(value: number): string {
  if (value === 0) return formatUsageCost(0)
  return `${value > 0 ? '+' : '-'}${formatUsageCost(Math.abs(value))}`
}

function syncErrorMessage(errorCode: string | undefined, t: ReturnType<typeof useT>): string {
  if (errorCode === 'billing_query_not_configured') return t('providerBillingSyncNotConfigured')
  if (errorCode === 'authorization_expired' || errorCode === 'credential_unavailable'
    || errorCode === 'billing_key_not_found') return t('providerBillingSyncExpired')
  if (errorCode === 'invalid_response') return t('providerBillingSyncInvalidResponse')
  if (errorCode === 'billing_endpoint_untrusted' || errorCode === 'cross_origin_response_blocked'
    || errorCode === 'redirect_blocked') return t('providerBillingSyncBlocked')
  if (errorCode === 'response_too_large' || errorCode === 'invalid_json') {
    return t('providerBillingSyncInvalidPayload')
  }
  return t('providerBillingSyncUnavailable')
}
