import type { BrowserTabTarget } from './browser-tab-types'

export type BrowserSiteAccess = 'allow' | 'block'
export interface BrowserSiteRule { origin: string; access: BrowserSiteAccess; downloads: 'inherit' | BrowserSiteAccess }
export interface BrowserPreferences {
  recordHistory: boolean
  retentionDays: number
  downloadDirectory: string
  askDownloadLocation: boolean
  defaultSiteAccess: BrowserSiteAccess
  siteRules: BrowserSiteRule[]
}
export interface BrowserPreferencesSnapshot { revision: number; preferences: BrowserPreferences }
export interface BrowserHistoryRecord {
  id: string; contextId: string; scopeKind: 'task' | 'workspace'; tabId: string; contextEpoch: string
  navigationRevision: number; url: string; title: string; visitedAt: number
}
export interface BrowserHistoryQuery { query?: string; before?: number; limit?: number; contextId?: string }
export interface BrowserHistoryResult { items: BrowserHistoryRecord[]; nextBefore?: number; clearToken: string }
export type BrowserDownloadState = 'awaiting-location' | 'progressing' | 'completed' | 'cancelled' | 'interrupted' | 'blocked'
export interface BrowserDownloadRecord {
  id: string; contextId: string; scopeKind: 'task' | 'workspace'; tabId: string; contextEpoch: string
  url: string; filename: string; state: BrowserDownloadState; receivedBytes: number; totalBytes: number
  savePath?: string; startedAt: number; updatedAt: number; error?: string
}
export interface BrowserSiteState {
  target: BrowserTabTarget; origin?: string; access: BrowserSiteAccess; downloads: BrowserSiteAccess
  ruleSource: 'default' | 'origin'; preferencesRevision: number
}
export interface BrowserManagementEvent { kind: 'preferences' | 'history' | 'downloads'; revision: number; contextId?: string }
export interface BrowserManagementApi {
  getBrowserPreferences(): Promise<BrowserPreferencesSnapshot>
  saveBrowserPreferences(input: { expectedRevision: number; preferences: BrowserPreferences }): Promise<BrowserPreferencesSnapshot>
  chooseBrowserDownloadDirectory(): Promise<string | null>
  listBrowserHistory(query?: BrowserHistoryQuery): Promise<BrowserHistoryResult>
  clearBrowserHistory(input: { clearToken: string }): Promise<{ removed: number }>
  listBrowserDownloads(query?: { contextId?: string }): Promise<BrowserDownloadRecord[]>
  controlBrowserDownload(input: { id: string; action: 'cancel' | 'reveal' | 'remove-record' }): Promise<void>
  getBrowserSiteState(target: BrowserTabTarget): Promise<BrowserSiteState>
  setCurrentBrowserSiteRule(input: { target: BrowserTabTarget; expectedRevision: number; rule: 'allow' | 'block' | 'inherit' }): Promise<BrowserPreferencesSnapshot>
  onBrowserManagementEvent(callback: (event: BrowserManagementEvent) => void): () => void
}
