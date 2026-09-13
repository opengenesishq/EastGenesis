import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Ban,
  Check,
  Clock3,
  CircleMinus,
  Film,
  HardDrive,
  ImagePlus,
  Link2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  WandSparkles
} from 'lucide-react'
import type {
  MediaAsset,
  MediaAssetBindingRole,
  MediaAssetKind,
  MediaDialogueCue,
  MediaFfmpegInfo,
  MediaMockScenario,
  MediaOperation,
  MediaStudioSnapshot,
  ProviderView,
  VideoProduction,
  VideoShot
} from '../../../../shared/types'
import { videoStudioText } from '../../i18n/studioTranslations'
import { useStore } from '../../store'
import VideoStoryboardPlanner from './VideoStoryboardPlanner'
import VideoMediaRoutingControls, { operationCapability } from './VideoMediaRoutingControls'
import { MEDIA_AUTO_PROVIDER_ID } from '../../../../shared/media-routing-types'
import type { MediaRoutingPreference } from '../../../../shared/media-types'
import VideoContinuitySection, { type BibleDraft, type LockDraft } from './VideoContinuitySection'
import { businessLineVideoSnapshot } from './businessLineVideoSnapshot'
import { getBusinessLines } from '../../../../shared/business-line-types'
import './video-studio.css'

const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled', 'waiting_reconciliation'])

export function VideoStudioPanel({ active, projectId, productionId, businessLineId = 'video' }: { active: boolean; projectId?: string; productionId?: string; businessLineId?: string }): React.JSX.Element | null {
  const language = useStore((state) => state.settings.language)
  const businessLines = useStore((state) => state.settings.businessLines)
  const text = videoStudioText(language)
  const [snapshot, setSnapshot] = useState<MediaStudioSnapshot | null>(null)
  const [ffmpeg, setFfmpeg] = useState<MediaFfmpegInfo | null>(null)
  const [selectedProductionId, setSelectedProductionId] = useState('')
  const [selectedShotId, setSelectedShotId] = useState('')
  const [selectedAssetId, setSelectedAssetId] = useState('')
  const [previewSelections, setPreviewSelections] = useState<Record<string, string>>({})
  const [title, setTitle] = useState<string>(text.defaultProductionTitle)
  const [script, setScript] = useState('')
  const [revisionScript, setRevisionScript] = useState('')
  const [shotDraft, setShotDraft] = useState({ title: '', prompt: '', durationMs: 5_000 })
  const [assetKind, setAssetKind] = useState<MediaAssetKind>('image')
  const [bindingRole, setBindingRole] = useState<MediaAssetBindingRole>('keyframe')
  const [scenario, setScenario] = useState<MediaMockScenario>('success')
  const [appProviders, setAppProviders] = useState<ProviderView[]>([])
  const [selectedMediaProviderId, setSelectedMediaProviderId] = useState(MEDIA_AUTO_PROVIDER_ID)
  const [selectedMediaOperation, setSelectedMediaOperation] = useState<MediaOperation>('video.text-to-video')
  const [voiceDraft, setVoiceDraft] = useState('alloy')
  const [generationParameters, setGenerationParameters] = useState({ durationSeconds: 5, width: 1280, height: 720, quality: 'standard' as 'draft' | 'standard' | 'high', seed: '', negativePrompt: '', speechSpeed: 1 })
  const [routingPreference, setRoutingPreference] = useState<MediaRoutingPreference>('balanced')
  const [cueDraft, setCueDraft] = useState({ speaker: '', text: '', startMs: 0, endMs: 2_000, audioAssetId: '', subtitleEnabled: true })
  const [editingCueId, setEditingCueId] = useState('')
  const [backgroundVolumeDraft, setBackgroundVolumeDraft] = useState(0.2)
  const [bibleDraft, setBibleDraft] = useState<BibleDraft>({ name: '', summary: '', appearanceRules: '', voiceRules: '', behaviorRules: '' })
  const [lockDraft, setLockDraft] = useState<LockDraft>({ label: '', role: 'character', bibleId: '' })
  const [budgetLimitDraft, setBudgetLimitDraft] = useState('')
  const [storageQuotaDraft, setStorageQuotaDraft] = useState('20')
  const [retentionModeDraft, setRetentionModeDraft] = useState<'retain' | 'expire'>('retain')
  const [retentionUntilDraft, setRetentionUntilDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useLocalizedProductionTitle(text.defaultProductionTitle, setTitle)
  useEffect(() => {
    const line = getBusinessLines({ businessLines }).find((item) => item.id === businessLineId)
    setRoutingPreference(line?.routingPreference ?? 'balanced')
  }, [businessLineId, businessLines])
  const refresh = useCallback(async (): Promise<void> => {
    if (!projectId) { setSnapshot(null); return }
    try {
      const [next, ffmpegInfo, providers] = await Promise.all([
        window.agentDesk.getMediaStudio(projectId).then((snapshot) => businessLineVideoSnapshot(snapshot, businessLineId)),
        window.agentDesk.getMediaFfmpegInfo(),
        window.agentDesk.listProviders()
      ])
      setSnapshot(next)
      setFfmpeg(ffmpegInfo)
      setAppProviders(providers)
      setSelectedMediaOperation((current) => next.providers.some((item) => item.enabled && item.operations.includes(current)) ? current : 'video.text-to-video')
      setSelectedProductionId((current) => productionId && next.productions.some((item) => item.id === productionId) ? productionId : next.productions.some((item) => item.id === current)
        ? current
        : next.productions[0]?.id ?? '')
      setError('')
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [projectId, productionId, businessLineId])
  useEffect(() => { if (active) void refresh() }, [active, refresh])
  const production = snapshot?.productions.find((item) => item.id === selectedProductionId) ?? snapshot?.productions[0]
  const adoptedStructure = production?.structureRevisions.find((item) => item.id === production.adoptedStructureRevisionId)
  const visibleScenes = production?.scenes.filter((scene) => adoptedStructure?.sceneIds.includes(scene.id) ?? true) ?? []
  const visibleShotIds = visibleScenes.flatMap((scene) => scene.shotIds)
  const shots = visibleShotIds.map((id) => production?.shots.find((shot) => shot.id === id)).filter((shot): shot is VideoShot => Boolean(shot))
  const selectedShot = shots.find((item) => item.id === selectedShotId) ?? shots[0]
  const selectedAsset = production?.assets.find((item) => item.id === selectedAssetId) ?? production?.assets[0]
  const compositionAssets = production?.assets
    .filter((asset) => asset.kind === 'video' && asset.authorization?.source === 'local_composition')
    .sort((left, right) => right.version - left.version || right.createdAt - left.createdAt) ?? []
  const previewAsset = compositionAssets.find((asset) => asset.id === previewSelections[production?.id ?? '']) ?? compositionAssets[0]
  const audioAssets = production?.assets.filter((asset) => asset.contentStatus === 'available' &&
    (asset.kind === 'audio' || asset.kind === 'voice' || asset.mediaType?.startsWith('audio/'))) ?? []
  const finalAsset = production?.assets.find((asset) => asset.id === production.finalAssetId)
  const jobs = snapshot?.jobs.filter((job) => !production || job.productionId === production.id) ?? []
  const mediaProviders = snapshot?.providers ?? []
  const compatibleMediaProviders = mediaProviders.filter((item) => item.enabled && item.operations.includes(selectedMediaOperation))
  const selectedMediaProvider = compatibleMediaProviders.find((item) => item.id === selectedMediaProviderId)
  const automaticMedia = selectedMediaProviderId === MEDIA_AUTO_PROVIDER_ID
  const selectedEgressGrant = selectedAsset?.egressGrants?.find((grant) => grant.mediaProviderId === selectedMediaProvider?.id && grant.operation === selectedMediaOperation && grant.assetVersion === selectedAsset.version)
  const selectedEgressActive = selectedEgressGrant?.status === 'granted' && (selectedEgressGrant.expiresAt === undefined || selectedEgressGrant.expiresAt > Date.now())
  const selectedVoiceAuthorization = selectedAsset?.voiceCloneAuthorizations?.find((item) => item.assetVersion === selectedAsset.version)
  const selectedVoiceAuthorizationActive = selectedVoiceAuthorization?.status === 'granted' && (selectedVoiceAuthorization.expiresAt === undefined || selectedVoiceAuthorization.expiresAt > Date.now())
  const speechProvider = mediaProviders.find((item) => item.id === selectedMediaProviderId && item.enabled && item.operations.includes('speech.synthesize'))
  const storage = useMemo(() => mediaStorageSummary(snapshot, projectId), [snapshot?.snapshotDigest, projectId])
  const selectedAssetAvailable = selectedAsset?.contentStatus === 'available'
  useEffect(() => {
    if (!production) return
    setRevisionScript(production.script)
    setBackgroundVolumeDraft(production.timeline.backgroundAudioVolume)
    setBudgetLimitDraft(production.budget.limitUsd === undefined ? '' : String(production.budget.limitUsd))
  }, [production?.id, production?.revision])
  useEffect(() => {
    if (!selectedShot) { setSelectedShotId(''); return }
    setSelectedShotId(selectedShot.id)
    setShotDraft({ title: selectedShot.title, prompt: selectedShot.prompt, durationMs: selectedShot.durationMs })
  }, [selectedShot?.id, selectedShot?.revision])
  useEffect(() => { if (selectedAsset) setSelectedAssetId(selectedAsset.id) }, [selectedAsset?.id])
  useStorageQuotaDraft(storage?.quotaBytes, setStorageQuotaDraft)
  useAssetRetentionDraft(selectedAsset, setRetentionModeDraft, setRetentionUntilDraft)
  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try { await operation(); await refresh() } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  const createProduction = (): void => void run(async () => {
    if (!projectId || !title.trim() || !script.trim()) throw new Error(text.productionInputRequired)
    const created = await window.agentDesk.createVideoProduction({ projectId, title, script, autoStructure: true, businessLineId })
    setSelectedProductionId(created.id)
    setScript('')
  })
  const reviseProduction = (): void => void run(async () => {
    if (!production || !revisionScript.trim()) return
    await window.agentDesk.reviseVideoProduction({ productionId: production.id, script: revisionScript })
  })
  const createShot = (sceneId: string): void => void run(async () => {
    if (!production) return
    const shot = await window.agentDesk.addVideoShot({
      productionId: production.id,
      sceneId,
      title: `镜头 ${shots.length + 1}`,
      prompt: production.script.slice(0, 500),
      durationMs: 5_000
    })
    setSelectedShotId(shot.id)
  })
  const saveShot = (): void => void run(async () => {
    if (!production || !selectedShot) return
    await window.agentDesk.updateVideoShot({ productionId: production.id, shotId: selectedShot.id, ...shotDraft })
  })
  const saveCue = (): void => void run(async () => {
    if (!production || !selectedShot) return
    await window.agentDesk.upsertMediaDialogueCue({
      ...(editingCueId ? { id: editingCueId } : {}),
      productionId: production.id,
      shotId: selectedShot.id,
      speaker: cueDraft.speaker,
      text: cueDraft.text,
      startMs: cueDraft.startMs,
      endMs: cueDraft.endMs,
      ...(cueDraft.audioAssetId ? { audioAssetId: cueDraft.audioAssetId } : {}),
      subtitleEnabled: cueDraft.subtitleEnabled
    })
    setEditingCueId('')
    setCueDraft({ speaker: '', text: '', startMs: 0, endMs: Math.min(2_000, selectedShot.durationMs), audioAssetId: '', subtitleEnabled: true })
  })
  const editCue = (cue: MediaDialogueCue): void => {
    setEditingCueId(cue.id)
    setCueDraft({ speaker: cue.speaker, text: cue.text, startMs: cue.startMs, endMs: cue.endMs, audioAssetId: cue.audioAssetId ?? cue.voiceAssetId ?? '', subtitleEnabled: cue.subtitleEnabled })
  }
  const deleteCue = (cueId: string): void => void run(async () => {
    if (!production || !selectedShot) return
    await window.agentDesk.deleteMediaDialogueCue({ productionId: production.id, shotId: selectedShot.id, cueId })
  })
  const generateCueAudio = (cue: MediaDialogueCue): void => void run(async () => {
    if (!projectId || !production || !selectedShot || !cue.text.trim()) return
    const job = await window.agentDesk.submitMediaJob({
      projectId,
      productionId: production.id,
      shotId: selectedShot.id,
      dialogueCueId: cue.id,
      capability: 'tts',
      operation: 'speech.synthesize',
      idempotencyKey: `${production.id}:${production.revision}:${selectedShot.id}:${cue.id}:${cue.revision}:speech.synthesize:${selectedMediaProviderId}:${speechProvider?.model ?? voiceDraft}`,
      mediaProviderId: selectedMediaProviderId,
      routingPreference,
      providerId: speechProvider?.providerId,
      model: speechProvider?.model,
      prompt: cue.text,
      voice: voiceDraft,
      parameters: { durationSeconds: generationParameters.durationSeconds, width: generationParameters.width, height: generationParameters.height, quality: generationParameters.quality, ...(generationParameters.seed.trim() ? { seed: Number(generationParameters.seed) } : {}), ...(generationParameters.speechSpeed !== 1 ? { speechSpeed: generationParameters.speechSpeed } : {}) },
      ...(speechProvider?.endpointClass === 'mock' ? { mockScenario: scenario } : {})
    })
    let current = job
    for (let attempt = 0; attempt < 4 && !terminalStatuses.has(current.status); attempt += 1) {
      current = await window.agentDesk.advanceMediaJob(current.id)
    }
  })
  const updateTimeline = (input: { backgroundAudioAssetId?: string; backgroundAudioVolume?: number; subtitleMode?: 'embedded' | 'burned_in' | 'none' }): void => void run(async () => {
    if (!production) return
    await window.agentDesk.updateMediaTimeline({ productionId: production.id, ...input })
  })
  const saveBible = (): void => void run(async () => {
    if (!production) return
    await window.agentDesk.upsertMediaCharacterBible({
      productionId: production.id,
      name: bibleDraft.name,
      summary: bibleDraft.summary,
      appearanceRules: ruleLines(bibleDraft.appearanceRules),
      voiceRules: ruleLines(bibleDraft.voiceRules),
      behaviorRules: ruleLines(bibleDraft.behaviorRules),
      referenceAssetIds: selectedAssetAvailable && selectedAsset ? [selectedAsset.id] : []
    })
    setBibleDraft({ name: '', summary: '', appearanceRules: '', voiceRules: '', behaviorRules: '' })
  })
  const deleteBible = (bibleId: string): void => void run(async () => {
    if (production) await window.agentDesk.deleteMediaCharacterBible({ productionId: production.id, bibleId })
  })
  const saveContinuityLock = (): void => void run(async () => {
    if (!production || !selectedAsset || !selectedAssetAvailable || shots.length === 0) return
    await window.agentDesk.upsertMediaContinuityLock({
      productionId: production.id,
      ...(lockDraft.bibleId ? { bibleId: lockDraft.bibleId } : {}),
      label: lockDraft.label || `${selectedAsset.title} ${lockDraft.role}`,
      role: lockDraft.role,
      assetId: selectedAsset.id,
      targetShotIds: shots.map((shot) => shot.id),
      enabled: true
    })
    setLockDraft((value) => ({ ...value, label: '' }))
  })
  const deleteContinuityLock = (lockId: string): void => void run(async () => {
    if (production) await window.agentDesk.deleteMediaContinuityLock({ productionId: production.id, lockId })
  })
  const checkContinuity = (): void => void run(async () => {
    if (projectId && production) await window.agentDesk.checkMediaContinuity({ projectId, productionId: production.id, shotIds: shots.map((shot) => shot.id) })
  })
  const saveBudget = (): void => void run(async () => {
    if (!production) return
    const limitUsd = budgetLimitDraft.trim() === '' ? 0 : Number(budgetLimitDraft)
    await window.agentDesk.updateMediaBudget({ productionId: production.id, limitUsd })
  })
  const saveStorageQuota = (): void => void run(async () => {
    if (!projectId) return
    const quotaBytes = Math.round(Number(storageQuotaDraft) * 1024 * 1024 * 1024)
    await window.agentDesk.updateMediaProjectStorage({ projectId, quotaBytes })
  })
  const saveRetention = (): void => void run(async () => {
    if (!projectId || !production || !selectedAsset) return
    const retainUntil = retentionModeDraft === 'expire' ? Date.parse(retentionUntilDraft) : undefined
    if (retentionModeDraft === 'expire' && (!Number.isSafeInteger(retainUntil) || Number(retainUntil) <= Date.now())) {
      throw new Error('到期时间必须是未来时间')
    }
    await window.agentDesk.updateMediaAssetRetention({
      projectId,
      productionId: production.id,
      assetId: selectedAsset.id,
      mode: retentionModeDraft,
      ...(retainUntil === undefined ? {} : { retainUntil })
    })
  })
  const purgeAsset = (): void => void run(async () => {
    if (!projectId || !production || !selectedAsset) return
    await window.agentDesk.purgeMediaAsset({ projectId, productionId: production.id, assetId: selectedAsset.id })
  })
  const toggleAssetEgress = (): void => void run(async () => {
    if (!projectId || !production || !selectedAsset || !selectedMediaProvider) return
    await window.agentDesk.setMediaAssetEgress({
      projectId,
      productionId: production.id,
      assetId: selectedAsset.id,
      mediaProviderId: selectedMediaProvider.id,
      operation: selectedMediaOperation,
      approved: !selectedEgressActive
    })
  })
  const toggleVoiceCloneAuthorization = (): void => void run(async () => {
    if (!projectId || !production || !selectedAsset) return
    await window.agentDesk.setMediaVoiceCloneAuthorization({ projectId, productionId: production.id, assetId: selectedAsset.id, approved: !selectedVoiceAuthorizationActive, basis: 'authorized' })
  })
  const moveShot = (direction: -1 | 1): void => void run(async () => {
    if (!production || !selectedShot) return
    const scene = visibleScenes.find((item) => item.id === selectedShot.sceneId)
    if (!scene) return
    const index = scene.shotIds.indexOf(selectedShot.id)
    const beforeShotId = direction < 0 ? scene.shotIds[index - 1] : scene.shotIds[index + 2] ?? ''
    if ((direction < 0 && index <= 0) || (direction > 0 && index >= scene.shotIds.length - 1)) return
    await window.agentDesk.updateVideoShot({ productionId: production.id, shotId: selectedShot.id, beforeShotId })
  })
  const importAsset = (): void => void run(async () => {
    if (!projectId || !production) return
    const asset = await window.agentDesk.importMediaAsset({ projectId, productionId: production.id, kind: assetKind })
    if (asset) setSelectedAssetId(asset.id)
  })
  const bindAsset = (): void => void run(async () => {
    if (!production || !selectedShot || !selectedAsset || !selectedAssetAvailable) return
    await window.agentDesk.bindMediaAsset({
      productionId: production.id,
      shotId: selectedShot.id,
      assetId: selectedAsset.id,
      role: bindingRole
    })
  })
  const adoptBinding = (bindingId: string, adopted: boolean): void => void run(async () => {
    if (!production) return
    await window.agentDesk.setMediaAdoption({ productionId: production.id, bindingId, adopted })
  })
  const adoptAsset = (): void => void run(async () => {
    if (!production || !selectedAsset || !selectedAssetAvailable) return
    await window.agentDesk.setMediaAdoption({ productionId: production.id, assetId: selectedAsset.id, adopted: !selectedAsset.adopted })
  })
  const submitShot = async (shot: VideoShot): Promise<unknown> => {
    if (!projectId || !production) throw new Error('请先创建制作')
    const job = await window.agentDesk.submitMediaJob({
      projectId,
      productionId: production.id,
      shotId: shot.id,
      capability: operationCapability(selectedMediaOperation),
      operation: selectedMediaOperation,
      idempotencyKey: `${production.id}:${production.revision}:${shot.id}:${shot.revision}:${selectedMediaOperation}:${selectedAsset?.id ?? 'no-input'}:${selectedMediaProviderId}:${selectedMediaProvider?.model ?? scenario}`,
      mediaProviderId: selectedMediaProviderId,
      routingPreference,
      providerId: selectedMediaProvider?.providerId,
      model: selectedMediaProvider?.model,
      prompt: shot.prompt,
      ...(operationNeedsAsset(selectedMediaOperation) && selectedAssetAvailable && selectedAsset ? { inputAssetIds: [selectedAsset.id] } : {}),
      ...(selectedMediaOperation.startsWith('speech.') ? { voice: voiceDraft } : {}),
      parameters: { durationSeconds: generationParameters.durationSeconds, width: generationParameters.width, height: generationParameters.height, quality: generationParameters.quality, ...(generationParameters.seed.trim() ? { seed: Number(generationParameters.seed) } : {}), ...(generationParameters.negativePrompt.trim() ? { negativePrompt: generationParameters.negativePrompt } : {}), ...(selectedMediaOperation.startsWith('speech.') ? { speechSpeed: generationParameters.speechSpeed } : {}) },
      ...(selectedMediaProvider?.endpointClass === 'mock' ? { mockScenario: scenario } : {})
    })
    if (selectedMediaProvider?.endpointClass === 'mock') {
      let current = job
      for (let attempt = 0; attempt < 4 && !terminalStatuses.has(current.status); attempt += 1) {
        current = await window.agentDesk.advanceMediaJob(current.id)
      }
    }
    return job
  }
  const submitSelected = (): void => void run(async () => { if (selectedShot) await submitShot(selectedShot) })
  const submitAll = (): void => void run(async () => {
    for (const shot of shots) await submitShot(shot)
  })
  const compose = (): void => void run(async () => {
    if (!projectId || !production) return
    const result = await window.agentDesk.composeMediaProduction({ projectId, productionId: production.id, shotIds: shots.map((shot) => shot.id), subtitleMode: production.timeline.subtitleMode })
    setSelectedAssetId(result.asset.id)
    setPreviewSelections((current) => ({ ...current, [production.id]: result.asset.id }))
  })
  const adoptPreview = (): void => void run(async () => {
    if (!production || !previewAsset) return
    await window.agentDesk.setMediaAdoption({ productionId: production.id, assetId: previewAsset.id, adopted: true })
  })
  const advance = (id: string): void => void run(() => window.agentDesk.advanceMediaJob(id))
  const reconcile = (id: string): void => void run(() => window.agentDesk.reconcileMediaJob(id))
  const cancel = (id: string): void => void run(() => window.agentDesk.cancelMediaJob(id))
  const activeJobCount = useMemo(() => jobs.filter((job) => !terminalStatuses.has(job.status)).length, [jobs])
  const costSummary = useMemo(() => summarizeMediaCost(production, jobs), [production?.revision, jobs])
  if (!projectId) return null
  return <section className="video-studio-panel" aria-labelledby="video-studio-title">
    <header className="video-studio-header">
      <div className="video-studio-heading">
        <h2 id="video-studio-title"><Film size={16} aria-hidden="true" />{text.overviewTitle}</h2>
        <span>{production ? text.productionSummary(visibleScenes.length, shots.length, production.assets.length) : text.noProduction}</span>
      </div>
      <div className="video-studio-header-actions">
        {production && <select className="input" value={production.id} onChange={(event) => setSelectedProductionId(event.target.value)} aria-label={text.selectProduction} data-video-production-select>
          {snapshot?.productions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>}
        <span className={ffmpeg?.available ? 'video-studio-runtime is-ready' : 'video-studio-runtime'}>{ffmpeg?.available ? text.ffmpegReady : text.ffmpegUnavailable}</span>
        <button type="button" className="btn btn-ghost btn-icon-sm" onClick={() => void refresh()} disabled={busy} aria-label={text.refreshStudio} title={text.refresh} data-video-refresh><RefreshCw size={14} aria-hidden="true" /></button>
      </div>
    </header>

    {error && <p className="video-studio-error" role="alert">{error}</p>}
    {!production ? <div className="video-studio-create">
      <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={text.productionTitlePlaceholder} aria-label={text.productionTitleLabel} />
      <textarea className="input" value={script} onChange={(event) => setScript(event.target.value)} placeholder={text.productionScriptPlaceholder} aria-label={text.productionScriptLabel} rows={5} />
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !title.trim() || !script.trim()} onClick={createProduction}><Sparkles size={14} aria-hidden="true" />{text.createStoryboard}</button>
    </div> : <div className="video-studio-workspace">
      <VideoPreviewFlow
        busy={busy}
        onCompose={compose}
        onAdopt={adoptPreview}
        previewAsset={previewAsset}
        compositionAssets={compositionAssets}
        finalAssetId={production.finalAssetId}
        onPreviewChange={(assetId) => setPreviewSelections((current) => ({ ...current, [production.id]: assetId }))}
        shotCount={shots.length}
        ffmpegAvailable={Boolean(ffmpeg?.available)}
      />
      <section className="video-studio-script" aria-label="剧本结构">
        <div className="video-studio-section-title"><strong>剧本与分镜</strong><span>结构修订 {production.structureRevisions.length}</span></div>
        <textarea className="input" value={revisionScript} onChange={(event) => setRevisionScript(event.target.value)} rows={5} aria-label="制作剧本" />
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || revisionScript.trim() === production.script} onClick={reviseProduction} data-video-revise><Sparkles size={14} aria-hidden="true" />生成新结构版本</button>
        <VideoStoryboardPlanner key={production.id} production={production} onApplied={refresh} />
        <div className="video-studio-storyboard">
          {visibleScenes.map((scene) => <div className="video-studio-scene" key={scene.id}>
            <div className="video-studio-scene-title"><strong>{scene.title}</strong><span>{scene.shotIds.length} 镜头</span><button type="button" className="btn btn-ghost btn-icon-sm" onClick={() => createShot(scene.id)} disabled={busy} aria-label={`向 ${scene.title} 添加镜头`} title="添加镜头"><Plus size={13} /></button></div>
            <div className="video-studio-shot-grid">
              {scene.shotIds.map((id, index) => {
                const shot = production.shots.find((item) => item.id === id)
                if (!shot) return null
                const bindingCount = shot.assetBindings?.length ?? 0
                return <button type="button" className={`video-studio-shot${selectedShot?.id === id ? ' is-selected' : ''}`} key={id} onClick={() => setSelectedShotId(id)}>
                  <span>{String(index + 1).padStart(2, '0')}</span><strong>{shot.title}</strong><small>{(shot.durationMs / 1_000).toFixed(1)}s · {bindingCount} 绑定</small>
                </button>
              })}
            </div>
          </div>)}
        </div>
      </section>
      <section className="video-studio-inspector" aria-label="镜头检查器">
        <div className="video-studio-section-title"><strong>镜头</strong><span>{selectedShot?.revision ? `v${selectedShot.revision}` : '-'}</span></div>
        {selectedShot && <>
          <input className="input" value={shotDraft.title} onChange={(event) => setShotDraft((value) => ({ ...value, title: event.target.value }))} aria-label="镜头标题" />
          <textarea className="input" value={shotDraft.prompt} onChange={(event) => setShotDraft((value) => ({ ...value, prompt: event.target.value }))} rows={5} aria-label="镜头提示词" />
          <label className="video-studio-duration"><span>时长</span><input className="input" type="number" min={500} max={120000} step={500} value={shotDraft.durationMs} onChange={(event) => setShotDraft((value) => ({ ...value, durationMs: Number(event.target.value) }))} /><span>ms</span></label>
          <div className="video-studio-inline-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={saveShot} disabled={busy} data-video-save-shot><Save size={14} />保存</button>
            <button type="button" className="btn btn-ghost btn-icon-sm" onClick={() => moveShot(-1)} disabled={busy} aria-label="镜头上移" title="上移"><ArrowUp size={14} /></button>
            <button type="button" className="btn btn-ghost btn-icon-sm" onClick={() => moveShot(1)} disabled={busy} aria-label="镜头下移" title="下移"><ArrowDown size={14} /></button>
          </div>
          <div className="video-studio-bindings">
            {(selectedShot.assetBindings ?? []).map((binding) => <button type="button" key={binding.id} className={binding.adopted ? 'is-adopted' : ''} onClick={() => adoptBinding(binding.id, !binding.adopted)} disabled={busy}>{binding.role} · v{binding.assetVersion}{binding.adopted ? ' · 已采用' : ' · 采用'}</button>)}
          </div>
          <div className="video-studio-dialogue">
            <div className="video-studio-subheading"><strong>对白与字幕</strong><span>{selectedShot.dialogueCues.length}</span></div>
            {selectedShot.dialogueCues.map((cue) => <div className="video-studio-cue" key={cue.id}>
              {(() => {
                const cueJob = jobs.find((job) => job.dialogueCueId === cue.id)
                return <>
              <div><strong>{cue.speaker}</strong><span>{cue.startMs}–{cue.endMs} ms</span></div>
              <p>{cue.text}</p>
              <small>{cue.audioAssetId || cue.voiceAssetId ? '已绑定音频' : '仅字幕'} · {cue.subtitleEnabled ? '字幕开启' : '字幕关闭'}{cueJob ? ` · 语音任务 ${cueJob.status}` : ''}</small>
              <div className="video-studio-cue-actions"><button type="button" className="btn btn-secondary btn-sm" disabled={busy || (!automaticMedia && !speechProvider) || (cueJob !== undefined && !terminalStatuses.has(cueJob.status))} onClick={() => generateCueAudio(cue)} aria-label="生成对白语音" title="生成对白语音"><AudioLines size={13} />{cue.audioAssetId ? '重新生成' : '生成语音'}</button><button type="button" className="btn btn-ghost btn-icon-sm" disabled={busy} onClick={() => editCue(cue)} aria-label="编辑对白" title="编辑对白"><Pencil size={13} /></button><button type="button" className="btn btn-ghost btn-icon-sm" disabled={busy} onClick={() => deleteCue(cue.id)} aria-label="删除对白" title="删除对白"><CircleMinus size={13} /></button></div>
                </>
              })()}
            </div>)}
            <div className="video-studio-cue-form">
              <input className="input" value={cueDraft.speaker} onChange={(event) => setCueDraft((value) => ({ ...value, speaker: event.target.value }))} placeholder="说话人" aria-label="对白说话人" />
              <textarea className="input" value={cueDraft.text} onChange={(event) => setCueDraft((value) => ({ ...value, text: event.target.value }))} placeholder="对白文本" aria-label="对白文本" rows={2} />
              <label><span>开始 ms</span><input className="input" type="number" min={0} max={selectedShot.durationMs} step={100} value={cueDraft.startMs} onChange={(event) => setCueDraft((value) => ({ ...value, startMs: Number(event.target.value) }))} /></label>
              <label><span>结束 ms</span><input className="input" type="number" min={1} max={selectedShot.durationMs} step={100} value={cueDraft.endMs} onChange={(event) => setCueDraft((value) => ({ ...value, endMs: Number(event.target.value) }))} /></label>
              <select className="input" value={cueDraft.audioAssetId} onChange={(event) => setCueDraft((value) => ({ ...value, audioAssetId: event.target.value }))} aria-label="对白音频">
                <option value="">无对白音频</option>{audioAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.title} · v{asset.version}</option>)}
              </select>
              <label className="video-studio-checkbox"><input type="checkbox" checked={cueDraft.subtitleEnabled} onChange={(event) => setCueDraft((value) => ({ ...value, subtitleEnabled: event.target.checked }))} /><span>生成字幕</span></label>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !cueDraft.speaker.trim() || !cueDraft.text.trim() || cueDraft.endMs <= cueDraft.startMs || cueDraft.endMs > selectedShot.durationMs} onClick={saveCue}>{editingCueId ? <Save size={13} /> : <Plus size={13} />}{editingCueId ? '保存对白' : '添加对白'}</button>
            </div>
          </div>
        </>}
      </section>
      <details className="video-studio-advanced-section" data-video-advanced-section="assets">
        <summary><strong>素材库</strong><span>{production.assets.length} 项 · 按需展开</span></summary>
      <section className="video-studio-assets" aria-label="资产库">
        <div className="video-studio-section-title"><strong>资产库</strong><span>{production.assets.filter((asset) => asset.adopted).length} 已采用</span></div>
        <div className="video-studio-storage-toolbar">
          <HardDrive size={13} aria-hidden="true" />
          <span>{formatBytes(storage?.usedBytes)} / {formatBytes(storage?.quotaBytes)}</span>
          <span>剩余 {formatBytes(storage?.availableBytes)}</span>
          <label><span>配额 GiB</span><input className="input" type="number" min={0.25} max={2048} step={0.25} value={storageQuotaDraft} onChange={(event) => setStorageQuotaDraft(event.target.value)} aria-label="项目媒体配额 GiB" /></label>
          <button type="button" className="btn btn-ghost btn-icon-sm" disabled={busy || !validQuotaGiB(storageQuotaDraft)} onClick={saveStorageQuota} aria-label="保存项目媒体配额" title="保存配额"><Save size={13} /></button>
        </div>
        <div className="video-studio-asset-toolbar">
          <select className="input" value={assetKind} onChange={(event) => setAssetKind(event.target.value as MediaAssetKind)} aria-label="素材类型">{assetKinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <button type="button" className="btn btn-secondary btn-sm" onClick={importAsset} disabled={busy}><ImagePlus size={14} />导入</button>
        </div>
        <div className="video-studio-asset-list">
          {production.assets.map((asset) => <button type="button" className={`video-studio-asset-row${selectedAsset?.id === asset.id ? ' is-selected' : ''}${asset.contentStatus !== 'available' ? ' is-unavailable' : ''}`} key={asset.id} onClick={() => setSelectedAssetId(asset.id)}>
            <span className="video-studio-asset-kind">{asset.kind}</span><strong>{asset.title}</strong><small>{assetStatusLabel(asset)} · v{asset.version} · {formatBytes(asset.sizeBytes)}</small>{asset.adopted && <Check size={13} aria-label="已采用" />}
          </button>)}
        </div>
        {selectedAsset && <>
          {selectedAssetAvailable
            ? <MediaPreview mediaType={selectedAsset.mediaType} previewUrl={selectedAsset.previewUrl} title={selectedAsset.title} />
            : <p className="video-studio-purge-state" role="status">{selectedAsset.contentStatus === 'purged' ? '内容已清理，仅保留审计记录' : `等待清理${selectedAsset.purgeError ? `：${selectedAsset.purgeError}` : ''}`}</p>}
          <div className="video-studio-retention-toolbar">
            <Clock3 size={13} aria-hidden="true" />
            <select className="input" value={retentionModeDraft} onChange={(event) => setRetentionModeDraft(event.target.value as 'retain' | 'expire')} disabled={!selectedAssetAvailable} aria-label="素材保留模式"><option value="retain">持续保留</option><option value="expire">到期清理</option></select>
            {retentionModeDraft === 'expire' && <input className="input" type="datetime-local" value={retentionUntilDraft} onChange={(event) => setRetentionUntilDraft(event.target.value)} disabled={!selectedAssetAvailable} aria-label="素材到期时间" />}
            <button type="button" className="btn btn-ghost btn-icon-sm" onClick={saveRetention} disabled={busy || !selectedAssetAvailable || (retentionModeDraft === 'expire' && !retentionUntilDraft)} aria-label="保存素材保留策略" title="保存保留策略"><Save size={13} /></button>
            <button type="button" className="btn btn-ghost btn-icon-sm is-danger" onClick={purgeAsset} disabled={busy || selectedAsset.contentStatus === 'purged' || selectedAsset.retention.mode !== 'expire' || !selectedAsset.retention.retainUntil || selectedAsset.retention.retainUntil > Date.now()} aria-label="清理到期素材" title="清理到期素材"><Trash2 size={13} /></button>
          </div>
          <div className="video-studio-asset-actions">
            <select className="input" value={bindingRole} onChange={(event) => setBindingRole(event.target.value as MediaAssetBindingRole)} aria-label="资产绑定角色">{bindingRoles.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            <button type="button" className="btn btn-secondary btn-sm" onClick={bindAsset} disabled={busy || !selectedShot || !selectedAssetAvailable}><Link2 size={14} />绑定</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={adoptAsset} disabled={busy || !selectedAssetAvailable}><Check size={14} />{selectedAsset.adopted ? '取消采用' : '采用版本'}</button>
          </div>
          {selectedAssetAvailable && selectedMediaProvider && operationNeedsAsset(selectedMediaOperation) && selectedMediaProvider.id !== 'media-provider:mock-local' && <div className="video-studio-egress-toolbar">
            <span>{selectedEgressActive ? '已允许该素材外发到当前 Provider' : '当前素材未授权外发'}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={toggleAssetEgress} disabled={busy} aria-label={selectedEgressActive ? '撤销素材外发授权' : '允许素材外发'} title={selectedEgressActive ? '撤销素材外发授权' : '允许素材外发'}>
              {selectedEgressActive ? '撤销授权' : '允许外发'}
            </button>
          </div>}
          {selectedAssetAvailable && (selectedAsset.kind === 'voice' || selectedAsset.kind === 'audio' || selectedAsset.mediaType?.startsWith('audio/')) && <div className="video-studio-egress-toolbar">
            <span>{selectedVoiceAuthorizationActive ? '已声明可用于声音克隆' : '未声明声音克隆授权'}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={toggleVoiceCloneAuthorization} disabled={busy} aria-label={selectedVoiceAuthorizationActive ? '撤销声音克隆授权' : '声明声音克隆授权'} title={selectedVoiceAuthorizationActive ? '撤销声音克隆授权' : '声明声音克隆授权'}>{selectedVoiceAuthorizationActive ? '撤销声音授权' : '声明声音授权'}</button>
          </div>}
        </>}
      </section>
      </details>
      <details className="video-studio-advanced-section" data-video-advanced-section="generation">
        <summary><strong>生成与合成</strong><span>{activeJobCount} 个任务运行中 · 按需展开</span></summary>
      <section className="video-studio-queue" aria-label="媒体任务队列">
        <div className="video-studio-section-title"><strong>生成与合成</strong><span>{activeJobCount} 运行中</span></div>
        <VideoMediaRoutingControls operation={selectedMediaOperation} selectedId={selectedMediaProviderId} preference={routingPreference}
          profiles={mediaProviders} providers={appProviders} busy={busy} onSelect={setSelectedMediaProviderId} onPreference={setRoutingPreference}
          onOperation={(operation) => { setSelectedMediaOperation(operation); setSelectedMediaProviderId(MEDIA_AUTO_PROVIDER_ID) }} run={run} />
        <div className="video-studio-budget-toolbar">
          <span>已结算 {formatUsd(costSummary.settledUsd)}</span><span>估算 {formatUsd(costSummary.estimatedUsd)}</span><span>{costSummary.unavailableCount} 未定价</span>
          <label><span>预算 USD</span><input className="input" type="number" min={0} max={1000000} step={1} value={budgetLimitDraft} onChange={(event) => setBudgetLimitDraft(event.target.value)} placeholder="不限" aria-label="媒体预算美元" /></label>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !Number.isFinite(Number(budgetLimitDraft || 0))} onClick={saveBudget}><Save size={13} />保存预算</button>
          <strong data-status={costSummary.status}>{budgetStatusLabel(costSummary.status, costSummary.limitUsd, costSummary.settledUsd)}</strong>
        </div>
        <div className="video-studio-timeline-toolbar">
          <label><span>背景音</span><select className="input" value={production.timeline.backgroundAudioAssetId ?? ''} onChange={(event) => updateTimeline({ backgroundAudioAssetId: event.target.value })} aria-label="背景音频"><option value="">无背景音</option>{audioAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.title} · v{asset.version}</option>)}</select></label>
          <label><span>音量 {Math.round(backgroundVolumeDraft * 100)}%</span><input type="range" min={0} max={1} step={0.05} value={backgroundVolumeDraft} onChange={(event) => setBackgroundVolumeDraft(Number(event.target.value))} onPointerUp={() => updateTimeline({ backgroundAudioVolume: backgroundVolumeDraft })} onBlur={() => { if (backgroundVolumeDraft !== production.timeline.backgroundAudioVolume) updateTimeline({ backgroundAudioVolume: backgroundVolumeDraft }) }} aria-label="背景音量" /></label>
          <label><span>字幕</span><select className="input" value={production.timeline.subtitleMode} onChange={(event) => updateTimeline({ subtitleMode: event.target.value as 'embedded' | 'burned_in' | 'none' })} aria-label="字幕输出模式"><option value="embedded">内嵌字幕轨</option><option value="burned_in">烧录到画面</option><option value="none">关闭字幕</option></select></label>
          <span className="video-studio-final">{finalAsset ? `最终成片 v${finalAsset.version}` : '未采用最终成片'}</span>
        </div>
        <div className="video-studio-generation-toolbar">
          {selectedMediaProvider?.endpointClass === 'mock' && <select className="input" value={scenario} onChange={(event) => setScenario(event.target.value as MediaMockScenario)} aria-label="Mock 任务结果"><option value="success">成功</option><option value="failure">失败</option><option value="rate_limit">限流</option><option value="unknown_result">未知结果</option></select>}
          {selectedMediaOperation.startsWith('speech.') && <input className="input" value={voiceDraft} onChange={(event) => setVoiceDraft(event.target.value)} placeholder="声线 ID" aria-label="TTS 声线 ID" />}
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !selectedShot || (!automaticMedia && !selectedMediaProvider) || (operationNeedsAsset(selectedMediaOperation) && !selectedAssetAvailable)} onClick={submitSelected}><WandSparkles size={14} />当前镜头</button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || shots.length === 0 || (!automaticMedia && !selectedMediaProvider) || operationNeedsAsset(selectedMediaOperation)} onClick={submitAll}><WandSparkles size={14} />批量入队</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || shots.length === 0 || !ffmpeg?.available} onClick={compose}><Film size={14} />合成 MP4</button>
        </div>
        <div className="video-studio-generation-toolbar">
          <label><span>时长秒</span><input className="input" type="number" min={1} max={3600} step={1} value={generationParameters.durationSeconds} onChange={(event) => setGenerationParameters((value) => ({ ...value, durationSeconds: Number(event.target.value) || 1 }))} aria-label="生成时长秒" /></label>
          <label><span>宽</span><input className="input" type="number" min={256} max={16384} step={1} value={generationParameters.width} onChange={(event) => setGenerationParameters((value) => ({ ...value, width: Number(event.target.value) || 256 }))} aria-label="生成宽度" /></label>
          <label><span>高</span><input className="input" type="number" min={256} max={16384} step={1} value={generationParameters.height} onChange={(event) => setGenerationParameters((value) => ({ ...value, height: Number(event.target.value) || 256 }))} aria-label="生成高度" /></label>
          <label><span>质量</span><select className="input" value={generationParameters.quality} onChange={(event) => setGenerationParameters((value) => ({ ...value, quality: event.target.value as typeof value.quality }))} aria-label="生成质量"><option value="draft">草稿</option><option value="standard">标准</option><option value="high">高</option></select></label>
          <label><span>Seed</span><input className="input" type="number" min={0} value={generationParameters.seed} onChange={(event) => setGenerationParameters((value) => ({ ...value, seed: event.target.value }))} aria-label="生成随机种子" /></label>
          {selectedMediaOperation.startsWith('speech.') && <label><span>语速</span><input className="input" type="number" min={0.25} max={4} step={0.05} value={generationParameters.speechSpeed} onChange={(event) => setGenerationParameters((value) => ({ ...value, speechSpeed: Number(event.target.value) || 1 }))} aria-label="语音速度" /></label>}
          <input className="input" value={generationParameters.negativePrompt} onChange={(event) => setGenerationParameters((value) => ({ ...value, negativePrompt: event.target.value }))} placeholder="负面提示词（可选）" aria-label="负面提示词" />
        </div>
        <div className="video-studio-job-list">
          {jobs.map((job) => <div className="video-studio-job" key={job.id}>
            <span>{production.shots.find((shot) => shot.id === job.shotId)?.title ?? job.capability}</span><strong data-status={job.status}>{job.status}</strong>{job.executionBinding && <small title={job.executionBinding.decision.considerations.join("；")}>{job.executionBinding.profile.displayName} · {job.executionBinding.decision.reason}</small>}<small>{job.downloadReceivedBytes !== undefined ? downloadProgress(job.downloadReceivedBytes, job.downloadTotalBytes) : job.cost.status === 'unavailable' ? '未定价' : formatUsd(job.cost.actualUsd ?? job.cost.estimatedUsd)}</small><code>{job.output?.digest.slice(7, 19) ?? job.id.slice(-12)}</code>
            {job.status === 'waiting_reconciliation'
              ? <button type="button" className="btn btn-ghost btn-icon-sm" disabled={busy || job.providerMode !== 'remote'} onClick={() => reconcile(job.id)} aria-label="查询媒体 Provider 外部任务结果" title="对账"><RefreshCw size={13} /></button>
              : !terminalStatuses.has(job.status) && <><button type="button" className="btn btn-ghost btn-icon-sm" disabled={busy} onClick={() => advance(job.id)} aria-label="推进媒体任务" title="推进"><Play size={13} /></button><button type="button" className="btn btn-ghost btn-icon-sm" disabled={busy} onClick={() => cancel(job.id)} aria-label="取消媒体任务" title="取消"><Ban size={13} /></button></>}
          </div>)}
        </div>
      </section>
      </details>
      <VideoContinuitySection
        busy={busy}
        production={production}
        shots={shots}
        selectedAssetAvailable={selectedAssetAvailable}
        bibleDraft={bibleDraft}
        lockDraft={lockDraft}
        onBibleDraftChange={setBibleDraft}
        onLockDraftChange={setLockDraft}
        onSaveBible={saveBible}
        onDeleteBible={deleteBible}
        onSaveContinuityLock={saveContinuityLock}
        onDeleteContinuityLock={deleteContinuityLock}
        onCheckContinuity={checkContinuity}
      />
    </div>}
  </section>
}

function useLocalizedProductionTitle(
  defaultTitle: string,
  setTitle: Dispatch<SetStateAction<string>>
): void {
  useEffect(() => {
    setTitle((current) => current === '新短片' || current === 'New video' ? defaultTitle : current)
  }, [defaultTitle, setTitle])
}

function useStorageQuotaDraft(
  quotaBytes: number | undefined,
  setDraft: Dispatch<SetStateAction<string>>
): void {
  useEffect(() => {
    setDraft(quotaBytes === undefined ? '20' : bytesToGiBInput(quotaBytes))
  }, [quotaBytes, setDraft])
}

function useAssetRetentionDraft(
  asset: MediaAsset | undefined,
  setMode: Dispatch<SetStateAction<'retain' | 'expire'>>,
  setUntil: Dispatch<SetStateAction<string>>
): void {
  const assetId = asset?.id
  const revision = asset?.retention.revision
  useEffect(() => {
    setMode(asset?.retention.mode ?? 'retain')
    setUntil(asset?.retention.retainUntil ? timestampToLocalInput(asset.retention.retainUntil) : '')
  }, [assetId, asset, revision, setMode, setUntil])
}

function VideoPreviewFlow({
  busy,
  ffmpegAvailable,
  onAdopt,
  onCompose,
  previewAsset,
  compositionAssets,
  finalAssetId,
  onPreviewChange,
  shotCount
}: {
  busy: boolean
  ffmpegAvailable: boolean
  onAdopt: () => void
  onCompose: () => void
  previewAsset?: MediaAsset
  compositionAssets: MediaAsset[]
  finalAssetId?: string
  onPreviewChange: (assetId: string) => void
  shotCount: number
}): React.JSX.Element {
  const previewAdopted = Boolean(previewAsset && previewAsset.id === finalAssetId)
  const finalAsset = compositionAssets.find((asset) => asset.id === finalAssetId)
  return (
    <section className="video-studio-preview-flow" aria-label="视频预览" data-video-preview-flow data-video-preview-asset={previewAsset?.id ?? ''}>
      <div className="video-studio-preview-flow-heading">
        <div>
          <strong>预览</strong>
          <span>{previewAsset ? `本地草稿 v${previewAsset.version}${finalAsset ? ` · 已采用成片 v${finalAsset.version}` : ' · 尚未采用成片'}` : `${shotCount} 个镜头，尚未生成草稿`}</span>
        </div>
        <div className="video-studio-inline-actions video-studio-header-actions">
          {previewAsset && <select className="input" value={previewAsset.id} onChange={(event) => onPreviewChange(event.target.value)} disabled={busy} aria-label="预览合成版本" data-video-preview-version>
            {compositionAssets.map((asset) => <option key={asset.id} value={asset.id}>本地草稿 v{asset.version}{asset.id === finalAssetId ? ' · 已采用成片' : ''}{asset.contentStatus !== 'available' ? ' · 文件不可用' : ''}</option>)}
          </select>}
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !ffmpegAvailable || shotCount === 0} onClick={onCompose} data-video-compose-preview>
            <Film size={13} aria-hidden="true" />生成本地预览
          </button>
          {previewAsset && <button type="button" className="btn btn-secondary btn-sm" disabled={busy || previewAdopted || previewAsset.contentStatus !== 'available'} onClick={onAdopt} data-video-adopt-preview>
            <Check size={13} aria-hidden="true" />{previewAdopted ? '已采用为成片' : '采用为成片'}
          </button>}
        </div>
      </div>
      {previewAsset?.contentStatus === 'available' && previewAsset.previewUrl && previewAsset.mediaType
        ? <MediaPreview key={previewAsset.id} mediaType={previewAsset.mediaType} previewUrl={previewAsset.previewUrl} title={previewAsset.title} />
        : <p className="video-studio-preview-empty">{previewAsset ? '此版本的文件当前不可用，请选择其他版本或重新生成本地预览。' : '先点击“生成本地预览”，即可检查当前分镜的可播放结果。'}</p>}
    </section>
  )
}

function MediaPreview({ mediaType, previewUrl, title }: { mediaType?: string; previewUrl?: string; title: string }): React.JSX.Element | null {
  if (!previewUrl || !mediaType) return null
  if (mediaType.startsWith('image/')) return <img className="video-studio-preview" data-video-preview src={previewUrl} alt={title} />
  if (mediaType.startsWith('video/')) return <video className="video-studio-preview" data-video-preview src={previewUrl} controls preload="auto" autoPlay muted playsInline aria-label={title} />
  if (mediaType.startsWith('audio/')) return <audio className="video-studio-audio" src={previewUrl} controls preload="metadata" aria-label={title} />
  return null
}

const assetKinds: Array<[MediaAssetKind, string]> = [['character', '角色'], ['scene', '场景'], ['prop', '道具'], ['voice', '声线'], ['image', '图片'], ['video', '视频'], ['audio', '音频'], ['subtitle', '字幕']]
const bindingRoles: Array<[MediaAssetBindingRole, string]> = [['character', '角色'], ['costume', '服装'], ['scene', '场景'], ['prop', '道具'], ['keyframe', '关键帧'], ['voice', '声线'], ['subtitle', '字幕'], ['audio_track', '音轨']]
function operationNeedsAsset(operation: MediaOperation): boolean {
  return operation === 'image.edit' || operation === 'video.image-to-video' || operation === 'video.reference-to-video' || operation === 'speech.voice-clone'
}
const errorText = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)
const ruleLines = (value: string): string[] => value.split('\n').map((line) => line.trim()).filter(Boolean)
const formatBytes = (value?: number): string => value === undefined ? '-' : value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`
const formatUsd = (value: number | undefined): string => value === undefined ? '未知' : `$${value.toFixed(4)}`
function mediaStorageSummary(snapshot: MediaStudioSnapshot | null, projectId?: string): { quotaBytes: number; usedBytes: number; availableBytes: number } | undefined {
  if (!snapshot || !projectId) return undefined
  const quotaBytes = snapshot.projectStorage.find((item) => item.projectId === projectId)?.quotaBytes ?? 20 * 1024 ** 3
  const digests = new Set<string>()
  let usedBytes = 0
  for (const asset of snapshot.productions.flatMap((item) => item.assets)) {
    if (asset.contentStatus === 'purged' || !asset.digest || asset.sizeBytes === undefined || digests.has(asset.digest)) continue
    digests.add(asset.digest)
    usedBytes += asset.sizeBytes
  }
  for (const job of snapshot.jobs) {
    if (job.output || !job.preparedOutputDigest || !job.preparedOutputSizeBytes || digests.has(job.preparedOutputDigest)) continue
    digests.add(job.preparedOutputDigest)
    usedBytes += job.preparedOutputSizeBytes
  }
  return { quotaBytes, usedBytes, availableBytes: Math.max(0, quotaBytes - usedBytes) }
}
const bytesToGiBInput = (value: number): string => String(Number((value / 1024 ** 3).toFixed(2)))
const validQuotaGiB = (value: string): boolean => Number.isFinite(Number(value)) && Number(value) >= 0.25 && Number(value) <= 2048
const timestampToLocalInput = (value: number): string => {
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}
const assetStatusLabel = (asset: MediaAsset): string => asset.contentStatus === 'purged' ? '已清理' : asset.contentStatus === 'purge_pending' ? '等待清理' : asset.retention.mode === 'expire' ? '到期清理' : '可用'
const downloadProgress = (received: number, total?: number): string => total && total > 0 ? `${formatBytes(received)} / ${formatBytes(total)} · ${Math.min(100, Math.floor(received / total * 100))}%` : `${formatBytes(received)} 已下载`
function summarizeMediaCost(production: VideoProduction | undefined, jobs: MediaStudioSnapshot['jobs']) {
  const scoped = production ? jobs.filter((job) => job.productionId === production.id) : []
  const settledUsd = scoped.reduce((sum, job) => sum + (job.cost.status === 'settled' ? job.cost.actualUsd ?? 0 : 0), 0)
  const estimatedUsd = scoped.reduce((sum, job) => sum + (job.cost.estimatedUsd ?? 0), 0)
  const unavailableCount = scoped.filter((job) => job.cost.status === 'unavailable').length
  const limitUsd = production?.budget.limitUsd
  const status = unavailableCount > 0 ? 'unknown' : limitUsd === undefined || limitUsd === 0 ? 'unlimited' : settledUsd > limitUsd ? 'exceeded' : settledUsd >= limitUsd * production!.budget.warningThreshold ? 'warning' : 'within_budget'
  return { settledUsd, estimatedUsd, unavailableCount, limitUsd, status }
}
function budgetStatusLabel(status: string, limitUsd?: number, settledUsd = 0): string { return ({ unlimited: '未限制', within_budget: `剩余 ${formatUsd(Math.max(0, (limitUsd ?? 0) - settledUsd))}`, warning: '接近预算', exceeded: '已超预算', unknown: '含未定价任务' } as Record<string, string>)[status] ?? status }
