export interface ComputerHistorySource {
  bundleId: string
  name: string
  excludedReason?: 'browser' | 'caogen'
}
export interface ComputerHistoryPolicy {
  enabled: boolean
  paused: boolean
  allowedApps: Array<{ bundleId: string; name: string }>
  retentionDays: 7 | 30 | 90
  revision: number
}
export interface ComputerHistoryPolicyInput {
  expectedRevision: number
  enabled: boolean
  paused: boolean
  allowedBundleIds: string[]
  retentionDays: 7 | 30 | 90
  /** Required when enabling or expanding the explicitly selected sources. */
  consent?: true
}
export interface ComputerHistoryRecord {
  id: string
  capturedAt: number
  bundleId: string
  appName: string
  title: string
}
export type ComputerHistoryStatus = 'unsupported' | 'temporary' | 'disabled' | 'paused' | 'waiting' | 'recording' | 'permission-required' | 'error'
export interface ComputerHistoryState {
  policy: ComputerHistoryPolicy
  status: ComputerHistoryStatus
  recordCount: number
  lastCapturedAt?: number
  error?: string
  captureScope: 'foreground-window-title'
}
export interface ComputerHistoryFilter {
  from?: number
  to?: number
  bundleId?: string
  query?: string
  recordId?: string
}
export interface ComputerHistoryQuery extends ComputerHistoryFilter { offset?: number; limit?: number }
export interface ComputerHistoryQueryResult {
  records: ComputerHistoryRecord[]
  total: number
  sources: Array<{ bundleId: string; name: string }>
}
export interface ComputerHistoryDeletionPreview {
  token: string
  count: number
  expiresAt: number
  from?: number
  to?: number
}
export interface ComputerHistoryApi {
  getComputerHistoryState(): Promise<ComputerHistoryState>
  /** Enumerates application identities only; does not read any window titles. */
  listComputerHistorySources(): Promise<ComputerHistorySource[]>
  updateComputerHistoryPolicy(input: ComputerHistoryPolicyInput): Promise<ComputerHistoryState>
  queryComputerHistory(input: ComputerHistoryQuery): Promise<ComputerHistoryQueryResult>
  previewComputerHistoryDeletion(input: ComputerHistoryFilter): Promise<ComputerHistoryDeletionPreview>
  deleteComputerHistory(token: string, reviewed: true): Promise<{ deleted: number }>
}
