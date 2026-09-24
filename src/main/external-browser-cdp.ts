import { randomUUID, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import type { Page, Browser, CDPSession } from 'puppeteer-core'
import type { EffectTarget } from '../shared/effect-types'
import type { ExternalBrowserTab, ExternalBrowserVendor } from '../shared/external-browser-types'
import { searchBrowserPage, isBrowserSearchPage } from './browser/browser-search-page'
import { readBrowserPageSource, safeSourceText, requireSourceUrl, type BrowserPageSource } from './browser/browser-page-source'

type MutationPage = NonNullable<Extract<EffectTarget, { kind: 'unsupported' }>['browserPage']>
type MutationKind = NonNullable<MutationPage['actionTarget']>['kind']
export const EXTERNAL_BROWSER_CAPABILITIES = ['read', 'navigate', 'click', 'type', 'screenshot'] as const
interface PageRecord { id: string; page: Page; client: CDPSession; revision: number; closed: boolean; loading: boolean; isolatedContextIds: Map<string, number> }
function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }

/** Read only the explicit endpoint. Redirects and advertised remote websocket
 * URLs are rejected before Puppeteer can follow them. */
export function discoverLocalCdpEndpoint(port: number): Promise<string> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return Promise.reject(new Error('CDP 端口必须是 1024-65535。'))
  return new Promise((resolve, reject) => {
    const request = get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 5_000 }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('CDP 端口未返回浏览器连接信息。')); return }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk; if (body.length > 65_536) request.destroy(new Error('CDP 响应过大。')) })
      response.on('error', reject)
      response.on('end', () => {
        try {
          const data = JSON.parse(body), endpoint = new URL(data.webSocketDebuggerUrl)
          if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
            Number(endpoint.port) !== port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
            !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(endpoint.pathname)) throw new Error('CDP 只接受此本机端口的浏览器连接。')
          endpoint.hostname = '127.0.0.1'; resolve(endpoint.href)
        } catch { reject(new Error('CDP 只接受此本机端口的有效浏览器连接。')) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('连接 CDP 端口超时。')))
    request.on('error', reject)
  })
}

/** Connects to a browser already started by its user. Never launches a browser,
 * scans ports, reads a profile, or reads Cookies. Tab selection is explicit. */
export class ExternalBrowserCdpAdapter {
  private browser?: Browser
  private readonly pages = new Map<string, PageRecord>()
  private readonly pendingPages = new Map<Page, Promise<PageRecord>>()
  private readonly activeSearches = new Set<string>()
  private closed = false
  constructor(private readonly vendor: ExternalBrowserVendor, private readonly port: number,
    private readonly connectionId: string, private readonly onDisconnect: () => void = () => undefined) {}

  async connect(): Promise<void> {
    const endpoint = await discoverLocalCdpEndpoint(this.port)
    const puppeteer = await import('puppeteer-core')
    const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, protocolTimeout: 15_000, defaultViewport: null })
    if (this.closed) { browser.disconnect(); throw new Error('外部浏览器连接已撤销。') }
    this.browser = browser
    browser.on('disconnected', () => { this.browser = undefined; this.onDisconnect() })
  }
  disconnect(): void { this.closed = true; const browser = this.browser; this.browser = undefined; this.pages.clear(); browser?.disconnect() }
  async listTabs(selectedTabId?: string): Promise<ExternalBrowserTab[]> {
    const browser = this.requireBrowser(), pages = await browser.pages()
    const result: ExternalBrowserTab[] = []
    for (const page of pages) {
      if (page.isClosed() || !/^https?:\/\//i.test(page.url())) continue
      const record = await this.recordPage(page)
      const url = new URL(page.url()); url.username = ''; url.password = ''; url.search = ''; url.hash = ''
      result.push({ tabId: record.id, title: safeSourceText(await page.title()).slice(0, 240), url: url.href,
        active: record.id === selectedTabId, vendor: this.vendor, connectionId: this.connectionId, pageRevision: record.revision })
    }
    this.requireBrowser()
    return result
  }
  async requireTab(tabId: string): Promise<ExternalBrowserTab> {
    const tab = (await this.listTabs(tabId)).find(item => item.tabId === tabId)
    if (!tab) throw new Error('外部浏览器标签页不存在、已关闭或不是 HTTP/HTTPS 页面。')
    return tab
  }
  async readPage(tabId: string): Promise<BrowserPageSource> {
    const record = this.requirePage(tabId), title = await record.page.title()
    return readBrowserPageSource({ getURL: () => record.page.url(), getTitle: () => title,
      isLoading: () => record.closed || record.loading, getDocumentRevision: () => record.revision,
      executeJavaScriptInIsolatedWorld: (worldId, scripts) => this.isolated(record, scripts.map(item => item.code).join('\n'), `source-${worldId}`) })
  }
  async navigate(tabId: string, rawUrl: string, approved: MutationPage, assertActive?: () => void): Promise<ExternalBrowserTab> {
    const record = this.requirePage(tabId)
    await this.mutate(tabId, 'true', approved, 'browser_evaluate', undefined, assertActive)
    this.assertPageBinding(record, approved, 'browser_evaluate')
    assertActive?.()
    await record.page.goto(requireSourceUrl(rawUrl), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    return this.requireTab(tabId)
  }
  async searchPage(tabId: string, query: string, signal: AbortSignal, assertActive: () => void) {
    const record = this.requirePage(tabId)
    assertActive()
    if (this.activeSearches.has(tabId)) throw new Error('当前外部标签页已有搜索正在执行。')
    this.activeSearches.add(tabId)
    try {
      const result = await searchBrowserPage({
        getURL: () => record.page.url(), getTitle: () => '', isLoading: () => record.closed || record.loading,
        getDocumentRevision: () => record.revision,
        executeJavaScriptInIsolatedWorld: (worldId, scripts) => this.isolated(record, scripts.map(item => item.code).join('\n'), `source-${worldId}`, assertActive),
        navigate: async url => { assertActive(); if (signal.aborted) throw new Error('搜索已中断。'); return record.page.goto(url, { waitUntil: 'load', timeout: 30_000 }) },
        stopOwnedNavigation: () => { if (isBrowserSearchPage(record.page.url(), query)) void record.client.send('Page.stopLoading').catch(() => undefined) }
      }, query, signal)
      const revision = record.revision
      const assertCurrent = () => { assertActive(); if (record.revision !== revision || !isBrowserSearchPage(record.page.url(), query)) throw new Error('搜索页面已变化。') }
      assertCurrent(); return { ...result, assertCurrent }
    } finally { this.activeSearches.delete(tabId) }
  }
  async screenshot(tabId: string, selector?: string): Promise<string> {
    const record = this.requirePage(tabId)
    const target = selector ? await record.page.$(selector) : undefined
    if (selector && !target) throw new Error('截图目标元素不存在。')
    const bytes = target ? await target.screenshot({ type: 'png' }) : await record.page.screenshot({ type: 'png' })
    await target?.dispose()
    this.requirePage(tabId)
    const path = join(tmpdir(), `caogen-external-browser-${randomUUID()}.png`)
    await writeFile(path, bytes, { mode: 0o600 }); return path
  }
  async waitFor(tabId: string, selector: string, timeoutMs: number): Promise<void> {
    const { waitForSelectorScript } = await import('./browserView')
    await this.isolated(this.requirePage(tabId), waitForSelectorScript(selector, timeoutMs))
  }
  async captureMutationPage(tabId: string, kind: MutationKind, input: Record<string, unknown>): Promise<MutationPage> {
    const { mutationTargetRuntimeScript } = await import('./browserView')
    const record = this.requirePage(tabId), revision = record.revision, url = record.page.url()
    if (record.loading) throw new Error('页面仍在加载，请稍后重新审批。')
    const value = await this.isolated(record, `(() => {
      const key = '__caogenApprovedDocumentV1';
      if (!Object.prototype.hasOwnProperty.call(globalThis, key)) Object.defineProperty(globalThis, key, { value: ${JSON.stringify(randomUUID())} });
      ${mutationTargetRuntimeScript()}
      return { documentToken: globalThis[key], ...globalThis.__caogenApprovedActionTargetV1.capture(${JSON.stringify(kind)}, ${JSON.stringify(input.selector ?? null)}) };
    })()`)
    const captured = value as Record<string, unknown>
    if (record !== this.requirePage(tabId) || revision !== record.revision || record.loading || url !== record.page.url() ||
      !captured || typeof captured.documentToken !== 'string' || typeof captured.nodeToken !== 'string' ||
      !Number.isSafeInteger(captured.version) || typeof captured.snapshot !== 'string') throw new Error('读取审批目标时外部浏览器页面已变化，请重新审批。')
    return { viewId: this.connectionId, navigationRevision: revision, urlDigest: digest(url), documentToken: captured.documentToken,
      external: { connectionId: this.connectionId, tabId, pageRevision: revision },
      actionTarget: { kind, nodeToken: captured.nodeToken, version: Number(captured.version), stateDigest: digest(captured.snapshot) } }
  }
  async click(tabId: string, selector: string, approved: MutationPage, assertActive?: () => void): Promise<void> {
    const { clickSelectorScript, mutationTargetCheckScript } = await import('./browserView')
    await this.mutate(tabId, clickSelectorScript(selector, mutationTargetCheckScript('browser_click', selector, approved.actionTarget)), approved, 'browser_click', selector, assertActive)
  }
  async typeText(tabId: string, selector: string, text: string, approved: MutationPage, assertActive?: () => void): Promise<void> {
    const { typeTextScript, mutationTargetCheckScript } = await import('./browserView')
    await this.mutate(tabId, typeTextScript(selector, text, mutationTargetCheckScript('browser_type', selector, approved.actionTarget)), approved, 'browser_type', selector, assertActive)
  }
  async evaluate(tabId: string, script: string, approved: MutationPage, assertActive?: () => void): Promise<unknown> {
    return this.mutate(tabId, script, approved, 'browser_evaluate', undefined, assertActive)
  }
  private async mutate(tabId: string, script: string, approved: MutationPage, kind: MutationKind, selector?: string, assertActive?: () => void): Promise<unknown> {
    const { mutationTargetCheckScript } = await import('./browserView')
    const record = this.requirePage(tabId), url = record.page.url()
    this.assertPageBinding(record, approved, kind)
    return this.isolated(record, `(() => {
      if (globalThis.__caogenApprovedDocumentV1 !== ${JSON.stringify(approved.documentToken)} || location.href !== ${JSON.stringify(url)}) throw new Error('外部浏览器页面已变化，原审批失效。');
      ${mutationTargetCheckScript(kind, selector, approved.actionTarget)}
      return (0, eval)(${JSON.stringify(script)});
    })()`, 'mutation', assertActive)
  }
  private assertPageBinding(record: PageRecord, approved: MutationPage, kind: MutationKind): void {
    const tabId = record.id, url = record.page.url()
    if (record.loading) throw new Error('页面正在加载，原审批失效。')
    if (!approved.external || approved.external.connectionId !== this.connectionId || approved.external.tabId !== tabId ||
      approved.external.pageRevision !== record.revision || approved.viewId !== this.connectionId ||
      approved.navigationRevision !== record.revision || approved.urlDigest !== digest(url) || approved.actionTarget?.kind !== kind ||
      !/^[a-f0-9]{64}$/.test(approved.actionTarget.stateDigest)) throw new Error('外部浏览器页面已变化，原审批失效；请重新查看并审批。')
  }
  private async recordPage(page: Page): Promise<PageRecord> {
    const existing = [...this.pages.values()].find(record => record.page === page)
    if (existing) return existing
    const pending = this.pendingPages.get(page)
    if (pending) return pending
    const promise = (async () => {
      const client = await page.createCDPSession()
      const { targetInfo } = await client.send('Target.getTargetInfo')
      const record: PageRecord = { id: targetInfo.targetId, page, client, revision: 1, closed: false, loading: false, isolatedContextIds: new Map() }
      const { frameTree } = await client.send('Page.getFrameTree')
      client.on('Page.frameStartedLoading', event => { if (event.frameId === frameTree.frame.id) record.loading = true })
      client.on('Page.frameStoppedLoading', event => { if (event.frameId === frameTree.frame.id) record.loading = false })
      await client.send('Page.enable')
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) { record.revision++; record.isolatedContextIds.clear() } })
      page.once('close', () => { record.closed = true; this.pages.delete(record.id) })
      this.requireBrowser(); this.pages.set(record.id, record); return record
    })()
    this.pendingPages.set(page, promise)
    try { return await promise } finally { this.pendingPages.delete(page) }
  }
  private async isolated(record: PageRecord, expression: string, world = 'mutation', assertActive?: () => void): Promise<unknown> {
    this.requirePage(record.id)
    const ensureContext = async (): Promise<number> => {
      const existing = record.isolatedContextIds.get(world)
      if (existing) return existing
      const { frameTree } = await record.client.send('Page.getFrameTree')
      const created = await record.client.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: `caogen-external-${world}`, grantUniveralAccess: false })
      record.isolatedContextIds.set(world, created.executionContextId)
      return created.executionContextId
    }
    const contextId = await ensureContext()
    this.requirePage(record.id)
    assertActive?.()
    // Never retry Runtime.evaluate: a lost reply can follow a successful click.
    const result = await record.client.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true, userGesture: world === 'mutation' }).catch(error => {
      record.isolatedContextIds.delete(world)
      throw error
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    this.requirePage(record.id)
    return result.result.value
  }
  private requirePage(tabId: string): PageRecord {
    this.requireBrowser()
    const record = this.pages.get(tabId)
    if (!record || record.closed || record.page.isClosed()) throw new Error('外部浏览器标签页已关闭；未重放操作。')
    requireSourceUrl(record.page.url())
    return record
  }
  private requireBrowser(): Browser {
    if (!this.browser || this.closed) throw new Error('外部浏览器连接已断开；请核对页面实际结果后重试。')
    return this.browser
  }
}
