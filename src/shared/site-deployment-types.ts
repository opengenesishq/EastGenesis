import type { SiteManagementConfig } from './hosted-site-types'
/** User-owned deployment scripts run locally; CaoGen supplies no hosted Sites backend. */
export interface SiteDeploymentTarget {
  id: string
  revision: number
  name: string
  /** Build output beneath the current task directory. */
  outputDirectory: string
  /** Absolute executable path, run without a shell. */
  executable: string
  deployArgs: string[]
  rollbackArgs: string[]
  inspectArgs: string[]
  /** Explicit process environment names; values never enter renderer or persistence. */
  environmentKeys: string[]
  estimatedCostUsd?: number
  timeoutSeconds: number
  management?: SiteManagementConfig
}
export interface SiteDeploymentReceipt {
  id: string
  sessionId: string
  targetId: string
  targetName: string
  action: 'deploy' | 'rollback'
  status: 'executing' | 'confirmed' | 'not_started' | 'needs_reconciliation'
  snapshotId: string
  manifestDigest: string
  operationId?: string
  effectId?: string
  recoverySnapshotId?: string
  deploymentId?: string
  url?: string
  rollbackOf?: string
  startedAt: number
  finishedAt?: number
  exitCode?: number | null
  signal?: string | null
  stdout: string
  stderr: string
  outputTruncated: boolean
  error?: string
  verification: 'adapter_receipt' | 'unconfirmed'
}
export interface SiteDeploymentPreview {
  id: string
  sessionId: string
  target: SiteDeploymentTarget
  action: 'deploy' | 'rollback'
  rollbackOf?: string
  sourceDirectory: string
  files: Array<{ path: string; bytes: number; sha256: string }>
  bytes: number
  manifestDigest: string
  command: string[]
  environmentKeys: string[]
  createdAt: number
  expiresAt: number
  localUrl?: string
}
export interface SiteDeploymentState { targets: SiteDeploymentTarget[]; receipts: SiteDeploymentReceipt[] }
export interface LocalSitePreview {
  id: string
  sessionId: string
  sourcePath: string
  kind: 'html' | 'directory'
  entryPath: string
  localUrl: string
  fileCount: number
  bytes: number
  manifestDigest: string
  createdAt: number
  expiresAt: number
}
export interface SiteDeploymentApi {
  startLocalSitePreview(sessionId: string, path: string, expectedTaskKey?: string): Promise<LocalSitePreview>
  getLocalSitePreview(sessionId: string): Promise<LocalSitePreview | null>
  stopLocalSitePreview(sessionId: string, previewId?: string): Promise<void>
  getSiteDeployments(sessionId: string): Promise<SiteDeploymentState>
  saveSiteDeploymentTarget(sessionId: string, input: SiteDeploymentTarget): Promise<SiteDeploymentTarget>
  removeSiteDeploymentTarget(sessionId: string, targetId: string, revision: number): Promise<void>
  prepareSiteDeployment(sessionId: string, targetId: string, rollbackReceiptId?: string): Promise<SiteDeploymentPreview>
  executeSiteDeployment(sessionId: string, previewId: string): Promise<SiteDeploymentReceipt | null>
  cancelSiteDeployment(sessionId: string, receiptId: string): Promise<boolean>
  inspectSiteDeployment(sessionId: string, receiptId: string): Promise<SiteDeploymentReceipt | null>
  stopSiteDeploymentPreview(sessionId: string, previewId: string): Promise<void>
}
