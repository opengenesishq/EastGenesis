import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Module } from 'node:module'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import JSZip from 'jszip'

// Actual IPC -> verified production stores -> package -> Artifact registration.
// Only desktop UI, live Sessions and unused Provider boundaries are substituted.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-delivery-audit-')))
const key = '__caogenDeliveryAuditFixture'
const state = { meta: undefined, onSave: () => {}, saves: 0 }
let networkCalls = 0
const oldFetch = globalThis.fetch
globalThis.fetch = async () => { networkCalls++; throw new Error('Provider/network calls forbidden') }
globalThis[key] = {
  electron: {
    app: { getPath: () => root, isPackaged: false },
    BrowserWindow: { fromWebContents: () => undefined, getAllWindows: () => [] },
    dialog: { showSaveDialog: async () => { state.onSave(); return { canceled: false, filePath: join(root, `delivery-${++state.saves}.zip`) } } }
  },
  sessionManager: { list: () => [state.meta], get: () => ({ meta: state.meta }) },
  assertTrustedWorkflowLedgerSender: event => assert.equal(event.sender.id, 7)
}
const output = await build({ stdin: { contents: `
  export { handleStudioResultIpc } from './src/main/ipc/studio-result-handlers'
  export { openProjectWorkspaceStore } from './src/main/project-workspace/store'
  export { createProjectWorkspaceCommandService } from './src/main/project-workspace/command-service'
  export { isTaskRunRecord } from './src/main/task/task-run'
  export { buildTaskSnapshot, saveTaskSnapshot } from './src/main/task/task-snapshot'
  export { startPersistedModelAttempt, completePersistedModelAttempt } from './src/main/task/model-attempt-api'
  export { registerCanonicalProducedArtifact } from './src/main/task/artifact-production-boundary'
  export { verifyPersistedWorkflowLedger } from './src/main/task/workflow-ledger-api'
  export { buildPortableDeliveryPackage } from './src/main/studio-result/studio-result-package'
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', packages: 'external',
  plugins: [{ name: 'delivery-desktop-boundaries', setup(builder) {
    builder.onResolve({ filter: /^electron$|(?:^|\/)(?:sessionManager(?:\.js)?|history|providers|session-input-runtime|session-creation-journal|workflow-ledger-handlers|acceptance-quality-feedback)$/ }, args =>
      ({ path: args.path === 'electron' ? 'electron' : args.path.split('/').at(-1).replace(/\.js$/, ''), namespace: 'delivery-desktop-boundaries' }))
    builder.onLoad({ filter: /.*/, namespace: 'delivery-desktop-boundaries' }, args => ({ loader: 'js', contents: {
      electron: `module.exports = globalThis.${key}.electron`,
      sessionManager: `module.exports = { sessionManager: globalThis.${key}.sessionManager }`,
      history: `module.exports = { listHistory: () => [] }`,
      providers: `module.exports = { getProvider: () => ({ id: 'fixture', engine: 'openai' }), providerIsReady: () => true }`,
      'session-input-runtime': `module.exports = { getSessionInputService: () => { throw new Error('unused') } }`,
      'session-creation-journal': `module.exports = { listPendingSessionCreations: () => [] }`,
      'workflow-ledger-handlers': `module.exports = { assertTrustedWorkflowLedgerSender: globalThis.${key}.assertTrustedWorkflowLedgerSender }`,
      'acceptance-quality-feedback': `module.exports = { scheduleModelRouteObservationRefresh: () => {}, scheduleAcceptanceQualityFeedbackRefresh: () => {} }`
    }[args.path] }))
  } }]
})
const filename = resolve('scripts/.delivery-audit-fixture.cjs'), mod = new Module(filename)
mod.filename = filename; mod.paths = Module._nodeModulePaths(dirname(filename)); mod._compile(output.outputFiles[0].text, filename)
const api = mod.exports
const event = { sender: { id: 7 } }
const invoke = action => api.handleStudioResultIpc(event, action, 'delivery-session')
const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`
let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`) }
try {
  state.meta = { id: 'delivery-session', cwd: root, createdAt: 1, status: 'idle', taskStrategy: 'execute', businessLineId: 'studio',
    title: 'Delivery', providerId: 'current-provider-unproven', model: 'current-model-unproven', engine: 'openai', permissionMode: 'acceptEdits',
    costUsd: 999, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0, workspaceId: 'project', goalId: 'goal', workItemId: 'work:delivery' }
  const workspace = await api.openProjectWorkspaceStore(root)
  await workspace.createWorkspace({ id: 'project', name: 'Delivery', kind: 'office' })
  const commands = api.createProjectWorkspaceCommandService(workspace, { rootDir: root })
  await commands.reconcileShadowProjection()
  await commands.createGoal({ id: 'goal', projectId: 'project', title: '交付报告', objective: '六页报告', status: 'verifying' })
  for (const name of ['delivery', 'unrelated']) {
    const workItemId = `work:${name}`, sessionId = `${name}-session`, runId = `run:${name}`
    await commands.createWorkItem({ id: workItemId, projectId: 'project', goalId: 'goal', title: name,
      type: 'writing', status: 'verifying', acceptanceSpec: [{ id: `criterion:${name}`, criterion: '来源可核对' }] })
    const tools = Array.from({ length: name === 'delivery' ? 125 : 1 }, (_, i) => ({
      id: `tool:${name}:${i}`, runId, sessionId, toolUseId: `use:${name}:${i}`, toolName: 'write_file',
      status: i === 1 ? 'failed' : 'succeeded', ...(i < 124 ? { permissionDecision: i === 1 ? 'deny' : 'allow' } : {}),
      ...(i === 1 ? { requestId: 'permission-request', approvalResolvedEventId: 'approval-resolution' } : {}),
      ...(i === 0 ? { effectId: 'effect:unknown' } : {}), createdAt: 1, updatedAt: 2, finishedAt: 2,
      outputDigest: sha256(`result:${i}`)
    }))
    const effects = name === 'delivery' ? [{ schemaVersion: 1, id: 'effect:unknown', effectKey: 'effect-key', resourceKey: 'resource-key',
      sessionId, runId, toolUseId: 'use:delivery:0', toolName: 'write_file', generation: 1, revision: 2,
      status: 'waiting_reconciliation', reconcilability: 'queryable',
      target: { kind: 'file_content', rootPath: root, relativePath: 'raw-target-must-not-export', preState: 'absent', expectedSha256: '1'.repeat(64), expectedBytes: 1 },
      targetDigest: '2'.repeat(64), intentDigest: '3'.repeat(64), inputDigest: '4'.repeat(64), createdAt: 1, updatedAt: 2,
      evidence: [{ id: 'manual-evidence', kind: 'manual_confirmation', digest: '5'.repeat(64), observedAt: 2, verifier: 'local-user:fixture', generation: 1 }]
    }] : []
    const meta = { ...state.meta, id: sessionId, workItemId, childTaskId: workItemId }
    const run = { schemaVersion: 1, id: runId, sessionId, taskId: workItemId, status: 'executing', revision: 2, attempt: 1,
      recoveryCount: 0, createdAt: 1, updatedAt: 2, startedAt: 1, steps: [], toolExecutions: tools, effects }
    assert.ok(api.isTaskRunRecord(run), 'initial fixture Run')
    await api.saveTaskSnapshot(api.buildTaskSnapshot({ meta, run, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', now: 2 }), root)
    const item = await workspace.getWorkItem(workItemId)
    await commands.updateWorkItem(workItemId, { runRefs: [run.id] }, { expectedRevision: item.revision })
    const attempt = await api.startPersistedModelAttempt({ id: `attempt:${name}`, commandId: `start:${name}`, requestId: `request:${name}`, runId,
      providerId: `persisted-provider-${name}`, model: `persisted-model-${name}`, protocol: 'openai_responses', adapterVersion: 'native-adapter/v1',
      contextDigest: '6'.repeat(64), routeReason: 'fixture route', startedAt: 3 }, root)
    await api.completePersistedModelAttempt(attempt.id, { commandId: `complete:${name}`, expectedRevision: attempt.revision,
      status: 'succeeded', outcome: 'success', costUsd: 0.25, completedAt: 4 }, root)
    Object.assign(run, { status: 'completed', revision: 3, updatedAt: 5, finishedAt: 5 })
    await api.saveTaskSnapshot(api.buildTaskSnapshot({ meta, run, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', now: 5 }), root)
    for (const suffix of name === 'delivery' ? ['good', 'manual'] : ['unrelated']) {
      const id = `artifact:${suffix}`, path = join(root, `${suffix}.txt`)
      writeFileSync(path, `Original ${suffix}`)
      await api.registerCanonicalProducedArtifact({ lifecycle: { id, projectId: 'project', goalId: 'goal', workItemId, runId,
        lineageId: `lineage:${suffix}`, kind: 'report', title: suffix, version: 1, provenance: 'explicit', mediaType: 'text/plain',
        retention: { mode: 'retain' }, metadata: { producer: 'fixture' }, content: { storageKind: 'source_ref', sourceRef: path } },
        evidence: { id: `evidence:${suffix}`, kind: 'delivery_check', title: suffix, summary: 'Bytes recorded', verifier: 'fixture' },
        acceptance: { id: `acceptance:${suffix}`, criterionId: `criterion:${suffix}`, criterion: 'Bytes recorded', status: 'passed', verifier: 'fixture' }, attachToStage: false }, root)
    }
  }
  const exported = await invoke('export')
  await check('export includes complete scoped audit from the same frozen result and historical records', async () => {
    const { snapshot, executionAudit: audit } = exported.bundle
    assert.ok(audit.total > 100); assert.equal(audit.total, audit.items.length)
    assert.equal(audit.aggregateDigest, snapshot.verification.aggregateDigest); assert.equal(audit.resultDigest, snapshot.verification.resultDigest)
    assert.equal(audit.items.filter(item => item.category === 'tool').length, 125)
    assert.equal(audit.coverage.permissions.status, 'partial'); assert.equal(audit.coverage.executors.status, 'unavailable')
    assert.equal(audit.coverage.modelAttempts.status, 'complete')
    assert.ok(audit.items.some(item => item.permissionDecision === 'deny' && item.approvalResolvedEventId === 'approval-resolution'))
    assert.ok(audit.items.some(item => item.status === 'waiting_reconciliation'))
    assert.ok(audit.items.some(item => item.action === 'effect_evidence.manual_confirmation' && item.actor.kind === 'human' && item.effectId === 'effect:unknown'))
    assert.ok(audit.items.some(item => item.model === 'persisted-model-delivery' && item.adapterVersion === 'native-adapter/v1'))
    assert.equal(snapshot.cost.knownUsd, 0.25)
    for (const text of ['current-model-unproven', 'raw-target-must-not-export', 'work:unrelated', 'persisted-model-unrelated']) assert.ok(!exported.json.includes(text), text)
  })
  const workBeforeSave = await workspace.getWorkItem('work:delivery')
  let saved, zip, manifest, result, auditBytes
  await check('save IPC writes digest-bound audit and human checklist and registers the produced ZIP', async () => {
    state.onSave = () => {
      writeFileSync(join(root, 'manual.txt'), 'Manual correction during save dialog')
      state.meta.model = 'switched-after-freeze'
    }
    saved = await invoke('save')
    assert.equal(saved.canceled, false); assert.equal((await workspace.getWorkItem('work:delivery')).status, workBeforeSave.status); assert.ok(saved.workflowArtifactId); assert.ok(saved.workflowEvidenceId); assert.ok(saved.workflowAcceptanceId)
    zip = await JSZip.loadAsync(readFileSync(saved.filePath))
    manifest = JSON.parse(await zip.file('manifest.json').async('string'))
    result = JSON.parse(await zip.file('result.json').async('string'))
    auditBytes = await zip.file('execution-audit.json').async('nodebuffer')
    assert.equal(manifest.executionAudit.contentDigest, sha256(auditBytes))
    assert.deepEqual(JSON.parse(auditBytes), result.executionAudit)
    assert.equal(manifest.exportDigest, result.exportDigest); assert.equal(manifest.resultDigest, result.executionAudit.resultDigest)
    assert.equal(saved.auditItems, result.executionAudit.total); assert.deepEqual(saved.acceptanceSummary, manifest.deliverySummary.acceptanceSummary)
    const checklist = await zip.file('DELIVERY.md').async('string')
    assert.ok(checklist.includes('execution-audit.json')); assert.ok(checklist.includes('manual')); assert.ok(checklist.includes('交付清单'))
    assert.ok(!(await zip.file('result.json').async('string')).includes('switched-after-freeze'))
    // The edited source deliberately makes its old Acceptance stale; ZIP registration is still canonical.
    await assert.rejects(api.verifyPersistedWorkflowLedger(root), /artifact bytes are invalid/)
  })
  await check('changed source is excluded, other bytes remain usable, and save counts describe actual ZIP', async () => {
    const changed = manifest.files.find(file => file.artifactId === 'artifact:manual')
    const good = manifest.files.find(file => file.artifactId === 'artifact:good')
    assert.equal(changed.contentIncluded, false); assert.equal(changed.contentStatus, 'digest_mismatch')
    assert.equal(good.contentIncluded, true); assert.equal(await zip.file(good.includedPath).async('string'), 'Original good')
    assert.equal(readFileSync(join(root, 'manual.txt'), 'utf8'), 'Manual correction during save dialog')
    assert.equal(saved.includedArtifacts, 1); assert.equal(saved.omittedArtifacts, 1)
  })
  await check('mixed snapshot/audit and modified result bytes cannot produce a portable package', async () => {
    const { snapshot, executionAudit: audit } = exported.bundle
    await assert.rejects(api.buildPortableDeliveryPackage(snapshot, exported.json, exported.exportDigest, { ...audit, resultDigest: 'sha256:' + 'f'.repeat(64) }), /STUDIO_AUDIT_SCOPE_MISMATCH/)
    await assert.rejects(api.buildPortableDeliveryPackage(snapshot, exported.json + ' ', exported.exportDigest, audit), /STUDIO_EXPORT_DIGEST_MISMATCH/)
  })
  assert.equal(networkCalls, 0)
  console.log(`studio-delivery-audit-required: ${passed}/${passed}; real IPC, canonical stores, ZIP and produced Artifact; no Provider calls`)
} finally {
  globalThis.fetch = oldFetch; delete globalThis[key]
  rmSync(root, { recursive: true, force: true })
}
