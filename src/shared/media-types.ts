import type { VideoStoryboardDraft } from './video-storyboard-types'
import type { BusinessLineBinding } from './business-line-types'
import type { MediaExecutionBinding, MediaRoutingPreference, ProviderMediaPricing } from './media-routing-types'
export type { MediaExecutionBinding, MediaRouteDecision, MediaRoutingPreference, ProviderMediaPricing } from './media-routing-types'
export const MEDIA_SCHEMA_VERSION = 12 as const

export type MediaCapability = 'image' | 'video' | 'tts' | 'synthesis'
export type MediaOperation =
  | 'image.generate'
  | 'image.edit'
  | 'video.text-to-video'
  | 'video.image-to-video'
  | 'video.reference-to-video'
  | 'speech.synthesize'
  | 'speech.voice-clone'
  | 'media.compose'

/** Main-owned evidence for a media capability. Declarations alone stay unknown. */
export type MediaCapabilityVerificationState = 'verified' | 'failed' | 'unknown'
export interface MediaCapabilityVerification {
  state: MediaCapabilityVerificationState
  /** Operations covered by the bounded verification, when known. */
  operations?: MediaOperation[]
  verifiedAt?: number
  reason?: string
}

export interface MediaProviderProfile {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  id: string
  displayName: string
  capabilities: MediaCapability[]
  operations: MediaOperation[]
  endpointClass:
    | 'mock'
    | 'openai-compatible'
    | 'anthropic-compatible'
    | 'openai-image'
    | 'openai-speech'
    | 'openai-video'
    | 'generic-async'
    | 'local-ffmpeg'
  /** Existing CaoGen Provider Profile used for the remote credential and endpoint. */
  providerId?: string
  model?: string
  defaultFor?: MediaCapability[]
  requestTimeoutMs?: number
  submitPath?: string
  statusPathTemplate?: string
  downloadPathTemplate?: string
  cancelPathTemplate?: string
  estimatedCostUsd?: number
  mediaPricing?: ProviderMediaPricing
  verification?: MediaCapabilityVerification
  source?: 'manual' | 'provider-catalog'
  credentialRef?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}
export type MediaJobStatus =
  | 'requested'
  | 'submitting'
  | 'running'
  | 'downloading'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'waiting_reconciliation'
export type MediaAssetKind = 'character' | 'scene' | 'prop' | 'voice' | 'image' | 'video' | 'audio' | 'subtitle'
export type MediaAssetBindingRole =
  | 'character'
  | 'costume'
  | 'scene'
  | 'prop'
  | 'keyframe'
  | 'voice'
  | 'subtitle'
  | 'audio_track'
export type MediaMockScenario = 'success' | 'failure' | 'rate_limit' | 'unknown_result'

export interface MediaAssetEgressGrant {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  id: string
  mediaProviderId: string
  providerId?: string
  operation: MediaOperation
  assetVersion: number
  status: 'granted' | 'revoked'
  grantedAt: number
  revokedAt?: number
  expiresAt?: number
  decisionDigest: string
}

export interface MediaVoiceCloneAuthorization {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  id: string
  assetVersion: number
  basis: 'self' | 'authorized' | 'licensed'
  status: 'granted' | 'revoked'
  declaredAt: number
  revokedAt?: number
  expiresAt?: number
  decisionDigest: string
}

export interface MediaGenerationParameters {
  durationSeconds?: number
  width?: number
  height?: number
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4'
  quality?: 'draft' | 'standard' | 'high'
  seed?: number
  negativePrompt?: string
  guidanceScale?: number
  speechSpeed?: number
}

export interface MediaCostRecord {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  currency: 'USD'
  estimatedUsd?: number
  actualUsd?: number
  status: 'estimated' | 'settled' | 'unavailable'
  source: 'non_billable_local' | 'mock_zero' | 'catalog_estimate' | 'provider_reported'
  billable: boolean
  observedAt: number
  receiptDigest?: string
}

export interface MediaBudgetSettings {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  productionId: string
  limitUsd?: number
  warningThreshold: number
  revision: number
  updatedAt: number
}

export interface MediaProjectStorageSettings {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  projectId: string
  quotaBytes: number
  revision: number
  updatedAt: number
}

export interface MediaAssetRetention {
  mode: 'retain' | 'expire'
  retainUntil?: number
  revision: number
  updatedAt: number
}

export interface MediaAssetBinding {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  id: string
  shotId: string
  assetId: string
  role: MediaAssetBindingRole
  assetVersion: number
  adopted: boolean
  createdAt: number
  updatedAt: number
}

export interface MediaAsset {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  id: string
  productionId: string
  kind: MediaAssetKind
  title: string
  version: number
  digest?: string
  mediaType?: string
  sizeBytes?: number
  artifactId?: string
  sourceFileName?: string
  previewUrl?: string
  adopted: boolean
  authorization?: {
    source: 'user_import' | 'provider_output' | 'local_composition'
    status: 'declared_by_user' | 'generated' | 'local'
    dataEgress: 'none' | 'provider'
  }
  egressGrants?: MediaAssetEgressGrant[]
  voiceCloneAuthorizations?: MediaVoiceCloneAuthorization[]
  cost?: MediaCostRecord
  retention: MediaAssetRetention
  contentStatus: 'available' | 'purge_pending' | 'purged'
  purgeError?: string
  purgedAt?: number
  createdAt: number
  supersedesId?: string
}

export interface VideoStructureRevision {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  id: string
  productionId: string
  revision: number
  sourceScriptDigest: string
  sceneIds: string[]
  shotIds: string[]
  createdAt: number
  adoptedAt?: number
}

export interface MediaDialogueCue {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  id: string
  shotId: string
  speaker: string
  text: string
  startMs: number
  endMs: number
  voiceAssetId?: string
  audioAssetId?: string
  subtitleEnabled: boolean
  revision: number
  createdAt: number
  updatedAt: number
}

export interface MediaTimelineSettings {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  productionId: string
  backgroundAudioAssetId?: string
  backgroundAudioVolume: number
  subtitleMode: 'embedded' | 'burned_in' | 'none'
  revision: number
  updatedAt: number
}

export interface MediaCharacterBible {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  id: string
  productionId: string
  name: string
  summary: string
  appearanceRules: string[]
  voiceRules: string[]
  behaviorRules: string[]
  referenceAssetIds: string[]
  revision: number
  createdAt: number
  updatedAt: number
}

export type MediaContinuityRole = Extract<MediaAssetBindingRole, 'character' | 'costume' | 'scene' | 'prop' | 'voice'>

export interface MediaContinuityLock {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  id: string
  productionId: string
  bibleId?: string
  label: string
  role: MediaContinuityRole
  assetId: string
  assetVersion: number
  targetShotIds: string[]
  enabled: boolean
  revision: number
  createdAt: number
  updatedAt: number
}

export interface MediaContinuityFinding {
  code: 'missing_binding' | 'asset_mismatch' | 'version_mismatch' | 'multiple_adopted_bindings'
  severity: 'error' | 'warning'
  lockId: string
  shotId: string
  message: string
}

export interface MediaContinuityCheckSummary {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  id: string
  productionId: string
  passed: boolean
  checkedAt: number
  shotIds: string[]
  lockIds: string[]
  findingCount: number
  digest: string
  artifactId: string
  evidenceId: string
  acceptanceId: string
}

export interface VideoShot {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  id: string
  sceneId: string
  title: string
  prompt: string
  durationMs: number
  assetIds: string[]
  assetBindings?: MediaAssetBinding[]
  dialogueCues: MediaDialogueCue[]
  revision: number
  createdAt: number
  updatedAt: number
}

export interface VideoScene {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  id: string
  episodeId: string
  title: string
  summary: string
  shotIds: string[]
  revision: number
  createdAt: number
  updatedAt: number
}

export interface VideoEpisode {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  id: string
  productionId: string
  title: string
  sceneIds: string[]
  revision: number
  createdAt: number
  updatedAt: number
}

export interface VideoProduction extends BusinessLineBinding {
  /** Immutable initial request fingerprint, retained across later production revisions. */
  creationRequestDigest?: string
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  id: string
  projectId: string
  title: string
  script: string
  revision: number
  episodes: VideoEpisode[]
  scenes: VideoScene[]
  shots: VideoShot[]
  assets: MediaAsset[]
  structureRevisions: VideoStructureRevision[]
  adoptedStructureRevisionId: string
  timeline: MediaTimelineSettings
  budget: MediaBudgetSettings
  characterBibles: MediaCharacterBible[]
  continuityLocks: MediaContinuityLock[]
  latestContinuityCheck?: MediaContinuityCheckSummary
  finalAssetId?: string
  createdAt: number
  updatedAt: number
}

export interface MediaJobOutput {
  digest: string
  sizeBytes: number
  mediaType: string
  blobRef: string
  artifactId?: string
  evidenceId?: string
  acceptanceId?: string
  runId?: string
  effectId?: string
  durationMs?: number
  width?: number
  height?: number
}

export interface MediaRemoteJobObservation {
  status: 'running' | 'downloading' | 'succeeded' | 'failed' | 'cancelled' | 'waiting_reconciliation'
  externalJobId: string
  outputUrl?: string
  outputBytes?: Uint8Array
  outputFilePath?: string
  outputDigest?: string
  outputSizeBytes?: number
  mediaType?: string
  actualUsd?: number
  billingReceiptDigest?: string
  reason?: string
  providerExternalJobId?: string
  downloadReceivedBytes?: number
  downloadTotalBytes?: number
}

export interface MediaJobRecord extends BusinessLineBinding {
  agentOrigin?: import('./media-agent-types').MediaAgentOrigin
  budgetReservationId?: string
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  id: string
  projectId: string
  productionId: string
  shotId?: string
  dialogueCueId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  effectId?: string
  operationRunIds: string[]
  effectIds: string[]
  requestId?: string
  capability: MediaCapability
  operation: MediaOperation
  providerId: string
  mediaProviderId?: string
  providerMode: 'mock' | 'remote'
  executionBinding?: MediaExecutionBinding
  externalJobId: string
  providerExternalJobId?: string
  idempotencyKey: string
  mockScenario: MediaMockScenario
  model?: string
  requestPrompt?: string
  inputAssetIds?: string[]
  voice?: string
  parameters: MediaGenerationParameters
  parametersDigest: string
  remoteOutputRef?: string
  remoteOutputMediaType?: string
  preparedOutputPath?: string
  preparedOutputDigest?: string
  preparedOutputSizeBytes?: number
  downloadReceivedBytes?: number
  downloadTotalBytes?: number
  reconciliationAttempts?: number
  lastReconciledAt?: number
  nextReconcileAt?: number
  status: MediaJobStatus
  attempt: number
  statusHistory: Array<{
    status: MediaJobStatus
    observedAt: number
    runId?: string
    effectId?: string
    reason?: string
  }>
  output?: MediaJobOutput
  cost: MediaCostRecord
  error?: string
  createdAt: number
  updatedAt: number
  finishedAt?: number
}

export interface MediaStudioSnapshot {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  revision: number
  productions: VideoProduction[]
  jobs: MediaJobRecord[]
  providers: MediaProviderProfile[]
  projectStorage: MediaProjectStorageSettings[]
  snapshotDigest: string
}

export interface MediaProjectSlice {
  schemaVersion: typeof MEDIA_SCHEMA_VERSION
  projectId: string
  productions: VideoProduction[]
  jobs: MediaJobRecord[]
  providers: MediaProviderProfile[]
  projectStorage: MediaProjectStorageSettings[]
  mediaDigest: string
}

export interface MediaProviderProfileInput {
  id?: string
  displayName: string
  capabilities: MediaCapability[]
  operations?: MediaOperation[]
  endpointClass: MediaProviderProfile['endpointClass']
  providerId?: string
  model?: string
  defaultFor?: MediaCapability[]
  requestTimeoutMs?: number
  submitPath?: string
  statusPathTemplate?: string
  downloadPathTemplate?: string
  cancelPathTemplate?: string
  estimatedCostUsd?: number
  verification?: MediaCapabilityVerification
  enabled?: boolean
}

export interface MediaProviderProfileDeleteInput {
  id: string
}

export interface MediaProductionInput extends BusinessLineBinding {
  id?: string
  projectId: string
  title: string
  script: string
  autoStructure?: boolean
  storyboardDraft?: VideoStoryboardDraft
}

export interface MediaProductionRevisionInput {
  productionId: string
  script: string
  storyboardDraft?: VideoStoryboardDraft
  expectedRevision?: number
}

export interface MediaShotInput {
  productionId: string
  sceneId: string
  title: string
  prompt: string
  durationMs?: number
}

export interface MediaShotUpdateInput {
  productionId: string
  shotId: string
  title?: string
  prompt?: string
  durationMs?: number
  beforeShotId?: string
}

export interface MediaDialogueCueInput {
  id?: string
  productionId: string
  shotId: string
  speaker: string
  text: string
  startMs: number
  endMs: number
  voiceAssetId?: string
  audioAssetId?: string
  subtitleEnabled?: boolean
}

export interface MediaDialogueCueDeleteInput {
  productionId: string
  shotId: string
  cueId: string
}

export interface MediaTimelineUpdateInput {
  productionId: string
  backgroundAudioAssetId?: string
  backgroundAudioVolume?: number
  subtitleMode?: MediaTimelineSettings['subtitleMode']
}

export interface MediaBudgetUpdateInput {
  productionId: string
  limitUsd?: number
  warningThreshold?: number
}

export interface MediaProjectStorageUpdateInput {
  projectId: string
  quotaBytes: number
}

export interface MediaAssetRetentionUpdateInput {
  projectId: string
  productionId: string
  assetId: string
  mode: 'retain' | 'expire'
  retainUntil?: number
}

export interface MediaAssetPurgeInput {
  projectId: string
  productionId: string
  assetId: string
}

export interface MediaAssetPurgeResult {
  asset: MediaAsset
  artifactId: string
  bytesRemoved: number
  purgedAt: number
}

export interface MediaAssetEgressInput {
  projectId: string
  productionId: string
  assetId: string
  mediaProviderId: string
  operation: MediaOperation
  approved: boolean
  expiresAt?: number
}

export interface MediaVoiceCloneAuthorizationInput {
  projectId: string
  productionId: string
  assetId: string
  approved: boolean
  basis?: MediaVoiceCloneAuthorization['basis']
  expiresAt?: number
}

export interface MediaAssetPurgeTarget extends MediaAssetPurgeInput {
  contentStatus: MediaAsset['contentStatus']
  retainUntil: number
}

export interface MediaCostSummary {
  currency: 'USD'
  settledUsd: number
  estimatedUsd: number
  unavailableCount: number
  billableJobCount: number
  limitUsd?: number
  warningThreshold: number
  status: 'unlimited' | 'within_budget' | 'warning' | 'exceeded' | 'unknown'
}

export interface MediaCharacterBibleInput {
  id?: string
  productionId: string
  name: string
  summary: string
  appearanceRules?: string[]
  voiceRules?: string[]
  behaviorRules?: string[]
  referenceAssetIds?: string[]
}

export interface MediaCharacterBibleDeleteInput {
  productionId: string
  bibleId: string
}

export interface MediaContinuityLockInput {
  id?: string
  productionId: string
  bibleId?: string
  label: string
  role: MediaContinuityRole
  assetId: string
  targetShotIds: string[]
  enabled?: boolean
}

export interface MediaContinuityLockDeleteInput {
  productionId: string
  lockId: string
}

export interface MediaContinuityCheckInput {
  projectId: string
  productionId: string
  shotIds?: string[]
}

export interface MediaContinuityCheckResult {
  summary: MediaContinuityCheckSummary
  findings: MediaContinuityFinding[]
}

export interface MediaAssetImportInput {
  projectId: string
  productionId: string
  kind: MediaAssetKind
  title?: string
  sourcePath?: string
  sourceFileName?: string
  mediaType?: string
}

export interface MediaAssetBindingInput {
  productionId: string
  shotId: string
  assetId: string
  role: MediaAssetBindingRole
}

export interface MediaAdoptionInput {
  productionId: string
  assetId?: string
  bindingId?: string
  adopted: boolean
}

export interface MediaCompositionInput {
  projectId: string
  productionId: string
  shotIds?: string[]
  width?: number
  height?: number
  fps?: number
  subtitleMode?: MediaTimelineSettings['subtitleMode']
}

export interface MediaAssetCommitInput {
  asset: MediaAsset
  output: MediaJobOutput
}

export interface MediaCompositionResult {
  asset: MediaAsset
  output: MediaJobOutput
  ffmpeg: {
    available: boolean
    version?: string
    source: 'ffmpeg-static' | 'unavailable'
    license: 'GPL-3.0-or-later' | 'unknown'
    commandDigest?: string
  }
  manifestArtifactId: string
  inputArtifactIds: string[]
  segmentCount: number
  subtitleCueCount: number
  cost: MediaCostRecord
}

export interface MediaFfmpegInfo {
  available: boolean
  version?: string
  source: 'ffmpeg-static' | 'unavailable'
  license: 'GPL-3.0-or-later' | 'unknown'
  binaryDigest?: string
}

export interface MediaJobInput extends BusinessLineBinding {
  projectId: string
  productionId: string
  shotId?: string
  dialogueCueId?: string
  capability: MediaCapability
  operation?: MediaOperation
  idempotencyKey: string
  providerId?: string
  mediaProviderId?: string
  model?: string
  prompt?: string
  inputAssetIds?: string[]
  voice?: string
  parameters?: MediaGenerationParameters
  mockScenario?: MediaMockScenario
  routingPreference?: MediaRoutingPreference
}

export interface MediaApi {
  getMediaStudio(projectId?: string): Promise<MediaStudioSnapshot>
  listMediaProviders(): Promise<MediaProviderProfile[]>
  upsertMediaProvider(input: MediaProviderProfileInput): Promise<MediaProviderProfile>
  deleteMediaProvider(input: MediaProviderProfileDeleteInput): Promise<void>
  getMediaFfmpegInfo(): Promise<MediaFfmpegInfo>
  createVideoProduction(input: MediaProductionInput): Promise<VideoProduction>
  reviseVideoProduction(input: MediaProductionRevisionInput): Promise<VideoProduction>
  addVideoShot(input: MediaShotInput): Promise<VideoShot>
  updateVideoShot(input: MediaShotUpdateInput): Promise<VideoShot>
  upsertMediaDialogueCue(input: MediaDialogueCueInput): Promise<MediaDialogueCue>
  deleteMediaDialogueCue(input: MediaDialogueCueDeleteInput): Promise<VideoShot>
  updateMediaTimeline(input: MediaTimelineUpdateInput): Promise<VideoProduction>
  updateMediaBudget(input: MediaBudgetUpdateInput): Promise<VideoProduction>
  updateMediaProjectStorage(input: MediaProjectStorageUpdateInput): Promise<MediaProjectStorageSettings>
  updateMediaAssetRetention(input: MediaAssetRetentionUpdateInput): Promise<MediaAsset>
  purgeMediaAsset(input: MediaAssetPurgeInput): Promise<MediaAssetPurgeResult>
  setMediaAssetEgress(input: MediaAssetEgressInput): Promise<MediaAsset>
  setMediaVoiceCloneAuthorization(input: MediaVoiceCloneAuthorizationInput): Promise<MediaAsset>
  upsertMediaCharacterBible(input: MediaCharacterBibleInput): Promise<MediaCharacterBible>
  deleteMediaCharacterBible(input: MediaCharacterBibleDeleteInput): Promise<VideoProduction>
  upsertMediaContinuityLock(input: MediaContinuityLockInput): Promise<MediaContinuityLock>
  deleteMediaContinuityLock(input: MediaContinuityLockDeleteInput): Promise<VideoProduction>
  checkMediaContinuity(input: MediaContinuityCheckInput): Promise<MediaContinuityCheckResult>
  importMediaAsset(input: MediaAssetImportInput): Promise<MediaAsset | null>
  bindMediaAsset(input: MediaAssetBindingInput): Promise<MediaAssetBinding>
  setMediaAdoption(input: MediaAdoptionInput): Promise<VideoProduction>
  composeMediaProduction(input: MediaCompositionInput): Promise<MediaCompositionResult>
  submitMediaJob(input: MediaJobInput): Promise<MediaJobRecord>
  advanceMediaJob(jobId: string): Promise<MediaJobRecord>
  reconcileMediaJob(jobId: string): Promise<MediaJobRecord>
  cancelMediaJob(jobId: string): Promise<MediaJobRecord>
}
