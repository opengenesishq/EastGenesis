import { clickSelectorScript, typeTextScript, mutationTargetCheckScript, mutationTargetRuntimeScript, waitForSelectorScript } from '../shared/browser-dom-scripts'
export { clickSelectorScript, typeTextScript, mutationTargetCheckScript, mutationTargetRuntimeScript, waitForSelectorScript } from '../shared/browser-dom-scripts'
import { app, BrowserWindow, WebContentsView } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  listAnnotations,
  saveAnnotation,
  type BrowserAnnotationInput
} from './browserAnnotations'
import type {
  BrowserAnnotation,
  BrowserAnnotationBoundingBox,
  BrowserBounds,
  BrowserEvent,
  BrowserObservation,
  BrowserPickResult,
  BrowserViewState
} from '../shared/types'
import { browserStyleController } from './browser-style/controller'
import { browserDebugController } from './browser-debug/controller'
import { browserManagement } from './browser-management/service'
import type { ManagedBrowserTab } from './browser-management/downloads'
import { DEFAULT_BROWSER_URL, normalizeBrowserNavigationUrl } from './browserNavigation'
import { readBrowserPageSource, type BrowserPageSource } from './browser/browser-page-source'
import { isBrowserSearchPage, searchBrowserPage } from './browser/browser-search-page'
import type { SearchAdapterResult } from './search/search-broker'
import type { EffectTarget } from '../shared/effect-types'
import type { BrowserTabTarget, BrowserTabsSnapshot, BrowserTabState } from '../shared/browser-tab-types'

type BrowserMutationPage = NonNullable<Extract<EffectTarget, { kind: 'unsupported' }>['browserPage']>
type BrowserMutationKind = NonNullable<BrowserMutationPage['actionTarget']>['kind']
const MUTATION_WORLD_ID = 1003
const DOCUMENT_TOKEN_KEY = '__caogenApprovedDocumentV1'
const ACTION_TARGET_KEY = '__caogenApprovedActionTargetV1'
function urlDigest(url: string): string { return createHash('sha256').update(url, 'utf8').digest('hex') }

interface BrowserRecord {
  management?: ManagedBrowserTab
  tabId: string
  viewId: string
  sessionId: string
  view: WebContentsView
  owner: BrowserWindow
  consoleErrors: string[]
  /** 最近的网络失败(status>=400 或加载失败),供批注/只读观测 */
  networkFailures: string[]
  navigationRevision: number
  state: BrowserViewState
}
interface BrowserContext {
  id: string; epoch: string; owner: BrowserWindow; tabs: BrowserRecord[]; selectionRevision: number; revision: number
  visible: boolean; bounds: BrowserBounds
  identityKey?: string
}

interface SelectionPayload {
  url?: string
  title?: string
  text?: string
  selector?: string
  boundingBox?: { x: number; y: number; width: number; height: number }
  viewport?: { width: number; height: number; deviceScaleFactor?: number }
}

type Listener = (event: BrowserEvent) => void

const MAX_CONSOLE_ERRORS = 200

class BrowserViewManager {
  private readonly records = new Map<string, BrowserRecord>()
  private readonly contexts = new Map<string, BrowserContext>()
  private readonly listeners = new Set<Listener>()
  private readonly tabListeners = new Set<(snapshot: BrowserTabsSnapshot, owner: BrowserWindow) => void>()
  private readonly activeSearches = new Set<string>()
  private readonly partitions = new Map<Electron.Session, Map<number, BrowserRecord>>()
  private readonly picks = new Map<string, { target: BrowserTabTarget; value: BrowserPickResult; expiresAt: number }>()
  private readonly observedOwners = new WeakSet<BrowserWindow>()
  private taskIdentity?: (sessionId: string) => string | undefined

  setTaskIdentityResolver(resolve: (sessionId: string) => string | undefined): void { this.taskIdentity = resolve }
  closeOwned(owner: BrowserWindow): void {
    for (const context of [...this.contexts.values()]) if (context.owner === owner) this.close(context.id, owner)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(sessionId: string): BrowserViewState | undefined {
    const record = this.records.get(sessionId)
    if (!record || record.owner.isDestroyed() || record.view.webContents.isDestroyed()) return undefined
    return this.projectState(record)
  }

  subscribeTabs(listener: (snapshot: BrowserTabsSnapshot, owner: BrowserWindow) => void): () => void {
    this.tabListeners.add(listener); return () => this.tabListeners.delete(listener)
  }
  visibleToWindow(sessionId: string | undefined, ownerId: number): boolean {
    return Boolean(sessionId && this.contexts.get(sessionId)?.owner.webContents.id === ownerId)
  }
  isContextVisible(sessionId: string): boolean { return this.contexts.get(sessionId)?.visible === true }
  getTabs(sessionId: string): BrowserTabsSnapshot {
    const context = this.requireContext(sessionId)
    return { contextId: sessionId, contextEpoch: context.epoch, scopeKind: sessionId.startsWith('workspace-browser:') ? 'workspace' : 'task',
      revision: context.revision, selectionRevision: context.selectionRevision, activeTabId: this.records.get(sessionId)?.tabId,
      tabs: context.tabs.map(record => this.projectState(record)) }
  }
  target(sessionId: string): BrowserTabTarget {
    const record = this.requireRecord(sessionId), context = this.requireContext(sessionId)
    return { contextId: sessionId, contextEpoch: context.epoch, tabId: record.tabId,
      selectionRevision: context.selectionRevision, navigationRevision: record.navigationRevision }
  }
  assertTarget(target: BrowserTabTarget, selected = true, page = false): BrowserRecord {
    if (!target || typeof target.contextId !== 'string' || typeof target.tabId !== 'string') throw new Error('浏览器标签身份无效。')
    const context = this.requireContext(target.contextId), record = context.tabs.find(tab => tab.tabId === target.tabId)
    if (!record || record.view.webContents.isDestroyed() || context.epoch !== target.contextEpoch ||
      context.selectionRevision !== target.selectionRevision || (selected && this.records.get(context.id) !== record) ||
      (page && record.navigationRevision !== target.navigationRevision)) throw new Error('浏览器标签或页面已变化，原操作失效（原审批失效）；请重新查看并审批。')
    return record
  }
  /** Captures a target before permission, disk reads or other asynchronous work. */
  bind(sessionId: string, expected?: BrowserTabTarget) {
    const target = expected ?? this.target(sessionId)
    if (target.contextId !== sessionId) throw new Error('浏览器标签不属于当前任务。')
    this.assertTarget(target)
    const run = async <T>(operation: () => Promise<T>, page = false): Promise<T> => {
      this.assertTarget(target, true, page)
      const result = await operation()
      this.assertTarget(target)
      return result
    }
    return {
      boundTarget: target,
      assertWindowOwner: (id: string, owner: BrowserWindow) => { if (id !== sessionId) throw new Error('浏览器上下文不一致'); this.assertTarget(target); this.assertWindowOwner(id, owner) },
      getState: (id: string) => { if (id !== sessionId) throw new Error('浏览器上下文不一致'); return this.projectState(this.assertTarget(target)) },
      open: (owner: BrowserWindow, id: string, url?: string) => run(() => { this.assertWindowOwner(id, owner); return this.open(owner, id, url) }, true),
      navigate: (_id: string, url: string) => run(() => this.navigate(sessionId, url), true),
      goBack: (_id: string) => run(() => this.goBack(sessionId), true),
      goForward: (_id: string) => run(() => this.goForward(sessionId), true),
      reload: (_id: string) => run(() => this.reload(sessionId), true),
      readPage: () => run(() => this.readPage(sessionId), true),
      screenshot: (selector?: string) => run(() => this.screenshot(sessionId, selector), true),
      waitFor: (selector: string, timeoutMs: number) => run(() => this.waitFor(sessionId, selector, timeoutMs), true),
      captureMutationPage: (kind: BrowserMutationKind, input: Record<string, unknown>) => run(() => this.captureMutationPage(sessionId, kind, input), true),
      click: (selector: string, page: BrowserMutationPage) => run(() => this.click(sessionId, selector, page), true),
      typeText: (selector: string, text: string, page: BrowserMutationPage) => run(() => this.typeText(sessionId, selector, text, page), true),
      evaluate: (script: string, page: BrowserMutationPage) => run(() => this.evaluate(sessionId, script, page), true)
    }
  }

  assertWindowOwner(sessionId: string, owner: BrowserWindow): void {
    if (owner.isDestroyed()) throw new Error('浏览器宿主窗口已关闭。')
    const context = this.contexts.get(sessionId)
    if (context && !context.owner.isDestroyed() && context.owner !== owner) {
      throw new Error('此任务的浏览器已在另一个窗口打开，请先关闭该窗口中的浏览器面板。')
    }
  }

  async open(owner: BrowserWindow, sessionId: string, url = DEFAULT_BROWSER_URL): Promise<BrowserViewState> {
    this.assertWindowOwner(sessionId, owner)
    if (this.contexts.get(sessionId)?.owner.isDestroyed()) this.close(sessionId)
    if (!this.contexts.has(sessionId)) {
      this.contexts.set(sessionId, { id: sessionId, epoch: randomUUID(), owner, tabs: [], selectionRevision: 0, revision: 0,
        visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, identityKey: this.currentIdentity(sessionId) })
      if (!this.observedOwners.has(owner)) {
        this.observedOwners.add(owner)
        owner.once('closed', () => this.closeOwned(owner))
        owner.webContents.once('destroyed', () => this.closeOwned(owner))
        owner.webContents.on('did-start-navigation', details => { if (details.isMainFrame) this.closeOwned(owner) })
      }
    }
    this.setVisible(sessionId, true, owner)
    const existing = this.records.get(sessionId)
    if (existing && !existing.owner.isDestroyed() && !existing.view.webContents.isDestroyed()) {
      if (existing.owner !== owner) throw new Error('此任务的浏览器已在另一个窗口打开，请先关闭该窗口中的浏览器面板。')
      if (url && url !== DEFAULT_BROWSER_URL) await this.navigate(sessionId, url)
      return this.projectState(existing)
    }
    if (existing) this.removeTab(existing)
    const tabs = await this.createTab(sessionId, { url, activate: true })
    return tabs.tabs.find(tab => tab.tabId === tabs.activeTabId)!
  }

  async createTab(sessionId: string, options: { url?: string; activate?: boolean; contextEpoch?: string } = {}): Promise<BrowserTabsSnapshot> {
    const context = this.requireContext(sessionId), owner = context.owner
    if (options.contextEpoch && options.contextEpoch !== context.epoch) throw new Error('浏览器工作区已重建，请刷新。')
    if (context.tabs.length >= 20) throw new Error('每个浏览器工作区最多打开20个标签，请先关闭不需要的页面。')
    const url = normalizeBrowserNavigationUrl(options.url ?? DEFAULT_BROWSER_URL)
    browserManagement().assertNavigation(url)

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: `persist:caogen-browser-${safePartitionId(sessionId)}`
      }
    })
    // Keep the native view invisible until the React BrowserPanel reports its viewport bounds.
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    owner.contentView.addChildView(view)

    const record: BrowserRecord = {
      tabId: randomUUID(),
      viewId: randomUUID(),
      sessionId,
      view,
      owner,
      consoleErrors: [],
      networkFailures: [],
      navigationRevision: 0,
      state: {
        sessionId,
        scopeKind: sessionId.startsWith('workspace-browser:') ? 'workspace' : 'task',
        url: DEFAULT_BROWSER_URL,
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false
      }
    }
    context.tabs.push(record)
    if (options.activate !== false || !this.records.has(sessionId)) {
      const previous = this.records.get(sessionId)
      if (previous) { void browserStyleController.invalidateTab(previous.tabId); browserDebugController.invalidateTab(previous.tabId) }
      this.records.set(sessionId, record); context.selectionRevision++
    }
    try { this.wireRecord(record) } catch (error) { this.removeTab(record); throw error }
    this.layoutContext(context)
    this.publishTabs(context)

    try {
      await view.webContents.loadURL(url)
      if (this.contexts.get(sessionId) !== context || !context.tabs.includes(record)) throw new Error('浏览器标签已关闭。')
      this.refreshState(record)
      this.publishState(record)
    } catch (error) {
      if (this.contexts.get(sessionId) === context && context.tabs.includes(record)) this.publishState(record)
      throw error
    }
    return this.getTabs(sessionId)
  }

  selectTab(target: BrowserTabTarget): BrowserTabsSnapshot {
    const record = this.assertTarget(target, false), context = this.requireContext(target.contextId)
    if (this.records.get(context.id) !== record) {
      const previous = this.records.get(context.id)
      if (previous) { void browserStyleController.invalidateTab(previous.tabId); browserDebugController.invalidateTab(previous.tabId) }
      this.records.set(context.id, record); context.selectionRevision++
      this.layoutContext(context); this.publishState(record)
    }
    return this.getTabs(context.id)
  }
  closeTab(target: BrowserTabTarget): BrowserTabsSnapshot {
    const record = this.assertTarget(target, false), context = this.requireContext(target.contextId)
    this.removeTab(record)
    this.layoutContext(context); this.publishTabs(context)
    const active = this.records.get(context.id)
    if (active) this.emit({ kind: 'state', sessionId: context.id, state: this.projectState(active) })
    return this.getTabs(context.id)
  }
  setVisible(sessionId: string, visible: boolean, owner?: BrowserWindow): void {
    const context = this.contexts.get(sessionId)
    if (!context || (owner && context.owner !== owner)) return
    if (visible) for (const other of this.contexts.values()) if (other !== context && other.owner === context.owner) {
      other.visible = false
      for (const tab of other.tabs) { void browserStyleController.invalidateTab(tab.tabId); browserDebugController.invalidateTab(tab.tabId) }
      this.layoutContext(other)
    }
    if (!visible) for (const tab of context.tabs) { void browserStyleController.invalidateTab(tab.tabId); browserDebugController.invalidateTab(tab.tabId) }
    context.visible = visible; this.layoutContext(context)
  }

  async navigate(sessionId: string, rawUrl: string): Promise<BrowserViewState> {
    const target = this.target(sessionId), record = this.assertTarget(target)
    const url = normalizeBrowserNavigationUrl(rawUrl)
    browserManagement().assertNavigation(url)
    await record.view.webContents.loadURL(url)
    this.assertTarget(target)
    this.refreshState(record)
    return this.projectState(record)
  }

  async captureMutationPage(sessionId: string, kind: BrowserMutationKind = 'browser_evaluate', input: Record<string, unknown> = {}): Promise<BrowserMutationPage> {
    const target = this.target(sessionId)
    const record = this.requireRecord(sessionId)
    const wc = record.view.webContents
    if (wc.isLoadingMainFrame()) throw new Error('页面仍在加载，请完成后重新审批浏览器操作。')
    const revision = record.navigationRevision, url = wc.getURL()
    const captured = await wc.executeJavaScriptInIsolatedWorld(MUTATION_WORLD_ID, [{ code: `(() => {
      const key = ${JSON.stringify(DOCUMENT_TOKEN_KEY)};
      if (!Object.prototype.hasOwnProperty.call(globalThis, key)) Object.defineProperty(globalThis, key, { value: ${JSON.stringify(randomUUID())} });
      ${mutationTargetRuntimeScript()}
      return { documentToken: globalThis[key], ...globalThis[${JSON.stringify(ACTION_TARGET_KEY)}].capture(${JSON.stringify(kind)}, ${JSON.stringify(input.selector ?? null)}) };
    })()` }])
    const token = captured?.documentToken
    if (this.records.get(sessionId) !== record || wc.isDestroyed() || wc.isLoadingMainFrame() || wc.getURL() !== url ||
      record.navigationRevision !== revision || typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token) ||
      typeof captured?.nodeToken !== 'string' || !Number.isSafeInteger(captured?.version) || captured.version < 1 || typeof captured?.snapshot !== 'string') {
      throw new Error('读取审批目标时浏览器页面已变化，请重新审批。')
    }
    this.assertTarget(target, true, true)
    return { embedded: target, viewId: record.viewId, navigationRevision: revision, urlDigest: urlDigest(url), documentToken: token,
      actionTarget: { kind, nodeToken: captured.nodeToken, version: captured.version, stateDigest: urlDigest(captured.snapshot) } }
  }

  async click(sessionId: string, selector: string, approvedPage: BrowserMutationPage): Promise<void> {
    const guard = mutationTargetCheckScript('browser_click', selector, approvedPage.actionTarget)
    await this.executeApprovedMutation(sessionId, clickSelectorScript(selector, guard), approvedPage, 'browser_click', selector)
  }

  async typeText(sessionId: string, selector: string, text: string, approvedPage: BrowserMutationPage): Promise<void> {
    const guard = mutationTargetCheckScript('browser_type', selector, approvedPage.actionTarget)
    await this.executeApprovedMutation(sessionId, typeTextScript(selector, text, guard), approvedPage, 'browser_type', selector)
  }

  async screenshot(sessionId: string, selector?: string): Promise<string | undefined> {
    const target = this.target(sessionId), record = this.assertTarget(target)
    const cropBox = selector
      ? normalizeCropBox(await record.view.webContents.executeJavaScript(selectorBoundsScript(selector), true))
      : undefined
    this.assertTarget(target, true, true)
    const path = await captureAnnotationScreenshot(record, `browser-tool-${randomUUID()}`, cropBox)
    this.assertTarget(target, true, true)
    return path
  }

  async waitFor(sessionId: string, selector: string, timeoutMs: number): Promise<void> {
    const target = this.target(sessionId), record = this.assertTarget(target)
    await record.view.webContents.executeJavaScript(waitForSelectorScript(selector, timeoutMs), true)
    this.assertTarget(target, true, true)
  }

  async evaluate(sessionId: string, script: string, approvedPage: BrowserMutationPage): Promise<unknown> {
    return this.executeApprovedMutation(sessionId, script, approvedPage, 'browser_evaluate')
  }

  async validateApprovedPage(sessionId: string, approvedPage: BrowserMutationPage): Promise<void> {
    await this.executeApprovedMutation(sessionId, 'true', approvedPage, 'browser_evaluate')
    if (!approvedPage.embedded) throw new Error('调试必须绑定内置浏览器标签。')
    this.assertTarget(approvedPage.embedded, true, true)
  }

  private async executeApprovedMutation(sessionId: string, script: string, approvedPage: BrowserMutationPage, kind: BrowserMutationKind, selector?: string): Promise<unknown> {
    if (!approvedPage?.embedded || approvedPage.embedded.contextId !== sessionId) throw new Error('浏览器操作缺少已审批的标签版本；请重新审批。')
    this.assertTarget(approvedPage.embedded, true, true)
    const record = this.requireRecord(sessionId)
    const wc = record.view.webContents
    const url = wc.getURL()
    if (!approvedPage || typeof approvedPage.documentToken !== 'string' || !/^[a-f0-9-]{36}$/.test(approvedPage.documentToken) ||
      approvedPage.viewId !== record.viewId || approvedPage.navigationRevision !== record.navigationRevision ||
      approvedPage.urlDigest !== urlDigest(url) || wc.isLoadingMainFrame()) throw new Error('浏览器页面已变化，原审批失效；请重新查看并审批。')
    if (approvedPage.actionTarget?.kind !== kind || !/^[a-f0-9]{64}$/.test(approvedPage.actionTarget.stateDigest)) {
      throw new Error('浏览器操作缺少已审批的目标或表单版本，请重新审批。')
    }
    // The document token is isolated from page-authored JS. Check it in the
    // same script that performs the action, closing the navigation race after
    // the main-process check, including replacement at the very same URL.
    return wc.executeJavaScriptInIsolatedWorld(MUTATION_WORLD_ID, [{ code: `(() => {
      if (globalThis[${JSON.stringify(DOCUMENT_TOKEN_KEY)}] !== ${JSON.stringify(approvedPage.documentToken)} || location.href !== ${JSON.stringify(url)}) {
        throw new Error('浏览器页面已变化，原审批失效；请重新查看并审批。');
      }
      ${mutationTargetCheckScript(kind, selector, approvedPage.actionTarget)}
      return (0, eval)(${JSON.stringify(script)});
    })()` }], true)
  }

  async readPage(sessionId: string): Promise<BrowserPageSource> {
    const target = this.target(sessionId), record = this.assertTarget(target)
    const wc = record.view.webContents
    const result = await readBrowserPageSource({
      getURL: () => wc.getURL(), getTitle: () => wc.getTitle(), isLoading: () => wc.isLoadingMainFrame(),
      getDocumentRevision: () => record.navigationRevision,
      executeJavaScriptInIsolatedWorld: (worldId, scripts) => wc.executeJavaScriptInIsolatedWorld(worldId, scripts)
    })
    this.assertTarget(target, true, true)
    return result
  }

  async searchPage(sessionId: string, query: string, signal: AbortSignal): Promise<SearchAdapterResult> {
    const target = this.target(sessionId), record = this.assertTarget(target), key = record.tabId
    if (this.activeSearches.has(key)) throw new Error('BROWSER_SEARCH_BUSY')
    this.activeSearches.add(key)
    const wc = record.view.webContents
    let pendingUrl = ''
    const trackNavigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (details.isMainFrame) pendingUrl = details.url
    }
    wc.on('did-start-navigation', trackNavigation)
    try {
      const result = await searchBrowserPage({
        getURL: () => wc.getURL(), getTitle: () => wc.getTitle(), isLoading: () => wc.isLoadingMainFrame(),
        getDocumentRevision: () => record.navigationRevision,
        executeJavaScriptInIsolatedWorld: (worldId, scripts) => wc.executeJavaScriptInIsolatedWorld(worldId, scripts),
        navigate: url => { this.assertTarget(target); browserManagement().assertNavigation(url); return wc.loadURL(url) },
        // A user navigation may supersede this query. Cancel only the load
        // still owned by this search, never the user's replacement page.
        stopOwnedNavigation: () => { if (!wc.isDestroyed() && isBrowserSearchPage(pendingUrl, query)) wc.stop() }
      }, query, signal)
      this.assertTarget(target)
      return result
    } finally {
      wc.removeListener('did-start-navigation', trackNavigation)
      this.activeSearches.delete(key)
    }
  }

  async goBack(sessionId: string): Promise<BrowserViewState> {
    const record = this.requireRecord(sessionId)
    if (record.view.webContents.navigationHistory.canGoBack()) {
      record.view.webContents.navigationHistory.goBack()
    }
    this.refreshState(record)
    return this.projectState(record)
  }

  async goForward(sessionId: string): Promise<BrowserViewState> {
    const record = this.requireRecord(sessionId)
    if (record.view.webContents.navigationHistory.canGoForward()) {
      record.view.webContents.navigationHistory.goForward()
    }
    this.refreshState(record)
    return this.projectState(record)
  }

  async reload(sessionId: string): Promise<BrowserViewState> {
    const record = this.requireRecord(sessionId)
    record.view.webContents.reload()
    this.refreshState(record)
    return this.projectState(record)
  }

  setBounds(sessionId: string, bounds: BrowserBounds, owner?: BrowserWindow): void {
    const context = this.contexts.get(sessionId)
    if (!context || (owner && context.owner !== owner)) return
    context.bounds = normalizeBounds(bounds); this.layoutContext(context)
  }

  close(sessionId: string, owner?: BrowserWindow): void {
    const context = this.contexts.get(sessionId)
    if (!context || (owner && context.owner !== owner)) return
    for (const record of [...context.tabs]) this.removeTab(record)
    this.emit({ kind: 'closed', sessionId })
    this.contexts.delete(sessionId)
    this.records.delete(sessionId)
    for (const [id, pick] of this.picks) if (pick.target.contextId === sessionId) this.picks.delete(id)
  }

  async captureAnnotation(sessionId: string, note: string): Promise<BrowserAnnotation> {
    const target = this.target(sessionId), record = this.assertTarget(target)
    const selection = await record.view.webContents.executeJavaScript(selectionScript(), true)
    const payload = normalizeSelectionPayload(selection)
    const annotationId = randomUUID()
    const screenshotPath = await captureAnnotationScreenshot(record, annotationId).catch(() => undefined)
    this.assertTarget(target, true, true)
    const annotationInput: BrowserAnnotationInput = {
      id: annotationId,
      sessionId,
      tabId: record.tabId, contextEpoch: target.contextEpoch, navigationRevision: target.navigationRevision,
      url: payload.url || record.state.url,
      title: payload.title || record.state.title,
      selector: payload.selector,
      boundingBox: payload.boundingBox,
      screenshotPath,
      note: note.trim() || payload.text || '网页批注',
      consoleErrors: record.consoleErrors,
      viewport: payload.viewport
    }
    const annotation = await saveAnnotation(annotationsRoot(), annotationInput)
    this.assertTarget(target, true, true)
    await this.injectHighlight(record, annotation).catch(() => undefined)
    this.emit({ kind: 'annotation', sessionId, annotation })
    return annotation
  }

  async listAnnotations(sessionId: string): Promise<BrowserAnnotation[]> {
    return listAnnotations(annotationsRoot(), sessionId)
  }

  /**
   * DOM 圈选:向页面注入一次性拾取器。用户悬停高亮、点击选定元素,
   * Esc 取消。返回被选元素的 selector/文本/矩形;随后可用
   * captureElementAnnotation 截图落批注。
   */
  async pickElement(sessionId: string): Promise<BrowserPickResult> {
    const target = this.target(sessionId), record = this.assertTarget(target)
    const result = await record.view.webContents.executeJavaScript(pickElementScript(), true)
    const payload = (result && typeof result === 'object' ? result : {}) as BrowserPickResult
    this.assertTarget(target, true, true)
    const value: BrowserPickResult = {
      cancelled: Boolean(payload.cancelled),
      url: payload.url || record.state.url,
      title: payload.title || record.state.title,
      selector: payload.selector,
      text: typeof payload.text === 'string' ? payload.text.slice(0, 400) : undefined,
      boundingBox: payload.boundingBox,
      viewport: payload.viewport
    }
    for (const [id, pick] of this.picks) if (pick.expiresAt < Date.now()) this.picks.delete(id)
    const pickId = randomUUID()
    this.picks.set(pickId, { target, value, expiresAt: Date.now() + 5 * 60_000 })
    return { ...value, pickId } as BrowserPickResult
  }

  /**
   * 圈选批注:按 pickElement 的结果截图(裁剪到元素区域,带 24px 上下文边距),
   * 存为批注。与 captureAnnotation(选区)并存 —— 一个针对文字选区,一个针对元素。
   */
  async captureElementAnnotation(
    sessionId: string,
    pick: BrowserPickResult,
    note: string
  ): Promise<BrowserAnnotation> {
    const pickId = (pick as BrowserPickResult & { pickId?: string }).pickId
    const saved = pickId && this.picks.get(pickId)
    if (!saved || saved.expiresAt < Date.now() || saved.target.contextId !== sessionId) throw new Error('元素圈选已过期，请在原标签重新选择。')
    const { target } = saved
    const record = this.assertTarget(target, true, true)
    pick = saved.value
    const annotationId = randomUUID()
    const screenshotPath = await captureAnnotationScreenshot(record, annotationId, pick.boundingBox).catch(
      () => undefined
    )
    const annotationInput: BrowserAnnotationInput = {
      id: annotationId,
      sessionId,
      tabId: record.tabId, contextEpoch: target.contextEpoch, navigationRevision: target.navigationRevision,
      url: pick.url || record.state.url,
      title: pick.title || record.state.title,
      selector: pick.selector,
      boundingBox: pick.boundingBox,
      screenshotPath,
      note: note.trim() || pick.text || 'DOM 圈选批注',
      consoleErrors: record.consoleErrors,
      viewport: pick.viewport
    }
    this.assertTarget(target, true, true)
    const annotation = await saveAnnotation(annotationsRoot(), annotationInput)
    this.assertTarget(target, true, true)
    if (pickId) this.picks.delete(pickId)
    await this.injectHighlight(record, annotation).catch(() => undefined)
    this.emit({ kind: 'annotation', sessionId, annotation })
    return annotation
  }

  /**
   * Agent 只读观测:当前页面 URL/标题/选中文本摘要 + 控制台错误 + 网络失败。
   * 只读 —— 不注入、不点击、不改页面;供 Agent 复验修复效果。
   */
  async observe(sessionId: string): Promise<BrowserObservation> {
    const target = this.target(sessionId), record = this.assertTarget(target)
    let pageText = ''
    try {
      pageText = await record.view.webContents.executeJavaScript(
        `(() => (document.body ? document.body.innerText : '').slice(0, 4000))()`,
        true
      )
    } catch {
      // 页面可能禁 JS 执行;观测退化为元数据
    }
    this.assertTarget(target, true, true)
    return {
      sessionId,
      url: record.state.url,
      title: record.state.title,
      loading: record.state.loading,
      pageTextSnippet: typeof pageText === 'string' ? pageText : '',
      consoleErrors: record.consoleErrors.slice(-30),
      networkFailures: record.networkFailures.slice(-30)
    }
  }

  private wireRecord(record: BrowserRecord): void {
    const wc = record.view.webContents
    const managed: ManagedBrowserTab = {
      contextId: record.sessionId, tabId: record.tabId, owner: record.owner, contents: wc,
      target: () => { const context = this.requireContext(record.sessionId); return { contextId: record.sessionId, contextEpoch: context.epoch,
        tabId: record.tabId, selectionRevision: context.selectionRevision, navigationRevision: record.navigationRevision } },
      isCurrent: (target, page) => { try { const context = this.requireContext(record.sessionId); return context.epoch === target.contextEpoch && context.tabs.includes(record) &&
        !wc.isDestroyed() && (!page || context.selectionRevision === target.selectionRevision && record.navigationRevision === target.navigationRevision) } catch { return false } },
      error: message => this.emit({ kind: 'error', sessionId: record.sessionId, message })
    }
    record.management = managed
    browserManagement().attach(managed)
    const recordHistory = (): void => { try { if (!wc.isDestroyed()) browserManagement().recordVisit(managed) } catch (error) { managed.error(error instanceof Error ? error.message : String(error)) } }
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame) {
        void browserStyleController.invalidateTab(record.tabId)
        browserDebugController.invalidateTab(record.tabId)
        record.navigationRevision += 1
      }
    })
    wc.setWindowOpenHandler(({ url, disposition, postBody }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        const context = this.contexts.get(record.sessionId)
        if (context?.tabs.includes(record) && !postBody) void this.createTab(record.sessionId, {
          url, contextEpoch: context.epoch, activate: this.records.get(record.sessionId) === record && disposition !== 'background-tab'
        }).catch(error => this.emit({ kind: 'error', sessionId: record.sessionId, message: error instanceof Error ? error.message : String(error) }))
      }
      return { action: 'deny' }
    })
    wc.on('did-start-loading', () => {
      record.state = { ...record.state, loading: true }
      this.publishState(record)
    })
    wc.on('did-stop-loading', () => {
      this.refreshState(record)
      this.publishState(record)
    })
    wc.on('page-title-updated', (_event, title) => {
      record.state = { ...record.state, title }
      this.publishState(record)
      try { browserManagement().updateTitle(managed) } catch { /* History errors must not interrupt native events. */ }
    })
    wc.on('did-navigate', (_event, _url, responseCode) => {
      this.refreshState(record)
      this.publishState(record)
      if (responseCode === undefined || responseCode < 400) recordHistory()
      void this.replayHighlights(record)
    })
    wc.on('did-navigate-in-page', () => {
      this.refreshState(record)
      this.publishState(record)
      recordHistory()
    })
    wc.on('console-message', (_event, level, message) => {
      if (level < 2) return
      record.consoleErrors.push(message)
      if (record.consoleErrors.length > MAX_CONSOLE_ERRORS) {
        record.consoleErrors = record.consoleErrors.slice(-MAX_CONSOLE_ERRORS)
      }
    })
    // 网络失败观测:加载失败 + 4xx/5xx 主资源(供 Agent 只读复验)
    wc.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
      if (code === -3) return // ERR_ABORTED:导航打断,噪音
      record.networkFailures.push(`${isMainFrame ? '[main]' : '[sub]'} ${desc}(${code}) ${url}`)
      if (record.networkFailures.length > MAX_CONSOLE_ERRORS) {
        record.networkFailures = record.networkFailures.slice(-MAX_CONSOLE_ERRORS)
      }
    })
    this.registerPartition(record)
    wc.on('render-process-gone', (_event, details) => {
      browserDebugController.invalidateTab(record.tabId)
      this.emit({ kind: 'error', sessionId: record.sessionId, message: `浏览器渲染进程退出:${details.reason}` })
    })
  }

  private refreshState(record: BrowserRecord): void {
    const wc = record.view.webContents
    if (wc.isDestroyed()) return
    record.state = {
      sessionId: record.sessionId,
      scopeKind: record.sessionId.startsWith('workspace-browser:') ? 'workspace' : 'task',
      url: wc.getURL() || DEFAULT_BROWSER_URL,
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
    }
  }

  private publishState(record: BrowserRecord): void {
    const context = this.contexts.get(record.sessionId)
    if (!context?.tabs.includes(record) || context.owner.isDestroyed()) return
    try { this.requireContext(record.sessionId) } catch { this.close(record.sessionId); return }
    this.publishTabs(context)
    if (this.records.get(record.sessionId) === record) this.emit({ kind: 'state', sessionId: record.sessionId, state: this.projectState(record) })
  }

  private async replayHighlights(record: BrowserRecord): Promise<void> {
    const annotations = await this.listAnnotations(record.sessionId).catch(() => [])
    for (const annotation of annotations.filter((item) => item.url === record.state.url)) {
      const identity = annotation as BrowserAnnotation & { tabId?: string; contextEpoch?: string }
      if (identity.tabId !== record.tabId || identity.contextEpoch !== this.contexts.get(record.sessionId)?.epoch) continue
      await this.injectHighlight(record, annotation).catch(() => undefined)
    }
  }

  private async injectHighlight(record: BrowserRecord, annotation: BrowserAnnotation): Promise<void> {
    await record.view.webContents.executeJavaScript(highlightScript(annotation), true)
  }

  private requireRecord(sessionId: string): BrowserRecord {
    const record = this.records.get(sessionId)
    if (!record || record.owner.isDestroyed() || record.view.webContents.isDestroyed()) {
      throw new Error('浏览器面板尚未打开')
    }
    return record
  }

  private requireContext(sessionId: string): BrowserContext {
    const context = this.contexts.get(sessionId)
    if (!context || context.owner.isDestroyed()) throw new Error('浏览器工作区已关闭。')
    if (context.identityKey !== this.currentIdentity(sessionId)) throw new Error('浏览器任务归属已变化，请关闭后重新打开。')
    return context
  }
  private currentIdentity(sessionId: string): string | undefined {
    if (sessionId.startsWith('workspace-browser:') || !this.taskIdentity) return undefined
    const key = this.taskIdentity(sessionId)
    if (!key) throw new Error('浏览器任务已关闭或不存在。')
    return key
  }
  private projectState(record: BrowserRecord): BrowserTabState {
    const context = this.requireContext(record.sessionId)
    return { ...record.state, tabId: record.tabId, contextEpoch: context.epoch,
      selectionRevision: context.selectionRevision, navigationRevision: record.navigationRevision }
  }
  private layoutContext(context: BrowserContext): void {
    const active = this.records.get(context.id)
    for (const record of context.tabs) if (!record.view.webContents.isDestroyed()) record.view.setBounds(
      context.visible && record === active ? context.bounds : { x: 0, y: 0, width: 0, height: 0 })
  }
  private publishTabs(context: BrowserContext): void {
    if (this.contexts.get(context.id) !== context || context.owner.isDestroyed()) return
    try { this.requireContext(context.id) } catch { this.close(context.id); return }
    context.revision++
    const snapshot = this.getTabs(context.id)
    for (const listener of this.tabListeners) listener(snapshot, context.owner)
  }
  private removeTab(record: BrowserRecord): void {
    browserDebugController.invalidateTab(record.tabId)
    const context = this.contexts.get(record.sessionId)
    if (!context) return
    const index = context.tabs.indexOf(record)
    if (index < 0) return
    void browserStyleController.invalidateTab(record.tabId)
    context.tabs.splice(index, 1); context.selectionRevision++
    if (record.management) browserManagement().detach(record.management)
    if (this.records.get(context.id) === record) {
      const replacement = context.tabs[Math.min(index, context.tabs.length - 1)]
      if (replacement) this.records.set(context.id, replacement)
      else this.records.delete(context.id)
    }
    const partition = record.view.webContents.session, routes = this.partitions.get(partition)
    routes?.delete(record.view.webContents.id)
    if (routes?.size === 0) { partition.webRequest?.onCompleted(null); this.partitions.delete(partition) }
    for (const [id, pick] of this.picks) if (pick.target.tabId === record.tabId) this.picks.delete(id)
    if (!record.owner.isDestroyed()) { try { record.owner.contentView.removeChildView(record.view) } catch { /* Teardown. */ } }
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close()
  }
  private registerPartition(record: BrowserRecord): void {
    const wc = record.view.webContents, partition = wc.session
    if (!partition?.webRequest) return
    let routes = this.partitions.get(partition)
    if (!routes) {
      routes = new Map(); this.partitions.set(partition, routes)
      partition.webRequest.onCompleted({ urls: ['*://*/*'] }, details => {
        const source = details.webContentsId === undefined ? undefined : this.partitions.get(partition)?.get(details.webContentsId)
        if (!source || details.statusCode < 400) return
        source.networkFailures.push(`HTTP ${details.statusCode} ${details.method} ${details.url.slice(0, 200)}`)
        if (source.networkFailures.length > MAX_CONSOLE_ERRORS) source.networkFailures = source.networkFailures.slice(-MAX_CONSOLE_ERRORS)
      })
    }
    routes.set(wc.id, record)
  }

  private emit(event: BrowserEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function annotationsRoot(): string {
  return join(app.getPath('userData'), 'browser-annotations')
}

async function captureAnnotationScreenshot(
  record: BrowserRecord,
  annotationId: string,
  cropBox?: { x: number; y: number; width: number; height: number }
): Promise<string | undefined> {
  const bounds = record.view.getBounds()
  if (bounds.width <= 0 || bounds.height <= 0) return undefined
  let image = await record.view.webContents.capturePage()
  if (!image || image.isEmpty()) return undefined
  // 元素圈选:裁剪到元素区域 + 24px 上下文边距(clamp 到视口)
  if (cropBox && Number.isFinite(cropBox.x) && cropBox.width > 0 && cropBox.height > 0) {
    const size = image.getSize()
    const scaleX = size.width / bounds.width
    const scaleY = size.height / bounds.height
    const margin = 24
    const x = Math.max(0, Math.round((cropBox.x - margin) * scaleX))
    const y = Math.max(0, Math.round((cropBox.y - margin) * scaleY))
    const width = Math.min(size.width - x, Math.round((cropBox.width + margin * 2) * scaleX))
    const height = Math.min(size.height - y, Math.round((cropBox.height + margin * 2) * scaleY))
    if (width > 4 && height > 4) {
      try {
        image = image.crop({ x, y, width, height })
      } catch {
        // 裁剪失败退回整页截图
      }
    }
  }
  const sessionDir = join(annotationsRoot(), record.sessionId)
  await mkdir(sessionDir, { recursive: true })
  const screenshotPath = join(sessionDir, `${annotationId}.png`)
  await writeFile(screenshotPath, image.toPNG())
  return screenshotPath
}

function safePartitionId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || 'default'
}

function normalizeBounds(bounds: BrowserBounds): BrowserBounds {
  const x = Math.max(0, Math.round(bounds.x))
  const y = Math.max(0, Math.round(bounds.y))
  const width = Math.max(0, Math.round(bounds.width))
  const height = Math.max(0, Math.round(bounds.height))
  return { x, y, width, height }
}

function normalizeSelectionPayload(value: unknown): SelectionPayload {
  return value && typeof value === 'object' ? (value as SelectionPayload) : {}
}

function normalizeCropBox(value: unknown): BrowserAnnotationBoundingBox | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const x = typeof record.x === 'number' ? record.x : NaN
  const y = typeof record.y === 'number' ? record.y : NaN
  const width = typeof record.width === 'number' ? record.width : NaN
  const height = typeof record.height === 'number' ? record.height : NaN
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined
  return { x, y, width, height }
}

function selectorBoundsScript(selector: string): string {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const el = document.querySelector(selector);
    if (!el) throw new Error('selector not found: ' + selector);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const box = el.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  })()`
}


function selectionScript(): string {
  return `(() => {
    const selection = window.getSelection();
    const text = selection ? String(selection.toString()).trim() : '';
    let rect;
    let selector;
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const box = range.getBoundingClientRect();
      rect = { x: box.x, y: box.y, width: box.width, height: box.height };
      const node = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
      if (node && node instanceof Element) {
        selector = node.tagName.toLowerCase();
        if (node.id) selector += '#' + CSS.escape(node.id);
        else if (node.classList.length) selector += '.' + Array.from(node.classList).slice(0, 3).map((c) => CSS.escape(c)).join('.');
      }
    }
    return {
      url: location.href,
      title: document.title,
      text,
      selector,
      boundingBox: rect,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        deviceScaleFactor: window.devicePixelRatio || 1
      }
    };
  })()`
}

/**
 * 一次性 DOM 元素拾取器:注入覆盖层,mousemove 高亮元素、click 选定、Esc 取消。
 * 返回 Promise,选定/取消后自动清理所有注入痕迹。
 */
function pickElementScript(): string {
  return `new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #4a9eff;background:rgba(74,158,255,0.15);transition:all .05s;display:none';
    document.documentElement.appendChild(overlay);
    let current = null;
    const cssPath = (el) => {
      if (!(el instanceof Element)) return undefined;
      const parts = [];
      let node = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
        let part = node.tagName.toLowerCase();
        if (node.id) { parts.unshift(part + '#' + CSS.escape(node.id)); break; }
        const cls = Array.from(node.classList).slice(0, 2).map((c) => CSS.escape(c));
        if (cls.length) part += '.' + cls.join('.');
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    };
    const cleanup = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    };
    const onMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === overlay) return;
      current = el;
      const r = el.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.left = r.x + 'px'; overlay.style.top = r.y + 'px';
      overlay.style.width = r.width + 'px'; overlay.style.height = r.height + 'px';
    };
    const onClick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const el = current || document.elementFromPoint(e.clientX, e.clientY);
      cleanup();
      if (!el) { resolve({ cancelled: true }); return; }
      const r = el.getBoundingClientRect();
      resolve({
        cancelled: false,
        url: location.href,
        title: document.title,
        selector: cssPath(el),
        text: (el.innerText || el.textContent || '').trim().slice(0, 400),
        boundingBox: { x: r.x, y: r.y, width: r.width, height: r.height },
        viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio || 1 }
      });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve({ cancelled: true }); }
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => { cleanup(); resolve({ cancelled: true }); }, 60000);
  })`
}

function highlightScript(annotation: BrowserAnnotation): string {
  const data = JSON.stringify(annotation)
  return `(() => {
    const annotation = ${data};
    const box = annotation.boundingBox;
    if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return false;
    const id = 'caogen-annotation-' + annotation.id;
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.position = 'fixed';
      el.style.pointerEvents = 'none';
      el.style.zIndex = '2147483647';
      el.style.border = '2px solid #f2c94c';
      el.style.background = 'rgba(242, 201, 76, 0.18)';
      el.style.boxShadow = '0 0 0 9999px rgba(0,0,0,0.02)';
      document.documentElement.appendChild(el);
    }
    el.style.left = box.x + 'px';
    el.style.top = box.y + 'px';
    el.style.width = Math.max(1, box.width) + 'px';
    el.style.height = Math.max(1, box.height) + 'px';
    el.title = annotation.note || '';
    return true;
  })()`
}

export const browserViewManager = new BrowserViewManager()
