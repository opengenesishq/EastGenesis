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
const models = ['old-model', 'new-model', 'third-model', 'shared-model']
const provider = { id: 'fixture', name: 'Fixture', ready: true, engine: 'openai', baseUrl: 'https://fixture.invalid', models,
  advancedConfig: { modelProfiles: models.map(model => ({ model, capabilities: ['text', 'tools'], contextWindow: 128000, pricing: { inputPerMillion: 1, outputPerMillion: 1 } })) } }
const backup = { ...provider, id: 'backup', name: 'Backup' }
const otherProtocol = { ...provider, id: 'anthropic', engine: 'anthropic' }
const providers = [provider, backup, otherProtocol]
let remainingBudget, denyTarget
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
boundary('src/main/providers.ts', { listProviders: () => providers, resolveProviderEngine: provider => provider.engine, getProviderConnectionIdentity: () => ({ generationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 1 }) })
boundary('src/main/settings.ts', { getSettings: () => settings, getRoutingSettingsBoundary: () => ({ read: () => ({ document: {} }) }) })
boundary('src/shared/business-line-types.ts', { ...load('src/shared/business-line-types.ts'), getBusinessLines: () => [{ id: 'studio', enabled: true }] })
boundary('src/main/model/session-runtime-routing.ts', { resolveRuntimeSessionRoute: ({ meta }) => {
  if (meta.model === 'incompatible') throw new Error('incompatible target')
  return undefined
} })
boundary('src/main/model/session-turn-route.ts', { prepareSessionTurnRoute: (_meta, _payload, route) => { armedRoute = route } })
boundary('src/main/model/session-routing.ts', { createLegacyRoutingDecisionView: input => input })
boundary('src/main/model/routing-expert-policy.ts', { providerAllowedByRoutingExpertPolicy: () => true, isLocalProviderUrl: () => false })
boundary('src/main/provider/providerRuntimeTarget.ts', { resolveProviderRuntimeTarget: () => ({ baseUrl: 'https://fixture.invalid' }) })
boundary('src/main/model/executor-compatibility.ts', { resolveNativeExecutorProtocol: provider => provider.engine === 'anthropic' ? 'anthropic.messages' : provider.engine === 'gemini' ? 'google.generative-language' : 'openai.chat-completions' })
boundary('src/main/task/workflow-ledger-codec.ts', canonical)
boundary('src/main/model/acceptance-quality-signal.ts', {})
boundary('src/main/model/route-observation-signal.ts', { routeObservationIdentity: () => undefined })
boundary('src/main/routing-settings/routing-settings-state.ts', { readStoredRoutingState: () => ({ mode: 'legacy_active' }) })
const controls = load('src/shared/session-routing-control-types.ts')
const { canonicalTarget } = load('src/main/model/routing-policy/evaluator-catalog.ts')
boundary('src/main/routing-service/session-routing-capture.ts', { captureSessionRouting: ({ meta, prompt }) => ({
  context: { executionDomain: 'native_text', originalPrompt: prompt, businessLine: { id: 'studio', enabled: true, requiredCapabilities: ['tools'] },
    userIntent: controls.sessionRoutingIntent(meta), baseStrategy: 'balanced', baseStrategySource: { kind: 'global' }, task: { requiresTools: true } },
  snapshots: { providers, expertPolicy: settings.routingExpertPolicy,
    budget: remainingBudget === undefined ? undefined : { remainingUsd: remainingBudget, hardLimit: true },
    targetEligibility: providers.flatMap(provider => provider.models.map(model => ({ target: canonicalTarget(provider, model),
      allowed: model !== 'incompatible' && denyTarget !== provider.id, reasons: [], connectionFingerprint: 'fixture' }))),
    providerHealth: {}, scoringSignals: providers.flatMap(provider => provider.models.map(model => ({ providerId: provider.id, model, reliability: 0.5 }))) }
}) })
const { applySessionModelSwitch, applySessionRoutingControl } = load('src/main/ipc/session-model-switch-handler.ts')
const change = load('src/main/session-model-change.ts')
const { frozenPolicyForSessionRun } = load('src/main/task/frozen-routing-from-session.ts')
const { sessionHistoryEntry } = load('src/main/session-history-entry.ts')
const { withSessionOperationQueue } = load('src/main/session-operation-queue.ts')
function fixture() {
  const session = {
    meta: { id: 'session', model: 'old-model', providerId: 'fixture', routingScope: 'fixed', status: 'idle', sdkSessionId: 'sdk',
      workItemId: 'work', goalId: 'goal', workspaceId: 'project', businessLineId: 'studio', engine: 'openai', cwd: root },
    permissions: [], setCalls: 0, events: [], pendingPermissions() { return this.permissions },
    async setModel(model, providerId) { this.setCalls++; if (providerId) this.meta.providerId = providerId; this.meta.model = model; this.meta.routingScope = model === 'auto' ? 'provider' : 'fixed' },
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
    await assert.rejects(applySessionModelSwitch(f.session, 'incompatible', f.context), /不可执行/)
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
  await check('preferred production evaluator freezes primary and only the authorized same-protocol backup', async () => {
    const f = fixture(), original = JSON.stringify(f.run.routingPolicy)
    const control = { kind: 'preferred', primary: { providerId: 'fixture', model: 'new-model' },
      alternatives: [{ providerId: 'backup', model: 'shared-model' }],
      failure: { kind: 'retry_allowed_targets', maxAdditionalAttempts: 1, retryOn: ['rate_limited'] } }
    await applySessionRoutingControl(f.session, control, f.context)
    assert.deepEqual(f.session.meta.routingControl, control)
    assert.deepEqual(f.saves.map(meta => meta.modelChange.state), ['prepared', 'committed'])
    const next = { ...f.run, id: 'preferred-run' }; delete next.routingPolicy
    const policy = frozenPolicyForSessionRun(f.session.meta, next, { text: 'continue', messageId: 'preferred-message' }, f.run)
    assert.equal(policy.initialTarget.providerId, 'fixture'); assert.equal(policy.initialTarget.model, 'new-model')
    assert.deepEqual(policy.retryTargets.map(({ providerId, model }) => ({ providerId, model })), control.alternatives)
    assert.equal(policy.matchedRules[0].id, 'session-routing-control')
    assert.equal(armedRoute.providerId, 'fixture'); assert.equal(armedRoute.model, 'new-model')
    assert.equal(JSON.stringify(f.run.routingPolicy), original)
    next.routingPolicy = policy
    const successor = { ...next, id: 'preferred-next' }; delete successor.routingPolicy
    assert.equal(frozenPolicyForSessionRun(f.session.meta, successor, { text: 'again', messageId: 'preferred-next-message' }, next).initialTarget.model, 'new-model')
    denyTarget = 'fixture'
    assert.throws(() => frozenPolicyForSessionRun(f.session.meta, { ...f.run, id: 'refused' }, { text: 'continue', messageId: 'refused-message' }, f.run), /不可执行/)
    denyTarget = undefined
  })
  await check('locked same-name cross-provider selection is durable and does not grant retry', async () => {
    const f = fixture(); f.session.meta.model = 'shared-model'
    await applySessionRoutingControl(f.session, { kind: 'locked', target: { providerId: 'backup', model: 'shared-model' } }, f.context)
    assert.equal(f.session.meta.providerId, 'backup'); assert.equal(f.saves[0].providerId, 'fixture')
    const policy = frozenPolicyForSessionRun(f.session.meta, { ...f.run, id: 'locked-next' }, { text: 'continue', messageId: 'locked-message' }, f.run)
    assert.equal(policy.initialTarget.providerId, 'backup'); assert.deepEqual(policy.retryTargets, [])
    assert.equal(policy.effectivePolicy.failure.kind, 'pause')
  })
  await check('aliases preserve the saved choice while locked/preferred policies freeze canonical targets', async () => {
    const aliasProvider = { ...provider, id: 'alias-provider', models: ['canonical-primary', 'canonical-backup'],
      advancedConfig: { modelProfiles: [
        { model: 'canonical-primary', aliases: ['primary-alias'], capabilities: ['text', 'tools'], contextWindow: 128000 },
        { model: 'canonical-backup', aliases: ['backup-alias'], capabilities: ['text', 'tools'], contextWindow: 128000 }
      ] } }
    providers.push(aliasProvider)
    try {
      for (const kind of ['locked', 'preferred']) {
        const f = fixture()
        const primary = { providerId: aliasProvider.id, model: 'primary-alias' }
        const control = kind === 'locked' ? { kind, target: primary } : { kind, primary,
          alternatives: [{ providerId: aliasProvider.id, model: 'backup-alias' }],
          failure: { kind: 'retry_allowed_targets', maxAdditionalAttempts: 1, retryOn: ['rate_limited'] } }
        const original = structuredClone(control)
        await applySessionRoutingControl(f.session, control, f.context)
        assert.deepEqual(control, original)
        assert.deepEqual(f.session.meta.modelChange.to.routingControl, original, 'receipt must preserve user selected spelling')
        const policy = frozenPolicyForSessionRun(f.session.meta, { ...f.run, id: `alias-${kind}` },
          { text: 'continue', messageId: `alias-${kind}-message` }, f.run)
        assert.equal(policy.initialTarget.providerId, aliasProvider.id)
        assert.equal(policy.initialTarget.model, 'canonical-primary')
        if (kind === 'locked') {
          assert.deepEqual(policy.effectivePolicy.selection.target, { providerId: aliasProvider.id, model: 'canonical-primary' })
          assert.deepEqual(policy.userIntent.target, { providerId: aliasProvider.id, model: 'canonical-primary' })
          assert.deepEqual(policy.retryTargets, [])
        } else {
          assert.deepEqual(policy.effectivePolicy.selection.primary, { providerId: aliasProvider.id, model: 'canonical-primary' })
          assert.deepEqual(policy.effectivePolicy.selection.alternatives, [{ providerId: aliasProvider.id, model: 'canonical-backup' }])
          assert.deepEqual(policy.retryTargets.map(({ providerId, model }) => ({ providerId, model })), [{ providerId: aliasProvider.id, model: 'canonical-backup' }])
        }
      }
      const refused = fixture()
      await assert.rejects(applySessionRoutingControl(refused.session, { kind: 'preferred',
        primary: { providerId: aliasProvider.id, model: 'primary-alias' },
        alternatives: [{ providerId: 'backup', model: 'backup-alias' }], failure: { kind: 'pause' } }, refused.context))
      assert.equal(refused.saves.length, 0, 'an alias from another provider must not widen the catalog')
    } finally { providers.pop() }
  })
  await check('Gemini catalog prefixes normalize only frozen targets and retain selected provider identity', async () => {
    const gemini = { ...provider, id: 'gemini-fixture', engine: 'gemini', models: ['models/gemini-primary', 'models/gemini-backup'],
      advancedConfig: { modelProfiles: ['models/gemini-primary', 'models/gemini-backup'].map(model => ({ model, capabilities: ['text', 'tools'], contextWindow: 128000 })) } }
    providers.push(gemini)
    try {
      const f = fixture()
      const control = { kind: 'preferred', primary: { providerId: gemini.id, model: 'models/gemini-primary' },
        alternatives: [{ providerId: gemini.id, model: 'models/gemini-backup' }],
        failure: { kind: 'retry_allowed_targets', maxAdditionalAttempts: 1, retryOn: ['rate_limited'] } }
      await applySessionRoutingControl(f.session, control, f.context)
      assert.deepEqual(f.session.meta.routingControl, control)
      const policy = frozenPolicyForSessionRun(f.session.meta, { ...f.run, id: 'gemini-prefixed' },
        { text: 'continue', messageId: 'gemini-prefixed-message' }, f.run)
      assert.deepEqual(policy.initialTarget, { providerId: gemini.id, model: 'gemini-primary', protocol: 'google.generative-language' })
      assert.deepEqual(policy.retryTargets, [{ providerId: gemini.id, model: 'gemini-backup', protocol: 'google.generative-language' }])
      assert.equal(policy.qualifiedTargets.every(target => target.providerId === gemini.id), true)
    } finally { providers.pop() }
  })
  await check('budget, invalid target, cross-protocol alternatives and noncanonical preferred reject before mutation', async () => {
    const preferred = { kind: 'preferred', primary: { providerId: 'fixture', model: 'new-model' }, alternatives: [], failure: { kind: 'pause' } }
    for (const mutate of [
      f => { remainingBudget = 0 },
      f => { delete f.session.meta.workItemId },
      f => { preferred.alternatives = [{ providerId: 'anthropic', model: 'new-model' }] },
      f => { preferred.alternatives = [{ providerId: 'backup', model: 'missing' }] }
    ]) {
      const f = fixture(); mutate(f)
      await assert.rejects(applySessionRoutingControl(f.session, preferred, f.context))
      assert.equal(f.saves.length, 0); assert.equal(f.session.setCalls, 0)
      remainingBudget = undefined; preferred.alternatives = []
    }
    const f = fixture()
    await assert.rejects(applySessionRoutingControl(f.session, { kind: 'locked', target: { providerId: 'anthropic', model: 'new-model' } }, f.context), /跨执行器/)
    await assert.rejects(applySessionRoutingControl(f.session, { kind: 'locked', target: { providerId: 'fixture', model: 'new-model' }, failure: { kind: 'retry_allowed_targets' } }, f.context))
  })
  await check('legacy auto keeps provider scope and legacy missing scope produces a valid committed receipt', async () => {
    const f = fixture(); delete f.session.meta.routingScope
    await applySessionModelSwitch(f.session, 'new-model', f.context)
    change.assertSessionModelChangeReady(f.session.meta)
    await applySessionModelSwitch(f.session, 'auto', f.context)
    assert.deepEqual(f.session.meta.routingControl, { kind: 'auto', scope: { kind: 'provider', providerId: 'fixture' } })
    change.assertSessionModelChangeReady(f.session.meta)
  })
  await check('cross-engine preferred keeps the active provider until the next frozen continuation', async () => {
    const f = fixture()
    await applySessionRoutingControl(f.session, { kind: 'preferred', primary: { providerId: 'anthropic', model: 'new-model' },
      alternatives: [], failure: { kind: 'pause' } }, f.context)
    assert.equal(f.session.meta.providerId, 'fixture'); assert.equal(f.session.meta.engine, 'openai')
    assert.equal(f.saves[1].providerId, 'fixture')
    const next = { ...f.run, id: 'cross-engine-next' }; delete next.routingPolicy
    const policy = frozenPolicyForSessionRun(f.session.meta, next, { text: 'continue', messageId: 'cross-engine-message' }, f.run)
    assert.equal(policy.initialTarget.providerId, 'anthropic'); assert.equal(policy.initialTarget.protocol, 'anthropic.messages')
    assert.equal(armedRoute.providerId, 'anthropic')
  })
  console.log(`session-model-change-required: ${passed}/${passed}; production transaction and frozen Run routing; no Provider I/O`)
} finally { rmSync(root, { recursive: true, force: true }) }
