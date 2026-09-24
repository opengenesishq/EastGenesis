import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Module } from 'node:module'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'caogen-remote-task-commands-'))
const calls = { starts: [], restores: [], appends: [], controls: [] }
const active = [], history = [], inputs = new Map()
let api, checks = 0
const pass = name => { checks++; console.log(`PASS ${name}`) }
const fixture = {
  root,
  history,
  manager: {
    list: () => active,
    get: id => { const meta = active.find(item => item.id === id); return meta ? { meta } : undefined },
    create: async options => {
      calls.restores.push(options)
      const saved = history.find(item => item.sdkSessionId === options.resumeSdkSessionId)
      const meta = { ...saved, status: 'idle' }
      active.push(meta)
      return meta
    },
    controlSupervisorRun: async (store, request) => {
      calls.controls.push(request)
      const supervisorRun = request.action === 'pause' ? await store.pauseRun(request.runId, request.options)
        : request.action === 'cancel' ? await store.cancelRun(request.runId, request.options)
        : await store.resumeRun(request.runId, request.options)
      return { supervisorRun }
    }
  },
  start: async input => { calls.starts.push(input); return { sessionId: 'created-session' } },
  inputs: {
    queue: async (sessionId, id, payload) => {
      const key = `${sessionId}:${id}`
      if (!inputs.has(key)) inputs.set(key, { phase: 'queued', payload })
      return inputs.get(key)
    },
    apply: async (sessionId, id) => {
      const record = inputs.get(`${sessionId}:${id}`)
      if (record.phase !== 'applied') calls.appends.push({ sessionId, id, payload: record.payload })
      record.phase = 'applied'
      return record
    }
  }
}
globalThis.__remoteTaskFixture = fixture
const canonical = value => JSON.stringify(stable(value))
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
const keys = generateKeyPairSync('ed25519')
let sequence = 0
function signed(device, kind, scope, revision, payload, overrides = {}) {
  const createdAt = Date.now()
  const unsigned = { schemaVersion: 1, commandId: `command-${++sequence}`, issuerDeviceId: device.id, kind,
    scope: { artifactIds: [], dataClass: 'metadata_only', ...scope }, revision, createdAt, expiresAt: createdAt + 300000,
    payloadDigest: digest(payload ?? { kind, scope: { artifactIds: [], dataClass: 'metadata_only', ...scope }, revision }),
    ...(payload === undefined ? {} : { payload }), ...overrides }
  return { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), keys.privateKey).toString('base64') }
}

try {
  const bundle = await build({ stdin: { contents: `export * from './src/main/remote/store'; export * from './src/main/remote/executor'; export * from './src/main/ipc/remote-continuation-handlers'; export * from './src/main/remote/console-session-store'; export { ProjectWorkspaceStore } from './src/main/project-workspace/store'; export { SupervisorStateStore } from './src/main/task/supervisor-state';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'no-provider-runtime', setup(builder) {
      builder.onResolve({ filter: /^electron$|(?:^|\/)(?:providers|settings|sessionManager|history|session-input-runtime|goal-submission-runtime|session-creation-journal|acceptance-quality-feedback|workflow-ledger-handlers|webhook-server|routine-executor)$/ }, args => ({ path: args.path === 'electron' ? 'electron' : args.path.split('/').at(-1), namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: {
        electron: 'module.exports = { app: { getPath: () => globalThis.__remoteTaskFixture.root, isPackaged: false }, BrowserWindow: {} }',
        providers: 'module.exports = { listProviders: () => [], getProvider: () => undefined }',
        settings: 'module.exports = { getSettings: () => ({}) }',
        sessionManager: 'module.exports = { sessionManager: globalThis.__remoteTaskFixture.manager }',
        history: 'module.exports = { listHistory: () => globalThis.__remoteTaskFixture.history }',
        'session-input-runtime': 'module.exports = { getSessionInputService: () => globalThis.__remoteTaskFixture.inputs }',
        'goal-submission-runtime': 'module.exports = { startProjectGoalTask: input => globalThis.__remoteTaskFixture.start(input) }',
        'session-creation-journal': 'module.exports = { listPendingSessionCreations: () => [] }',
        'acceptance-quality-feedback': 'module.exports = { scheduleModelRouteObservationRefresh: () => {}, scheduleAcceptanceQualityFeedbackRefresh: () => {} }',
        'workflow-ledger-handlers': 'module.exports = { assertTrustedWorkflowLedgerSender: () => {} }',
        'webhook-server': 'module.exports = { createRemotePairingSession: () => { throw new Error("No network in fixture") } }',
        'routine-executor': 'module.exports = { executeRoutine: () => { throw new Error("No provider in fixture") } }'
      }[args.path], loader: 'js' }))
    } }] })
  const filename = resolve('scripts/.remote-task-commands-fixture.cjs'), module = new Module(filename)
  module.filename = filename; module.paths = Module._nodeModulePaths(dirname(filename)); module._compile(bundle.outputFiles[0].text, filename)
  api = module.exports
  const workspaces = await new api.ProjectWorkspaceStore(root).open()
  const project = await workspaces.createWorkspace({ id: 'remote-project', name: 'Remote task fixture' })
  const goal = await workspaces.createGoal({ id: 'remote-goal', projectId: project.id, title: 'Goal', objective: 'Remote fixture' })
  const otherGoal = await workspaces.createGoal({ id: 'other-goal', projectId: project.id, title: 'Other', objective: 'Other fixture' })
  const item = await workspaces.createWorkItem({ id: 'remote-work', projectId: project.id, goalId: goal.id, title: 'Work', type: 'testing' })
  const store = api.getRemoteContinuationStore(root)
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const device = await api.handleRemoteContinuationIpc({}, 'register-device', { label: 'Phone', userId: 'fixture', publicKey, capabilities: ['view_results', 'create_task', 'control_work_item', 'resume_work_item'] })
  const limited = await store.registerDevice({ label: 'Read only', userId: 'fixture', publicKey, capabilities: ['view_results'] })
  const projectScope = { projectId: project.id }, workScope = { ...projectScope, goalId: goal.id, workItemId: item.id }
  const create = signed(device, 'create_task', projectScope, project.revision, { kind: 'create_task', objective: 'Create a report' })
  const forged = { ...create, payload: { ...create.payload, objective: 'Changed after signing' } }
  await assert.rejects(store.ingest(forged), /signature is invalid/)
  const digestMismatch = signed(device, 'create_task', projectScope, project.revision, create.payload, { payloadDigest: '0'.repeat(64) })
  await assert.rejects(store.ingest(digestMismatch), /payload digest/)
  pass('task payload is authenticated by both Ed25519 signature and digest')
  for (const [kind, scope, revision, payload] of [
    ['create_task', projectScope, project.revision, create.payload],
    ['append_task', workScope, item.revision, { kind: 'append_task', text: 'More detail', clientRequestId: 'append-1' }],
    ['pause_work_item', workScope, item.revision, { kind: 'pause_work_item' }],
    ['cancel_work_item', workScope, item.revision, { kind: 'cancel_work_item' }]
  ]) await assert.rejects(store.ingest(signed(limited, kind, scope, revision, payload)), /lacks capability/)
  pass('create, append, pause and cancel require their explicit device capability')
  await assert.rejects(store.ingest(signed(device, 'append_task', workScope, item.revision + 1, { kind: 'append_task', text: 'More', clientRequestId: 'stale' })), /revision is stale/)
  await assert.rejects(store.ingest(signed(device, 'append_task', { ...workScope, workItemId: 'foreign-work' }, item.revision, { kind: 'append_task', text: 'More', clientRequestId: 'foreign' })), /outside Project/)
  await assert.rejects(store.ingest(signed(device, 'append_task', { ...workScope, goalId: otherGoal.id }, item.revision, { kind: 'append_task', text: 'More', clientRequestId: 'wrong-goal' })), /outside Goal/)
  await assert.rejects(store.ingest(signed(device, 'create_task', { projectId: 'missing-project' }, 1, create.payload)), /project|Project/)
  pass('stale revision and wrong Project, Goal or WorkItem are rejected')
  for (const payload of [{ ...create.payload, businessLineId: '../../secrets' }, { ...create.payload, permissionMode: 'bypassPermissions' }]) {
    await assert.rejects(store.ingest(signed(device, 'create_task', projectScope, project.revision, payload)), /businessLineId|unsupported fields/)
  }
  await assert.rejects(store.ingest(signed(device, 'pause_work_item', { ...workScope, dataClass: 'artifact_summary' }, item.revision, { kind: 'pause_work_item' })), /metadata_only/)
  pass('invalid business identity, permission overrides and control data scope are rejected')
  const created = await api.handleRemoteContinuationIpc({}, 'ingest-command', create)
  assert.equal(created.execution.status, 'succeeded')
  assert.equal(calls.starts.length, 1)
  assert.equal(calls.starts[0].requestId, `remote-${create.commandId}`)
  await api.handleRemoteContinuationIpc({}, 'ingest-command', create)
  await api.executeRemoteCommand(root, create.commandId)
  assert.equal(calls.starts.length, 1)
  pass('signed create enters the canonical goal starter once, including IPC and replay')
  active.push({ id: 'active-session', workspaceId: project.id, goalId: goal.id, workItemId: item.id, status: 'idle' })
  const append = signed(device, 'append_task', workScope, item.revision, { kind: 'append_task', text: 'Add source citations', clientRequestId: 'append-1' })
  await store.ingest(append)
  await Promise.all([api.executeRemoteCommand(root, append.commandId), api.executeRemoteCommand(root, append.commandId)])
  await api.executeRemoteCommand(root, append.commandId)
  assert.equal(calls.appends.length, 1)
  assert.equal(calls.appends[0].payload.text, 'Add source citations')
  assert.equal((await store.getCommand(append.commandId)).execution.runId, 'active-session')
  pass('concurrent append and replay enter SessionInputService once with a durable Session binding')
  active.length = 0
  history.push({ id: 'historical-session', workspaceId: project.id, goalId: goal.id, workItemId: item.id, sdkSessionId: 'historical-sdk', cwd: root })
  const historicalAppend = signed(device, 'append_task', workScope, item.revision, { kind: 'append_task', text: 'Continue history', clientRequestId: 'append-history' })
  await store.ingest(historicalAppend)
  assert.equal((await api.executeRemoteCommand(root, historicalAppend.commandId)).execution.status, 'succeeded')
  assert.equal(calls.restores[0].resumeSdkSessionId, 'historical-sdk')
  assert.equal(calls.appends.at(-1).sessionId, 'historical-session')
  pass('a unique saved task resumes its SDK conversation before applying the new request')
  const supervisor = new api.SupervisorStateStore(root)
  const run = await supervisor.createRun({ id: 'supervisor-run', projectId: project.id, goalId: goal.id, workItemId: item.id })
  const ownerId = `remote-device:${device.id}`
  const leased = await supervisor.acquireLease(run.id, { ownerId, expectedRevision: run.revision })
  await supervisor.startRun(run.id, { ownerId, leaseId: leased.lease.id, fencingToken: leased.lease.fencingToken, expectedRevision: leased.revision })
  const pause = signed(device, 'pause_work_item', workScope, item.revision, { kind: 'pause_work_item' })
  await store.ingest(pause)
  assert.equal((await api.executeRemoteCommand(root, pause.commandId)).execution.status, 'succeeded')
  assert.equal((await supervisor.getRun(run.id)).status, 'paused')
  assert.equal(calls.controls.at(-1).action, 'pause')
  pass('pause refreshes the same device lease and reaches the Session control boundary')
  const cancel = signed(device, 'cancel_work_item', workScope, item.revision, { kind: 'cancel_work_item', reason: 'User cancelled' })
  await store.ingest(cancel)
  assert.equal((await api.executeRemoteCommand(root, cancel.commandId)).execution.status, 'succeeded')
  assert.equal((await supervisor.getRun(run.id)).status, 'cancelled')
  const count = calls.controls.length
  await api.executeRemoteCommand(root, cancel.commandId)
  assert.equal(calls.controls.length, count)
  pass('cancel reaches the Session control boundary and replay does not cancel twice')
  const pending = signed(device, 'append_task', workScope, item.revision, { kind: 'append_task', text: 'Must not run', clientRequestId: 'revoked' })
  await store.ingest(pending); await store.claimCommandExecution(pending.commandId)
  const token = 'a'.repeat(32), sessions = new api.RemoteConsoleSessionStore(root)
  sessions.put(token, { expiresAt: Date.now() + 100000, deviceId: device.id, projectId: project.id })
  await api.handleRemoteContinuationIpc({}, 'unbind-device', device.id)
  assert.equal(sessions.get(token), undefined)
  assert.equal((await api.executeRemoteCommand(root, pending.commandId)).status, 'rejected')
  assert.equal(calls.appends.length, 2)
  pass('unbind erases console access and stops a previously claimed command before dispatch')
  console.log(`remote-task-commands-required: ${checks}/${checks}; no Provider calls or network listeners; local execution boundaries are stubbed`)
} finally {
  delete globalThis.__remoteTaskFixture
  rmSync(root, { recursive: true, force: true })
}
