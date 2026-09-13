import { useCallback, useEffect, useState } from 'react'
import type { ProviderGenerationProbeResult, ProviderModelProfile, ProviderView } from '../../../shared/types'
import { useT } from '../i18n'
import { useStore } from '../store'
import { initialProviderRoutingPatch } from '../store/provider-onboarding-policy'
import ProviderGenerationProbe from './ProviderGenerationProbe'
import ProviderModelCapabilitySummary from './ProviderModelCapabilitySummary'
import ProviderSetupModelCapabilities from './ProviderSetupModelCapabilities'
import { getBusinessLines, getBusinessLineWorkSurfaces, type BusinessLineDefinition } from '../../../shared/business-line-types'
import { hasDeclaredProviderModelCapability } from '../../../shared/provider-model-capability-summary'

export type ProviderModelSource = 'discovered' | 'manual' | 'account' | 'local'
type ReceiptMediaEntry = { providerId?: string; model?: string; operations: string[]; enabled: boolean }

export default function ProviderSetupReceipt({ provider, source, onDone, onEdit }: {
  provider: ProviderView
  source: ProviderModelSource
  onDone: (provider: ProviderView) => void
  onEdit: (provider: ProviderView) => void
}): React.JSX.Element {
  const t = useT()
  const refreshProviders = useStore((state) => state.refreshProviders)
  const settings = useStore((state) => state.settings)
  const [currentProvider, setCurrentProvider] = useState(provider)
  const [mediaCatalog, setMediaCatalog] = useState<ReceiptMediaEntry[]>([])
  const profiles = receiptModelProfiles(currentProvider)
  const verified = profiles.filter((profile) => profile.verification?.generation === 'passed' && profile.verification.responseValidation === 'protocol-json-v1').length
  const failed = profiles.filter((profile) => profile.verification?.generation === 'failed').length
  const declared = profiles.filter((profile) => (profile.capabilities?.length ?? 0) > 0).length
  const [model, setModel] = useState(provider.models[0] ?? '')
  const [probe, setProbe] = useState<ProviderGenerationProbeResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<{ base: ProviderModelProfile; patch: Partial<ProviderModelProfile> } | null>(null)
  const [notice, setNotice] = useState('')
  const businessLines = getBusinessLines(settings).filter((line) => line.enabled)

  // The catalog is the single source of truth for media availability. A
  // provider being reachable does not imply that it can generate images,
  // video or audio, so the receipt keeps that distinction visible.
  useEffect(() => {
    let cancelled = false
    void window.agentDesk.listMediaProviders().then((entries) => {
      if (!cancelled) setMediaCatalog(entries.map((entry) => ({ providerId: entry.providerId, model: entry.model, operations: entry.operations, enabled: entry.enabled })))
    }).catch(() => { if (!cancelled) setMediaCatalog([]) })
    return () => { cancelled = true }
  }, [currentProvider.id, currentProvider.advancedConfig?.modelProfiles])
  const selectedProfile = profiles.find((profile) => matchesModel(profile, model)) ?? { model }
  const saveCapabilities = async (): Promise<void> => {
    if (!draft) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      // Merge only edited declarations into the latest profile. A probe or an
      // expert edit may have updated unrelated pricing, aliases or evidence.
      const latest = (await window.agentDesk.listProviders()).find((item) => item.id === provider.id)
      if (!latest || !latest.models.includes(model)) throw new Error(t('providerSetupModelChanged'))
      const latestProfiles = receiptModelProfiles(latest)
      const latestProfile = latestProfiles.find((profile) => matchesModel(profile, model))
      if (!latestProfile || latestProfile.model !== draft.base.model ||
        (['capabilities', 'mediaPricing'] as const).some((field) => field in draft.patch &&
          JSON.stringify(latestProfile[field]) !== JSON.stringify(draft.base[field]))) {
        setCurrentProvider(latest)
        throw new Error(t('providerSetupCapabilitiesConflict'))
      }
      const updated = await useStore.getState().updateProvider(latest.id, {
        advancedConfig: { ...(latest.advancedConfig ?? { schemaVersion: 1 }),
          modelProfiles: latestProfiles.map((profile) => matchesModel(profile, model) ? { ...profile, ...draft.patch } : profile) }
      })
      setCurrentProvider(updated)
      setDraft(null)
      setNotice(t('providerSetupCapabilitiesSaved'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }
  const runProbe = async (): Promise<void> => {
    setBusy(true)
    setProbe(null)
    setError('')
    try {
      setProbe(await window.agentDesk.probeProviderGeneration({ providerId: currentProvider.id, baseUrl: currentProvider.baseUrl, model }))
      await refreshProviders()
      const refreshed = useStore.getState().providers.find((item) => item.id === currentProvider.id)
      if (refreshed) setCurrentProvider(refreshed)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }
  return <section className="provider-editor" data-provider-setup-receipt={provider.id}>
    <header className="provider-editor-header"><h2 className="provider-editor-title">{t('providerSetupSavedTitle', { name: provider.name })}</h2></header>
      <div className="provider-quick-setup">
      <ProviderModelCapabilitySummary profiles={profiles} />
      <ProviderBusinessLineAvailability provider={currentProvider} lines={businessLines} mediaCatalog={mediaCatalog} />
      <ol className="provider-diagnostic-attempts" data-provider-setup-stages>
        <li data-provider-setup-stage="saved" data-state="complete"><strong>{t('providerSetupStageSaved')}</strong><span>{t('providerSetupSavedHint')}</span></li>
        <li data-provider-setup-stage="models" data-state={source}><strong>{t('providerSetupStageModels')}</strong><span>{t(`providerSetupModelSource_${source}`, { n: provider.models.length })}</span></li>
        <li data-provider-setup-stage="generation" data-state={probe?.ok ? 'protocol-verified' : probe ? 'failed' : 'unverified'}><strong>{t('providerSetupStageGeneration')}</strong><span>{t(probe?.ok ? 'providerSetupProtocolVerified' : probe ? 'providerSetupProbeFailed' : 'providerSetupUnverified')}</span></li>
        <li data-provider-setup-stage="capabilities" data-state={declared > 0 ? 'declared' : 'unverified'}><strong>{t('providerSetupStageCapabilities')}</strong><span>{t(declared > 0 ? 'providerSetupCapabilitiesDeclared' : 'providerSetupCapabilitiesUnverified', { n: declared })}</span></li>
        <li data-provider-setup-stage="routing" data-state={verified === profiles.length && profiles.length > 0 ? 'ready' : 'partial'}><strong>{t('providerSetupStageRouting')}</strong><span>{t(verified === profiles.length && profiles.length > 0 ? 'providerSetupRoutingReady' : 'providerSetupRoutingPartial', { verified, failed, total: profiles.length })}</span></li>
        <li data-provider-setup-stage="task" data-state="unverified"><strong>{t('providerSetupStageTask')}</strong><span>{t('providerSetupTaskUnverified')}</span></li>
      </ol>
      <label className="field-label">{t('providerSetupProbeModel')}
        <select className="input input-block" data-provider-setup-model value={model} disabled={busy || !!draft} onChange={(event) => { setModel(event.target.value); setProbe(null); setError(''); setNotice('') }}>
          {currentProvider.models.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      {model && <ProviderSetupModelCapabilities profile={{ ...selectedProfile, ...draft?.patch }} disabled={busy} dirty={!!draft}
        onChange={(patch) => { setDraft((previous) => ({ base: previous?.base ?? selectedProfile, patch: { ...previous?.patch, ...patch } })); setNotice('') }}
        onSave={() => void saveCapabilities()} onReset={() => { setDraft(null); setError('') }} />}
      {notice && <p className="field-hint field-hint-ok" data-provider-setup-capabilities-saved role="status">{notice}</p>}
      <p>{t('providerGenerationProbeBillingNotice')}</p>
      <button className="btn btn-ghost" data-provider-setup-action="probe" disabled={busy || !!draft || !model} onClick={() => void runProbe()}>{t(busy ? 'providerGenerationProbeRunning' : 'providerGenerationProbeButton')}</button>
      {probe && <ProviderGenerationProbe result={probe} />}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
    </div>
    <div className="provider-editor-actions">
      <button className="btn btn-ghost" data-provider-setup-action="edit" disabled={busy || !!draft} onClick={() => onEdit(currentProvider)}>{t('providerSetupEditSaved')}</button>
      <button className="btn btn-primary" data-provider-setup-action="done" disabled={busy || !!draft} onClick={() => onDone(currentProvider)}>{t('providerSetupDone')}</button>
    </div>
  </section>
}

function matchesModel(profile: ProviderModelProfile, model: string): boolean {
  return [profile.model, ...(profile.aliases ?? [])].some((value) => value.toLowerCase() === model.toLowerCase())
}

function receiptModelProfiles(provider: ProviderView): ProviderModelProfile[] {
  const profiles = provider.advancedConfig?.modelProfiles ?? []
  const known = new Set(profiles.flatMap((profile) => [profile.model, ...(profile.aliases ?? [])]).map((model) => model.toLowerCase()))
  return [...profiles, ...provider.models.filter((model) => !known.has(model.toLowerCase())).map((model) => ({ model }))]
}

function ProviderBusinessLineAvailability({ provider, lines, mediaCatalog }: {
  provider: ProviderView
  lines: BusinessLineDefinition[]
  mediaCatalog: ReceiptMediaEntry[]
}): React.JSX.Element {
  const t = useT()
  const profiles = receiptModelProfiles(provider)
  return <section className="provider-business-line-availability" data-provider-business-line-availability>
    <strong>{t('providerSetupBusinessLineAvailabilityTitle')}</strong>
    <p className="field-hint">{t('providerSetupBusinessLineAvailabilityHint')}</p>
    <ul>
      {lines.map((line) => {
        const required = line.requiredCapabilities ?? []
        const needsMedia = getBusinessLineWorkSurfaces(line).includes('video')
        const capabilityReady = profiles.some((profile) => provider.models.some((model) => matchesModel(profile, model)) && profile.verification?.generation !== 'failed'
          && required.every((capability) => hasDeclaredProviderModelCapability(profile, capability))
          && (!needsMedia || mediaCatalog.some((entry) => entry.providerId === provider.id && entry.enabled && entry.operations.length > 0
            && !!entry.model && matchesModel(profile, entry.model))))
        const state = provider.ready && capabilityReady ? 'declared' : 'needs-setup'
        return <li key={line.id} data-provider-business-line={line.id} data-state={state}>
          <span>{line.name}</span>
          <span>{state === 'declared' ? t('providerSetupBusinessLineDeclared') : t('providerSetupBusinessLineNeedsSetup')}</span>
        </li>
      })}
    </ul>
  </section>
}

export function useProviderSetupCompletion(): {
  saved: { provider: ProviderView; source: ProviderModelSource } | null
  complete(provider: ProviderView, source: ProviderModelSource): Promise<void>
} {
  const [saved, setSaved] = useState<{ provider: ProviderView; source: ProviderModelSource } | null>(null)
  const complete = useCallback(async (provider: ProviderView, source: ProviderModelSource): Promise<void> => {
    // Save completion is independent of default selection; a preferences write
    // failure must leave a recoverable receipt rather than invite duplicate saves.
    setSaved({ provider, source })
    const state = useStore.getState()
    const patch = initialProviderRoutingPatch(state.settings, state.providers, provider.id)
    if (patch) await state.updateSettings(patch)
  }, [])
  return { saved, complete }
}
