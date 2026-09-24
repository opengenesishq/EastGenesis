import type { Dispatch, SetStateAction } from 'react'
import type {
  ProviderApiKeyView,
  ProviderAuthMode,
  ProviderCredentialRoutingMode,
  ProviderCredentialStorage,
  ProviderView
} from '../../../../shared/types'
import { useT } from '../../i18n'
import ProviderSavedKeys, { type ProviderKeyDraft } from './ProviderSavedKeys'

interface Props {
  authMode: ProviderAuthMode
  onAuthModeChange: (mode: ProviderAuthMode) => void
  existingCredentialCount: number
  provider: ProviderView | null
  isEdit: boolean
  token: string
  tokenTouched: boolean
  onTokenChange: (value: string) => void
  tokenLabel: string
  onTokenLabelChange: (value: string) => void
  savedKeys: ProviderApiKeyView[]
  keyDrafts: Record<string, ProviderKeyDraft>
  activeKeyId: string
  onActiveKeyChange: (id: string) => void
  credentialRoutingMode: ProviderCredentialRoutingMode
  onCredentialRoutingModeChange: (mode: ProviderCredentialRoutingMode) => void
  onKeyDraftsChange: Dispatch<SetStateAction<Record<string, ProviderKeyDraft>>>
  additionalKeysText: string
  onAdditionalKeysTextChange: (value: string) => void
}

export default function ProviderCredentialFields(props: Props): React.JSX.Element {
  const t = useT()
  const { authMode, onAuthModeChange, existingCredentialCount, provider, isEdit, token, tokenTouched,
    onTokenChange, tokenLabel, onTokenLabelChange, savedKeys, keyDrafts, activeKeyId,
    onActiveKeyChange, credentialRoutingMode, onCredentialRoutingModeChange, onKeyDraftsChange,
    additionalKeysText, onAdditionalKeysTextChange } = props
  return <>
    <label className="field-label">{t('providerAuthModeLabel')}</label>
    <select className="select select-block" value={authMode} onChange={(event) => onAuthModeChange(event.target.value as ProviderAuthMode)}>
      <option value="api-key">{t('providerAuthModeApiKey')}</option>
      <option value="none">{t('providerAuthModeNone')}</option>
    </select>
    {authMode === 'none' ? <div className={`notice ${existingCredentialCount > 0 ? 'notice-error' : 'notice-info'}`}>
      {t(existingCredentialCount > 0 ? 'providerAuthModeNoneDeletesKeysHint' : 'providerAuthModeNoneHint', { n: existingCredentialCount })}
    </div> : <>
      <ProviderCredentialStorageNotice storage={provider?.credentialStorage} />
      <label className="field-label">
        {t('apiKeyLabelPrimary')}
        {isEdit && provider?.hasToken && !tokenTouched && <span className="field-hint">{t('savedKeepEmpty')}</span>}
      </label>
      <input className="input input-block" data-provider-field="api-key" type="password" value={token} placeholder={isEdit && provider?.hasToken ? t('tokenPlaceholderSaved') : '<your-api-key>'} onChange={(event) => onTokenChange(event.target.value)} />
      <details className="provider-credential-options">
      <summary>{t('providerSimpleCredentialsMore')}</summary>
      <label className="field-label">{t('apiKeyNameLabel')}</label>
      <input className="input input-block" value={tokenLabel} placeholder={t('apiKeyNamePlaceholder')} onChange={(event) => onTokenLabelChange(event.target.value)} />
      <ProviderSavedKeys provider={provider} savedKeys={savedKeys} keyDrafts={keyDrafts} activeKeyId={activeKeyId} routingMode={credentialRoutingMode} onActiveKeyChange={onActiveKeyChange} onRoutingModeChange={onCredentialRoutingModeChange} onKeyDraftsChange={onKeyDraftsChange} />
      <label className="field-label">{t('additionalApiKeysLabel')}</label>
      <textarea className="input input-block textarea" data-provider-field="additional-api-keys" value={additionalKeysText} rows={3} placeholder={t('additionalApiKeysPlaceholder')} onChange={(event) => onAdditionalKeysTextChange(event.target.value)} />
      <div className="field-hint">{t('additionalApiKeysHint')}</div>
      </details>
    </>}
  </>
}

export function ProviderCredentialMigrationNotice({ provider }: { provider: ProviderView | null }): React.JSX.Element | null {
  const t = useT()
  if (!provider?.credentialMigrationRequired) return null
  return <div className="notice notice-error">{t('providerCredentialMigrationNotice')}</div>
}

function ProviderCredentialStorageNotice({ storage }: { storage: ProviderCredentialStorage | undefined }): React.JSX.Element | null {
  const t = useT()
  if (!storage) return null
  const notice = providerCredentialNotice(storage)
  return notice ? <div className={`notice ${notice.tone}`}>{t(notice.key)}</div> : null
}

function providerCredentialNotice(storage: ProviderCredentialStorage): { key: string; tone: 'notice-info' | 'notice-error' } | null {
  if (storage === 'session') return { key: 'providerCredentialSessionNotice', tone: 'notice-info' }
  if (storage === 'legacy-b64') return { key: 'providerCredentialLegacyNotice', tone: 'notice-info' }
  if (storage === 'unavailable') return { key: 'providerCredentialUnavailableNotice', tone: 'notice-error' }
  if (storage === 'mixed') return { key: 'providerCredentialMixedNotice', tone: 'notice-info' }
  return null
}
