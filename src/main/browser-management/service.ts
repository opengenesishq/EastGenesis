import { app, dialog, shell, type Session, type DownloadItem, type WebContents, type Event } from 'electron'
import { join } from 'node:path'
import type { BrowserPreferences, BrowserPreferencesSnapshot, BrowserSiteState } from '../../shared/browser-preferences-types'
import type { BrowserTabTarget } from '../../shared/browser-tab-types'
import { BrowserDownloads, type BrowserDownloadHost, type ManagedBrowserTab } from './downloads'
import { browserOrigin, browserSiteDecision } from './preferences'
import { BrowserManagementStore } from './store'

interface Partition { tabs: Map<number, ManagedBrowserTab>; download: (event: Event, item: DownloadItem, contents: WebContents) => void }
export class BrowserManagementService {
  readonly downloads: BrowserDownloads
  private readonly partitions = new Map<Session, Partition>()
  constructor(readonly store: BrowserManagementStore, host: BrowserDownloadHost) { this.downloads = new BrowserDownloads(store, host) }
  attach(tab: ManagedBrowserTab): void {
    const session = tab.contents.session
    // Keep deterministic/native-light fixtures compatible; real Electron always has these APIs.
    if (!session?.webRequest?.onBeforeRequest || !session.on) return
    this.store.getPreferences()
    let partition = this.partitions.get(session)
    if (!partition) {
      const tabs = new Map<number, ManagedBrowserTab>()
      const download = (event: Event, item: DownloadItem, contents: WebContents): void => {
        try { this.downloads.begin(event, item, tabs.get(contents.id)) }
        catch (error) { event.preventDefault(); tabs.get(contents.id)?.error(error instanceof Error ? error.message : String(error)) }
      }
      partition = { tabs, download }; this.partitions.set(session, partition)
      session.on('will-download', download)
      session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        const source = details.webContentsId === undefined ? undefined : tabs.get(details.webContentsId)
        try {
          // A service worker may have no WebContents; the partition's shared policy still applies.
          const decision = browserSiteDecision(this.store.getPreferences().preferences, details.url)
          const blocked = tabs.size === 0 || (details.webContentsId !== undefined && !source) || !!browserOrigin(details.url) && decision.access === 'block'
          if (blocked && details.resourceType === 'mainFrame') source?.error(`站点已阻止：${decision.origin}`)
          callback({ cancel: blocked })
        } catch { callback({ cancel: true }) }
      })
    }
    partition.tabs.set(tab.contents.id, tab)
  }
  detach(tab: ManagedBrowserTab): void {
    this.downloads.detach(tab.tabId)
    const session = tab.contents.session, partition = this.partitions.get(session)
    if (!partition) return
    partition.tabs.delete(tab.contents.id)
    if (!partition.tabs.size) { session.removeListener('will-download', partition.download); session.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true })); this.partitions.delete(session) }
  }
  assertNavigation(url: string): void {
    const origin = browserOrigin(url)
    if (origin && browserSiteDecision(this.store.getPreferences().preferences, url).access === 'block') throw new Error(`站点已阻止：${origin}`)
  }
  save(expectedRevision: number, preferences: BrowserPreferences): BrowserPreferencesSnapshot {
    const snapshot = this.store.savePreferences(expectedRevision, preferences)
    for (const partition of this.partitions.values()) for (const tab of partition.tabs.values()) {
      if (tab.contents.isDestroyed()) continue
      const origin = browserOrigin(tab.contents.getURL())
      if (origin && browserSiteDecision(snapshot.preferences, origin).access === 'block') {
        tab.contents.stop()
        // Unload the blocked document so existing scripts/sockets and its approvals cannot keep working.
        void tab.contents.loadURL('about:blank').catch(() => undefined)
        tab.error(`站点已阻止：${origin}；页面已关闭。`)
      }
    }
    this.downloads.enforceRules(); return snapshot
  }
  siteState(target: BrowserTabTarget, url: string): BrowserSiteState {
    const snapshot = this.store.getPreferences()
    return { target, ...browserSiteDecision(snapshot.preferences, url), preferencesRevision: snapshot.revision }
  }
  recordVisit(tab: ManagedBrowserTab): void {
    const target = tab.target()
    this.store.recordVisit({ contextId: tab.contextId, scopeKind: tab.contextId.startsWith('workspace-browser:') ? 'workspace' : 'task',
      tabId: tab.tabId, contextEpoch: target.contextEpoch, navigationRevision: target.navigationRevision, url: tab.contents.getURL(), title: tab.contents.getTitle() })
  }
  updateTitle(tab: ManagedBrowserTab): void { const target = tab.target(); this.store.updateTitle(tab.tabId, target.contextEpoch, target.navigationRevision, tab.contents.getTitle()) }
}
let singleton: BrowserManagementService | undefined
export function browserManagement(): BrowserManagementService {
  if (!singleton) singleton = new BrowserManagementService(new BrowserManagementStore(join(app.getPath('userData'), 'browser-management'), app.getPath('downloads')), {
    chooseFile: async (owner, defaultPath) => { const result = await dialog.showSaveDialog(owner, { title: '保存浏览器下载', defaultPath, buttonLabel: '保存', properties: ['showOverwriteConfirmation', 'createDirectory'] }); return result.canceled ? undefined : result.filePath },
    reveal: file => shell.showItemInFolder(file)
  })
  return singleton
}
