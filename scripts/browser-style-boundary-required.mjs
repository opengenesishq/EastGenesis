import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { Module } from 'node:module'
import { build } from 'esbuild'

const key = '__caogenBrowserStyleBoundary', handlers = new Map(), owners = new Map()
let checks = 0, capturedPort, ownerId = 1, closed = false
const pass = label => { checks++; console.log(`PASS ${checks}: ${label}`) }
for (const [id, role, taskId] of [[1,'main'],[2,'main'],[3,'task','task-one'],[4,'task','task-two'],[5,'companion']]) {
  owners.set(id, { role, taskId, webContents: { id, send() {} }, isDestroyed: () => false })
}
const target = { contextId: 'task-one', contextEpoch: 'epoch', tabId: 'tab', selectionRevision: 1, navigationRevision: 1 }
let current = { ...target }
const manager = {
  assertWindowOwner(_task, owner) { if (owner.webContents.id !== ownerId) throw new Error('owner mismatch') },
  assertTarget(value) { assert.deepEqual(value, current, 'stale target'); return { view: { webContents: { isLoadingMainFrame: () => false } } } }
}
globalThis[key] = {
  electron: { BrowserWindow: { fromWebContents: sender => owners.get(sender.id) }, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
  controller: { pick: async port => { capturedPort = port; return { cancelled: true } }, preview() {}, revert() {}, draft() {}, release() {} }
}
try {
  const output = await build({ stdin: { contents: `export { registerBrowserStyleIpc } from './src/main/ipc/browser-style-handlers'; export { appendPersistentComposerDraft, readComposerDraft, writeComposerDraft } from './src/renderer/src/store/composer-draft-persistence';`, loader: 'ts', resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', plugins: [{ name: 'style-fixture', setup(builder) {
      builder.onResolve({ filter: /^electron$|(?:^|\/)(?:workflow-ledger-handlers|desktop-window-registry|task-window|browserView)$|browser-style\/controller$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'style-fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'style-fixture' }, args => ({ loader: 'js', contents: {
        electron: `module.exports = globalThis.${key}.electron`,
        controller: `module.exports = { browserStyleController: globalThis.${key}.controller }`,
        browserView: 'module.exports = { browserViewManager: {} }',
        'workflow-ledger-handlers': 'module.exports = { assertTrustedWorkflowLedgerSender: event => { if (![1,2,3,4,5].includes(event.sender?.id)) throw new Error("untrusted") } }',
        'desktop-window-registry': 'module.exports = { desktopWindowRole: win => win.role }',
        'task-window': 'module.exports = { taskSessionForWindow: win => win.taskId }'
      }[args.path] }))
    } }] })
  const filename = resolve('scripts/.browser-style-boundary.cjs'), mod = new Module(filename)
  mod.filename = filename; mod.paths = Module._nodeModulePaths(dirname(filename)); mod._compile(output.outputFiles[0].text, filename)
  const api = mod.exports
  api.registerBrowserStyleIpc({ manager, getSessionMeta: id => id === 'task-one' || id.startsWith('workspace-browser:') ? { id, status: closed ? 'closed' : 'idle' } : undefined })
  const invoke = (id, input = { target, previewId: 'opaque-id' }) => Promise.resolve().then(() => handlers.get('browser-style:pick')({ sender: owners.get(id)?.webContents ?? { id } }, input))
  await invoke(1); assert.equal(capturedPort.ownerId, 1)
  for (const id of [2,4,5,6]) await assert.rejects(invoke(id))
  pass('IPC rejects another main window, another task, a companion and untrusted senders')
  closed = true; await assert.rejects(invoke(1), /当前任务/); closed = false
  await assert.rejects(invoke(1, { target: { ...target, contextId: 'workspace-browser:one' }, previewId: 'opaque-id' }), /当前任务/)
  await assert.rejects(invoke(1, { target: { ...target, navigationRevision: 0 }, previewId: 'opaque-id' }), /stale target/)
  pass('closed tasks, standalone browsing and stale document targets are refused')
  await invoke(1); current = { ...target, selectionRevision: 2 }; assert.throws(() => capturedPort.assertCurrent(), /stale target/)
  current = { ...target }; ownerId = 3; await invoke(3); assert.equal(capturedPort.ownerId, 3)
  ownerId = 1; assert.throws(() => capturedPort.assertCurrent(), /owner mismatch/)
  pass('detached task binding and ownership are checked again when a deferred operation runs')
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  api.writeComposerDraft(storage, 'task-one', 'User text already typed')
  const first = api.appendPersistentComposerDraft(storage, 'task-one', 'Preview revision 1', 'browser-style:preview-id:1')
  const repeated = api.appendPersistentComposerDraft(storage, 'task-one', 'Preview revision 1', 'browser-style:preview-id:1')
  assert.equal(first.text, 'User text already typed\n\nPreview revision 1'); assert.equal(repeated.duplicate, true)
  assert.equal(api.readComposerDraft(storage, 'task-one'), first.text)
  assert.equal(api.readComposerDraft(storage, 'task-two'), '')
  assert.throws(() => api.appendPersistentComposerDraft(storage, 'task-two', 'Wrong target', 'browser-style:preview-id:1'), /绑定其他任务/)
  pass('style delivery preserves typed text, stays in its task and is idempotent per preview revision')
  const broken = { ...storage, setItem() { throw new Error('disk full') } }
  assert.throws(() => api.appendPersistentComposerDraft(broken, 'task-one', 'Next revision', 'browser-style:preview-id:2'), /disk full/)
  assert.equal(api.readComposerDraft(storage, 'task-one'), first.text)
  pass('failed durable draft storage reports failure without claiming delivery')
  console.log(`Browser style scoped boundaries: ${checks}/${checks} passed; isolated IPC and draft fixture, no Provider calls.`)
} finally { delete globalThis[key] }
