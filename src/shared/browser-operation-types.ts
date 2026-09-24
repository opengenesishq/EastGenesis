import type { EffectStatus } from './effect-types'
import type { BrowserTabTarget } from './browser-tab-types'

export interface BrowserEffectResultMetadata {
  sourceKind?: 'task' | 'workspace_human'
  effectStatus?: EffectStatus
  operationId?: string
}

export interface BrowserViewState {
  /** For scopeKind=workspace this is a UI context, not a chat Session id. */
  sessionId: string
  scopeKind?: 'task' | 'workspace'
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  tabId?: string
  contextEpoch?: string
  selectionRevision?: number
  navigationRevision?: number
}

export type BrowserStateActionResult<T> =
  | ({ ok: true; state: T } & BrowserEffectResultMetadata)
  | ({ ok: false; error: string; snapshotId?: string } & BrowserEffectResultMetadata)

export interface BrowserNavigationEffectApi {
  openWorkspaceBrowser(url?: string): Promise<BrowserStateActionResult<BrowserViewState>>
  openBrowser(sessionId: string, url?: string): Promise<BrowserStateActionResult<BrowserViewState>>
  navigateBrowser(sessionId: string, url: string, target?: BrowserTabTarget): Promise<BrowserStateActionResult<BrowserViewState>>
  browserGoBack(sessionId: string, target?: BrowserTabTarget): Promise<BrowserStateActionResult<BrowserViewState>>
  browserGoForward(sessionId: string, target?: BrowserTabTarget): Promise<BrowserStateActionResult<BrowserViewState>>
  reloadBrowser(sessionId: string, target?: BrowserTabTarget): Promise<BrowserStateActionResult<BrowserViewState>>
}
