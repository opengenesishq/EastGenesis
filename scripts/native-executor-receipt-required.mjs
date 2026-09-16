import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Module } from 'node:module'
import { build } from 'esbuild'
import initSqlJs from 'sql.js'
import JSZip from 'jszip'

// Real wrappers and stores; physical transport, desktop, and configured Provider metadata are fixture boundaries.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-executor-receipt-')))
const key = '__caogenExecutorReceiptFixture'
const state = { meta: undefined, starts: [], transportCalls: 0 }
const originalFetch = globalThis.fetch
let forbiddenNetworkCalls = 0
globalThis.fetch = async () => { forbiddenNetworkCalls++; throw new Error('Provider/network I/O forbidden') }
globalThis[key] = {
  electron: { app: { getPath: () => root, isPackaged: false }, BrowserWindow: {}, dialog: {} },
  sessionManager: { list: () => [state.meta] },
  provider: { id: 'fixture', name: 'Fixture', engine: 'openai', baseUrl: 'https://fixture.invalid', openaiProtocol: 'chat', authMode: 'none', models: ['model-dag'] }
}
const output = await build({ stdin: { contents: `
  export { OpenAIModelAttemptTracker } from './src/main/task/openai-model-attempt-runtime'
  export { AnthropicModelAttemptTracker } from './src/main/task/anthropic-model-attempt-runtime'
  export { GoogleGenAiRuntime } from './src/main/googleGenAiRuntime'
  export { createModelDagDecomposer } from './src/main/agent/model-dag-decomposer'
  export { beginPersistedModelAttempt } from './src/main/task/model-attempt-runtime'
  export { createNativeModelExecutorReceipt, normalizeModelExecutorReceipt } from './src/main/task/model-attempt-executor'
  export { startPersistedModelAttempt, completePersistedModelAttempt, queryPersistedModelAttempts, verifyPersistedModelAttemptLedger } from './src/main/task/model-attempt-api'
  export { verifyModelAttemptLedger, selectModelAttempts } from './src/main/task/model-attempt-store'
  export { openProjectWorkspaceStore } from './src/main/project-workspace/store'
  export { createProjectWorkspaceCommandService } from './src/main/project-workspace/command-service'
  export { buildTaskSnapshot, saveTaskSnapshot, readTaskSnapshotDatabase } from './src/main/task/task-snapshot'
  export { handleStudioResultIpc } from './src/main/ipc/studio-result-handlers'
  export { buildPortableDeliveryPackage } from './src/main/studio-result/studio-result-package'
  export { canonicalJson, digest } from './src/main/task/workflow-ledger-codec'
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', packages: 'external',
plugins: [{ name: 'executor-fixture-boundaries', setup(builder) {
  builder.onResolve({ filter: /^electron$|(?:^|\/)(?:sessionManager(?:\.js)?|history|providers|settings|anthropicEngine|session-input-runtime|session-creation-journal|workflow-ledger-handlers|acceptance-quality-feedback)$/ }, args =>
    ({ path: args.path === 'electron' ? 'electron' : args.path.split('/').at(-1).replace(/\.js$/, ''), namespace: 'executor-fixture-boundaries' }))
  builder.onLoad({ filter: /.*/, namespace: 'executor-fixture-boundaries' }, args => ({ loader: 'js', contents: {
    electron: `module.exports = globalThis.${key}.electron`,
    sessionManager: `module.exports = { sessionManager: globalThis.${key}.sessionManager }`,
    history: `module.exports = { listHistory: () => [] }`,
    settings: `module.exports = { getSettings: () => ({defaultProviderId:'fixture'}) }`,
    providers: `module.exports = { getProvider: () => globalThis.${key}.provider, providerIsReady: () => true, decryptProviderToken: () => '', providerAuthMode: () => 'none', providerCredentialHeaders: () => ({}) }`,
    anthropicEngine: `module.exports = { AnthropicEngine: class { constructor(meta, emit, resume, seq, dependencies) { this.fixtureRuntimeDependencies = dependencies } } }`,
    'session-input-runtime': `module.exports = { getSessionInputService: () => { throw new Error('unused') } }`,
    'session-creation-journal': `module.exports = { listPendingSessionCreations: () => [] }`,
    'workflow-ledger-handlers': `module.exports = { assertTrustedWorkflowLedgerSender: event => { if(event.sender.id !== 7) throw new Error('untrusted') } }`,
    'acceptance-quality-feedback': `module.exports = { scheduleModelRouteObservationRefresh: () => {}, scheduleAcceptanceQualityFeedbackRefresh: () => {} }`
  }[args.path] }))
} } ] })
const filename = resolve('scripts/.native-executor-receipt-fixture.cjs'), mod = new Module(filename)
mod.filename = filename; mod.paths = Module._nodeModulePaths(dirname(filename)); mod._compile(output.outputFiles[0].text, filename)
const api = mod.exports
const dependencies = {
  start: async input => { state.starts.push(structuredClone(input)); return api.startPersistedModelAttempt(input, root) },
  complete: (id, input) => api.completePersistedModelAttempt(id, input, root),
  getRetryAuthorization: async () => null
}
const signal = new AbortController().signal
const usage = { input: 2, output: 1, cacheRead: 0, cacheCreation: 0 }
const steps = []
let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`) }
try {
  state.meta = { id: 'executor-session', cwd: root, createdAt: 1, status: 'idle', taskStrategy: 'execute', businessLineId: 'studio',
    title: 'Executor receipts', providerId: 'unproven-current-provider', model: 'unproven-current-model', engine: 'openai', permissionMode: 'acceptEdits',
    costUsd: 500, usage, contextTokens: 0, workspaceId: 'project', goalId: 'goal', workItemId: 'work', childTaskId: 'work' }
  const workspace = await api.openProjectWorkspaceStore(root)
  await workspace.createWorkspace({ id: 'project', name: 'Executor receipts', kind: 'office' })
  const commands = api.createProjectWorkspaceCommandService(workspace, { rootDir: root })
  await commands.reconcileShadowProjection()
  await commands.createGoal({ id: 'goal', projectId: 'project', title: 'Report', objective: 'Report', status: 'running' })
  await commands.createWorkItem({ id: 'work', projectId: 'project', goalId: 'goal', title: 'Report', type: 'writing', status: 'verifying' })
  const run = { schemaVersion: 1, id: 'run', sessionId: state.meta.id, taskId: 'work', status: 'executing', revision: 1,
    attempt: 1, recoveryCount: 0, createdAt: 1, updatedAt: 2, startedAt: 1, steps, toolExecutions: [], effects: [] }
  await api.saveTaskSnapshot(api.buildTaskSnapshot({ meta: state.meta, run, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', now: 2 }), root)
  const item = await workspace.getWorkItem('work')
  await commands.updateWorkItem('work', { runRefs: ['run'] }, { expectedRevision: item.revision })
  const assertDurableBeforeTransport = async component => {
    const page = await api.queryPersistedModelAttempts({ runId: 'run' }, root)
    assert.ok(page.attempts.some(attempt => attempt.status === 'started' && attempt.executorReceipt?.component === component), component)
    state.transportCalls++
  }
  await check('actual OpenAI chat/responses and Anthropic wrappers persist receipt before transport', async () => {
    for (const protocol of ['openai.chat-completions', 'openai.responses']) {
      const tracker = new api.OpenAIModelAttemptTracker(dependencies)
      tracker.startTurn(protocol)
      await tracker.fetch({ run, providerId: 'fixture', model: `model-${protocol}`, protocol, url: 'https://fixture.invalid',
        init: { method: 'POST', body: '{}' }, signal, auth: {}, readUsage: () => usage,
        executeFetch: async () => { await assertDurableBeforeTransport('openai_engine'); return new Response('{}') }, consume: async response => response.json() })
    }
    const tracker = new api.AnthropicModelAttemptTracker(dependencies)
    tracker.startTurn('anthropic')
    await tracker.execute({ run, providerId: 'fixture', model: 'model-anthropic', endpoint: 'https://fixture.invalid', body: {}, signal, auth: {},
      operation: async () => { await assertDurableBeforeTransport('anthropic_engine'); return { usage } } })
  })
  await check('Google runtime constructor and DAG decomposer select their own executor component', async () => {
    const google = new api.GoogleGenAiRuntime({ ...state.meta, engine: 'gemini' }, () => {})
    const tracker = google.fixtureRuntimeDependencies.modelAttempts
    tracker.startTurn('google')
    await tracker.execute({ run, providerId: 'fixture', model: 'model-google', endpoint: 'https://fixture.invalid', body: {}, signal, auth: {},
      operation: async () => { await assertDurableBeforeTransport('google_genai_runtime'); return { usage } } })
    const decomposer = api.createModelDagDecomposer({ title: 'Report', prompt: 'Build report', providerId: 'fixture', model: 'model-dag' },
      { runId: 'run', requestId: 'dag-request' }, { attempt: dependencies,
        fetch: async () => { await assertDurableBeforeTransport('model_dag_decomposer'); return Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'Report', tasks: [{ id: 'report', title: 'Report', description: 'Write report', dependencies: [], role: 'general' }] }) } }] }) } })
    assert.equal((await decomposer.decompose()).tasks[0].id, 'report')
    assert.equal(state.transportCalls, 5)
  })
  let records
  await check('receipt survives completion, database rehydration and complete export; current Session cannot rewrite it', async () => {
    const page = await api.queryPersistedModelAttempts({ runId: 'run' }, root)
    records = page.attempts
    assert.equal(records.length, 5); assert.ok(records.every(attempt => attempt.status === 'succeeded'))
    const components = new Set(records.map(attempt => attempt.executorReceipt.component))
    assert.equal(components.size, 4)
    for (const attempt of records) {
      assert.equal(attempt.executorReceipt.executorVersion, JSON.parse(readFileSync('package.json')).version)
      assert.deepEqual(api.normalizeModelExecutorReceipt(attempt.executorReceipt, attempt), attempt.executorReceipt)
      const events = page.events.filter(event => event.attemptId === attempt.id)
      assert.equal(events.length, 2)
      for (const event of events) assert.deepEqual(event.payload.executorReceipt, attempt.executorReceipt)
    }
    const bytes = await api.readTaskSnapshotDatabase(root, db => db.export())
    const SQL = await initSqlJs(), rehydrated = new SQL.Database(bytes)
    try { assert.equal(api.verifyModelAttemptLedger(rehydrated).valid, true); assert.deepEqual(api.selectModelAttempts(rehydrated, { runId: 'run' }).attempts, records) }
    finally { rehydrated.close() }
    state.meta.model = 'changed-current-model'; state.meta.engine = 'gemini'
    const exported = await api.handleStudioResultIpc({ sender: { id: 7 } }, 'export', state.meta.id)
    assert.equal(exported.bundle.executionAudit.coverage.executors.status, 'complete')
    assert.equal(exported.bundle.executionAudit.coverage.executors.recorded, 1)
    assert.equal(exported.bundle.executionAudit.coverage.executors.total, 1)
    const projected = exported.bundle.executionAudit.items.filter(item => item.category === 'model_attempt')
    assert.deepEqual(new Set(projected.map(item => item.executorReceipt.component)), components)
    assert.ok(!exported.json.includes('changed-current-model'))
    const zip = await JSZip.loadAsync(await api.buildPortableDeliveryPackage(exported.bundle.snapshot, exported.json, exported.exportDigest, exported.bundle.executionAudit))
    const checklist = await zip.file('DELIVERY.md').async('string')
    for (const component of components) assert.ok(checklist.replaceAll('\\_', '_').includes(component), component)
  })
  await check('legacy rows remain absent and lower executor coverage without inventing history or expense', async () => {
    const legacy = await api.startPersistedModelAttempt({ id: 'legacy', commandId: 'legacy-start', requestId: 'legacy-request', runId: 'run',
      providerId: 'fixture', model: 'legacy-model', protocol: 'openai.responses', adapterVersion: 'legacy-adapter', contextDigest: 'a'.repeat(64), routeReason: 'Legacy fixture', startedAt: 3 }, root)
    await api.completePersistedModelAttempt(legacy.id, { commandId: 'legacy-complete', expectedRevision: legacy.revision, status: 'succeeded', outcome: 'success', costUsd: 0.01, completedAt: 4 }, root)
    const page = await api.queryPersistedModelAttempts({ runId: 'run' }, root)
    const old = page.attempts.find(attempt => attempt.id === 'legacy')
    assert.ok(!Object.hasOwn(old, 'executorReceipt')); assert.ok(page.events.filter(event => event.attemptId === 'legacy').every(event => !Object.hasOwn(event.payload, 'executorReceipt')))
    const exported = await api.handleStudioResultIpc({ sender: { id: 7 } }, 'export', state.meta.id)
    assert.equal(exported.bundle.executionAudit.coverage.executors.status, 'partial')
    assert.equal(exported.bundle.snapshot.cost.coverage, 'partial')
    assert.equal(exported.bundle.snapshot.cost.knownUsd, 0.01)
    assert.ok(!exported.bundle.executionAudit.items.find(item => item.entityId === 'legacy').executorReceipt)
  })
  await check('receipt identity, model pairing, unsupported data and ledger/event tampering are rejected', async () => {
    const first = records[0], receipt = first.executorReceipt
    assert.throws(() => api.normalizeModelExecutorReceipt({ ...receipt, arbitrary: 'raw-secret' }, first), /unsupported/)
    assert.throws(() => api.normalizeModelExecutorReceipt({ ...receipt, component: 'anthropic_engine' }, first), /incompatible/)
    assert.throws(() => api.normalizeModelExecutorReceipt(receipt, { ...first, model: 'different-model' }), /does not match/)
    const input = state.starts[0]
    const different = { ...input, model: 'different-model' }
    different.executorReceipt = api.createNativeModelExecutorReceipt('openai_engine', different)
    await assert.rejects(api.startPersistedModelAttempt(different, root), error => error.code === 'MODEL_ATTEMPT_COMMAND_CONFLICT')
    await api.readTaskSnapshotDatabase(root, db => {
      const edited = { ...first, executorReceipt: undefined }
      delete edited.executorReceipt; delete edited.recordDigest
      edited.recordDigest = api.digest(edited)
      db.run('UPDATE model_attempts SET payload = ?, record_digest = ? WHERE id = ?', [api.canonicalJson(edited), edited.recordDigest, first.id])
      assert.throws(() => api.verifyModelAttemptLedger(db), error => error.code === 'MODEL_ATTEMPT_LEDGER_CORRUPTION')
    })
    assert.equal((await api.verifyPersistedModelAttemptLedger(root)).valid, true, 'read-only fixture mutation must not persist')
  })
  await check('Attempt identity freezes before asynchronous retry resolution and rejects before transport on invalid receipt', async () => {
    let release, entered
    const barrier = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { entered = resolve })
    const input = { runId: 'run', requestId: 'freeze-request', providerId: 'fixture', model: 'frozen-model', protocol: 'openai.responses', adapterVersion: 'freeze-adapter', context: {}, routeReason: 'Freeze fixture' }
    input.executorReceipt = api.createNativeModelExecutorReceipt('openai_engine', input)
    const pending = api.beginPersistedModelAttempt(input, { dependencies: { ...dependencies, getRetryAuthorization: async () => { entered(); await barrier; return null } } })
    await ready; input.model = 'mutated-after-begin'; input.executorReceipt = { ...input.executorReceipt, executorVersion: '9.0.0' }; release()
    const handle = await pending
    assert.equal(handle.attempt.model, 'frozen-model'); assert.notEqual(handle.attempt.executorReceipt.executorVersion, '9.0.0')
    await handle.succeed({ costUsd: 0 })
    const count = (await api.queryPersistedModelAttempts({ runId: 'run' }, root)).total
    await assert.rejects(api.beginPersistedModelAttempt({ ...input, requestId: 'bad-receipt' }, { dependencies }), /persistence failed/)
    assert.equal((await api.queryPersistedModelAttempts({ runId: 'run' }, root)).total, count)
    assert.equal(state.transportCalls, 5)
  })
  assert.equal(forbiddenNetworkCalls, 0)
  console.log(`native-executor-receipt-required: ${passed}/${passed}; native wrappers -> durable attempts -> audit -> ZIP; no Provider I/O`)
} finally { globalThis.fetch = originalFetch; delete globalThis[key]; rmSync(root, { recursive: true, force: true }) }
