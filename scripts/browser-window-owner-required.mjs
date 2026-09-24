import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { dirname, resolve } from 'node:path'
import { Module } from 'node:module'
import { build } from 'esbuild'

// Real manager, Effect wrappers and IPC routing; Electron and durable execution are local fixture boundaries.
const handlers = new Map()
const views = []
const receipts = []
const owners = new Map()
class Contents extends EventEmitter {
  url = 'about:blank'; destroyed = false; loads = 0; back = 0; forward = 0; reloads = 0
  navigationHistory = { canGoBack: () => true, canGoForward: () => true, goBack: () => { this.back++ }, goForward: () => { this.forward++ } }
  isDestroyed() { return this.destroyed }
  setWindowOpenHandler() {}
  async loadURL(url) { this.loads++; this.url = url }
  getURL() { return this.url }
  getTitle() { return 'Fixture' }
  isLoading() { return false }
  reload() { this.reloads++ }
  close() { this.destroyed = true }
}
class View {
  webContents = new Contents()
  bounds = {}
  constructor() { views.push(this) }
  setBounds(value) { this.bounds = value }
}
function owner(id) {
  const window = new EventEmitter()
  const sender = new EventEmitter()
  sender.id = id; sender.isDestroyed = () => false
  window.webContents = sender; window.isDestroyed = () => false
  window.contentView = { addChildView() {}, removeChildView() {} }
  owners.set(id, window)
  return window
}
const fixtureKey = '__caogenBrowserOwnerFixture'
let beforeExecute
globalThis[fixtureKey] = {
  electron: { app: { getPath: () => '/fixture' }, BrowserWindow: { fromWebContents: sender => owners.get(sender.id) },
    WebContentsView: View, shell: {}, ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
  async execute(spec) {
    receipts.push(spec)
    const effect = { target: { kind: 'unsupported', toolName: spec.toolName } }
    if (beforeExecute) { const hook = beforeExecute; beforeExecute = undefined; await hook() }
    const value = await spec.execute(effect)
    return { status: 'completed', value, effect, effectStatus: 'completed', operationId: 'fixture-operation', effectId: 'fixture-effect' }
  }
}
try {
  const output = await build({ stdin: { contents: `
    export { browserViewManager } from './src/main/browserView'
    export { openBrowserWithEffect } from './src/main/browserEffect'
    export { registerBrowserMutationIpc, assertRendererBrowserOwner } from './src/main/ipc/browser-mutation-ipc'
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', packages: 'external',
    plugins: [{ name: 'browser-owner-boundaries', setup(builder) {
      builder.onResolve({ filter: /^electron$|(?:^|\/)(?:workflow-ledger-handlers|operation-effect-gateway)$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'browser-owner-boundaries' }))
      builder.onLoad({ filter: /.*/, namespace: 'browser-owner-boundaries' }, args => ({ loader: 'js', contents: {
        electron: `module.exports = globalThis.${fixtureKey}.electron`,
        'workflow-ledger-handlers': `module.exports = { assertTrustedWorkflowLedgerSender: event => { if(!event.sender || ![1,2].includes(event.sender.id)) throw new Error('untrusted') } }`,
        'operation-effect-gateway': `module.exports = { executeInteractiveOperationEffect: spec => globalThis.${fixtureKey}.execute(spec) }`
      }[args.path] }))
    } }] })
  const filename = resolve('scripts/.browser-window-owner-fixture.cjs')
  const mod = new Module(filename)
  mod.filename = filename; mod.paths = Module._nodeModulePaths(dirname(filename)); mod._compile(output.outputFiles[0].text, filename)
  const api = mod.exports
  const manager = api.browserViewManager
  const first = owner(1), second = owner(2)
  const event = window => ({ sender: window.webContents })
  api.registerBrowserMutationIpc({ manager, getSessionMeta: id => ({ id, cwd: '/fixture' }) })
  const invoke = (name, window, ...args) => Promise.resolve().then(() => handlers.get(name)(event(window), ...args))
  await manager.open(first, 'task-fixture', 'https://fixture.invalid/one')
  const view = views.at(-1)
  await assert.rejects(api.openBrowserWithEffect({ sourceSessionId: 'task-fixture', cwd: '/fixture' }, manager, second), /另一个窗口/)
  assert.equal((await api.openBrowserWithEffect({ sourceSessionId: 'task-fixture', cwd: '/fixture' }, manager, first)).ok, true)
  assert.equal(receipts.length, 0)
  for (const channel of ['browser:open', 'browser:navigate', 'browser:back', 'browser:forward', 'browser:reload', 'browser:bounds', 'browser:close']) {
    await assert.rejects(invoke(channel, second, 'task-fixture', channel === 'browser:bounds' ? { x: 0, y: 0, width: 2, height: 2 } : 'https://fixture.invalid/two'), /另一个窗口/)
  }
  assert.throws(() => api.assertRendererBrowserOwner(manager, event(second), 'task-fixture'), /另一个窗口/)
  assert.equal(view.webContents.loads, 1)
  assert.equal(view.webContents.destroyed, false)
  assert.equal(receipts.length, 0)
  await invoke('browser:navigate', first, 'task-fixture', 'https://fixture.invalid/two')
  await invoke('browser:back', first, 'task-fixture')
  await invoke('browser:forward', first, 'task-fixture')
  await invoke('browser:reload', first, 'task-fixture')
  assert.equal(view.webContents.loads, 2)
  assert.equal(view.webContents.back, 1); assert.equal(view.webContents.forward, 1); assert.equal(view.webContents.reloads, 1)
  beforeExecute = async () => { manager.close('task-fixture', first); await manager.open(second, 'task-fixture') }
  await assert.rejects(invoke('browser:navigate', first, 'task-fixture', 'https://fixture.invalid/stale'), /另一个窗口/)
  assert.equal(manager.getState('task-fixture').url, 'about:blank')
  const workspace = await invoke('browser:open-workspace', first)
  assert.equal(workspace.state.scopeKind, 'workspace')
  assert.equal(workspace.sourceKind, 'workspace_human')
  await assert.rejects(invoke('browser:navigate', second, workspace.state.sessionId, 'https://fixture.invalid/no'), /不属于/)
  await invoke('browser:navigate', first, workspace.state.sessionId, 'https://fixture.invalid/workspace')
  assert.equal(manager.getState(workspace.state.sessionId).scopeKind, 'workspace')
  console.log('PASS: Real browser manager/Effect/IPC owner checks, cached-open rejection, task navigation/history/reload/bounds/close isolation, queued ownership change and workspace scope retention.')
} finally { delete globalThis[fixtureKey] }
