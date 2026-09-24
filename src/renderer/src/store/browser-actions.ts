import type { StoreApi } from 'zustand'
import type { BrowserStateActionResult, BrowserViewState } from '../../../shared/types'
import type { AppStore } from '../store'
import { targetForBrowserState, sameBrowserSelection } from './browser-tab-state'
import type { BrowserTabTarget } from '../../../shared/browser-tab-types'

type SetState = StoreApi<AppStore>['setState']
type GetState = StoreApi<AppStore>['getState']

type BrowserActions = Pick<
  AppStore,
  | 'openBrowserPanel'
  | 'closeBrowserPanel'
  | 'navigateBrowser'
  | 'browserGoBack'
  | 'browserGoForward'
  | 'reloadBrowser'
  | 'setBrowserBounds'
>

export function createBrowserActions(set: SetState, get: GetState): BrowserActions {
  let operationVersion = 0
  const isCurrent = (id: string, version: number, target?: BrowserTabTarget): boolean => get().activeId === id
    && !get().showNewSession && operationVersion === version
    && get().workbench.activePanelId === 'browser'
    && (!target || sameBrowserSelection(get().workbench.browserState, target))
  return {
    async openBrowserPanel(url) {
      const id = get().activeId
      if (!id || get().showNewSession) return
      const version = ++operationVersion
      set((state) => ({
        workbench: {
          ...state.workbench,
          activePanelId: 'browser',
          mountedPanels: new Set(state.workbench.mountedPanels).add('browser'),
          browserLoading: true,
          browserError: undefined,
          browserMessage: undefined
        }
      }))
      try {
        const state = await requireBrowserState(await window.agentDesk.openBrowser(id, url), get)
        const annotations = await window.agentDesk.listBrowserAnnotations(id).catch(() => [])
        if (!isCurrent(id, version)) return
        const selected = get().workbench.browserState
        if (selected && selected.contextEpoch === state.contextEpoch && selected.selectionRevision !== state.selectionRevision) return
        await window.agentDesk.setBrowserContextVisible(id, true)
        if (!isCurrent(id, version)) return
        const now = get().workbench.browserState
        if (now && !sameBrowserSelection(now, targetForBrowserState(state))) return
        set((current) => ({
          workbench: {
            ...current.workbench,
            browserLoading: state.loading,
            browserState: state,
            browserUrlDraft: state.url,
            browserAnnotations: annotations,
            browserError: undefined
          }
        }))
      } catch (error) {
        if (!isCurrent(id, version)) return
        setBrowserError(set, error, true)
      }
    },

    async closeBrowserPanel() {
      const id = get().activeId
      const version = ++operationVersion
      if (id) await window.agentDesk.setBrowserContextVisible(id, false).catch(() => undefined)
      if (get().activeId !== id || operationVersion !== version) return
      set((state) => ({
        workbench: {
          ...state.workbench,
          activePanelId: state.workbench.activePanelId === 'browser' ? null : state.workbench.activePanelId,
          browserLoading: false,
          browserError: undefined
        }
      }))
    },

    async navigateBrowser(url) {
      const id = get().activeId
      const target = url.trim()
      if (!id || !target || get().showNewSession) return
      const page = targetForBrowserState(get().workbench.browserState)
      if (!page) return
      const version = ++operationVersion
      set((state) => ({
        workbench: { ...state.workbench, browserLoading: true, browserError: undefined }
      }))
      try {
        const state = await requireBrowserState(await window.agentDesk.navigateBrowser(id, target, page), get)
        if (!isCurrent(id, version, page)) return
        set((current) => ({
          workbench: {
            ...current.workbench,
            browserState: state,
            browserUrlDraft: state.url,
            browserLoading: state.loading
          }
        }))
      } catch (error) {
        if (!isCurrent(id, version, page)) return
        setBrowserError(set, error, true)
      }
    },

    async browserGoBack() {
      const id = get().activeId
      if (!id || get().showNewSession) return
      const page = targetForBrowserState(get().workbench.browserState)
      if (!page) return
      const version = ++operationVersion
      try {
        const state = await requireBrowserState(await window.agentDesk.browserGoBack(id, page), get)
        if (!isCurrent(id, version, page)) return
        setBrowserHistoryState(set, state)
      } catch (error) {
        if (!isCurrent(id, version, page)) return
        setBrowserError(set, error)
      }
    },

    async browserGoForward() {
      const id = get().activeId
      if (!id || get().showNewSession) return
      const page = targetForBrowserState(get().workbench.browserState)
      if (!page) return
      const version = ++operationVersion
      try {
        const state = await requireBrowserState(await window.agentDesk.browserGoForward(id, page), get)
        if (!isCurrent(id, version, page)) return
        setBrowserHistoryState(set, state)
      } catch (error) {
        if (!isCurrent(id, version, page)) return
        setBrowserError(set, error)
      }
    },

    async reloadBrowser() {
      const id = get().activeId
      if (!id || get().showNewSession) return
      const page = targetForBrowserState(get().workbench.browserState)
      if (!page) return
      const version = ++operationVersion
      try {
        const state = await requireBrowserState(await window.agentDesk.reloadBrowser(id, page), get)
        if (!isCurrent(id, version, page)) return
        set((current) => ({
          workbench: { ...current.workbench, browserState: state, browserLoading: state.loading }
        }))
      } catch (error) {
        if (!isCurrent(id, version, page)) return
        setBrowserError(set, error, true)
      }
    },

    async setBrowserBounds(bounds) {
      const id = get().activeId
      if (!id || get().showNewSession || get().workbench.activePanelId !== 'browser') return
      await window.agentDesk.setBrowserBounds(id, bounds)
    }
  }
}

async function requireBrowserState(
  result: BrowserStateActionResult<BrowserViewState>,
  get: GetState
): Promise<BrowserViewState> {
  if (result.effectStatus === 'waiting_reconciliation') await get().refreshTaskSnapshots()
  if (!result.ok) throw new Error(result.error)
  return result.state
}

function setBrowserHistoryState(set: SetState, state: BrowserViewState): void {
  set((current) => ({
    workbench: { ...current.workbench, browserState: state, browserUrlDraft: state.url }
  }))
}

function setBrowserError(set: SetState, error: unknown, stopLoading = false): void {
  set((state) => ({
    workbench: {
      ...state.workbench,
      ...(stopLoading ? { browserLoading: false } : {}),
      browserError: error instanceof Error ? error.message : String(error)
    }
  }))
}
