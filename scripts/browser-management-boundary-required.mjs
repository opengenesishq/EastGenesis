import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { dirname, resolve, join } from 'node:path'
import { Module } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'caogen-browser-management-boundary-')), fixture = '__browserManagementBoundary'
const outputs = join(root, 'outputs'); mkdirSync(outputs)
const handlers = new Map(), owners = new Map(), revealed = []
let choose, checks = 0
const pass = name => { checks++; console.log(`PASS ${checks}: ${name}`) }
const event = id => ({ sender: owners.get(id).webContents })
for (const [id, role, taskId] of [[1,'main'],[2,'task','task-one'],[3,'task','task-two']]) {
  const sender = { id, isDestroyed: () => false, send() {} }
  owners.set(id, { webContents: sender, role, taskId, isDestroyed: () => false })
}
const target = { contextId: 'task-one', tabId: 'tab-one', contextEpoch: 'epoch-one', selectionRevision: 1, navigationRevision: 1 }
let live = true
const manager = { assertWindowOwner(_id, owner) { if (owner !== owners.get(1) && owner !== owners.get(2)) throw new Error('owner') },
  assertTarget(value) { if (!live || JSON.stringify(value) !== JSON.stringify(target)) throw new Error('stale target') },
  getState() { return { url: 'https://fixture.invalid/page', ...target } } }
class Item extends EventEmitter {
  path; cancelled = false; bytes = 0
  constructor(url='https://fixture.invalid/file') { super(); this.url = url }
  getURL() { return this.url } getURLChain() { return [this.url] } getFilename() { return 'file.txt' }
  getTotalBytes() { return 7 } getReceivedBytes() { return this.bytes } setSavePath(path) { this.path = path }
  pause() {} resume() { writeFileSync(this.path, 'fixture'); this.bytes = 7; this.emit('done', {}, 'completed') }
  cancel() { this.cancelled = true; this.emit('done', {}, 'cancelled') }
}
globalThis[fixture] = {
  electron: { app: { getPath: name => name === 'downloads' ? outputs : root }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: { fromWebContents: sender => owners.get(sender.id), getAllWindows: () => [...owners.values()] },
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: await choose() }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { showItemInFolder: path => revealed.push(path) } }
}
try {
  const output = await build({ stdin: { contents: `export { browserManagement, BrowserManagementService } from './src/main/browser-management/service'; export { registerBrowserManagementIpc } from './src/main/ipc/browser-management-handlers'; export { BrowserManagementStore } from './src/main/browser-management/store';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', plugins: [{ name: 'fixture', setup(builder) {
    builder.onResolve({ filter: /^electron$|(?:^|\/)(?:workflow-ledger-handlers|desktop-window-registry|task-window)$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: {
      electron: `module.exports = globalThis.${fixture}.electron`,
      'workflow-ledger-handlers': 'module.exports = { assertTrustedWorkflowLedgerSender: event => { if (![1,2,3].includes(event.sender?.id)) throw new Error("untrusted") } }',
      'desktop-window-registry': 'module.exports = { desktopWindowRole: win => win.role }',
      'task-window': 'module.exports = { taskSessionForWindow: win => win.taskId }'
    }[args.path] }))
  } }] })
  const filename = resolve('scripts/.browser-management-boundary.cjs'), mod = new Module(filename)
  mod.filename = filename; mod.paths = Module._nodeModulePaths(dirname(filename)); mod._compile(output.outputFiles[0].text, filename)
  const { browserManagement, BrowserManagementService, registerBrowserManagementIpc, BrowserManagementStore } = mod.exports
  const service = browserManagement(), store = service.store
  registerBrowserManagementIpc({ manager, getSessionMeta: id => ['task-one','task-two'].includes(id) ? { id, status: 'idle' } : undefined })
  const invoke = (channel, id, ...args) => Promise.resolve().then(() => handlers.get(`browser-management:${channel}`)(event(id), ...args))
  const initial = await invoke('preferences', 1)
  await invoke('save', 1, { expectedRevision: initial.revision, preferences: { ...initial.preferences, recordHistory: true } })
  for (const [contextId, tabId] of [['task-one','tab-one'],['task-two','tab-two']]) store.recordVisit({ contextId, scopeKind: 'task', tabId, contextEpoch: 'epoch-one', navigationRevision: 1, url: 'https://fixture.invalid/path?secret=never-save', title: contextId })
  const mainList = await invoke('history', 1, { limit: 100 }), taskList = await invoke('history', 2)
  assert.equal(mainList.items.length, 2); assert.equal(taskList.items.length, 1); assert.equal(taskList.items[0].contextId, 'task-one')
  await assert.rejects(invoke('history', 2, { contextId: 'task-two' }), /其他任务/)
  await assert.rejects(invoke('save', 2, { expectedRevision: 1, preferences: initial.preferences }), /主工作台/)
  pass('main settings and task history are scoped to the correct window role')
  await assert.rejects(invoke('clear-history', 3, { clearToken: taskList.clearToken }), /过期/)
  store.recordVisit({ contextId: 'task-one', scopeKind: 'task', tabId: 'tab-one', contextEpoch: 'epoch-one', navigationRevision: 2, url: 'https://fixture.invalid/later', title: 'Later' })
  assert.equal((await invoke('clear-history', 2, { clearToken: taskList.clearToken })).removed, 1)
  assert.equal(store.listHistory().items.length, 2)
  await assert.rejects(invoke('clear-history', 2, { clearToken: taskList.clearToken }), /过期/)
  pass('clear token is one-use, owner-bound and only removes displayed snapshot ids')
  await assert.rejects(invoke('site-rule', 1, { target: { ...target, selectionRevision: 0 }, expectedRevision: 1, rule: 'block' }), /stale/)
  await assert.rejects(invoke('site', 3, target), /其他任务/)
  pass('current-site shortcut rejects stale selection and another task')
  let resolvePick
  choose = () => new Promise(resolve => { resolvePick = resolve })
  const tab = { contextId: 'task-one', tabId: 'tab-one', owner: owners.get(1), contents: { getURL: () => 'https://fixture.invalid/page', isDestroyed: () => false }, target: () => ({ ...target }), isCurrent: () => live, error() {} }
  const cancelled = new Item(), nativeEvent = { preventDefault() { throw new Error('unexpected block') } }
  service.downloads.begin(nativeEvent, cancelled, tab)
  const waiting = store.listDownloads()[0]
  assert.equal(waiting.state, 'awaiting-location'); assert.equal(readdirSync(outputs).length, 0)
  live = false; resolvePick(join(outputs, 'stale.txt')); await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled.cancelled, true); assert.equal(store.listDownloads()[0].state, 'cancelled'); assert.equal(readdirSync(outputs).length, 0)
  pass('late save dialog after context closes cannot publish a file')
  live = true
  const rulePending = new Item(); service.downloads.begin(nativeEvent, rulePending, tab)
  const latest = store.getPreferences()
  service.save(latest.revision, { ...latest.preferences, siteRules: [{ origin: 'https://fixture.invalid', access: 'allow', downloads: 'block' }] })
  resolvePick(join(outputs, 'revoked.txt')); await new Promise(resolve => setImmediate(resolve))
  assert.equal(rulePending.cancelled, true); assert.equal(store.listDownloads()[0].state, 'blocked'); assert.equal(readdirSync(outputs).length, 0)
  pass('revoking downloads cancels pending native save and rejects its late destination')
  const enabled = store.getPreferences(); service.save(enabled.revision, { ...enabled.preferences, siteRules: [] })
  choose = async () => join(outputs, 'existing.txt'); writeFileSync(join(outputs, 'existing.txt'), 'preserve me')
  service.downloads.begin(nativeEvent, new Item(), tab); await new Promise(resolve => setImmediate(resolve))
  assert.equal(readFileSync(join(outputs, 'existing.txt'), 'utf8'), 'preserve me'); assert.equal(store.listDownloads()[0].state, 'interrupted')
  pass('even an explicitly chosen existing destination is preserved without overwrite')
  choose = async () => join(outputs, 'finished.txt')
  service.downloads.begin(nativeEvent, new Item(), tab); await new Promise(resolve => setImmediate(resolve))
  const completed = store.listDownloads()[0]; assert.equal(completed.state, 'completed')
  await assert.rejects(invoke('download-control', 3, { id: completed.id, action: 'reveal' }), /不能访问/)
  await invoke('download-control', 2, { id: completed.id, action: 'reveal' }); assert.equal(revealed[0], completed.savePath)
  await invoke('download-control', 2, { id: completed.id, action: 'remove-record' }); assert.equal(readFileSync(completed.savePath, 'utf8'), 'fixture')
  pass('download actions enforce task scope and record removal preserves the output file')
  const corruptRoot = join(root, 'corrupt'); mkdirSync(corruptRoot); writeFileSync(join(corruptRoot, 'preferences.json'), '{bad')
  assert.throws(() => new BrowserManagementStore(corruptRoot, outputs).getPreferences(), /无法读取/)
  pass('unreadable policy fails closed instead of silently allowing websites')
  const badDownloads = join(root, 'bad-downloads'); mkdirSync(badDownloads); writeFileSync(join(badDownloads, 'downloads.json'), '{bad')
  const recovering = new BrowserManagementService(new BrowserManagementStore(badDownloads, outputs), { chooseFile: async () => undefined, reveal() {} })
  let prevented = false
  recovering.downloads.begin({ preventDefault() { prevented = true } }, new Item(), tab)
  assert.equal(prevented, true)
  pass('corrupt download metadata blocks downloads without crashing service startup')
  console.log(`Browser management focused boundaries: ${checks}/${checks} passed; native prompts/downloads simulated locally.`)
} finally { delete globalThis[fixture]; rmSync(root, { recursive: true, force: true }) }
