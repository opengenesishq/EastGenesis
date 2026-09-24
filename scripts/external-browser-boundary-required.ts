import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { isLoopbackHost, normalizeExternalBrowserInput } from '../src/shared/external-browser-types'
import { ExternalBrowserRegistry, type ExternalBrowserAdapter } from '../src/main/external-browser-registry'
import { ExternalBrowserCdpAdapter } from '../src/main/external-browser-cdp'

function owner(id: number) {
  let destroyed = false
  const listeners: Array<() => void> = []
  return { webContents: { id }, isDestroyed: () => destroyed, once(_name: string, fn: () => void) { listeners.push(fn) }, destroy() { destroyed = true; for (const fn of listeners) fn() } } as any
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
async function main() {
  let passed = 0
  const check = async (name: string, run: () => void | Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`) }
  await check('explicit loopback and extension input validation', () => {
    assert.deepEqual(normalizeExternalBrowserInput({ sessionId: 'session-1', vendor: 'chrome', transport: 'cdp', port: 9222 }), { sessionId: 'session-1', vendor: 'chrome', transport: 'cdp', port: 9222 })
    for (const bad of [
      { sessionId: 's', vendor: 'chrome', transport: 'cdp', port: 80 },
      { sessionId: 's', vendor: 'chrome', transport: 'cdp', port: 9222, host: '192.168.1.10' },
      { sessionId: 's', vendor: 'chrome', transport: 'extension', extensionId: 'secret' },
      { sessionId: 's', vendor: 'firefox', transport: 'cdp', port: 9222 }
    ]) assert.throws(() => normalizeExternalBrowserInput(bad))
    assert.equal(isLoopbackHost('127.0.0.1'), true); assert.equal(isLoopbackHost('192.168.1.10'), false)
  })
  let disconnected = 0, clicks = 0, failConnect = false, failListing = false, disconnectCallback = () => undefined
  const first = owner(1), second = owner(2)
  const registry = new ExternalBrowserRegistry((connection, _port, onDisconnect) => {
    disconnectCallback = onDisconnect
    const tabs = ['tab-1', 'tab-2'].map(tabId => ({ tabId, title: tabId, url: 'https://fixture.test/', active: false, vendor: connection.vendor, connectionId: connection.id, pageRevision: 1 }))
    return {
      connect: async () => { if (failConnect) throw new Error('offline connect failure') },
      disconnect: () => { disconnected++; onDisconnect() },
      listTabs: async () => { if (failListing) throw new Error('offline tab failure'); return tabs },
      requireTab: async tabId => { const tab = tabs.find(item => item.tabId === tabId); if (!tab) throw new Error('missing tab'); return tab },
      readPage: async () => ({ url: 'https://fixture.test/', title: 'Fixture', text: 'Evidence', truncated: false, filtered: false, observedAt: Date.now() }),
      navigate: async tabId => tabs.find(tab => tab.tabId === tabId)!,
      searchPage: async () => ({ citations: [] }),
      screenshot: async () => '/fixture.png', waitFor: async () => undefined,
      captureMutationPage: async (tabId, kind) => ({ viewId: connection.id, navigationRevision: 1, urlDigest: digest('https://fixture.test/'), documentToken: 'document',
        external: { connectionId: connection.id, tabId, pageRevision: 1 }, actionTarget: { kind, nodeToken: '1', version: 1, stateDigest: digest('form') } }),
      click: async (_tab, _selector, _page, assertActive) => { assertActive?.(); clicks++ },
      typeText: async () => undefined, evaluate: async () => true
    } satisfies ExternalBrowserAdapter
  })
  const created = registry.create({ sessionId: 'session-1', vendor: 'chrome', transport: 'cdp', port: 9222 }, first)
  await check('renderer ownership rejects cross-window replacement and access', () => {
    assert.throws(() => registry.get(created.id, second))
    assert.throws(() => registry.create({ sessionId: 'session-1', vendor: 'edge', transport: 'cdp', port: 9333 }, second))
  })
  await check('connect returns tabs without selecting the first one', async () => {
    const result = await registry.connect(created.id, first)
    assert.equal(result.tabs.length, 2); assert.equal(result.connection.status, 'connected'); assert.equal(result.connection.selectedTabId, undefined)
    assert.throws(() => registry.forTask('session-1'), /选择/)
  })
  await check('unlisted and cross-window tab selection rejected', async () => {
    await assert.rejects(registry.selectTabLive(created.id, first, 'missing'), /missing/)
    await assert.rejects(registry.selectTabLive(created.id, second, 'tab-1'), /窗口/)
  })
  await registry.selectTabLive(created.id, first, 'tab-1')
  const task = registry.forTask('session-1')!
  const approval = await task.captureMutationPage('browser_click', { selector: '#submit' })
  await check('selected task routes read and approved click to its bound adapter', async () => {
    assert.equal((await task.readPage()).text, 'Evidence')
    await task.click('#submit', approval); assert.equal(clicks, 1)
  })
  await check('A to B to A invalidates old approval and captured task binding', async () => {
    await registry.selectTabLive(created.id, first, 'tab-2'); await registry.selectTabLive(created.id, first, 'tab-1')
    await assert.rejects(task.readPage(), /绑定已变化/)
    await assert.rejects(registry.forTask('session-1')!.click('#submit', approval), /审批/)
    assert.equal(clicks, 1)
  })
  await check('disconnect fails closed instead of falling back', () => {
    disconnectCallback(); assert.equal(registry.taskStatus('session-1')?.status, 'disconnected')
    assert.throws(() => registry.forTask('session-1'), /断开/)
  })
  await check('reconnect clears selection and advances binding revision', async () => {
    const before = registry.taskStatus('session-1')!.selectionRevision
    const result = await registry.connect(created.id, first)
    assert.equal(result.connection.selectedTabId, undefined); assert.ok(result.connection.selectionRevision > before)
  })
  await check('failed adapter connection is disconnected and discarded', async () => {
    failConnect = true; const before = disconnected
    await assert.rejects(registry.connect(created.id, first), /offline connect/)
    assert.ok(disconnected > before); assert.equal(registry.taskStatus('session-1')?.status, 'error')
    assert.throws(() => registry.forTask('session-1')); failConnect = false
  })
  await check('failed tab listing cleans an already-connected adapter', async () => {
    failListing = true; const before = disconnected
    await assert.rejects(registry.connect(created.id, first), /offline tab/)
    assert.ok(disconnected > before); failListing = false
  })
  await registry.connect(created.id, first); await registry.selectTabLive(created.id, first, 'tab-1')
  const beforeRevoke = registry.forTask('session-1')!
  await check('owner close revokes the task capability', async () => {
    first.destroy(); assert.equal(registry.taskStatus('session-1'), undefined)
    await assert.rejects(beforeRevoke.readPage(), /撤销/)
  })
  await check('lost CDP mutation reply is never replayed', async () => {
    let sends = 0
    const adapter = new ExternalBrowserCdpAdapter('chrome', 9222, 'fixture') as any
    const page = { isClosed: () => false, url: () => 'https://fixture.test/' }
    const record = { id: 'tab-1', page, closed: false, loading: false, revision: 1, isolatedContextIds: new Map([['mutation', 3]]),
      client: { send: async () => { sends++; throw new Error('response lost after effect') } } }
    adapter.browser = {}; adapter.pages.set(record.id, record)
    await assert.rejects(adapter.isolated(record, 'document.querySelector("button").click()'), /response lost/)
    assert.equal(sends, 1)
  })
  await check('revocation during CDP context preparation prevents dispatch', async () => {
    let revoked = false, evaluations = 0
    const adapter = new ExternalBrowserCdpAdapter('chrome', 9222, 'fixture') as any
    const record = { id: 'tab-1', page: { isClosed: () => false, url: () => 'https://fixture.test/' }, closed: false, loading: false, revision: 1, isolatedContextIds: new Map(), client: {
      send: async (method: string) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1' } } }
        if (method === 'Page.createIsolatedWorld') { revoked = true; return { executionContextId: 4 } }
        evaluations++; return { result: { value: true } }
      }
    } }
    adapter.browser = {}; adapter.pages.set(record.id, record)
    await assert.rejects(adapter.isolated(record, 'true', 'mutation', () => { if (revoked) throw new Error('revoked') }), /revoked/)
    assert.equal(evaluations, 0)
  })
  console.log(`D22 offline boundary fixtures: ${passed}/${passed} passed. No real browser, profile, cookies, or Provider used.`)
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
