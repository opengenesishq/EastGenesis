import type { BrowserStateActionResult, BrowserViewState } from './browser-operation-types'

/** Renderer hints are checked against the main-process owner and live context. */
export interface BrowserTabTarget {
  contextId: string
  contextEpoch: string
  tabId: string
  selectionRevision: number
  navigationRevision: number
}
export interface BrowserTabState extends BrowserViewState { tabId: string; navigationRevision: number }
export interface BrowserTabsSnapshot {
  contextId: string
  contextEpoch: string
  scopeKind: 'task' | 'workspace'
  revision: number
  selectionRevision: number
  activeTabId?: string
  tabs: BrowserTabState[]
}
export interface BrowserTabApi {
  listBrowserTabs(contextId: string): Promise<BrowserTabsSnapshot>
  createBrowserTab(contextId: string, options?: { url?: string; activate?: boolean; contextEpoch?: string }): Promise<BrowserStateActionResult<BrowserTabsSnapshot>>
  selectBrowserTab(target: BrowserTabTarget): Promise<BrowserTabsSnapshot>
  closeBrowserTab(target: BrowserTabTarget): Promise<BrowserTabsSnapshot>
  setBrowserContextVisible(contextId: string, visible: boolean): Promise<void>
  onBrowserTabsEvent(callback: (snapshot: BrowserTabsSnapshot) => void): () => void
}
export function browserTabTarget(snapshot: BrowserTabsSnapshot, tabId = snapshot.activeTabId): BrowserTabTarget | undefined {
  const tab = snapshot.tabs.find(value => value.tabId === tabId)
  return tab && { contextId: snapshot.contextId, contextEpoch: snapshot.contextEpoch, tabId: tab.tabId,
    selectionRevision: snapshot.selectionRevision, navigationRevision: tab.navigationRevision }
}
