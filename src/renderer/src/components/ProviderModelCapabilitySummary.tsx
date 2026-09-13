import type { ProviderModelProfile } from '../../../shared/types'
import {
  PROVIDER_MODEL_CAPABILITIES,
  summarizeProviderModelProfiles,
  type ProviderModelCapability
} from '../../../shared/provider-model-capability-summary'
import { useT } from '../i18n'

interface Props {
  profiles: ProviderModelProfile[]
  compact?: boolean
}

/** A single capability projection reused by Provider setup and routing config. */
export default function ProviderModelCapabilitySummary({ profiles, compact = false }: Props): React.JSX.Element {
  const t = useT()
  const summary = summarizeProviderModelProfiles(profiles)
  return (
    <div className={`provider-model-capability-summary${compact ? ' is-compact' : ''}`} data-provider-capability-summary>
      <div className="provider-model-capability-summary-head">
        <strong>{t('providerModelCapabilitySummary')}</strong>
        <span>{t('providerModelCapabilityDeclaredHint')}</span>
      </div>
      <div className="provider-model-capability-chips" role="list" aria-label={t('providerModelCapabilitySummary')}>
        {PROVIDER_MODEL_CAPABILITIES.map((capability) => (
          <span className={`provider-model-capability-chip${summary.byCapability[capability] > 0 ? '' : ' is-empty'}`} role="listitem" key={capability}>
            {t(capabilityLabelKey(capability))} {summary.byCapability[capability]}
          </span>
        ))}
        <span className={`provider-model-capability-chip${summary.unclassified > 0 ? ' is-warning' : ' is-empty'}`} role="listitem">
          {t('providerCapabilityUnclassified')} {summary.unclassified}
        </span>
      </div>
    </div>
  )
}

function capabilityLabelKey(capability: ProviderModelCapability): string {
  return `providerCapability_${capability}`
}
