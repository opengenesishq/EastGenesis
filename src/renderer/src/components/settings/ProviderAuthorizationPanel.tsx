import { useCallback, useEffect, useState } from 'react'
import type {
  ProviderAuthorizationAccountView,
  ProviderAuthorizationQuotaView,
  ProviderAuthorizationService,
  ProviderDeviceAuthorizationView
} from '../../../../shared/provider-authorization-types'
import type { ProviderAuthorization, ProviderView } from '../../../../shared/types'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import ProviderAuthorizationQuota from './ProviderAuthorizationQuota'
import ProviderAuthorizationRouting from './ProviderAuthorizationRouting'

export default function ProviderAuthorizationPanel({ provider }: { provider: ProviderView }): React.JSX.Element {
  const t = useT()
  const refreshProviders = useStore((state) => state.refreshProviders)
  const [authorization, setAuthorization] = useState<ProviderAuthorization | undefined>(provider.authorization)
  const [accounts, setAccounts] = useState<ProviderAuthorizationAccountView[]>([])
  const [flow, setFlow] = useState<ProviderDeviceAuthorizationView | null>(null)
  const [nextPollAt, setNextPollAt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [quota, setQuota] = useState<ProviderAuthorizationQuotaView | null>(null)
  const [quotaLoading, setQuotaLoading] = useState(false)
  const [quotaError, setQuotaError] = useState('')
  const service: ProviderAuthorizationService = authorization?.provider ?? 'xai-oauth'
  const authorized = Boolean(authorization?.provider) && authorization?.status === 'authorized'
  const quotaUnavailableText = t('providerAuthorizationQuotaUnavailable')

  const loadAccounts = async (): Promise<void> => {
    setAccounts(await window.agentDesk.listProviderAuthorizationAccounts(provider.id))
  }

  useEffect(() => {
    void loadAccounts().catch(() => undefined)
  }, [provider.id])

  useEffect(() => {
    setAuthorization(provider.authorization)
  }, [provider.id, provider.authorization])

  const loadQuota = useCallback(async (): Promise<void> => {
    setQuotaLoading(true)
    setQuotaError('')
    try {
      const result = await window.agentDesk.queryProviderAuthorizationQuota(provider.id)
      setQuota(result)
      if (result.status === 'expired') {
        setAuthorization((current) => current ? {
          ...current,
          status: 'expired',
          lastErrorCode: 'quota_authorization_expired'
        } : current)
        await refreshProviders()
      }
    } catch {
      setQuotaError(quotaUnavailableText)
    } finally {
      setQuotaLoading(false)
    }
  }, [provider.id, quotaUnavailableText, refreshProviders])

  useEffect(() => {
    if (!authorized) {
      if (authorization?.status !== 'expired') setQuota(null)
      return
    }
    void loadQuota()
    const timer = setInterval(() => void loadQuota(), 5 * 60 * 1000)
    return () => clearInterval(timer)
  }, [authorized, authorization?.accountId, authorization?.status, loadQuota])

  useEffect(() => {
    if (!flow) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      const wait = Math.max(0, nextPollAt - Date.now())
      timer = setTimeout(async () => {
        try {
          const result = await window.agentDesk.pollProviderAuthorization(provider.id, flow.flowId)
          if (cancelled) return
          if (result.status === 'pending') {
            setNextPollAt(result.nextPollAt)
            return
          }
          setAuthorization(result.provider.authorization)
          setFlow(null)
          setError('')
          await Promise.all([loadAccounts(), refreshProviders()])
        } catch (cause) {
          if (cancelled) return
          setFlow(null)
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, wait)
    }
    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [flow, nextPollAt, provider.id])

  const start = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const started = await window.agentDesk.startProviderAuthorization(provider.id, 'xai-oauth')
      setFlow(started)
      setNextPollAt(Date.now())
      window.open(started.verificationUri, '_blank', 'noopener,noreferrer')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const refresh = async (): Promise<void> => {
    await runMutation(() => window.agentDesk.refreshProviderAuthorization(provider.id))
  }

  const bind = async (accountId: string): Promise<void> => {
    if (!accountId || accountId === authorization?.accountId) return
    await runMutation(() => window.agentDesk.bindProviderAuthorizationAccount(provider.id, accountId))
  }

  const revoke = async (): Promise<void> => {
    if (!window.confirm(t('providerAuthorizationRevokeConfirm'))) return
    await runMutation(() => window.agentDesk.revokeProviderAuthorization(provider.id))
  }

  const runMutation = async (action: () => Promise<ProviderView>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const updated = await action()
      setAuthorization(updated.authorization)
      await Promise.all([loadAccounts(), refreshProviders()])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="provider-authorization" aria-label={t('providerAuthorizationTitle')}>
      <div className="settings-section-head">
        <div>
          <h3 className="settings-h3">{t('providerAuthorizationTitle')}</h3>
          <p className="settings-hint">{t('providerAuthorizationServiceHint', { service: serviceLabel(service, t) })}</p>
        </div>
        {!flow && !authorized && (
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void start()}>
            {busy ? t('providerAuthorizationStarting') : t('providerAuthorizationConnect')}
          </button>
        )}
      </div>

      {flow && (
        <div className="provider-authorization-device" data-provider-authorization-flow>
          <code>{flow.userCode}</code>
          <a href={flow.verificationUri} target="_blank" rel="noreferrer">
            {t('providerAuthorizationOpenPage')}
          </a>
          <span>{t('providerAuthorizationWaiting')}</span>
        </div>
      )}

      {authorized && (
        <>
          <div className="provider-authorization-account">
            <select
              className="select"
              value={authorization.accountId ?? ''}
              disabled={busy}
              aria-label={t('providerAuthorizationAccount')}
              onChange={(event) => void bind(event.target.value)}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id} disabled={account.requiresReauth}>
                  {account.label}{account.requiresReauth ? ` · ${t('providerAuthorizationExpired')}` : ''}
                </option>
              ))}
            </select>
            <div className="provider-authorization-actions">
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void refresh()}>
                {t('providerAuthorizationRefresh')}
              </button>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void revoke()}>
                {t('providerAuthorizationRevoke')}
              </button>
            </div>
          </div>
          <ProviderAuthorizationRouting
            providerId={provider.id}
            accounts={accounts}
            mode={authorization.accountRoutingMode ?? 'preferred'}
            boundAccountId={authorization.accountId}
            disabled={busy || quotaLoading}
            onAccountsChanged={setAccounts}
            onProviderChanged={async (updated) => {
              setAuthorization(updated.authorization)
              await refreshProviders()
            }}
            onQuotaLoaded={(accountId, result) => {
              if (accountId === authorization.accountId) setQuota(result)
            }}
          />
        </>
      )}

      <ProviderAuthorizationQuota
        authorized={authorized}
        quota={quota}
        loading={quotaLoading}
        error={quotaError}
        onRefresh={loadQuota}
      />

      {authorization?.status === 'expired' && !flow && (
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void start()}>
          {t('providerAuthorizationReconnect')}
        </button>
      )}
      {error && <div className="notice notice-error">{error}</div>}
    </section>
  )
}

function serviceLabel(
  service: ProviderAuthorizationService,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  return service === 'xai-oauth' ? t('providerAuthorizationServiceXai') : ''
}
