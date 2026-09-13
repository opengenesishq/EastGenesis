import { useEffect, useMemo, useRef, useState } from 'react'
import { PROVIDER_PRESETS, useStore } from '../store'
import { useT } from '../i18n'
import ProviderQuickSetup from './ProviderQuickSetup'
import type {
  EngineKind,
  OpenAIProtocol,
  ProviderAuthMode,
  ProviderApiKeyInput,
  ProviderApiKeyUpdateInput,
  ProviderApiKeyView,
  ProviderAdvancedConfig,
  ProviderCredentialRoutingMode,
  ProviderGenerationProbeResult,
  ProviderInput,
  ProviderModelFetchError,
  ProviderModelSuggestedAction,
  ProviderView
} from '../../../shared/types'
import {
  createProviderKeyDrafts,
  providerKeyPolicyFromDraft,
  type ProviderKeyDraft
} from './settings/ProviderSavedKeys'
import ProviderCredentialFields, { ProviderCredentialMigrationNotice } from './settings/ProviderCredentialFields'
import ProviderAuthorizationPanel from './settings/ProviderAuthorizationPanel'
import ProviderBalancePanel from './settings/ProviderBalancePanel'
import ProviderAdvancedConfigEditor from './ProviderAdvancedConfigEditor'
import ProviderConnectionDiagnostic from './ProviderConnectionDiagnostic'
import ProviderPresetCatalog from './ProviderPresetCatalog'
import ProviderGenerationProbe from './ProviderGenerationProbe'

const DEFAULT_PROVIDER_BASE_URL = PROVIDER_PRESETS.find((preset) => preset.key === 'caogen-relay')?.baseUrl ?? ''

interface Props {
  /** null = 新建;否则编辑该 Provider */
  provider: ProviderView | null
  initialDiagnostic?: ProviderModelFetchError
  onClose: (result: ProviderEditorCloseResult) => void
}

export type ProviderEditorCloseResult =
  | { reason: 'cancelled' }
  | { reason: 'saved'; provider: ProviderView }

interface ProviderEditorSaveState {
  provider: ProviderView | null
  name: string
  baseUrl: string
  modelsText: string
  engine: EngineKind
  authMode: ProviderAuthMode
  customHeaders: string
  credentialHeaderNamesText: string
  budgetUsd: string
  openaiProtocol: OpenAIProtocol
  note: string
  token: string
  tokenLabel: string
  tokenTouched: boolean
  additionalKeysText: string
  savedKeys: ProviderApiKeyView[]
  keyDrafts: Record<string, ProviderKeyDraft>
  activeKeyId: string
  credentialRoutingMode: ProviderCredentialRoutingMode
  advancedConfig?: ProviderAdvancedConfig
}

export default function ProviderEditorEntry(props: Props): React.JSX.Element {
  return props.provider
    ? <ProviderEditor {...props} />
    : <NewProviderEditor onClose={props.onClose} />
}

function NewProviderEditor({ onClose }: Pick<Props, 'onClose'>): React.JSX.Element {
  const [advanced, setAdvanced] = useState(false)
  const [savedProvider, setSavedProvider] = useState<ProviderView | null>(null)
  return advanced
    ? <ProviderEditor provider={savedProvider} onClose={onClose} />
    : (
        <ProviderQuickSetup
          onAdvanced={() => setAdvanced(true)}
          onCancel={() => onClose({ reason: 'cancelled' })}
          onSaved={(provider) => onClose({ reason: 'saved', provider })}
          onEditSaved={(provider) => { setSavedProvider(provider); setAdvanced(true) }}
        />
      )
}

function ProviderEditorIntro({ provider, isEdit, presetHint, onClose, onApplyPreset, onNavigate }: {
  provider: ProviderView | null
  isEdit: boolean
  presetHint: string
  onClose: Props['onClose']
  onApplyPreset: (key: string) => void
  onNavigate: (selector: string) => void
}): React.JSX.Element {
  const t = useT()
  return <>
    <header className="provider-editor-header">
      <button type="button" className="provider-editor-back" data-provider-editor-action="back" aria-label={t('backToProviders')} title={t('backToProviders')} onClick={() => onClose({ reason: 'cancelled' })}>←</button>
      <h2 className="provider-editor-title">{isEdit ? t('providerEditTitle') : t('providerAddTitle')}</h2>
    </header>
    {!isEdit && <>
      <label className="field-label">{t('quickTemplate')}</label>
      <ProviderPresetCatalog onSelect={(preset) => onApplyPreset(preset.key)} />
      <p className="provider-gateway-note">{t('gatewayNote1')}<b>{t('gatewayNoteBold')}</b>{t('gatewayNote2')}</p>
    </>}
    {presetHint && <div className="notice notice-info">{presetHint}</div>}
    <ProviderCredentialMigrationNotice provider={provider} />
    <nav className="provider-editor-section-nav" aria-label={t('providerEditorSectionNavigation')}>
      {provider && <button type="button" onClick={() => onNavigate('.provider-authorization')}>{t('providerEditorSectionAuthorization')}</button>}
      <button type="button" onClick={() => onNavigate('[data-provider-field="base-url"]')}>{t('providerEditorSectionConnection')}</button>
      <button type="button" onClick={() => onNavigate('[data-provider-field="models"]')}>{t('providerEditorSectionModels')}</button>
      <button type="button" onClick={() => onNavigate('[data-provider-model-catalog]')}>{t('providerEditorSectionPricing')}</button>
      <button type="button" onClick={() => onNavigate('[data-provider-reliability-config]')}>{t('providerEditorSectionReliability')}</button>
    </nav>
    {provider && <ProviderAuthorizationPanel provider={provider} />}
    {provider && <ProviderBalancePanel provider={provider} />}
  </>
}

function ProviderEditor({ provider, initialDiagnostic, onClose }: Props): React.JSX.Element {
  const t = useT()
  const editorRef = useRef<HTMLElement>(null)
  const createProvider = useStore((s) => s.createProvider)
  const updateProvider = useStore((s) => s.updateProvider)
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? DEFAULT_PROVIDER_BASE_URL)
  const [modelsText, setModelsText] = useState((provider?.models ?? []).join('\n'))
  const [engine, setEngine] = useState<EngineKind>(provider?.engine ?? 'openai')
  const [authMode, setAuthMode] = useState<ProviderAuthMode>(provider?.authMode ?? 'api-key')
  const [customHeaders, setCustomHeaders] = useState(provider?.customHeaders ?? '')
  const [credentialHeaderNamesText, setCredentialHeaderNamesText] = useState(
    (provider?.credentialHeaderNames ?? [defaultCredentialHeaderName(provider?.engine ?? 'openai')]).join('\n')
  )
  const [budgetUsd, setBudgetUsd] = useState(provider?.budgetUsd ? String(provider.budgetUsd) : '')
  const [openaiProtocol, setOpenaiProtocol] = useState<OpenAIProtocol>(provider?.openaiProtocol ?? 'responses')
  const [note, setNote] = useState(provider?.note ?? '')
  const [advancedConfigText, setAdvancedConfigText] = useState(
    provider?.advancedConfig ? JSON.stringify(provider.advancedConfig, null, 2) : ''
  )
  const [token, setToken] = useState('')
  const [tokenLabel, setTokenLabel] = useState(provider?.activeKeyLabel ?? '')
  const [tokenTouched, setTokenTouched] = useState(false)
  const [additionalKeysText, setAdditionalKeysText] = useState('')
  const [activeKeyId, setActiveKeyId] = useState(provider?.activeKeyId ?? '')
  const [credentialRoutingMode, setCredentialRoutingMode] = useState<ProviderCredentialRoutingMode>(initialCredentialRoutingMode(provider))
  const [keyDrafts, setKeyDrafts] = useState<Record<string, ProviderKeyDraft>>(() => createProviderKeyDrafts(provider?.apiKeys ?? []))
  const [presetHint, setPresetHint] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fetching, setFetching] = useState(false)
  const [fetchNote, setFetchNote] = useState('')
  const [fetchError, setFetchError] = useState<ProviderModelFetchError | null>(initialDiagnostic ?? null)
  const [generationProbe, setGenerationProbe] = useState<ProviderGenerationProbeResult | null>(null)
  const [probingGeneration, setProbingGeneration] = useState(false)
  const [modelSourceKey, setModelSourceKey] = useState(() =>
    provider ? providerModelSourceKey(provider.id, provider.baseUrl, provider.engine, provider.openaiProtocol ?? 'responses') : ''
  )
  const isEdit = provider !== null
  const savedKeys = provider?.apiKeys ?? []
  const existingCredentialCount = countExistingProviderCredentials(provider)
  const currentModelSourceKey = useMemo(
    () => providerModelSourceKey(provider?.id, baseUrl, engine, openaiProtocol),
    [provider?.id, baseUrl, engine, openaiProtocol]
  )
  const modelsStale = isProviderModelListStale(modelsText, modelSourceKey, currentModelSourceKey)

  useEffect(() => {
    if (!fetchError) return
    const frame = requestAnimationFrame(() => {
      editorRef.current?.querySelector('[data-provider-connection-diagnostic]')?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'center'
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [fetchError])

  const handleAuthModeChange = (mode: ProviderAuthMode): void => {
    setAuthMode(mode)
    setError('')
    setGenerationProbe(null)
    if (mode !== 'none') return
    setToken('')
    setTokenTouched(false)
    setTokenLabel('')
    setAdditionalKeysText('')
    setActiveKeyId('')
    setKeyDrafts(createProviderKeyDrafts(savedKeys))
  }

  const handleEngineChange = (nextEngine: EngineKind): void => {
    setGenerationProbe(null)
    const configuredNames = parseCredentialHeaderNames(credentialHeaderNamesText)
    const currentDefault = defaultCredentialHeaderName(engine).toLowerCase()
    if (configuredNames.length === 0
      || (configuredNames.length === 1 && configuredNames[0].toLowerCase() === currentDefault)) {
      setCredentialHeaderNamesText(defaultCredentialHeaderName(nextEngine))
    }
    setEngine(nextEngine)
  }

  const fetchModels = async (): Promise<void> => {
    setFetching(true)
    setError('')
    setFetchNote('')
    setFetchError(null)
    try {
      const result = await window.agentDesk.fetchProviderModels({
        baseUrl: baseUrl.trim(),
        token: token.trim() || undefined,
        providerId: provider?.id,
        customHeaders: customHeaders.trim() || undefined,
        credentialHeaderNames: parseCredentialHeaderNames(credentialHeaderNamesText),
        engine,
        openaiProtocol,
        authMode
      })
      if (!result.ok) {
        setModelSourceKey('')
        setFetchNote(t('modelListStaleAfterFailure', { baseUrl: result.baseUrl || baseUrl.trim() }))
        if (result.error) setFetchError(result.error)
        else setError(t('fetchModelsFailed'))
        return
      }
      setModelsText(result.models.join('\n'))
      setModelSourceKey(result.cacheKey)
      setFetchNote(t('fetchedModelsFrom', {
        n: result.models.length,
        baseUrl: result.baseUrl,
        latencyMs: result.latencyMs ?? 0
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setFetching(false)
    }
  }

  const handleDiagnosticAction = (action: ProviderModelSuggestedAction): void => {
    const field = diagnosticTargetField(action)
    if (field) {
      editorRef.current?.querySelector<HTMLElement>(`[data-provider-field="${field}"]`)?.focus()
      return
    }
    void fetchModels()
  }

  const probeGeneration = async (): Promise<void> => {
    const model = modelsText.split(/\r?\n/).map((item) => item.trim()).find(Boolean)
    if (!model) {
      setError(t('providerGenerationProbeModelRequired'))
      editorRef.current?.querySelector<HTMLElement>('[data-provider-field="models"]')?.focus()
      return
    }
    setProbingGeneration(true)
    setGenerationProbe(null)
    setError('')
    try {
      setGenerationProbe(await window.agentDesk.probeProviderGeneration({
        baseUrl: baseUrl.trim(),
        token: token.trim() || undefined,
        providerId: provider?.id,
        customHeaders: customHeaders.trim() || undefined,
        credentialHeaderNames: parseCredentialHeaderNames(credentialHeaderNamesText),
        engine,
        openaiProtocol,
        authMode,
        model
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setProbingGeneration(false)
    }
  }

  const applyPreset = (key: string): void => {
    const preset = PROVIDER_PRESETS.find((p) => p.key === key)
    if (!preset) return
    setPresetHint(preset.hint)
    setGenerationProbe(null)
    if (preset.key === 'custom') return
    if (!name.trim()) setName(preset.label)
    setBaseUrl(preset.baseUrl)
    setModelsText(preset.models.join('\n'))
    handleEngineChange(preset.engine)
    handleAuthModeChange(preset.key === 'local-openai' ? 'none' : 'api-key')
    setOpenaiProtocol(preset.openaiProtocol ?? 'responses')
    setModelSourceKey(providerModelSourceKey(provider?.id, preset.baseUrl, preset.engine, preset.openaiProtocol ?? 'responses'))
  }

  const save = async (): Promise<void> => {
    const additionalTokens = parseAdditionalKeys(additionalKeysText)
    const validationKey = providerEditorValidationKey(
      name,
      provider,
      authMode,
      token,
      additionalTokens,
      modelsText.split('\n').map((model) => model.trim()).filter(Boolean)
    )
    if (validationKey) {
      setError(t(validationKey))
      return
    }
    if (requiresCredentialDeletionConfirmation(provider, authMode, existingCredentialCount)
      && !window.confirm(t('providerAuthModeNoneDeleteKeysConfirm', { n: existingCredentialCount }))) {
      return
    }
    let advancedConfig: ProviderAdvancedConfig | undefined
    try {
      advancedConfig = parseAdvancedConfigText(advancedConfigText)
    } catch {
      setError(t('providerAdvancedConfigInvalid'))
      return
    }
    const input = buildProviderSaveInput({
      provider, name, baseUrl, modelsText, engine, authMode, customHeaders,
      credentialHeaderNamesText, budgetUsd, openaiProtocol, note, token, tokenLabel,
      tokenTouched, additionalKeysText, savedKeys, keyDrafts, activeKeyId, credentialRoutingMode, advancedConfig
    })
    setBusy(true)
    setError('')
    try {
      const savedProvider = provider
        ? await updateProvider(provider.id, input)
        : await createProvider(input)
      onClose({ reason: 'saved', provider: savedProvider })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  const scrollToEditorSection = (selector: string): void => {
    editorRef.current?.querySelector<HTMLElement>(selector)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <section ref={editorRef} className="provider-editor" aria-label={isEdit ? t('providerEditTitle') : t('providerAddTitle')} data-provider-editor="form">
        <ProviderEditorIntro provider={provider} isEdit={isEdit} presetHint={presetHint} onClose={onClose} onApplyPreset={applyPreset} onNavigate={scrollToEditorSection} />

        <label className="field-label">{t('nameLabel')}</label>
        <input
          className="input input-block" data-provider-field="name"
          value={name}
          placeholder={t('namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="field-label">{t('baseUrlLabel')}</label>
        <input
          className="input input-block" data-provider-field="base-url"
          value={baseUrl}
          placeholder="https://your-gateway.example.com"
          onChange={(e) => { setBaseUrl(e.target.value); setGenerationProbe(null) }}
        />

        <label className="field-label">{t('providerEngineLabel')}</label>
        <select
          className="select select-block" data-provider-field="engine"
          value={engine}
          onChange={(e) => handleEngineChange(e.target.value as EngineKind)}
        >
          <option value="openai">{t('providerEngineOpenAI')}</option>
          <option value="anthropic">{t('providerEngineAnthropic')}</option>
          <option value="gemini">{t('providerEngineGemini')}</option>
        </select>

        <ProviderCredentialFields
          authMode={authMode}
          onAuthModeChange={handleAuthModeChange}
          existingCredentialCount={existingCredentialCount}
          provider={provider}
          isEdit={isEdit}
          token={token}
          tokenTouched={tokenTouched}
          onTokenChange={(value) => { setToken(value); setTokenTouched(true); setGenerationProbe(null) }}
          tokenLabel={tokenLabel}
          onTokenLabelChange={setTokenLabel}
          savedKeys={savedKeys}
          keyDrafts={keyDrafts}
          activeKeyId={activeKeyId}
          onActiveKeyChange={setActiveKeyId}
          credentialRoutingMode={credentialRoutingMode}
          onCredentialRoutingModeChange={setCredentialRoutingMode}
          onKeyDraftsChange={setKeyDrafts}
          additionalKeysText={additionalKeysText}
          onAdditionalKeysTextChange={setAdditionalKeysText}
        />

        <div className="field-label-row">
          <label className="field-label">{t('modelListLabel')}</label>
          <div className="provider-model-probe-actions">
            <button
              className="btn btn-ghost btn-sm"
              disabled={fetching || probingGeneration}
              onClick={() => void fetchModels()}
              title={t('fetchModelsTitle')}
            >
              {fetching ? t('fetching') : t(authMode === 'none' ? 'fetchModelsNoKey' : 'fetchWithKey')}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              disabled={fetching || probingGeneration || !baseUrl.trim()}
              onClick={() => void probeGeneration()}
            >
              {probingGeneration ? t('providerGenerationProbeRunning') : t('providerGenerationProbeButton')}
            </button>
          </div>
        </div>
        <textarea
          className="input input-block textarea" data-provider-field="models"
          value={modelsText}
          rows={4}
          placeholder={'gpt-4o\nclaude-3-5-sonnet\ngemini-1.5-pro'}
          onChange={(e) => {
            setModelsText(e.target.value)
            setGenerationProbe(null)
            setModelSourceKey(currentModelSourceKey)
          }}
        />
        {fetchNote && <div className="field-hint field-hint-ok">{fetchNote}</div>}
        {modelsStale && <div className="field-hint field-hint-warning">{t('modelListStale')}</div>}
        {fetchError && (
          <ProviderConnectionDiagnostic
            error={fetchError}
            onAction={() => handleDiagnosticAction(fetchError.suggestedAction)}
          />
        )}
        {generationProbe && <ProviderGenerationProbe result={generationProbe} />}

        <label className="field-label">
          {t('customHeadersLabel')} <span className="field-hint">{t('customHeadersHint')}</span>
        </label>
        <textarea
          className="input input-block textarea"
          value={customHeaders}
          rows={2}
          placeholder={'X-Gateway-Route: openai\nX-Trace-Id: request-label'}
          onChange={(e) => { setCustomHeaders(e.target.value); setGenerationProbe(null) }}
        />

        <label className="field-label">
          {t('credentialHeaderNamesLabel')} <span className="field-hint">{t('credentialHeaderNamesHint')}</span>
        </label>
        <textarea
          className="input input-block textarea"
          value={credentialHeaderNamesText}
          rows={2}
          placeholder={'api-key\nOcp-Apim-Subscription-Key'}
          onChange={(e) => { setCredentialHeaderNamesText(e.target.value); setGenerationProbe(null) }}
        />

        {engine === 'openai' && (
          <>
            <label className="field-label">
              {t('openaiProtocolLabel')} <span className="field-hint">{t('openaiProtocolHint')}</span>
            </label>
            <select
              className="select select-block" data-provider-field="openai-protocol"
              value={openaiProtocol}
              onChange={(e) => { setOpenaiProtocol(e.target.value as OpenAIProtocol); setGenerationProbe(null) }}
            >
              <option value="responses">{t('openaiProtocolResponses')}</option>
              <option value="chat">{t('openaiProtocolChat')}</option>
            </select>
          </>
        )}

        <label className="field-label">{t('noteOptional')}</label>
        <input
          className="input input-block"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <label className="field-label">
          {t('providerAdvancedConfigLabel')} <span className="field-hint">{t('providerAdvancedConfigHint')}</span>
        </label>
        <ProviderAdvancedConfigEditor
          value={advancedConfigText}
          availableModels={modelsText.split(/\r?\n/).map((model) => model.trim()).filter(Boolean)}
          engine={engine}
          onChange={setAdvancedConfigText}
        />

        <label className="field-label">Provider 预算上限 ($)</label>
        <input
          className="input input-block"
          type="number"
          min="0"
          step="0.01"
          value={budgetUsd}
          placeholder="0 = 继承全局设置"
          onChange={(e) => setBudgetUsd(e.target.value)}
        />

        {error && <div className="notice notice-error" data-provider-editor-error>{error}</div>}

        <div className="provider-editor-actions">
          <button className="btn btn-ghost" data-provider-editor-action="cancel" onClick={() => onClose({ reason: 'cancelled' })}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" data-provider-editor-action="save" disabled={busy} onClick={() => void save()}>
            {busy ? t('saving') : t('save')}
          </button>
        </div>
    </section>
  )
}

function initialCredentialRoutingMode(provider: ProviderView | null): ProviderCredentialRoutingMode {
  return provider?.credentialRoutingMode ?? 'preferred'
}

function diagnosticTargetField(action: ProviderModelSuggestedAction): string | null {
  if (action === 'enter_credentials' || action === 'review_credentials') return 'api-key'
  if (action === 'review_base_url_and_credentials' || action === 'review_configuration') return 'base-url'
  if (action === 'enter_models_manually') return 'models'
  return null
}

function providerEditorValidationKey(
  name: string,
  provider: ProviderView | null,
  authMode: ProviderAuthMode,
  token: string,
  additionalTokens: ProviderApiKeyInput[],
  models: string[]
): string | null {
  if (!name.trim()) return 'errNameRequired'
  if (useStore.getState().settingsContext !== 'welcome-provider-recovery') return null
  if (authMode !== 'none' && !provider?.hasToken && !token.trim() && additionalTokens.length === 0) {
    return 'errProviderKeyRequired'
  }
  return models.length === 0 ? 'errProviderModelRequired' : null
}

function requiresCredentialDeletionConfirmation(
  provider: ProviderView | null,
  authMode: ProviderAuthMode,
  existingCredentialCount: number
): boolean {
  return Boolean(provider && provider.authMode !== 'none' && authMode === 'none' && existingCredentialCount > 0)
}

function countExistingProviderCredentials(provider: ProviderView | null): number {
  return Math.max(
    provider?.apiKeys?.length ?? 0,
    provider?.keyCount ?? 0,
    provider?.hasToken ? 1 : 0
  )
}

function isProviderModelListStale(modelsText: string, sourceKey: string, currentSourceKey: string): boolean {
  return modelsText.trim().length > 0 && sourceKey !== '' && sourceKey !== currentSourceKey
}

function buildProviderSaveInput(state: ProviderEditorSaveState): ProviderInput {
  const budget = Number(state.budgetUsd)
  return {
    name: state.name.trim(),
    baseUrl: state.baseUrl.trim(),
    models: state.modelsText.split('\n').map((model) => model.trim()).filter(Boolean),
    engine: state.engine,
    authMode: state.authMode,
    customHeaders: state.customHeaders.trim(),
    credentialHeaderNames: parseCredentialHeaderNames(state.credentialHeaderNamesText),
    budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : 0,
    openaiProtocol: state.openaiProtocol,
    note: state.note.trim(),
    advancedConfig: state.advancedConfig,
    credentialRoutingMode: state.credentialRoutingMode,
    ...buildProviderCredentialPatch(state)
  }
}

function parseAdvancedConfigText(value: string): ProviderAdvancedConfig | undefined {
  const text = value.trim()
  if (!text) return undefined
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid config')
  return parsed as ProviderAdvancedConfig
}

function defaultCredentialHeaderName(engine: EngineKind): string {
  if (engine === 'anthropic') return 'x-api-key'
  if (engine === 'gemini') return 'x-goog-api-key'
  return 'Authorization'
}

function buildProviderCredentialPatch(state: ProviderEditorSaveState): Partial<ProviderInput> {
  if (state.authMode === 'none') return {}
  const additionalTokens = parseAdditionalKeys(state.additionalKeysText)
  const keyUpdates = buildKeyUpdates(state.savedKeys, state.keyDrafts)
  const removeKeyIds = state.savedKeys
    .filter((key) => state.keyDrafts[key.id]?.remove)
    .map((key) => key.id)
  const activeKeyId = state.activeKeyId && !removeKeyIds.includes(state.activeKeyId)
    ? state.activeKeyId
    : undefined
  const patch: Partial<ProviderInput> = {}

  if (!state.provider || state.tokenTouched) {
    patch.token = state.token
    patch.tokenLabel = state.tokenLabel.trim()
  } else if (state.tokenLabel.trim()) {
    patch.tokenLabel = state.tokenLabel.trim()
  }
  if (additionalTokens.length > 0) patch.additionalTokens = additionalTokens
  if (keyUpdates.length > 0) patch.keyUpdates = keyUpdates
  if (removeKeyIds.length > 0) patch.removeKeyIds = removeKeyIds
  if (activeKeyId) patch.activeKeyId = activeKeyId
  return patch
}

function parseAdditionalKeys(value: string): ProviderApiKeyInput[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const eqIndex = line.indexOf('=')
      if (eqIndex <= 0) return [{ token: line }]
      const label = line.slice(0, eqIndex).trim()
      const token = line.slice(eqIndex + 1).trim()
      return token ? [{ label, token }] : []
    })
}

function parseCredentialHeaderNames(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function buildKeyUpdates(
  savedKeys: ProviderApiKeyView[],
  drafts: Record<string, ProviderKeyDraft>
): ProviderApiKeyUpdateInput[] {
  return savedKeys.flatMap((key) => {
    const draft = drafts[key.id]
    if (!draft || draft.remove) return []
    const label = draft.label.trim()
    const labelChanged = label !== key.label
    const disabledChanged = draft.disabled !== key.disabled
    const policy = providerKeyPolicyFromDraft(draft)
    const policyChanged = Object.entries(policy).some(([name, value]) =>
      key.policy[name as keyof typeof key.policy] !== value)
    if (!labelChanged && !disabledChanged && !policyChanged) return []
    return [{
      id: key.id,
      ...(labelChanged ? { label } : {}),
      ...(disabledChanged ? { disabled: draft.disabled } : {}),
      ...(policyChanged ? { policy } : {})
    }]
  })
}

function providerModelSourceKey(
  providerId: string | undefined,
  baseUrl: string,
  engine: EngineKind,
  protocol: OpenAIProtocol | undefined
): string {
  const clean = normalizeProviderModelBaseUrl(baseUrl)
  return [providerId || 'new-provider', engine, clean, engine === 'openai' ? protocol || 'default' : 'native'].join('|')
}

function normalizeProviderModelBaseUrl(value: string): string {
  const clean = value.trim().replace(/\/+$/, '')
  try {
    const url = new URL(clean)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return clean
  }
}
