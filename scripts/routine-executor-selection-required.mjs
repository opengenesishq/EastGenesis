import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

// Exercise production dispatch, routing, creation and frozen-policy code with
// local storage/transport boundaries. No credentials or Provider I/O.
const require = createRequire(import.meta.url), ts = require('typescript')
const root = mkdtempSync(join(tmpdir(), 'caogen-routine-executor-'))
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
  new Function('require', 'module', 'exports', source)(id => id === 'electron'
    ? { app: { getPath: () => root }, powerSaveBlocker: {} }
    : id.startsWith('.') ? load(resolve(dirname(file), `${id.replace(/\.js$/, '')}.ts`)) : require(id), module, module.exports)
  return module.exports
}
const providers = ['anthropic', 'openai', 'gemini'].map(engine => ({
  id: engine, name: engine, engine, ready: true, baseUrl: 'https://fixture.invalid/v1', openaiProtocol: 'chat',
  models: ['fixture-model'], advancedConfig: { modelProfiles: [{ model: 'fixture-model',
    capabilities: ['text', 'tools', 'vision'], contextWindow: 128000 }] }
}))
const settings = { driveMode: 'core', schedulerStrategy: 'balanced', defaultProviderId: 'openai', defaultModel: 'fixture-model',
  permissionAllowlist: '', permissionDenylist: '', routingExpertPolicy: { locality: 'any', allowedProviderIds: [] } }
const identity = { generationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 1 }
let history = [], rankedProviders = []
boundary('src/main/providers.ts', { listProviders: () => providers, getProvider: id => providers.find(p => p.id === id),
  providerIsReady: p => p.ready, resolveProviderEngine: p => p.engine, getProviderConnectionIdentity: () => identity })
boundary('src/main/settings.ts', { getSettings: () => settings, getRoutingSettingsBoundary: () => ({ read: () => ({ document: {} }) }) })
boundary('src/main/history.ts', { listHistory: () => history })
boundary('src/main/model/native-request-budget.ts', { nativeBudgetSnapshot: () => ({ sessionSpentUsd: 0 }) })
boundary('src/main/model/monthly-budget.ts', { calculateMonthlyBudgetSnapshot: () => ({}) })
boundary('src/main/providerHealth.ts', { getHealth: () => ({ healthy: true, circuitState: 'closed' }) })
boundary('src/main/model/model-router.ts', { captureModelRouteScoringSignal: p => ({ providerId: p.providerId, model: p.model }) })
boundary('src/main/model/session-routing.ts', { createLegacyRoutingDecisionView: input => input, resolveSessionModelRoute: input => {
  rankedProviders = input.providers
  const provider = input.providers[0]
  if (!provider) return { kind: 'unavailable' }
  return { kind: 'routed', providerId: provider.id, model: provider.models[0], decision: {}, crossValidationPlan: { primary: {} } }
} })
boundary('src/main/routing-settings/routing-settings-state.ts', { readStoredRoutingState: () => ({ mode: 'legacy_active' }) })
boundary('src/shared/business-line-types.ts', { ...load('src/shared/business-line-types.ts'),
  getBusinessLines: () => [{ id: 'assistant', enabled: true, requiredCapabilities: ['tools'] }] })
boundary('src/main/business-line-execution-policy.ts', {
  filterBusinessLineModels: value => value, applyBusinessLineCreationPolicy: () => {}, assertBusinessLineTaskStrategy: () => {}
})
boundary('src/main/projects.ts', { getProject: () => ({ id: 'project' }), touchProject: () => ({ id: 'project' }) })
boundary('src/main/ipc/worktree-operation-handlers.ts', {})
boundary('src/main/project-workspace/store.ts', {})
boundary('src/main/task/operation-effect-gateway.ts', {})
boundary('src/main/worktrees.ts', { inspectManagedWorktreeIdentity: () => undefined, inspectManagedWorktreeRegistryRecord: () => ({}) })
boundary('src/main/permission/task-execution-authority-marker.ts', { reconcileTaskExecutionAuthorityMarker: value => value })
boundary('src/main/session-model-change.ts', { assertSessionModelChange: () => undefined, hasExplicitModelChange: () => false })
boundary('src/main/session-routing-control.ts', {})
let armedRoute
boundary('src/main/model/session-turn-route.ts', { prepareSessionTurnRoute: (_meta, _payload, route) => { armedRoute = route } })
const { resolveRuntimeSessionRoute } = load('src/main/model/session-runtime-routing.ts')
const { captureSessionRouting } = load('src/main/routing-service/session-routing-capture.ts')
const { prepareSessionCreationDraft, sessionMetaForRecovery } = load('src/main/session-create-lifecycle.ts')
const { frozenPolicyForSessionRun } = load('src/main/task/frozen-routing-from-session.ts')
const { sealFrozenRoutingPolicy, verifyFrozenRoutingPolicy } = load('src/main/task/frozen-routing-policy.ts')
const { sessionHistoryEntry } = load('src/main/session-history-entry.ts')
const meta = { id: 'session', model: 'fixture-model', providerId: 'openai', engine: 'openai', executorEngine: 'openai',
  createdAt: 1, costUsd: 0, contextTokens: 0, routingScope: 'fixed', driveMode: 'core', businessLineId: 'assistant',
  cwd: root, workspaceId: 'project', goalId: 'goal', workItemId: 'work', taskStrategy: 'execute' }
const route = overrides => resolveRuntimeSessionRoute({ meta: { ...meta, ...overrides }, payload: { text: 'prepare a report' },
  settings, providers, history: [], allowAnyEngine: true })
const run = { id: 'run', sessionId: 'session', taskId: 'session' }
const payload = { text: 'prepare a report', messageId: 'message' }
let passed = 0
async function check(name, operation) { await operation(); passed++; console.log(`PASS ${name}`) }
try {
  await check('fixed models honor explicit executor choice; legacy engine hint remains compatible', () => {
    assert.equal(route({}), undefined)
    assert.throws(() => route({ providerId: 'anthropic' }), error => error.code === 'ROUTING_MANUAL_TARGET_UNAVAILABLE')
    assert.equal(route({ providerId: 'anthropic', executorEngine: undefined }), undefined)
    assert.throws(() => route({ executorEngine: 'external-agent' }), /尚未实现/)
  })
  await check('global auto excludes incompatible engines before ranking even during engine selection', () => {
    assert.equal(route({ model: 'auto', routingScope: 'global' }).providerId, 'openai')
    assert.deepEqual(rankedProviders.map(p => p.engine), ['openai'])
    assert.equal(route({ model: 'auto', routingScope: 'global', executorEngine: undefined }).providerId, 'anthropic')
    assert.equal(rankedProviders.length, 3)
  })
  await check('V1 capture and preview authority retain the executor requirement', () => {
    const capture = captureSessionRouting({ meta: { ...meta, model: 'auto', routingScope: 'global' }, prompt: payload.text })
    assert.equal(capture.authority.executorEngine, 'openai')
    assert.deepEqual(capture.snapshots.targetEligibility.filter(t => t.allowed).map(t => t.target.providerId), ['openai'])
    const legacy = captureSessionRouting({ meta: { ...meta, executorEngine: undefined }, prompt: payload.text })
    assert.equal(legacy.snapshots.targetEligibility.filter(t => t.allowed).length, 3)
  })
  await check('creation and history resume preserve executor and task identity; fork makes its own selection', () => {
    const opts = { cwd: root, providerId: 'openai', model: 'fixture-model', unassigned: true, executorEngine: 'openai' }
    const created = prepareSessionCreationDraft(opts)
    assert.equal(created.baseMeta.executorEngine, 'openai')
    assert.notEqual(created.opts, opts)
    const legacy = prepareSessionCreationDraft({ ...opts, executorEngine: undefined, engine: 'gemini' })
    assert.equal(legacy.baseMeta.engine, 'openai')
    assert.equal(legacy.baseMeta.executorEngine, undefined)
    history = [{ ...created.baseMeta, id: 'saved-session', createdAt: 10, sdkSessionId: 'saved-sdk' }]
    const resumed = prepareSessionCreationDraft({ cwd: root, resumeSdkSessionId: 'saved-sdk' })
    assert.equal(resumed.baseMeta.id, 'saved-session')
    assert.equal(resumed.baseMeta.createdAt, 10)
    assert.equal(resumed.baseMeta.executorEngine, 'openai')
    assert.equal(sessionHistoryEntry(resumed.baseMeta).executorEngine, 'openai')
    assert.equal(sessionMetaForRecovery(resumed.baseMeta).executorEngine, 'openai')
    assert.throws(() => sessionMetaForRecovery({ ...resumed.baseMeta, engine: 'anthropic' }), /任务要求 openai 执行器/)
    assert.throws(() => sessionMetaForRecovery({ ...resumed.baseMeta, executorEngine: 'external-agent' }), /尚未实现/)
    assert.throws(() => prepareSessionCreationDraft({ cwd: root, resumeSdkSessionId: 'saved-sdk', executorEngine: 'gemini' }), /不能更改/)
    const fork = prepareSessionCreationDraft({ cwd: root, forkFromSdkSessionId: 'saved-sdk', model: 'fixture-model', providerId: 'anthropic' })
    assert.equal(fork.baseMeta.executorEngine, undefined)
    assert.equal(fork.baseMeta.engine, 'anthropic')
    assert.notEqual(fork.baseMeta.id, 'saved-session')
    history = []
  })
  await check('frozen Run preserves explicit executor bounds and refuses cross-protocol qualified/retry targets', () => {
    const frozen = frozenPolicyForSessionRun(meta, run, payload)
    assert.equal(frozen.hardBounds.executorEngine, 'openai')
    assert.equal(verifyFrozenRoutingPolicy(frozen).hardBounds.executorEngine, 'openai')
    const inherited = frozenPolicyForSessionRun(meta, { ...run, id: 'next' }, { ...payload, messageId: 'next-message' }, { ...run, routingPolicy: frozen })
    assert.equal(inherited.hardBounds.executorEngine, 'openai')
    assert.equal(armedRoute.providerId, 'openai')
    assert.throws(() => frozenPolicyForSessionRun({ ...meta, executorEngine: undefined }, { ...run, id: 'next' }, payload, { ...run, routingPolicy: frozen }), /已冻结/)
    const cross = { providerId: 'anthropic', model: 'fixture-model', protocol: 'anthropic.messages' }
    assert.throws(() => sealFrozenRoutingPolicy({ ...frozen, userIntent: { kind: 'global' },
      effectivePolicy: { ...frozen.effectivePolicy, selection: { kind: 'global_auto' },
        failure: { kind: 'retry_allowed_targets', maxAdditionalAttempts: 1, retryOn: ['rate_limited'] } },
      qualifiedTargets: [...frozen.qualifiedTargets, { ...cross, connectionIdentity: identity }], retryTargets: [cross] }), /executor requirement/)
    const legacy = frozenPolicyForSessionRun({ ...meta, executorEngine: undefined }, run, payload)
    assert.equal(Object.hasOwn(legacy.hardBounds, 'executorEngine'), false)
    assert.doesNotThrow(() => frozenPolicyForSessionRun({ ...meta, executorEngine: undefined }, { ...run, id: 'legacy-next' }, payload, { ...run, routingPolicy: legacy }))
  })

  let createdOptions, sentPrompt, historyPersisted = false, dispatchPersisted = false
  boundary('src/main/routineScheduler.ts', { computeNextRun: () => null })
  boundary('src/main/desktopNotify.ts', {})
  boundary('src/main/routineStore.ts', {})
  boundary('src/main/routines/personal-os.ts', { runWithPersonalOsPowerBlocker: (_options, operation) => operation() })
  boundary('src/main/routines/routine-session-lifecycle.ts', { initializeRoutineSessionLifecycle: () => {} })
  let heartbeatRoutine
  boundary('src/main/routines/routine-heartbeat-runtime.ts', { routineHeartbeatService: () => ({ trigger: async routine => { heartbeatRoutine = routine; return { id: 'original-task-run' } } }) })
  boundary('src/main/routines/routine-project-runtime.ts', { prepareRoutineProjectExecution: async (_root, _routine, _run, bind) => {
    const binding = { projectId: 'project', goalId: 'goal', workItemId: 'work', cwd: root }
    await bind(binding); return binding
  }, transitionRoutineWorkItem: async () => {}, transitionRoutineGoal: async () => {} })
  boundary('src/main/routines/routine-runner.ts', {
    runRoutineWithHistory: async (_root, routine, execute) => {
      const result = await execute(routine, { id: 'routine-run' }); historyPersisted = true
      return { id: 'routine-run', status: 'running', ...result }
    }, setRoutineRunExecutionBinding: async () => ({}),
    setRoutineRunDispatchState: async (_root, _id, state) => {
      if (state === 'session_created') dispatchPersisted = true
      return { id: 'routine-run', status: 'running' }
    }
  })
  boundary('src/main/sessionManager.ts', { sessionManager: {
    createManaged: async (opts, hooks) => { createdOptions = opts; await hooks.beforeStart({ id: 'routine-session' }); return { id: 'routine-session' } },
    send: async (_id, prompt) => { assert.ok(historyPersisted && dispatchPersisted); sentPrompt = prompt; return true },
    getTaskRun: () => ({ id: 'routine-task-run' })
  } })
  const { executeRoutine } = load('src/main/routines/routine-executor.ts')
  await check('Routine dispatch binds saved executor and real prompt before sending', async () => {
    const routine = { id: 'routine', name: 'Daily report', engine: 'gemini', prompt: 'Summarize the attached chart', model: 'auto' }
    await executeRoutine(root, routine, { sendDelayMs: 0, nextRunAt: null })
    assert.equal(createdOptions.executorEngine, 'gemini')
    assert.equal(createdOptions.initialPrompt, routine.prompt)
    assert.equal(createdOptions.workspaceId, 'project')
    assert.equal(createdOptions.goalId, 'goal')
    assert.equal(createdOptions.workItemId, 'work')
    assert.equal(sentPrompt, routine.prompt)
    assert.equal(createdOptions.isolated, false)
    await executeRoutine(root, { ...routine, model: 'fixture-model', executionLocation: 'worktree', reasoningEffort: 'high' }, { sendDelayMs: 0, nextRunAt: null })
    assert.equal(createdOptions.isolated, true)
    assert.equal(createdOptions.reasoningEffort, 'high')
    await executeRoutine(root, { ...routine, engine: undefined }, { sendDelayMs: 0, nextRunAt: null })
    assert.equal(createdOptions.executorEngine, undefined)
    assert.equal(createdOptions.reasoningEffort, undefined)
    createdOptions = undefined
    const heartbeat = { ...routine, executionTarget: { kind: 'existing_session', sessionId: 'original-task' } }
    await executeRoutine(root, heartbeat, { sendDelayMs: 0, nextRunAt: null })
    assert.equal(heartbeatRoutine, heartbeat)
    assert.equal(createdOptions, undefined)
  })
  console.log(`${passed}/${passed} routine executor selection checks passed; no Provider I/O`)
} finally { rmSync(root, { recursive: true, force: true }) }
