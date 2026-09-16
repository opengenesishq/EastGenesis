import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire, Module } from 'node:module'

// Exercise the real native scope, canonical stores, durable reservation and
// ModelAttempt admission. Only application settings and Provider transport /
// ModelAttempt storage are fixtures; no real Provider is contacted.
const require = createRequire(import.meta.url), ts = require('typescript')
const root = mkdtempSync(join(tmpdir(), 'caogen-goal-budget-'))
const cache = new Map(), stubs = new Map(), checks = []
const source = path => load(resolve(path))
const stub = (path, value) => stubs.set(resolve(path), value)
function load(path) {
  if (stubs.has(path)) return stubs.get(path)
  if (cache.has(path)) return cache.get(path).exports
  const mod = new Module(path); cache.set(path, mod); mod.filename = path; mod.paths = Module._nodeModulePaths(dirname(path))
  mod.require = name => {
    if (stubs.has(name)) return stubs.get(name)
    if (!name.startsWith('.')) return require(name)
    const target = resolve(dirname(path), name)
    if (target.endsWith('.json')) return require(target)
    return load(existsSync(`${target}.ts`) ? `${target}.ts` : target)
  }
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), { fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, path)
  return mod.exports
}
let history = [], starts = 0
const settings = { budgetUsdPerMonth: 0, budgetUsdPerSession: 0 }
const provider = { id: 'fixture', engine: 'openai', models: ['model'], advancedConfig: { modelProfiles: [
  { model: 'model', contextWindow: 2000000, pricing: { inputPerMillion: 0, outputPerMillion: 1, source: 'user' } }
] } }
stubs.set('electron', { app: { getPath: () => root } })
stub('src/main/settings.ts', { getSettings: () => settings })
stub('src/main/model/drive.ts', { settingsForCaoGenDrive: value => value })
stub('src/main/history.ts', { listHistory: () => history })
stub('src/main/providers.ts', { listProviders: () => [provider] })
stub('src/main/model/configured-model-profile.ts', { findConfiguredModelProfile: (model, profiles) => profiles?.find(profile => profile.model === model) })
stub('src/main/council/council-request-guard.ts', { councilBudgetConstraints: () => ({ budgets: [], observed: [] }) })
stub('src/main/task/model-attempt-api.ts', {
  startPersistedModelAttempt: async input => { starts++; return { ...input, revision: 1 } },
  completePersistedModelAttempt: async (id, input) => ({ id, ...input, revision: 2 }),
  getPersistedModelAttemptRetryAuthorization: async () => undefined
})
const { nativeRequestBudgetInput, nativeBudgetScope, nativeBudgetSnapshot } = source('src/main/model/native-request-budget.ts')
const { reserveRequestBudget, settleRequestBudget, readBudgetDocument } = source('src/main/budget/request-budget-store.ts')
const { beginPersistedModelAttempt } = source('src/main/task/model-attempt-runtime.ts')
const { SupervisorStateStore } = source('src/main/task/supervisor-state.ts')
const { taskRuntimeRegistry } = source('src/main/task/task-runtime-registry.ts')
const supervisor = new SupervisorStateStore(root)
let state = { schemaVersion: 1, revision: 1, workspaces: [{ id: 'project', status: 'active' }],
  goals: [{ id: 'goal', projectId: 'project', budget: { amount: 1, currency: 'USD' } },
    { id: 'other-goal', projectId: 'project', budget: { amount: 1 } }],
  workItems: ['a', 'b', 'c'].map(id => ({ id, projectId: 'project', goalId: 'goal' })), events: [] }
const save = () => writeFileSync(join(root, 'project-workspace.json'), JSON.stringify(state))
const meta = (id, goalId = 'goal') => ({ id, workspaceId: 'project', goalId, workItemId: goalId === 'goal' ? id : undefined,
  sdkSessionId: `sdk-${id}`, costUsd: 0, createdAt: Date.now(), providerId: provider.id, budgetUsd: 10 })
const request = session => nativeRequestBudgetInput({ meta: session, providerId: provider.id, model: 'model', rootDir: root,
  body: { model: 'model', messages: [{ role: 'user', content: 'bounded fixture' }], max_tokens: 600000 } })
const attempt = (id, budgetScope) => beginPersistedModelAttempt({ id, runId: `run-${id}`, requestId: `request-${id}`,
  providerId: provider.id, model: 'model', protocol: 'openai.chat-completions', adapterVersion: 'fixture',
  context: {}, routeReason: 'fixture', rootDir: root, budgetScope })
const scope = session => nativeBudgetScope(session, { rootDir: root })
const snapshot = session => nativeBudgetSnapshot(session, {}, root)
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`)
const pass = message => { checks.push(message); console.log(`PASS ${message}`) }
try {
  save()
  const a = meta('a'), b = meta('b'), c = meta('c')
  await supervisor.createRun({ id: 'run-a', projectId: 'project', goalId: 'goal', workItemId: 'a', budget: { amount: 1 } })
  taskRuntimeRegistry.set(a.id, { id: 'run-a', sessionId: a.id, toolExecutions: [] })
  // Both sibling scopes are captured before either reservation exists.
  const results = await Promise.allSettled([attempt('first', request(a)), attempt('second', request(b))])
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected')
  assert.equal(results[1].reason.code, 'ROUTING_BUDGET_UNAFFORDABLE'); assert.equal(starts, 1)
  close(snapshot(b).aggregateRemainingUsd[0], .4)
  pass('ordinary sibling WorkItems share one Goal reservation before ModelAttempt dispatch')

  await results[0].value.succeed({ costUsd: .4 })
  close(snapshot(b).aggregateRemainingUsd[0], .6)
  const record = readBudgetDocument(root).sessions.find(session => session.sessionIds.includes('a'))
  assert.ok(record.aggregateBudgetIds.includes('goal:project:goal'))
  pass('settled sibling cost remains charged before its history projection exists')

  const supervisorDocument = JSON.parse(readFileSync(join(root, 'supervisor-state.json'), 'utf8'))
  supervisorDocument.runs[0].usage.costUsd = .4
  writeFileSync(join(root, 'supervisor-state.json'), JSON.stringify(supervisorDocument))
  history = [{ ...a, costUsd: .4, updatedAt: Date.now() }]
  close(snapshot(b).aggregateRemainingUsd[0], .6)
  history = []
  close(snapshot(b).aggregateRemainingUsd[0], .6)
  pass('Supervisor and history projections do not double-charge; removed history cannot reset Goal spend')

  reserveRequestBudget({ rootDir: root, id: 'media:peer', kind: 'media', providerId: 'media-provider',
    scope: scope(b), estimatedUsd: .3 })
  close(snapshot(c).aggregateRemainingUsd[0], .3)
  settleRequestBudget({ rootDir: root, id: 'media:peer', status: 'unknown' })
  assert.equal(snapshot(c).aggregateRemainingUsd[0], 0)
  await assert.rejects(attempt('after-unknown', request(c)), error => error.code === 'ROUTING_BUDGET_EXHAUSTED')
  settleRequestBudget({ rootDir: root, id: 'media:peer', status: 'settled', actualUsd: .1 })
  close(snapshot(c).aggregateRemainingUsd[0], .5)
  pass('media reservations and ambiguous outcomes consume the same Goal purse until reconciliation')

  close(snapshot(meta('unrelated', 'other-goal')).aggregateRemainingUsd[0], 1)
  pass('unrelated Goal in the same Project retains its own configured allowance')

  taskRuntimeRegistry.set(a.id, { id: 'run-a', sessionId: a.id, toolExecutions: [] })
  state.goals[0].budget.amount = 2; save()
  assert.equal(scope(a).aggregateBudgets[0].limitUsd, 1)
  assert.equal(scope(c).aggregateBudgets[0].limitUsd, 2)
  taskRuntimeRegistry.delete(a.id)
  pass('existing Run keeps its frozen Goal cap after the Goal allowance increases')

  state.goals[0].budget = undefined; save()
  reserveRequestBudget({ rootDir: root, id: 'no-limit-yet', kind: 'model', providerId: provider.id,
    scope: scope(c), estimatedUsd: .25 })
  settleRequestBudget({ rootDir: root, id: 'no-limit-yet', status: 'settled', actualUsd: .25 })
  state.goals[0].budget = { amount: 1 }; save()
  close(snapshot(b).aggregateRemainingUsd[0], .25)
  pass('adding a Goal limit later includes requests made before the limit existed')

  assert.throws(() => scope({ ...c, workItemId: 'foreign' }), error => error.code === 'ROUTING_INVALID_BUDGET')
  state.goals[0].budget.currency = 'CNY'; save()
  assert.throws(() => scope(c), error => error.code === 'ROUTING_INVALID_BUDGET')
  state.goals[0].budget.currency = 'USD'; save()
  writeFileSync(join(root, 'project-workspace.json'), '{bad')
  assert.throws(() => scope(c), error => error.code === 'ROUTING_INVALID_BUDGET')
  save()
  pass('mismatched ownership, unsupported currency and damaged canonical records fail before dispatch')

  const unpriced = request(meta('unpriced', 'other-goal')); unpriced.estimatedUsd = undefined
  const before = starts
  await assert.rejects(attempt('unpriced', unpriced), error => error.code === 'ROUTING_BUDGET_UNAFFORDABLE')
  assert.equal(starts, before)
  pass('finite Goal budget refuses an unpriced request before starting a ModelAttempt')

  // Import/migration can leave Supervisor usage with no Session history or request ledger.
  supervisorDocument.runs[0].usage.costUsd = .9
  writeFileSync(join(root, 'supervisor-state.json'), JSON.stringify(supervisorDocument))
  close(snapshot(b).aggregateRemainingUsd[0], 0)
  await assert.rejects(attempt('legacy-cost', request(b)), error => error.code === 'ROUTING_BUDGET_EXHAUSTED')
  pass('canonical historical Run usage remains a spending floor when Session history is absent')

  // A later Session of the same WorkItem must not absorb an unrelated older
  // Run's cost just because both share the same WorkItem identity.
  state.goals[0].budget.amount = 2; save()
  const legacy = structuredClone(supervisorDocument.runs[0])
  legacy.id = 'legacy-run-without-session-link'; legacy.usage.costUsd = .8
  supervisorDocument.runs[0].usage.costUsd = .4
  supervisorDocument.runs.push(legacy)
  writeFileSync(join(root, 'supervisor-state.json'), JSON.stringify(supervisorDocument))
  close(snapshot(b).aggregateRemainingUsd[0], .45)
  pass('legacy unlinked Run spend is retained separately from later sessions of the same WorkItem')

  console.log(`Canonical request budget checks: ${checks.length}/${checks.length} passed; no Provider calls.`)
} finally { rmSync(root, { recursive: true, force: true }) }
