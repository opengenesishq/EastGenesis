import type { ProviderModelProfile } from '../../../shared/types'
import { useT } from '../i18n'
import ProviderMediaModelFields from './ProviderMediaModelFields'

export default function ProviderSetupModelCapabilities({ profile, disabled, dirty, onChange, onSave, onReset }: {
  profile: ProviderModelProfile
  disabled: boolean
  dirty: boolean
  onChange: (patch: Partial<ProviderModelProfile>) => void
  onSave: () => void
  onReset: () => void
}): React.JSX.Element {
  const t = useT()
  return <fieldset className="provider-advanced-section" data-provider-setup-capabilities disabled={disabled}>
    <legend>{t('providerSetupModelCapabilities')}</legend>
    <p className="field-hint">{t('providerSetupDeclareHint')}</p>
    <div className="provider-advanced-row">
      {(['text', 'tools', 'vision'] as const).map((capability) => <label key={capability}>
        <input type="checkbox" data-provider-setup-capability={capability}
          checked={(profile.capabilities ?? []).some((value) => value.trim().toLowerCase() === capability)}
          onChange={(event) => onChange({ capabilities: [
            ...(profile.capabilities ?? []).filter((value) => value.trim().toLowerCase() !== capability),
            ...(event.target.checked ? [capability] : [])
          ] })} />{t(`providerCapability_${capability}`)}
      </label>)}
    </div>
    <ProviderMediaModelFields key={profile.model} model={profile} onChange={onChange} />
    <div className="provider-model-actions">
      <button type="button" className="btn btn-primary btn-sm" data-provider-setup-action="save-capabilities" disabled={!dirty} onClick={onSave}>{t('providerSetupSaveCapabilities')}</button>
      <button type="button" className="btn btn-ghost btn-sm" data-provider-setup-action="reset-capabilities" disabled={!dirty} onClick={onReset}>{t('providerSetupResetCapabilities')}</button>
    </div>
    {dirty && <p className="field-hint" role="status">{t('providerSetupCapabilitiesUnsaved')}</p>}
  </fieldset>
}
