import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile, unlink } from 'node:fs/promises'
import type { EffectTarget } from '../../shared/effect-types'
import type { ExternalBrowserTab, ExternalBrowserVendor } from '../../shared/external-browser-types'
import { readBrowserPageSource, requireSourceUrl, safeSourceText } from '../browser/browser-page-source'
import { browserExtensionBridge as bridge } from './bridge'

type MutationPage = NonNullable<Extract<EffectTarget, { kind: 'unsupported' }>['browserPage']>
type MutationKind = NonNullable<MutationPage['actionTarget']>['kind']
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export class ExternalBrowserExtensionAdapter {
  private closed = false
  constructor(private readonly vendor: ExternalBrowserVendor, private readonly id: string, private readonly onDisconnect: () => void) {}
  async connect(): Promise<void> { await bridge.wait(this.id, this.onDisconnect); this.current() }
  disconnect(): void { this.closed = true; bridge.revoke(this.id) }
  async listTabs(selectedTabId?: string): Promise<ExternalBrowserTab[]> {
    const page = this.current(), url = new URL(page.url); url.search = ''; url.hash = ''; url.username = ''; url.password = ''
    return [{ tabId: page.tabId, title: safeSourceText(page.title).slice(0, 240), url: url.href, active: selectedTabId === page.tabId,
      connectionId: this.id, vendor: this.vendor, pageRevision: page.revision }]
  }
  async requireTab(tabId: string): Promise<ExternalBrowserTab> { bridge.assert(this.id, tabId); return (await this.listTabs(tabId))[0] }
  async readPage(tabId: string) {
    const before = this.current(); bridge.assert(this.id, tabId, before.revision)
    return readBrowserPageSource({ getURL: () => this.current().url, getTitle: () => this.current().title,
      isLoading: () => this.current().loading, getDocumentRevision: () => this.current().revision,
      executeJavaScriptInIsolatedWorld: () => bridge.request(this.id, 'read', {}, before.revision) })
  }
  async captureMutationPage(tabId: string, kind: MutationKind, input: Record<string, unknown>): Promise<MutationPage> {
    const before = this.current(); bridge.assert(this.id, tabId, before.revision)
    if (before.loading) throw new Error('扩展页面仍在加载，请稍后重新审批。')
    if (kind === 'browser_evaluate' && (typeof input.url !== 'string' || typeof input.script === 'string')) throw new Error('扩展仅支持固定浏览器动作，不支持任意 browser_evaluate。')
    const capture = await bridge.request(this.id, 'capture', { kind, selector: input.selector ?? null }, before.revision) as Record<string, unknown>
    bridge.assert(this.id, tabId, before.revision)
    if (!capture || typeof capture.documentToken !== 'string' || !/^[a-f0-9-]{36}$/.test(capture.documentToken) ||
      typeof capture.nodeToken !== 'string' || !Number.isSafeInteger(capture.version) || typeof capture.stateDigest !== 'string' || !/^[a-f0-9]{64}$/.test(capture.stateDigest)) throw new Error('扩展审批快照无效。')
    return { viewId: this.id, navigationRevision: before.revision, urlDigest: digest(before.url), documentToken: capture.documentToken,
      external: { connectionId: this.id, tabId, pageRevision: before.revision },
      actionTarget: { kind, nodeToken: capture.nodeToken, version: Number(capture.version), stateDigest: capture.stateDigest } }
  }
  async navigate(tabId: string, url: string, approved: MutationPage, assertActive?: () => void): Promise<ExternalBrowserTab> {
    this.approved(tabId, approved, 'browser_evaluate'); assertActive?.()
    await bridge.request(this.id, 'navigate', { url: requireSourceUrl(url), approved }, approved.navigationRevision)
    assertActive?.(); return this.requireTab(tabId)
  }
  async click(tabId: string, selector: string, approved: MutationPage, assertActive?: () => void): Promise<void> {
    this.approved(tabId, approved, 'browser_click'); assertActive?.()
    await bridge.request(this.id, 'click', { selector, approved }, approved.navigationRevision); assertActive?.()
  }
  async typeText(tabId: string, selector: string, text: string, approved: MutationPage, assertActive?: () => void): Promise<void> {
    this.approved(tabId, approved, 'browser_type'); assertActive?.()
    await bridge.request(this.id, 'type', { selector, text, approved }, approved.navigationRevision); assertActive?.()
  }
  async screenshot(tabId: string, selector?: string): Promise<string> {
    const before = this.current(); bridge.assert(this.id, tabId, before.revision)
    const value = await bridge.request(this.id, 'screenshot', { selector: selector ?? null }, before.revision)
    bridge.assert(this.id, tabId, before.revision)
    if (typeof value !== 'string' || value.length > 24_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('扩展截图格式或大小无效。')
    const bytes = Buffer.from(value, 'base64')
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.length > 18_000_000) throw new Error('扩展没有返回有效 PNG。')
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
    if (!width || !height || width > 16384 || height > 16384 || width * height > 64_000_000) throw new Error('扩展截图尺寸超出限制。')
    const path = join(tmpdir(), `caogen-extension-${randomUUID()}.png`)
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
    try { bridge.assert(this.id, tabId, before.revision); return path } catch (cause) { await unlink(path).catch(() => undefined); throw cause }
  }
  async waitFor(tabId: string, selector: string, timeoutMs: number): Promise<void> {
    const before = this.current(); bridge.assert(this.id, tabId, before.revision)
    await bridge.request(this.id, 'wait', { selector, timeoutMs: Math.max(0, Math.min(25_000, timeoutMs)) }, before.revision)
  }
  async evaluate(): Promise<never> { throw new Error('扩展连接不接受任意 browser_evaluate；请使用读页、点击、输入等固定动作。') }
  async searchPage(): Promise<never> { throw new Error('扩展暂不提供自动搜索流程；请明确导航到搜索页面并使用固定浏览器动作。') }
  private current() { if (this.closed) throw new Error('扩展连接已撤销。'); return bridge.page(this.id) }
  private approved(tabId: string, approved: MutationPage, kind: MutationKind): void {
    const page = this.current(); bridge.assert(this.id, tabId, approved.navigationRevision)
    if (page.loading || approved.viewId !== this.id || approved.external?.connectionId !== this.id || approved.external.tabId !== tabId ||
      approved.external.pageRevision !== page.revision || approved.urlDigest !== digest(page.url) || approved.actionTarget?.kind !== kind) throw new Error('扩展页面或审批目标已变化。')
  }
}
