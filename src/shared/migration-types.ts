export type MigrationAssetKind =
  | 'rules'
  | 'mcp'
  | 'config'
  | 'skill'
  | 'prompt'
  | 'usage'
  | 'hook'
  | 'memory'
  | 'routine'
  | 'channel'
export type MigrationAssetScope = 'project' | 'user'
export type MigrationAssetRisk = 'low' | 'review' | 'blocked'
export type MigrationAssetConflict = 'none' | 'merge' | 'duplicate' | 'replace_required' | 'unsupported'
export type MigrationDecisionAction = 'import' | 'replace' | 'skip'

export interface MigrationAsset {
  id: string
  agent: string
  kind: MigrationAssetKind
  scope: MigrationAssetScope
  path: string
  name: string
  sourceDigest: string
  sizeBytes: number
  preview: string
  targetPath?: string
  conflict: MigrationAssetConflict
  conflictDetail?: string
  ignoredFields: string[]
  risk: MigrationAssetRisk
  riskReasons: string[]
  importable: boolean
  recommended: boolean
  supportedActions: MigrationDecisionAction[]
}

export interface MigrationScan {
  scanId: string
  cwd?: string
  mode: 'project' | 'conversation'
  scannedAt: string
  assets: MigrationAsset[]
  diagnostics: Array<{ code: string; message: string; path?: string }>
}

export interface MigrationDecision {
  assetId: string
  action: MigrationDecisionAction
}

export interface MigrationApplyInput {
  scanId: string
  decisions: MigrationDecision[]
}

export interface MigrationApplyItemResult {
  assetId: string
  name: string
  status: 'applied' | 'skipped' | 'failed'
  targetPath?: string
  detail?: string
}

export interface MigrationApplyResult {
  ok: boolean
  status: 'applied' | 'no_changes' | 'failed'
  backupId?: string
  applied: MigrationApplyItemResult[]
  skipped: MigrationApplyItemResult[]
  errorCode?: string
  message: string
}

export interface MigrationRollbackResult {
  ok: boolean
  status: 'rolled_back' | 'failed'
  backupId: string
  safetyBackupId?: string
  restoredTargets: string[]
  errorCode?: string
  message: string
}

export interface MigrationApi {
  scanMigration(cwd?: string): Promise<MigrationScan>
  applyMigration(input: MigrationApplyInput): Promise<MigrationApplyResult>
  rollbackMigration(backupId: string): Promise<MigrationRollbackResult>
}
