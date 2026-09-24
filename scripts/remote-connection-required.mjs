import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Module } from 'node:module'
import { createServer } from 'node:http'
import { build } from 'esbuild'

// Exercise the production listener, settings and credential persistence with temporary data.
// Model execution and project membership are fixtures; this never opens a non-loopback socket.
const root = mkdtempSync(join(tmpdir(), 'caogen-remote-connection-'))
const envNames = ['CAOGEN_ENABLE_REMOTE_CONTINUATION', 'CAOGEN_REMOTE_WEBHOOK_HOST', 'CAOGEN_REMOTE_WEBHOOK_PORT', 'CAOGEN_REMOTE_WEBHOOK_ADVERTISE_HOST', 'CAOGEN_REMOTE_WEBHOOK_TLS_CERT', 'CAOGEN_REMOTE_WEBHOOK_TLS_KEY']
const savedEnv = Object.fromEntries(envNames.map(key => [key, process.env[key]]))
for (const key of envNames) delete process.env[key]
const handlers = new Map(), devices = [], appEvents = new Map(), powerBlocks = new Map()
let nextPowerBlock = 0
const powerSaveBlocker = { start(type) { const id = ++nextPowerBlock; powerBlocks.set(id, type); return id }, stop(id) { powerBlocks.delete(id) }, isStarted(id) { return powerBlocks.has(id) } }
globalThis.__remoteConnectionFixture = { root, handlers, devices, appEvents, powerSaveBlocker,
  store: {
    async registerDevice(input) { const device = { ...input, id: `device-${devices.length + 1}`, publicKeyFingerprint: 'fixture', status: 'active' }; devices.push(device); return device },
    async unbindDevice(id) { devices.find(item => item.id === id).status = 'revoked' },
    async getSnapshot() { return { devices } }
  }
}
let api, blocker, checks = 0
const pass = label => { checks++; console.log(`PASS ${label}`) }
try {
  const result = await build({ stdin: { contents: `export * from './src/main/remote/connection-controller'; export * from './src/main/remote/webhook-server'; export * from './src/main/remote/console-session-store'; export * from './src/shared/remote-connection-types';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'isolated-remote-dependencies', setup(builder) {
      const mocks = {
        electron: 'export const app = { getPath: () => globalThis.__remoteConnectionFixture.root, once: (event, callback) => globalThis.__remoteConnectionFixture.appEvents.set(event, callback) }; export const ipcMain = { handle: (name, fn) => globalThis.__remoteConnectionFixture.handlers.set(name, fn) }; export const powerSaveBlocker = globalThis.__remoteConnectionFixture.powerSaveBlocker;',
        'workflow-ledger-handlers': 'export const assertTrustedWorkflowLedgerSender = event => { if (!event.trusted) throw new Error("untrusted") };',
        sessionManager: 'export const sessionManager = { whenInitialized: async () => {} };',
        reconciler: 'export const startRemoteContinuationReconciler = () => {}; export const stopRemoteContinuationReconciler = () => {};',
        executor: 'export const executeRemoteCommand = () => { throw new Error("No model execution in connection fixture") };',
        store: 'export const getRemoteContinuationStore = () => globalThis.__remoteConnectionFixture.store;',
        'project-aggregate': 'export const createProductionProjectAggregateService = () => ({ verifyLiveProject: async id => { if (id !== "project-1") throw new Error("missing project"); return {} } });',
        routineStore: 'export const listRoutines = async () => [];',
        'supervisor-state': 'export class SupervisorStateStore {}',
        'created-task-projection': 'export const inspectRemoteCreatedTask = async () => undefined;',
        'workspace-runtime': 'export const readBoundRemoteWorkspace = () => { throw new Error("No workspace execution in connection fixture") }; export const remoteApprovalCandidates = async () => [];',
        'task-handoff-service': 'export const handleTaskHandoffRemote = () => { throw new Error("No task migration in connection fixture") };'
      }
      builder.onResolve({ filter: /\/task-handoff\/service$/ }, () => ({ path: 'task-handoff-service', namespace: 'fixture' }))
      builder.onResolve({ filter: /^electron$|(?:^|\/)(?:workflow-ledger-handlers|sessionManager|reconciler|executor|store|project-aggregate|routineStore|supervisor-state|created-task-projection|workspace-runtime)$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }))
    } }] })
  const filename = resolve('scripts/.remote-connection-fixture.cjs'), module = new Module(filename)
  module.filename = filename; module.paths = Module._nodeModulePaths(dirname(filename)); module._compile(result.outputFiles[0].text, filename)
  api = module.exports
  api.registerRemoteConnectionIpc()
  const get = () => handlers.get('remote-connection:get')({ trusted: true })
  const save = input => handlers.get('remote-connection:save')({ trusted: true }, input)
  const defaults = api.DEFAULT_REMOTE_CONNECTION
  assert.equal(get().running, false)
  assert.throws(() => handlers.get('remote-connection:get')({ trusted: false }), /untrusted/)
  const legacy = { ...defaults }; delete legacy.keepAwake
  assert.equal(api.validateRemoteConnectionSettings(legacy).keepAwake, false)
  for (const patch of [{ host: '0.0.0.0' }, { host: '::' }, { port: -1 }, { port: 65536 }, { tlsCertPath: 'relative.pem' }, { advertisedHost: 'https://example.com' }, { enabled: 1 }, { keepAwake: 'yes' }]) {
    assert.throws(() => api.validateRemoteConnectionSettings({ ...defaults, enabled: true, ...patch }))
  }
  pass('settings reject unsafe listeners, invalid endpoints, paths and untrusted IPC')
  const first = await save({ ...defaults, enabled: true })
  assert.equal(first.running, true); assert.ok(first.settings.port > 0)
  const originalPort = first.settings.port
  assert.equal(JSON.parse(readFileSync(join(root, 'remote/connection.json'), 'utf8')).port, originalPort)
  assert.equal((await fetch(`${first.address}/unknown`)).status, 404)
  pass('loopback service starts from settings and persists the chosen port')
  const unrelatedBlocker = powerSaveBlocker.start('prevent-display-sleep')
  assert.equal(get().keepingAwake, false)
  await save({ ...get().settings, keepAwake: true })
  assert.equal(get().keepingAwake, true); assert.equal(powerBlocks.size, 2)
  assert.equal([...powerBlocks.values()].filter(type => type === 'prevent-app-suspension').length, 1)
  assert.equal(JSON.parse(readFileSync(join(root, 'remote/connection.json'), 'utf8')).keepAwake, true)
  get(); get(); assert.equal(powerBlocks.size, 2)
  await api.stopRemoteWebhookServer()
  assert.equal(get().keepingAwake, false); assert.equal(powerBlocks.size, 1); assert(powerBlocks.has(unrelatedBlocker))
  await api.initializeRemoteConnection()
  assert.equal(get().keepingAwake, true); assert.equal(powerBlocks.size, 2)
  await save({ ...get().settings, keepAwake: false })
  assert.equal(get().running, true); assert.equal(get().keepingAwake, false); assert.equal(powerBlocks.size, 1)
  await save({ ...get().settings, keepAwake: true })
  pass('remote wake preference persists, follows actual listener lifecycle and leaves task blockers untouched')
  const pair = await api.createRemotePairingSession({ projectId: 'project-1' })
  assert.equal((await fetch(pair.url)).status, 200)
  const body = { token: pair.token, label: 'Fixture phone', userId: 'fixture', publicKey: 'fixture-key' }
  const register = () => fetch(`${first.address}/remote/pair/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const pairResponses = await Promise.all([register(), register()])
  assert.deepEqual(pairResponses.map(value => value.status).sort(), [201, 400])
  const paired = await pairResponses.find(value => value.status === 201).json()
  assert.equal(devices.length, 1)
  const consoleToken = paired.consoleUrl.split('/').at(-1)
  assert.ok(!readFileSync(join(root, 'remote/console-sessions.json'), 'utf8').includes(consoleToken))
  assert.equal((await fetch(paired.consoleUrl)).status, 200)
  pass('pairing is single-use and stores only a digest of the console credential')
  const unusedPair = await api.createRemotePairingSession({ projectId: 'project-1' })
  await api.stopRemoteWebhookServer()
  await api.initializeRemoteConnection()
  assert.equal(get().settings.port, originalPort); assert.equal(get().running, true)
  assert.equal((await fetch(unusedPair.url)).status, 410)
  assert.equal((await fetch(paired.consoleUrl)).status, 200)
  assert.ok(new api.RemoteConsoleSessionStore(root).get(consoleToken))
  pass('restart preserves paired console URL and port, while discarding unused pairing links')
  await globalThis.__remoteConnectionFixture.store.unbindDevice(paired.deviceId)
  assert.equal((await fetch(paired.consoleUrl)).status, 410)
  new api.RemoteConsoleSessionStore(root).revokeDevice(paired.deviceId)
  assert.equal(new api.RemoteConsoleSessionStore(root).get(consoleToken), undefined)
  pass('device revocation invalidates the page and persisted bearer credential')
  const token = 'a'.repeat(32), sessions = new api.RemoteConsoleSessionStore(root)
  sessions.put(token, { deviceId: 'expiry', projectId: 'project-1', expiresAt: Date.now() - 1 })
  assert.equal(new api.RemoteConsoleSessionStore(root).get(token), undefined)
  pass('expired console credentials are rejected after storage reload')
  const disabled = await save({ ...get().settings, enabled: false })
  assert.equal(disabled.running, false); assert.equal(disabled.keepingAwake, false); assert.equal(powerBlocks.size, 1)
  process.env.CAOGEN_ENABLE_REMOTE_CONTINUATION = '1'
  await api.initializeRemoteConnection()
  assert.equal(get().running, false)
  pass('saved stop preference overrides legacy environment auto-start')
  blocker = createServer()
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve))
  const failed = await save({ ...defaults, enabled: true, keepAwake: true, port: blocker.address().port })
  assert.equal(failed.running, false); assert.match(failed.error, /EADDRINUSE/); assert.equal(failed.keepingAwake, false); assert.equal(powerBlocks.size, 1)
  await save({ ...defaults, enabled: false })
  pass('occupied port returns stopped state with an actionable error')
  await save({ ...defaults, enabled: true, keepAwake: true })
  assert.equal(get().keepingAwake, true)
  appEvents.get('before-quit')()
  assert.equal(get().keepingAwake, false); assert.equal(powerBlocks.size, 1); assert(powerBlocks.has(unrelatedBlocker))
  await api.stopRemoteWebhookServer()
  pass('application quit releases only its remote blocker and prevents reacquisition')
  console.log(`PASS ${checks}/${checks} remote connection checks (loopback only, temporary data, no Provider calls)`)
} finally {
  await api?.stopRemoteWebhookServer()
  if (blocker) await new Promise(resolve => blocker.close(resolve))
  for (const key of envNames) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key] }
  delete globalThis.__remoteConnectionFixture
  rmSync(root, { recursive: true, force: true })
}
