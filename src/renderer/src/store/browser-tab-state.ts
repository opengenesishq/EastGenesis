import type { BrowserViewState } from '../../../shared/browser-operation-types'
import type { BrowserTabsSnapshot, BrowserTabTarget } from '../../../shared/browser-tab-types'

export function targetForBrowserState(state?: BrowserViewState): BrowserTabTarget | undefined {
  if (!state?.tabId || !state.contextEpoch || state.selectionRevision === undefined || state.navigationRevision === undefined) return undefined
  return { contextId: state.sessionId, contextEpoch: state.contextEpoch, tabId: state.tabId,
    selectionRevision: state.selectionRevision, navigationRevision: state.navigationRevision }
}
export function sameBrowserSelection(state: BrowserViewState | undefined, target: BrowserTabTarget | undefined): boolean {
  return Boolean(target && state?.sessionId === target.contextId && state.contextEpoch === target.contextEpoch &&
    state.tabId === target.tabId && state.selectionRevision === target.selectionRevision)
}
export function activeBrowserState(snapshot: BrowserTabsSnapshot): BrowserViewState {
  return snapshot.tabs.find(tab => tab.tabId === snapshot.activeTabId) ?? {
    sessionId: snapshot.contextId, scopeKind: snapshot.scopeKind, contextEpoch: snapshot.contextEpoch,
    selectionRevision: snapshot.selectionRevision, url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false
  }
}
