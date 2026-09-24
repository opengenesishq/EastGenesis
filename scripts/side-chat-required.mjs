import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Module } from 'node:module'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'caogen-side-chat-'))
const cwd = join(root, 'workspace'); mkdirSync(cwd)
writeFileSync(join(cwd, 'README.md'), 'Frozen local project fact.\n')
const active = new Map(), history = [], transcripts = new Map(), accepted = new Set()
const creates = [], sends = []
let api, inputs, unknown = false, checks = 0
const pass = name => { checks++; console.log(`PASS ${name}`) }
const providers = [
  { id: 'fixture', name: 'Cloud fixture', engine: 'openai', baseUrl: 'https://example.invalid/v1' },
  { id: 'local', name: 'Local fixture', engine: 'openai', baseUrl: 'http://127.0.0.1:12345/v1' }
]
const fixture = { root, history, providers, inputs: () => inputs, manager: {
  whenInitialized: async () => {},
  get: id => active.has(id) ? { meta: active.get(id) } : undefined,
  getTranscript: id => transcripts.get(id) ?? [],
  createManaged: async (options, lifecycle) => {
    creates.push({ options, lifecycle })
    assert.equal(options.isolated, false)
    assert.equal(lifecycle.awaitStart, true)
    const draft = api.prepareIdentifiedSessionDraft({ options, reservedSessionId: lifecycle.reservedSessionId, hasSession: id => active.has(id) })
    const identity = await api.prepareSessionIdentityForActivation(draft.baseMeta, root, Boolean(options.resumeSdkSessionId))
    const meta = { ...identity, isolated: false, sdkSessionId: options.resumeSdkSessionId ?? `sdk-${draft.baseMeta.id}` }
    active.set(meta.id, meta)
    await api.saveTaskSnapshot(api.buildTaskSnapshot({ meta, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created' }), root)
    const session = { meta, start: async () => {
      const record = api.getSideChatRecord(root, meta.id)
      assert.equal(record.sessionCreatedAt, meta.createdAt)
      assert.equal(record.sdkSessionId, meta.sdkSessionId)
      api.assertSideChatBinding(meta, root)
      meta.status = 'idle'
    } }
    return api.completeManagedSessionInitialization({ meta, session, lifecycle,
      rollbackBeforeStart: async () => active.delete(meta.id),
      persistInitialized: async () => { history.splice(0, history.length, ...history.filter(item => item.id !== meta.id), structuredClone(meta)) },
      acknowledge: () => {} })
  },
  interrupt: async () => {},
  close: async id => { active.delete(id) }
} }
globalThis.__sideChatFixture = fixture

try {
  const stubs = {
    electron: 'module.exports = { app: { getPath: () => globalThis.__sideChatFixture.root, isPackaged: false }, BrowserWindow: {} }',
    providers: 'module.exports = { listProviders: () => globalThis.__sideChatFixture.providers, getProvider: id => globalThis.__sideChatFixture.providers.find(p => p.id === id), providerIsReady: () => true, resolveProviderEngine: p => p.engine }',
    settings: 'module.exports = { getSettings: () => ({ defaultProviderId: "fixture", defaultModel: "fixture-model", driveMode: "balanced", defaultTaskStrategy: "execute", failoverEnabled: true }) }',
    sessionManager: 'module.exports = { sessionManager: globalThis.__sideChatFixture.manager }',
    history: 'module.exports = { listHistory: () => globalThis.__sideChatFixture.history }',
    projects: 'module.exports = { getProject: id => ({ id }), touchProject: () => { throw new Error("Side chat must not create a new legacy project") } }',
    'session-input-runtime': 'module.exports = { getSessionInputService: () => globalThis.__sideChatFixture.inputs() }',
    'session-runtime-routing': 'module.exports = { resolveCreationModelRoute: ({providerId}) => ({providerId}), sessionBusinessLine: ({opts,history}) => opts.businessLineId ?? history?.businessLineId }',
    'business-line-execution-policy': 'module.exports = { assertBusinessLineTaskStrategy: () => {} }',
    'worktree-operation-handlers': 'module.exports = { executeManagedWorktreeCreateEffect: () => { throw new Error("No worktree effect in side chat") } }',
    'operation-effect-gateway': 'module.exports = { executeInteractiveOperationEffect: () => { throw new Error("No effects in side chat") } }',
    'workspace-handoff': 'module.exports = { restoreWorkspaceHandoff: meta => meta, workspaceHandoffAllowsLocal: () => false }',
    worktrees: 'module.exports = { inspectManagedWorktreeRegistryRecord: () => ({}), inspectManagedWorktreeIdentity: () => ({}), prepareWorktree: () => { throw new Error("unused") }, prepareManagedWorktreeCreateEffect: () => { throw new Error("unused") } }',
    'acceptance-quality-feedback': 'module.exports = { scheduleModelRouteObservationRefresh: () => {}, scheduleAcceptanceQualityFeedbackRefresh: () => {} }',
    'session-creation-journal': 'module.exports = { listPendingSessionCreations: () => [] }'
  }
  const bundle = await build({ stdin: { contents: `
    export * from './src/main/side-chat/side-chat-service';
    export * from './src/main/side-chat/side-chat-store';
    export * from './src/main/side-chat/side-chat-policy';
    export * from './src/main/session-creation-identity';
    export * from './src/main/session-create-lifecycle';
    export * from './src/main/session-managed-initialization';
    export * from './src/main/session-execution-ownership';
    export * from './src/main/session-domain-activation';
    export { managedTaskRunSendGateError } from './src/main/session-manager-support';
    export { buildTaskSnapshot, saveTaskSnapshot, getTaskSnapshot } from './src/main/task/task-snapshot';
    export { createSessionTaskRun, transitionTaskRun } from './src/main/task/task-run';
    export * from './src/main/project-workspace/outbound-context-policy';
    export * from './src/main/task/workflow-run-canonical-binding';
    export { ensureSupervisorRunBinding } from './src/main/task/supervisor-taskrun-bridge';
    export { ProjectWorkspaceStore } from './src/main/project-workspace/store';
    export { SessionInputService } from './src/main/task/session-input-service';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'offline-runtime', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        const key = args.path.split('/').at(-1)
        if (Object.hasOwn(stubs, key)) return { path: key, namespace: 'fixture' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'js' }))
    } }] })
  const filename = resolve('scripts/.side-chat-fixture.cjs'), module = new Module(filename)
  module.filename = filename; module.paths = Module._nodeModulePaths(dirname(filename)); module._compile(bundle.outputFiles[0].text, filename)
  api = module.exports
  inputs = new api.SessionInputService(root, {
    meta: id => active.get(id),
    accepted: async receipt => accepted.has(receipt.messageId),
    send: async (id, payload) => {
      const meta = active.get(id)
      assert.equal(api.managedTaskRunSendGateError(meta, false, null), undefined)
      await api.assertPersistedSessionExecutionAllowed(meta, root)
      const outbound = await api.prepareOutboundContext({ meta, rootDir: root, payload })
      await api.assertOutboundContextAllowed({ manifest: outbound.manifest, rootDir: root, providerId: meta.providerId, model: meta.model, engine: meta.engine })
      const run = api.createSessionTaskRun(meta)
      assert.equal((await api.ensureSupervisorRunBinding(meta, run, { rootDir: root })).disposition, 'unscoped')
      await api.saveTaskSnapshot(api.buildTaskSnapshot({ meta, run: api.transitionTaskRun(run, 'completed'), transcript: [], lastSeq: 0, eventCount: 0, reason: 'important-event' }), root)
      sends.push({ id, payload })
      if (unknown) throw new Error('Fixture lost acknowledgement after dispatch')
      accepted.add(payload.messageId)
      return true
    }
  })
  const store = await new api.ProjectWorkspaceStore(root).open()
  let workspace = await store.createWorkspace({ id: 'side-project', name: 'Side fixture', resources: [
    { id: 'files', kind: 'directory', path: cwd, label: 'Project docs', dataClass: 'S2', egressPolicy: 'allow' }
  ] })
  const goal = await store.createGoal({ id: 'source-goal', projectId: workspace.id, title: 'Original goal', objective: 'Preserve original task progress' })
  const item = await store.createWorkItem({ id: 'source-work', projectId: workspace.id, goalId: goal.id, title: 'Original work' })
  const source = { id: 'source-session', sdkSessionId: 'source-sdk', createdAt: 1, title: 'Original task', cwd, status: 'running',
    projectId: 'legacy-project', workspaceId: workspace.id, goalId: goal.id, workItemId: item.id,
    providerId: 'fixture', model: 'fixture-model', engine: 'openai', routingScope: 'fixed', taskStrategy: 'execute', permissionMode: 'acceptEdits' }
  source.routingControl = { kind: 'locked', target: { providerId: 'fixture', model: 'fixture-model' } }
  active.set(source.id, source)
  const service = api.sideChatService
  const [created, same] = await Promise.all([1, 2].map(() => service.create({ sourceSessionId: source.id, requestId: 'create-one' })))
  assert.equal(creates.length, 1); assert.equal(created.id, same.id)
  const meta = active.get(created.id), record = api.getSideChatRecord(root, created.id)
  assert.equal(creates[0].lifecycle.reservedSessionId, created.id)
  assert.equal(record.id, meta.id); assert.equal(record.sessionId, meta.id)
  assert.equal(meta.projectId, source.projectId); assert.equal(meta.workspaceId, source.workspaceId)
  assert.equal(meta.goalId, undefined); assert.equal(meta.workItemId, undefined)
  assert.deepEqual(meta.routingControl, source.routingControl)
  assert.equal(record.snapshot.source.goalId, goal.id); assert.equal(record.snapshot.source.workItemId, item.id)
  assert.equal(source.status, 'running')
  pass('concurrent creation reserves one actual lifecycle identity before engine start; original Goal remains provenance')

  const run = { id: 'side-run', sessionId: meta.id }
  assert.equal((await api.bindWorkflowRunToCanonicalWorkItem(meta, run, root)).disposition, 'unscoped')
  await api.assertPersistedSessionExecutionAllowed(meta, root)
  await assert.rejects(api.assertPersistedSessionExecutionAllowed({ id: 'ordinary', workspaceId: workspace.id }, root), /WorkItem does not exist/)
  assert.deepEqual((await store.getWorkItem(item.id)).runRefs, [])
  await assert.rejects(api.resolveWorkflowRunCanonicalWorkItem({ id: 'ordinary', workspaceId: workspace.id }, { id: 'ordinary-run', sessionId: 'ordinary' }, root), /requires workspaceId and workItemId/)
  await assert.rejects(api.resolveWorkflowRunCanonicalWorkItem(meta, { ...run, sessionId: 'foreign' }, root), /crosses session/)
  pass('verified side Runs remain unscoped; ordinary incomplete ownership and cross-session Runs are still rejected')

  const first = await service.send({ sideChatId: created.id, requestId: 'message-one', text: 'Explain the current plan.' })
  assert.equal(first.input.phase, 'applied')
  assert.equal((await api.getTaskSnapshot(created.id, root)).meta.id, created.id)
  assert.deepEqual((await store.getWorkItem(item.id)).runRefs, [])
  await service.send({ sideChatId: created.id, requestId: 'message-one', text: 'Explain the current plan.' })
  assert.equal(sends.length, 1)
  await assert.rejects(service.send({ sideChatId: created.id, requestId: 'message-one', text: 'Changed payload' }), /相同提交标识/)
  unknown = true
  const unclear = await service.send({ sideChatId: created.id, requestId: 'message-unknown', text: 'An unknown send outcome.' })
  assert.equal(unclear.input.phase, 'needs_reconciliation')
  await assert.rejects(service.send({ sideChatId: created.id, requestId: 'message-unknown', text: 'An unknown send outcome.' }), /核对/)
  assert.equal(sends.length, 2); unknown = false
  pass('actual durable SessionInput receipts deduplicate replay and refuse unknown-result redispatch')

  active.delete(meta.id)
  const restored = await service.get(created.id)
  const reopened = active.get(restored.id)
  assert.equal(reopened.id, meta.id); assert.equal(reopened.createdAt, meta.createdAt)
  assert.deepEqual(reopened.sideChat, meta.sideChat); assert.equal(reopened.taskStrategy, 'view')
  assert.equal(creates.at(-1).lifecycle.reservedSessionId, undefined)
  active.delete(meta.id)
  history.find(entry => entry.id === meta.id).sideChat = undefined
  const recovered = api.prepareIdentifiedSessionDraft({ options: { cwd, resumeSdkSessionId: meta.sdkSessionId }, hasSession: () => false })
  assert.equal(recovered.baseMeta.id, meta.id); assert.deepEqual(recovered.baseMeta.sideChat, meta.sideChat)
  assert.throws(() => api.prepareSessionCreationDraft({ cwd, forkFromSdkSessionId: meta.sdkSessionId }), /不能分叉/)
  assert.throws(() => api.prepareSessionCreationDraft({ cwd, resumeSdkSessionId: meta.sdkSessionId, taskStrategy: 'execute' }), /只读策略/)
  active.set(meta.id, reopened)
  pass('history reopen keeps identity, timestamp and read-only policy even if the history marker is missing; execution forks are refused')

  const stripped = api.boundedSideChatBody(meta, { messages: [], tools: [{ type: 'function' }], tool_choice: 'auto', mcp_servers: [{}], parallel_tool_calls: true }, root)
  assert.deepEqual(stripped, { messages: [] })
  assert.throws(() => api.boundedSideChatBody({ ...meta, sideChat: undefined }, {}, root), /身份缺失/)
  pass('last-mile Provider overrides cannot add tools or erase a persisted side-chat identity')

  for (const policy of ['local_only', 'deny', 'S3']) {
    workspace = await store.updateWorkspace(workspace.id, { resources: [{ ...workspace.resources[0],
      dataClass: policy === 'S3' ? 'S3' : 'S2', egressPolicy: policy === 'S3' ? 'allow' : policy }] })
    const restricted = await service.create({ sourceSessionId: source.id, requestId: `policy-${policy}` })
    const restrictedMeta = active.get(restricted.id)
    const outbound = await api.prepareOutboundContext({ meta: restrictedMeta, rootDir: root, payload: { text: 'Discuss snapshot' } })
    assert(outbound.manifest.items.some(item => item.kind === 'conversation_context' && item.egressPolicy === (policy === 'S3' ? 'deny' : policy)))
    await assert.rejects(api.assertOutboundContextAllowed({ manifest: outbound.manifest, rootDir: root, providerId: 'fixture', model: 'fixture-model' }), /外发策略/)
    if (policy === 'local_only') {
      const local = await api.prepareOutboundContext({ meta: restrictedMeta, rootDir: root, providerId: 'local', payload: { text: 'Discuss locally' } })
      await api.assertOutboundContextAllowed({ manifest: local.manifest, rootDir: root, providerId: 'local', model: 'fixture-model' })
    }
  }
  await assert.rejects(api.frozenSideChatResourceContext(meta, root), /授权已变化/)
  await assert.rejects(service.send({ sideChatId: created.id, requestId: 'after-revocation', text: 'Should be blocked' }), /授权已变化/)
  assert.equal(sends.length, 2)
  pass('captured local-only, deny and S3 policies enter the outbound gate; a later source-policy change blocks old snapshots before dispatch')

  source.status = 'closed'
  await assert.rejects(service.send({ sideChatId: created.id, requestId: 'closed-source', text: 'No source access' }), /原任务已关闭/)
  source.status = 'running'
  source.workItemId = 'moved-work'
  await assert.rejects(service.send({ sideChatId: created.id, requestId: 'moved-source', text: 'No changed ownership' }), /归属变化/)
  source.workItemId = item.id
  pass('closed or rebound source tasks cannot authorize another side-chat send')
  const looseSource = { ...source, id: 'unassigned-source', projectId: undefined, workspaceId: undefined, goalId: undefined, workItemId: undefined, unassigned: true }
  active.set(looseSource.id, looseSource)
  const loose = await service.create({ sourceSessionId: looseSource.id, requestId: 'unassigned-chat' })
  const looseMeta = active.get(loose.id)
  assert.equal(looseMeta.projectId, undefined); assert.equal(looseMeta.unassigned, true)
  looseMeta.status = 'running'
  await assert.rejects(service.send({ sideChatId: loose.id, requestId: 'busy-message', text: 'No concurrent send' }), /仍在运行/)
  assert.equal(sends.length, 2)
  looseMeta.status = 'idle'
  await service.close(loose.id)
  await assert.rejects(service.send({ sideChatId: loose.id, requestId: 'closed-message', text: 'No closed send' }), /已关闭/)
  pass('projectless side chats retain their scope; busy and closed conversations never auto-dispatch queued input')
  console.log(`side-chat-required: ${checks}/${checks}; real creation draft, initialization, stores and input receipts; engine and Provider I/O are offline fixtures`)
} finally { delete globalThis.__sideChatFixture; rmSync(root, { recursive: true, force: true }) }
