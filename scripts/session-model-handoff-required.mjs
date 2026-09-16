import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Module } from 'node:module'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

// Production builders, transcript writer, canonical stores and byte verification.
// Only Electron, live Sessions and Provider/settings discovery use local fixtures.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-model-handoff-')))
const key = '__caogenModelHandoffFixture'
const previousFetch = globalThis.fetch
let networkCalls = 0, passed = 0
globalThis.fetch = async () => { networkCalls++; throw new Error('Provider/network I/O forbidden') }
globalThis[key] = { root, providers: [{ id: 'fixture', name: 'Fixture', engine: 'openai', baseUrl: 'https://fixture.invalid', models: ['fixture-model'] }] }
const check = async (name, operation) => { await operation(); passed++; console.log(`PASS ${name}`) }
const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`
try {
  const bundled = await build({ stdin: { contents: `
    export { prepareSessionModelHandoff, assertSessionModelHandoff, sessionModelHandoffPrompt, prepareSessionModelHandoffCheckpoint } from './src/main/agent/session-model-handoff'
    export { providerChatCheckpointId, restoreProviderChatCheckpoint } from './src/main/provider-chat-checkpoint'
    export { projectAggregateDigest } from './src/main/project-aggregate/codec'
    export { TranscriptWriter, readTranscriptEntriesStrict } from './src/main/transcript'
    export { openProjectWorkspaceStore } from './src/main/project-workspace/store'
    export { createProjectWorkspaceCommandService } from './src/main/project-workspace/command-service'
    export { registerCanonicalProducedArtifact } from './src/main/task/artifact-production-boundary'
    export { buildTaskSnapshot, saveTaskSnapshot, taskSnapshotsDbFile, mutateTaskSnapshotDatabase } from './src/main/task/task-snapshot'
    export { startPersistedModelAttempt, completePersistedModelAttempt } from './src/main/task/model-attempt-api'
    export { nativeRecoveryHandoffPrompt } from './src/main/task/native-recovery-handoff'
    export { nativeTurnRejection } from './src/main/model/native-turn-rejection'
    export { prepareOutboundContext, appendOutboundContextItems, assertOutboundContextAllowed } from './src/main/project-workspace/outbound-context-policy'
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', packages: 'external',
    plugins: [{ name: 'handoff-local-boundaries', setup(builder) {
      builder.onResolve({ filter: /^electron$|(?:^|\/)(?:providers|settings|sessionManager|history|session-input-runtime|session-creation-journal|acceptance-quality-feedback)$/ }, args => ({ path: args.path === 'electron' ? 'electron' : args.path.split('/').at(-1), namespace: 'handoff-local-boundaries' }))
      builder.onLoad({ filter: /.*/, namespace: 'handoff-local-boundaries' }, args => ({ loader: 'js', contents: {
        electron: `module.exports = { app: { getPath: () => globalThis.${key}.root, isPackaged: false }, BrowserWindow: {} }`,
        providers: `module.exports = { listProviders: () => globalThis.${key}.providers, getProvider: () => globalThis.${key}.providers[0], providerIsReady: () => true }`,
        settings: `module.exports = { getSettings: () => ({ failoverEnabled: true }) }`,
        sessionManager: `module.exports = { sessionManager: { list: () => [], get: () => undefined } }`,
        history: `module.exports = { listHistory: () => [] }`,
        'session-input-runtime': `module.exports = { getSessionInputService: () => { throw new Error('unused') } }`,
        'session-creation-journal': `module.exports = { listPendingSessionCreations: () => [] }`,
        'acceptance-quality-feedback': `module.exports = { scheduleModelRouteObservationRefresh: () => {}, scheduleAcceptanceQualityFeedbackRefresh: () => {} }`
      }[args.path] }))
    } }]
  })
  const filename = resolve('scripts/.session-model-handoff-fixture.cjs'), mod = new Module(filename)
  mod.filename = filename; mod.paths = Module._nodeModulePaths(dirname(filename)); mod._compile(bundled.outputFiles[0].text, filename)
  const api = mod.exports
  const base = { id: 'handoff-session', title: '切换模型', cwd: root, createdAt: 1, status: 'idle', taskStrategy: 'execute', businessLineId: 'studio',
    providerId: 'fixture', model: 'fixture-model', engine: 'openai', permissionMode: 'acceptEdits', costUsd: 0, contextTokens: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } }
  const seal = receipt => { const { digest: _digest, ...body } = receipt; return { ...body, digest: api.projectAggregateDigest(body) } }
  const handoffBlocked = error => api.nativeTurnRejection(error)?.subtype === 'handoff-blocked'

  await check('empty source permits first SDK identity while retaining exact empty source digests', async () => {
    const receipt = await api.prepareSessionModelHandoff(base, undefined, root)
    assert.equal(receipt.transcript.entryCount, 0); assert.equal(receipt.transcript.sdkSessionId, undefined)
    const started = { ...base, sdkSessionId: 'first-sdk' }
    const writer = new api.TranscriptWriter(started.sdkSessionId)
    writer.next({ kind: 'user-message', messageId: 'first-message', text: '开始当前任务' })
    const entries = api.readTranscriptEntriesStrict(started.sdkSessionId)
    assert.doesNotThrow(() => api.assertSessionModelHandoff(receipt, started, entries))
    assert.ok(api.sessionModelHandoffPrompt(receipt, started, entries).includes(receipt.digest))
    const invalid = seal({ ...receipt, transcript: { ...receipt.transcript, sourceDigest: 'a'.repeat(64) } })
    assert.throws(() => api.assertSessionModelHandoff(invalid, started, entries), /来源会话无效/)
    const boundEmpty = await api.prepareSessionModelHandoff({ ...base, sdkSessionId: 'empty-bound-sdk' }, undefined, root)
    assert.throws(() => api.assertSessionModelHandoff(boundEmpty, started, []), /来源会话无效/)
  })

  const source = { ...base, sdkSessionId: 'source-sdk' }
  const writer = new api.TranscriptWriter(source.sdkSessionId)
  writer.next({ kind: 'user-message', messageId: 'source-message', text: '六页以内，保留已确认事实' })
  writer.next({ kind: 'assistant-message', messageId: 'source-answer', blocks: [{ type: 'text', text: '保留原始引用和文件版本' }] })
  const sourceReceipt = await api.prepareSessionModelHandoff(source, undefined, root)
  await check('nonempty identity and sealed prefix survive appends and reject substitution, truncation and tampering', async () => {
    const before = api.readTranscriptEntriesStrict(source.sdkSessionId)
    assert.equal(sourceReceipt.transcript.entryCount, before.length)
    writer.next({ kind: 'user-message', messageId: 'later-message', text: '第二页补来源' })
    const after = api.readTranscriptEntriesStrict(source.sdkSessionId)
    assert.doesNotThrow(() => api.assertSessionModelHandoff(sourceReceipt, source, after))
    assert.throws(() => api.assertSessionModelHandoff(sourceReceipt, { ...source, sdkSessionId: 'another-sdk' }, after), /来源会话无效/)
    assert.throws(() => api.assertSessionModelHandoff(sourceReceipt, source, before.slice(1)), /账本|前缀/)
    const edited = structuredClone(before); edited[0].event.text = '替换原始事实'
    assert.throws(() => api.assertSessionModelHandoff(sourceReceipt, source, edited), /账本|前缀/)
    assert.throws(() => api.assertSessionModelHandoff({ ...sourceReceipt, createdAt: sourceReceipt.createdAt + 1 }, source, after), /摘要不匹配/)
    assert.throws(() => api.sessionModelHandoffPrompt({ ...sourceReceipt, digest: '0'.repeat(64) }, source, after), handoffBlocked)
    assert.ok(api.sessionModelHandoffPrompt(sourceReceipt, source, after).includes('不允许自动重试'))
  })

  const workspace = await api.openProjectWorkspaceStore(root)
  await workspace.createWorkspace({ id: 'project', name: 'Handoff', kind: 'office' })
  const commands = api.createProjectWorkspaceCommandService(workspace, { rootDir: root })
  await commands.reconcileShadowProjection()
  await commands.createGoal({ id: 'goal', projectId: 'project', title: '交付报告', objective: '控制在六页', status: 'verifying' })
  const fixtures = new Map()
  for (const name of ['source', 'other']) {
    const workItemId = `work-${name}`, runId = `run-${name}`
    await commands.createWorkItem({ id: workItemId, projectId: 'project', goalId: 'goal', title: name, type: 'writing', status: 'verifying' })
    const meta = { ...base, id: `${name}-session`, workspaceId: 'project', goalId: 'goal', workItemId, childTaskId: workItemId }
    const run = { schemaVersion: 1, id: runId, sessionId: meta.id, taskId: workItemId, status: 'executing', revision: 1,
      attempt: 1, recoveryCount: 0, createdAt: 1, updatedAt: 2, startedAt: 1, steps: [], toolExecutions: [], effects: [] }
    await api.saveTaskSnapshot(api.buildTaskSnapshot({ meta, run, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', now: 2 }), root)
    const item = await workspace.getWorkItem(workItemId)
    await commands.updateWorkItem(workItemId, { runRefs: [runId] }, { expectedRevision: item.revision })
    const attempt = await api.startPersistedModelAttempt({ id: `attempt-${name}`, commandId: `start-${name}`, requestId: `request-${name}`, runId,
      providerId: 'fixture', model: `failed-${name}-model`, protocol: 'openai.responses', adapterVersion: 'fixture-v1', contextDigest: '6'.repeat(64), routeReason: 'Persisted failure fixture', startedAt: 3 }, root)
    await api.completePersistedModelAttempt(attempt.id, { commandId: `complete-${name}`, expectedRevision: 1, status: 'failed', outcome: 'timeout', errorClass: 'timeout', completedAt: 4 }, root)
    fixtures.set(name, { meta, run })
  }
  const register = async (name, version) => {
    const { meta, run } = fixtures.get(name), id = `artifact-${name}-${version}`, path = join(root, `${id}.txt`)
    writeFileSync(path, `${name} content version ${version}`)
    await api.registerCanonicalProducedArtifact({ lifecycle: { id, projectId: 'project', goalId: 'goal', workItemId: meta.workItemId, runId: run.id,
      lineageId: `lineage-${name}`, kind: 'report', title: `${name} report`, version, provenance: 'explicit', mediaType: 'text/plain', retention: { mode: 'retain' },
      ...(version > 1 ? { supersedesId: `artifact-${name}-${version - 1}` } : {}),
      metadata: { producer: 'fixture' }, content: { storageKind: 'source_ref', sourceRef: path } },
      evidence: { id: `evidence-${name}-${version}`, kind: 'delivery_check', title: `${name} evidence`, summary: 'Original bytes verified', verifier: 'fixture' },
      acceptance: { id: `acceptance-${name}-${version}`, criterionId: `criterion-${name}-${version}`, criterion: 'Version bytes match', status: 'passed', verifier: 'fixture' }, attachToStage: false }, root)
    return { id, path, digest: sha256(readFileSync(path)) }
  }
  const original = await register('source', 1)
  await register('other', 1)
  const own = fixtures.get('source'), other = fixtures.get('other')
  const frozen = await api.prepareSessionModelHandoff(own.meta, own.run, root)
  await check('canonical handoff freezes Goal, WorkItem, accepted Artifact bytes and scoped failure records', async () => {
    assert.equal(frozen.goal.id, 'goal'); assert.equal(frozen.goal.objective, '控制在六页')
    assert.deepEqual(frozen.workItems.map(item => item.id), ['work-source'])
    const artifact = frozen.artifacts.find(item => item.id === original.id)
    assert.equal(artifact.deliveryStatus, 'ready'); assert.equal(artifact.version, 1); assert.equal(artifact.digest, original.digest)
    assert.ok(artifact.evidenceIds.includes('evidence-source-1')); assert.ok(artifact.acceptanceIds.includes('acceptance-source-1'))
    assert.match(frozen.artifactContinuationDigest, /^sha256:[a-f0-9]{64}$/)
    assert.ok(frozen.failures.some(item => item.entityId === 'attempt-source'))
    const prompt = api.sessionModelHandoffPrompt(frozen, own.meta, [])
    for (const foreign of ['work-other', 'artifact-other-1', 'attempt-other', 'failed-other-model']) assert.ok(!prompt.includes(foreign), foreign)
    await assert.rejects(api.prepareSessionModelHandoff(own.meta, other.run, root), /来源 Run/)
    const legacy = await api.prepareSessionModelHandoff({ ...base, workspaceId: 'project' }, undefined, root)
    assert.equal(legacy.artifacts.length, 0); assert.equal(legacy.workItems.length, 0); assert.equal(legacy.failures.length, 0)
  })

  await check('later Artifact versions do not rewrite the frozen handoff and modified bytes block a new handoff', async () => {
    const later = await register('source', 2)
    const fresh = await api.prepareSessionModelHandoff(own.meta, own.run, root)
    assert.ok(fresh.artifacts.some(item => item.id === later.id && item.version === 2 && item.digest === later.digest))
    assert.equal(frozen.artifacts.find(item => item.id === original.id).version, 1)
    assert.ok(!api.sessionModelHandoffPrompt(frozen, own.meta, []).includes(later.id))
    assert.notEqual(fresh.artifactContinuationDigest, frozen.artifactContinuationDigest)
    const bytes = readFileSync(later.path)
    writeFileSync(later.path, 'manual changes after acceptance')
    try { await assert.rejects(api.prepareSessionModelHandoff(own.meta, own.run, root), /artifact|Artifact|文件|bytes|integrity/i) }
    finally { writeFileSync(later.path, bytes) }
  })

  await check('native failure handoff verifies source digest, task ownership and corrupt ledger before dispatch', async () => {
    const prompt = await api.nativeRecoveryHandoffPrompt(own.meta, own.run, root)
    const context = JSON.parse(prompt.split('\n').at(-1))
    assert.equal(context.failures[0].id, 'attempt-source')
    assert.ok(prompt.includes(`Source digest: sha256:${api.projectAggregateDigest(context)}`)); assert.ok(!prompt.includes('attempt-other'))
    await assert.rejects(api.nativeRecoveryHandoffPrompt(own.meta, other.run, root), handoffBlocked)
    const databasePath = api.taskSnapshotsDbFile(root), databaseBytes = readFileSync(databasePath)
    try {
      await api.mutateTaskSnapshotDatabase(root, db => db.run('UPDATE workflow_events SET record_digest = ? WHERE seq = 1', ['0'.repeat(64)]))
      await assert.rejects(api.nativeRecoveryHandoffPrompt(own.meta, own.run, root), handoffBlocked)
    } finally { writeFileSync(databasePath, databaseBytes) }
    assert.ok((await api.nativeRecoveryHandoffPrompt(own.meta, own.run, root)).includes('attempt-source'))
  })

  await check('recovery manifest preserves no-egress and local-only restrictions and binds replacement content', async () => {
    const locked = { id: 'context:locked', kind: 'workflow_context', label: 'Local source', dataClass: 'S2', egressPolicy: 'local_only', decision: 'included', digest: sha256('local') }
    const denied = { id: 'context:denied', kind: 'project_resource', label: 'Forbidden source', dataClass: 'S3', egressPolicy: 'deny', decision: 'excluded' }
    const initial = (await api.prepareOutboundContext({ meta: base, rootDir: root, payload: { text: 'Continue' }, additionalItems: [locked, denied] })).manifest
    const recovery = { id: 'context:model-recovery', kind: 'workflow_context', label: 'Recovery evidence', dataClass: 'S4', egressPolicy: 'allow', decision: 'included', digest: sha256('failure') }
    const appended = api.appendOutboundContextItems(initial, [recovery])
    assert.equal(appended.failoverAllowed, false); assert.equal(appended.blocked, true)
    assert.deepEqual(appended.items.find(item => item.id === locked.id), locked)
    assert.deepEqual(appended.items.find(item => item.id === denied.id), denied)
    assert.notEqual(appended.manifestDigest, initial.manifestDigest)
    const next = api.appendOutboundContextItems(appended, [{ ...recovery, digest: sha256('new failure') }])
    assert.equal(next.items.filter(item => item.id === recovery.id).length, 1)
    assert.notEqual(next.manifestDigest, appended.manifestDigest)
    assert.throws(() => api.appendOutboundContextItems(initial, [{ ...locked, egressPolicy: 'allow' }]), error => error.code === 'OUTBOUND_CONTEXT_DENIED')
    assert.throws(() => api.appendOutboundContextItems(initial, [{ ...denied, dataClass: 'S2', egressPolicy: 'allow', decision: 'included' }]), error => error.code === 'OUTBOUND_CONTEXT_DENIED')
    await assert.rejects(api.assertOutboundContextAllowed({ manifest: appended, rootDir: root, providerId: 'fixture', model: 'fixture-model', engine: 'openai' }), error => error.code === 'OUTBOUND_CONTEXT_DENIED')
    assert.throws(() => api.appendOutboundContextItems({ ...appended, failoverAllowed: true }, []), error => error.code === 'OUTBOUND_CONTEXT_STALE')
  })
  await check('authorized chat checkpoint keeps a valid shorter handoff before and after durable truncation', async () => {
    const checkpointMeta = { ...own.meta, sdkSessionId: 'checkpoint-sdk' }
    const checkpointWriter = new api.TranscriptWriter(checkpointMeta.sdkSessionId)
    const addTurn = number => {
      const messageId = `checkpoint-turn-${number}`
      checkpointWriter.next({ kind: 'user-message', messageId, text: `第 ${number} 轮请求` })
      checkpointWriter.next({ kind: 'assistant-message', messageId: `checkpoint-answer-${number}`, blocks: [{ type: 'text', text: `第 ${number} 轮回答` }] })
      checkpointWriter.next({ kind: 'checkpoint', messageId: api.providerChatCheckpointId(messageId), userMessageId: messageId, scope: 'chat' })
      return messageId
    }
    addTurn(1)
    const rewindId = addTurn(2)
    const before = await api.prepareSessionModelHandoff(checkpointMeta, own.run, root)
    checkpointMeta.modelChange = { handoff: before }
    const preview = api.restoreProviderChatCheckpoint(checkpointWriter, rewindId, 'chat', true, () => assert.fail('dry-run applied'))
    assert.equal(preview.canRewind, true); assert.equal(preview.applied, false); assert.ok(preview.chat?.ok)
    const initialEntries = checkpointWriter.readAll()
    assert.throws(() => api.prepareSessionModelHandoffCheckpoint(checkpointMeta, rewindId, initialEntries,
      { ...preview.chat, keepThroughSeq: preview.chat.keepThroughSeq + 1 }), /预览与当前账本不一致/)
    assert.throws(() => api.prepareSessionModelHandoffCheckpoint(checkpointMeta, 'missing-checkpoint', initialEntries, preview.chat), /预览与当前账本不一致/)
    const corruptedPrefix = structuredClone(initialEntries); corruptedPrefix[0].event.text = '篡改冻结前缀'
    assert.throws(() => api.prepareSessionModelHandoffCheckpoint(checkpointMeta, rewindId, corruptedPrefix, preview.chat), /账本|前缀/)
    const laterId = addTurn(3)
    const fullEntries = checkpointWriter.readAll()
    assert.throws(() => api.prepareSessionModelHandoffCheckpoint(checkpointMeta, rewindId, fullEntries, preview.chat), /预览与当前账本不一致/)
    const laterPreview = api.restoreProviderChatCheckpoint(checkpointWriter, laterId, 'chat', true, () => assert.fail('dry-run applied'))
    assert.equal(laterPreview.canRewind, true)
    assert.equal(api.prepareSessionModelHandoffCheckpoint(checkpointMeta, laterId, fullEntries, laterPreview.chat), undefined)

    const approved = api.restoreProviderChatCheckpoint(checkpointWriter, rewindId, 'chat', true, () => assert.fail('dry-run applied'))
    const shorter = api.prepareSessionModelHandoffCheckpoint(checkpointMeta, rewindId, fullEntries, approved.chat)
    assert.ok(shorter); assert.ok(shorter.transcript.boundarySeq < before.transcript.boundarySeq)
    assert.equal(shorter.transcript.boundarySeq, approved.chat.keepThroughSeq)
    assert.equal(shorter.transcript.entryCount, approved.chat.keptEntries)
    assert.equal(shorter.checkpointProjection.previousHandoffDigest, before.digest)
    assert.equal(shorter.checkpointProjection.previousBoundarySeq, before.transcript.boundarySeq)
    assert.equal(shorter.checkpointProjection.previousEntryCount, before.transcript.entryCount)
    assert.equal(shorter.checkpointProjection.previousSourceDigest, before.transcript.sourceDigest)
    assert.equal(shorter.checkpointProjection.previousContextDigest, before.transcript.contextDigest)
    assert.equal(shorter.checkpointProjection.checkpointId, approved.chat.checkpointId)
    for (const field of ['sourceRunId', 'scope', 'aggregateDigest', 'goal', 'workItems', 'facts', 'artifacts', 'artifactContinuationDigest', 'failures', 'omitted']) {
      assert.deepEqual(shorter[field], before[field], field)
    }
    assert.ok(shorter.artifacts.some(artifact => artifact.deliveryStatus === 'ready'))
    assert.doesNotThrow(() => api.assertSessionModelHandoff(shorter, checkpointMeta, fullEntries))
    checkpointMeta.modelChange = { handoff: shorter }
    let appliedCallback = 0
    const applied = api.restoreProviderChatCheckpoint(checkpointWriter, rewindId, 'chat', false, entries => {
      appliedCallback++
      api.assertSessionModelHandoff(checkpointMeta.modelChange.handoff, checkpointMeta, entries)
    })
    assert.equal(applied.applied, true); assert.equal(appliedCallback, 1)
    const durable = api.readTranscriptEntriesStrict(checkpointMeta.sdkSessionId)
    assert.equal(durable.length, approved.chat.keptEntries)
    assert.doesNotThrow(() => api.assertSessionModelHandoff(shorter, checkpointMeta, durable))
    assert.ok(api.sessionModelHandoffPrompt(shorter, checkpointMeta, durable).includes(before.digest))
    assert.throws(() => api.assertSessionModelHandoff(before, checkpointMeta, durable), /前缀/)
  })
  assert.equal(networkCalls, 0)
  console.log(`session-model-handoff-required: ${passed}/${passed}; production handoff and canonical stores; no Provider I/O`)
} finally {
  globalThis.fetch = previousFetch
  delete globalThis[key]
  rmSync(root, { recursive: true, force: true })
}
