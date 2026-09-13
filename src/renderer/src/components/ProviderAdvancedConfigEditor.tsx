import { useEffect, useMemo, useState } from 'react'
import { Download, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type {
  EngineKind,
  ProviderAdvancedConfig,
  ProviderAppBinding,
  ProviderEndpointProfile,
  ProviderModelProfile,
  ProviderRuntimeConfig
} from '../../../shared/types'
import {
  mergeCatalogPricing,
  syncDiscoveredModelProfiles
} from '../../../shared/provider-pricing-catalog'
import { useT } from '../i18n'
import ProviderAnthropicRuntimeSection from './ProviderAnthropicRuntimeSection'
import ProviderGeminiRuntimeSection from './ProviderGeminiRuntimeSection'
import ProviderMediaModelFields from './ProviderMediaModelFields'
import ProviderModelCapabilitySummary from './ProviderModelCapabilitySummary'

interface Props {
  value: string
  onChange: (value: string) => void
  availableModels: string[]
  engine: EngineKind
}

type Draft = ProviderAdvancedConfig & Record<string, unknown>
type ProviderReliabilityConfig = NonNullable<ProviderAdvancedConfig['reliability']>
type ProviderBillingQueryConfig = NonNullable<ProviderAdvancedConfig['billingQuery']>

const DEFAULT_BILLING_QUERY: ProviderBillingQueryConfig = {
  path: '/v1/billing',
  method: 'GET',
  credentialMode: 'provider',
  periodStart: { target: 'query', name: 'start_time', format: 'unix-seconds' },
  periodEnd: { target: 'query', name: 'end_time', format: 'unix-seconds' },
  response: { amountPath: '/amount', currency: 'USD' }
}

const DEFAULT_CIRCUIT_BREAKER: NonNullable<ProviderReliabilityConfig['circuitBreaker']> = {
  failureThreshold: 4,
  successThreshold: 2,
  timeoutSeconds: 60,
  errorRateThreshold: 0.6,
  minRequests: 10
}

export default function ProviderAdvancedConfigEditor({ value, onChange, availableModels, engine }: Props): React.JSX.Element {
  const t = useT()
  const [mode, setMode] = useState<'structured' | 'json'>('structured')
  const parsed = useMemo(() => parseDraft(value), [value])
  const [jsonError, setJsonError] = useState('')
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [modelNotice, setModelNotice] = useState<{ tone: 'ok' | 'warning'; text: string } | null>(null)
  useEffect(() => {
    if (parsed.error) setJsonError(parsed.error)
    else setJsonError('')
  }, [parsed.error])
  const update = (mutate: (draft: Draft) => void): void => {
    const next = parseDraft(value).draft
    mutate(next)
    onChange(JSON.stringify(next, null, 2))
  }

  const draft = parsed.draft
  const syncModels = (): void => {
    let added = 0
    update((next) => {
      const result = syncDiscoveredModelProfiles(next.modelProfiles ?? [], availableModels)
      next.modelProfiles = result.profiles
      added = result.added
    })
    setModelNotice({
      tone: 'ok',
      text: added > 0 ? t('providerModelsSynced', { n: added }) : t('providerModelsAlreadySynced')
    })
  }

  const importCatalogPricing = async (): Promise<void> => {
    const requestedModels = Array.from(new Set([
      ...availableModels,
      ...(draft.modelProfiles ?? []).flatMap((profile) => [profile.model, ...(profile.aliases ?? [])])
    ].map((model) => model.trim()).filter(Boolean)))
    if (requestedModels.length === 0) {
      setModelNotice({ tone: 'warning', text: t('providerPricingNoModels') })
      return
    }
    setCatalogBusy(true)
    setModelNotice(null)
    try {
      const catalog = await window.agentDesk.fetchProviderPricingCatalog(requestedModels)
      let added = 0
      let imported = 0
      let protectedUserPrices = 0
      update((next) => {
        const synced = syncDiscoveredModelProfiles(next.modelProfiles ?? [], availableModels)
        const merged = mergeCatalogPricing(synced.profiles, catalog.matched, catalog.fetchedAt)
        next.modelProfiles = merged.profiles
        added = synced.added
        imported = merged.imported
        protectedUserPrices = merged.protectedUserPrices
      })
      setModelNotice({
        tone: imported > 0 || added > 0 ? 'ok' : 'warning',
        text: t('providerPricingImported', { imported, added, protected: protectedUserPrices })
      })
    } catch (error) {
      setModelNotice({
        tone: 'warning',
        text: t('providerPricingImportFailed', { error: error instanceof Error ? error.message : String(error) })
      })
    } finally {
      setCatalogBusy(false)
    }
  }

  return (
    <div className="provider-advanced-editor" data-provider-advanced-editor>
      <div className="provider-advanced-tabs" role="tablist" aria-label={t('providerAdvancedViewAria')}>
        <button type="button" className={`btn btn-sm ${mode === 'structured' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('structured')}>
          {t('providerAdvancedStructured')}
        </button>
        <button type="button" className={`btn btn-sm ${mode === 'json' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('json')}>
          JSON
        </button>
      </div>
      {mode === 'json' ? (
        <>
          <textarea
            className="input input-block textarea provider-advanced-config"
            data-provider-field="advanced-config"
            value={value}
            rows={14}
            placeholder={'{\n  "schemaVersion": 1,\n  "modelProfiles": []\n}'}
            onChange={(event) => onChange(event.target.value)}
          />
          {jsonError && <div className="field-hint field-hint-warning">{jsonError}</div>}
        </>
      ) : parsed.error ? (
        <div className="notice notice-error">
          {t('providerAdvancedInvalidRepair')}
        </div>
      ) : (
        <>
          <EndpointSection endpoints={draft.endpoints ?? []} update={update} />
          <ModelSection
            models={draft.modelProfiles ?? []}
            availableModelCount={availableModels.length}
            catalogBusy={catalogBusy}
            notice={modelNotice}
            onSync={syncModels}
            onImport={() => void importCatalogPricing()}
            update={update}
          />
          <ProviderRuntimeSections runtime={draft.runtime} update={update} engine={engine} />
          <ReliabilitySection reliability={draft.reliability} update={update} />
          <AppBindingSection bindings={draft.appBindings ?? {}} update={update} />
          <RequestSection request={draft.request} update={update} />
          <BalanceSection balanceQuery={draft.balanceQuery} update={update} />
          <BillingQuerySection billingQuery={draft.billingQuery} update={update} />
          <MapSection
            title={t('providerMetadata')}
            value={mapToLines(draft.metadata)}
            onChange={(text) => update((next) => setOptional(next, 'metadata', linesToMap(text)))}
          />
        </>
      )}
    </div>
  )
}

function RuntimeSection({
  runtime,
  update,
  engine
}: {
  runtime: ProviderRuntimeConfig | undefined
  update: (mutate: (draft: Draft) => void) => void
  engine: EngineKind
}): React.JSX.Element {
  const t = useT()
  return (
    <section className="provider-advanced-section provider-runtime-section" data-provider-runtime-config>
      <div className="provider-advanced-section-title">
        <div>
          <strong>{t('providerRuntimeTitle')}</strong>
          <div className="field-hint">{t('providerRuntimeHint')}</div>
        </div>
        {runtime && Object.keys(runtime).length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => update((draft) => { delete draft.runtime })}>
            {t('providerRuntimeReset')}
          </button>
        )}
      </div>
      <div className="provider-runtime-grid">
        {engine === 'openai' && <SelectField label={t('providerRuntimeReasoning')} value={runtime?.reasoningEffort ?? ''} options={['none', 'minimal', 'low', 'medium', 'high', 'xhigh']} inheritLabel={t('providerRuntimeInherit')} onChange={(value) => update((draft) => updateRuntime(draft, { reasoningEffort: value as ProviderRuntimeConfig['reasoningEffort'] || undefined }))} />}
        {engine === 'openai' && <SelectField label={t('providerRuntimeVerbosity')} value={runtime?.verbosity ?? ''} options={['low', 'medium', 'high']} inheritLabel={t('providerRuntimeInherit')} onChange={(value) => update((draft) => updateRuntime(draft, { verbosity: value as ProviderRuntimeConfig['verbosity'] || undefined }))} />}
        <NumberField label={t('providerRuntimeTemperature')} value={runtime?.temperature} onChange={(value) => update((draft) => updateRuntime(draft, { temperature: value }))} />
        <NumberField label={t('providerRuntimeTopP')} value={runtime?.topP} onChange={(value) => update((draft) => updateRuntime(draft, { topP: value }))} />
        <NumberField label={t('providerRuntimeMaxOutput')} value={runtime?.maxOutputTokens} onChange={(value) => update((draft) => updateRuntime(draft, { maxOutputTokens: value }))} />
        {engine === 'openai' && <SelectField
          label={t('providerRuntimeServiceTier')}
          value={runtime?.serviceTier ?? ''}
          options={['auto', 'default', 'flex', 'priority']}
          inheritLabel={t('providerRuntimeInherit')}
          onChange={(value) => update((draft) => updateRuntime(draft, { serviceTier: value as ProviderRuntimeConfig['serviceTier'] || undefined }))}
        />}
        {engine === 'openai' && <BooleanField label={t('providerRuntimeParallelTools')} value={runtime?.parallelToolCalls} onChange={(value) => update((draft) => updateRuntime(draft, { parallelToolCalls: value }))} />}
        {engine === 'openai' && <BooleanField label={t('providerRuntimeStoreResponses')} value={runtime?.storeResponses} onChange={(value) => update((draft) => updateRuntime(draft, { storeResponses: value }))} />}
      </div>
    </section>
  )
}

function ProviderRuntimeSections({
  runtime,
  update,
  engine
}: {
  runtime: ProviderRuntimeConfig | undefined
  update: (mutate: (draft: Draft) => void) => void
  engine: EngineKind
}): React.JSX.Element {
  return (
    <>
      <RuntimeSection runtime={runtime} update={update} engine={engine} />
      {engine === 'anthropic' && (
        <ProviderAnthropicRuntimeSection
          value={runtime?.anthropic}
          onChange={(anthropic) => update((draft) => updateRuntime(draft, { anthropic }))}
        />
      )}
      {engine === 'gemini' && (
        <ProviderGeminiRuntimeSection
          value={runtime?.gemini}
          onChange={(gemini) => update((draft) => updateRuntime(draft, { gemini }))}
        />
      )}
    </>
  )
}

function EndpointSection({ endpoints, update }: { endpoints: ProviderEndpointProfile[]; update: (mutate: (draft: Draft) => void) => void }): React.JSX.Element {
  const t = useT()
  return (
    <section className="provider-advanced-section" data-provider-endpoint-config>
      <div className="provider-advanced-section-title"><strong>{t('providerEndpointProfiles')}</strong><button type="button" className="btn btn-ghost btn-sm" onClick={() => update((draft) => {
        const next = [...(draft.endpoints ?? [])]
        next.push({ id: `endpoint-${next.length + 1}`, url: 'https://api.example.com/v1', enabled: true })
        draft.endpoints = next
      })}>{t('providerAddEndpoint')}</button></div>
      {endpoints.length === 0 && <div className="field-hint">{t('providerEndpointEmpty')}</div>}
      {endpoints.map((endpoint, index) => (
        <div className="provider-advanced-row" key={`${endpoint.id}-${index}`}>
          <input className="input" aria-label={t('providerEndpointId')} value={endpoint.id} onChange={(event) => update((draft) => updateEndpoint(draft, index, { id: event.target.value }))} placeholder="id" />
          <input className="input provider-advanced-url" aria-label={t('providerEndpointUrl')} value={endpoint.url} onChange={(event) => update((draft) => updateEndpoint(draft, index, { url: event.target.value }))} placeholder="https://api.example.com/v1" />
          <select className="select" aria-label={t('providerEndpointProtocol')} value={endpoint.protocol ?? ''} onChange={(event) => update((draft) => updateEndpoint(draft, index, { protocol: event.target.value ? event.target.value as ProviderEndpointProfile['protocol'] : undefined }))}>
            <option value="">{t('providerDefault')}</option><option value="responses">Responses</option><option value="chat">Chat</option>
          </select>
          <input className="input" aria-label={t('providerEndpointRegion')} value={endpoint.region ?? ''} onChange={(event) => update((draft) => updateEndpoint(draft, index, { region: event.target.value || undefined }))} placeholder={t('providerEndpointRegion')} />
          <input className="input" aria-label={t('providerEndpointDomain')} value={endpoint.domain ?? ''} onChange={(event) => update((draft) => updateEndpoint(draft, index, { domain: event.target.value || undefined }))} placeholder={t('providerEndpointDomain')} />
          <input className="input" aria-label={t('providerEndpointPermissionTags')} value={(endpoint.permissionTags ?? []).join(', ')} onChange={(event) => update((draft) => updateEndpoint(draft, index, { permissionTags: splitList(event.target.value) }))} placeholder={t('providerEndpointPermissionTags')} />
          <input className="input" type="number" step="1" aria-label={t('providerEndpointPriority')} value={endpoint.priority ?? ''} onChange={(event) => update((draft) => updateEndpoint(draft, index, { priority: numberOrUndefined(event.target.value) }))} placeholder={t('providerEndpointPriority')} />
          <label className="settings-check"><input type="checkbox" checked={endpoint.enabled !== false} onChange={(event) => update((draft) => updateEndpoint(draft, index, { enabled: event.target.checked }))} /> {t('providerEnabled')}</label>
          <button type="button" className="btn btn-ghost btn-sm" aria-label={t('providerRemoveEndpoint')} onClick={() => update((draft) => removeAt(draft, 'endpoints', index))}>{t('providerRemoveEndpoint')}</button>
        </div>
      ))}
    </section>
  )
}

function ReliabilitySection({
  reliability,
  update
}: {
  reliability: ProviderReliabilityConfig | undefined
  update: (mutate: (draft: Draft) => void) => void
}): React.JSX.Element {
  const t = useT()
  const circuit = reliability?.circuitBreaker
  return (
    <section className="provider-advanced-section provider-reliability-section" data-provider-reliability-config>
      <div className="provider-advanced-section-title">
        <div>
          <strong>{t('providerReliabilityTitle')}</strong>
          <div className="field-hint">{t('providerReliabilityHint')}</div>
        </div>
        {reliability && Object.keys(reliability).length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => update((draft) => { delete draft.reliability })}>
            {t('providerReliabilityReset')}
          </button>
        )}
      </div>
      <div className="provider-reliability-grid">
        <BooleanField
          label={t('providerReliabilityFailover')}
          value={reliability?.failoverEnabled}
          onChange={(value) => update((draft) => updateReliability(draft, { failoverEnabled: value }))}
        />
        <NumberField
          label={t('providerReliabilityMaxRetries')}
          value={reliability?.maxRetries}
          min={0}
          max={20}
          step={1}
          onChange={(value) => update((draft) => updateReliability(draft, { maxRetries: value }))}
        />
        <NumberField
          label={t('providerReliabilityFirstByteTimeout')}
          value={reliability?.streamingFirstByteTimeoutSeconds}
          min={1}
          max={3600}
          step={1}
          onChange={(value) => update((draft) => updateReliability(draft, { streamingFirstByteTimeoutSeconds: value }))}
        />
        <NumberField
          label={t('providerReliabilityIdleTimeout')}
          value={reliability?.streamingIdleTimeoutSeconds}
          min={1}
          max={3600}
          step={1}
          onChange={(value) => update((draft) => updateReliability(draft, { streamingIdleTimeoutSeconds: value }))}
        />
        <NumberField
          label={t('providerReliabilityRequestTimeout')}
          value={reliability?.requestTimeoutSeconds}
          min={1}
          max={3600}
          step={1}
          onChange={(value) => update((draft) => updateReliability(draft, { requestTimeoutSeconds: value }))}
        />
      </div>
      <label className="provider-reliability-toggle">
        <input
          type="checkbox"
          checked={Boolean(circuit)}
          onChange={(event) => update((draft) => setReliabilityCircuit(draft, event.target.checked))}
        />
        <span><strong>{t('providerReliabilityCircuitOverride')}</strong><small>{t('providerReliabilityCircuitHint')}</small></span>
      </label>
      {circuit && (
        <div className="provider-reliability-grid provider-circuit-grid" data-provider-circuit-config>
          <NumberField label={t('providerCircuitFailureThreshold')} value={circuit.failureThreshold} min={1} max={20} step={1} onChange={(value) => update((draft) => updateReliabilityCircuit(draft, { failureThreshold: value ?? DEFAULT_CIRCUIT_BREAKER.failureThreshold }))} />
          <NumberField label={t('providerCircuitSuccessThreshold')} value={circuit.successThreshold} min={1} max={10} step={1} onChange={(value) => update((draft) => updateReliabilityCircuit(draft, { successThreshold: value ?? DEFAULT_CIRCUIT_BREAKER.successThreshold }))} />
          <NumberField label={t('providerCircuitTimeout')} value={circuit.timeoutSeconds} min={0} max={300} step={1} onChange={(value) => update((draft) => updateReliabilityCircuit(draft, { timeoutSeconds: value ?? DEFAULT_CIRCUIT_BREAKER.timeoutSeconds }))} />
          <PercentField label={t('providerCircuitErrorRate')} value={circuit.errorRateThreshold} onChange={(value) => update((draft) => updateReliabilityCircuit(draft, { errorRateThreshold: value }))} />
          <NumberField label={t('providerCircuitMinRequests')} value={circuit.minRequests} min={1} max={100} step={1} onChange={(value) => update((draft) => updateReliabilityCircuit(draft, { minRequests: value ?? DEFAULT_CIRCUIT_BREAKER.minRequests }))} />
        </div>
      )}
    </section>
  )
}

function ModelSection({
  models,
  availableModelCount,
  catalogBusy,
  notice,
  onSync,
  onImport,
  update
}: {
  models: ProviderModelProfile[]
  availableModelCount: number
  catalogBusy: boolean
  notice: { tone: 'ok' | 'warning'; text: string } | null
  onSync: () => void
  onImport: () => void
  update: (mutate: (draft: Draft) => void) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <section className="provider-advanced-section provider-model-catalog" data-provider-model-catalog>
      <div className="provider-advanced-section-title">
        <div>
          <strong>{t('providerModelProfilesTitle')}</strong>
          <div className="field-hint">{t('providerModelProfilesSummary', { profiles: models.length, discovered: availableModelCount })}</div>
        </div>
        <div className="provider-model-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onSync} disabled={availableModelCount === 0} title={t('providerSyncModelsTitle')}>
            <RefreshCw size={14} aria-hidden="true" /> {t('providerSyncModels')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onImport} disabled={catalogBusy} title={t('providerImportPricingTitle')}>
            <Download size={14} aria-hidden="true" /> {catalogBusy ? t('providerImportingPricing') : t('providerImportPricing')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => update((draft) => {
            const next = [...(draft.modelProfiles ?? [])]
            next.push({ model: `new-model-${next.length + 1}` })
            draft.modelProfiles = next
          })} title={t('providerAddModel')}>
            <Plus size={14} aria-hidden="true" /> {t('providerAddModel')}
          </button>
        </div>
      </div>
      <div className="provider-model-catalog-note">{t('providerPricingCatalogPrivacy')}</div>
      <ProviderModelCapabilitySummary profiles={models} compact />
      {notice && <div className={`field-hint ${notice.tone === 'ok' ? 'field-hint-ok' : 'field-hint-warning'}`}>{notice.text}</div>}
      {models.length === 0 && <div className="field-hint">{t('providerModelProfilesEmpty')}</div>}
      {models.map((model, index) => (
        <div className="provider-advanced-model" key={`${model.model}-${index}`}>
          <div className="provider-advanced-row">
            <input className="input" aria-label={t('providerModelId')} value={model.model} onChange={(event) => update((draft) => updateModel(draft, index, { model: event.target.value }))} placeholder="model id" />
            <input className="input" aria-label={t('providerModelDisplayName')} value={model.displayName ?? ''} onChange={(event) => update((draft) => updateModel(draft, index, { displayName: event.target.value || undefined }))} placeholder={t('providerModelDisplayName')} />
            <button type="button" className="btn btn-ghost btn-icon-sm" aria-label={t('providerRemoveModel')} title={t('providerRemoveModel')} onClick={() => update((draft) => removeAt(draft, 'modelProfiles', index))}><Trash2 size={14} aria-hidden="true" /></button>
          </div>
          <div className="provider-advanced-row">
            <input className="input" aria-label={t('providerModelAliases')} value={(model.aliases ?? []).join(', ')} onChange={(event) => update((draft) => updateModel(draft, index, { aliases: splitList(event.target.value) }))} placeholder={t('providerModelAliasesPlaceholder')} />
            <input className="input" type="number" min="1" aria-label={t('providerModelContextWindow')} value={model.contextWindow ?? ''} onChange={(event) => update((draft) => updateModel(draft, index, { contextWindow: numberOrUndefined(event.target.value) }))} placeholder={t('providerModelContextWindow')} />
            <input className="input" aria-label={t('providerModelCapabilities')} value={(model.capabilities ?? []).join(', ')} onChange={(event) => update((draft) => updateModel(draft, index, { capabilities: splitList(event.target.value) }))} placeholder={t('providerModelCapabilitiesPlaceholder')} />
          </div>
          <ProviderMediaModelFields model={model} onChange={(patch) => update((draft) => updateModel(draft, index, patch))} />
          <div className="provider-advanced-pricing">
            <div className="provider-pricing-meta">
              <span className="provider-pricing-unit">USD / 1M tokens</span>
              {model.pricing && <span className={`provider-pricing-source provider-pricing-source-${model.pricing.source}`}>{t(`providerPricingSource_${model.pricing.source}`)}</span>}
            </div>
            <div className="provider-pricing-fields">
              <NumberField label={t('providerPricingInput')} value={model.pricing?.inputPerMillion} onChange={(value) => update((draft) => updatePricing(draft, index, 'inputPerMillion', value))} />
              <NumberField label={t('providerPricingOutput')} value={model.pricing?.outputPerMillion} onChange={(value) => update((draft) => updatePricing(draft, index, 'outputPerMillion', value))} />
              <NumberField label={t('providerPricingCacheRead')} value={model.pricing?.cacheReadPerMillion} onChange={(value) => update((draft) => updatePricing(draft, index, 'cacheReadPerMillion', value))} />
              <NumberField label={t('providerPricingCacheWrite')} value={model.pricing?.cacheWritePerMillion} onChange={(value) => update((draft) => updatePricing(draft, index, 'cacheWritePerMillion', value))} />
            </div>
          </div>
        </div>
      ))}
    </section>
  )
}

function AppBindingSection({ bindings, update }: { bindings: Record<string, ProviderAppBinding>; update: (mutate: (draft: Draft) => void) => void }): React.JSX.Element {
  const t = useT()
  const entries = Object.entries(bindings)
  return (
    <section className="provider-advanced-section">
      <div className="provider-advanced-section-title"><strong>{t('providerAppBindings')}</strong><button type="button" className="btn btn-ghost btn-sm" onClick={() => update((draft) => {
        const next = { ...(draft.appBindings ?? {}) }
        next[`app-${Object.keys(next).length + 1}`] = {}
        draft.appBindings = next
      })}>{t('providerAddAppBinding')}</button></div>
      {entries.map(([app, binding], index) => (
        <div className="provider-advanced-row" key={`${app}-${index}`}>
          <input className="input" aria-label={t('providerAppId')} value={app} onChange={(event) => update((draft) => renameBinding(draft, app, event.target.value))} placeholder="app id" />
          <input className="input" aria-label={t('providerAccountId')} value={binding.accountId ?? ''} onChange={(event) => update((draft) => updateBinding(draft, app, { accountId: event.target.value || undefined }))} placeholder={t('providerAccountId')} />
          <input className="input" aria-label={t('providerEndpointId')} value={binding.endpointId ?? ''} onChange={(event) => update((draft) => updateBinding(draft, app, { endpointId: event.target.value || undefined }))} placeholder={t('providerEndpointId')} />
          <input className="input" aria-label={t('providerModelMap')} value={mapToLines(binding.modelMap)} onChange={(event) => update((draft) => updateBinding(draft, app, { modelMap: linesToMap(event.target.value) }))} placeholder="source=target" />
          <button type="button" className="btn btn-ghost btn-sm" aria-label={t('providerRemoveAppBinding')} onClick={() => update((draft) => { const next = { ...(draft.appBindings ?? {}) }; delete next[app]; draft.appBindings = next })}>{t('providerRemoveAppBinding')}</button>
        </div>
      ))}
    </section>
  )
}

function RequestSection({ request, update }: { request: ProviderAdvancedConfig['request']; update: (mutate: (draft: Draft) => void) => void }): React.JSX.Element {
  const t = useT()
  return (
    <section className="provider-advanced-section">
      <strong>{t('providerRequestOverrides')}</strong>
      <MapField label={t('providerRequestHeaders')} value={mapToLines(request?.headers)} onChange={(text) => update((draft) => setNestedMap(draft, 'request', 'headers', linesToMap(text)))} />
      <MapField label={t('providerQueryParameters')} value={mapToLines(request?.query)} onChange={(text) => update((draft) => setNestedMap(draft, 'request', 'query', linesToMap(text)))} />
      <JsonField label={t('providerRequestBodyFields')} value={request?.body} onChange={(value) => update((draft) => setNested(draft, 'request', 'body', value))} />
    </section>
  )
}

function BalanceSection({ balanceQuery, update }: { balanceQuery: ProviderAdvancedConfig['balanceQuery']; update: (mutate: (draft: Draft) => void) => void }): React.JSX.Element {
  const t = useT()
  const response = balanceQuery?.response
  return (
    <section className="provider-advanced-section">
      <strong>{t('providerBalanceQuery')}</strong>
      <div className="provider-advanced-row">
        <input className="input" aria-label={t('providerBalancePath')} value={balanceQuery?.path ?? ''} onChange={(event) => update((draft) => setBalance(draft, { path: event.target.value }))} placeholder="/v1/balance" />
        <select className="select" aria-label={t('providerBalanceMethod')} value={balanceQuery?.method ?? 'GET'} onChange={(event) => update((draft) => setBalance(draft, { method: event.target.value as 'GET' | 'POST' }))}><option>GET</option><option>POST</option></select>
        <select className="select" aria-label={t('providerBalanceCredentialMode')} value={balanceQuery?.credentialMode ?? 'provider'} onChange={(event) => update((draft) => setBalance(draft, { credentialMode: event.target.value as 'provider' | 'none' }))}><option value="provider">{t('providerBalanceUseKey')}</option><option value="none">{t('providerBalanceNoCredentials')}</option></select>
      </div>
      <div className="provider-advanced-row">
        <input className="input" aria-label={t('providerBalanceRemainingPath')} value={response?.remainingPath ?? ''} onChange={(event) => update((draft) => setBalanceResponse(draft, { remainingPath: event.target.value || undefined }))} placeholder="remainingPath /data/remaining" />
        <input className="input" aria-label={t('providerBalanceTotalPath')} value={response?.totalPath ?? ''} onChange={(event) => update((draft) => setBalanceResponse(draft, { totalPath: event.target.value || undefined }))} placeholder="totalPath /data/total" />
        <input className="input" aria-label={t('providerBalanceUsedPath')} value={response?.usedPath ?? ''} onChange={(event) => update((draft) => setBalanceResponse(draft, { usedPath: event.target.value || undefined }))} placeholder="usedPath /data/used" />
        <NumberField label={t('providerBalanceScale')} value={response?.scale} onChange={(value) => update((draft) => setBalanceResponse(draft, { scale: value }))} />
      </div>
      <MapField label={t('providerQueryParameters')} value={mapToLines(balanceQuery?.query)} onChange={(text) => update((draft) => setBalance(draft, { query: linesToMap(text) }))} />
    </section>
  )
}

function BillingQuerySection({
  billingQuery,
  update
}: {
  billingQuery: ProviderAdvancedConfig['billingQuery']
  update: (mutate: (draft: Draft) => void) => void
}): React.JSX.Element {
  const t = useT()
  if (!billingQuery) {
    return (
      <section className="provider-advanced-section" data-provider-billing-query>
        <div className="provider-advanced-section-title">
          <div><strong>{t('providerBillingQueryTitle')}</strong><div className="field-hint">{t('providerBillingQueryHint')}</div></div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => update((draft) => { draft.billingQuery = structuredClone(DEFAULT_BILLING_QUERY) })}>
            <Plus size={14} aria-hidden="true" /> {t('providerBillingQueryEnable')}
          </button>
        </div>
      </section>
    )
  }
  const response = billingQuery.response
  return (
    <section className="provider-advanced-section" data-provider-billing-query>
      <div className="provider-advanced-section-title">
        <div><strong>{t('providerBillingQueryTitle')}</strong><div className="field-hint">{t('providerBillingQueryHint')}</div></div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => update((draft) => { delete draft.billingQuery })}>
          <Trash2 size={14} aria-hidden="true" /> {t('providerBillingQueryClear')}
        </button>
      </div>
      <div className="provider-advanced-row">
        <input className="input" aria-label={t('providerBillingQueryPath')} value={billingQuery.path} onChange={(event) => update((draft) => setBilling(draft, { path: event.target.value }))} placeholder="/v1/billing" />
        <select className="select" aria-label={t('providerBillingQueryMethod')} value={billingQuery.method ?? 'GET'} onChange={(event) => update((draft) => setBillingMethod(draft, event.target.value as 'GET' | 'POST'))}><option>GET</option><option>POST</option></select>
        <select className="select" aria-label={t('providerBillingQueryCredential')} value={billingQuery.credentialMode ?? 'provider'} onChange={(event) => update((draft) => setBilling(draft, { credentialMode: event.target.value as 'provider' | 'none', ...(event.target.value === 'none' ? { keyLabel: undefined } : {}) }))}><option value="provider">{t('providerBalanceUseKey')}</option><option value="none">{t('providerBalanceNoCredentials')}</option></select>
        <input className="input" aria-label={t('providerBillingQueryKeyLabel')} disabled={(billingQuery.credentialMode ?? 'provider') === 'none'} value={billingQuery.keyLabel ?? ''} onChange={(event) => update((draft) => setBilling(draft, { keyLabel: event.target.value || undefined }))} placeholder={t('providerBillingQueryKeyLabel')} />
      </div>
      <BillingPeriodField kind="periodStart" value={billingQuery.periodStart} method={billingQuery.method ?? 'GET'} update={update} />
      <BillingPeriodField kind="periodEnd" value={billingQuery.periodEnd} method={billingQuery.method ?? 'GET'} update={update} />
      <div className="provider-advanced-row">
        <input className="input" aria-label={t('providerBillingItemsPath')} value={response.itemsPath ?? ''} onChange={(event) => update((draft) => setBillingResponse(draft, { itemsPath: event.target.value || undefined }))} placeholder="/data/items" />
        <input className="input" aria-label={t('providerBillingAmountPath')} value={response.amountPath} onChange={(event) => update((draft) => setBillingResponse(draft, { amountPath: event.target.value }))} placeholder="/amount" />
        <input className="input" aria-label={t('providerBillingCurrencyPath')} disabled={response.currency === 'USD'} value={response.currencyPath ?? ''} onChange={(event) => update((draft) => setBillingResponse(draft, { currencyPath: event.target.value || undefined }))} placeholder="/currency" />
        <label className="provider-advanced-field"><span>{t('providerBillingCurrency')}</span><select className="select" value={response.currency ?? 'path'} onChange={(event) => update((draft) => setBillingResponse(draft, event.target.value === 'USD' ? { currency: 'USD', currencyPath: undefined } : { currency: undefined, currencyPath: response.currencyPath ?? '/currency' }))}><option value="USD">USD</option><option value="path">{t('providerBillingCurrencyFromPath')}</option></select></label>
        <NumberField label={t('providerBillingScale')} value={response.scale} min={0.000001} max={1000000} onChange={(value) => update((draft) => setBillingResponse(draft, { scale: value }))} />
      </div>
      <MapField label={t('providerQueryParameters')} value={mapToLines(billingQuery.query)} onChange={(text) => update((draft) => setBilling(draft, { query: linesToMap(text) }))} />
      <MapField label={t('providerRequestHeaders')} value={mapToLines(billingQuery.headers)} onChange={(text) => update((draft) => setBilling(draft, { headers: linesToMap(text) }))} />
      <JsonField label={t('providerRequestBodyFields')} value={billingQuery.body} onChange={(value) => update((draft) => setBilling(draft, { body: value }))} />
    </section>
  )
}

function BillingPeriodField({
  kind,
  value,
  method,
  update
}: {
  kind: 'periodStart' | 'periodEnd'
  value: ProviderBillingQueryConfig['periodStart']
  method: 'GET' | 'POST'
  update: (mutate: (draft: Draft) => void) => void
}): React.JSX.Element {
  const t = useT()
  const isStart = kind === 'periodStart'
  const location = value.target === 'query' ? value.name : value.path
  return (
    <div className="provider-advanced-row provider-billing-period-config">
      <strong>{t(isStart ? 'providerBillingPeriodStart' : 'providerBillingPeriodEnd')}</strong>
      <select className="select" aria-label={t('providerBillingPeriodTarget')} value={value.target} onChange={(event) => update((draft) => setBillingPeriod(draft, kind, event.target.value as 'query' | 'body'))}>
        <option value="query">{t('providerBillingPeriodQuery')}</option>
        <option value="body" disabled={method !== 'POST'}>{t('providerBillingPeriodBody')}</option>
      </select>
      <input className="input" aria-label={t(value.target === 'query' ? 'providerBillingPeriodName' : 'providerBillingPeriodBodyPath')} value={location} onChange={(event) => update((draft) => setBillingPeriodLocation(draft, kind, event.target.value))} placeholder={value.target === 'query' ? (isStart ? 'start_time' : 'end_time') : (isStart ? '/period/start' : '/period/end')} />
      <select className="select" aria-label={t('providerBillingPeriodFormat')} value={value.format} onChange={(event) => update((draft) => setBillingPeriodFormat(draft, kind, event.target.value as ProviderBillingQueryConfig['periodStart']['format']))}><option value="unix-seconds">Unix s</option><option value="unix-ms">Unix ms</option><option value="iso">ISO 8601</option></select>
    </div>
  )
}

function MapSection({ title, value, onChange }: { title: string; value: string; onChange: (value: string) => void }): React.JSX.Element {
  return <section className="provider-advanced-section"><strong>{title}</strong><textarea className="input input-block textarea" rows={2} value={value} onChange={(event) => onChange(event.target.value)} placeholder="key=value" /></section>
}

function MapField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): React.JSX.Element {
  return <label className="provider-advanced-field"><span>{label}</span><textarea className="input input-block textarea" rows={2} value={value} onChange={(event) => onChange(event.target.value)} placeholder="key=value" /></label>
}

function JsonField({ label, value, onChange }: { label: string; value: unknown; onChange: (value: Record<string, unknown> | undefined) => void }): React.JSX.Element {
  const [text, setText] = useState(value ? JSON.stringify(value, null, 2) : '')
  useEffect(() => setText(value ? JSON.stringify(value, null, 2) : ''), [value])
  return <label className="provider-advanced-field"><span>{label}</span><textarea className="input input-block textarea" rows={4} value={text} onChange={(event) => { setText(event.target.value); try { const parsed = event.target.value.trim() ? JSON.parse(event.target.value) : undefined; if (!parsed || (typeof parsed === 'object' && !Array.isArray(parsed))) onChange(parsed) } catch { /* keep editing until valid JSON */ } }} /></label>
}

function NumberField({ label, value, min = 0, max, step = 'any', onChange }: { label: string; value: number | undefined; min?: number; max?: number; step?: number | 'any'; onChange: (value: number | undefined) => void }): React.JSX.Element {
  return <label className="provider-advanced-number"><span>{label}</span><input className="input" type="number" min={min} max={max} step={step} value={value ?? ''} onChange={(event) => onChange(numberOrUndefined(event.target.value))} /></label>
}

function PercentField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }): React.JSX.Element {
  return <label className="provider-advanced-number"><span>{label}</span><input className="input" type="number" min="1" max="100" step="1" value={Math.round(value * 100)} onChange={(event) => { const percent = numberOrUndefined(event.target.value); if (percent !== undefined) onChange(percent / 100) }} /></label>
}

function SelectField({ label, value, options, inheritLabel, onChange }: { label: string; value: string; options: string[]; inheritLabel: string; onChange: (value: string) => void }): React.JSX.Element {
  return <label className="provider-advanced-field"><span>{label}</span><select className="select" value={value} onChange={(event) => onChange(event.target.value)}><option value="">{inheritLabel}</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
}

function BooleanField({ label, value, onChange }: { label: string; value: boolean | undefined; onChange: (value: boolean | undefined) => void }): React.JSX.Element {
  const t = useT()
  return <label className="provider-advanced-field"><span>{label}</span><select className="select" value={value === undefined ? '' : String(value)} onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}><option value="">{t('providerRuntimeInherit')}</option><option value="true">{t('providerRuntimeEnabled')}</option><option value="false">{t('providerRuntimeDisabled')}</option></select></label>
}

function parseDraft(value: string): { draft: Draft; error?: string } {
  if (!value.trim()) return { draft: { schemaVersion: 1 } }
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Advanced config must be a JSON object')
    return { draft: { schemaVersion: 1, ...(parsed as Record<string, unknown>) } as Draft }
  } catch (error) {
    return { draft: { schemaVersion: 1 }, error: error instanceof Error ? error.message : 'Invalid JSON' }
  }
}

function updateEndpoint(draft: Draft, index: number, patch: Partial<ProviderEndpointProfile>): void { draft.endpoints = (draft.endpoints ?? []).map((item, i) => i === index ? { ...item, ...patch } : item) }
function updateModel(draft: Draft, index: number, patch: Partial<ProviderModelProfile>): void { draft.modelProfiles = (draft.modelProfiles ?? []).map((item, i) => i === index ? { ...item, ...patch } : item) }
function updatePricing(draft: Draft, index: number, key: keyof NonNullable<ProviderModelProfile['pricing']>, value: number | undefined): void {
  const models = [...(draft.modelProfiles ?? [])]
  const current = models[index]?.pricing ?? { currency: 'USD' as const, inputPerMillion: 0, outputPerMillion: 0, source: 'user' as const }
  models[index] = { ...models[index], pricing: { ...current, [key]: value, source: 'user', updatedAt: Date.now() } }
  draft.modelProfiles = models
}
function updateBinding(draft: Draft, app: string, patch: Partial<ProviderAppBinding>): void { draft.appBindings = { ...(draft.appBindings ?? {}), [app]: { ...(draft.appBindings?.[app] ?? {}), ...patch } } }
function updateRuntime(draft: Draft, patch: Partial<ProviderRuntimeConfig>): void {
  const next = Object.fromEntries(Object.entries({ ...(draft.runtime ?? {}), ...patch }).filter(([, value]) => value !== undefined)) as ProviderRuntimeConfig
  if (Object.keys(next).length === 0) delete draft.runtime
  else draft.runtime = next
}
function updateReliability(draft: Draft, patch: Partial<ProviderReliabilityConfig>): void {
  const next = Object.fromEntries(Object.entries({ ...(draft.reliability ?? {}), ...patch }).filter(([, value]) => value !== undefined)) as ProviderReliabilityConfig
  if (Object.keys(next).length === 0) delete draft.reliability
  else draft.reliability = next
}
function setReliabilityCircuit(draft: Draft, enabled: boolean): void {
  if (enabled) updateReliability(draft, { circuitBreaker: { ...DEFAULT_CIRCUIT_BREAKER } })
  else updateReliability(draft, { circuitBreaker: undefined })
}
function updateReliabilityCircuit(draft: Draft, patch: Partial<NonNullable<ProviderReliabilityConfig['circuitBreaker']>>): void {
  updateReliability(draft, { circuitBreaker: { ...(draft.reliability?.circuitBreaker ?? DEFAULT_CIRCUIT_BREAKER), ...patch } })
}
function renameBinding(draft: Draft, from: string, to: string): void { const next = { ...(draft.appBindings ?? {}) }; const binding = next[from]; delete next[from]; next[to || from] = binding; draft.appBindings = next }
function setNested(draft: Draft, parent: 'request', key: string, value: unknown): void {
  const next = { ...(draft[parent] as Record<string, unknown> ?? {}) }
  if (value === undefined) delete next[key]
  else next[key] = value
  if (Object.keys(next).length === 0) delete draft[parent]
  else draft[parent] = next as Draft['request']
}
function setNestedMap(draft: Draft, parent: 'request', key: string, value: Record<string, string> | undefined): void { setNested(draft, parent, key, value) }
function setBalance(draft: Draft, patch: Record<string, unknown>): void { draft.balanceQuery = { ...(draft.balanceQuery ?? { path: '', response: { remainingPath: '/remaining' } }), ...patch } }
function setBalanceResponse(draft: Draft, patch: Record<string, unknown>): void { draft.balanceQuery = { ...(draft.balanceQuery ?? { path: '', response: { remainingPath: '/remaining' } }), response: { ...(draft.balanceQuery?.response ?? {}), ...patch } } }
function setBilling(draft: Draft, patch: Partial<ProviderBillingQueryConfig>): void {
  draft.billingQuery = cleanObject<ProviderBillingQueryConfig>({
    ...(draft.billingQuery ?? structuredClone(DEFAULT_BILLING_QUERY)), ...patch
  })
}
function setBillingResponse(draft: Draft, patch: Partial<ProviderBillingQueryConfig['response']>): void {
  const current = draft.billingQuery ?? structuredClone(DEFAULT_BILLING_QUERY)
  draft.billingQuery = {
    ...current,
    response: cleanObject<ProviderBillingQueryConfig['response']>({ ...current.response, ...patch })
  }
}
function setBillingMethod(draft: Draft, method: 'GET' | 'POST'): void {
  const current = draft.billingQuery ?? structuredClone(DEFAULT_BILLING_QUERY)
  draft.billingQuery = {
    ...current,
    method,
    ...(method === 'GET' ? {
      periodStart: toQueryPeriod(current.periodStart, 'start_time'),
      periodEnd: toQueryPeriod(current.periodEnd, 'end_time')
    } : {})
  }
}
function setBillingPeriod(draft: Draft, kind: 'periodStart' | 'periodEnd', target: 'query' | 'body'): void {
  const current = draft.billingQuery ?? structuredClone(DEFAULT_BILLING_QUERY)
  const previous = current[kind]
  const next = target === 'query'
    ? { target, name: kind === 'periodStart' ? 'start_time' : 'end_time', format: previous.format } as const
    : { target, path: kind === 'periodStart' ? '/period/start' : '/period/end', format: previous.format } as const
  draft.billingQuery = { ...current, [kind]: next }
}
function setBillingPeriodLocation(draft: Draft, kind: 'periodStart' | 'periodEnd', location: string): void {
  const current = draft.billingQuery ?? structuredClone(DEFAULT_BILLING_QUERY)
  const previous = current[kind]
  draft.billingQuery = { ...current, [kind]: previous.target === 'query' ? { ...previous, name: location } : { ...previous, path: location } }
}
function setBillingPeriodFormat(draft: Draft, kind: 'periodStart' | 'periodEnd', format: ProviderBillingQueryConfig['periodStart']['format']): void {
  const current = draft.billingQuery ?? structuredClone(DEFAULT_BILLING_QUERY)
  draft.billingQuery = { ...current, [kind]: { ...current[kind], format } }
}
function toQueryPeriod(period: ProviderBillingQueryConfig['periodStart'], fallback: string): ProviderBillingQueryConfig['periodStart'] {
  return period.target === 'query' ? period : { target: 'query', name: fallback, format: period.format }
}
function cleanObject<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
function removeAt(draft: Draft, key: 'endpoints' | 'modelProfiles', index: number): void { draft[key] = (draft[key] as unknown[] ?? []).filter((_, i) => i !== index) as never }
function setOptional(draft: Draft, key: string, value: unknown): void { if (value && typeof value === 'object' && Object.keys(value).length > 0) draft[key] = value; else delete draft[key] }
function splitList(value: string): string[] | undefined { const result = value.split(',').map((item) => item.trim()).filter(Boolean); return result.length ? result : undefined }
function numberOrUndefined(value: string): number | undefined { const n = Number(value); return value.trim() && Number.isFinite(n) ? n : undefined }
function mapToLines(value: Record<string, string> | undefined): string { return Object.entries(value ?? {}).map(([key, item]) => `${key}=${item}`).join('\n') }
function linesToMap(value: string): Record<string, string> | undefined { const result: Record<string, string> = {}; for (const line of value.split(/\r?\n/)) { const index = line.indexOf('='); if (index > 0) result[line.slice(0, index).trim()] = line.slice(index + 1).trim() } return Object.keys(result).length ? result : undefined }
