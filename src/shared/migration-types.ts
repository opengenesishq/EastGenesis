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
  /** Assets captured by the main process as eligible for an explicit source watch. */
  subscriptionAssetIds?: string[]
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

export type MigrationHistoryState = 'prepared' | 'backup_verified' | 'applying' | 'committed' | 'rollback_pending' | 'rolled_back' | 'invalid'
export interface MigrationHistoryEntry {
  backupId: string
  state: MigrationHistoryState
  createdAt?: number
  updatedAt?: number
  targetPaths: string[]
  canReviewRollback: boolean
  message?: string
}
export interface MigrationHistory {
  entries: MigrationHistoryEntry[]
  truncated: boolean
}
export interface MigrationRollbackPreview {
  backupId: string
  targetPaths: string[]
  canRollback: boolean
  reviewDigest?: string
  message: string
}

export interface MigrationApi {
  scanMigration(cwd?: string): Promise<MigrationScan>
  applyMigration(input: MigrationApplyInput): Promise<MigrationApplyResult>
  listMigrationHistory(): Promise<MigrationHistory>
  previewMigrationRollback(backupId: string): Promise<MigrationRollbackPreview>
  rollbackMigration(backupId: string, reviewDigest?: string): Promise<MigrationRollbackResult>
}
