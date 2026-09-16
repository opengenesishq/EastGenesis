import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

// Run the production switch transaction and frozen routing builder. Provider
// availability and the independently verified handoff builder are boundaries.
const require = createRequire(import.meta.url), ts = require('typescript')
const cache = new Map(), boundaries = new Map()
function boundary(path, value) { boundaries.set(resolve(path), value) }
function load(file) {
  file = resolve(file)
  if (boundaries.has(file)) return boundaries.get(file)
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }; cache.set(file, module)
  const source = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  new Function('require', 'module', 'exports', source)(id => id.startsWith('.')
    ? load(resolve(dirname(file), `${id.replace(/\.js$/, '')}.ts`)) : require(id), module, module.exports)
  return module.exports
}
const canonical = load('src/main/task/workflow-ledger-canonical.ts')
const root = mkdtempSync(join(tmpdir(), 'caogen-model-switch-'))
const provider = { id: 'fixture', name: 'Fixture', ready: true, engine: 'openai' }
const settings = { schedulerStrategy: 'balanced', routingExpertPolicy: { locality: 'any', allowedProviderIds: [] } }
let armedRoute, preparationCount = 0
const handoffBoundary = {
  prepareSessionModelHandoff: async (meta, run) => {
    preparationCount++
    const body = { scope: { sessionId: meta.id }, sourceRunId: run?.id, artifacts: [], facts: [], failures: [] }
    return { ...body, digest: canonical.digest(body) }
  },
  assertSessionModelHandoff: (handoff, meta) => {
    const { digest, ...body } = handoff
    assert.equal(handoff.scope.sessionId, meta.id)
    assert.equal(digest, canonical.digest(body))
  }
}
boundary('src/main/agent/session-model-handoff.ts', handoffBoundary)
boundary('src/main/task/effect-runtime.ts', { runHasUnresolvedEffects: load('src/main/task/effect-ledger.ts').hasUnresolvedEffects })
boundary('src/main/providers.ts', { listProviders: () => [provider], getProviderConnectionIdentity: () => ({ generationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 1 }) })
boundary('src/main/settings.ts', { getSettings: () => settings })
boundary('src/shared/business-line-types.ts', { ...load('src/shared/business-line-types.ts'), getBusinessLines: () => [{ id: 'studio', enabled: true }] })
boundary('src/main/model/session-runtime-routing.ts', { resolveRuntimeSessionRoute: ({ meta }) => {
  if (meta.model === 'incompatible') throw new Error('incompatible target')
  return undefined
} })
boundary('src/main/model/session-turn-route.ts', { prepareSessionTurnRoute: (_meta, _payload, route) => { armedRoute = route } })
boundary('src/main/model/session-routing.ts', { createLegacyRoutingDecisionView: input => input })
boundary('src/main/model/routing-expert-policy.ts', { providerAllowedByRoutingExpertPolicy: () => true, isLocalProviderUrl: () => false })
boundary('src/main/provider/providerRuntimeTarget.ts', { resolveProviderRuntimeTarget: () => ({ baseUrl: 'https://fixture.invalid' }) })
boundary('src/main/model/executor-compatibility.ts', { resolveNativeExecutorProtocol: () => 'openai.chat-completions' })
for (const file of ['src/main/model/routing-policy/routing-policy-evaluator.ts', 'src/main/routing-service/session-routing-capture.ts', 'src/main/routing-settings/routing-settings-state.ts']) boundary(file, {})
const { applySessionModelSwitch } = load('src/main/ipc/session-model-switch-handler.ts')
const change = load('src/main/session-model-change.ts')
const { frozenPolicyForSessionRun } = load('src/main/task/frozen-routing-from-session.ts')
const { sessionHistoryEntry } = load('src/main/session-history-entry.ts')
const { withSessionOperationQueue } = load('src/main/session-operation-queue.ts')
function fixture() {
  const session = {
    meta: { id: 'session', model: 'old-model', providerId: 'fixture', routingScope: 'fixed', status: 'idle', sdkSessionId: 'sdk',
      workItemId: 'work', goalId: 'goal', workspaceId: 'project', businessLineId: 'studio', engine: 'openai', cwd: root },
    permissions: [], setCalls: 0, events: [], pendingPermissions() { return this.permissions },
    async setModel(model) { this.setCalls++; this.meta.model = model; this.meta.routingScope = model === 'auto' ? 'provider' : 'fixed' },
    emitSyntheticEvent(event) { this.events.push(event) }
  }
  const run = { id: 'run-old', sessionId: 'session', taskId: 'session', status: 'completed', revision: 1, createdAt: 1, effects: [], toolExecutions: [] }
  run.routingPolicy = frozenPolicyForSessionRun(session.meta, run, { text: 'original goal', messageId: 'original-message' })
  const saves = [], context = { rootDir: root, getRun: () => structuredClone(run), isCurrent: candidate => candidate === session,
    assertRecoveryAllowed: async () => {}, persist: async () => {
      saves.push(structuredClone(session.meta))
      writeFileSync(join(root, 'switch.json'), JSON.stringify(session.meta))
    } }
  return { session, run, saves, context }
}
let passed = 0
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`) }
try {
  await check('explicit change persists before adoption and retargets only the next Run; old policy remains immutable', async () => {
    const f = fixture(), oldPolicy = JSON.stringify(f.run.routingPolicy)
    const originalSetter = f.session.setModel.bind(f.session)
    f.session.setModel = async model => {
      const persisted = JSON.parse(readFileSync(join(root, 'switch.json')))
      assert.equal(persisted.modelChange.state, 'prepared'); assert.equal(persisted.model, 'old-model')
      return originalSetter(model)
    }
    await applySessionModelSwitch(f.session, 'new-model', f.context)
    assert.deepEqual(f.saves.map(meta => meta.modelChange.state), ['prepared', 'committed'])
    const restored = JSON.parse(readFileSync(join(root, 'switch.json')))
    change.assertSessionModelChangeReady(restored)
    assert.deepEqual(sessionHistoryEntry(restored).modelChange, restored.modelChange)
    const next = { ...f.run, id: 'run-next' }; delete next.routingPolicy
    next.routingPolicy = frozenPolicyForSessionRun(restored, next, { text: 'continue', messageId: 'next-message' }, f.run)
    assert.equal(next.routingPolicy.initialTarget.model, 'new-model')
    assert.equal(next.routingPolicy.effectivePolicy.failure.kind, 'pause')
    const later = { ...next, id: 'run-later' }; delete later.routingPolicy
    const inherited = frozenPolicyForSessionRun({ ...restored, model: 'settings-changed' }, later, { text: 'again', messageId: 'later-message' }, next)
    assert.equal(inherited.initialTarget.model, 'new-model'); assert.equal(armedRoute.model, 'new-model')
    assert.equal(JSON.stringify(f.run.routingPolicy), oldPolicy)
    await applySessionModelSwitch(f.session, 'new-model', f.context)
    assert.equal(f.session.setCalls, 1)
  })
  await check('ordinary setting changes cannot replace a frozen continuation target', async () => {
    const f = fixture(), next = { ...f.run, id: 'next' }; delete next.routingPolicy
    const policy = frozenPolicyForSessionRun({ ...f.session.meta, model: 'new-setting' }, next, { text: 'continue', messageId: 'continued' }, f.run)
    assert.equal(policy.initialTarget.model, 'old-model'); assert.equal(armedRoute.model, 'old-model')
  })
  await check('prepared or committed save failure blocks sending and resumes the same decision after restart', async () => {
    for (const failedSave of [1, 2]) {
      const f = fixture(), persist = f.context.persist; let calls = 0
      f.context.persist = async () => { if (++calls === failedSave) throw new Error('disk write failed'); await persist() }
      await assert.rejects(applySessionModelSwitch(f.session, 'new-model', f.context), /disk write failed/)
      assert.throws(() => change.assertSessionModelChangeReady(f.session.meta), /尚未确认保存/)
      const id = f.session.meta.modelChange.id, preparedCount = preparationCount
      await assert.rejects(applySessionModelSwitch(f.session, 'third-model', f.context), /同一模型/)
      // Simulate reopening the durable prepared projection after the second write failed.
      if (failedSave === 2) f.session.meta = JSON.parse(readFileSync(join(root, 'switch.json')))
      f.context.persist = persist
      await applySessionModelSwitch(f.session, 'new-model', f.context)
      assert.equal(f.session.meta.modelChange.id, id); assert.equal(preparationCount, preparedCount)
      change.assertSessionModelChangeReady(f.session.meta)
    }
  })
  await check('active execution, approval, unresolved Effect/request, and incompatible model cannot change a task', async () => {
    for (const mutate of [
      f => { f.session.meta.status = 'running' },
      f => { f.session.permissions.push({ requestId: 'approval' }) },
      f => { f.run.effects.push({ status: 'waiting_reconciliation' }) },
      f => { f.run.toolExecutions.push({ status: 'unknown_outcome' }) },
      f => { f.context.assertRecoveryAllowed = async () => { throw new Error('unknown request') } },
      f => { f.run.status = 'recovering' }
    ]) {
      const f = fixture(); mutate(f)
      await assert.rejects(applySessionModelSwitch(f.session, 'new-model', f.context))
      assert.equal(f.session.setCalls, 0); assert.equal(f.saves.length, 0)
    }
    const f = fixture()
    await assert.rejects(applySessionModelSwitch(f.session, 'incompatible', f.context), /incompatible/)
    assert.equal(f.session.setCalls, 0)
    for (const value of ['', 'bad\u0000model', 'x'.repeat(241)]) await assert.rejects(applySessionModelSwitch(f.session, value, f.context))
  })
  await check('pruned terminal snapshot recovers the prepared source from the canonical Run without changing identity', async () => {
    const f = fixture(), persist = f.context.persist; let writes = 0
    f.context.persist = async () => { if (++writes === 2) throw new Error('interrupted'); await persist() }
    await assert.rejects(applySessionModelSwitch(f.session, 'new-model', f.context), /interrupted/)
    f.session.meta = JSON.parse(readFileSync(join(root, 'switch.json')))
    const recovered = change.restoreModelChangeSourceRun(f.session.meta, [f.run])
    assert.equal(recovered.id, 'run-old')
    f.context.getRun = () => recovered; f.context.persist = persist
    await applySessionModelSwitch(f.session, 'new-model', f.context)
    change.assertSessionModelChangeReady(f.session.meta)
    const prepared = f.saves[0]
    assert.throws(() => change.restoreModelChangeSourceRun(prepared, []), /缺失/)
    assert.throws(() => change.restoreModelChangeSourceRun(prepared, [f.run, { ...f.run, id: 'later', createdAt: 2 }]), /替代/)
    assert.throws(() => change.restoreModelChangeSourceRun(prepared, [{ ...f.run, sessionId: 'another' }]), /缺失|owner/)
  })
  await check('handoff preparation races and receipt tampering cannot authorize a route replacement', async () => {
    const f = fixture()
    f.context.prepareHandoff = async (...args) => { const result = await handoffBoundary.prepareSessionModelHandoff(...args); f.run.revision++; return result }
    await assert.rejects(applySessionModelSwitch(f.session, 'new-model', f.context), /任务状态已变化/)
    assert.equal(f.session.setCalls, 0)
    const valid = fixture(); await applySessionModelSwitch(valid.session, 'new-model', valid.context)
    const copy = structuredClone(valid.session.meta); copy.modelChange.to.model = 'tampered'
    assert.throws(() => change.assertSessionModelChangeReady(copy), /不一致/)
    const stale = structuredClone(valid.run); stale.routingPolicy.policyDigest = '0'.repeat(64)
    assert.throws(() => change.hasExplicitModelChange(valid.session.meta, stale), /不一致/)
    const moved = { ...valid.session.meta, id: 'different-session' }
    assert.throws(() => change.assertSessionModelChangeReady(moved), /不一致/)
  })
  await check('switch and follow-up send are serialized by the same Session operation queue', async () => {
    const f = fixture(); let release, entered
    const barrier = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { entered = resolve })
    f.context.prepareHandoff = async (...args) => { entered(); await barrier; return handoffBoundary.prepareSessionModelHandoff(...args) }
    const switching = withSessionOperationQueue('session', () => applySessionModelSwitch(f.session, 'new-model', f.context))
    await ready; let sent = false
    const sending = withSessionOperationQueue('session', async () => { change.assertSessionModelChangeReady(f.session.meta); assert.equal(f.session.meta.model, 'new-model'); sent = true })
    await Promise.resolve(); assert.equal(sent, false); release(); await Promise.all([switching, sending]); assert.equal(sent, true)
  })
  console.log(`session-model-change-required: ${passed}/${passed}; production transaction and frozen Run routing; no Provider I/O`)
} finally { rmSync(root, { recursive: true, force: true }) }
