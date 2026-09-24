import { useRef, useState } from 'react'
import { Download, Pencil, RefreshCw } from 'lucide-react'
import type { ProviderView } from '../../../../shared/types'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import { discoverImportedProviderModels, ImportedModelsError } from './native-provider-model-discovery'

export default function ProviderImportedModelRecovery({ providers, busy, onEdit }: {
  providers: ProviderView[]
  busy: boolean
  onEdit?: (provider: ProviderView) => void
}): React.JSX.Element | null {
  const t = useT()
  const refreshProviders = useStore((state) => state.refreshProviders)
  const pending = providers.filter((provider) => provider.models.length === 0 &&
    ['native-client', 'codex-native'].includes(String(provider.advancedConfig?.metadata?.importedFrom ?? '')))
  const [running, setRunning] = useState<string[]>([])
  const runningRef = useRef(false)
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [completed, setCompleted] = useState<Record<string, { name: string; count: number }>>({})
  const available = pending.filter((provider) => provider.authMode === 'none' || provider.hasToken)
  const active = busy || running.length > 0
  async function discover(ids: string[]): Promise<void> {
    if (runningRef.current || busy) return
    runningRef.current = true
    setRunning(ids)
    try {
      for (const id of ids) {
        setFailures((current) => { const next = { ...current }; delete next[id]; return next })
        try {
          const saved = await discoverImportedProviderModels(id, window.agentDesk)
          setCompleted((current) => ({ ...current, [id]: { name: saved.name, count: saved.models.length } }))
          await refreshProviders()
        } catch (cause) {
          const message = cause instanceof ImportedModelsError && cause.reason !== 'unavailable'
            ? t(cause.reason === 'changed' ? 'providerNativeModelsChanged' : 'providerNativeModelsMissing')
            : cause instanceof Error && cause.message && cause.message !== 'unavailable' ? cause.message : t('providerNativeModelsUnavailable')
          setFailures((current) => ({ ...current, [id]: message }))
        }
      }
    } finally { runningRef.current = false; setRunning([]) }
  }
  if (pending.length === 0 && Object.keys(completed).length === 0) return null
  return <section className="provider-native-preview" data-provider-import-models>
    <div className="provider-native-preview-head">
      <div><h4>{t('providerNativeModelsTitle')}</h4><p>{t('providerNativeModelsHint')}</p></div>
      {available.length > 1 && <button className="btn btn-primary btn-sm" disabled={active} data-provider-import-models-all onClick={() => void discover(available.map((provider) => provider.id))}>
        <Download size={14} aria-hidden="true" /> {t('providerNativeModelsFetchAll')}
      </button>}
    </div>
    {pending.map((provider) => <div className="provider-profile-backup-row" key={provider.id} data-provider-import-model-row={provider.id}>
      <div>
        <strong>{provider.name}</strong>
        <span>{provider.hasToken || provider.authMode === 'none' ? t('providerNativeModelsReady') : t('providerNativeModelsCredentialNeeded')}</span>
        {failures[provider.id] && <p className="notice notice-error" role="alert">{failures[provider.id]} {t('providerNativeModelsEditHint')}</p>}
      </div>
      <div className="provider-profile-actions">
        <button className="btn btn-primary btn-sm" data-provider-import-model-fetch={provider.id} disabled={active || (!provider.hasToken && provider.authMode !== 'none')} onClick={() => void discover([provider.id])}>
          <RefreshCw size={14} aria-hidden="true" /> {t(running.includes(provider.id) ? 'providerNativeModelsFetching' : 'providerNativeModelsFetch')}
        </button>
        {onEdit && <button className="btn btn-ghost btn-sm" disabled={active} data-provider-import-model-edit={provider.id} onClick={() => onEdit(provider)}>
          <Pencil size={14} aria-hidden="true" /> {t('providerNativeModelsEdit')}
        </button>}
      </div>
    </div>)}
    {Object.entries(completed).filter(([id]) => providers.some((provider) => provider.id === id && provider.models.length > 0)).map(([id, result]) =>
      <p className="field-hint field-hint-ok" role="status" key={id} data-provider-import-models-saved={id}>{t('providerNativeModelsSaved', { name: result.name, n: result.count })}</p>)}
  </section>
}
