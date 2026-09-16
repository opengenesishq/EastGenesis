import { app, BrowserWindow, WebContentsView, shell } from 'electron'
import { randomUUID } from 'node:crypto'
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
import { DEFAULT_BROWSER_URL, normalizeBrowserNavigationUrl } from './browserNavigation'
import { readBrowserPageSource, type BrowserPageSource } from './browser/browser-page-source'
import { isBrowserSearchPage, searchBrowserPage } from './browser/browser-search-page'
import type { SearchAdapterResult } from './search/search-broker'

interface BrowserRecord {
  sessionId: string
  view: WebContentsView
  owner: BrowserWindow
  consoleErrors: string[]
  /** 最近的网络失败(status>=400 或加载失败),供批注/只读观测 */
  networkFailures: string[]
  navigationRevision: number
  state: BrowserViewState
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
  private readonly listeners = new Set<Listener>()
  private readonly activeSearches = new Set<string>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(sessionId: string): BrowserViewState | undefined {
    const record = this.records.get(sessionId)
    if (!record || record.owner.isDestroyed() || record.view.webContents.isDestroyed()) return undefined
    return { ...record.state }
  }

  async open(owner: BrowserWindow, sessionId: string, url = DEFAULT_BROWSER_URL): Promise<BrowserViewState> {
    const existing = this.records.get(sessionId)
    if (existing && !existing.owner.isDestroyed() && !existing.view.webContents.isDestroyed()) {
      if (url && url !== DEFAULT_BROWSER_URL) await this.navigate(sessionId, url)
      return { ...existing.state }
    }
    if (existing) this.close(sessionId)

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
      sessionId,
      view,
      owner,
      consoleErrors: [],
      networkFailures: [],
      navigationRevision: 0,
      state: {
        sessionId,
        url: DEFAULT_BROWSER_URL,
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false
      }
    }
    this.records.set(sessionId, record)
    this.wireRecord(record)
    owner.once('closed', () => this.close(sessionId))

    if (url && url !== DEFAULT_BROWSER_URL) {
      await this.navigate(sessionId, url)
    } else {
      await view.webContents.loadURL(DEFAULT_BROWSER_URL).catch(() => undefined)
      this.refreshState(record)
    }
    return { ...record.state }
  }

  async navigate(sessionId: string, rawUrl: string): Promise<BrowserViewState> {
    const record = this.requireRecord(sessionId)
    const url = normalizeBrowserNavigationUrl(rawUrl)
    await record.view.webContents.loadURL(url)
    this.refreshState(record)
    return { ...record.state }
  }

  async click(sessionId: string, selector: string): Promise<void> {
    const record = this.requireRecord(sessionId)
    await record.view.webContents.executeJavaScript(clickSelectorScript(selector), true)
  }

  async typeText(sessionId: string, selector: string, text: string): Promise<void> {
    const record = this.requireRecord(sessionId)
    await record.view.webContents.executeJavaScript(typeTextScript(selector, text), true)
  }

  async screenshot(sessionId: string, selector?: string): Promise<string | undefined> {
    const record = this.requireRecord(sessionId)
    const cropBox = selector
      ? normalizeCropBox(await record.view.webContents.executeJavaScript(selectorBoundsScript(selector), true))
      : undefined
    return captureAnnotationScreenshot(record, `browser-tool-${randomUUID()}`, cropBox)
  }

  async waitFor(sessionId: string, selector: string, timeoutMs: number): Promise<void> {
    const record = this.requireRecord(sessionId)
    await record.view.webContents.executeJavaScript(waitForSelectorScript(selector, timeoutMs), true)
  }

  async evaluate(sessionId: string, script: string): Promise<unknown> {
    const record = this.requireRecord(sessionId)
    return record.view.webContents.executeJavaScript(script, true)
  }

  async readPage(sessionId: string): Promise<BrowserPageSource> {
    const record = this.requireRecord(sessionId)
    const wc = record.view.webContents
    return readBrowserPageSource({
      getURL: () => wc.getURL(), getTitle: () => wc.getTitle(), isLoading: () => wc.isLoadingMainFrame(),
      getDocumentRevision: () => record.navigationRevision,
      executeJavaScriptInIsolatedWorld: (worldId, scripts) => wc.executeJavaScriptInIsolatedWorld(worldId, scripts)
    })
  }

  async searchPage(sessionId: string, query: string, signal: AbortSignal): Promise<SearchAdapterResult> {
    const record = this.requireRecord(sessionId)
    if (this.activeSearches.has(sessionId)) throw new Error('BROWSER_SEARCH_BUSY')
    this.activeSearches.add(sessionId)
    const wc = record.view.webContents
    let pendingUrl = ''
    const trackNavigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (details.isMainFrame) pendingUrl = details.url
    }
    wc.on('did-start-navigation', trackNavigation)
    try {
      return await searchBrowserPage({
        getURL: () => wc.getURL(), getTitle: () => wc.getTitle(), isLoading: () => wc.isLoadingMainFrame(),
        getDocumentRevision: () => record.navigationRevision,
        executeJavaScriptInIsolatedWorld: (worldId, scripts) => wc.executeJavaScriptInIsolatedWorld(worldId, scripts),
        navigate: url => wc.loadURL(url),
        // A user navigation may supersede this query. Cancel only the load
        // still owned by this search, never the user's replacement page.
        stopOwnedNavigation: () => { if (!wc.isDestroyed() && isBrowserSearchPage(pendingUrl, query)) wc.stop() }
      }, query, signal)
    } finally {
      wc.removeListener('did-start-navigation', trackNavigation)
      this.activeSearches.delete(sessionId)
    }
  }

  async goBack(sessionId: string): Promise<BrowserViewState> {
    const record = this.requireRecord(sessionId)
    if (record.view.webContents.navigationHistory.canGoBack()) {
      record.view.webContents.navigationHistory.goBack()
    }
    this.refreshState(record)
    return { ...record.state }
  }

  async goForward(sessionId: string): Promise<BrowserViewState> {
    const record = this.requireRecord(sessionId)
    if (record.view.webContents.navigationHistory.canGoForward()) {
      record.view.webContents.navigationHistory.goForward()
    }
    this.refreshState(record)
    return { ...record.state }
  }

  async reload(sessionId: string): Promise<BrowserViewState> {
    const record = this.requireRecord(sessionId)
    record.view.webContents.reload()
    this.refreshState(record)
    return { ...record.state }
  }

  setBounds(sessionId: string, bounds: BrowserBounds): void {
    const record = this.requireRecord(sessionId)
    record.view.setBounds(normalizeBounds(bounds))
  }

  close(sessionId: string): void {
    const record = this.records.get(sessionId)
    if (!record) return
    this.records.delete(sessionId)
    if (!record.owner.isDestroyed()) {
      try {
        record.owner.contentView.removeChildView(record.view)
      } catch {
        // View may already be detached during window teardown.
      }
    }
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close()
    this.emit({ kind: 'closed', sessionId })
  }

  async captureAnnotation(sessionId: string, note: string): Promise<BrowserAnnotation> {
    const record = this.requireRecord(sessionId)
    const selection = await record.view.webContents.executeJavaScript(selectionScript(), true)
    const payload = normalizeSelectionPayload(selection)
    const annotationId = randomUUID()
    const screenshotPath = await captureAnnotationScreenshot(record, annotationId).catch(() => undefined)
    const annotationInput: BrowserAnnotationInput = {
      id: annotationId,
      sessionId,
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
    const record = this.requireRecord(sessionId)
    const result = await record.view.webContents.executeJavaScript(pickElementScript(), true)
    const payload = (result && typeof result === 'object' ? result : {}) as BrowserPickResult
    return {
      cancelled: Boolean(payload.cancelled),
      url: payload.url || record.state.url,
      title: payload.title || record.state.title,
      selector: payload.selector,
      text: typeof payload.text === 'string' ? payload.text.slice(0, 400) : undefined,
      boundingBox: payload.boundingBox,
      viewport: payload.viewport
    }
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
    const record = this.requireRecord(sessionId)
    const annotationId = randomUUID()
    const screenshotPath = await captureAnnotationScreenshot(record, annotationId, pick.boundingBox).catch(
      () => undefined
    )
    const annotationInput: BrowserAnnotationInput = {
      id: annotationId,
      sessionId,
      url: pick.url || record.state.url,
      title: pick.title || record.state.title,
      selector: pick.selector,
      boundingBox: pick.boundingBox,
      screenshotPath,
      note: note.trim() || pick.text || 'DOM 圈选批注',
      consoleErrors: record.consoleErrors,
      viewport: pick.viewport
    }
    const annotation = await saveAnnotation(annotationsRoot(), annotationInput)
    await this.injectHighlight(record, annotation).catch(() => undefined)
    this.emit({ kind: 'annotation', sessionId, annotation })
    return annotation
  }

  /**
   * Agent 只读观测:当前页面 URL/标题/选中文本摘要 + 控制台错误 + 网络失败。
   * 只读 —— 不注入、不点击、不改页面;供 Agent 复验修复效果。
   */
  async observe(sessionId: string): Promise<BrowserObservation> {
    const record = this.requireRecord(sessionId)
    let pageText = ''
    try {
      pageText = await record.view.webContents.executeJavaScript(
        `(() => (document.body ? document.body.innerText : '').slice(0, 4000))()`,
        true
      )
    } catch {
      // 页面可能禁 JS 执行;观测退化为元数据
    }
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
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame) record.navigationRevision += 1
    })
    wc.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        void wc.loadURL(url)
      } else {
        void shell.openExternal(url).catch(() => undefined)
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
    })
    wc.on('did-navigate', () => {
      this.refreshState(record)
      this.publishState(record)
      void this.replayHighlights(record)
    })
    wc.on('did-navigate-in-page', () => {
      this.refreshState(record)
      this.publishState(record)
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
    // session 在测试 stub 里可能缺席;真 Electron 恒有。缺则退化为只记 did-fail-load。
    wc.session?.webRequest?.onCompleted({ urls: ['*://*/*'] }, (details) => {
      if (details.statusCode >= 400 && details.webContentsId === wc.id) {
        record.networkFailures.push(`HTTP ${details.statusCode} ${details.method} ${details.url.slice(0, 200)}`)
        if (record.networkFailures.length > MAX_CONSOLE_ERRORS) {
          record.networkFailures = record.networkFailures.slice(-MAX_CONSOLE_ERRORS)
        }
      }
    })
    wc.on('render-process-gone', (_event, details) => {
      this.emit({ kind: 'error', sessionId: record.sessionId, message: `浏览器渲染进程退出:${details.reason}` })
    })
  }

  private refreshState(record: BrowserRecord): void {
    const wc = record.view.webContents
    record.state = {
      sessionId: record.sessionId,
      url: wc.getURL() || DEFAULT_BROWSER_URL,
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
    }
  }

  private publishState(record: BrowserRecord): void {
    this.emit({ kind: 'state', sessionId: record.sessionId, state: { ...record.state } })
  }

  private async replayHighlights(record: BrowserRecord): Promise<void> {
    const annotations = await this.listAnnotations(record.sessionId).catch(() => [])
    for (const annotation of annotations.filter((item) => item.url === record.state.url)) {
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

function clickSelectorScript(selector: string): string {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const el = document.querySelector(selector);
    if (!el) throw new Error('selector not found: ' + selector);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof el.focus === 'function') el.focus();
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`
}

function typeTextScript(selector: string, text: string): string {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const text = ${JSON.stringify(text)};
    const el = document.querySelector(selector);
    if (!el) throw new Error('selector not found: ' + selector);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof el.focus === 'function') el.focus();
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      el.value = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    }
    throw new Error('selector is not a text input: ' + selector);
  })()`
}

function waitForSelectorScript(selector: string, timeoutMs: number): string {
  return `new Promise((resolve, reject) => {
    const selector = ${JSON.stringify(selector)};
    const timeoutMs = ${Math.max(0, Math.min(60_000, Math.round(timeoutMs)))};
    const startedAt = Date.now();
    const tick = () => {
      const el = document.querySelector(selector);
      if (el) { resolve(true); return; }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('selector timeout: ' + selector));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  })`
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
