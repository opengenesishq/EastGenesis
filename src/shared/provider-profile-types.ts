import type {
  EngineInfo,
  EngineKind,
  OpenAIProtocol,
  ProviderHealthView,
  ProviderInput,
  ProviderAuthMode,
  ProviderGenerationProbeInput,
  ProviderGenerationProbeResult,
  ProviderModelFetchInput,
  ProviderModelFetchResult,
  ProviderPricingCatalogFetchResult,
  ProviderView
} from './types'
import type { ProviderProfileWebDavApi } from './provider-profile-webdav-types'
import type { ProviderProfileS3Api } from './provider-profile-s3-types'

export type ProviderProfileImportAction = 'create' | 'update' | 'skip'

export type ProviderProfileConflictKind =
  | 'none'
  | 'same_provider'
  | 'name'
  | 'target'
  | 'ambiguous'

export interface ProviderProfileImportItem {
  id: string
  name: string
  baseUrl: string
  models: string[]
  engine: EngineKind
  openaiProtocol?: OpenAIProtocol
  authMode: ProviderAuthMode
  targetProviderId?: string
  targetProviderName?: string
  targetKeyCount?: number
  targetActiveKeyLabel?: string
  targetCredentialMigrationRequired?: boolean
  targetCredentialBindingChanged: boolean
  conflict: ProviderProfileConflictKind
  changedFields: string[]
  defaultAction: ProviderProfileImportAction
  allowedActions: ProviderProfileImportAction[]
}

export interface ProviderProfileImportPreview {
  previewId: string
  fileName: string
  profileCount: number
  createCount: number
  updateCount: number
  skipCount: number
  credentialFieldsIgnored: number
  warnings: string[]
  items: ProviderProfileImportItem[]
}

export interface ProviderProfileImportDecision {
  itemId: string
  action: ProviderProfileImportAction
}

export interface ProviderProfileBackupView {
  id: string
  createdAt: string
  expiresAt: string
  providerCount: number
  reason: ProviderProfileBackupReason
  nonPersistentCredentialCount: number
  excludedCredentialCount: number
}

export interface ProviderProfileExportResult {
  canceled: boolean
  fileName?: string
  providerCount: number
}

export interface ProviderProfileApplyResult {
  operationId: string
  providers: ProviderView[]
  backup: ProviderProfileBackupView
  created: number
  updated: number
  skipped: number
}

export interface ProviderProfileRollbackResult {
  operationId: string
  providers: ProviderView[]
  restoredBackupId: string
}

export type ProviderProfileBackupReason =
  | 'import'
  | 'manual'
  | 'provider-create'
  | 'provider-update'
  | 'provider-delete'

export type ProviderProfileBackupChangeAction = 'create' | 'update' | 'delete' | 'unchanged'

export interface ProviderProfileBackupChange {
  id: string
  providerName: string
  action: ProviderProfileBackupChangeAction
  changedFields: string[]
}

export interface ProviderProfileBackupPreview {
  previewId: string
  backup: ProviderProfileBackupView
  createCount: number
  updateCount: number
  deleteCount: number
  unchangedCount: number
  credentialReentryCount: number
  items: ProviderProfileBackupChange[]
}

export type ProviderProfileSyncRelation =
  | 'unconfigured'
  | 'remote_missing'
  | 'in_sync'
  | 'local_ahead'
  | 'remote_ahead'
  | 'diverged'

export interface ProviderProfileSyncHistoryEntry {
  revisionId: string
  parentRevisionId?: string
  createdAt: string
  providerCount: number
  deviceId: string
}

export interface ProviderProfileSyncHistoryPreview {
  previewId: string
  entry: ProviderProfileSyncHistoryEntry
  importPreview: ProviderProfileImportPreview
}

export interface ProviderProfileSyncStatus {
  configured: boolean
  directoryName?: string
  relation: ProviderProfileSyncRelation
  localProviderCount: number
  remoteProviderCount?: number
  remoteCreatedAt?: string
  lastSyncAt?: string
}

export interface ProviderProfileSyncPreview {
  previewId: string
  status: ProviderProfileSyncStatus
  importPreview?: ProviderProfileImportPreview
  canPublish: boolean
  canPull: boolean
  requiresConflictChoice: boolean
}

export interface ProviderProfileSyncPublishResult {
  revisionId: string
  providerCount: number
  status: ProviderProfileSyncStatus
}

export interface ProviderProfileSyncApplyResult extends ProviderProfileApplyResult {
  status: ProviderProfileSyncStatus
}

export interface ProviderManagementApi {
  listProviders(): Promise<ProviderView[]>
  createProvider(provider: ProviderInput): Promise<ProviderView>
  updateProvider(id: string, patch: Partial<ProviderInput>): Promise<ProviderView>
  deleteProvider(id: string): Promise<void>
  fetchProviderModels(opts: ProviderModelFetchInput): Promise<ProviderModelFetchResult>
  probeProviderGeneration(opts: ProviderGenerationProbeInput): Promise<ProviderGenerationProbeResult>
  fetchProviderPricingCatalog(models: string[]): Promise<ProviderPricingCatalogFetchResult>
  activateLocalCompute(options?: LocalComputeActivationOptions): Promise<LocalComputeActivationResult>
  listProviderHealth(): Promise<ProviderHealthView[]>
  listEngines(): Promise<EngineInfo[]>
}

export type LocalComputeService = 'ollama' | 'lm-studio' | 'vllm'

export type LocalComputeUnavailableReason = 'runtime-missing' | 'runtime-stopped' | 'model-missing'

export interface LocalComputeActivationOptions {
  /** Start an installed Ollama runtime. Automatic first-screen discovery leaves this false. */
  startInstalled?: boolean
}

export interface LocalComputeActivationResult {
  status: 'activated' | 'unavailable'
  checkedAt: number
  service?: LocalComputeService
  provider?: ProviderView
  reason?: LocalComputeUnavailableReason
  startedService?: boolean
}

export interface ProviderProfileApi extends ProviderManagementApi, ProviderProfileWebDavApi, ProviderProfileS3Api {
  exportProviderProfile(): Promise<ProviderProfileExportResult>
  previewProviderProfileImport(): Promise<ProviderProfileImportPreview | null>
  applyProviderProfileImport(
    previewId: string,
    decisions: ProviderProfileImportDecision[]
  ): Promise<ProviderProfileApplyResult>
  listProviderProfileBackups(): Promise<ProviderProfileBackupView[]>
  previewProviderProfileBackup(backupId: string): Promise<ProviderProfileBackupPreview>
  applyProviderProfileBackupPreview(previewId: string): Promise<ProviderProfileRollbackResult>
  rollbackProviderProfileBackup(backupId: string): Promise<ProviderProfileRollbackResult>
  deleteProviderProfileBackup(backupId: string): Promise<{ deletedBackupId: string }>
  getProviderProfileSyncStatus(): Promise<ProviderProfileSyncStatus>
  chooseProviderProfileSyncDirectory(): Promise<ProviderProfileSyncStatus | null>
  disconnectProviderProfileSync(): Promise<ProviderProfileSyncStatus>
  previewProviderProfileSync(): Promise<ProviderProfileSyncPreview>
  publishProviderProfileSync(
    previewId: string,
    allowDiverged: boolean
  ): Promise<ProviderProfileSyncPublishResult>
  applyProviderProfileSync(
    previewId: string,
    decisions: ProviderProfileImportDecision[]
  ): Promise<ProviderProfileSyncApplyResult>
  previewCodexNativeProviderImport(): Promise<import('./provider-native-import-types').ProviderNativeImportPreview>
  applyCodexNativeProviderImport(
    previewId: string,
    action: ProviderProfileImportAction
  ): Promise<import('./provider-native-import-types').ProviderNativeImportApplyResult>
  listProviderNativeImportBackups(): Promise<import('./provider-native-import-types').ProviderNativeImportBackupView[]>
  rollbackProviderNativeImportBackup(
    backupId: string
  ): Promise<import('./provider-native-import-types').ProviderNativeImportRollbackResult>
}
