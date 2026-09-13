import { useEffect, useState } from 'react'
import { RefreshCw, Settings2 } from 'lucide-react'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import ProviderProfileManager from './ProviderProfileManager'
import ProviderProfileSyncPanel from './ProviderProfileSyncPanel'
import ProviderProfileWebDavPanel from './ProviderProfileWebDavPanel'
import ProviderProfileS3Panel from './ProviderProfileS3Panel'
import type { ProviderAuthorizationAccountView } from '../../../../shared/provider-authorization-types'
import type { ProviderBalanceItemView, ProviderBalanceView } from '../../../../shared/provider-balance-types'
import type {
  ProviderCredentialStorage,
  ProviderHealthView,
  ProviderModelFetchError,
  ProviderAuthorizationStatus,
  ProviderView
} from '../../../../shared/types'
import ProviderModelCapabilitySummary from '../ProviderModelCapabilitySummary'

interface ProviderProbe {
  providerId: string
  ok: boolean
  message: string
  error?: ProviderModelFetchError
}

interface Props {
  providers: ProviderView[]
  health: ProviderHealthView[]
  providerProbe: ProviderProbe | null
  checkingProviderId: string
  onAdd: () => void
  onProbe: (provider: ProviderView) => void
  onEdit: (provider: ProviderView) => void
  onRemove: (provider: ProviderView) => void
}

export default function ProviderList({
  providers,
  health,
  providerProbe,
  checkingProviderId,
  onAdd,
  onProbe,
  onEdit,
  onRemove
}: Props): React.JSX.Element {
  const t = useT()
  return (
    <ProviderProfileManager providers={providers} onAdd={onAdd}>
      <ProviderProfileSyncPanel />
      <ProviderProfileWebDavPanel />
      <ProviderProfileS3Panel />
      <ProviderAccountOverview providers={providers} onEdit={onEdit} />
      <div className="provider-list">
        {providers.length === 0 && <div className="provider-empty">{t('providerEmpty')}</div>}
        {providers.map((provider) => (
          <ProviderListRow
            key={provider.id}
            provider={provider}
            health={health.find((item) => item.providerId === (provider.id || 'local-login'))}
            providerProbe={providerProbe}
            checking={checkingProviderId === provider.id}
            onProbe={onProbe}
            onEdit={onEdit}
            onRemove={onRemove}
          />
        ))}
      </div>
    </ProviderProfileManager>
  )
}

function ProviderAccountOverview({ providers, onEdit }: { providers: ProviderView[]; onEdit: (provider: ProviderView) => void }): React.JSX.Element {
  const t = useT()
  const authorized = providers.filter((provider) => provider.authorization?.status === 'authorized').length
  const modelCount = new Set(providers.flatMap((provider) => provider.models)).size
  const keyCount = providers.reduce((total, provider) => total + (provider.keyCount ?? (provider.hasToken ? 1 : 0)), 0)
  const modelProfiles = providers.flatMap((provider) => {
    const profiles = provider.advancedConfig?.modelProfiles ?? []
    const known = new Set(profiles.flatMap((profile) => [profile.model, ...(profile.aliases ?? [])]).map((model) => model.toLowerCase()))
    return [...profiles, ...provider.models.filter((model) => !known.has(model.toLowerCase())).map((model) => ({ model }))]
  })
  return (
    <section className="provider-account-overview" aria-label={t('providerAccountOverviewTitle')} data-provider-account-overview>
      <div className="provider-account-overview-head">
        <div>
          <h3 className="settings-h3">{t('providerAccountOverviewTitle')}</h3>
          <p className="settings-hint">{t('providerAccountOverviewHint')}</p>
        </div>
        <span className="provider-account-overview-status">
          {authorized > 0 ? t('providerAccountOverviewAuthorized') : t('providerAccountOverviewKeyMode')}
        </span>
      </div>
      <div className="provider-account-metrics">
        <AccountMetric value={providers.length} label={t('providerAccountOverviewProviders')} />
        <AccountMetric value={authorized} label={t('providerAccountOverviewAuthorizedAccounts')} />
        <AccountMetric value={modelCount} label={t('providerAccountOverviewModels')} />
        <AccountMetric value={keyCount} label={t('providerAccountOverviewKeys')} />
      </div>
      <ProviderModelCapabilitySummary profiles={modelProfiles} compact />
      <ProviderAuthorizationOverview providers={providers} onEdit={onEdit} />
      <ProviderBalanceOverview providers={providers} />
    </section>
  )
}

function ProviderAuthorizationOverview({ providers, onEdit }: { providers: ProviderView[]; onEdit: (provider: ProviderView) => void }): React.JSX.Element | null {
  const t = useT()
  const refreshProviders = useStore((state) => state.refreshProviders)
  const authorizationProviders = providers.filter((provider) => Boolean(provider.authorization?.provider))
  const providerSignature = authorizationProviders
    .map((provider) => `${provider.id}:${provider.authorization?.accountId ?? ''}:${provider.authorization?.status ?? ''}`)
    .join('|')
  const [accounts, setAccounts] = useState<Record<string, ProviderAuthorizationAccountView[]>>({})
  const [loading, setLoading] = useState(false)
  const [switchingProviderId, setSwitchingProviderId] = useState('')
  const [reloadRevision, setReloadRevision] = useState(0)
  const [errorProviderId, setErrorProviderId] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      setLoading(true)
      const entries = await Promise.all(authorizationProviders.map(async (provider) => {
        try {
          return [provider.id, await window.agentDesk.listProviderAuthorizationAccounts(provider.id)] as const
        } catch {
          return [provider.id, []] as const
        }
      }))
      if (!cancelled) {
        setAccounts(Object.fromEntries(entries))
        setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [providerSignature, reloadRevision])

  if (authorizationProviders.length === 0) return null

  const bind = async (provider: ProviderView, accountId: string): Promise<void> => {
    if (!accountId || accountId === provider.authorization?.accountId) return
    setSwitchingProviderId(provider.id)
    setErrorProviderId('')
    try {
      await window.agentDesk.bindProviderAuthorizationAccount(provider.id, accountId)
      await refreshProviders()
      setReloadRevision((revision) => revision + 1)
    } catch {
      setErrorProviderId(provider.id)
    } finally {
      setSwitchingProviderId('')
    }
  }

  return (
    <div className="provider-authorization-overview" data-provider-authorization-overview>
      <div className="provider-authorization-overview-head">
        <strong>{t('providerAuthorizationOverviewTitle')}</strong>
        <span>{loading ? t('providerAuthorizationOverviewLoading') : t('providerAuthorizationOverviewSummary', { accounts: Object.values(accounts).reduce((total, items) => total + items.length, 0), providers: authorizationProviders.length })}</span>
      </div>
      <div className="provider-authorization-overview-items">
        {authorizationProviders.map((provider) => {
          const providerAccounts = accounts[provider.id] ?? []
          const authorization = provider.authorization
          return (
            <div className="provider-authorization-overview-item" key={provider.id}>
              <div className="provider-authorization-overview-identity">
                <span>{provider.name}</span>
                <strong>{authorization?.accountLabel || t('providerAuthorizationNoAccount')}</strong>
                <small className={`is-${authorization?.status ?? 'unconfigured'}`}>{authorizationStatusLabel(authorization?.status, t)}</small>
              </div>
              <div className="provider-authorization-overview-actions">
                {providerAccounts.length > 0 && (
                  <select
                    className="select"
                    aria-label={t('providerAuthorizationAccount')}
                    value={authorization?.accountId ?? ''}
                    disabled={switchingProviderId === provider.id}
                    onChange={(event) => void bind(provider, event.target.value)}
                  >
                    <option value="" disabled>{t('providerAuthorizationSelectAccount')}</option>
                    {providerAccounts.map((account) => (
                      <option key={account.id} value={account.id} disabled={account.requiresReauth}>
                        {account.label}{account.requiresReauth ? ` · ${t('providerAuthorizationExpired')}` : ''}
                      </option>
                    ))}
                  </select>
                )}
                <button type="button" className="btn btn-ghost btn-icon-sm" aria-label={t('providerConfigure')} title={t('providerConfigure')} onClick={() => onEdit(provider)}>
                  <Settings2 size={14} aria-hidden="true" />
                </button>
              </div>
              {errorProviderId === provider.id && <span className="provider-authorization-overview-error">{t('providerAuthorizationSwitchFailed')}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function authorizationStatusLabel(status: ProviderAuthorizationStatus | undefined, t: ReturnType<typeof useT>): string {
  return status === 'authorized'
    ? t('providerAuthorizationAuthorized')
    : status === 'expired'
      ? t('providerAuthorizationExpired')
      : status === 'revoked'
        ? t('providerAuthorizationRevoked')
        : status === 'error'
          ? t('providerAuthorizationError')
          : t('providerAuthorizationUnconfigured')
}

function ProviderBalanceOverview({ providers }: { providers: ProviderView[] }): React.JSX.Element {
  const t = useT()
  const [refreshRevision, setRefreshRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [supportedCount, setSupportedCount] = useState(0)
  const [balances, setBalances] = useState<Record<string, ProviderBalanceView>>({})
  const providerSignature = providers.map((provider) => provider.id).join('|')

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      setLoading(true)
      const capabilities = await Promise.all(providers.map(async (provider) => {
        try {
          return await window.agentDesk.inspectProviderBalance(provider.id)
        } catch {
          return { providerId: provider.id, supported: false }
        }
      }))
      if (cancelled) return
      const supported = capabilities.filter((capability) => capability.supported)
      setSupportedCount(supported.length)
      const results = await Promise.all(supported.map(async (capability) => {
        try {
          return await window.agentDesk.queryProviderBalance(capability.providerId)
        } catch {
          return {
            providerId: capability.providerId,
            status: 'unavailable' as const,
            queriedAt: Date.now(),
            items: [],
            errorCode: 'query_failed'
          }
        }
      }))
      if (cancelled) return
      setBalances(Object.fromEntries(results.map((result) => [result.providerId, result])))
      setLoading(false)
    }
    void load()
    return () => { cancelled = true }
  }, [providerSignature, refreshRevision])

  const supportedProviders = providers.filter((provider) => balances[provider.id] || loading)
  const readyCount = Object.values(balances).filter((balance) => balance.status === 'ready').length
  const lastUpdated = Math.max(0, ...Object.values(balances).map((balance) => balance.queriedAt))
  return (
    <div className="provider-balance-overview" data-provider-balance-overview>
      <div className="provider-balance-overview-head">
        <div>
          <strong>{t('providerBalanceOverviewTitle')}</strong>
          <span>
            {loading
              ? t('providerBalanceLoading')
              : supportedCount === 0
                ? t('providerBalanceOverviewNone')
                : t('providerBalanceOverviewSummary', { ready: readyCount, supported: supportedCount })}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-icon-sm"
          aria-label={t('providerBalanceRefresh')}
          title={t('providerBalanceRefresh')}
          disabled={loading || providers.length === 0}
          onClick={() => setRefreshRevision((revision) => revision + 1)}
        >
          <RefreshCw size={14} aria-hidden="true" className={loading ? 'provider-usage-spin' : ''} />
        </button>
      </div>
      {!loading && supportedCount > 0 && (
        <div className="provider-balance-overview-items">
          {supportedProviders.map((provider) => (
            <ProviderBalanceOverviewItem key={provider.id} provider={provider} balance={balances[provider.id]} />
          ))}
        </div>
      )}
      {!loading && lastUpdated > 0 && (
        <span className="provider-balance-overview-updated">
          {t('providerBalanceOverviewUpdated', { time: new Date(lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
        </span>
      )}
    </div>
  )
}

function ProviderBalanceOverviewItem({ provider, balance }: { provider: ProviderView; balance: ProviderBalanceView | undefined }): React.JSX.Element {
  const t = useT()
  const values = balance?.status === 'ready'
    ? balance.items.map(formatBalanceOverviewValue).filter(Boolean)
    : []
  return (
    <div className={`provider-balance-overview-item ${balance?.status === 'expired' ? 'is-warning' : balance?.status !== 'ready' ? 'is-muted' : ''}`}>
      <span>{provider.name}</span>
      <strong>{values.length > 0 ? values.join(' · ') : balance?.status === 'expired' ? t('providerBalanceExpired') : t('providerBalanceUnavailable')}</strong>
    </div>
  )
}

function formatBalanceOverviewValue(item: ProviderBalanceItemView): string {
  const value = item.remaining ?? item.total ?? item.used
  if (value === undefined) return ''
  const amount = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value)
  return `${item.label ? `${item.label} ` : ''}${amount}${item.unit ? ` ${item.unit}` : ''}`
}

function AccountMetric({ value, label }: { value: number; label: string }): React.JSX.Element {
  return (
    <div className="provider-account-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

function ProviderListRow({
  provider,
  health,
  providerProbe,
  checking,
  onProbe,
  onEdit,
  onRemove
}: {
  provider: ProviderView
  health: ProviderHealthView | undefined
  providerProbe: ProviderProbe | null
  checking: boolean
  onProbe: (provider: ProviderView) => void
  onEdit: (provider: ProviderView) => void
  onRemove: (provider: ProviderView) => void
}): React.JSX.Element {
  const t = useT()
  const pricedModels = provider.advancedConfig?.modelProfiles?.filter((profile) => Boolean(profile.pricing)).length ?? 0
  return (
    <div className="provider-row">
      <div className="provider-row-body">
        <div className="provider-row-name">
          {provider.name}
          <ProviderCredentialTag provider={provider} />
          <ProviderHealthDot health={health} />
        </div>
        <div className="provider-row-sub">
          {provider.baseUrl || t('officialEndpoint')} · {t('modelsCount', { n: provider.models.length })} ·{' '}
          {providerCredentialSummary(provider, t)} · {t('providerPricingConfiguredCount', { priced: pricedModels, total: provider.models.length })}
        </div>
        {provider.credentialMigrationRequired && (
          <div className="provider-probe-message provider-probe-bad">
            {t('providerCredentialMigrationNotice')}
          </div>
        )}
        {providerProbe?.providerId === provider.id && (
          <div className={`provider-probe-message ${providerProbe.ok ? 'provider-probe-ok' : 'provider-probe-bad'}`}>
            <span>{providerProbe.message}</span>
            {!providerProbe.ok && providerProbe.error && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onEdit(provider)}>
                {t('providerProbeFixConfiguration')}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="provider-row-actions">
        <button className="btn btn-ghost btn-sm" disabled={checking} onClick={() => onProbe(provider)}>
          {checking ? t('providerProbing') : t('providerProbe')}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => onEdit(provider)}>
          {t('providerConfigure')}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => onRemove(provider)}>
          {t('delete')}
        </button>
      </div>
    </div>
  )
}

function ProviderCredentialTag({ provider }: { provider: ProviderView }): React.JSX.Element | null {
  const t = useT()
  const authorization = provider.authorization
  if (authorization && authorization.method !== 'none') {
    const statusKey = authorization.status === 'authorized'
      ? 'providerAuthorizationAuthorized'
      : authorization.status === 'expired'
        ? 'providerAuthorizationExpired'
        : authorization.status === 'revoked'
          ? 'providerAuthorizationRevoked'
          : authorization.status === 'error'
            ? 'providerAuthorizationError'
            : 'providerAuthorizationUnconfigured'
    return <span className="provider-tag">{t('providerAuthorizationStatus')}: {t(statusKey)}</span>
  }
  if (provider.authMode === 'none') return <span className="provider-tag">{t('providerLocalNoKey')}</span>
  const tagKey = providerCredentialTagKey(provider.credentialStorage)
  if (tagKey) return <span className="provider-tag-warn">{t(tagKey)}</span>
  if (!provider.hasToken) return <span className="provider-tag-warn">{t('noKeyConfigured')}</span>
  return null
}

function ProviderHealthDot({ health }: { health: ProviderHealthView | undefined }): React.JSX.Element | null {
  const t = useT()
  if (!health) return null
  const title = health.circuitState === 'open'
    ? t('healthCircuitOpenTip', {
        error: health.recentFailures?.[0]?.message ?? health.lastError ?? '-'
      })
    : health.circuitState === 'half_open'
      ? t('healthCircuitHalfOpenTip')
      : health.healthy
    ? t('healthOkTip', {
        s: health.successes,
        f: health.failures,
        latencyMs: health.latencyEmaMs ?? health.lastLatencyMs ?? '-'
      })
    : t('healthBadTip', {
        n: health.consecutiveFailures,
        error: health.recentFailures?.[0]?.message ?? health.lastError ?? '-'
      })
  const statusClass = health.circuitState === 'open'
    ? 'health-bad'
    : health.circuitState === 'half_open'
      ? 'health-warn'
      : health.healthy ? 'health-ok' : 'health-bad'
  return (
    <span
      className={`health-dot ${statusClass}`}
      title={title}
    />
  )
}

function providerCredentialSummary(provider: ProviderView, t: ReturnType<typeof useT>): string {
  if (provider.authMode === 'none') return t('providerLocalNoKey')
  if (provider.hasToken) {
    const activeLabel = provider.activeKeyLabel ? ` · ${provider.activeKeyLabel}` : ''
    return `${t('apiKeyCountLabel', { n: provider.keyCount ?? 1 })}${activeLabel}`
  }
  const tagKey = providerCredentialTagKey(provider.credentialStorage)
  return t(tagKey ?? 'noKeyConfigured')
}

function providerCredentialTagKey(storage: ProviderCredentialStorage): string | null {
  switch (storage) {
    case 'session':
      return 'providerCredentialSessionTag'
    case 'legacy-b64':
      return 'providerCredentialLegacyTag'
    case 'unavailable':
      return 'providerCredentialUnavailableTag'
    case 'mixed':
      return 'providerCredentialMixedTag'
    case 'none':
    case 'encrypted':
      return null
  }
}
