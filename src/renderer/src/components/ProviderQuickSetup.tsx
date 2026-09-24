import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  LocalComputeActivationOptions,
  LocalComputeActivationResult,
  LocalComputeUnavailableReason,
  ProviderGenerationProbeResult,
  ProviderModelFetchError,
  ProviderModelSuggestedAction,
  ProviderView,
  ProviderInput
} from '../../../shared/types'
import type {
  ProviderAuthorizationService,
  ProviderQuickDeviceAuthorizationView
} from '../../../shared/provider-authorization-types'
import { useT } from '../i18n'
import { PROVIDER_PRESETS, useStore, type ProviderPreset } from '../store'
import ProviderConnectionDiagnostic from './ProviderConnectionDiagnostic'
import ProviderPresetCatalog from './ProviderPresetCatalog'
import ProviderGenerationProbe from './ProviderGenerationProbe'
import ProviderSetupReceipt, { useProviderSetupCompletion } from './ProviderSetupReceipt'

const QUICK_API_PRESETS = PROVIDER_PRESETS
type QuickProtocol = 'chat' | 'responses' | 'anthropic' | 'gemini'

function presetProtocol(preset: ProviderPreset): QuickProtocol {
  return preset.engine === 'openai' ? preset.openaiProtocol ?? 'chat' : preset.engine
}

interface ProviderQuickSetupProps {
  onAdvanced: (draft?: ProviderInput) => void
  onCancel: () => void
  onSaved: (provider: ProviderView) => void
  onEditSaved: (provider: ProviderView) => void
}

function providerQuickLocalErrorKey(reason: LocalComputeUnavailableReason | null | undefined):
  | 'providerQuickLocalRuntimeMissing'
  | 'providerQuickLocalRuntimeStartFailed'
  | 'providerQuickLocalModelMissing'
  | 'providerQuickLocalUnavailable' {
  if (reason === 'runtime-missing') return 'providerQuickLocalRuntimeMissing'
  if (reason === 'runtime-stopped') return 'providerQuickLocalRuntimeStartFailed'
  if (reason === 'model-missing') return 'providerQuickLocalModelMissing'
  return 'providerQuickLocalUnavailable'
}

function ProviderQuickErrorNotice({
  error,
  localReason
}: {
  error: string
  localReason: LocalComputeUnavailableReason | null
}): React.JSX.Element | null {
  const t = useT()
  if (!error) return null
  const help = localReason === 'runtime-missing'
    ? { href: 'https://ollama.com/download', label: t('assistantInstallOllama') }
    : localReason === 'model-missing'
      ? { href: 'https://ollama.com/library', label: t('assistantBrowseOllamaModels') }
      : null
  return (
    <div className="notice notice-error" role="alert" data-local-compute-reason={localReason ?? undefined}>
      <span>{error}</span>
      {help && (
        <a className="btn btn-ghost btn-sm" href={help.href} target="_blank" rel="noreferrer">
          {help.label}
        </a>
      )}
    </div>
  )
}

interface QuickLocalOutcome {
  provider: ProviderView | null
  reason: LocalComputeUnavailableReason | null
}

async function activateQuickLocalCompute(
  activate: (options?: LocalComputeActivationOptions) => Promise<LocalComputeActivationResult>
): Promise<QuickLocalOutcome> {
  try {
    const result = await activate({ startInstalled: true })
    return result.status === 'activated' && result.provider
      ? { provider: result.provider, reason: null }
      : { provider: null, reason: result.reason ?? null }
  } catch {
    return { provider: null, reason: null }
  }
}

function ProviderQuickAccountOptions({ oauthFlow, oauthBusy, busy, localBusy, onConnectOAuth, onConnectLocal }: {
  oauthFlow: ProviderQuickDeviceAuthorizationView | null
  oauthBusy: boolean
  busy: boolean
  localBusy: boolean
  onConnectOAuth: (service: ProviderAuthorizationService) => Promise<void>
  onConnectLocal: () => Promise<void>
}): React.JSX.Element {
  const t = useT()
  const services = [
    ['xai-oauth', 'providerQuickXaiName', 'providerQuickXaiHint', 'providerQuickXaiConnect']
  ] as const
  return <>
    <div className="provider-quick-heading"><span className="provider-quick-badge">{t('providerQuickRecommended')}</span><strong>{t('providerQuickAccountTitle')}</strong></div>
    {!oauthFlow && <div className="provider-quick-oauth-options">
      {services.map(([service, nameKey, hintKey, actionKey]) => <div className="provider-quick-oauth-option" key={service}>
        <div><strong>{t(nameKey)}</strong><span>{t(hintKey)}</span></div>
        <button type="button" className="btn btn-ghost btn-sm" disabled={oauthBusy || busy || localBusy} onClick={() => void onConnectOAuth(service)}>{oauthBusy ? t('providerQuickOAuthStarting') : t(actionKey)}</button>
      </div>)}
    </div>}
    {oauthFlow && <div className="provider-authorization-device provider-quick-device" data-provider-quick-authorization-flow>
      <code>{oauthFlow.userCode}</code>
      <a href={oauthFlow.verificationUri} target="_blank" rel="noreferrer">{t('providerAuthorizationOpenPage')}</a>
      <span>{t('providerAuthorizationWaiting')}</span>
    </div>}
    <div className="provider-quick-divider"><span>{t('providerQuickOtherWays')}</span></div>
    <button type="button" className="btn btn-ghost provider-quick-local" disabled={localBusy || busy || oauthBusy || Boolean(oauthFlow)} onClick={() => void onConnectLocal()}>
      {localBusy ? t('assistantComputeCheckingLocal') : t('providerQuickUseLocal')}
    </button>
  </>
}

function modelNames(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map(value => value.trim()).filter(Boolean))]
}

function ModelChoices({ preset, value, onChange }: { preset: ProviderPreset; value: string; onChange(value: string): void }): React.JSX.Element {
  const t = useT()
  const selected = modelNames(value)
  const manualField = <textarea className="input input-block textarea" data-provider-quick-field="models" rows={3} value={value}
    aria-label={t('providerSimpleModels')} placeholder={t('providerSimpleModelPlaceholder')} onChange={event => onChange(event.target.value)} />
  return <>
    {preset.models.length > 0 && <div className="provider-simple-model-options">
      {preset.models.map(model => <label key={model}><input type="checkbox" checked={selected.includes(model)}
        onChange={event => onChange((event.target.checked ? [...selected, model] : selected.filter(item => item !== model)).join('\n'))} />{model}</label>)}
    </div>}
    {preset.models.length ? <details className="provider-simple-manual-models">
      <summary>{t('providerSimpleOtherModels')}</summary>{manualField}
    </details> : manualField}
  </>
}

export default function ProviderQuickSetup({ onAdvanced, onCancel, onSaved, onEditSaved }: ProviderQuickSetupProps): React.JSX.Element {
  const t = useT()
  const setupRef = useRef<HTMLElement>(null)
  const connecting = useRef(false)
  const createProvider = useStore(state => state.createProvider)
  const activateLocalCompute = useStore(state => state.activateLocalCompute)
  const { saved, complete } = useProviderSetupCompletion()
  const [presetKey, setPresetKey] = useState('')
  const preset = useMemo(() => QUICK_API_PRESETS.find(item => item.key === presetKey), [presetKey])
  const [choosing, setChoosing] = useState(true)
  const [token, setToken] = useState('')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelsText, setModelsText] = useState('')
  const [protocol, setProtocol] = useState<QuickProtocol>('chat')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [diagnostic, setDiagnostic] = useState<ProviderModelFetchError | null>(null)
  const [generationProbe, setGenerationProbe] = useState<ProviderGenerationProbeResult | null>(null)
  const [probingGeneration, setProbingGeneration] = useState(false)
  const [localBusy, setLocalBusy] = useState(false)
  const [localReason, setLocalReason] = useState<LocalComputeUnavailableReason | null>(null)
  const [oauthBusy, setOauthBusy] = useState(false)
  const [oauthFlow, setOauthFlow] = useState<ProviderQuickDeviceAuthorizationView | null>(null)
  const [nextPollAt, setNextPollAt] = useState(0)
  const [showConnectionDetails, setShowConnectionDetails] = useState(false)
  const pending = busy || localBusy || oauthBusy || Boolean(oauthFlow) || probingGeneration
  const authMode = preset?.auth === 'none' ? 'none' : 'api-key'
  const engine = protocol === 'anthropic' || protocol === 'gemini' ? protocol : 'openai'
  const credentialHeaderNames = preset?.key === 'custom' ? [engine === 'anthropic'
    ? 'x-api-key' : engine === 'gemini' ? 'x-goog-api-key' : 'authorization'] : preset?.credentialHeaderNames

  useEffect(() => {
    if (!diagnostic) return
    setShowConnectionDetails(true)
    const frame = requestAnimationFrame(() => setupRef.current?.querySelector('[data-provider-connection-diagnostic]')?.scrollIntoView({ block: 'nearest' }))
    return () => cancelAnimationFrame(frame)
  }, [diagnostic])

  useEffect(() => {
    if (!oauthFlow) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const result = await window.agentDesk.pollQuickProviderAuthorization(oauthFlow.flowId)
        if (cancelled) return
        if (result.status === 'pending') { setNextPollAt(result.nextPollAt); return }
        setOauthFlow(null)
        await complete(result.provider, 'account')
      } catch (cause) {
        if (!cancelled) { setOauthFlow(null); setError(cause instanceof Error ? cause.message : String(cause)) }
      }
    }, Math.max(0, nextPollAt - Date.now()))
    return () => { cancelled = true; clearTimeout(timer) }
  }, [nextPollAt, oauthFlow, complete])

  const connectOAuth = async (service: ProviderAuthorizationService): Promise<void> => {
    if (pending) return
    setOauthBusy(true); setError('')
    try {
      const started = await window.agentDesk.startQuickProviderAuthorization(service)
      setOauthFlow(started); setNextPollAt(Date.now())
      window.open(started.verificationUri, '_blank', 'noopener,noreferrer')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setOauthBusy(false) }
  }
  const connectLocal = async (): Promise<void> => {
    if (pending) return
    setLocalBusy(true); setError('')
    try {
      const outcome = await activateQuickLocalCompute(activateLocalCompute)
      setLocalReason(outcome.reason)
      if (outcome.provider) await complete(outcome.provider, 'local')
      else setError(t(providerQuickLocalErrorKey(outcome.reason)))
    } finally { setLocalBusy(false) }
  }
  const input = (models = modelNames(modelsText)): ProviderInput | undefined => preset ? {
    name: name.trim() || preset.label, baseUrl: baseUrl.trim(), models,
    engine, openaiProtocol: protocol === 'responses' ? 'responses' : 'chat', authMode,
    credentialHeaderNames, ...(authMode === 'api-key' ? { token: token.trim(), tokenLabel: t('providerQuickKeyLabel') } : {})
  } : undefined

  const validConnection = (): boolean => {
    if (!preset) { setError(t('providerSimpleSelectFirst')); return false }
    if (!baseUrl.trim()) { setError(t('providerQuickBaseUrlRequired')); return false }
    if (authMode === 'api-key' && !token.trim()) { setError(t('providerQuickKeyRequired')); return false }
    return true
  }
  const connect = async (manual = false): Promise<void> => {
    if (connecting.current || pending || !validConnection()) return
    const request = input()!
    if ((manual || preset?.requiresModelId) && !request.models.length) {
      setError(t('providerSimpleModelRequired')); return
    }
    connecting.current = true; setBusy(true); setError(''); setDiagnostic(null)
    try {
      if (!manual && !preset?.requiresModelId) {
        const discovery = await window.agentDesk.fetchProviderModels({
          baseUrl: request.baseUrl, token: request.token, credentialHeaderNames: request.credentialHeaderNames,
          engine: request.engine, openaiProtocol: request.openaiProtocol, authMode: request.authMode
        })
        if (!discovery.ok || !discovery.models.length) {
          if (discovery.error) setDiagnostic(discovery.error)
          else { setError(t('providerQuickUnavailable')); setShowConnectionDetails(true) }
          return
        }
        request.models = discovery.models
      }
      const created = await createProvider(request)
      setToken('')
      await complete(created, manual || preset?.requiresModelId ? 'manual' : authMode === 'none' ? 'local' : 'discovered')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { connecting.current = false; setBusy(false) }
  }
  const probeGeneration = async (): Promise<void> => {
    if (pending || !validConnection()) return
    const model = modelNames(modelsText)[0]
    if (!model) { setError(t('providerGenerationProbeModelRequired')); return }
    const request = input()!
    setProbingGeneration(true); setGenerationProbe(null); setError('')
    try {
      setGenerationProbe(await window.agentDesk.probeProviderGeneration({
        baseUrl: request.baseUrl, token: request.token, credentialHeaderNames: request.credentialHeaderNames,
        engine: request.engine, openaiProtocol: request.openaiProtocol, authMode: request.authMode, model
      }))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setProbingGeneration(false) }
  }
  const selectPreset = (next: ProviderPreset): void => {
    if (pending) return
    if (next.key !== presetKey) setToken('')
    setPresetKey(next.key); setName(next.label); setBaseUrl(next.baseUrl); setModelsText(next.models.join('\n'))
    setProtocol(presetProtocol(next))
    setChoosing(false); setDiagnostic(null); setGenerationProbe(null); setError(''); setLocalReason(null); setShowConnectionDetails(false)
    requestAnimationFrame(() => setupRef.current?.querySelector<HTMLInputElement>(next.requiresBaseUrl
      ? '[data-provider-quick-field="base-url"]' : '[data-provider-quick-field="api-key"]')?.focus())
  }
  const handleDiagnosticAction = (action: ProviderModelSuggestedAction): void => {
    setShowConnectionDetails(true)
    const field = action === 'enter_models_manually' ? 'models'
      : action === 'enter_credentials' || action === 'review_credentials' ? 'api-key'
      : action === 'review_base_url_and_credentials' || action === 'review_configuration' ? 'base-url' : ''
    if (field) requestAnimationFrame(() => {
      const target = setupRef.current?.querySelector<HTMLElement>(`[data-provider-quick-field="${field}"]`)
      const modelDetails = target?.closest('details.provider-simple-manual-models')
      if (modelDetails instanceof HTMLDetailsElement) modelDetails.open = true
      target?.focus()
    })
    else void connect()
  }

  if (saved) return <ProviderSetupReceipt {...saved} onDone={onSaved} onEdit={onEditSaved} />
  return <section ref={setupRef} className="provider-editor" aria-label={t('providerQuickTitle')} data-provider-quick-setup>
    <header className="provider-editor-header">
      <button type="button" className="provider-editor-back" disabled={pending} aria-label={t('backToProviders')} onClick={onCancel}>←</button>
      <h2 className="provider-editor-title">{t('providerQuickTitle')}</h2>
    </header>
    <div className="provider-quick-setup">
      <p className="provider-simple-intro">{t('providerSimpleIntro')}</p>
      {choosing && <ProviderPresetCatalog compact presets={QUICK_API_PRESETS} selectedKey={presetKey} disabled={pending} onSelect={selectPreset} />}
      {preset && !choosing && <>
        <div className="provider-simple-selection" data-provider-selected={preset.key}>
          <div><strong>{preset.label}</strong><code>{baseUrl || t('providerSimpleAddressHint')}</code>
            {preset.docsUrl && <a className="provider-simple-docs" href={preset.docsUrl} target="_blank" rel="noreferrer">{t('providerSimpleDocs')}</a>}</div>
          <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => setChoosing(true)}>{t('providerSimpleChange')}</button>
        </div>
        <fieldset className="provider-simple-fields" disabled={pending}>
          {preset.requiresBaseUrl && <label className="field-label">{t('providerSimpleAddress')}
            <input className="input input-block" data-provider-quick-field="base-url" value={baseUrl}
              placeholder={preset.baseUrlPlaceholder || 'https://your-service.example.com/v1'}
              onChange={event => { setBaseUrl(event.target.value); setDiagnostic(null); setGenerationProbe(null) }} /></label>}
          {preset.key === 'custom' && <label className="field-label">{t('providerSimpleProtocol')}
            <select className="select select-block" data-provider-quick-field="protocol" value={protocol}
              onChange={event => {
                setProtocol(event.target.value as QuickProtocol); setModelsText(''); setDiagnostic(null); setGenerationProbe(null)
              }}>
              <option value="chat">OpenAI Chat Completions</option>
              <option value="responses">OpenAI Responses</option>
              <option value="anthropic">Anthropic Messages</option>
              <option value="gemini">Google Gemini</option>
            </select>
            <span className="field-hint">{t('providerSimpleProtocolHint')}</span>
          </label>}
          {authMode === 'none' ? <p className="field-hint">{t('providerSimpleLocal')}</p> : <>
            <div className="provider-simple-key-heading"><label className="field-label" htmlFor="provider-quick-key">{t('apiKeyLabel')}</label>
              {preset.apiKeyUrl && <a href={preset.apiKeyUrl} target="_blank" rel="noreferrer">{t('providerSimpleGetKey')}</a>}</div>
            <input id="provider-quick-key" className="input input-block" data-provider-quick-field="api-key" type="password" autoComplete="off"
              value={token} placeholder={t('providerQuickKeyPlaceholder')}
              onChange={event => { setToken(event.target.value); setDiagnostic(null); setGenerationProbe(null); setError('') }}
              onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void connect() }} />
          </>}
          {preset.requiresModelId ? <>
            <label className="field-label">{t('providerSimpleModels')}</label>
            <p className="field-hint">{t('providerSimpleModelsHint')}</p>
            <ModelChoices preset={preset} value={modelsText} onChange={value => { setModelsText(value); setGenerationProbe(null) }} />
          </> : <p className="field-hint">{t('providerSimpleModelsAuto')}</p>}
          <details className="provider-quick-connection-details" data-provider-quick-connection-details open={showConnectionDetails}
            onToggle={event => setShowConnectionDetails(event.currentTarget.open)}>
            <summary>{t('providerQuickConnectionDetails')}</summary>
            <label className="field-label">{t('nameLabel')}<input className="input input-block" data-provider-quick-field="name" value={name} onChange={event => setName(event.target.value)} /></label>
            {!preset.requiresBaseUrl && <label className="field-label">{t('baseUrlLabel')}<input className="input input-block" data-provider-quick-field="base-url" value={baseUrl}
              onChange={event => { setBaseUrl(event.target.value); setDiagnostic(null); setGenerationProbe(null) }} /></label>}
            <div className="provider-quick-protocol"><span>{t(engine === 'anthropic' ? 'providerEngineAnthropic' : engine === 'gemini' ? 'providerEngineGemini' : 'providerEngineOpenAI')}</span>
              {engine === 'openai' && <span>{t(protocol === 'responses' ? 'openaiProtocolResponses' : 'openaiProtocolChat')}</span>}</div>
            {authMode === 'none' && <p className="field-hint">{t('providerSimpleLocalOnly')}</p>}
            {!preset.requiresModelId && <><label className="field-label">{t('providerQuickFallbackModelsLabel')}</label>
              <ModelChoices preset={preset} value={modelsText} onChange={value => { setModelsText(value); setGenerationProbe(null) }} />
              {modelsText.trim() && <><p className="field-hint">{t('providerSimpleManualHint')}</p>
                <button type="button" className="btn btn-ghost" data-provider-quick-action="manual-save" onClick={() => void connect(true)}>{t('providerSimpleManualSave')}</button></>}
            </>}
            <p className="field-hint">{t('providerGenerationProbeBillingNotice')}</p>
            <button type="button" className="btn btn-ghost" disabled={!modelNames(modelsText).length} onClick={() => void probeGeneration()}>{t('providerGenerationProbeButton')}</button>
            {generationProbe && <ProviderGenerationProbe result={generationProbe} />}
          </details>
        </fieldset>
        {diagnostic && <ProviderConnectionDiagnostic error={diagnostic} onAction={() => handleDiagnosticAction(diagnostic.suggestedAction)} />}
      </>}
      <ProviderQuickErrorNotice error={error} localReason={localReason} />
      <details className="provider-simple-other-methods" open={oauthFlow ? true : undefined}>
        <summary>{t('providerSimpleOtherMethods')}</summary>
        <ProviderQuickAccountOptions oauthFlow={oauthFlow} oauthBusy={oauthBusy} busy={busy || probingGeneration} localBusy={localBusy}
          onConnectOAuth={connectOAuth} onConnectLocal={connectLocal} />
      </details>
    </div>
    <div className="provider-editor-actions">
      <button className="btn btn-ghost" data-provider-quick-action="advanced" disabled={pending} onClick={() => onAdvanced(input())}>{t('providerQuickAdvanced')}</button>
      <button className="btn btn-primary" data-provider-quick-action="save" disabled={pending || !preset || choosing} onClick={() => void connect()}>
        {t(busy ? 'providerQuickConnecting' : 'providerQuickConnect')}
      </button>
    </div>
  </section>
}
