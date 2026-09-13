import type { ProviderProfileImportAction } from './provider-profile-types'
import type { ProviderRuntimeConfig, ProviderView } from './types'

export type ProviderNativeClient = 'codex'
export type ProviderNativeCredentialKind = 'api-key' | 'environment' | 'none'
export type ProviderNativeImportWarning =
  | 'credential_missing'
  | 'ignored_sections'
  | 'existing_credential_preserved'

export interface ProviderNativeImportDiff {
  field: 'name' | 'baseUrl' | 'models' | 'protocol' | 'runtime' | 'credential'
  current?: string
  incoming: string
}

export interface ProviderNativeImportPreview {
  previewId: string
  client: ProviderNativeClient
  source: 'environment-override' | 'user-profile'
  configPresent: boolean
  authPresent: boolean
  providerName: string
  baseUrl: string
  models: string[]
  protocol: 'responses' | 'chat'
  runtime?: ProviderRuntimeConfig
  credentialKind: ProviderNativeCredentialKind
  credentialImportable: boolean
  targetProviderId?: string
  targetProviderName?: string
  conflict: 'none' | 'same_provider' | 'name' | 'target' | 'ambiguous'
  diffs: ProviderNativeImportDiff[]
  ignoredSections: string[]
  warnings: ProviderNativeImportWarning[]
  defaultAction: ProviderProfileImportAction
  allowedActions: ProviderProfileImportAction[]
  expiresAt: number
}

export interface ProviderNativeImportApplyResult {
  operationId: string
  action: Exclude<ProviderProfileImportAction, 'skip'>
  provider: ProviderView
  providers: ProviderView[]
  backup: ProviderNativeImportBackupView
}

export interface ProviderNativeImportBackupView {
  id: string
  client: ProviderNativeClient
  createdAt: string
  action: 'create' | 'update'
  providerId: string
  providerName: string
  addedCredentialCount: number
}

export interface ProviderNativeImportRollbackResult {
  operationId: string
  restoredBackupId: string
  providers: ProviderView[]
}
