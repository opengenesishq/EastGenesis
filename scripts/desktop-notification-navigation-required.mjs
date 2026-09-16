import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const ts = require('typescript')
function load(file, dependencies = {}) {
  const source = ts.transpileModule(readFileSync(resolve(file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)((id) => {
    if (Object.hasOwn(dependencies, id)) return dependencies[id]
    throw new Error(`Unexpected dependency: ${id}`)
  }, module, module.exports)
  return module.exports
}

const checks = []
const ipcMain = new EventEmitter()
const notices = []
class FakeNotification extends EventEmitter {
  static isSupported() { return true }
  constructor(input) { super(); this.input = input; notices.push(this) }
  show() {}
}
let onActivation = () => {}
function makeWindow() {
  const contents = new EventEmitter()
  contents.loading = true
  contents.sent = []
  contents.isDestroyed = () => false
  contents.isLoadingMainFrame = () => contents.loading
  contents.send = (channel, sessionId) => { contents.sent.push({ channel, sessionId }); onActivation(sessionId) }
  return { destroyed: false, isDestroyed() { return this.destroyed }, webContents: contents }
}
const desktop = load('src/main/desktopNotify.ts', {
  electron: { app: { focus() {} }, ipcMain, Notification: FakeNotification }
})
let mainWindow = makeWindow(), focusCount = 0
desktop.configureDesktopNotifications({
  getMainWindow: () => mainWindow,
  showMainWindow: () => { focusCount++; if (mainWindow.destroyed) mainWindow = makeWindow(); return mainWindow }
})
const { SessionNotificationCoordinator } = load('src/main/notification/session-notification-coordinator.ts', {
  '../desktopNotify': desktop,
  '../settings': { getSettings: () => ({ notificationsEnabled: true }) }
})
const coordinator = new SessionNotificationCoordinator((id) => ({ id, title: '审批中的原任务', cwd: '/fixture' }))
const emit = (event) => coordinator.handle('original-session', event)
const request = (requestId) => emit({ kind: 'permission-request', request: { requestId, toolName: 'write_file' } })
const resolved = (requestId) => emit({ kind: 'permission-resolved', requestId, behavior: 'allow' })
emit({ kind: 'user-message' })
request('first'); request('first'); request('parallel')
assert.equal(notices.length, 1)
resolved('first'); request('parallel')
assert.equal(notices.length, 1)
resolved('parallel'); request('next-operation')
assert.equal(notices.length, 2)
resolved('next-operation'); request('next-operation')
assert.equal(notices.length, 2)
assert.equal(focusCount, 0)
checks.push('one reminder per pending approval queue; a later queue alerts again, duplicate request IDs stay quiet')

const { createDesktopNotificationNavigation } = load('src/renderer/src/store/desktop-notification-navigation.ts')
const sessions = new Set(['original-session'])
let current = '', recovery = 0, navigationKey = 'initial', listCalls = 0
let listResult = Promise.resolve([])
const navigate = createDesktopNotificationNavigation({
  hasSession: (id) => sessions.has(id),
  listSessions: () => { listCalls++; return listResult },
  adoptSessions: (metas) => metas.forEach((meta) => sessions.add(meta.id)),
  navigationKey: () => navigationKey,
  openSession: (id) => { current = id; navigationKey = id },
  openRecovery: () => { recovery++; navigationKey = `recovery-${recovery}` }
})
onActivation = (id) => { void navigate(id) }
notices[0].emit('click')
assert.equal(current, '')
assert.equal(focusCount, 1)
ipcMain.emit('desktop-notification:ready', { sender: mainWindow.webContents })
assert.equal(current, '')
mainWindow.webContents.loading = false
mainWindow.webContents.emit('did-finish-load')
assert.equal(current, 'original-session')
assert.equal(mainWindow.webContents.sent.length, 1)
assert.equal(listCalls, 0)
checks.push('explicit click waits for renderer hydration/load then opens the same task once without execution')

mainWindow.destroyed = true
notices[1].emit('click')
assert.equal(mainWindow.destroyed, false)
const quickbar = makeWindow()
ipcMain.emit('desktop-notification:ready', { sender: quickbar.webContents })
assert.equal(mainWindow.webContents.sent.length, 0)
mainWindow.webContents.loading = false
ipcMain.emit('desktop-notification:ready', { sender: mainWindow.webContents })
assert.equal(mainWindow.webContents.sent[0].sessionId, 'original-session')
mainWindow.webContents.emit('did-start-navigation', {}, 'fixture://reload', false, true)
desktop.showDesktopNotification({ title: 'reload first', body: 'fixture', sessionId: 'superseded-session' })
desktop.showDesktopNotification({ title: 'reload latest', body: 'fixture', sessionId: 'original-session' })
notices[2].emit('click'); notices[3].emit('click')
assert.equal(mainWindow.webContents.sent.length, 1)
ipcMain.emit('desktop-notification:ready', { sender: mainWindow.webContents })
assert.equal(mainWindow.webContents.sent.length, 2)
assert.equal(mainWindow.webContents.sent[1].sessionId, 'original-session')
checks.push('destroyed/reloaded main window retains the latest click; unrelated Quickbar cannot consume it')

listResult = Promise.resolve([{ id: 'background-session' }])
await navigate('background-session')
assert.equal(current, 'background-session')
await navigate('removed-session')
assert.equal(recovery, 1)
await navigate('task-snapshot')
assert.equal(recovery, 2)
assert.equal(listCalls, 2)
checks.push('new background task metadata is adopted; missing tasks and recovery notices open existing recovery UI')

let finishLookup
listResult = new Promise((resolveLookup) => { finishLookup = resolveLookup })
const pending = navigate('slow-session')
navigationKey = 'manual-navigation'
finishLookup([{ id: 'slow-session' }]); await pending
assert.equal(current, 'background-session')
assert.equal(sessions.has('slow-session'), false)
listResult = Promise.reject(new Error('offline lookup'))
await navigate('unknown-session')
assert.equal(recovery, 3)
checks.push('slow lookup cannot override later user navigation; lookup failure still exposes recovery')

emit({ kind: 'turn-result', isError: false })
emit({ kind: 'turn-result', isError: false })
assert.equal(notices.length, 5)
assert.equal(focusCount, 4)
checks.push('terminal event remains deduplicated and creating notifications never steals task focus')
console.log(`Desktop notification navigation: ${checks.length}/${checks.length} passed\n${checks.join('\n')}\nProvider calls: 0`)
