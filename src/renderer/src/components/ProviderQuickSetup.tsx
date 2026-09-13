import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  LocalComputeActivationOptions,
  LocalComputeActivationResult,
  LocalComputeUnavailableReason,
  ProviderGenerationProbeResult,
  ProviderModelFetchError,
  ProviderModelSuggestedAction,
  ProviderView
} from '../../../shared/types'
import type {
  ProviderAuthorizationService,
  ProviderQuickDeviceAuthorizationView
} from '../../../shared/provider-authorization-types'
import { useT } from '../i18n'
import { PROVIDER_PRESETS, useStore } from '../store'
import ProviderConnectionDiagnostic from './ProviderConnectionDiagnostic'
import ProviderPresetCatalog from './ProviderPresetCatalog'
import ProviderGenerationProbe from './ProviderGenerationProbe'
import ProviderSetupReceipt, { useProviderSetupCompletion } from './ProviderSetupReceipt'

const QUICK_API_PRESETS = PROVIDER_PRESETS.filter((item) => item.key !== 'custom' && item.key !== 'local-openai')

interface ProviderQuickSetupProps {
  onAdvanced: () => void
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

function ProviderConnectionDetails({
  open,
  name,
  baseUrl,
  modelsText,
  busy,
  probingGeneration,
  generationProbe,
  onToggle,
  onNameChange,
  onBaseUrlChange,
  onModelsChange,
  onProbe
}: {
  open: boolean
  name: string
  baseUrl: string
  modelsText: string
  busy: boolean
  probingGeneration: boolean
  generationProbe: ProviderGenerationProbeResult | null
  onToggle: (open: boolean) => void
  onNameChange: (value: string) => void
  onBaseUrlChange: (value: string) => void
  onModelsChange: (value: string) => void
  onProbe: () => void
}): React.JSX.Element {
  const t = useT()
  return <details
    className="provider-quick-connection-details"
    data-provider-quick-connection-details
    open={open}
    onToggle={(event) => onToggle(event.currentTarget.open)}
  >
    <summary>{t('providerQuickConnectionDetails')}</summary>
    <p className="provider-quick-connection-hint">{t('providerQuickConnectionDetailsHint')}</p>
    <div className="provider-quick-api-grid">
      <label className="field-label">
        {t('nameLabel')}
        <input className="input input-block" data-provider-quick-field="name" value={name} onChange={(event) => onNameChange(event.target.value)} />
      </label>
    </div>
    <label className="field-label">
      {t('baseUrlLabel')}
      <input
        className="input input-block"
        data-provider-quick-field="base-url"
        value={baseUrl}
        placeholder="https://your-gateway.example.com"
        onChange={(event) => onBaseUrlChange(event.target.value)}
      />
    </label>
    <label className="field-label">
      {t('providerQuickFallbackModelsLabel')}
      <textarea
        className="input input-block textarea"
        data-provider-quick-field="models"
        rows={3}
        value={modelsText}
        placeholder="gpt-4.1\nclaude-sonnet-4"
        onChange={(event) => onModelsChange(event.target.value)}
      />
    </label>
    <button type="button" className="btn btn-ghost" disabled={busy || probingGeneration || !baseUrl.trim()} onClick={onProbe}>
      {probingGeneration ? t('providerGenerationProbeRunning') : t('providerGenerationProbeButton')}
    </button>
    {generationProbe && <ProviderGenerationProbe result={generationProbe} />}
  </details>
}

function ProviderQuickProtocol({ preset }: { preset: (typeof QUICK_API_PRESETS)[number] }): React.JSX.Element {
  const t = useT()
  return (
        <div className="provider-quick-protocol">
          <span>{preset.engine === 'anthropic'
            ? t('providerEngineAnthropic')
            : preset.engine === 'gemini' ? t('providerEngineGemini') : t('providerEngineOpenAI')}</span>
          {preset.engine === 'openai' && (
            <span>{preset.openaiProtocol === 'chat' ? t('openaiProtocolChat') : t('openaiProtocolResponses')}</span>
          )}
        </div>
  )
}

export default function ProviderQuickSetup({ onAdvanced, onCancel, onSaved, onEditSaved }: ProviderQuickSetupProps): React.JSX.Element {
  const t = useT()
  const setupRef = useRef<HTMLElement>(null)
  const createProvider = useStore((state) => state.createProvider)
  const activateLocalCompute = useStore((state) => state.activateLocalCompute)
  const { saved, complete } = useProviderSetupCompletion()
  const [token, setToken] = useState('')
  const [presetKey, setPresetKey] = useState('caogen-relay')
  const preset = useMemo(
    () => QUICK_API_PRESETS.find((item) => item.key === presetKey) ?? QUICK_API_PRESETS[0],
    [presetKey]
  )
  const [name, setName] = useState(preset?.label ?? '')
  const [baseUrl, setBaseUrl] = useState(preset?.baseUrl ?? '')
  const [modelsText, setModelsText] = useState((preset?.models ?? []).join('\n'))
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

  useEffect(() => {
    if (!diagnostic) return
    setShowConnectionDetails(true)
    const frame = requestAnimationFrame(() => {
      setupRef.current?.querySelector('[data-provider-connection-diagnostic]')?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'center'
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [diagnostic])

  useEffect(() => {
    if (!oauthFlow) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = (): void => {
      timer = setTimeout(async () => {
        try {
          const result = await window.agentDesk.pollQuickProviderAuthorization(oauthFlow.flowId)
          if (cancelled) return
          if (result.status === 'pending') {
            setNextPollAt(result.nextPollAt)
            return
          }
          setOauthFlow(null)
          await complete(result.provider, 'account')
        } catch (cause) {
          if (cancelled) return
          setOauthFlow(null)
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, Math.max(0, nextPollAt - Date.now()))
    }
    poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [nextPollAt, oauthFlow, complete])

  const connectOAuth = async (service: ProviderAuthorizationService): Promise<void> => {
    setOauthBusy(true)
    setError('')
    try {
      const started = await window.agentDesk.startQuickProviderAuthorization(service)
      setOauthFlow(started)
      setNextPollAt(Date.now())
      window.open(started.verificationUri, '_blank', 'noopener,noreferrer')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOauthBusy(false)
    }
  }

  const connectLocal = async (): Promise<void> => {
    setLocalBusy(true)
    setError('')
    try {
      const outcome = await activateQuickLocalCompute(activateLocalCompute)
      setLocalReason(outcome.reason)
      if (outcome.provider) await complete(outcome.provider, 'local')
      else setError(t(providerQuickLocalErrorKey(outcome.reason)))
    } finally {
      setLocalBusy(false)
    }
  }

  const saveProvider = async (models: string[], nextToken: string, source: 'discovered' | 'manual'): Promise<void> => {
    if (!preset) throw new Error(t('providerQuickUnavailable'))
    const created = await createProvider({
      name: name.trim() || preset.label,
      baseUrl: baseUrl.trim(),
      models,
      engine: preset.engine,
      openaiProtocol: preset.openaiProtocol ?? 'chat',
      token: nextToken,
      tokenLabel: t('providerQuickKeyLabel')
    })
    await complete(created, source)
  }

  const connect = async (): Promise<void> => {
    const nextToken = token.trim()
    if (!nextToken) {
      setError(t('providerQuickKeyRequired'))
      return
    }
    if (!preset) {
      setError(t('providerQuickUnavailable'))
      return
    }
    if (!baseUrl.trim()) {
      setError(t('providerQuickBaseUrlRequired'))
      return
    }
    setBusy(true)
    setError('')
    setDiagnostic(null)
    try {
      const discovery = await window.agentDesk.fetchProviderModels({
        baseUrl: baseUrl.trim(),
        token: nextToken,
        credentialHeaderNames: [preset.engine === 'anthropic'
          ? 'x-api-key'
          : preset.engine === 'gemini' ? 'x-goog-api-key' : 'Authorization'],
        engine: preset.engine,
        openaiProtocol: preset.openaiProtocol ?? 'chat',
        authMode: 'api-key'
      })
      if (!discovery.ok || discovery.models.length === 0) {
        if (discovery.error) setDiagnostic(discovery.error)
        else setError(t('providerQuickUnavailable'))
        return
      }
      await saveProvider(discovery.models, nextToken, 'discovered')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const probeGeneration = async (): Promise<void> => {
    const model = modelsText.split(/\r?\n/).map((item) => item.trim()).find(Boolean)
    if (!model) {
      setError(t('providerGenerationProbeModelRequired'))
      setupRef.current?.querySelector<HTMLElement>('[data-provider-quick-field="models"]')?.focus()
      return
    }
    if (!preset) return
    setProbingGeneration(true)
    setGenerationProbe(null)
    setError('')
    try {
      setGenerationProbe(await window.agentDesk.probeProviderGeneration({
        baseUrl: baseUrl.trim(),
        token: token.trim() || undefined,
        credentialHeaderNames: [preset.engine === 'anthropic'
          ? 'x-api-key'
          : preset.engine === 'gemini' ? 'x-goog-api-key' : 'Authorization'],
        engine: preset.engine,
        openaiProtocol: preset.openaiProtocol ?? 'chat',
        authMode: 'api-key',
        model
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setProbingGeneration(false)
    }
  }

  const useManualModels = async (): Promise<void> => {
    const models = modelsText.split(/\r?\n/).map((model) => model.trim()).filter(Boolean)
    if (models.length === 0) {
      setupRef.current?.querySelector<HTMLElement>('[data-provider-quick-field="models"]')?.focus()
      return
    }
    setBusy(true)
    setError('')
    try {
      await saveProvider([...new Set(models)], token.trim(), 'manual')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const selectPreset = (key: string): void => {
    const next = QUICK_API_PRESETS.find((item) => item.key === key)
    if (!next) return
    setPresetKey(next.key)
    setName(next.label)
    setBaseUrl(next.baseUrl)
    setModelsText(next.models.join('\n'))
    setDiagnostic(null)
    setGenerationProbe(null)
    setError('')
  }

  const handleDiagnosticAction = (action: ProviderModelSuggestedAction): void => {
    setShowConnectionDetails(true)
    if (action === 'enter_models_manually') {
      setupRef.current?.querySelector<HTMLElement>('[data-provider-quick-field="models"]')?.focus()
      return
    }
    const field = action === 'enter_credentials' || action === 'review_credentials'
      ? 'api-key'
      : action === 'review_base_url_and_credentials' || action === 'review_configuration'
        ? 'base-url'
        : ''
    if (field) {
      setupRef.current?.querySelector<HTMLElement>(`[data-provider-quick-field="${field}"]`)?.focus()
      return
    }
    void connect()
  }

  if (saved) return <ProviderSetupReceipt {...saved} onDone={onSaved} onEdit={onEditSaved} />

  return (
    <section ref={setupRef} className="provider-editor" aria-label={t('providerQuickTitle')} data-provider-quick-setup>
      <header className="provider-editor-header">
        <button type="button" className="provider-editor-back" aria-label={t('backToProviders')} title={t('backToProviders')} onClick={onCancel}>←</button>
        <h2 className="provider-editor-title">{t('providerQuickTitle')}</h2>
      </header>
      <div className="provider-quick-setup">
        <ProviderQuickAccountOptions oauthFlow={oauthFlow} oauthBusy={oauthBusy} busy={busy} localBusy={localBusy} onConnectOAuth={connectOAuth} onConnectLocal={connectLocal} />
        <div className="provider-quick-divider"><span>{t('providerQuickOrKey')}</span></div>
        <label className="field-label">{t('providerQuickTemplateLabel')}</label>
        <ProviderPresetCatalog compact presets={QUICK_API_PRESETS} onSelect={(next) => selectPreset(next.key)} />
        <ProviderQuickProtocol preset={preset} />
        <label className="field-label" htmlFor="provider-quick-key">{t('apiKeyLabel')}</label>
        <input
          id="provider-quick-key"
          className="input input-block"
          data-provider-quick-field="api-key"
          type="password"
          autoComplete="off"
          value={token}
          placeholder={t('providerQuickKeyPlaceholder')}
          onChange={(event) => { setToken(event.target.value); setDiagnostic(null); setGenerationProbe(null); setError('') }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) void connect()
          }}
        />
        <ProviderConnectionDetails
          open={showConnectionDetails}
          name={name}
          baseUrl={baseUrl}
          modelsText={modelsText}
          busy={busy}
          probingGeneration={probingGeneration}
          generationProbe={generationProbe}
          onToggle={setShowConnectionDetails}
          onNameChange={setName}
          onBaseUrlChange={(value) => { setBaseUrl(value); setDiagnostic(null); setGenerationProbe(null); setError('') }}
          onModelsChange={(value) => { setModelsText(value); setGenerationProbe(null) }}
          onProbe={() => void probeGeneration()}
        />
        {diagnostic && (
          <ProviderConnectionDiagnostic
            error={diagnostic}
            onAction={() => handleDiagnosticAction(diagnostic.suggestedAction)}
          />
        )}
        {diagnostic?.suggestedAction === 'enter_models_manually' && modelsText.trim() && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void useManualModels()}>
            {t('providerQuickUseManualModels')}
          </button>
        )}
        <ProviderQuickErrorNotice error={error} localReason={localReason} />
      </div>
      <div className="provider-editor-actions">
        <button
          className="btn btn-ghost"
          data-provider-quick-action="advanced"
          disabled={oauthBusy || Boolean(oauthFlow)}
          onClick={onAdvanced}
        >
          {t('providerQuickAdvanced')}
        </button>
        <button className="btn btn-primary" data-provider-quick-action="save" disabled={busy || localBusy || oauthBusy || Boolean(oauthFlow)} onClick={() => void connect()}>
          {busy ? t('providerQuickConnecting') : t('providerQuickConnect')}
        </button>
      </div>
    </section>
  )
}
