import type { BrowserWindow, DownloadItem, Event, WebContents } from 'electron'
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserDownloadRecord } from '../../shared/browser-preferences-types'
import type { BrowserTabTarget } from '../../shared/browser-tab-types'
import { browserLogUrl, browserOrigin, browserSiteDecision } from './preferences'
import type { BrowserManagementStore } from './store'

export interface ManagedBrowserTab {
  contextId: string; tabId: string; owner: BrowserWindow; contents: WebContents
  target(): BrowserTabTarget
  isCurrent(target: BrowserTabTarget, page: boolean): boolean
  error(message: string): void
}
interface ActiveDownload {
  item: DownloadItem; record: BrowserDownloadRecord; tab: ManagedBrowserTab; target: BrowserTabTarget
  urls: string[]; staging: string; destination?: string; directoryIdentity?: { dev: number; ino: number }
  ending: boolean; progressAt: number
}
export interface BrowserDownloadHost {
  chooseFile(owner: BrowserWindow, defaultPath: string): Promise<string | undefined>
  reveal(file: string): void
}
export class BrowserDownloads {
  private readonly active = new Map<string, ActiveDownload>()
  private recoveryError?: string
  constructor(private readonly store: BrowserManagementStore, private readonly host: BrowserDownloadHost) {
    // Only remove staging files named by this service's own recorded download ids.
    try {
      const staging = join(store.root, 'download-staging')
      if (existsSync(staging) && lstatSync(staging).isSymbolicLink()) throw new Error('下载暂存目录不可为符号链接。')
      for (const record of store.listDownloads()) if (/^[a-f0-9-]{36}$/.test(record.id)) rmSync(join(store.root, 'download-staging', `${record.id}.part`), { force: true })
    } catch (error) { this.recoveryError = errorText(error) }
  }
  private allowed(tab: ManagedBrowserTab, urls: string[]): boolean {
    const preferences = this.store.getPreferences().preferences
    return !tab.owner.isDestroyed() && !tab.contents.isDestroyed() && urls.length > 0 && urls.every(url =>
      Boolean(browserOrigin(url)) && browserSiteDecision(preferences, url).downloads === 'allow')
  }
  begin(event: Event, item: DownloadItem, tab?: ManagedBrowserTab): void {
    if (!tab) { event.preventDefault(); return }
    if (this.recoveryError) { event.preventDefault(); tab.error(this.recoveryError); return }
    const id = randomUUID(), target = tab.target(), now = Date.now()
    const urls = [...new Set([tab.contents.getURL(), ...item.getURLChain(), item.getURL()])]
    const filename = safeFilename(item.getFilename())
    const record: BrowserDownloadRecord = { id, contextId: tab.contextId, tabId: tab.tabId, contextEpoch: target.contextEpoch,
      scopeKind: tab.contextId.startsWith('workspace-browser:') ? 'workspace' : 'task', url: browserLogUrl(item.getURL()), filename,
      state: 'awaiting-location', receivedBytes: 0, totalBytes: Math.max(0, item.getTotalBytes()), startedAt: now, updatedAt: now }
    if (!this.allowed(tab, urls) || [...this.active.values()].filter(value => value.tab.contextId === tab.contextId).length >= 16) {
      event.preventDefault(); record.state = 'blocked'; record.error = '下载被站点规则阻止，或同时下载数量已达上限。'; this.store.putDownload(record); tab.error(record.error); return
    }
    const stagingDirectory = join(this.store.root, 'download-staging')
    mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 })
    if (lstatSync(stagingDirectory).isSymbolicLink()) { event.preventDefault(); throw new Error('下载暂存目录不可为符号链接。') }
    const staging = join(stagingDirectory, `${id}.part`)
    item.setSavePath(staging)
    item.pause()
    const active: ActiveDownload = { item, record, tab, target, urls, staging, ending: false, progressAt: 0 }
    this.active.set(id, active); this.store.putDownload(record)
    item.on('updated', (_event, state) => {
      if (active.ending) return
      if (state === 'interrupted') { this.cancel(active, 'interrupted', '网络下载中断，请重新下载。'); return }
      if (!this.allowed(tab, urls) || !tab.isCurrent(target, false)) { this.cancel(active, 'cancelled', '原浏览器页面已关闭或下载规则已变化。'); return }
      record.receivedBytes = Math.max(0, item.getReceivedBytes()); record.updatedAt = Date.now()
      if (record.state !== 'awaiting-location') record.state = 'progressing'
      if (Date.now() - active.progressAt >= 250) { active.progressAt = Date.now(); this.store.putDownload(record, false) }
    })
    item.once('done', (_event, state) => { this.finish(active, state) })
    const preferences = this.store.getPreferences().preferences
    const suggested = join(preferences.downloadDirectory, filename)
    if (preferences.askDownloadLocation) {
      void this.host.chooseFile(tab.owner, suggested).then(destination => {
        if (active.ending) return
        if (!destination) { this.cancel(active, 'cancelled'); return }
        if (!tab.isCurrent(target, true) || !this.allowed(tab, urls)) { this.cancel(active, 'cancelled', '选择位置期间原页面或下载规则已变化。'); return }
        this.resume(active, destination)
      }).catch(error => this.cancel(active, 'interrupted', errorText(error)))
    } else this.resume(active, uniqueDestination(preferences.downloadDirectory, filename, id))
  }
  private resume(active: ActiveDownload, rawDestination: string): void {
    try {
      if (active.ending || !this.allowed(active.tab, active.urls) || !active.tab.isCurrent(active.target, false)) throw new Error('下载归属或站点规则已变化。')
      const directory = realpathSync(dirname(rawDestination)), info = statSync(directory)
      if (!info.isDirectory()) throw new Error('下载位置不可用。')
      const destination = join(directory, basename(rawDestination))
      if (existsSync(destination)) throw new Error('目标文件已存在，请重新下载并选择其他文件名。')
      active.destination = destination; active.directoryIdentity = { dev: info.dev, ino: info.ino }
      active.record.state = 'progressing'; active.record.updatedAt = Date.now(); this.store.putDownload(active.record)
      active.item.resume()
    } catch (error) { this.cancel(active, 'interrupted', errorText(error)) }
  }
  private finish(active: ActiveDownload, state: 'completed' | 'cancelled' | 'interrupted'): void {
    if (active.ending) return
    active.ending = true
    const record = active.record
    try {
      if (state === 'completed') {
        if (!active.destination || !active.tab.isCurrent(active.target, false) || !this.allowed(active.tab, active.urls)) throw new Error('下载完成时原浏览器归属或规则已变化，文件未发布。')
        const parent = statSync(dirname(active.destination))
        if (parent.dev !== active.directoryIdentity?.dev || parent.ino !== active.directoryIdentity?.ino) throw new Error('下载目标目录已变化，文件未发布。')
        const source = lstatSync(active.staging)
        if (!source.isFile() || source.isSymbolicLink()) throw new Error('下载暂存文件无效。')
        copyFileSync(active.staging, active.destination, constants.COPYFILE_EXCL)
        record.savePath = active.destination; record.filename = basename(active.destination); record.state = 'completed'
      } else record.state = state
      record.receivedBytes = Math.max(0, active.item.getReceivedBytes())
    } catch (error) { record.state = 'interrupted'; record.error = errorText(error) }
    this.cleanup(active)
  }
  private cancel(active: ActiveDownload, state: 'cancelled' | 'interrupted' | 'blocked', error?: string): void {
    if (active.ending) return
    active.ending = true; active.record.state = state; active.record.error = error
    try { active.item.cancel() } catch { /* Native download already ended. */ }
    this.cleanup(active)
  }
  private cleanup(active: ActiveDownload): void {
    this.active.delete(active.record.id); active.record.updatedAt = Date.now()
    try { rmSync(active.staging, { force: true }) } catch { active.record.error ??= '暂存文件清理失败，可在退出应用后检查浏览器管理目录。' }
    this.store.putDownload(active.record)
  }
  detach(tabId: string): void { for (const active of this.active.values()) if (active.tab.tabId === tabId) this.cancel(active, 'cancelled', '原浏览器标签已关闭。') }
  enforceRules(): void { for (const active of this.active.values()) if (!this.allowed(active.tab, active.urls)) this.cancel(active, 'blocked', '下载被更新后的站点规则阻止。') }
  control(id: string, action: 'cancel' | 'reveal' | 'remove-record'): void {
    const record = this.store.listDownloads().find(item => item.id === id)
    if (!record) throw new Error('下载记录不存在。')
    const active = this.active.get(id)
    if (action === 'cancel') { if (!active) throw new Error('下载已经结束。'); this.cancel(active, 'cancelled'); return }
    if (action === 'remove-record') { if (active) throw new Error('请先取消进行中的下载。'); this.store.removeDownload(id); return }
    if (record.state !== 'completed' || !record.savePath || !existsSync(record.savePath)) throw new Error('完成的下载文件已不存在。')
    this.host.reveal(record.savePath)
  }
}
function safeFilename(value: string): string {
  const name = basename(value).replace(/[\\/:\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '').slice(0, 180).trim()
  return name || 'download'
}
function uniqueDestination(directory: string, name: string, id: string): string {
  const path = join(directory, name)
  if (!existsSync(path)) return path
  const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, extension = dot > 0 ? name.slice(dot) : ''
  return join(directory, `${base}-${id.slice(0, 8)}${extension}`)
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
