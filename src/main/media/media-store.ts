import { parseVideoScript } from './media-script-parser'
import { assertSameBusinessLine, newBusinessLineId, storedBusinessLineId } from '../business-line-ownership'
import { assertProductionCreationReplay, mediaProductionCreationDigest, productionScript } from './media-production-identity'
import { parseVideoStoryboardDraft } from '../../shared/video-storyboard-types'
import { localMediaCost as localCost, normalizeMediaCost, providerEstimatedCost, validMoney } from './media-cost'
import { createHash, randomUUID } from 'node:crypto'
import type { MediaExecutionBinding } from '../../shared/media-types'
import { assertMediaSubmissionBudget } from './media-budget'
import { resolveSubmissionMediaProfile } from './media-submission-profile'
import { assertMediaSubmissionReconciled } from './media-reconciliation-identity'
import { mediaJobIdForKey, normalizeMediaIdempotencyKey } from './media-submission-identity'
import { mediaStoreRoot } from './media-store-root'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  MediaAdoptionInput,
  MediaAsset,
  MediaAssetBinding,
  MediaAssetBindingInput,
  MediaAssetCommitInput,
  MediaAssetPurgeTarget,
  MediaAssetEgressInput,
  MediaAssetEgressGrant,
  MediaAssetRetentionUpdateInput,
  MediaBudgetUpdateInput,
  MediaCharacterBible,
  MediaCharacterBibleDeleteInput,
  MediaCharacterBibleInput,
  MediaContinuityCheckSummary,
  MediaContinuityLock,
  MediaContinuityLockDeleteInput,
  MediaContinuityLockInput,
  MediaDialogueCue,
  MediaDialogueCueDeleteInput,
  MediaDialogueCueInput,
  MediaJobInput,
  MediaJobOutput,
  MediaJobRecord,
  MediaGenerationParameters,
  MediaVoiceCloneAuthorization,
  MediaVoiceCloneAuthorizationInput,
  MediaJobStatus,
  MediaMockScenario,
  MediaOperation,
  MediaProductionInput,
  MediaProductionRevisionInput,
  MediaShotInput,
  MediaShotUpdateInput,
  MediaProjectSlice,
  MediaProjectStorageSettings,
  MediaProjectStorageUpdateInput,
  MediaProviderProfile,
  MediaProviderProfileInput,
  MediaProviderProfileDeleteInput,
  MediaStudioSnapshot,
  MediaTimelineUpdateInput,
  VideoProduction,
  VideoScene,
  VideoShot,
  VideoStructureRevision
} from '../../shared/media-types'
import { MEDIA_SCHEMA_VERSION } from '../../shared/media-types'
import { writeDurableFile } from '../durable-file'
import { canonicalJson, digest, requiredId, requiredText } from '../project-workspace/codec'

const FILE_NAME = 'media-studio.json'

interface MediaDocument {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  revision: number
  productions: VideoProduction[]
  jobs: MediaJobRecord[]
  providers: MediaProviderProfile[]
  projectStorage: MediaProjectStorageSettings[]
}

export interface MediaJobCanonicalBinding {
  businessLineId?: string
  goalId: string
  workItemId: string
  runId: string
  effectId: string
}

export interface MediaJobOperationCommit {
  operation: 'submit' | 'poll' | 'download' | 'cancel'
  status: MediaJobStatus
  binding: MediaJobCanonicalBinding
  reason?: string
  remoteOutputRef?: string
  remoteOutputMediaType?: string
  providerExternalJobId?: string
  preparedOutputPath?: string
  preparedOutputDigest?: string
  preparedOutputSizeBytes?: number
  downloadReceivedBytes?: number
  downloadTotalBytes?: number
  actualUsd?: number
  billingReceiptDigest?: string
  output?: MediaJobOutput
}

const empty = (): MediaDocument => ({ schemaVersion: MEDIA_SCHEMA_VERSION, revision: 0, productions: [], jobs: [], providers: defaultProviders(), projectStorage: [] })
const clone = <T,>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const ALL_MEDIA_OPERATIONS: MediaOperation[] = [
  'image.generate', 'image.edit', 'video.text-to-video', 'video.image-to-video',
  'video.reference-to-video', 'speech.synthesize', 'speech.voice-clone', 'media.compose'
]

function normalize(value: unknown): MediaDocument {
  if (!value || typeof value !== 'object') throw new Error('Media store is invalid')
  const candidate = value as { schemaVersion?: unknown; revision?: unknown; productions?: unknown; jobs?: unknown; providers?: unknown; projectStorage?: unknown }
  if (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2 && candidate.schemaVersion !== 3 && candidate.schemaVersion !== 4 && candidate.schemaVersion !== 5 && candidate.schemaVersion !== 6 && candidate.schemaVersion !== 7 && candidate.schemaVersion !== 8 && candidate.schemaVersion !== 9 && candidate.schemaVersion !== 10 && candidate.schemaVersion !== 11 &&
      candidate.schemaVersion !== MEDIA_SCHEMA_VERSION) {
    throw new Error('Media store schema is unsupported')
  }
  if (!Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 0 ||
      !Array.isArray(candidate.productions) || !Array.isArray(candidate.jobs)) {
    throw new Error('Media store collections are invalid')
  }
  return migrateDocument(candidate as {
    schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | typeof MEDIA_SCHEMA_VERSION
    revision: number
    productions: Array<Record<string, unknown>>
    jobs: Array<Record<string, unknown>>
    providers?: Array<Record<string, unknown>>
    projectStorage?: Array<Record<string, unknown>>
  })
}

function migrateDocument(candidate: {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | typeof MEDIA_SCHEMA_VERSION
  revision: number
  productions: Array<Record<string, unknown>>
  jobs: Array<Record<string, unknown>>
  providers?: Array<Record<string, unknown>>
  projectStorage?: Array<Record<string, unknown>>
}): MediaDocument {
  const productions = candidate.productions.map((raw) => migrateProduction(raw))
  const jobs = candidate.jobs.map((raw) => migrateJob(raw))
  const providers = (candidate.providers ?? defaultProviders()).map((raw) => migrateProvider(raw))
  const projectStorage = (candidate.projectStorage ?? []).map((raw) => migrateProjectStorage(raw))
  return { schemaVersion: MEDIA_SCHEMA_VERSION, revision: candidate.revision, productions, jobs, providers, projectStorage }
}

export function normalizeMediaProjectSliceForImport(value: unknown): MediaProjectSlice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Media project slice is invalid')
  const candidate = clone(value) as Record<string, unknown>
  const schemaVersion = Number(candidate.schemaVersion)
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > MEDIA_SCHEMA_VERSION ||
      typeof candidate.projectId !== 'string' || !candidate.projectId.trim() ||
      !Array.isArray(candidate.productions) || !Array.isArray(candidate.jobs) ||
      typeof candidate.mediaDigest !== 'string') {
    throw new Error('Media project slice is invalid')
  }
  const { mediaDigest, ...sourceBody } = candidate
  if (digest(sourceBody) !== mediaDigest) throw new Error('Media project slice digest mismatch')
  const projectId = requiredId(candidate.projectId, 'projectId')
  const productions = (candidate.productions as Array<Record<string, unknown>>).map(migrateProduction)
  const jobs = (candidate.jobs as Array<Record<string, unknown>>).map(migrateJob)
  const providers = (Array.isArray(candidate.providers) ? candidate.providers : defaultProviders())
    .map((record) => migrateProvider(record as Record<string, unknown>))
  const projectStorage = (Array.isArray(candidate.projectStorage) ? candidate.projectStorage : [])
    .map((record) => migrateProjectStorage(record as Record<string, unknown>))
  const body = { schemaVersion: MEDIA_SCHEMA_VERSION, projectId, productions, jobs, providers, projectStorage }
  return { ...body, mediaDigest: digest(body) }
}

function migrateProduction(raw: Record<string, unknown>): VideoProduction {
  const production = clone(raw) as unknown as VideoProduction
  production.schemaVersion = MEDIA_SCHEMA_VERSION
  production.businessLineId = storedBusinessLineId(raw.businessLineId)
  production.episodes = (production.episodes ?? []).map((record) => ({ ...record, schemaVersion: MEDIA_SCHEMA_VERSION }))
  production.scenes = (production.scenes ?? []).map((record) => ({ ...record, schemaVersion: MEDIA_SCHEMA_VERSION }))
  production.shots = (production.shots ?? []).map((record) => ({
    ...record,
    schemaVersion: MEDIA_SCHEMA_VERSION,
    assetBindings: (record.assetBindings ?? []).map((binding) => ({ ...binding, schemaVersion: MEDIA_SCHEMA_VERSION })),
    dialogueCues: (record.dialogueCues ?? []).map((cue) => ({ ...cue, schemaVersion: MEDIA_SCHEMA_VERSION }))
  }))
  production.assets = (production.assets ?? []).map((record) => ({ ...record, schemaVersion: MEDIA_SCHEMA_VERSION }))
  production.assets = production.assets.map((record) => ({
    ...record,
    adopted: record.adopted === true,
    authorization: record.authorization ?? {
      source: record.artifactId ? 'provider_output' : 'user_import',
      status: record.artifactId ? 'generated' : 'declared_by_user',
      dataEgress: record.artifactId ? 'provider' : 'none'
    },
    egressGrants: normalizeEgressGrants(record.egressGrants),
    voiceCloneAuthorizations: normalizeVoiceCloneAuthorizations(record.voiceCloneAuthorizations),
    cost: normalizeMediaCost(record.cost, record.authorization?.source === 'provider_output' ? 'unavailable' : 'settled', production.updatedAt),
    retention: normalizeAssetRetention(record.retention, record.createdAt),
    contentStatus: record.contentStatus === 'purged' || record.contentStatus === 'purge_pending' ? record.contentStatus : 'available'
  }))
  production.structureRevisions = (production.structureRevisions ?? []).map((record) => ({
    ...record,
    schemaVersion: MEDIA_SCHEMA_VERSION
  }))
  if (production.structureRevisions.length === 0) {
    const structure = structureRevision(production, production.revision || 1, production.createdAt, true)
    production.structureRevisions = [structure]
    production.adoptedStructureRevisionId = structure.id
  } else if (!production.adoptedStructureRevisionId) {
    production.adoptedStructureRevisionId = production.structureRevisions.at(-1)!.id
  }
  const timeline = production.timeline
  production.timeline = {
    schemaVersion: MEDIA_SCHEMA_VERSION,
    productionId: production.id,
    backgroundAudioVolume: normalizeBackgroundVolume(timeline?.backgroundAudioVolume),
    subtitleMode: normalizeSubtitleMode(timeline?.subtitleMode),
    revision: Number.isSafeInteger(timeline?.revision) && timeline.revision > 0 ? timeline.revision : 1,
    updatedAt: Number.isFinite(timeline?.updatedAt) ? timeline.updatedAt : production.updatedAt,
    ...(timeline?.backgroundAudioAssetId ? { backgroundAudioAssetId: timeline.backgroundAudioAssetId } : {})
  }
  production.budget = {
    schemaVersion: MEDIA_SCHEMA_VERSION,
    productionId: production.id,
    ...(validMoney(production.budget?.limitUsd) ? { limitUsd: production.budget.limitUsd } : {}),
    warningThreshold: validThreshold(production.budget?.warningThreshold) ? production.budget.warningThreshold : 0.8,
    revision: Number.isSafeInteger(production.budget?.revision) && production.budget.revision > 0 ? production.budget.revision : 1,
    updatedAt: Number.isFinite(production.budget?.updatedAt) ? production.budget.updatedAt : production.updatedAt
  }
  production.characterBibles = (production.characterBibles ?? []).map((record) => ({ ...record, schemaVersion: MEDIA_SCHEMA_VERSION }))
  production.continuityLocks = (production.continuityLocks ?? []).map((record) => ({ ...record, schemaVersion: MEDIA_SCHEMA_VERSION }))
  if (production.latestContinuityCheck) production.latestContinuityCheck.schemaVersion = MEDIA_SCHEMA_VERSION
  if (production.finalAssetId && !production.assets.some((asset) => asset.id === production.finalAssetId)) {
    production.finalAssetId = undefined
  }
  return production
}

function migrateJob(raw: Record<string, unknown>): MediaJobRecord {
  const job = clone(raw) as unknown as MediaJobRecord
  job.schemaVersion = MEDIA_SCHEMA_VERSION
  job.businessLineId = storedBusinessLineId(raw.businessLineId)
  job.providerMode = job.providerMode === 'remote' ? 'remote' : 'mock'
  job.operation = validMediaOperation(job.operation) ? job.operation : defaultMediaOperation(job.capability)
  job.parameters = normalizeGenerationParameters(job.parameters)
  job.parametersDigest = typeof job.parametersDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(job.parametersDigest)
    ? job.parametersDigest
    : `sha256:${sha256(canonicalJson(job.parameters))}`
  job.inputAssetIds = Array.isArray(job.inputAssetIds) ? [...new Set(job.inputAssetIds.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())))] : []
  if (job.dialogueCueId !== undefined && typeof job.dialogueCueId !== 'string') delete job.dialogueCueId
  if (typeof job.preparedOutputPath !== 'string' || !job.preparedOutputPath.trim()) delete job.preparedOutputPath
  if (typeof job.preparedOutputDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(job.preparedOutputDigest)) delete job.preparedOutputDigest
  if (!Number.isSafeInteger(job.preparedOutputSizeBytes) || Number(job.preparedOutputSizeBytes) <= 0) delete job.preparedOutputSizeBytes
  if (!Number.isSafeInteger(job.downloadReceivedBytes) || Number(job.downloadReceivedBytes) < 0) delete job.downloadReceivedBytes
  if (!Number.isSafeInteger(job.downloadTotalBytes) || Number(job.downloadTotalBytes) <= 0) delete job.downloadTotalBytes
  if (job.mediaProviderId !== undefined && typeof job.mediaProviderId !== 'string') delete job.mediaProviderId
  job.mockScenario = normalizeMockScenario(job.mockScenario)
  job.operationRunIds = Array.isArray(job.operationRunIds) ? [...new Set(job.operationRunIds.filter(Boolean))] : job.runId ? [job.runId] : []
  job.effectIds = Array.isArray(job.effectIds) ? [...new Set(job.effectIds.filter(Boolean))] : job.effectId ? [job.effectId] : []
  job.statusHistory = Array.isArray(job.statusHistory) && job.statusHistory.length > 0
    ? job.statusHistory.map((event) => ({ ...event }))
    : [{ status: job.status, observedAt: job.updatedAt, ...(job.runId ? { runId: job.runId } : {}), ...(job.effectId ? { effectId: job.effectId } : {}) }]
  job.cost = normalizeMediaCost(job.cost, job.providerMode === 'mock' ? 'settled' : 'unavailable', job.updatedAt)
  if (job.providerMode === 'remote' && job.status === 'waiting_reconciliation') {
    job.reconciliationAttempts = nonNegativeInteger(job.reconciliationAttempts)
    job.lastReconciledAt = finiteOptionalTimestamp(job.lastReconciledAt)
    job.nextReconcileAt = finiteOptionalTimestamp(job.nextReconcileAt) ?? job.updatedAt
  } else {
    delete job.nextReconcileAt
  }
  return job
}

function snapshot(document: MediaDocument, projectId?: string): MediaStudioSnapshot {
  const productions = projectId ? document.productions.filter((item) => item.projectId === projectId) : document.productions
  const productionIds = new Set(productions.map((item) => item.id))
  const jobs = document.jobs.filter((item) => productionIds.has(item.productionId))
  const projectStorage = projectId
    ? [document.projectStorage.find((item) => item.projectId === projectId) ?? defaultProjectStorage(projectId)]
    : document.projectStorage
  const body = { schemaVersion: MEDIA_SCHEMA_VERSION, revision: document.revision, productions, jobs, providers: document.providers, projectStorage }
  return { ...clone(body), snapshotDigest: digest(body) }
}

function migrateProjectStorage(raw: Record<string, unknown> | MediaProjectStorageSettings): MediaProjectStorageSettings {
  const value = raw as Partial<MediaProjectStorageSettings>
  return {
    schemaVersion: MEDIA_SCHEMA_VERSION,
    projectId: requiredId(value.projectId ?? '', 'media storage projectId'),
    quotaBytes: normalizeStorageQuota(value.quotaBytes),
    revision: Number.isSafeInteger(value.revision) && Number(value.revision) > 0 ? Number(value.revision) : 1,
    updatedAt: Number.isFinite(value.updatedAt) ? Number(value.updatedAt) : 0
  }
}

function defaultProviders(): MediaProviderProfile[] {
  return [{
    schemaVersion: MEDIA_SCHEMA_VERSION,
    id: 'media-provider:mock-local',
    displayName: '本地 Mock（零成本）',
    capabilities: ['image', 'video', 'tts', 'synthesis'],
    operations: ALL_MEDIA_OPERATIONS,
    endpointClass: 'mock',
    defaultFor: ['image', 'video', 'tts', 'synthesis'],
    enabled: true,
    createdAt: 0,
    updatedAt: 0
  }]
}

function migrateProvider(raw: Record<string, unknown> | MediaProviderProfile): MediaProviderProfile {
  const value = clone(raw) as Partial<MediaProviderProfile>
  const now = Date.now()
  const capabilities: MediaProviderProfile['capabilities'] = Array.isArray(value.capabilities)
    ? value.capabilities.filter((item): item is MediaProviderProfile['capabilities'][number] => ['image', 'video', 'tts', 'synthesis'].includes(String(item)))
    : ['video']
  const operations = Array.isArray(value.operations)
    ? value.operations.filter((item): item is MediaOperation => validMediaOperation(item))
    : capabilities.flatMap((capability) => ALL_MEDIA_OPERATIONS.filter((operation) => operationCapability(operation) === capability))
  const endpointClass = ['mock', 'openai-compatible', 'anthropic-compatible', 'openai-image', 'openai-speech', 'openai-video', 'generic-async', 'local-ffmpeg'].includes(String(value.endpointClass))
    ? value.endpointClass as MediaProviderProfile['endpointClass']
    : 'mock'
  const rawVerification = value.verification && typeof value.verification === 'object'
    ? value.verification as NonNullable<MediaProviderProfile['verification']>
    : undefined
  const verification = rawVerification && ['verified', 'failed', 'unknown'].includes(rawVerification.state)
    ? {
      state: rawVerification.state,
      ...(Array.isArray(rawVerification.operations)
        ? { operations: rawVerification.operations.filter((item): item is MediaOperation => validMediaOperation(item)) }
        : {}),
      ...(Number.isFinite(rawVerification.verifiedAt) ? { verifiedAt: Number(rawVerification.verifiedAt) } : {}),
      ...(typeof rawVerification.reason === 'string' ? { reason: rawVerification.reason.slice(0, 240) } : {})
    } as NonNullable<MediaProviderProfile['verification']>
    : undefined
  return {
    schemaVersion: MEDIA_SCHEMA_VERSION,
    id: requiredId(value.id ?? `media-provider:${randomUUID()}`, 'media provider id'),
    displayName: requiredText(value.displayName ?? '媒体 Provider', 'media provider name').slice(0, 160),
    capabilities: [...new Set(capabilities)],
    operations: [...new Set(operations)],
    endpointClass,
    ...(value.providerId ? { providerId: requiredId(value.providerId, 'providerId') } : {}),
    ...(value.model ? { model: requiredText(value.model, 'media provider model').slice(0, 240) } : {}),
    ...(Array.isArray(value.defaultFor) ? { defaultFor: [...new Set(value.defaultFor.filter((item): item is MediaProviderProfile['capabilities'][number] => capabilities.includes(item as never)))] } : {}),
    ...(Number.isSafeInteger(value.requestTimeoutMs) && Number(value.requestTimeoutMs) >= 1_000 && Number(value.requestTimeoutMs) <= 300_000 ? { requestTimeoutMs: Number(value.requestTimeoutMs) } : {}),
    ...(validMediaPath(value.submitPath) ? { submitPath: value.submitPath } : {}),
    ...(validMediaPathTemplate(value.statusPathTemplate) ? { statusPathTemplate: value.statusPathTemplate } : {}),
    ...(validMediaPathTemplate(value.downloadPathTemplate) ? { downloadPathTemplate: value.downloadPathTemplate } : {}),
    ...(validMediaPathTemplate(value.cancelPathTemplate) ? { cancelPathTemplate: value.cancelPathTemplate } : {}),
    ...(validMoney(value.estimatedCostUsd) ? { estimatedCostUsd: value.estimatedCostUsd } : {}),
    ...(verification ? { verification } : {}),
    enabled: value.enabled !== false,
    createdAt: Number.isFinite(value.createdAt) ? Number(value.createdAt) : now,
    updatedAt: Number.isFinite(value.updatedAt) ? Number(value.updatedAt) : now
  }
}

export class MediaStore {
  private state: MediaDocument | undefined
  private initialLoad: Promise<MediaDocument> | undefined
  private queue: Promise<void> = Promise.resolve()
  private readonly filePath: string

  constructor(private readonly rootDir: string) {
    this.filePath = join(rootDir, FILE_NAME)
  }

  private async read(): Promise<MediaDocument> {
    if (this.state) return clone(this.state)
    const initialLoad = this.initialLoad ??= this.loadInitialState()
    try {
      return clone(await initialLoad)
    } catch (error) {
      if (this.initialLoad === initialLoad) this.initialLoad = undefined
      throw error
    }
  }

  private async loadInitialState(): Promise<MediaDocument> {
    try {
      this.state = normalize(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') this.state = empty()
      else if (error instanceof SyntaxError) throw new Error(`Media store is corrupt: ${error.message}`)
      else throw error
    }
    return this.state
  }

  private async mutate<T>(fn: (state: MediaDocument, now: number) => T): Promise<T> {
    const previous = this.queue
    let release!: () => void
    this.queue = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const state = await this.read()
      const result = fn(state, Date.now())
      state.revision += 1
      await writeDurableFile(this.filePath, `${canonicalJson(state)}\n`, { mode: 0o600 })
      this.state = state
      return clone(result)
    } finally {
      release()
    }
  }

  getMediaStudio(projectId?: string): Promise<MediaStudioSnapshot> {
    return this.read().then((state) => snapshot(state, projectId))
  }

  updateMediaProjectStorage(input: MediaProjectStorageUpdateInput): Promise<MediaProjectStorageSettings> {
    return this.mutate((state, now) => {
      const projectId = requiredId(input.projectId, 'projectId')
      if (!state.productions.some((production) => production.projectId === projectId)) throw new Error('Media Project was not found')
      const quotaBytes = normalizeStorageQuota(input.quotaBytes)
      const usedBytes = projectStorageUsage(state, projectId)
      if (quotaBytes < usedBytes) throw new Error(`Media project quota cannot be lower than current usage (${usedBytes} bytes)`)
      const existing = state.projectStorage.find((item) => item.projectId === projectId)
      const record: MediaProjectStorageSettings = {
        schemaVersion: MEDIA_SCHEMA_VERSION,
        projectId,
        quotaBytes,
        revision: (existing?.revision ?? 0) + 1,
        updatedAt: now
      }
      if (existing) state.projectStorage[state.projectStorage.indexOf(existing)] = record
      else state.projectStorage.push(record)
      return record
    })
  }

  async assertProjectStorageAvailable(projectId: string, incomingBytes = 0): Promise<{ settings: MediaProjectStorageSettings; usedBytes: number; availableBytes: number }> {
    const id = requiredId(projectId, 'projectId')
    if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0) throw new Error('Media incoming byte count is invalid')
    const state = await this.read()
    const settings = state.projectStorage.find((item) => item.projectId === id) ?? defaultProjectStorage(id)
    const used = projectStorageUsage(state, id)
    if (used > settings.quotaBytes || incomingBytes > settings.quotaBytes - used) {
      throw new Error(`Media project storage quota exceeded (${used} used of ${settings.quotaBytes} bytes)`)
    }
    return { settings: clone(settings), usedBytes: used, availableBytes: settings.quotaBytes - used }
  }

  async listRecoverableMediaDownloadJobIds(limit = 8): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error('Media download recovery limit is invalid')
    return (await this.read()).jobs
      .filter((job) => job.providerMode === 'remote' && job.status === 'downloading')
      .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((job) => job.id)
  }

  async listMediaAssetPurgeTargets(now = Date.now(), limit = 8): Promise<MediaAssetPurgeTarget[]> {
    if (!Number.isFinite(now) || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
      throw new Error('Media asset purge scan is invalid')
    }
    const targets: MediaAssetPurgeTarget[] = []
    for (const production of (await this.read()).productions) {
      for (const asset of production.assets) {
        const retainUntil = asset.retention.retainUntil
        if (asset.contentStatus === 'purged' || asset.retention.mode !== 'expire' || !retainUntil || retainUntil > now) continue
        if (asset.contentStatus === 'available' && assetPurgeBlockReason(production, asset)) continue
        targets.push({
          projectId: production.projectId,
          productionId: production.id,
          assetId: asset.id,
          contentStatus: asset.contentStatus,
          retainUntil
        })
      }
    }
    return targets
      .sort((left, right) => left.retainUntil - right.retainUntil || left.assetId.localeCompare(right.assetId))
      .slice(0, limit)
  }

  listMediaProviders(): Promise<MediaProviderProfile[]> {
    return this.read().then((state) => clone(state.providers))
  }

  upsertMediaProvider(input: MediaProviderProfileInput): Promise<MediaProviderProfile> {
    return this.mutate((state, now) => {
      const id = input.id?.trim() || `media-provider:${randomUUID()}`
      const next = migrateProvider({
        ...input,
        id,
        createdAt: state.providers.find((item) => item.id === id)?.createdAt ?? now,
        updatedAt: now
      } as Record<string, unknown>)
      for (const provider of state.providers) {
        if (provider.id !== id && next.defaultFor?.length && provider.defaultFor?.length) {
          provider.defaultFor = provider.defaultFor.filter((capability) => !next.defaultFor!.includes(capability))
          provider.updatedAt = now
        }
      }
      const index = state.providers.findIndex((item) => item.id === id)
      if (index >= 0) state.providers[index] = next
      else state.providers.push(next)
      return next
    })
  }

  deleteMediaProvider(input: MediaProviderProfileDeleteInput): Promise<void> {
    return this.mutate((state) => {
      const id = requiredId(input.id, 'media provider id')
      if (id === 'media-provider:mock-local') throw new Error('Built-in local Mock Provider cannot be deleted')
      if (state.jobs.some((job) => job.mediaProviderId === id && !['succeeded', 'failed', 'cancelled'].includes(job.status))) {
        throw new Error('Media Provider has active jobs')
      }
      state.providers = state.providers.filter((provider) => provider.id !== id)
    })
  }

  async getMediaJob(jobId: string): Promise<MediaJobRecord | undefined> {
    const id = requiredId(jobId, 'mediaJobId')
    return clone((await this.read()).jobs.find((item) => item.id === id))
  }

  async findMediaJobByIdempotencyKey(idempotencyKey: string): Promise<MediaJobRecord | undefined> {
    const key = normalizeMediaIdempotencyKey(idempotencyKey)
    return clone((await this.read()).jobs.find((item) => item.idempotencyKey === key))
  }

  async countProject(projectId: string): Promise<{ productions: number; jobs: number }> {
    const id = requiredId(projectId, 'projectId')
    const state = await this.read()
    return {
      productions: state.productions.filter((item) => item.projectId === id).length,
      jobs: state.jobs.filter((item) => item.projectId === id).length
    }
  }

  async listDueMediaReconciliationJobIds(now = Date.now(), limit = 8): Promise<string[]> {
    if (!Number.isFinite(now) || now < 0) throw new Error('Media reconciliation time is invalid')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error('Media reconciliation limit is invalid')
    return (await this.read()).jobs
      .filter((job) => job.providerMode === 'remote' && job.status === 'waiting_reconciliation' &&
        (job.nextReconcileAt ?? job.updatedAt) <= now)
      .sort((left, right) => (left.nextReconcileAt ?? left.updatedAt) - (right.nextReconcileAt ?? right.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((job) => job.id)
  }

  deferMediaJobReconciliation(jobId: string, reason: string): Promise<MediaJobRecord> {
    return this.mutate((state, now) => {
      const job = state.jobs.find((item) => item.id === requiredId(jobId, 'mediaJobId'))
      if (!job) throw new Error('MediaJob was not found')
      if (job.providerMode !== 'remote' || job.status !== 'waiting_reconciliation') return job
      scheduleMediaReconciliation(job, now)
      job.error = requiredText(reason, 'media reconciliation reason').slice(0, 500)
      job.updatedAt = now
      return job
    })
  }

  async listUnsharedLegacyRemoteOutputPaths(projectId: string): Promise<string[]> {
    const id = requiredId(projectId, 'projectId')
    const state = await this.read()
    const otherProjectRefs = new Set(state.jobs
      .filter((job) => job.projectId !== id && job.providerMode === 'remote' && job.output?.blobRef)
      .map((job) => job.output!.blobRef))
    return [...new Set(state.jobs
      .filter((job) => job.projectId === id && job.providerMode === 'remote' && job.output?.blobRef)
      .map((job) => job.output!.blobRef))]
      .filter((path) => !otherProjectRefs.has(path))
      .sort()
  }

  async exportProjectSlice(projectId: string): Promise<MediaProjectSlice> {
    const id = requiredId(projectId, 'projectId')
    const state = await this.read()
    const productions = state.productions.filter((item) => item.projectId === id)
    const productionIds = new Set(productions.map((item) => item.id))
    const jobs = state.jobs.filter((item) => productionIds.has(item.productionId))
    const providers = state.providers
    const projectStorage = state.projectStorage.filter((item) => item.projectId === id)
    const body = { schemaVersion: MEDIA_SCHEMA_VERSION, projectId: id, productions, jobs, providers, projectStorage }
    return { ...clone(body), mediaDigest: digest(body) }
  }

  async importProjectSlice(slice: MediaProjectSlice): Promise<void> {
    const normalized = normalizeMediaProjectSliceForImport(slice)
    const id = requiredId(normalized.projectId, 'projectId')
    for (const production of normalized.productions) {
      if (production.projectId !== id) throw new Error('Media project slice Production ownership is invalid')
      for (const shot of production.shots) {
        if (!production.scenes.some((scene) => scene.shotIds.includes(shot.id))) throw new Error('Media project slice Shot closure is invalid')
      }
    }
    for (const job of normalized.jobs) {
      if (job.projectId !== id || !normalized.productions.some((production) => production.id === job.productionId)) {
        throw new Error('Media project slice MediaJob ownership is invalid')
      }
    }
    await this.mutate((state) => {
      const existing = state.productions.filter((item) => item.projectId === id)
      const existingJobs = state.jobs.filter((item) => item.projectId === id)
      if (existing.length || existingJobs.length) {
        if (digest({ schemaVersion: MEDIA_SCHEMA_VERSION, projectId: id, productions: existing, jobs: existingJobs, providers: state.providers, projectStorage: state.projectStorage.filter((item) => item.projectId === id) }) !== normalized.mediaDigest) {
          throw new Error(`Media project import identity conflict: ${id}`)
        }
        return
      }
      state.productions.push(...clone(normalized.productions))
      state.jobs.push(...clone(normalized.jobs))
      state.projectStorage.push(...normalized.projectStorage.map((item) => migrateProjectStorage(item)))
      for (const provider of normalized.providers) {
        if (!state.providers.some((candidate) => candidate.id === provider.id)) state.providers.push(clone(provider))
      }
    })
  }

  createVideoProduction(input: MediaProductionInput): Promise<VideoProduction> {
    return this.mutate((state, now) => {
      const projectId = requiredId(input.projectId, 'projectId')
      const title = requiredText(input.title, 'production title').slice(0, 240)
      const script = productionScript(input.script)
      const existing = input.id ? state.productions.find((item) => item.id === input.id) : undefined
      if (existing) {
        assertProductionCreationReplay(existing, input, { projectId, title, script })
        return existing
      }
      const id = input.id?.trim() || `production:${randomUUID()}`
      const episodeId = `episode:${randomUUID()}`
      const parsed = input.storyboardDraft ? parseVideoStoryboardDraft(input.storyboardDraft).scenes
        : input.autoStructure === false ? [{ title: 'Scene 1', summary: script.slice(0, 500), shots: [] }] : parseVideoScript(script)
      const scenes: VideoScene[] = parsed.map((item) => ({
        schemaVersion: MEDIA_SCHEMA_VERSION,
        id: `scene:${randomUUID()}`,
        episodeId,
        title: item.title,
        summary: item.summary,
        shotIds: [],
        revision: 1,
        createdAt: now,
        updatedAt: now
      }))
      const episode = {
        schemaVersion: MEDIA_SCHEMA_VERSION,
        id: episodeId,
        productionId: id,
        title: 'Episode 1',
        sceneIds: scenes.map((scene) => scene.id),
        revision: 1,
        createdAt: now,
        updatedAt: now
      }
      const production: VideoProduction = {
        schemaVersion: MEDIA_SCHEMA_VERSION,
        id,
        projectId,
        businessLineId: newBusinessLineId(input.businessLineId, undefined, 'video'),
        creationRequestDigest: mediaProductionCreationDigest(input),
        title,
        script,
        revision: 1,
        episodes: [episode],
        scenes,
        shots: [],
        assets: [],
        structureRevisions: [],
        adoptedStructureRevisionId: '',
        timeline: {
          schemaVersion: MEDIA_SCHEMA_VERSION,
          productionId: id,
          backgroundAudioVolume: 0.2,
          subtitleMode: 'embedded',
          revision: 1,
          updatedAt: now
        },
        budget: {
          schemaVersion: MEDIA_SCHEMA_VERSION,
          productionId: id,
          warningThreshold: 0.8,
          revision: 1,
          updatedAt: now
        },
        characterBibles: [],
        continuityLocks: [],
        createdAt: now,
        updatedAt: now
      }
      for (let sceneIndex = 0; sceneIndex < parsed.length; sceneIndex += 1) {
        const scene = scenes[sceneIndex]
        for (const item of parsed[sceneIndex].shots) {
          const shot = newShot(scene.id, item.title, item.prompt, item.durationMs, now)
          production.shots.push(shot)
          scene.shotIds.push(shot.id)
        }
      }
      const structure = structureRevision(production, 1, now, true)
      production.structureRevisions.push(structure)
      production.adoptedStructureRevisionId = structure.id
      state.productions.push(production)
      return production
    })
  }

  reviseVideoProduction(input: MediaProductionRevisionInput): Promise<VideoProduction> {
    return this.mutate((state, now) => {
      const production = state.productions.find((item) => item.id === requiredId(input.productionId, 'productionId'))
      if (!production) throw new Error('VideoProduction was not found')
      const script = productionScript(input.script)
      if (input.expectedRevision !== undefined && input.expectedRevision !== production.revision) throw new Error('制作项目已更新，请重新生成或核对分镜草稿后再采用')
      if (script === production.script && !input.storyboardDraft) return production
      const parsed = input.storyboardDraft ? parseVideoStoryboardDraft(input.storyboardDraft).scenes : parseVideoScript(script)
      const episode = production.episodes[0]
      if (!episode) throw new Error('VideoProduction Episode is missing')
      const scenes: VideoScene[] = parsed.map((item) => ({
        schemaVersion: MEDIA_SCHEMA_VERSION,
        id: `scene:${randomUUID()}`,
        episodeId: episode.id,
        title: item.title,
        summary: item.summary,
        shotIds: [],
        revision: 1,
        createdAt: now,
        updatedAt: now
      } satisfies VideoScene))
      const shots: VideoShot[] = []
      parsed.forEach((item, index) => item.shots.forEach((candidate) => {
        const shot = newShot(scenes[index].id, candidate.title, candidate.prompt, candidate.durationMs, now)
        scenes[index].shotIds.push(shot.id)
        shots.push(shot)
      }))
      production.script = script
      production.scenes = [...production.scenes, ...scenes]
      production.shots = [...production.shots, ...shots]
      episode.sceneIds = scenes.map((scene) => scene.id)
      episode.revision += 1
      episode.updatedAt = now
      production.revision += 1
      production.updatedAt = now
      const structure = structureRevision(production, production.revision, now, true, scenes, shots)
      production.structureRevisions.push(structure)
      production.adoptedStructureRevisionId = structure.id
      return production
    })
  }

  addVideoShot(input: MediaShotInput): Promise<VideoShot> {
    return this.mutate((state, now) => {
      const production = state.productions.find((item) => item.id === requiredId(input.productionId, 'productionId'))
      if (!production) throw new Error('VideoProduction was not found')
      const scene = production.scenes.find((item) => item.id === requiredId(input.sceneId, 'sceneId'))
      if (!scene) throw new Error('VideoScene was not found')
      const shot = newShot(
        scene.id,
        requiredText(input.title, 'shot title').slice(0, 240),
        requiredText(input.prompt, 'shot prompt').slice(0, 20_000),
        mediaDuration(input.durationMs),
        now
      )
      production.shots.push(shot)
      scene.shotIds.push(shot.id)
      production.revision += 1
      production.updatedAt = now
      return shot
    })
  }

  updateVideoShot(input: MediaShotUpdateInput): Promise<VideoShot> {
    return this.mutate((state, now) => {
      const production = state.productions.find((item) => item.id === requiredId(input.productionId, 'productionId'))
      if (!production) throw new Error('VideoProduction was not found')
      const shot = production.shots.find((item) => item.id === requiredId(input.shotId, 'shotId'))
      if (!shot) throw new Error('VideoShot was not found')
      if (input.title !== undefined) shot.title = requiredText(input.title, 'shot title').slice(0, 240)
      if (input.prompt !== undefined) shot.prompt = requiredText(input.prompt, 'shot prompt').slice(0, 20_000)
      if (input.durationMs !== undefined) {
        const durationMs = mediaDuration(input.durationMs)
        if (shot.dialogueCues.some((cue) => cue.endMs > durationMs)) {
          throw new Error('VideoShot duration cannot end before an existing Dialogue cue')
        }
        shot.durationMs = durationMs
      }
      const scene = production.scenes.find((item) => item.id === shot.sceneId)
      if (!scene) throw new Error('VideoShot Scene was not found')
      if (input.beforeShotId !== undefined) {
        const beforeId = input.beforeShotId ? requiredId(input.beforeShotId, 'beforeShotId') : ''
        const reordered = scene.shotIds.filter((id) => id !== shot.id)
        const index = beforeId ? reordered.indexOf(beforeId) : -1
        if (beforeId && index < 0) throw new Error('VideoShot reorder target is outside Scene')
        reordered.splice(index < 0 ? reordered.length : index, 0, shot.id)
        scene.shotIds = reordered
        scene.revision += 1
        scene.updatedAt = now
      }
      shot.revision += 1
      shot.updatedAt = now
      production.revision += 1
      production.updatedAt = now
      return shot
    })
  }

  upsertMediaDialogueCue(input: MediaDialogueCueInput): Promise<MediaDialogueCue> {
    return this.mutate((state, now) => {
      const production = state.productions.find((item) => item.id === requiredId(input.productionId, 'productionId'))
      if (!production) throw new Error('VideoProduction was not found')
      const shot = production.shots.find((item) => item.id === requiredId(input.shotId, 'shotId'))
      if (!shot) throw new Error('VideoShot was not found')
      const startMs = cueTime(input.startMs, 'Dialogue startMs')
      const endMs = cueTime(input.endMs, 'Dialogue endMs')
      if (endMs <= startMs || endMs > shot.durationMs) {
        throw new Error('Dialogue cue timing must be ordered within the Shot duration')
      }
      const voiceAssetId = optionalOwnedCueAsset(production, input.voiceAssetId, 'voice')
      const audioAssetId = optionalOwnedCueAsset(production, input.audioAssetId, 'audio')
      const id = input.id ? requiredId(input.id, 'dialogueCueId') : `dialogue:${randomUUID()}`
      const existing = shot.dialogueCues.find((cue) => cue.id === id)
      if (existing && existing.shotId !== shot.id) throw new Error('Dialogue cue scope is invalid')
      const cue: MediaDialogueCue = existing ?? {
        schemaVersion: MEDIA_SCHEMA_VERSION,
        id,
        shotId: shot.id,
        speaker: '',
        text: '',
        startMs,
        endMs,
        subtitleEnabled: true,
        revision: 0,
        createdAt: now,
        updatedAt: now
      }
      cue.speaker = requiredText(input.speaker, 'dialogue speaker').slice(0, 160)
      cue.text = requiredText(input.text, 'dialogue text').slice(0, 4_000)
      cue.startMs = startMs
      cue.endMs = endMs
      cue.voiceAssetId = voiceAssetId
      cue.audioAssetId = audioAssetId
      cue.subtitleEnabled = input.subtitleEnabled !== false
      cue.revision += 1
      cue.updatedAt = now
      if (!existing) shot.dialogueCues.push(cue)
      shot.dialogueCues.sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
      shot.revision += 1
      shot.updatedAt = now
      production.revision += 1
      production.updatedAt = now
      return cue
    })
  }

  deleteMediaDialogueCue(input: MediaDialogueCueDeleteInput): Promise<VideoShot> {
    return this.mutate((state, now) => {
      const production = state.productions.find((item) => item.id === requiredId(input.productionId, 'productionId'))
      if (!production) throw new Error('VideoProduction was not found')
      const shot = production.shots.find((item) => item.id === requiredId(input.shotId, 'shotId'))
      if (!shot) throw new Error('VideoShot was not found')
      const cueId = requiredId(input.cueId, 'dialogueCueId')
      if (!shot.dialogueCues.some((cue) => cue.id === cueId)) throw new Error('Dialogue cue was not found')
      shot.dialogueCues = shot.dialogueCues.filter((cue) => cue.id !== cueId)
      shot.revision += 1
      shot.updatedAt = now
      production.revision += 1
      production.updatedAt = now
      return shot
    })
  }

  updateMediaTimeline(input: MediaTimelineUpdateInput): Promise<VideoProduction> {
    return this.mutate((state, now) => {
      const production = state.productions.find((item) => item.id === requiredId(input.productionId, 'productionId'))
      if (!production) throw new Error('VideoProduction was not found')
      if (input.backgroundAudioAssetId !== undefined) {
        production.timeline.backgroundAudioAssetId = input.backgroundAudioAssetId
          ? optionalOwnedCueAsset(production, input.backgroundAudioAssetId, 'audio')
          : undefined
      }
      if (input.backgroundAudioVolume !== undefined) {
        if (!Number.isFinite(input.backgroundAudioVolume) || input.backgroundAudioVolume < 0 || input.backgroundAudioVolume > 1) {
          throw new Error('Background audio volume must be between 0 and 1')
        }
        production.timeline.backgroundAudioVolume = input.backgroundAudioVolume
      }
      if (input.subtitleMode !== undefined) production.timeline.subtitleMode = normalizeSubtitleMode(input.subtitleMode)
      production.timeline.revision += 1
      production.timeline.updatedAt = now
      production.revision += 1
      production.updatedAt = now
      return production
    })
  }

  updateMediaBudget(input: MediaBudgetUpdateInput): Promise<VideoProduction> {
    return this.mutate((state, now) => {
      const production = requiredProduction(state, input.productionId)
      if (input.limitUsd !== undefined) {
        if (!validMoney(input.limitUsd)) throw new Error('Media budget limit must be a non-negative USD amount')
        production.budget.limitUsd = input.limitUsd
      }
      if (input.warningThreshold !== undefined) {
        if (!validThreshold(input.warningThreshold)) throw new Error('Media budget warning threshold must be between 0.1 and 1')
        production.budget.warningThreshold = input.warningThreshold
      }
      production.budget.revision += 1
      production.budget.updatedAt = now
      touchProduction(production, now)
      return production
    })
  }

  upsertMediaCharacterBible(input: MediaCharacterBibleInput): Promise<MediaCharacterBible> {
    return this.mutate((state, now) => {
      const production = requiredProduction(state, input.productionId)
      const id = input.id ? requiredId(input.id, 'characterBibleId') : `character-bible:${randomUUID()}`
      const existing = production.characterBibles.find((item) => item.id === id)
      const referenceAssetIds = uniqueIds(input.referenceAssetIds ?? [], 'referenceAssetId')
      for (const assetId of referenceAssetIds) {
        const asset = production.assets.find((candidate) => candidate.id === assetId)
        if (!asset) throw new Error('Character Bible reference Asset is outside Production scope')
        assertMediaAssetAvailable(asset)
      }
      const bible: MediaCharacterBible = existing ?? {
        schemaVersion: MEDIA_SCHEMA_VERSION,
        id,
        productionId: production.id,
        name: '',
        summary: '',
        appearanceRules: [],
        voiceRules: [],
        behaviorRules: [],
        referenceAssetIds: [],
        revision: 0,
        createdAt: now,
        updatedAt: now
      }
      bible.name = requiredText(input.name, 'character Bible name').slice(0, 160)
      bible.summary = requiredText(input.summary, 'character Bible summary').slice(0, 4_000)
      bible.appearanceRules = normalizedRules(input.appearanceRules)
      bible.voiceRules = normalizedRules(input.voiceRules)
      bible.behaviorRules = normalizedRules(input.behaviorRules)
      bible.referenceAssetIds = referenceAssetIds
      bible.revision += 1
      bible.updatedAt = now
      if (!existing) production.characterBibles.push(bible)
      touchProduction(production, now)
      return bible
    })
  }

  deleteMediaCharacterBible(input: MediaCharacterBibleDeleteInput): Promise<VideoProduction> {
    return this.mutate((state, now) => {
      const production = requiredProduction(state, input.productionId)
      const bibleId = requiredId(input.bibleId, 'characterBibleId')
      if (!production.characterBibles.some((bible) => bible.id === bibleId)) throw new Error('Character Bible was not found')
      production.characterBibles = production.characterBibles.filter((bible) => bible.id !== bibleId)
      production.continuityLocks = production.continuityLocks.map((lock) => lock.bibleId === bibleId ? { ...lock, bibleId: undefined, revision: lock.revision + 1, updatedAt: now } : lock)
      touchProduction(production, now)
      return production
    })
  }

  upsertMediaContinuityLock(input: MediaContinuityLockInput): Promise<MediaContinuityLock> {
    return this.mutate((state, now) => {
      const production = requiredProduction(state, input.productionId)
      const asset = production.assets.find((item) => item.id === requiredId(input.assetId, 'assetId'))
      if (!asset) throw new Error('Continuity Asset is outside Production scope')
      assertMediaAssetAvailable(asset)
      const targetShotIds = uniqueIds(input.targetShotIds, 'targetShotId')
      if (targetShotIds.length === 0 || targetShotIds.some((shotId) => !production.shots.some((shot) => shot.id === shotId))) {
        throw new Error('Continuity Lock needs Production-owned target Shots')
      }
      const bibleId = input.bibleId ? requiredId(input.bibleId, 'characterBibleId') : undefined
      if (bibleId && !production.characterBibles.some((bible) => bible.id === bibleId)) throw new Error('Continuity Lock Character Bible was not found')
      if (!['character', 'costume', 'scene', 'prop', 'voice'].includes(input.role)) throw new Error('Continuity Lock role is invalid')
      const id = input.id ? requiredId(input.id, 'continuityLockId') : `continuity-lock:${randomUUID()}`
      const existing = production.continuityLocks.find((item) => item.id === id)
      const lock: MediaContinuityLock = existing ?? {
        schemaVersion: MEDIA_SCHEMA_VERSION,
        id,
        productionId: production.id,
        label: '',
        role: input.role,
        assetId: asset.id,
        assetVersion: asset.version,
        targetShotIds: [],
        enabled: true,
        revision: 0,
        createdAt: now,
        updatedAt: now
      }
      lock.bibleId = bibleId
      lock.label = requiredText(input.label, 'continuity Lock label').slice(0, 240)
      lock.role = input.role
      lock.assetId = asset.id
      lock.assetVersion = asset.version
      lock.targetShotIds = targetShotIds
      lock.enabled = input.enabled !== false
      lock.revision += 1
      lock.updatedAt = now
      if (!existing) production.continuityLocks.push(lock)
      for (const shotId of targetShotIds) {
        const shot = production.shots.find((candidate) => candidate.id === shotId)!
        const bindingId = `binding:${sha256(`${shot.id}\0${asset.id}\0${input.role}`).slice(0, 32)}`
        let binding = (shot.assetBindings ?? []).find((candidate) => candidate.id === bindingId)
        for (const candidate of shot.assetBindings ?? []) {
          if (candidate.role === input.role) {
            candidate.adopted = false
            candidate.updatedAt = now
          }
        }
        if (!binding) {
          binding = {
            schemaVersion: MEDIA_SCHEMA_VERSION,
            id: bindingId,
            shotId: shot.id,
            assetId: asset.id,
            role: input.role,
            assetVersion: asset.version,
            adopted: true,
            createdAt: now,
            updatedAt: now
          }
          shot.assetBindings = [...(shot.assetBindings ?? []), binding]
        } else {
          binding.assetVersion = asset.version
          binding.adopted = true
          binding.updatedAt = now
        }
        shot.assetIds = [...new Set([...shot.assetIds, asset.id])]
        shot.revision += 1
        shot.updatedAt = now
      }
      touchProduction(production, now)
      return lock
    })
  }

  deleteMediaContinuityLock(input: MediaContinuityLockDeleteInput): Promise<VideoProduction> {
    return this.mutate((state, now) => {
      const production = requiredProduction(state, input.productionId)
      const lockId = requiredId(input.lockId, 'continuityLockId')
      if (!production.continuityLocks.some((lock) => lock.id === lockId)) throw new Error('Continuity Lock was not found')
      production.continuityLocks = production.continuityLocks.filter((lock) => lock.id !== lockId)
      touchProduction(production, now)
      return production
    })
  }

  commitMediaContinuityCheck(productionId: string, summary: MediaContinuityCheckSummary): Promise<MediaContinuityCheckSummary> {
    return this.mutate((state, now) => {
      const production = requiredProduction(state, productionId)
      if (summary.productionId !== production.id) throw new Error('Continuity Check Production scope is invalid')
      production.latestContinuityCheck = clone(summary)
      touchProduction(production, now)
      return summary
    })
  }

  addMediaAsset(productionId: string, asset: MediaAsset): Promise<MediaAsset> {
    return this.mutate((state, now) => {
      const production = state.productions.find((item) => item.id === requiredId(productionId, 'productionId'))
      if (!production || asset.productionId !== production.id) throw new Error('MediaAsset Production scope is invalid')
      const existing = production.assets.find((item) => item.id === asset.id)
      if (existing) {
        if (digest(existing) !== digest(asset)) throw new Error('MediaAsset identity conflict')
        return existing
      }
      production.assets.push(clone(asset))
      production.revision += 1
      production.updatedAt = now
      return asset
    })
  }

  commitMediaAsset(input: MediaAssetCommitInput): Promise<MediaAsset> {
    return this.mutate((state, now) => {
      const production = state.productions.find((item) => item.id === requiredId(input.asset.productionId, 'productionId'))
      if (!production) throw new Error('MediaAsset Production was not found')
      const existing = production.assets.find((item) => item.id === input.asset.id)
      if (existing) return existing
      const asset = {
        ...clone(input.asset),
        retention: normalizeAssetRetention(input.asset.retention, input.asset.createdAt),
        contentStatus: input.asset.contentStatus ?? 'available',
        previewUrl: mediaPreviewUrl(requiredId(input.output.artifactId, 'artifactId'))
      }
      production.assets.push(asset)
      production.revision += 1
      production.updatedAt = now
      return asset
    })
  }

  updateMediaAssetRetention(input: MediaAssetRetentionUpdateInput): Promise<MediaAsset> {
    return this.mutate((state, now) => {
      const production = state.productions.find((item) => item.id === requiredId(input.productionId, 'productionId') && item.projectId === requiredId(input.projectId, 'projectId'))
      const asset = production?.assets.find((item) => item.id === requiredId(input.assetId, 'assetId'))
      if (!production || !asset || !asset.artifactId) throw new Error('MediaAsset retention target is invalid')
      if (asset.contentStatus !== 'available') throw new Error('MediaAsset content is not available')
      const retainUntil = input.mode === 'expire' ? positiveRetentionTimestamp(input.retainUntil) : undefined
      asset.retention = {
        mode: input.mode,
        ...(retainUntil === undefined ? {} : { retainUntil }),
        revision: (asset.retention?.revision ?? 0) + 1,
        updatedAt: now
      }
      touchProduction(production, now)
      return asset
    })
  }

  setMediaAssetEgress(input: MediaAssetEgressInput, catalogProfile?: MediaProviderProfile): Promise<MediaAsset> {
    return this.mutate((state, now) => {
      const production = state.productions.find((item) => item.id === requiredId(input.productionId, 'productionId') && item.projectId === requiredId(input.projectId, 'projectId'))
      const asset = production?.assets.find((item) => item.id === requiredId(input.assetId, 'assetId'))
      const provider = resolveSubmissionMediaProfile(state.providers, input.mediaProviderId, catalogProfile)
      if (!production || !asset || !provider) throw new Error('Media egress target is invalid')
      if (asset.contentStatus !== 'available') throw new Error('MediaAsset content is not available')
      if (!provider.enabled || !provider.operations.includes(input.operation)) throw new Error('Media Provider does not support this operation')
      if (!ALL_MEDIA_OPERATIONS.includes(input.operation)) throw new Error('Media operation is invalid')
      if (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now)) throw new Error('Media egress expiry is invalid')
      const existing = (asset.egressGrants ?? []).find((grant) => grant.mediaProviderId === provider.id && grant.operation === input.operation && grant.assetVersion === asset.version)
      if (existing) {
        existing.status = input.approved ? 'granted' : 'revoked'
        if (input.approved) {
          existing.grantedAt = now
          existing.revokedAt = undefined
          existing.expiresAt = input.expiresAt
        } else {
          existing.revokedAt = now
        }
        existing.decisionDigest = `sha256:${sha256(`${asset.id}\0${asset.version}\0${provider.id}\0${input.operation}\0${existing.status}\0${existing.grantedAt}\0${existing.revokedAt ?? ''}\0${existing.expiresAt ?? ''}`)}`
        touchProduction(production, now)
        return asset
      }
      const status = input.approved ? 'granted' : 'revoked'
      const grant: MediaAssetEgressGrant = {
        schemaVersion: MEDIA_SCHEMA_VERSION,
        id: `egress:${sha256(`${asset.id}\0${asset.version}\0${provider.id}\0${input.operation}`).slice(0, 32)}`,
        mediaProviderId: provider.id,
        ...(provider.providerId ? { providerId: provider.providerId } : {}),
        operation: input.operation,
        assetVersion: asset.version,
        status,
        grantedAt: now,
        ...(status === 'revoked' ? { revokedAt: now } : {}),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        decisionDigest: `sha256:${sha256(`${asset.id}\0${asset.version}\0${provider.id}\0${input.operation}\0${status}\0${now}\0${input.expiresAt ?? ''}`)}`
      }
      asset.egressGrants = [...(asset.egressGrants ?? []), grant]
      touchProduction(production, now)
      return asset
    })
  }

  setMediaVoiceCloneAuthorization(input: MediaVoiceCloneAuthorizationInput): Promise<MediaAsset> {
    return this.mutate((state, now) => {
      const production = state.productions.find((item) => item.id === requiredId(input.productionId, 'productionId') && item.projectId === requiredId(input.projectId, 'projectId'))
      const asset = production?.assets.find((item) => item.id === requiredId(input.assetId, 'assetId'))
      if (!production || !asset) throw new Error('Voice clone authorization target is invalid')
      if (!['voice', 'audio'].includes(asset.kind) && !asset.mediaType?.startsWith('audio/')) throw new Error('Voice clone authorization requires an audio asset')
      if (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now)) throw new Error('Voice clone authorization expiry is invalid')
      const basis = input.basis ?? 'authorized'
      if (!['self', 'authorized', 'licensed'].includes(basis)) throw new Error('Voice clone authorization basis is invalid')
      const status = input.approved ? 'granted' : 'revoked'
      const previous = (asset.voiceCloneAuthorizations ?? []).find((item) => item.assetVersion === asset.version)
      const authorization: MediaVoiceCloneAuthorization = {
        schemaVersion: MEDIA_SCHEMA_VERSION,
        id: previous?.id ?? `voice-auth:${sha256(`${asset.id}\0${asset.version}`).slice(0, 32)}`,
        assetVersion: asset.version,
        basis,
        status,
        declaredAt: previous?.declaredAt ?? now,
        ...(status === 'revoked' ? { revokedAt: now } : {}),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        decisionDigest: `sha256:${sha256(`${asset.id}\0${asset.version}\0${basis}\0${status}\0${now}\0${input.expiresAt ?? ''}`)}`
      }
      asset.voiceCloneAuthorizations = [...(asset.voiceCloneAuthorizations ?? []).filter((item) => item.assetVersion !== asset.version), authorization]
      touchProduction(production, now)
      return asset
    })
  }

  markMediaAssetPurgePending(input: MediaAssetRetentionUpdateInput): Promise<MediaAsset> {
    return this.mutate((state, now) => {
      const production = state.productions.find((item) => item.id === requiredId(input.productionId, 'productionId') && item.projectId === requiredId(input.projectId, 'projectId'))
      const asset = production?.assets.find((item) => item.id === requiredId(input.assetId, 'assetId'))
      if (!production || !asset || !asset.artifactId) throw new Error('MediaAsset purge target is invalid')
      assertAssetPurgeable(production, asset, now)
      asset.contentStatus = 'purge_pending'
      delete asset.purgeError
      touchProduction(production, now)
      return asset
    })
  }

  finishMediaAssetPurge(input: { projectId: string; productionId: string; assetId: string; purgedAt: number }): Promise<MediaAsset> {
    return this.mutate((state, now) => {
      const production = state.productions.find((item) => item.id === requiredId(input.productionId, 'productionId') && item.projectId === requiredId(input.projectId, 'projectId'))
      const asset = production?.assets.find((item) => item.id === requiredId(input.assetId, 'assetId'))
      if (!production || !asset) throw new Error('MediaAsset purge target is invalid')
      asset.contentStatus = 'purged'
      asset.purgedAt = input.purgedAt
      asset.previewUrl = undefined
      delete asset.purgeError
      touchProduction(production, now)
      return asset
    })
  }

  failMediaAssetPurge(input: { projectId: string; productionId: string; assetId: string; error: string }): Promise<MediaAsset> {
    return this.mutate((state, now) => {
      const production = state.productions.find((item) => item.id === requiredId(input.productionId, 'productionId') && item.projectId === requiredId(input.projectId, 'projectId'))
      const asset = production?.assets.find((item) => item.id === requiredId(input.assetId, 'assetId'))
      if (!production || !asset) throw new Error('MediaAsset purge target is invalid')
      asset.contentStatus = 'purge_pending'
      asset.purgeError = requiredText(input.error, 'purge error').slice(0, 500)
      touchProduction(production, now)
      return asset
    })
  }

  bindMediaAsset(input: MediaAssetBindingInput): Promise<MediaAssetBinding> {
    return this.mutate((state, now) => {
      const production = state.productions.find((item) => item.id === requiredId(input.productionId, 'productionId'))
      if (!production) throw new Error('VideoProduction was not found')
      const shot = production.shots.find((item) => item.id === requiredId(input.shotId, 'shotId'))
      const asset = production.assets.find((item) => item.id === requiredId(input.assetId, 'assetId'))
      if (!shot || !asset) throw new Error('MediaAsset binding scope is invalid')
      assertMediaAssetAvailable(asset)
      const bindingId = `binding:${sha256(`${shot.id}\0${asset.id}\0${input.role}`).slice(0, 32)}`
      const existing = shot.assetBindings?.find((item) => item.id === bindingId)
      if (existing) return existing
      const binding: MediaAssetBinding = {
        schemaVersion: MEDIA_SCHEMA_VERSION,
        id: bindingId,
        shotId: shot.id,
        assetId: asset.id,
        role: input.role,
        assetVersion: asset.version,
        adopted: false,
        createdAt: now,
        updatedAt: now
      }
      shot.assetBindings = [...(shot.assetBindings ?? []), binding]
      shot.assetIds = [...new Set([...shot.assetIds, asset.id])]
      shot.revision += 1
      shot.updatedAt = now
      production.revision += 1
      production.updatedAt = now
      return binding
    })
  }

  setMediaAdoption(input: MediaAdoptionInput): Promise<VideoProduction> {
    return this.mutate((state, now) => {
      const production = state.productions.find((item) => item.id === requiredId(input.productionId, 'productionId'))
      if (!production) throw new Error('VideoProduction was not found')
      if (input.assetId) {
        const asset = production.assets.find((item) => item.id === requiredId(input.assetId, 'assetId'))
        if (!asset) throw new Error('MediaAsset was not found')
        if (input.adopted) assertMediaAssetAvailable(asset)
        const isFinalComposition = asset.kind === 'video' && asset.authorization?.source === 'local_composition'
        if (isFinalComposition && input.adopted) {
          for (const candidate of production.assets) {
            if (candidate.kind === 'video' && candidate.authorization?.source === 'local_composition') candidate.adopted = false
          }
          asset.adopted = true
          production.finalAssetId = asset.id
        } else {
          asset.adopted = input.adopted === true
          if (production.finalAssetId === asset.id && !asset.adopted) production.finalAssetId = undefined
        }
      } else if (input.bindingId) {
        const binding = production.shots.flatMap((shot) => shot.assetBindings ?? [])
          .find((item) => item.id === requiredId(input.bindingId, 'bindingId'))
        if (!binding) throw new Error('MediaAssetBinding was not found')
        if (input.adopted) {
          const asset = production.assets.find((candidate) => candidate.id === binding.assetId)
          if (!asset) throw new Error('MediaAssetBinding Asset was not found')
          assertMediaAssetAvailable(asset)
        }
        if (input.adopted) {
          const shot = production.shots.find((candidate) => candidate.id === binding.shotId)
          for (const candidate of shot?.assetBindings ?? []) {
            if (candidate.role === binding.role) candidate.adopted = false
          }
        }
        binding.adopted = input.adopted === true
        binding.updatedAt = now
      } else {
        throw new Error('Media adoption target is missing')
      }
      production.revision += 1
      production.updatedAt = now
      return production
    })
  }

  validateMediaJobInput(input: MediaJobInput, selectedProfile?: MediaProviderProfile): Promise<{ production: VideoProduction; jobId: string; externalJobId: string }> {
    return this.read().then((state) => {
      const projectId = requiredId(input.projectId, 'projectId')
      const productionId = requiredId(input.productionId, 'productionId')
      const production = state.productions.find((item) => item.id === productionId && item.projectId === projectId)
      if (!production) throw new Error('Media job Project/Production scope is invalid')
      if (input.shotId && !production.shots.some((shot) => shot.id === input.shotId)) {
        throw new Error('Media job Shot is outside Production scope')
      }
      const dialogueCue = input.dialogueCueId
        ? production.shots.flatMap((shot) => shot.dialogueCues).find((cue) => cue.id === input.dialogueCueId && cue.shotId === input.shotId)
        : undefined
      if (input.dialogueCueId && !dialogueCue) throw new Error('Media job Dialogue cue is outside Shot scope')
      if (input.dialogueCueId && input.capability !== 'tts') throw new Error('Dialogue cue binding requires a TTS capability')
      const idempotencyKey = normalizeMediaIdempotencyKey(input.idempotencyKey)
      const mediaProvider = selectedProfile ?? state.providers.find((provider) => provider.id === input.mediaProviderId)
      const operation = input.operation ?? defaultMediaOperation(input.capability)
      normalizeGenerationParameters(input.parameters)
      if (mediaProvider && mediaProvider.id !== 'media-provider:mock-local' && input.inputAssetIds?.length) {
        for (const assetId of validateJobInputAssets(production, input.inputAssetIds)) {
          const asset = production.assets.find((candidate) => candidate.id === assetId)
          const grant = asset?.egressGrants?.find((candidate) => candidate.mediaProviderId === mediaProvider.id && candidate.operation === operation && candidate.assetVersion === asset.version && candidate.status === 'granted' && (candidate.expiresAt === undefined || candidate.expiresAt > Date.now()))
          if (!grant) throw new Error(`MediaAsset ${assetId} requires explicit external-provider authorization for ${operation}`)
        }
      }
      if (mediaProvider && mediaProvider.id !== 'media-provider:mock-local' && operation === 'speech.voice-clone') {
        assertVoiceCloneAuthorization(production, input.inputAssetIds ?? [], Date.now())
      }
      assertMediaSubmissionBudget(production, state.jobs, mediaProvider)
      return {
        production: clone(production),
        jobId: mediaJobIdForKey(idempotencyKey),
        externalJobId: `${input.mediaProviderId && input.mediaProviderId !== 'media-provider:mock-local' ? 'remote' : 'mock'}:${sha256(idempotencyKey)}`
      }
    })
  }

  prepareMediaJobSubmission(input: MediaJobInput, binding: MediaJobCanonicalBinding, executionBinding?: MediaExecutionBinding): Promise<MediaJobRecord> {
    return this.mutate((state, now) => {
      const idempotencyKey = normalizeMediaIdempotencyKey(input.idempotencyKey)
      const existing = state.jobs.find((job) => job.idempotencyKey === idempotencyKey)
      if (existing) {
        assertJobBinding(existing, input, binding)
        return existing
      }
      const production = state.productions.find((item) =>
        item.id === requiredId(input.productionId, 'productionId') && item.projectId === requiredId(input.projectId, 'projectId'))
      if (!production) throw new Error('Media job Project/Production scope is invalid')
      if (input.shotId && !production.shots.some((shot) => shot.id === input.shotId)) {
        throw new Error('Media job Shot is outside Production scope')
      }
      const dialogueCue = input.dialogueCueId
        ? production.shots.flatMap((shot) => shot.dialogueCues).find((cue) => cue.id === input.dialogueCueId && cue.shotId === input.shotId)
        : undefined
      if (input.dialogueCueId && !dialogueCue) throw new Error('Media job Dialogue cue is outside Shot scope')
      if (input.dialogueCueId && input.capability !== 'tts') throw new Error('Dialogue cue binding requires a TTS capability')
      if (!['image', 'video', 'tts', 'synthesis'].includes(input.capability)) throw new Error('Media capability is invalid')
      const operation = input.operation ?? defaultMediaOperation(input.capability)
      if (!validMediaOperation(operation) || operationCapability(operation) !== input.capability) throw new Error('Media operation does not match its capability')
      const mediaProviderId = input.mediaProviderId?.trim() || undefined
      assertMediaSubmissionReconciled(state.jobs, executionBinding?.contentDigest)
      const selectedProfile = resolveSubmissionMediaProfile(state.providers, mediaProviderId, executionBinding?.profile, operation)
      assertMediaSubmissionBudget(production, state.jobs, selectedProfile)
      if (mediaProviderId && mediaProviderId !== 'media-provider:mock-local' && input.inputAssetIds?.length) {
        assertMediaAssetEgressGrants(production, input.inputAssetIds, mediaProviderId, operation, now)
      }
      if (mediaProviderId && mediaProviderId !== 'media-provider:mock-local' && operation === 'speech.voice-clone') {
        assertVoiceCloneAuthorization(production, input.inputAssetIds ?? [], now)
      }
      const id = mediaJobIdForKey(idempotencyKey)
      const job: MediaJobRecord = {
        schemaVersion: MEDIA_SCHEMA_VERSION,
        id,
        projectId: production.projectId,
        productionId: production.id,
        businessLineId: newBusinessLineId(input.businessLineId, production.businessLineId ?? 'video'),
        ...(input.shotId ? { shotId: input.shotId } : {}),
        ...(input.dialogueCueId ? { dialogueCueId: input.dialogueCueId } : {}),
        goalId: requiredId(binding.goalId, 'goalId'),
        workItemId: requiredId(binding.workItemId, 'workItemId'),
        runId: requiredId(binding.runId, 'runId'),
        effectId: requiredId(binding.effectId, 'effectId'),
        operationRunIds: [],
        effectIds: [],
        requestId: `media-job:${sha256(idempotencyKey)}`,
        capability: input.capability,
        operation,
        providerId: input.providerId?.trim() || selectedProfile?.providerId || 'mock-local',
        ...(mediaProviderId ? { mediaProviderId } : {}),
        ...(executionBinding ? { executionBinding: clone(executionBinding) } : {}),
        agentOrigin: executionBinding?.agentOrigin, budgetReservationId: executionBinding?.budgetReservationId,
        providerMode: mediaProviderId && mediaProviderId !== 'media-provider:mock-local' ? 'remote' : 'mock',
        externalJobId: `${mediaProviderId && mediaProviderId !== 'media-provider:mock-local' ? 'remote' : 'mock'}:${sha256(idempotencyKey)}`,
        idempotencyKey,
        ...(input.model?.trim() ? { model: input.model.trim().slice(0, 240) } : {}),
        ...(dialogueCue ? { requestPrompt: dialogueCue.text.slice(0, 20_000) } : input.prompt?.trim() ? { requestPrompt: input.prompt.trim().slice(0, 20_000) } : {}),
        ...(input.inputAssetIds?.length ? { inputAssetIds: validateJobInputAssets(production, input.inputAssetIds) } : {}),
        ...(input.voice?.trim() ? { voice: input.voice.trim().slice(0, 240) } : {}),
        parameters: normalizeGenerationParameters(input.parameters),
        parametersDigest: `sha256:${sha256(canonicalJson(normalizeGenerationParameters(input.parameters)))}`,
        mockScenario: normalizeMockScenario(input.mockScenario),
        cost: mediaProviderId && mediaProviderId !== 'media-provider:mock-local'
          ? providerEstimatedCost(selectedProfile, now)
          : localCost('mock_zero', now),
        status: 'requested',
        attempt: 1,
        statusHistory: [{ status: 'requested', observedAt: now }],
        createdAt: now,
        updatedAt: now
      }
      state.jobs.push(job)
      return job
    })
  }

  commitMediaJobOperation(jobId: string, input: MediaJobOperationCommit): Promise<MediaJobRecord> {
    return this.mutate((state, now) => {
      const job = state.jobs.find((item) => item.id === requiredId(jobId, 'mediaJobId'))
      if (!job) throw new Error('MediaJob was not found')
      if (!job.goalId || !job.workItemId) throw new Error('MediaJob canonical ownership is missing')
      if (job.goalId !== input.binding.goalId || job.workItemId !== input.binding.workItemId) {
        throw new Error('MediaJob canonical ownership conflict')
      }
      const existingEvent = job.statusHistory.find((event) => event.runId === input.binding.runId)
      if (existingEvent) {
        if (existingEvent.status !== input.status || existingEvent.effectId !== input.binding.effectId) {
          throw new Error('MediaJob operation replay differs from its durable event')
        }
        return job
      }
      assertMediaTransition(job.status, input.status, input.operation)
      job.status = input.status
      job.runId = requiredId(input.binding.runId, 'runId')
      job.effectId = requiredId(input.binding.effectId, 'effectId')
      job.operationRunIds = [...new Set([...job.operationRunIds, input.binding.runId])]
      job.effectIds = [...new Set([...job.effectIds, input.binding.effectId])]
      job.updatedAt = now
      job.error = input.reason
      if (input.status === 'waiting_reconciliation' && job.providerMode === 'remote') {
        scheduleMediaReconciliation(job, now)
      } else {
        if (input.operation === 'poll' && job.providerMode === 'remote') job.lastReconciledAt = now
        delete job.nextReconcileAt
      }
      if (input.remoteOutputRef) job.remoteOutputRef = input.remoteOutputRef
      if (input.remoteOutputMediaType) job.remoteOutputMediaType = input.remoteOutputMediaType
      if (input.providerExternalJobId) job.providerExternalJobId = input.providerExternalJobId
      if (input.preparedOutputPath) job.preparedOutputPath = input.preparedOutputPath
      if (input.preparedOutputDigest) job.preparedOutputDigest = input.preparedOutputDigest
      if (input.preparedOutputSizeBytes) job.preparedOutputSizeBytes = input.preparedOutputSizeBytes
      if (input.downloadReceivedBytes !== undefined) job.downloadReceivedBytes = input.downloadReceivedBytes
      if (input.downloadTotalBytes !== undefined) job.downloadTotalBytes = input.downloadTotalBytes
      if (input.actualUsd !== undefined) {
        if (!validMoney(input.actualUsd) || !input.billingReceiptDigest || !/^sha256:[a-f0-9]{64}$/.test(input.billingReceiptDigest)) {
          throw new Error('Provider-reported media billing receipt is invalid')
        }
        job.cost = {
          ...job.cost,
          actualUsd: input.actualUsd,
          status: 'settled',
          source: 'provider_reported',
          billable: true,
          observedAt: now,
          receiptDigest: input.billingReceiptDigest
        }
      }
      job.statusHistory.push({
        status: input.status,
        observedAt: now,
        runId: input.binding.runId,
        effectId: input.binding.effectId,
        ...(input.reason ? { reason: input.reason } : {})
      })
      if (input.output) {
        job.output = clone(input.output)
        attachOutputAsset(state, job, input.output, now)
      }
      if (input.status === 'succeeded' || input.status === 'failed' || input.status === 'cancelled') {
        job.finishedAt = now
      }
      return job
    })
  }

  purgeProject(projectId: string): Promise<{ productions: number; jobs: number }> {
    return this.mutate((state) => {
      const id = requiredId(projectId, 'projectId')
      const productions = state.productions.filter((item) => item.projectId === id).length
      const jobs = state.jobs.filter((item) => item.projectId === id).length
      state.productions = state.productions.filter((item) => item.projectId !== id)
      state.jobs = state.jobs.filter((item) => item.projectId !== id)
      state.projectStorage = state.projectStorage.filter((item) => item.projectId !== id)
      return { productions, jobs }
    })
  }
}

function attachOutputAsset(state: MediaDocument, job: MediaJobRecord, output: MediaJobOutput, now: number): void {
  const production = state.productions.find((item) => item.id === job.productionId && item.projectId === job.projectId)
  if (!production) throw new Error('MediaJob output Production was not found')
  const assetId = `asset:${sha256(`${job.id}\0${output.digest}`).slice(0, 32)}`
  let asset = production.assets.find((item) => item.id === assetId)
  if (!asset) {
    asset = {
      schemaVersion: MEDIA_SCHEMA_VERSION,
      id: assetId,
      productionId: production.id,
      kind: assetKind(job),
      title: `${job.providerMode === 'mock' ? 'Mock ' : ''}${job.capability} output`,
      version: 1,
      digest: output.digest,
      mediaType: output.mediaType,
      sizeBytes: output.sizeBytes,
      artifactId: output.artifactId,
      previewUrl: output.artifactId ? mediaPreviewUrl(output.artifactId) : undefined,
      adopted: false,
      authorization: { source: 'provider_output', status: 'generated', dataEgress: 'provider' },
      cost: clone(job.cost),
      retention: defaultAssetRetention(now),
      contentStatus: 'available',
      createdAt: now
    }
    production.assets.push(asset)
  }
  if (job.shotId) {
    const shot = production.shots.find((item) => item.id === job.shotId)
    if (shot && !shot.assetIds.includes(asset.id)) {
      shot.assetIds.push(asset.id)
      shot.revision += 1
      shot.updatedAt = now
    }
    if (job.dialogueCueId && job.capability === 'tts') {
      const cue = shot?.dialogueCues.find((item) => item.id === job.dialogueCueId)
      if (cue && cue.audioAssetId !== asset.id) {
        cue.audioAssetId = asset.id
        cue.revision += 1
        cue.updatedAt = now
        if (shot) {
          shot.revision += 1
          shot.updatedAt = now
        }
      }
    }
  }
  production.revision += 1
  production.updatedAt = now
}

function newShot(sceneId: string, title: string, prompt: string, durationMs: number, now: number): VideoShot {
  return {
    schemaVersion: MEDIA_SCHEMA_VERSION,
    id: `shot:${randomUUID()}`,
    sceneId,
    title,
    prompt,
    durationMs: mediaDuration(durationMs),
    assetIds: [],
    assetBindings: [],
    dialogueCues: [],
    revision: 1,
    createdAt: now,
    updatedAt: now
  }
}

function mediaDuration(value: number | undefined): number {
  return Math.min(Math.max(Math.floor(value ?? 5_000), 500), 120_000)
}

function requiredProduction(state: MediaDocument, productionId: string): VideoProduction {
  const production = state.productions.find((item) => item.id === requiredId(productionId, 'productionId'))
  if (!production) throw new Error('VideoProduction was not found')
  return production
}

function touchProduction(production: VideoProduction, now: number): void {
  production.revision += 1
  production.updatedAt = now
}

function defaultProjectStorage(projectId: string): MediaProjectStorageSettings {
  return {
    schemaVersion: MEDIA_SCHEMA_VERSION,
    projectId,
    quotaBytes: 20 * 1024 * 1024 * 1024,
    revision: 0,
    updatedAt: 0
  }
}

function normalizeStorageQuota(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 256 * 1024 * 1024 || Number(value) > 2 * 1024 * 1024 * 1024 * 1024) {
    throw new Error('Media project storage quota must be between 256 MiB and 2 TiB')
  }
  return Number(value)
}

function defaultAssetRetention(now: number): MediaAsset['retention'] {
  return { mode: 'retain', revision: 0, updatedAt: now }
}

function normalizeAssetRetention(value: MediaAsset['retention'] | undefined, createdAt: number): MediaAsset['retention'] {
  if (value?.mode === 'expire') {
    return {
      mode: 'expire',
      retainUntil: positiveRetentionTimestamp(value.retainUntil),
      revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
      updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : createdAt
    }
  }
  const revision = value?.revision
  const updatedAt = value?.updatedAt
  return {
    mode: 'retain',
    revision: Number.isSafeInteger(revision) && Number(revision) >= 0 ? Number(revision) : 0,
    updatedAt: Number.isFinite(updatedAt) ? Number(updatedAt) : createdAt
  }
}

function positiveRetentionTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error('Media retention expiry is invalid')
  return Number(value)
}

function projectStorageUsage(state: MediaDocument, projectId: string): number {
  const digests = new Set<string>()
  let total = 0
  for (const production of state.productions) {
    if (production.projectId !== projectId) continue
    for (const asset of production.assets) {
      if (asset.contentStatus === 'purged' || !asset.digest || !Number.isSafeInteger(asset.sizeBytes) || digests.has(asset.digest)) continue
      digests.add(asset.digest)
      total += asset.sizeBytes ?? 0
    }
  }
  for (const job of state.jobs) {
    if (job.projectId !== projectId || job.output || !job.preparedOutputDigest || !job.preparedOutputSizeBytes || digests.has(job.preparedOutputDigest)) continue
    digests.add(job.preparedOutputDigest)
    total += job.preparedOutputSizeBytes
  }
  return total
}

function assertAssetPurgeable(production: VideoProduction, asset: MediaAsset, now: number): void {
  if (asset.retention.mode !== 'expire' || !asset.retention.retainUntil || now < asset.retention.retainUntil) {
    throw new Error('MediaAsset retention period has not expired')
  }
  const reason = assetPurgeBlockReason(production, asset)
  if (reason) throw new Error(reason)
}

function assetPurgeBlockReason(production: VideoProduction, asset: MediaAsset): string | undefined {
  if (asset.adopted || production.finalAssetId === asset.id) return 'Adopted or final MediaAsset cannot be purged'
  if (production.continuityLocks.some((lock) => lock.enabled && lock.assetId === asset.id)) return 'Continuity Lock references this MediaAsset'
  if (production.characterBibles.some((bible) => bible.referenceAssetIds.includes(asset.id))) return 'Character Bible references this MediaAsset'
  if (production.shots.some((shot) => shot.assetIds.includes(asset.id) ||
      (shot.assetBindings ?? []).some((binding) => binding.assetId === asset.id) ||
      shot.dialogueCues.some((cue) => cue.voiceAssetId === asset.id || cue.audioAssetId === asset.id))) {
    return 'Shot, binding, or dialogue references this MediaAsset'
  }
  if (production.timeline.backgroundAudioAssetId === asset.id) return 'Timeline references this MediaAsset'
  return undefined
}

function assertMediaAssetAvailable(asset: MediaAsset): void {
  if (asset.contentStatus !== 'available') throw new Error('MediaAsset content is not available')
}

function normalizedRules(values: string[] | undefined): string[] {
  if (values === undefined) return []
  if (!Array.isArray(values)) throw new Error('Character Bible rules are invalid')
  return [...new Set(values.map((value) => requiredText(value, 'character Bible rule').slice(0, 500)))].slice(0, 64)
}

function uniqueIds(values: string[], label: string): string[] {
  if (!Array.isArray(values)) throw new Error(`${label}s are invalid`)
  return [...new Set(values.map((value) => requiredId(value, label)))].slice(0, 128)
}

function cueTime(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 120_000) throw new Error(`${label} is invalid`)
  return value
}

function optionalOwnedCueAsset(
  production: VideoProduction,
  value: string | undefined,
  purpose: 'voice' | 'audio'
): string | undefined {
  if (!value) return undefined
  const id = requiredId(value, `${purpose}AssetId`)
  const asset = production.assets.find((candidate) => candidate.id === id)
  if (!asset) throw new Error(`Dialogue ${purpose} Asset is outside Production scope`)
  assertMediaAssetAvailable(asset)
  const audioMedia = asset.mediaType?.startsWith('audio/') === true
  if (!audioMedia) {
    throw new Error(`Dialogue ${purpose} Asset type is invalid`)
  }
  return asset.id
}

function normalizeBackgroundVolume(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.2
}

function normalizeSubtitleMode(value: unknown): VideoProduction['timeline']['subtitleMode'] {
  return value === 'burned_in' || value === 'none' ? value : 'embedded'
}

function structureRevision(
  production: VideoProduction,
  revision: number,
  createdAt: number,
  adopted: boolean,
  scenes = production.scenes,
  shots = production.shots
): VideoStructureRevision {
  const identity = sha256(`${production.id}\0${revision}\0${sha256(production.script)}`).slice(0, 32)
  return {
    schemaVersion: MEDIA_SCHEMA_VERSION,
    id: `media-structure:${identity}`,
    productionId: production.id,
    revision,
    sourceScriptDigest: `sha256:${sha256(production.script)}`,
    sceneIds: scenes.map((scene) => scene.id),
    shotIds: shots.map((shot) => shot.id),
    createdAt,
    ...(adopted ? { adoptedAt: createdAt } : {})
  }
}

function mediaPreviewUrl(artifactId: string): string {
  return `caogen-media://artifact/${encodeURIComponent(artifactId)}`
}

function assertJobBinding(job: MediaJobRecord, input: MediaJobInput, binding: MediaJobCanonicalBinding): void {
  assertSameBusinessLine(input.businessLineId, job.businessLineId, 'video')
  assertSameBusinessLine(binding.businessLineId, job.businessLineId, 'video')
  const parametersDigest = `sha256:${sha256(canonicalJson(normalizeGenerationParameters(input.parameters)))}`
  if (job.projectId !== input.projectId || job.productionId !== input.productionId || job.shotId !== input.shotId || job.dialogueCueId !== input.dialogueCueId ||
      job.capability !== input.capability || job.operation !== (input.operation ?? defaultMediaOperation(input.capability)) ||
      job.mediaProviderId !== input.mediaProviderId || job.providerId !== (input.providerId ?? job.providerId) ||
      job.parametersDigest !== parametersDigest || job.goalId !== binding.goalId || job.workItemId !== binding.workItemId) {
    throw new Error('MediaJob idempotency identity conflict')
  }
}

function assertMediaTransition(from: MediaJobStatus, to: MediaJobStatus, operation: MediaJobOperationCommit['operation']): void {
  if (from === to) return
  if (operation === 'cancel' && to === 'cancelled' && !['succeeded', 'failed', 'cancelled'].includes(from)) return
  const allowed: Record<MediaJobStatus, MediaJobStatus[]> = {
    requested: ['submitting', 'running', 'downloading', 'failed', 'waiting_reconciliation'],
    submitting: ['running', 'failed', 'waiting_reconciliation'],
    running: ['downloading', 'failed', 'waiting_reconciliation'],
    downloading: ['succeeded', 'failed', 'waiting_reconciliation'],
    succeeded: [],
    failed: [],
    cancelled: [],
    waiting_reconciliation: ['running', 'downloading', 'failed', 'cancelled']
  }
  if (!allowed[from].includes(to)) throw new Error(`MediaJob transition is invalid:${from}->${to}`)
}

function assetKind(job: MediaJobRecord): MediaAsset['kind'] {
  if (job.capability === 'video' || job.capability === 'synthesis') return 'video'
  if (job.capability === 'tts') return 'audio'
  return 'image'
}

function validMediaOperation(value: unknown): value is MediaOperation {
  return typeof value === 'string' && ALL_MEDIA_OPERATIONS.includes(value as MediaOperation)
}

function defaultMediaOperation(capability: MediaJobInput['capability']): MediaOperation {
  if (capability === 'image') return 'image.generate'
  if (capability === 'video') return 'video.text-to-video'
  if (capability === 'tts') return 'speech.synthesize'
  return 'media.compose'
}

function operationCapability(operation: MediaOperation): MediaJobInput['capability'] {
  if (operation.startsWith('image.')) return 'image'
  if (operation.startsWith('video.')) return 'video'
  if (operation.startsWith('speech.')) return 'tts'
  return 'synthesis'
}

function validateJobInputAssets(production: VideoProduction, inputAssetIds: string[]): string[] {
  const ids = [...new Set(inputAssetIds.map((value) => requiredId(value, 'inputAssetId')))]
  if (ids.length > 16 || ids.some((id) => !production.assets.some((asset) => asset.id === id && asset.contentStatus === 'available'))) {
    throw new Error('Media input Assets are outside Production scope')
  }
  return ids
}

function assertMediaAssetEgressGrants(
  production: VideoProduction,
  inputAssetIds: string[],
  mediaProviderId: string,
  operation: MediaOperation,
  now: number
): void {
  for (const assetId of validateJobInputAssets(production, inputAssetIds)) {
    const asset = production.assets.find((candidate) => candidate.id === assetId)
    const grant = asset?.egressGrants?.find((candidate) =>
      candidate.mediaProviderId === mediaProviderId &&
      candidate.operation === operation &&
      candidate.assetVersion === asset.version &&
      candidate.status === 'granted' &&
      (candidate.expiresAt === undefined || candidate.expiresAt > now)
    )
    if (!grant) throw new Error(`MediaAsset ${assetId} requires explicit external-provider authorization for ${operation}`)
  }
}

function normalizeMockScenario(value: unknown): MediaMockScenario {
  return value === 'failure' || value === 'rate_limit' || value === 'unknown_result' ? value : 'success'
}

function normalizeEgressGrants(value: unknown): MediaAssetEgressGrant[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Partial<MediaAssetEgressGrant>
    const assetVersion = record.assetVersion
    const grantedAt = record.grantedAt
    if (typeof record.id !== 'string' || typeof record.mediaProviderId !== 'string' || !validMediaOperation(record.operation) ||
        typeof assetVersion !== 'number' || !Number.isSafeInteger(assetVersion) || assetVersion <= 0 ||
        (record.status !== 'granted' && record.status !== 'revoked') || typeof grantedAt !== 'number' || !Number.isFinite(grantedAt)) return []
    return [{
      schemaVersion: MEDIA_SCHEMA_VERSION,
      id: record.id,
      mediaProviderId: record.mediaProviderId,
      ...(typeof record.providerId === 'string' ? { providerId: record.providerId } : {}),
      operation: record.operation,
      assetVersion,
      status: record.status,
      grantedAt,
      ...(Number.isFinite(record.revokedAt) ? { revokedAt: record.revokedAt } : {}),
      ...(Number.isFinite(record.expiresAt) ? { expiresAt: record.expiresAt } : {}),
      decisionDigest: typeof record.decisionDigest === 'string' ? record.decisionDigest : `sha256:${sha256(`${record.id}\0${grantedAt}`)}`
    } satisfies MediaAssetEgressGrant]
  })
}

function normalizeVoiceCloneAuthorizations(value: unknown): MediaVoiceCloneAuthorization[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Partial<MediaVoiceCloneAuthorization>
    if (typeof record.id !== 'string' || !Number.isSafeInteger(record.assetVersion) || Number(record.assetVersion) <= 0 ||
        !['self', 'authorized', 'licensed'].includes(String(record.basis)) || (record.status !== 'granted' && record.status !== 'revoked') ||
        !Number.isFinite(record.declaredAt)) return []
    return [{ schemaVersion: MEDIA_SCHEMA_VERSION, id: record.id, assetVersion: Number(record.assetVersion), basis: record.basis!, status: record.status!, declaredAt: Number(record.declaredAt),
      ...(Number.isFinite(record.revokedAt) ? { revokedAt: Number(record.revokedAt) } : {}), ...(Number.isFinite(record.expiresAt) ? { expiresAt: Number(record.expiresAt) } : {}),
      decisionDigest: typeof record.decisionDigest === 'string' ? record.decisionDigest : `sha256:${sha256(`${record.id}\0${record.declaredAt}`)}` } satisfies MediaVoiceCloneAuthorization]
  })
}

function normalizeGenerationParameters(value: unknown): MediaGenerationParameters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  const result: MediaGenerationParameters = {}
  if (Number.isFinite(source.durationSeconds) && Number(source.durationSeconds) > 0 && Number(source.durationSeconds) <= 3600) result.durationSeconds = Number(source.durationSeconds)
  if (Number.isSafeInteger(source.width) && Number(source.width) > 0 && Number(source.width) <= 16_384) result.width = Number(source.width)
  if (Number.isSafeInteger(source.height) && Number(source.height) > 0 && Number(source.height) <= 16_384) result.height = Number(source.height)
  if (['1:1', '16:9', '9:16', '4:3', '3:4'].includes(String(source.aspectRatio))) result.aspectRatio = source.aspectRatio as MediaGenerationParameters['aspectRatio']
  if (['draft', 'standard', 'high'].includes(String(source.quality))) result.quality = source.quality as MediaGenerationParameters['quality']
  if (Number.isSafeInteger(source.seed) && Number(source.seed) >= 0) result.seed = Number(source.seed)
  if (typeof source.negativePrompt === 'string' && source.negativePrompt.trim()) result.negativePrompt = source.negativePrompt.trim().slice(0, 20_000)
  if (Number.isFinite(source.guidanceScale) && Number(source.guidanceScale) >= 0 && Number(source.guidanceScale) <= 100) result.guidanceScale = Number(source.guidanceScale)
  if (Number.isFinite(source.speechSpeed) && Number(source.speechSpeed) > 0 && Number(source.speechSpeed) <= 4) result.speechSpeed = Number(source.speechSpeed)
  return result
}

function assertVoiceCloneAuthorization(production: VideoProduction, inputAssetIds: string[], now: number): void {
  for (const assetId of validateJobInputAssets(production, inputAssetIds)) {
    const asset = production.assets.find((candidate) => candidate.id === assetId)
    const authorization = asset?.voiceCloneAuthorizations?.find((item) => item.assetVersion === asset.version && item.status === 'granted' && (item.expiresAt === undefined || item.expiresAt > now))
    if (!authorization) throw new Error(`MediaAsset ${assetId} requires explicit voice-clone authorization`)
  }
}

function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

function finiteOptionalTimestamp(value: unknown): number | undefined {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : undefined
}

function scheduleMediaReconciliation(job: MediaJobRecord, now: number): void {
  const attempts = nonNegativeInteger(job.reconciliationAttempts) + 1
  const delay = Math.min(5 * 60_000, 15_000 * (2 ** Math.min(attempts - 1, 5)))
  job.reconciliationAttempts = attempts
  job.lastReconciledAt = now
  job.nextReconcileAt = now + delay
}

function validThreshold(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0.1 && value <= 1 }
function validMediaPath(value: unknown): value is string { return typeof value === 'string' && /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,500}$/.test(value) && !value.includes('..') && !value.includes('?') && !value.includes('#') }
function validMediaPathTemplate(value: unknown): value is string { return validMediaPath(value) && value.includes('{id}') }
const stores = new Map<string, MediaStore>()

export function getMediaStore(rootDir: string): MediaStore {
  rootDir = mediaStoreRoot(rootDir)
  const existing = stores.get(rootDir)
  if (existing) return existing
  const store = new MediaStore(rootDir)
  stores.set(rootDir, store)
  return store
}
