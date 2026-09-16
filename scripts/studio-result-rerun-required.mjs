import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Module } from 'node:module'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const restart = process.argv[2] === '--restart'
const temp = restart ? process.argv[3] : realpathSync(mkdtempSync(join(tmpdir(), 'caogen-rerun-')))
const key = '__caogenRerunFixture'
const state = { root: temp, sessions: new Map(), persisted: [], creates: 0, sends: 0, failCreate: false, unknownSend: false, accepted: [], inputs: undefined }
let networkCalls = 0
const oldFetch = globalThis.fetch
globalThis.fetch = async () => { networkCalls++; throw new Error('Provider/network calls forbidden') }
const boundary = {
  electron: { app: { getPath: () => state.root, isPackaged: false }, BrowserWindow: { getAllWindows: () => [] }, dialog: {} },
  sessionManager: {
    list: () => [...state.sessions.values()].map(value => value.meta), get: id => state.sessions.get(id),
    requireTaskExecutionAuthority: async id => { state.sessions.get(id).meta.taskExecutionAuthorityRequired = true },
    createManaged: async (options, lifecycle) => {
      state.creates++
      assert.equal(lifecycle.awaitStart, true)
      assert.match(lifecycle.reservedSessionId, /^[a-f0-9-]{36}$/)
      if (state.failCreate) throw new Error('fixture crash during managed creation')
      const meta = { ...state.sessions.get('parent').meta, ...options, id: lifecycle.reservedSessionId, createdAt: Date.now(), status: 'starting' }
      state.sessions.set(meta.id, { meta })
      await lifecycle.beforeStart(meta)
      assert.equal(meta.taskExecutionAuthorityRequired, true, 'restriction must exist before engine starts')
      meta.status = 'idle'
      state.persisted.push(meta)
      return { ...meta }
    }
  },
  listHistory: () => state.persisted,
  getSessionInputService: () => state.inputs,
  assertTrustedWorkflowLedgerSender: event => assert.equal(event.sender.id, 7)
}
globalThis[key] = boundary
const output = await build({ stdin: { contents: `
  export { handleStudioResultIpc } from './src/main/ipc/studio-result-handlers'
  export { openProjectWorkspaceStore } from './src/main/project-workspace/store'
  export { createProjectWorkspaceCommandService } from './src/main/project-workspace/command-service'
  export { buildTaskSnapshot, saveTaskSnapshot } from './src/main/task/task-snapshot'
  export { registerCanonicalProducedArtifact } from './src/main/task/artifact-production-boundary'
  export { createWorkflowArtifactEdge, verifyPersistedWorkflowLedger } from './src/main/task/workflow-ledger-api'
  export { SessionInputService } from './src/main/task/session-input-service'
  export { TaskExecutionAuthorityStore } from './src/main/permission/task-execution-authority-store'
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', packages: 'external',
  plugins: [{ name: 'rerun-runtime-boundaries', setup(builder) {
    builder.onResolve({ filter: /^electron$|(?:^|\/)(?:sessionManager(?:\.js)?|history|providers|session-input-runtime|session-creation-journal|workflow-ledger-handlers)$/ }, args =>
      ({ path: args.path === 'electron' ? 'electron' : args.path.split('/').at(-1).replace(/\.js$/, ''), namespace: 'rerun-runtime-boundaries' }))
    builder.onLoad({ filter: /.*/, namespace: 'rerun-runtime-boundaries' }, args => ({ loader: 'js', contents: {
      electron: `module.exports = globalThis.${key}.electron`,
      sessionManager: `module.exports = { sessionManager: globalThis.${key}.sessionManager }`,
      history: `module.exports = { listHistory: globalThis.${key}.listHistory }`,
      providers: `module.exports = { getProvider: () => ({ id: 'fixture', engine: 'openai' }), providerIsReady: () => true }`,
      'session-input-runtime': `module.exports = { getSessionInputService: globalThis.${key}.getSessionInputService }`,
      'session-creation-journal': `module.exports = { listPendingSessionCreations: () => [] }`,
      'workflow-ledger-handlers': `module.exports = { assertTrustedWorkflowLedgerSender: globalThis.${key}.assertTrustedWorkflowLedgerSender }`
    }[args.path] }))
  } }]
})
const filename = resolve('scripts/.rerun-fixture.cjs'), mod = new Module(filename)
mod.filename = filename; mod.paths = Module._nodeModulePaths(dirname(filename)); mod._compile(output.outputFiles[0].text, filename)
const api = mod.exports
const event = { sender: { id: 7 } }
const invoke = (action, input) => api.handleStudioResultIpc(event, action, 'parent', input)
function inputs() {
  state.inputs = new api.SessionInputService(state.root, {
    meta: id => state.sessions.get(id)?.meta,
    send: async (id, payload) => {
      state.sends++
      assert.equal(state.sessions.get(id).meta.status, 'idle')
      assert.match(payload.text, /目标：客户报告/)
      assert.match(payload.text, /约束：\n六页以内/)
      assert.match(payload.text, /保留并读取人工修改：[\s\S]*source.txt/)
      if (state.unknownSend) throw new Error('fixture unknown send result')
      state.accepted.push(payload.messageId)
      writeFileSync(join(state.root, 'fixture-accepted.json'), JSON.stringify(state.accepted))
      return true
    },
    accepted: async record => state.accepted.includes(record.messageId)
  })
}
async function setup(name) {
  state.root = join(temp, name); mkdirSync(state.root)
  state.sessions = new Map(); state.persisted = []; state.creates = 0; state.sends = 0; state.accepted = []
  state.failCreate = false; state.unknownSend = false; inputs()
  const meta = { id: 'parent', cwd: state.root, createdAt: 1, status: 'idle', taskStrategy: 'execute', businessLineId: 'studio',
    title: 'Report', providerId: 'fixture', model: 'fixture-model', engine: 'openai', permissionMode: 'acceptEdits',
    costUsd: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0, workspaceId: 'project', goalId: 'goal' }
  state.sessions.set(meta.id, { meta })
  const workspace = await api.openProjectWorkspaceStore(state.root)
  await workspace.createWorkspace({ id: 'project', name: 'Report', kind: 'office' })
  const commands = api.createProjectWorkspaceCommandService(workspace, { rootDir: state.root })
  await commands.reconcileShadowProjection()
  await commands.createGoal({ id: 'goal', projectId: 'project', title: '客户报告', objective: '客户报告', status: 'verifying', constraints: ['六页以内'] })
  for (const name of ['source', 'report']) {
    const workItemId = `work:${name}`
    await commands.createWorkItem({ id: workItemId, projectId: 'project', goalId: 'goal', title: name,
      description: '客户报告', type: 'writing', status: 'verifying', acceptanceSpec: [{ id: `criterion:${name}`, criterion: '每页注明来源' }] })
    const child = { ...meta, id: `original:${name}`, workItemId, childTaskId: workItemId }
    const run = { schemaVersion: 1, id: `run:${name}`, sessionId: child.id, taskId: workItemId, status: 'completed',
      revision: 2, attempt: 1, recoveryCount: 0, createdAt: 1, updatedAt: 2, startedAt: 1, finishedAt: 2, steps: [], toolExecutions: [], effects: [] }
    await api.saveTaskSnapshot(api.buildTaskSnapshot({ meta: child, run, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', now: 2 }), state.root)
    let item = await workspace.getWorkItem(workItemId)
    await commands.updateWorkItem(workItemId, { runRefs: [run.id] }, { expectedRevision: item.revision })
    writeFileSync(join(state.root, `${name}.txt`), `Original ${name}`)
    await api.registerCanonicalProducedArtifact({ lifecycle: { id: `artifact:${name}`, projectId: 'project', goalId: 'goal', workItemId,
      runId: run.id, lineageId: `lineage:${name}`, kind: 'report', title: name, version: 1, provenance: 'explicit', mediaType: 'text/plain',
      retention: { mode: 'retain' }, metadata: { producer: 'rerun-fixture' }, content: { storageKind: 'source_ref', sourceRef: join(state.root, `${name}.txt`) } },
      evidence: { id: `evidence:${name}`, kind: 'delivery_check', title: name, summary: 'Fixture bytes', verifier: 'fixture' },
      acceptance: { id: `acceptance:${name}`, criterionId: `criterion:${name}`, criterion: 'Bytes verified', status: 'passed', verifier: 'fixture' }, attachToStage: false }, state.root)
  }
  await api.createWorkflowArtifactEdge({ id: 'source-report', projectId: 'project', goalId: 'goal', fromArtifactId: 'artifact:source', toArtifactId: 'artifact:report', relation: 'derived_from' }, state.root)
  writeFileSync(join(state.root, 'source.txt'), 'Manual corrected values')
  const check = await invoke('check_files')
  const preview = await invoke('rerun_preview', { planDigest: check.planDigest, workItemId: 'work:report' })
  assert.equal(preview.state, 'ready', JSON.stringify(preview.blockedReasons))
  return { workspace, preview, input: { planDigest: preview.planDigest, workItemId: preview.sourceWorkItemId, previewDigest: preview.previewDigest } }
}
let passed = 0
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`) }
try {
  if (restart) {
    const saved = JSON.parse(readFileSync(join(temp, 'fixture-restart.json'), 'utf8'))
    state.root = temp; state.sessions = new Map([['parent', { meta: saved.parent }]]); state.persisted = saved.persisted
    state.accepted = JSON.parse(readFileSync(join(temp, 'fixture-accepted.json'), 'utf8')); inputs()
    const result = await invoke('rerun_confirm', saved.input)
    assert.equal(result.state, 'existing'); assert.equal(result.sessionId, saved.sessionId)
    assert.equal(state.creates, 0); assert.equal(state.sends, 0)
    console.log('cold restart reused original accepted Session')
  } else {
    await check('actual confirmation IPC creates one canonical repair and waits for idle before independent grant/send', async () => {
      const { workspace, preview, input } = await setup('success')
      const [first, second] = await Promise.all([invoke('rerun_confirm', input), invoke('rerun_confirm', input)])
      assert.equal(first.state, 'started', JSON.stringify(first)); assert.equal(second.state, 'existing')
      assert.equal(first.sessionId, second.sessionId); assert.equal(state.creates, 1); assert.equal(state.sends, 1)
      const work = await workspace.getWorkItem(first.repairWorkItemId)
      assert.equal(work.parentId, 'work:report'); assert.deepEqual(work.dependencyIds, []); assert.equal(work.status, 'running')
      const child = state.sessions.get(first.sessionId).meta, store = new api.TaskExecutionAuthorityStore(state.root)
      assert.deepEqual(store.get(child).pathPatterns, preview.outputs.map(file => file.relativeOutputPath))
      assert.throws(() => store.assertAllowed(child, 'write_file', { path: join(state.root, 'source.txt') }, state.root), /修改授权/)
      assert.throws(() => store.assertAllowed(child, 'bash', { command: 'npm test' }, state.root), /独立命令授权/)
      assert.equal(readFileSync(join(state.root, 'source.txt'), 'utf8'), 'Manual corrected values')
      assert.equal((await api.verifyPersistedWorkflowLedger(state.root)).valid, true)
      // Existing output is normal after dispatch and must not trigger another preview/send.
      writeFileSync(preview.outputs[0].outputPath, 'Generated successor')
      assert.equal((await invoke('rerun_confirm', input)).state, 'existing')
      writeFileSync(join(state.root, 'fixture-restart.json'), JSON.stringify({ parent: state.sessions.get('parent').meta, persisted: state.persisted, input, sessionId: first.sessionId }))
      const childProcess = spawnSync(process.execPath, [resolve(process.argv[1]), '--restart', state.root], { encoding: 'utf8', cwd: process.cwd() })
      assert.equal(childProcess.status, 0, childProcess.stdout + childProcess.stderr)
    })
    await check('unknown send remains reconcilable across duplicate confirmations without another send', async () => {
      const { input } = await setup('unknown'); state.unknownSend = true
      const first = await invoke('rerun_confirm', input), second = await invoke('rerun_confirm', input)
      assert.equal(first.state, 'needs_reconciliation'); assert.equal(second.state, 'needs_reconciliation')
      assert.equal(first.sessionId, second.sessionId); assert.equal(state.creates, 1); assert.equal(state.sends, 1)
    })
    await check('managed creation uncertainty never allocates a replacement child', async () => {
      const { input } = await setup('creation'); state.failCreate = true
      const first = await invoke('rerun_confirm', input); state.failCreate = false
      const second = await invoke('rerun_confirm', input)
      assert.equal(first.state, 'needs_reconciliation'); assert.equal(second.state, 'needs_reconciliation')
      assert.equal(first.sessionId, second.sessionId); assert.equal(state.creates, 1); assert.equal(state.sends, 0)
    })
    await check('queued repair cannot silently restore missing or revoked child authority', async () => {
      for (const mode of ['missing', 'revoked']) {
        const { input } = await setup(`grant-${mode}`)
        const queue = state.inputs.queue.bind(state.inputs)
        state.inputs.queue = async (...args) => { await queue(...args); throw new Error('fixture interruption after durable queue') }
        const first = await invoke('rerun_confirm', input)
        assert.equal(first.state, 'needs_reconciliation'); assert.ok(first.sessionId)
        const meta = state.sessions.get(first.sessionId).meta
        const authority = new api.TaskExecutionAuthorityStore(state.root)
        if (mode === 'missing') rmSync(join(state.root, 'private/task-execution-authorities'), { recursive: true })
        else authority.revoke(meta, { expectedRevision: authority.get(meta).revision }, 'local-user:fixture')
        inputs()
        const second = await invoke('rerun_confirm', input)
        assert.equal(second.state, 'awaiting_authorization', JSON.stringify(second)); assert.equal(second.sessionId, first.sessionId)
        assert.equal(authority.get(meta).available, false); assert.equal(state.sends, 0); assert.equal(state.creates, 1)
      }
    })
    await check('child identity changed during queue cannot receive stale repair dispatch', async () => {
      const { input } = await setup('identity')
      const queue = state.inputs.queue.bind(state.inputs)
      state.inputs.queue = async (...args) => {
        const result = await queue(...args)
        state.sessions.get(args[0]).meta.parentSessionId = 'different-parent'
        return result
      }
      const result = await invoke('rerun_confirm', input)
      assert.equal(result.state, 'needs_reconciliation'); assert.match(result.reason, /身份/); assert.equal(state.sends, 0)
    })
    await check('stale preview and unexpected IPC fields fail before repair creation', async () => {
      const { input, workspace } = await setup('stale')
      await assert.rejects(invoke('rerun_confirm', { ...input, allowedWriteTools: ['bash'] }), /确认参数/)
      writeFileSync(join(state.root, 'source.txt'), 'Changed again')
      await assert.rejects(invoke('rerun_confirm', input), /检查版本已变化|预览已变化/)
      assert.equal((await workspace.getState()).workItems.length, 2); assert.equal(state.creates, 0)
    })
    console.log(`Studio rerun dispatch: ${passed}/${passed} passed; real IPC, canonical stores and input receipts; mocked engine, no Provider calls.`)
  }
  assert.equal(networkCalls, 0)
} finally {
  globalThis.fetch = oldFetch; delete globalThis[key]
  if (!restart) rmSync(temp, { recursive: true, force: true })
}
