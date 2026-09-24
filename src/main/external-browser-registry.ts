import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { normalizeExternalBrowserInput, type ExternalBrowserConnection, type ExternalBrowserConnectInput, type ExternalBrowserTab, type ExternalBrowserConnectResult } from '../shared/external-browser-types'
import type { EffectTarget } from '../shared/effect-types'
import { ExternalBrowserCdpAdapter, EXTERNAL_BROWSER_CAPABILITIES } from './external-browser-cdp'

type MutationPage = NonNullable<Extract<EffectTarget, { kind: 'unsupported' }>['browserPage']>
type MutationKind = NonNullable<MutationPage['actionTarget']>['kind']
export type ExternalBrowserAdapter = Pick<ExternalBrowserCdpAdapter, 'connect' | 'disconnect' | 'listTabs' | 'requireTab' | 'readPage' | 'navigate' | 'screenshot' | 'waitFor' | 'searchPage' | 'captureMutationPage' | 'click' | 'typeText' | 'evaluate'>
type AdapterFactory = (connection: ExternalBrowserConnection, port: number, onDisconnect: () => void) => ExternalBrowserAdapter
interface Entry { connection: ExternalBrowserConnection; owner: BrowserWindow; capability: string; adapter?: ExternalBrowserAdapter; attempt: number }
const copy = (entry: Entry): ExternalBrowserConnection => ({ ...entry.connection, capabilities: [...entry.connection.capabilities] })

/** Renderer operations require their owning window; native tools receive a
 * captured task binding that fails if selection, connection or owner changes. */
export class ExternalBrowserRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly bySession = new Map<string, string>()
  constructor(private readonly makeAdapter: AdapterFactory = (connection, port, onDisconnect) =>
    new ExternalBrowserCdpAdapter(connection.vendor, port, connection.id, onDisconnect)) {}

  create(rawInput: ExternalBrowserConnectInput, owner: BrowserWindow): ExternalBrowserConnection {
    const input = normalizeExternalBrowserInput(rawInput)
    if (owner.isDestroyed()) throw new Error('浏览器宿主窗口已关闭。')
    const prior = this.bySession.get(input.sessionId)
    if (prior) this.assertOwner(this.require(prior), owner)
    this.revokeForSession(input.sessionId)
    const id = `external-browser:${randomUUID()}`
    const entry: Entry = { owner, capability: randomUUID(), attempt: 0, connection: {
      id, sessionId: input.sessionId, ownerWebContentsId: owner.webContents.id,
      vendor: input.vendor, transport: input.transport, status: 'pairing', selectionRevision: 0,
      endpointLabel: input.transport === 'cdp' ? `127.0.0.1:${input.port}` : `extension:${input.extensionId}`,
      capabilities: [...EXTERNAL_BROWSER_CAPABILITIES]
    } }
    this.entries.set(id, entry); this.bySession.set(input.sessionId, id)
    owner.once('closed', () => this.revoke(id))
    return copy(entry)
  }

  async connect(id: string, owner: BrowserWindow): Promise<ExternalBrowserConnectResult> {
    const entry = this.require(id); this.assertOwner(entry, owner)
    const attempt = ++entry.attempt
    entry.adapter?.disconnect()
    entry.connection = { ...entry.connection, status: 'pairing', selectedTabId: undefined, selectionRevision: entry.connection.selectionRevision + 1 }
    const onDisconnect = () => {
      if (this.entries.get(id) === entry && entry.attempt === attempt) {
        entry.connection = { ...entry.connection, status: 'disconnected', selectionRevision: entry.connection.selectionRevision + 1 }
      }
    }
    if (entry.connection.transport === 'extension') throw new Error('浏览器扩展连接已不再支持。')
    const adapter = this.makeAdapter(copy(entry), Number(entry.connection.endpointLabel.split(':')[1]), onDisconnect)
    entry.adapter = adapter
    try {
      await adapter.connect()
      const tabs = await adapter.listTabs()
      this.assertEntryCurrent(entry, attempt); this.assertOwner(entry, owner)
      if (entry.connection.status !== 'pairing') throw new Error('连接期间浏览器已断开。')
      // Listing tabs confers no authority to operate one. The user selects it.
      entry.connection = { ...entry.connection, status: 'connected', connectedAt: Date.now(), selectedTabId: undefined }
      return { connection: copy(entry), tabs }
    } catch (error) {
      adapter.disconnect()
      if (this.entries.get(id) === entry && entry.attempt === attempt) {
        entry.adapter = undefined
        entry.connection = { ...entry.connection, status: 'error', selectedTabId: undefined }
      }
      throw error
    }
  }

  async listTabs(id: string, owner: BrowserWindow): Promise<ExternalBrowserTab[]> {
    const entry = this.require(id); this.assertOwner(entry, owner)
    const adapter = this.requireAdapter(entry), attempt = entry.attempt
    const tabs = await adapter.listTabs(entry.connection.selectedTabId)
    this.assertEntryCurrent(entry, attempt); this.assertOwner(entry, owner)
    return tabs
  }
  async selectTabLive(id: string, owner: BrowserWindow, tabId: string): Promise<ExternalBrowserTab> {
    if (!/^[A-Za-z0-9:_-]{1,180}$/.test(tabId)) throw new Error('标签页标识无效。')
    const entry = this.require(id); this.assertOwner(entry, owner)
    const adapter = this.requireAdapter(entry), attempt = entry.attempt
    const revision = ++entry.connection.selectionRevision
    const tab = await adapter.requireTab(tabId)
    this.assertEntryCurrent(entry, attempt); this.assertOwner(entry, owner); this.requireAdapter(entry)
    if (revision !== entry.connection.selectionRevision) throw new Error('标签页选择已被新的选择替换。')
    entry.connection = { ...entry.connection, selectedTabId: tabId }
    return { ...tab, active: true }
  }
  get(id: string, owner: BrowserWindow): ExternalBrowserConnection {
    const entry = this.require(id); this.assertOwner(entry, owner); return copy(entry)
  }
  list(owner: BrowserWindow): ExternalBrowserConnection[] {
    return [...this.entries.values()].filter(entry => entry.owner === owner && !owner.isDestroyed()).map(copy)
  }
  revoke(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.entries.delete(id)
    if (this.bySession.get(entry.connection.sessionId) === id) this.bySession.delete(entry.connection.sessionId)
    entry.attempt++; entry.connection.status = 'revoked'; entry.connection.revokedAt = Date.now()
    entry.adapter?.disconnect(); entry.adapter = undefined
    return true
  }
  revokeForSession(sessionId: string): void { const id = this.bySession.get(sessionId); if (id) this.revoke(id) }

  /** Main-process only. sessionId comes from the native execution context,
   * never from browser tool arguments. Disconnected bindings never fall back. */
  forTask(sessionId: string) {
    const id = this.bySession.get(sessionId)
    if (!id) return undefined
    const entry = this.require(id), adapter = this.requireAdapter(entry)
    this.assertOwner(entry, entry.owner)
    const tabId = entry.connection.selectedTabId, revision = entry.connection.selectionRevision, attempt = entry.attempt
    if (!tabId) throw new Error('请先在浏览器面板中选择允许当前任务操作的外部标签页。')
    const assertActive = () => {
      this.assertEntryCurrent(entry, attempt); this.assertOwner(entry, entry.owner); this.requireAdapter(entry)
      if (entry.connection.selectedTabId !== tabId || entry.connection.selectionRevision !== revision) throw new Error('外部浏览器标签页绑定已变化，原操作失效；请重新查看并审批。')
    }
    const run = async <T>(fn: () => Promise<T>): Promise<T> => { assertActive(); const value = await fn(); assertActive(); return value }
    const approved = (page: MutationPage, kind: MutationKind): MutationPage => {
      assertActive()
      if (page.external?.connectionId !== id || page.external.tabId !== tabId || page.external.selectionRevision !== revision || page.actionTarget?.kind !== kind) throw new Error('外部浏览器审批与当前任务标签页绑定不一致。')
      return page
    }
    return {
      connection: copy(entry),
      readPage: () => run(() => adapter.readPage(tabId)),
      navigate: (url: string, page: MutationPage) => run(() => adapter.navigate(tabId, url, approved(page, 'browser_evaluate'), assertActive)),
      searchPage: (query: string, signal: AbortSignal) => run(() => adapter.searchPage(tabId, query, signal, assertActive)),
      screenshot: (selector?: string) => run(() => adapter.screenshot(tabId, selector)),
      waitFor: (selector: string, timeoutMs: number) => run(() => adapter.waitFor(tabId, selector, timeoutMs)),
      captureMutationPage: (kind: MutationKind, input: Record<string, unknown>) => run(async () => {
        const page = await adapter.captureMutationPage(tabId, kind, input)
        if (!page.external || page.external.connectionId !== id || page.external.tabId !== tabId) throw new Error('外部浏览器审批目标无效。')
        return { ...page, external: { ...page.external, selectionRevision: revision } }
      }),
      click: (selector: string, page: MutationPage) => run(() => adapter.click(tabId, selector, approved(page, 'browser_click'), assertActive)),
      typeText: (selector: string, text: string, page: MutationPage) => run(() => adapter.typeText(tabId, selector, text, approved(page, 'browser_type'), assertActive)),
      evaluate: (script: string, page: MutationPage) => run(() => adapter.evaluate(tabId, script, approved(page, 'browser_evaluate'), assertActive))
    }
  }
  taskStatus(sessionId: string): ExternalBrowserConnection | undefined {
    const id = this.bySession.get(sessionId), entry = id && this.entries.get(id)
    return entry ? copy(entry) : undefined
  }
  private requireAdapter(entry: Entry): ExternalBrowserAdapter {
    if (!entry.adapter || entry.connection.status !== 'connected') throw new Error('外部浏览器尚未连接或已断开；请核对页面实际结果后重试。')
    return entry.adapter
  }
  private require(id: string): Entry { const entry = this.entries.get(id); if (!entry) throw new Error('外部浏览器连接不存在或已撤销。'); return entry }
  private assertEntryCurrent(entry: Entry, attempt: number): void {
    if (this.entries.get(entry.connection.id) !== entry || entry.attempt !== attempt) throw new Error('外部浏览器连接已撤销或被替换。')
  }
  private assertOwner(entry: Entry, owner: BrowserWindow): void {
    if (owner.isDestroyed() || entry.owner !== owner || entry.owner.webContents.id !== owner.webContents.id) throw new Error('外部浏览器连接不属于当前窗口。')
  }
}
export const externalBrowserRegistry = new ExternalBrowserRegistry()
