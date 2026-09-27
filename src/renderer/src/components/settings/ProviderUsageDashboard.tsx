import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, RefreshCw } from 'lucide-react'
import type {
  ProviderUsageAggregate,
  ProviderUsageBucket,
  ProviderUsageCostSourceSummary,
  ProviderUsageRequest,
  ProviderUsageSummary
} from '../../../../shared/provider-usage-types'
import type { ProviderView } from '../../../../shared/types'
import { formatDuration, formatTokens } from '../../format'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import ProviderBillingReconciliation from './ProviderBillingReconciliation'
import { DisclosureChevron } from '../DisclosureChevron'
import { formatUsageCost, usageCostAmount, usageCostDetail } from './provider-usage-cost-view'

type UsageRange = 'today' | '24h' | '7d' | '30d'
type UsageView = 'requests' | 'providers' | 'models' | 'credentials'
type RefreshInterval = 0 | 5_000 | 10_000 | 30_000 | 60_000
const REQUEST_PAGE_SIZE = 25
const DEFAULT_REFRESH_INTERVAL: RefreshInterval = 30_000

const RANGE_MS: Record<UsageRange, number> = {
  today: 24 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
}

export default function ProviderUsageDashboard({
  providers
}: {
  providers: Array<Pick<ProviderView, 'id' | 'name'>>
}): React.JSX.Element {
  const t = useT()
  const language = useStore((state) => state.settings.language)
  const [range, setRange] = useState<UsageRange>('today')
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [source, setSource] = useState('')
  const [keyLabel, setKeyLabel] = useState('')
  const [refreshInterval, setRefreshInterval] = useState<RefreshInterval>(DEFAULT_REFRESH_INTERVAL)
  const [view, setView] = useState<UsageView>('requests')
  const [requestPage, setRequestPage] = useState(0)
  const [usageSnapshot, setUsage] = useState<ProviderUsageSummary | null>(null)
  const [loadedQueryKey, setLoadedQueryKey] = useState('')
  const [scopeUsage, setScopeUsage] = useState<ProviderUsageSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(false)
  const [failed, setFailed] = useState(false)
  const requestId = useRef(0)
  const queryKey = JSON.stringify([range, providerId, model, source, keyLabel, requestPage])
  const usage = loadedQueryKey === queryKey ? usageSnapshot : null

  const reload = useCallback(async (): Promise<void> => {
    const currentRequest = requestId.current + 1
    requestId.current = currentRequest
    setLoading(true)
    setFailed(false)
    const to = Date.now()
    const baseQuery = {
      from: usageRangeStart(range, to),
      to,
      providerId: providerId || undefined,
      bucketCount: 24
    }
    try {
      const [nextUsage, nextScope] = await Promise.all([
        window.agentDesk.queryProviderUsage({
          ...baseQuery,
          model: model || undefined,
          source: source || undefined,
          keyLabel: keyLabel || undefined,
          limit: REQUEST_PAGE_SIZE,
          offset: requestPage * REQUEST_PAGE_SIZE
        }),
        window.agentDesk.queryProviderUsage({ ...baseQuery, limit: 1, offset: 0 })
      ])
      if (requestId.current !== currentRequest) return
      setUsage(nextUsage)
      setScopeUsage(nextScope)
      setLoadedQueryKey(queryKey)
    } catch {
      if (requestId.current === currentRequest) setFailed(true)
    } finally {
      if (requestId.current === currentRequest) setLoading(false)
    }
  }, [keyLabel, model, providerId, range, requestPage, source, queryKey])

  useEffect(() => {
    void reload()
    return () => {
      requestId.current += 1
    }
  }, [reload])

  useEffect(() => {
    if (refreshInterval === 0) return
    const timer = window.setInterval(() => void reload(), refreshInterval)
    return () => window.clearInterval(timer)
  }, [refreshInterval, reload])

  const providerNames = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider.name])),
    [providers]
  )
  const modelOptions = scopeUsage?.requestsByModel ?? []
  const sourceOptions = scopeUsage?.sources ?? []
  const credentialOptions = (scopeUsage?.requestsByCredential ?? []).filter((item) => item.keyLabel)
  const terminalRequests = (usage?.succeeded ?? 0) + (usage?.failed ?? 0)
  const priceEligibleRequests = (usage?.pricedRequests ?? 0) + (usage?.unpricedRequests ?? 0)
  const trend = useMemo(() => usage?.buckets?.map(toTrendPoint) ?? buildUsageTrend(usage?.recentRequests ?? [], usage?.from ?? 0, usage?.to ?? Date.now()), [usage])

  const exportUsage = useCallback(async (): Promise<void> => {
    setExporting(true)
    setExportError(false)
    try {
      const to = Date.now()
      const exported = await window.agentDesk.queryProviderUsage({
        from: usageRangeStart(range, to),
        to,
        providerId: providerId || undefined,
        model: model || undefined,
        source: source || undefined,
        keyLabel: keyLabel || undefined,
        limit: 10_000,
        offset: 0,
        bucketCount: 24
      })
      const header = ['time', 'provider_id', 'provider', 'model', 'credential_id', 'credential_name', 'source', 'status', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'latency_ms', 'cost_usd', 'price_source']
      const rows = exported.recentRequests.map((request) => [
        new Date(request.startedAt).toISOString(),
        request.providerId,
        providerNames.get(request.providerId) ?? request.providerId,
        request.model,
        request.keyLabel ?? '',
        request.credentialName ?? '',
        request.source ?? '',
        request.status,
        request.usage?.inputTokens ?? '',
        request.usage?.outputTokens ?? '',
        request.usage?.cacheReadTokens ?? '',
        request.usage?.cacheWriteTokens ?? '',
        request.latencyMs ?? '',
        request.costUsd ?? '',
        request.costSource
      ])
      const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
      const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `eastgenesis-usage-${range}.csv`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch {
      setExportError(true)
    } finally {
      setExporting(false)
    }
  }, [keyLabel, model, providerId, providerNames, range, source])

  return (
    <section className="settings-section provider-usage-dashboard" aria-label={t('providerUsageTitle')} data-provider-usage-dashboard>
      <UsageDashboardToolbar
        range={range}
        refreshInterval={refreshInterval}
        loading={loading}
        exporting={exporting}
        onRangeChange={(option) => { setRange(option); setModel(''); setSource(''); setKeyLabel(''); setRequestPage(0) }}
        onRefreshIntervalChange={setRefreshInterval}
        onRefresh={reload}
        onExport={exportUsage}
      />

      <ProviderUsageFilters
        providers={providers}
        modelOptions={modelOptions}
        sourceOptions={sourceOptions}
        credentialOptions={credentialOptions}
        values={{ providerId, model, source, keyLabel }}
        usage={usage}
        loading={loading}
        language={language}
        onProviderChange={(value) => { setProviderId(value); setModel(''); setSource(''); setKeyLabel(''); setRequestPage(0) }}
        onModelChange={(value) => { setModel(value); setRequestPage(0) }}
        onSourceChange={(value) => { setSource(value); setRequestPage(0) }}
        onCredentialChange={(value) => { setKeyLabel(value); setRequestPage(0) }}
      />

      {failed && <div className="notice notice-error" role="alert">{t('providerUsageUnavailable')}</div>}
      {exportError && <div className="notice notice-error" role="alert">{language === 'zh' ? '导出失败，请重试。' : 'Export failed. Please try again.'}</div>}
      {!failed && usage && (
        <>
          <div className="provider-usage-hero">
            <div className="provider-usage-total">
              <span>{t('providerUsageTotalTokens')}</span>
              <strong>{formatTokens(totalTokens(usage))}</strong>
            </div>
            <div className="provider-usage-hero-summary">
              <UsageMetric value={String(usage.requests)} label={t('providerUsageRequests')} />
              <UsageMetric value={usageCostAmount(usage, language)} label={language === 'zh' ? '已计价费用 USD（含估算）' : 'Priced cost USD (includes estimates)'} />
            </div>
          </div>
          <p className="settings-hint" data-provider-usage-cost-summary>{[
            usageCostDetail(usage, language),
            language === 'zh' ? '统计仅覆盖 EastGenesis 记录到的调用，实际账单以厂商为准。' : 'Covers calls recorded by EastGenesis; the provider invoice is authoritative.'
          ].filter(Boolean).join(language === 'zh' ? '；' : '; ')}</p>

          <div className="provider-usage-token-strip" aria-label={t('providerUsageTokenBreakdown')}>
            <TokenMetric label={t('providerUsageInputTokens')} value={usage.inputTokens} />
            <TokenMetric label={t('providerUsageOutputTokens')} value={usage.outputTokens} />
            <TokenMetric label={t('providerUsageCacheWriteTokens')} value={usage.cacheWriteTokens} />
            <TokenMetric label={t('providerUsageCacheReadTokens')} value={usage.cacheReadTokens} />
            <UsageMetric value={formatPercent(usage.cacheReadTokens, usage.inputTokens + usage.cacheReadTokens)} label={t('providerUsageCacheHitRate')} />
          </div>

          <div className="provider-usage-kpis">
            <UsageMetric value={formatPercent(usage.succeeded, terminalRequests)} label={t('providerUsageSuccessRate')} />
            <UsageMetric value={formatLatency(usage.averageLatencyMs)} label={t('providerUsageAverageLatency')} />
            <UsageMetric value={formatPercent(usage.pricedRequests, priceEligibleRequests)} label={t('providerUsagePricingCoverage')} />
          </div>

          <ProviderCostProvenance sources={usage.costSources} />

          {usage.truncated && (
            <div className="provider-usage-cost-warning" role="status" data-provider-usage-truncated>
              {t('providerUsageTruncatedWarning')}
            </div>
          )}

          <ProviderBillingReconciliation
            providerId={providerId}
            providers={providers}
            period={{ from: usage.from, to: usage.to }}
          />

          {usage.requests > 0 && (
            <UsageTrend points={trend} language={language} />
          )}

          {usage.requests === 0 ? (
            <div className="provider-usage-empty">{t('providerUsageEmpty')}</div>
          ) : (
            <>
              <div className="provider-usage-views" role="tablist" aria-label={t('providerUsageViews')}>
                {([
                  ['requests', t('providerUsageViewRequests')],
                  ['providers', t('providerUsageViewProviders')],
                  ['models', t('providerUsageViewModels')],
                  ['credentials', t('providerUsageViewCredentials')]
                ] as Array<[UsageView, string]>).map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    role="tab"
                    aria-selected={view === value}
                    data-provider-usage-view={value}
                    className={view === value ? 'active' : ''}
                    onClick={() => setView(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {view === 'requests' && (
                <RequestTable
                  requests={usage.recentRequests}
                  providerNames={providerNames}
                  language={language}
                  offset={usage.recentOffset}
                  total={usage.recentTotal}
                  hasMore={usage.recentHasMore}
                  onPrevious={() => setRequestPage((page) => Math.max(0, page - 1))}
                  onNext={() => setRequestPage((page) => page + 1)}
                />
              )}
              {view === 'providers' && <UsageAggregateTable title={t('providerUsageByProvider')} rows={usage.requestsByProvider} />}
              {view === 'models' && <UsageAggregateTable title={language === 'zh' ? '厂商 × 模型统计' : 'Provider × model statistics'} rows={usage.requestsByProviderModel ?? []} />}
              {view === 'credentials' && <UsageAggregateTable title={t('providerUsageByCredential')} rows={usage.requestsByCredential} />}
            </>
          )}
        </>
      )}
    </section>
  )
}

function UsageDashboardToolbar({ range, refreshInterval, loading, exporting, onRangeChange, onRefreshIntervalChange, onRefresh, onExport }: {
  range: UsageRange
  refreshInterval: RefreshInterval
  loading: boolean
  exporting: boolean
  onRangeChange: (range: UsageRange) => void
  onRefreshIntervalChange: (interval: RefreshInterval) => void
  onRefresh: () => Promise<void>
  onExport: () => Promise<void>
}): React.JSX.Element {
  const t = useT()
  return <div className="provider-usage-toolbar">
    <div><h3 className="settings-h3">{t('providerUsageTitle')}</h3><p className="settings-hint">{t('providerUsageHint')}</p></div>
    <div className="provider-usage-toolbar-actions">
      <div className="provider-usage-range" role="group" aria-label={t('providerUsageRange')}>
        {(['today', '24h', '7d', '30d'] as UsageRange[]).map((option) => <button type="button" key={option} className={range === option ? 'active' : ''} aria-pressed={range === option} onClick={() => onRangeChange(option)}>{t(`providerUsageRange_${option}`)}</button>)}
      </div>
      <label className="provider-usage-refresh-interval">
        <span>{t('providerUsageAutoRefresh')}</span>
        <select className="select" aria-label={t('providerUsageAutoRefresh')} value={refreshInterval} onChange={(event) => onRefreshIntervalChange(Number(event.target.value) as RefreshInterval)}>
          <option value={0}>{t('providerUsageAutoRefreshOff')}</option>
          <option value={5_000}>{t('providerUsageAutoRefreshSeconds', { n: 5 })}</option>
          <option value={10_000}>{t('providerUsageAutoRefreshSeconds', { n: 10 })}</option>
          <option value={30_000}>{t('providerUsageAutoRefreshSeconds', { n: 30 })}</option>
          <option value={60_000}>{t('providerUsageAutoRefreshSeconds', { n: 60 })}</option>
        </select>
      </label>
      <button type="button" className="btn btn-ghost btn-icon-sm" aria-label={t('providerUsageRefresh')} title={t('providerUsageRefresh')} disabled={loading} onClick={() => void onRefresh()}><RefreshCw size={14} aria-hidden="true" className={loading ? 'provider-usage-spin' : ''} /></button>
      <button type="button" className="btn btn-ghost btn-icon-sm" aria-label={t('providerUsageExport')} title={t('providerUsageExport')} disabled={exporting || loading} onClick={() => void onExport()}><Download size={14} aria-hidden="true" /></button>
    </div>
  </div>
}

function ProviderCostProvenance({ sources }: { sources: ProviderUsageCostSourceSummary[] }): React.JSX.Element {
  const t = useT()
  const unpriced = sources.find((item) => item.source === 'unpriced')
  return (
    <section className="provider-usage-cost-provenance" aria-label={t('providerUsageCostProvenanceTitle')} data-provider-usage-cost-provenance>
      <div className="provider-usage-cost-provenance-head">
        <div>
          <h4>{t('providerUsageCostProvenanceTitle')}</h4>
          <p>{t('providerUsageCostProvenanceHint')}</p>
        </div>
        <span>{t('providerUsageCostProvenanceSources', { n: sources.length })}</span>
      </div>
      <div className="provider-usage-cost-source-grid">
        {sources.map((item) => (
          <div className={`provider-usage-cost-source is-${item.source}`} key={item.source}>
            <span>{t(`providerUsageCostSource_${item.source}`)}</span>
            <strong>{item.source === 'unpriced' ? '-' : formatUsageCost(item.costUsd)}</strong>
            <small>{t('providerUsageCostSourceRequests', { n: item.requests })}</small>
            <p>{t(`providerUsageCostSourceDescription_${item.source}`)}</p>
          </div>
        ))}
      </div>
      {unpriced && unpriced.requests > 0 && (
        <div className="provider-usage-cost-warning" role="status">
          {t('providerUsageCostUnpricedWarning', { n: unpriced.requests })}
        </div>
      )}
    </section>
  )
}

function ProviderUsageFilters({
  providers,
  modelOptions,
  sourceOptions,
  credentialOptions,
  values,
  usage,
  loading,
  language,
  onProviderChange,
  onModelChange,
  onSourceChange,
  onCredentialChange
}: {
  providers: Array<Pick<ProviderView, 'id' | 'name'>>
  modelOptions: ProviderUsageAggregate[]
  sourceOptions: string[]
  credentialOptions: ProviderUsageSummary['requestsByCredential']
  values: { providerId: string; model: string; source: string; keyLabel: string }
  usage: ProviderUsageSummary | null
  loading: boolean
  language: 'zh' | 'en'
  onProviderChange: (value: string) => void
  onModelChange: (value: string) => void
  onSourceChange: (value: string) => void
  onCredentialChange: (value: string) => void
}): React.JSX.Element {
  const t = useT()
  return <div className="provider-usage-filters" aria-label={t('providerUsageFilters')}>
    <UsageFilter label={t('providerUsageProviderFilter')} value={values.providerId} allLabel={t('providerUsageAllProviders')} options={providers.map((item) => ({ id: item.id, label: item.name }))} onChange={onProviderChange} />
    <UsageFilter label={t('providerUsageModelFilter')} value={values.model} allLabel={t('providerUsageAllModels')} options={modelOptions} onChange={onModelChange} />
    <UsageFilter label={t('providerUsageSource')} value={values.source} allLabel={t('providerUsageAllSources')} options={sourceOptions.map((item) => ({ id: item, label: item }))} onChange={onSourceChange} />
    <UsageFilter label={t('providerUsageCredential')} value={values.keyLabel} allLabel={t('providerUsageAllCredentials')} options={credentialOptions.flatMap((item) => item.keyLabel ? [{ id: item.keyLabel, label: item.label }] : [])} onChange={onCredentialChange} />
    <span className="provider-usage-updated" aria-live="polite">
      {loading ? t('providerUsageLoading') : usage ? t('providerUsageRangeSummary', {
        from: formatUsageDate(usage.from, language),
        to: formatUsageDate(usage.to, language)
      }) : ''}
    </span>
  </div>
}

function UsageFilter({ label, value, allLabel, options, onChange }: {
  label: string
  value: string
  allLabel: string
  options: Array<{ id: string; label: string }>
  onChange: (value: string) => void
}): React.JSX.Element {
  return <label>
    <span>{label}</span>
    <select className="select" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{allLabel}</option>
      {options.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select>
  </label>
}

interface UsageTrendPoint {
  at: number
  requests: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

function UsageTrend({ points, language }: { points: UsageTrendPoint[]; language: 'zh' | 'en' }): React.JSX.Element {
  const t = useT()
  const maxCost = Math.max(...points.map((point) => point.costUsd), 0)
  const maxTokens = Math.max(...points.flatMap((point) => [point.inputTokens, point.outputTokens, point.cacheReadTokens, point.cacheWriteTokens]), 0)
  const axisIndexes = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])
  const scaleSteps = [1, 0.75, 0.5, 0.25, 0]
  return (
    <section className="provider-usage-trend" aria-label={t('providerUsageTrendTitle')} data-provider-usage-trend>
      <div className="provider-usage-trend-head">
        <div>
          <h4>{t('providerUsageTrendTitle')}</h4>
          <p>{t('providerUsageTrendHint')}</p>
        </div>
        <span>{t('providerUsageTrendSample')}</span>
      </div>
      <div className="provider-usage-trend-plot">
        <div className="provider-usage-trend-y-axis is-token" aria-hidden="true">
          {scaleSteps.map((scale) => <span key={scale}>{formatTokens(maxTokens * scale)}</span>)}
        </div>
        <div className="provider-usage-trend-chart" role="img" aria-label={t('providerUsageTrendAria')}>
          <svg viewBox="0 0 1000 160" preserveAspectRatio="none" aria-hidden="true">
            {[20, 55, 90, 125, 160].map((y) => <line className="provider-usage-trend-gridline" x1="0" x2="1000" y1={y} y2={y} key={y} />)}
            <polyline className="provider-usage-series is-cost" points={trendPolyline(points, (point) => point.costUsd, maxCost)} />
            <polyline className="provider-usage-series is-cache-write" points={trendPolyline(points, (point) => point.cacheWriteTokens, maxTokens)} />
            <polyline className="provider-usage-series is-cache-read" points={trendPolyline(points, (point) => point.cacheReadTokens, maxTokens)} />
            <polyline className="provider-usage-series is-input" points={trendPolyline(points, (point) => point.inputTokens, maxTokens)} />
            <polyline className="provider-usage-series is-output" points={trendPolyline(points, (point) => point.outputTokens, maxTokens)} />
          </svg>
          <div className="provider-usage-trend-hit-grid" aria-hidden="true">
            {points.map((point) => <span key={point.at} title={trendPointTitle(point, language, t)} />)}
          </div>
        </div>
        <div className="provider-usage-trend-y-axis is-cost" aria-hidden="true">
          {scaleSteps.map((scale) => <span key={scale}>{formatUsageCost(maxCost * scale)}</span>)}
        </div>
      </div>
      <div className="provider-usage-trend-axis-row">
        <span />
        <div className="provider-usage-trend-axis">
          {points.map((point, index) => <span key={point.at}>{axisIndexes.has(index) ? formatTrendLabel(point.at, language) : ''}</span>)}
        </div>
        <span />
      </div>
      <div className="provider-usage-trend-legend">
        <span><i className="provider-usage-legend-swatch is-cost" />{t('providerUsageCost')}</span>
        <span><i className="provider-usage-legend-swatch is-cache-write" />{t('providerUsageCacheWriteTokens')}</span>
        <span><i className="provider-usage-legend-swatch is-cache-read" />{t('providerUsageCacheReadTokens')}</span>
        <span><i className="provider-usage-legend-swatch is-input" />{t('providerUsageInputTokens')}</span>
        <span><i className="provider-usage-legend-swatch is-output" />{t('providerUsageOutputTokens')}</span>
      </div>
    </section>
  )
}

function UsageMetric({ value, label }: { value: string; label: string }): React.JSX.Element {
  return <div><strong>{value}</strong><span>{label}</span></div>
}

function TokenMetric({ value, label }: { value: number; label: string }): React.JSX.Element {
  return <div><span>{label}</span><strong>{formatTokens(value)}</strong></div>
}

function UsageAggregateTable({ title, rows }: { title: string; rows: ProviderUsageAggregate[] }): React.JSX.Element {
  const t = useT()
  const language = useStore((state) => state.settings.language)
  const [page, setPage] = useState(0)
  const pageSize = 20
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1))
  const offset = currentPage * pageSize
  const shown = rows.slice(offset, offset + pageSize)
  useEffect(() => { setPage(0) }, [title])
  return (
    <div className="provider-usage-aggregate">
      <div className="field-label">{title}</div>
      <div className="provider-usage-table-wrap">
        <table className="provider-usage-table provider-usage-aggregate-table">
          <thead><tr><th>{t('providerUsageName')}</th><th>{t('providerUsageRequests')}</th><th>{t('providerUsageSuccessRate')}</th><th>{t('providerUsageInputTokens')}</th><th>{t('providerUsageOutputTokens')}</th><th>{t('providerUsageCacheReadTokens')}</th><th>{t('providerUsageCost')}</th></tr></thead>
          <tbody>
            {shown.map((item) => (
              <tr key={item.id} data-provider-usage-aggregate-row={item.id}>
                <td title={`${item.label} · ${item.id}`}>{item.label}</td>
                <td>{item.requests}</td>
                <td>{formatPercent(item.succeeded, item.succeeded + item.failed)}</td>
                <td>{formatTokens(item.inputTokens)}</td>
                <td>{formatTokens(item.outputTokens)}</td>
                <td>{formatTokens(item.cacheReadTokens)}</td>
                <td><span>{usageCostAmount(item, language)}</span><small className="provider-usage-cost-detail">{usageCostDetail(item, language)}</small></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="provider-usage-pagination" aria-label={t('providerUsagePagination')}>
        <button type="button" className="btn btn-ghost btn-icon-sm" aria-label={t('providerUsagePreviousPage')} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={14} aria-hidden="true" /></button>
        <span>{t('providerUsageRecentRange', { from: rows.length ? offset + 1 : 0, to: offset + shown.length, total: rows.length })}</span>
        <button type="button" className="btn btn-ghost btn-icon-sm" aria-label={t('providerUsageNextPage')} disabled={offset + shown.length >= rows.length} onClick={() => setPage(currentPage + 1)}><ChevronRight size={14} aria-hidden="true" /></button>
      </div>
    </div>
  )
}

function RequestTable({
  requests,
  providerNames,
  language,
  offset,
  total,
  hasMore,
  onPrevious,
  onNext
}: {
  requests: ProviderUsageRequest[]
  providerNames: Map<string, string>
  language: 'zh' | 'en'
  offset: number
  total: number
  hasMore: boolean
  onPrevious: () => void
  onNext: () => void
}): React.JSX.Element {
  const t = useT()
  const [expandedAttemptId, setExpandedAttemptId] = useState<string | null>(null)
  return (
    <div className="provider-usage-requests">
      <div className="provider-usage-table-head">
        <div className="field-label">{t('providerUsageRecentRequests')}</div>
        <span>{t('providerUsageRecentRange', { from: total === 0 ? 0 : offset + 1, to: offset + requests.length, total })}</span>
      </div>
      <div className="provider-usage-table-wrap">
        <table className="provider-usage-table provider-usage-request-table">
          <thead>
            <tr>
              <th>{t('providerUsageTime')}</th><th>{t('providerUsageProviderFilter')}</th><th>{t('providerUsageModelFilter')}</th>
              <th>{t('providerUsageInputTokens')}</th><th>{t('providerUsageOutputTokens')}</th><th>{t('providerUsageCacheReadTokens')}</th>
              <th>{t('providerUsageCost')}</th><th>{t('providerUsageLatency')}</th><th>{t('providerUsageStatus')}</th><th>{t('providerUsageSource')}</th><th>{t('providerUsagePriceSource')}</th><th>{t('providerUsageCredential')}</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => <RequestRows
              key={request.attemptId}
              request={request}
              providerName={providerNames.get(request.providerId) ?? request.providerId}
              language={language}
              expanded={expandedAttemptId === request.attemptId}
              onToggle={() => setExpandedAttemptId(expandedAttemptId === request.attemptId ? null : request.attemptId)}
            />)}
          </tbody>
        </table>
      </div>
      <div className="provider-usage-pagination" aria-label={t('providerUsagePagination')}>
        <button type="button" className="btn btn-ghost btn-icon-sm" aria-label={t('providerUsagePreviousPage')} title={t('providerUsagePreviousPage')} disabled={offset === 0} onClick={onPrevious}>
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <span>{t('providerUsageRecentRange', { from: total === 0 ? 0 : offset + 1, to: offset + requests.length, total })}</span>
        <button type="button" className="btn btn-ghost btn-icon-sm" aria-label={t('providerUsageNextPage')} title={t('providerUsageNextPage')} disabled={!hasMore} onClick={onNext}>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

function RequestRows({ request, providerName, language, expanded, onToggle }: {
  request: ProviderUsageRequest
  providerName: string
  language: 'zh' | 'en'
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  return <Fragment>
    <RequestSummaryRow request={request} providerName={providerName} language={language} expanded={expanded} onToggle={onToggle} />
    {expanded && <RequestDetailRow request={request} />}
  </Fragment>
}

function RequestSummaryRow({ request, providerName, language, expanded, onToggle }: {
  request: ProviderUsageRequest
  providerName: string
  language: 'zh' | 'en'
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const t = useT()
  return <tr className={expanded ? 'is-expanded' : ''}>
    <td><button type="button" className="provider-usage-row-toggle" aria-expanded={expanded} aria-label={expanded ? t('providerUsageCollapseRequest') : t('providerUsageExpandRequest')} onClick={onToggle}><DisclosureChevron expanded={expanded} size={13} />{formatUsageTime(request.startedAt, language)}</button></td>
    <td title={providerName}>{providerName}</td>
    <td title={request.model}>{request.model}</td>
    <td>{request.usage ? formatTokens(request.usage.inputTokens) : '-'}</td>
    <td>{request.usage ? formatTokens(request.usage.outputTokens) : '-'}</td>
    <td>{request.usage ? formatTokens(request.usage.cacheReadTokens ?? 0) : '-'}</td>
    <td>{request.costUsd === undefined ? (language === 'zh' ? '未知' : 'Unknown') : formatUsageCost(request.costUsd)}</td>
    <td>{formatLatency(request.latencyMs)}</td>
    <td><span className={`provider-usage-status provider-usage-status-${request.status}`}>{t(`providerUsageStatus_${request.status}`)}</span></td>
    <td title={request.source}>{request.source ?? '-'}</td>
    <td>{t(`providerUsageCostSource_${request.costSource}`)}</td>
    <td title={request.keyLabel}>{request.credentialName ?? formatCredentialIdentity(request.keyLabel, t('providerUsageNoCredential'))}</td>
  </tr>
}

function RequestDetailRow({ request }: { request: ProviderUsageRequest }): React.JSX.Element {
  const t = useT()
  return <tr className="provider-usage-detail-row"><td colSpan={12}><div className="provider-usage-request-detail">
    <DetailMetric label={t('providerUsageInputTokens')} value={formatTokens(request.usage?.inputTokens ?? 0)} />
    <DetailMetric label={t('providerUsageOutputTokens')} value={formatTokens(request.usage?.outputTokens ?? 0)} />
    <DetailMetric label={t('providerUsageCacheReadTokens')} value={formatTokens(request.usage?.cacheReadTokens ?? 0)} />
    <DetailMetric label={t('providerUsageCacheWriteTokens')} value={formatTokens(request.usage?.cacheWriteTokens ?? 0)} />
    <DetailMetric label={t('providerUsageOutcome')} value={request.outcome ? t(`providerUsageOutcome_${request.outcome}`) : '-'} />
    <DetailMetric label={t('providerUsagePriceSource')} value={t(`providerUsageCostSource_${request.costSource}`)} />
    <DetailMetric label={t('providerUsageSource')} value={request.source ?? '-'} />
    <DetailMetric label={t('providerUsageCredentialId')} value={request.keyLabel ?? t('providerUsageNoCredential')} />
  </div></td></tr>
}

function DetailMetric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div><span>{label}</span><strong title={value}>{value}</strong></div>
}

function formatPercent(value: number, total: number): string {
  if (total <= 0) return '-'
  return `${Math.round((value / total) * 100)}%`
}

function formatLatency(value: number | undefined): string {
  if (value === undefined) return '-'
  if (value === 0) return '0ms'
  return formatDuration(value)
}

function formatCredentialIdentity(keyLabel: string | undefined, emptyLabel: string): string {
  if (!keyLabel) return emptyLabel
  if (keyLabel.startsWith('label:')) return keyLabel.slice('label:'.length)
  if (keyLabel.startsWith('sha256:')) return `SHA-256 ${keyLabel.slice(7, 15)}...${keyLabel.slice(-4)}`
  return emptyLabel
}

function formatUsageDate(timestamp: number, language: 'zh' | 'en'): string {
  return new Date(timestamp).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' })
}

function formatUsageTime(timestamp: number, language: 'zh' | 'en'): string {
  return new Date(timestamp).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function formatTrendLabel(timestamp: number, language: 'zh' | 'en'): string {
  return new Date(timestamp).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit', minute: '2-digit'
  })
}

function toTrendPoint(bucket: ProviderUsageBucket): UsageTrendPoint {
  return {
    at: Math.round((bucket.from + bucket.to) / 2),
    requests: bucket.requests,
    costUsd: bucket.costUsd,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    cacheWriteTokens: bucket.cacheWriteTokens
  }
}

function buildUsageTrend(requests: ProviderUsageRequest[], from: number, to: number): UsageTrendPoint[] {
  const bucketCount = 12
  const span = Math.max(1, to - from)
  const bucketSize = span / bucketCount
  const points = Array.from({ length: bucketCount }, (_, index) => ({
    at: Math.round(from + index * bucketSize),
    requests: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  }))
  for (const request of requests) {
    const index = Math.max(0, Math.min(bucketCount - 1, Math.floor((request.startedAt - from) / bucketSize)))
    const point = points[index]
    point.requests += 1
    point.costUsd += request.costUsd ?? 0
    point.inputTokens += request.usage?.inputTokens ?? 0
    point.outputTokens += request.usage?.outputTokens ?? 0
    point.cacheReadTokens += request.usage?.cacheReadTokens ?? 0
    point.cacheWriteTokens += request.usage?.cacheWriteTokens ?? 0
  }
  return points
}

function totalTokens(usage: Pick<ProviderUsageSummary, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

function usageRangeStart(range: UsageRange, to: number): number {
  if (range !== 'today') return to - RANGE_MS[range]
  const start = new Date(to)
  start.setHours(0, 0, 0, 0)
  return start.getTime()
}

function trendPolyline(points: UsageTrendPoint[], select: (point: UsageTrendPoint) => number, maximum: number): string {
  if (points.length === 0) return ''
  return points.map((point, index) => {
    const x = points.length === 1 ? 500 : (index / (points.length - 1)) * 1000
    const value = select(point)
    const y = maximum > 0 ? 156 - (value / maximum) * 146 : 156
    return `${x.toFixed(2)},${Math.max(6, Math.min(156, y)).toFixed(2)}`
  }).join(' ')
}

function trendPointTitle(point: UsageTrendPoint, language: 'zh' | 'en', t: (key: string, values?: Record<string, string | number>) => string): string {
  return [
    formatUsageTime(point.at, language),
    `${t('providerUsageInputTokens')}: ${formatTokens(point.inputTokens)}`,
    `${t('providerUsageOutputTokens')}: ${formatTokens(point.outputTokens)}`,
    `${t('providerUsageCacheReadTokens')}: ${formatTokens(point.cacheReadTokens)}`,
    `${t('providerUsageCacheWriteTokens')}: ${formatTokens(point.cacheWriteTokens)}`,
    `${t('providerUsageCost')}: ${formatUsageCost(point.costUsd)}`
  ].join('\n')
}
