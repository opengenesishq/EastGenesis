import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const checks = []
async function check(name, run) { await run(); checks.push(name); console.log(`PASS ${name}`) }
const captures = [], saved = [], ocrCalls = [], ipc = new Map()
let sessions = new Map([['task-a', { meta: { id: 'task-a', cwd: '/workspace/a', status: 'idle' } }]])
let sources = [], captureHook
const thumbnail = { isEmpty: () => false, getSize: () => ({ width: 1200, height: 800 }), resize() { return this }, toPNG: () => Buffer.from('fixture-image'), toDataURL: () => 'data:image/png;base64,Zml4dHVyZQ==' }
const fixtures = {
  electron: {
    BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '/fixture/user-data' },
    desktopCapturer: { getSources: async options => { captures.push(options); if (captureHook) captureHook(); return sources } },
    clipboard: { readText: () => 'fixture clipboard' }, dialog: {}, globalShortcut: {},
    ipcMain: { handle: (name, callback) => ipc.set(name, callback) }, systemPreferences: { getMediaAccessStatus: () => 'granted' }
  },
  attachments: { saveImageAttachmentBytes: async (data, root) => { saved.push({ data: data.toString(), root }); return { ok: true, id: 'image-1', path: `${root}/fixture.png`, hash: 'hash-1', mime: 'image/png', bytes: data.length, createdAt: '2026-09-17' } } },
  ocr: { ocrImage: async path => { ocrCalls.push(path); return { ok: true, text: 'fixture recognized text', engine: 'vision' } } },
  sessions: { sessionManager: { get: id => sessions.get(id) } },
  trust: { assertTrustedWorkflowLedgerSender: event => { if (!event?.trusted) throw new Error('untrusted') } }
}
const replacements = { electron: 'electron', '../attachmentOps': 'attachments', '../imageOcr': 'ocr', '../sessionManager': 'sessions', '../ipc/workflow-ledger-handlers': 'trust' }
const backendBundle = await build({ entryPoints: ['src/main/quickbar/index.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'isolated-quickbar', setup(builder) {
  builder.onResolve({ filter: /.*/ }, args => replacements[args.path] ? { path: replacements[args.path], namespace: 'fixture' } : undefined)
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: `module.exports = globalThis.fixtures[${JSON.stringify(args.path)}]`, loader: 'js' }))
} }] })
const context = vm.createContext({ fixtures, process: { platform: 'darwin' }, Buffer, require, module: { exports: {} }, console })
vm.runInContext(backendBundle.outputFiles[0].text, context)
const api = context.module.exports

await check('source enumeration requests no screenshot pixels or AX text', async () => {
  sources = [{ id: 'window:1:0', name: 'Fixture editor', thumbnail }]
  const result = await api.getQuickbarWindowContext('/workspace/a')
  assert.equal(result.windows.length, 1); assert.equal(result.current, undefined)
  assert.equal(captures.at(-1).thumbnailSize.width, 0); assert.equal(saved.length, 0)
})
await check('capture requires an explicit source without guessing another window', async () => {
  const before = captures.length
  assert.equal((await api.captureQuickbarScreenshot({ sessionId: 'task-a' })).ok, false)
  assert.equal(captures.length, before)
})
await check('renamed or vanished sources do not silently capture the screen', async () => {
  sources = [{ id: 'screen:1:0', name: 'Screen', thumbnail }, { id: 'window:1:0', name: 'Different document', thumbnail }]
  assert.equal((await api.captureQuickbarScreenshot({ sessionId: 'task-a', sourceId: 'window:1:0', expectedSourceName: 'Fixture editor' })).ok, false)
  assert.equal(saved.length, 0)
})
await check('screenshot, OCR and attachment are bound to the explicit task and source', async () => {
  sources = [{ id: 'window:1:0', name: 'Fixture editor', thumbnail }]
  const result = await api.captureQuickbarScreenshot({ sessionId: 'task-a', sourceId: 'window:1:0', expectedSourceName: 'Fixture editor', includeOcr: true, cwd: '/wrong-directory' })
  assert.equal(result.ok, true); assert.equal(result.sessionId, 'task-a')
  assert.equal(result.context.current.id, 'window:1:0'); assert.equal(result.context.cwd, '/workspace/a')
  assert.equal(saved.at(-1).root, '/fixture/user-data/attachments/task-a')
  assert.equal(ocrCalls.at(-1), result.payload.images[0].path)
  assert.match(result.payload.text, /fixture recognized text/); assert.ok(result.imagePreviews['image-1'])
})
await check('closed tasks are rejected before capture', async () => {
  sessions.get('task-a').meta.status = 'closed'; const before = captures.length
  assert.equal((await api.captureQuickbarScreenshot({ sessionId: 'task-a', sourceId: 'window:1:0', expectedSourceName: 'Fixture editor' })).ok, false)
  assert.equal(captures.length, before); sessions.get('task-a').meta.status = 'idle'
})
await check('task closure during capture prevents attachment delivery', async () => {
  captureHook = () => { sessions.get('task-a').meta.status = 'closed' }
  const before = saved.length
  assert.equal((await api.captureQuickbarScreenshot({ sessionId: 'task-a', sourceId: 'window:1:0', expectedSourceName: 'Fixture editor' })).ok, false)
  assert.equal(saved.length, before); captureHook = undefined; sessions.get('task-a').meta.status = 'idle'
})
await check('Quickbar IPC rejects untrusted callers before reading clipboard or capture', () => {
  api.registerQuickbarIpc()
  for (const name of ['quickbar:getState', 'quickbar:getWindowContext', 'quickbar:readClipboard', 'quickbar:captureScreenshot']) assert.throws(() => ipc.get(name)({ trusted: false }), /untrusted/)
})

const windowEvents = new EventTarget()
const frontendBundle = await build({ stdin: { contents: `export * from './src/renderer/src/store/quickbar-draft'; export * from './src/renderer/src/store/composer-draft-inbox';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'browser', format: 'cjs', write: false, plugins: [{ name: 'isolate-draft-persistence', setup(builder) {
  builder.onResolve({ filter: /composer-draft-persistence$/ }, () => ({ path: 'deleted', namespace: 'fixture' }))
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const COMPOSER_DRAFTS_DELETED_EVENT="drafts-deleted"; export const isDeletedComposerDraft = id => globalThis.deleted.has(id)', loader: 'js' }))
} }] })
const frontContext = vm.createContext({ window: windowEvents, Event, module: { exports: {} }, deleted: new Set(), console })
vm.runInContext(frontendBundle.outputFiles[0].text, frontContext)
const draft = frontContext.module.exports
let sends = 0
const state = { activeId: 'task-b', sessions: { 'task-a': { meta: { cwd: '/workspace/a', status: 'idle' } }, 'task-b': { meta: { cwd: '/workspace/b', status: 'idle' } } },
  createSession: async () => { state.sessions['task-new'] = { meta: { cwd: '/workspace/new', status: 'idle' } }; state.activeId = 'task-b'; return 'task-new' },
  selectSession: id => { state.activeId = id }, setView: () => {}, sendMessage: () => { sends++ } }
await check('current task target does not drift to the active task', async () => {
  assert.equal((await draft.ensureQuickbarSession(() => state, { target: 'current', sessionId: 'task-a' })).sessionId, 'task-a')
  await assert.rejects(() => draft.ensureQuickbarSession(() => state, { target: 'current' }))
})
await check('new target uses createSession return id despite concurrent selection', async () => {
  assert.equal((await draft.ensureQuickbarSession(() => state, { target: 'new', cwd: '/workspace/new' })).sessionId, 'task-new')
})
await check('draft receipt is delivered exactly once to its target and never sends', () => {
  draft.stageQuickbarPayload(() => state, 'task-a', { text: 'review me', images: [{ id: 'image-a' }] }, { 'image-a': 'data:image/png;base64,fixture' })
  assert.equal(draft.takeComposerDraftAdditions('task-b').length, 0)
  const additions = draft.takeComposerDraftAdditions('task-a')
  assert.equal(additions.length, 1); assert.equal(additions[0].payload.images[0].id, 'image-a')
  assert.equal(draft.takeComposerDraftAdditions('task-a').length, 0); assert.equal(sends, 0)
})
await check('closed or deleted target rejects draft attachment', async () => {
  state.sessions['task-a'].meta.status = 'closed'
  await assert.rejects(() => draft.ensureQuickbarSession(() => state, { target: 'current', sessionId: 'task-a' }))
  assert.throws(() => draft.stageQuickbarPayload(() => state, 'task-a', { text: 'no' }))
  state.sessions['task-a'].meta.status = 'idle'; frontContext.deleted.add('task-a')
  assert.throws(() => draft.stageQuickbarPayload(() => state, 'task-a', { text: 'no' }))
  assert.equal(draft.takeComposerDraftAdditions('task-a').length, 0)
})
await check('deleting a task clears an already pending receipt', () => {
  frontContext.deleted.delete('task-a')
  draft.stageQuickbarPayload(() => state, 'task-a', { text: 'pending' })
  frontContext.deleted.add('task-a'); windowEvents.dispatchEvent(new Event('drafts-deleted'))
  assert.equal(draft.takeComposerDraftAdditions('task-a').length, 0)
})
await check('same-task detached window keeps an independent draft inbox', () => {
  const otherContext = vm.createContext({ window: new EventTarget(), Event, module: { exports: {} }, deleted: new Set(), console })
  vm.runInContext(frontendBundle.outputFiles[0].text, otherContext)
  draft.stageQuickbarPayload(() => state, 'task-b', { text: 'main window draft' })
  assert.equal(otherContext.module.exports.takeComposerDraftAdditions('task-b').length, 0)
  assert.equal(draft.takeComposerDraftAdditions('task-b').length, 1)
})
await check('Quickbar store actions prepare drafts and do not call message execution', () => {
  const store = readFileSync('src/renderer/src/store.ts', 'utf8')
  const actions = store.slice(store.indexOf('  async sendQuickbarText(options)'), store.indexOf('  async interrupt(sessionId)'))
  assert.ok(actions.includes('stageQuickbarPayload')); assert.equal(/\.sendMessage\(/.test(actions), false)
})
console.log(`quickbar-draft-required: ${checks.length}/${checks.length} passed; isolated fixtures only, no real screenshot, clipboard, provider or settings access`)
