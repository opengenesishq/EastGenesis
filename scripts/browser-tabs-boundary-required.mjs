import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { dirname, resolve, join } from 'node:path'
import { Module } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'

// Real manager, Effect and IPC. Native pages are deterministic local fakes; no network/Provider calls.
const fixtureKey = '__caogenBrowserTabsFixture'
const root = await mkdtemp(join(tmpdir(), 'caogen-browser-tabs-'))
const handlers = new Map(), views = [], owners = new Map(), partitions = new Map(), receipts = []
let contentsId = 100, beforeExecute, checks = 0
function pass(label) { checks++; console.log(`PASS ${checks}: ${label}`) }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
class Contents extends EventEmitter {
  id = ++contentsId; destroyed = false; url = 'about:blank'; title = 'Fixture'; loads = []; history = []; position = -1; mutationCalls = 0
  token = randomUUID(); scriptGate; captureGate; loadGate
  constructor(session) { super(); this.session = session }
  navigationHistory = {
    canGoBack: () => this.position > 0,
    canGoForward: () => this.position < this.history.length - 1,
    goBack: () => { if (this.position > 0) this.visit(this.history[--this.position]) },
    goForward: () => { if (this.position < this.history.length - 1) this.visit(this.history[++this.position]) }
  }
  visit(url) { this.emit('did-start-navigation', { isMainFrame: true, url }); this.url = url; this.emit('did-navigate') }
  async loadURL(url) {
    this.loads.push(url); this.history = this.history.slice(0, this.position + 1); this.history.push(url); this.position++
    this.visit(url); if (this.loadGate) { const gate = this.loadGate; this.loadGate = undefined; await gate.promise }
    this.emit('did-stop-loading')
  }
  getURL() { return this.url } getTitle() { return this.title } isLoading() { return false } isLoadingMainFrame() { return false }
  isDestroyed() { return this.destroyed } close() { this.destroyed = true } reload() { this.visit(this.url) }
  setWindowOpenHandler(handler) { this.popup = handler }
  async executeJavaScript(code) {
    if (this.scriptGate) { const gate = this.scriptGate; this.scriptGate = undefined; await gate.promise }
    if (code.includes('document.body ? document.body.innerText')) return 'Fixture body'
    return { cancelled: false, url: this.url, title: this.title, selector: '#fixture', text: 'Fixture', boundingBox: { x: 1, y: 1, width: 10, height: 10 } }
  }
  async executeJavaScriptInIsolatedWorld(world, scripts) {
    if (this.scriptGate) { const gate = this.scriptGate; this.scriptGate = undefined; await gate.promise }
    if (world === 1001) return { url: this.url, text: 'Verified local fixture body', truncated: false }
    if (scripts[0].code.includes('return { documentToken:')) return { documentToken: this.token, nodeToken: 'fixture-node', version: 1, snapshot: 'fixture-dom' }
    this.mutationCalls++; return true
  }
  async capturePage() {
    if (this.captureGate) { const gate = this.captureGate; this.captureGate = undefined; await gate.promise }
    return { isEmpty: () => false, toPNG: () => Buffer.from('fixture'), getSize: () => ({ width: 200, height: 100 }), crop() { return this } }
  }
}
class View {
  bounds = { x: 0, y: 0, width: 0, height: 0 }
  constructor(options) {
    const key = options.webPreferences.partition
    if (!partitions.has(key)) {
      const session = { registrations: 0, removals: 0, listener: undefined }
      session.webRequest = { onCompleted(filter, listener) { if (filter === null) { session.removals++; session.listener = undefined } else { session.registrations++; session.listener = listener } } }
      partitions.set(key, session)
    }
    this.webContents = new Contents(partitions.get(key)); views.push(this)
  }
  setBounds(bounds) { this.bounds = bounds } getBounds() { return this.bounds }
}
function owner(id) {
  const win = new EventEmitter(), sender = new EventEmitter()
  sender.id = id; sender.isDestroyed = () => false; sender.send = (...args) => { win.events.push(args) }
  win.events = []; win.webContents = sender; win.isDestroyed = () => false; win.contentView = { addChildView() {}, removeChildView() {} }
  owners.set(id, win); return win
}
globalThis[fixtureKey] = {
  electron: { app: { getPath: () => root }, BrowserWindow: { fromWebContents: sender => owners.get(sender.id) }, WebContentsView: View,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
  async execute(spec) {
    receipts.push(spec)
    if (beforeExecute) { const hook = beforeExecute; beforeExecute = undefined; await hook() }
    const value = await spec.execute({ target: { kind: 'unsupported', toolName: spec.toolName } })
    return { status: 'completed', value, effectStatus: 'completed', operationId: randomUUID() }
  }
}
let manager
try {
  const output = await build({ stdin: { contents: `
    export { browserViewManager } from './src/main/browserView'
    export { registerBrowserMutationIpc } from './src/main/ipc/browser-mutation-ipc'
    export { registerBrowserTabIpc } from './src/main/ipc/browser-tab-handlers'
    export { registerDesktopWindow } from './src/main/desktop-window-registry'
    export { browserTabTarget } from './src/shared/browser-tab-types'
    export { createBrowserActions } from './src/renderer/src/store/browser-actions'
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', packages: 'external',
    plugins: [{ name: 'tabs-fixture', setup(builder) {
      builder.onResolve({ filter: /^electron$|(?:^|\/)(?:workflow-ledger-handlers|operation-effect-gateway|task-window)$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'tabs-fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'tabs-fixture' }, args => ({ loader: 'js', contents: {
        electron: `module.exports = globalThis.${fixtureKey}.electron`,
        'workflow-ledger-handlers': `module.exports = { assertTrustedWorkflowLedgerSender: event => { if(![1,2,3].includes(event.sender?.id)) throw new Error('untrusted') } }`,
        'operation-effect-gateway': `module.exports = { executeInteractiveOperationEffect: spec => globalThis.${fixtureKey}.execute(spec) }`,
        'task-window': `module.exports = { taskSessionForWindow: win => win.taskId }`
      }[args.path] }))
    } }] })
  const filename = resolve('scripts/.browser-tabs-boundary-fixture.cjs'), mod = new Module(filename)
  mod.filename = filename; mod.paths = Module._nodeModulePaths(dirname(filename)); mod._compile(output.outputFiles[0].text, filename)
  const api = mod.exports
  manager = api.browserViewManager
  const first = owner(1), second = owner(2), detached = owner(3)
  api.registerDesktopWindow(first, 'main'); api.registerDesktopWindow(second, 'main'); api.registerDesktopWindow(detached, 'task'); detached.taskId = 'task-other'
  let identity = 'original'
  const metas = new Map(['task-one', 'task-other'].map(id => [id, { id, createdAt: 1, cwd: root, status: 'idle', workItemId: id }]))
  const deps = { manager, getSessionMeta: id => { const meta = metas.get(id); return meta && { ...meta, goalId: identity } } }
  api.registerBrowserMutationIpc(deps); api.registerBrowserTabIpc(deps)
  const invoke = (channel, win, ...args) => Promise.resolve().then(() => handlers.get(channel)({ sender: win.webContents }, ...args))
  const target = (id = 'task-one', tabId) => api.browserTabTarget(manager.getTabs(id), tabId)
  const select = tabId => manager.selectTab(target('task-one', tabId))
  await invoke('browser:open', first, 'task-one', 'https://fixture.invalid/a')
  const a = views.at(-1), aId = manager.target('task-one').tabId
  manager.setBounds('task-one', { x: 10, y: 40, width: 200, height: 100 }, first)
  await invoke('browser-tabs:create', first, 'task-one', { url: 'https://fixture.invalid/b' })
  const b = views.at(-1), bId = manager.target('task-one').tabId
  assert.notEqual(a.webContents.id, b.webContents.id); assert.equal(a.bounds.width, 0); assert.equal(b.bounds.width, 200)
  pass('distinct native WebContents and only selected tab visible')
  await manager.navigate('task-one', 'https://fixture.invalid/b2'); select(aId)
  assert.equal(manager.getState('task-one').url, 'https://fixture.invalid/a'); assert.equal(manager.getState('task-one').canGoBack, true)
  select(bId); await manager.goBack('task-one'); assert.equal(manager.getState('task-one').url, 'https://fixture.invalid/b'); select(aId)
  pass('independent page URL and native history')
  const legacy = []; const unsubscribe = manager.subscribe(event => legacy.push(event))
  b.webContents.title = 'Background B'; b.webContents.emit('page-title-updated', {}, 'Background B'); b.webContents.emit('did-start-loading')
  assert.equal(manager.getState('task-one').tabId, aId); assert.equal(manager.getState('task-one').url, 'https://fixture.invalid/a')
  assert.equal(legacy.filter(event => event.kind === 'state').length, 0)
  pass('background title/loading updates cannot replace active URL')
  const approval = await manager.captureMutationPage('task-one', 'browser_click', { selector: '#fixture' })
  select(bId); select(aId)
  await assert.rejects(manager.click('task-one', '#fixture', approval), /原操作失效/); assert.equal(a.webContents.mutationCalls, 0)
  pass('A to B to A invalidates old mutation approval')
  const old = target(); beforeExecute = () => { select(bId) }
  await assert.rejects(invoke('browser:navigate', first, 'task-one', 'https://fixture.invalid/stale', old), /失败/)
  assert.equal(b.webContents.loads.includes('https://fixture.invalid/stale'), false); assert.equal(a.webContents.loads.includes('https://fixture.invalid/stale'), false)
  assert.equal(receipts.at(-1).toolInput.browserTab.tabId, aId); select(aId)
  pass('queued Effect stays bound to original tab and records its identity')
  const gate = deferred(); a.webContents.loadGate = gate
  const loading = manager.bind('task-one').navigate('task-one', 'https://fixture.invalid/a2'); select(bId); gate.resolve()
  await assert.rejects(loading, /原操作失效/); assert.equal(b.webContents.url, 'https://fixture.invalid/b'); select(aId)
  pass('late navigation never navigates selected replacement tab')
  for (const kind of ['read', 'observe', 'pick', 'wait', 'screenshot']) {
    const hold = deferred()
    if (kind === 'screenshot') a.webContents.captureGate = hold
    else a.webContents.scriptGate = hold
    const work = kind === 'read' ? manager.readPage('task-one') : kind === 'observe' ? manager.observe('task-one') : kind === 'pick' ? manager.pickElement('task-one') : kind === 'wait' ? manager.waitFor('task-one', '#fixture', 100) : manager.screenshot('task-one')
    select(bId); select(aId); hold.resolve(); await assert.rejects(work, /原操作失效/)
    pass(`delayed ${kind} result rejected after selection changes`)
  }
  const picked = await manager.pickElement('task-one')
  await assert.rejects(manager.captureElementAnnotation('task-one', { ...picked, pickId: 'forged' }, 'bad'), /过期/)
  const dateNow = Date.now; Date.now = () => dateNow() + 301_000
  try { await assert.rejects(manager.captureElementAnnotation('task-one', picked, 'expired'), /过期/) } finally { Date.now = dateNow }
  const freshPick = await manager.pickElement('task-one')
  const annotation = await manager.captureElementAnnotation('task-one', { ...freshPick, selector: '#forged' }, 'safe')
  assert.equal(annotation.selector, '#fixture'); assert.equal(annotation.tabId, aId)
  assert.equal((await manager.listAnnotations('task-one'))[0].contextEpoch, target().contextEpoch)
  pass('opaque pick id rejects forgery/expiry; saved annotation keeps tab provenance')
  const partition = a.webContents.session
  assert.equal(partition, b.webContents.session); assert.equal(partition.registrations, 1)
  partition.listener({ webContentsId: b.webContents.id, statusCode: 503, method: 'GET', url: 'https://fixture.invalid/failure-b' })
  assert.equal((await manager.observe('task-one')).networkFailures.length, 0); select(bId)
  assert.match((await manager.observe('task-one')).networkFailures[0], /failure-b/); select(aId)
  pass('one partition listener routes HTTP failures to the correct native tab')
  const count = manager.getTabs('task-one').tabs.length
  a.webContents.popup({ url: 'https://fixture.invalid/popup', disposition: 'background-tab' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.getTabs('task-one').tabs.length, count + 1); assert.equal(manager.target('task-one').tabId, aId)
  a.webContents.popup({ url: 'https://fixture.invalid/post', disposition: 'new-window', postBody: { data: [] } })
  assert.equal(manager.getTabs('task-one').tabs.length, count + 1)
  pass('GET popup opens independent background tab; unsupported POST popup is denied')
  const beforeHide = manager.getTabs('task-one')
  await invoke('browser-tabs:visible', first, 'task-one', false); assert.equal(a.bounds.width, 0)
  await invoke('browser-tabs:visible', first, 'task-one', true); assert.equal(a.bounds.width, 200)
  assert.deepEqual(manager.getTabs('task-one'), beforeHide)
  pass('hide/show preserves tabs, history and context identity')
  for (const channel of ['browser-tabs:list', 'browser-tabs:create', 'browser-tabs:visible']) await assert.rejects(invoke(channel, second, 'task-one'), /另一个窗口/)
  await assert.rejects(invoke('browser-tabs:select', second, target()), /另一个窗口/)
  await assert.rejects(invoke('browser-tabs:list', detached, 'task-one'), /其他任务/)
  await assert.rejects(invoke('browser:navigate', first, 'task-other', 'https://fixture.invalid/no', target()), /不属于/)
  pass('tab APIs reject cross-window, detached-task and cross-task target access')
  const workspace = await invoke('browser:open-workspace', first)
  assert.equal(a.bounds.width, 0)
  await invoke('browser-tabs:create', first, workspace.state.sessionId, {})
  assert.equal(manager.getTabs(workspace.state.sessionId).tabs.length, 2)
  await assert.rejects(invoke('browser-tabs:list', second, workspace.state.sessionId), /不属于/)
  pass('standalone browser has independent owner-scoped tabs and hides task view')
  manager.setVisible('task-one', true)
  const pendingTarget = target(); manager.close('task-one'); await invoke('browser:open', first, 'task-one')
  assert.notEqual(target().contextEpoch, pendingTarget.contextEpoch); assert.throws(() => manager.assertTarget(pendingTarget), /原操作失效/)
  assert.ok(a.webContents.destroyed && b.webContents.destroyed); assert.equal(partition.removals, 1)
  pass('closing context destroys every tab and invalidates old epoch')
  manager.closeTab(target()); assert.equal(manager.getTabs('task-one').tabs.length, 0); assert.equal(manager.getState('task-one'), undefined)
  await invoke('browser-tabs:create', first, 'task-one', {}); assert.equal(manager.getTabs('task-one').tabs.length, 1)
  pass('last tab can close to empty state and a new tab can be created')
  const currentNative = views.at(-1); identity = 'rebound'
  assert.throws(() => manager.getTabs('task-one'), /归属已变化/)
  assert.doesNotThrow(() => currentNative.webContents.emit('page-title-updated', {}, 'late after rebind'))
  assert.equal(currentNative.webContents.destroyed, true)
  pass('task canonical identity changes reject work and safely tear down late events')
  await invoke('browser:open', first, 'task-one')
  // Cleanup is installed by open, even before the renderer first lists its tabs.
  first.webContents.emit('did-start-navigation', { isMainFrame: true })
  assert.equal(manager.getState('task-one'), undefined); assert.equal(manager.getState(workspace.state.sessionId), undefined)
  pass('owner renderer navigation destroys task and standalone contexts')
  unsubscribe()
  // Renderer store binding: an IPC response for A cannot overwrite B or its address draft.
  let state = { activeId: 'task-one', showNewSession: false, workbench: { activePanelId: 'browser', mountedPanels: new Set(['browser']), browserState: { sessionId: 'task-one', contextEpoch: 'epoch', tabId: 'a', selectionRevision: 1, navigationRevision: 1, url: 'https://fixture.invalid/a' } }, refreshTaskSnapshots: async () => {} }
  const oldWindow = globalThis.window, pending = deferred(); let sentTarget
  globalThis.window = { agentDesk: { navigateBrowser: async (_id, _url, captured) => { sentTarget = captured; return pending.promise } } }
  const actions = api.createBrowserActions(update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } }, () => state)
  const navigation = actions.navigateBrowser('https://fixture.invalid/a-new')
  state = { ...state, workbench: { ...state.workbench, browserState: { ...state.workbench.browserState, tabId: 'b', selectionRevision: 2 }, browserUrlDraft: 'https://fixture.invalid/user-draft' } }
  pending.resolve({ ok: true, state: { ...state.workbench.browserState, tabId: 'a', selectionRevision: 1, url: 'https://fixture.invalid/a-new' } }); await navigation
  assert.equal(sentTarget.tabId, 'a'); assert.equal(state.workbench.browserState.tabId, 'b'); assert.equal(state.workbench.browserUrlDraft, 'https://fixture.invalid/user-draft')
  globalThis.window = oldWindow
  pass('renderer freezes target and ignores stale navigation result/draft updates')
  console.log(`Browser tab focused boundaries: ${checks}/${checks} passed; no network or Provider calls.`)
} finally {
  for (const win of owners.values()) manager?.closeOwned(win)
  delete globalThis[fixtureKey]
  await rm(root, { recursive: true, force: true })
}
