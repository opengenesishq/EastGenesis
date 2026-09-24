import type { MigrationApplyResult, MigrationAsset, MigrationScan } from './migration-types'

export interface MigrationSubscription {
  id: string; revision: number; name: string; cwd?: string; assetId: string
  sourcePath: string; targetPath: string; kind: MigrationAsset['kind']
  sourceDigest: string; targetFingerprint: string; previousPreview: string
  enabled: boolean; status: 'unchanged' | 'changed' | 'conflict' | 'unavailable' | 'applying' | 'needs_reconciliation'
  createdAt: number; checkedAt?: number; backupId: string; message?: string
}
export interface MigrationSubscriptionPreview {
  id: string; subscriptionId: string; revision: number; before: string; after: MigrationAsset
  sourceDigest: string; expiresAt: number; action: 'import' | 'replace'
}
export interface MigrationSubscriptionApi {
  listMigrationSubscriptions(): Promise<MigrationSubscription[]>
  subscribeMigrationImport(backupId: string, assetIds: string[]): Promise<MigrationSubscription[]>
  setMigrationSubscriptionEnabled(id: string, revision: number, enabled: boolean): Promise<MigrationSubscription>
  checkMigrationSubscriptions(): Promise<MigrationSubscription[]>
  previewMigrationSubscription(id: string, revision: number): Promise<MigrationSubscriptionPreview>
  applyMigrationSubscription(previewId: string): Promise<MigrationApplyResult>
}
export interface MigrationSubscriptionsProps { scan: MigrationScan | null; result: MigrationApplyResult | null }
