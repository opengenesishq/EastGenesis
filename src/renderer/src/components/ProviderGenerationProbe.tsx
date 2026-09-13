import type { ProviderGenerationProbeResult } from '../../../shared/types'
import { useT } from '../i18n'

export default function ProviderGenerationProbe({ result }: { result: ProviderGenerationProbeResult }): React.JSX.Element {
  const t = useT()
  const credential = result.credentialSource === 'stored-active' && result.credentialLabel
    ? t('providerDiagnosticCredentialSource_storedLabel', { label: result.credentialLabel })
    : t(`providerDiagnosticCredentialSource_${result.credentialSource}`)
  return (
    <section className={`provider-generation-probe is-${result.ok ? 'success' : 'failure'}`} data-provider-generation-probe>
      <div className="provider-generation-probe-heading">
        <strong>{t('providerGenerationProbeTitle')}</strong>
        <span>{t(`providerGenerationProbeOutcome_${result.outcome}`)}</span>
      </div>
      <div className="provider-diagnostic-facts">
        <ProbeFact label={t('providerDiagnosticProtocol')} value={t(`providerDiagnosticProtocol_${result.protocol}`)} />
        <ProbeFact label={t('providerDiagnosticGenerationPath')} value={result.endpointPath} code />
        <ProbeFact label={t('providerDiagnosticCredentialSource')} value={credential} />
        <ProbeFact
          label={t('providerDiagnosticCredential')}
          value={result.credentialHeaderNames.length > 0 ? result.credentialHeaderNames.join(' / ') : t('providerDiagnosticNoCredential')}
          code
        />
      </div>
      <p>{t('providerGenerationProbeSummary', {
        status: result.status ?? t('providerDiagnosticNoStatus'),
        latencyMs: result.latencyMs
      })}</p>
      <p>{t('providerSetupProtocolScope')}</p>
      <p className="provider-generation-probe-billing">{t('providerGenerationProbeBillingNotice')}</p>
    </section>
  )
}

function ProbeFact({ label, value, code = false }: { label: string; value: string; code?: boolean }): React.JSX.Element {
  return (
    <div className="provider-diagnostic-fact">
      <span>{label}</span>
      {code ? <code>{value}</code> : <strong>{value}</strong>}
    </div>
  )
}
