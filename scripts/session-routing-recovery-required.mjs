import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'

// Production engine recovery loops and planners; transport, environment and
// existing physical-request gates are fixture boundaries. No Provider I/O.
const require = createRequire(import.meta.url), ts = require('typescript')
const cache = new Map(), boundaries = new Map(), real = new Set([
  'src/main/openaiEngine.ts', 'src/main/anthropicEngine.ts',
  'src/main/provider/anthropicRecovery.ts', 'src/main/provider/openAiProviderModelRecovery.ts',
  'src/main/model/native-recovery-session.ts', 'src/main/model/native-http-refusal.ts',
  'src/main/scheduler.ts', 'src/main/task/effect-ledger.ts'
].map(file => resolve(file)))
const boundary = (file, value) => boundaries.set(resolve(file), value)
function load(file) {
  file = resolve(file)
  if (boundaries.has(file)) return boundaries.get(file)
  if (cache.has(file)) return cache.get(file).exports
  if (!real.has(file)) return {}
  const module = { exports: {} }; cache.set(file, module)
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', compiled)(id => id.startsWith('.') ? load(resolve(dirname(file), `${id}.ts`)) : id === 'electron' ? {} : require(id), module, module.exports)
  return module.exports
}
const noop = () => {}, target = { providerId: 'first', model: 'model-a' }
let engineKind = 'openai', retry, unknownEffect = false
const makeProvider = id => ({ id, name: id, ready: true, hasToken: true, engine: engineKind, baseUrl: 'https://fixture.invalid', models: ['model-a'], advancedConfig: {} })
let providers = [makeProvider('first'), makeProvider('backup')]
const settings = { failoverEnabled: true, fallbackProviderId: 'not-authorized', fallbackModel: 'not-authorized', routingExpertPolicy: { locality: 'any', allowedProviderIds: [] } }
const failure = { kind: 'rate_limit', switchable: true, label: '429' }
boundary('src/shared/types.ts', { AUTO_MODEL: 'auto' })
boundary('src/main/providers.ts', { getProvider: id => providers.find(p => p.id === id), listProviders: () => providers, providerIsReady: () => true,
  markProviderKeyUsed: noop, recordProviderKeySuccess: noop, rotateProviderKey: () => { throw new Error('single key must not be rotated before same-target retry') } })
boundary('src/main/settings.ts', { getSettings: () => settings })
boundary('src/main/providerHealth.ts', { synchronizeProviderReliabilityPolicies: noop, isProviderAvailable: () => true,
  acquireProviderRequest: () => true, releaseProviderRequest: noop, recordFailure: noop, recordSuccess: noop, classifyFailure: () => failure })
boundary('src/main/modelStats.ts', { recordModelFailure: noop, recordModelSuccess: noop })
boundary('src/main/provider/providerRuntimeTarget.ts', { resolveProviderRuntimeTarget: (provider, input) => ({ baseUrl: provider.baseUrl, model: input.model }), resolveOpenAIProtocol: () => 'chat' })
boundary('src/main/model/routing-expert-policy.ts', { providerAllowedByRoutingExpertPolicy: () => true, assertRoutingExpertTargetAllowed: noop })
boundary('src/main/project-workspace/outbound-context-policy.ts', { providerAllowedByOutboundContext: () => true })
boundary('src/main/model/native-recovery-eligibility.ts', { evaluateNativeRecoveryTarget: () => ({ allowed: true }), assertNativeRecoveryTargetAllowed: noop,
  filterNativeRecoveryModels: input => input.provider.models })
boundary('src/main/task/effect-runtime.ts', { runHasUnresolvedEffects: () => unknownEffect })
boundary('src/main/task/task-runtime-registry.ts', { taskRuntimeRegistry: { get: () => ({ id: 'run' }) } })
boundary('src/main/model/native-recovery-boundary.ts', { withNativeRecoveryBoundary: async (run, fail) => { try { await run() } catch (error) { fail({ message: error.message, subtype: 'recovery-error' }) } } })
boundary('src/main/model/native-turn-rejection.ts', { nativeTurnRejection: error => error.gate ? { message: error.message, subtype: 'gate' } : undefined })
boundary('src/main/task/model-attempt-runtime.ts', { isModelAttemptPersistenceError: () => false, unwrapModelAttemptOperationError: error => error.operationError ?? error,
  isModelAttemptOperationError: error => Boolean(error.operationError) })
boundary('src/main/openaiTools.ts', { OPENAI_CODING_TOOLS: [] })
boundary('src/main/anthropic-history.ts', { anthropicErrorText: error => error.message })
boundary('src/main/provider/openai-provider-utils.ts', { redactProviderErrorText: value => value })
boundary('src/main/providerCredentialRuntime.ts', { redactProviderCredentials: value => value })
const native = load('src/main/model/native-recovery-session.ts')
const recovery = () => ({ frozenRetry: retry, initialExpertPolicy: settings.routingExpertPolicy, anchor: {}, currentRequiredCapabilities: [] })
boundary('src/main/model/native-recovery-session.ts', { ...native, nativeSessionRecoveryContext: recovery, assertNativeSessionRecoveryTarget: noop })
const { NativeProviderHttpError } = load('src/main/model/native-http-refusal.ts')
const planners = load('src/main/provider/openAiProviderModelRecovery.ts')
const anthropic = load('src/main/provider/anthropicRecovery.ts')
const scheduler = load('src/main/scheduler.ts')
const { OpenAIEngine } = load('src/main/openaiEngine.ts')
const { AnthropicEngine } = load('src/main/anthropicEngine.ts')
function reset(kind = 'openai', policy = 'retry_same_target', max = 1) {
  engineKind = kind; providers = [makeProvider('first'), makeProvider('backup')]
  settings.failoverEnabled = true; unknownEffect = false
  const protocol = kind === 'openai' ? 'openai.chat-completions' : kind === 'gemini' ? 'google.generative-language' : 'anthropic.messages'
  retry = { initialTarget: { ...target, protocol }, retryTargets: [{ providerId: 'backup', model: 'model-a', protocol }],
    effectivePolicy: { selection: { kind: 'preferred', primary: target, alternatives: [{ providerId: 'backup', model: 'model-a' }] },
      strategy: 'balanced', failure: { kind: policy, maxAdditionalAttempts: max, retryOn: ['rate_limited'] } } }
}
function openAiFixture(errors = [new NativeProviderHttpError(429, '429')]) {
  const instance = Object.create(OpenAIEngine.prototype), calls = [], events = [], finishes = []
  Object.assign(instance, { meta: { id: 'session', ...target }, disposed: false, assistantText: '', turnStartedAt: Date.now(),
    recoveryState: new planners.OpenAiRecoveryState('first'), modelAttempts: { setRouteReason: noop },
    augmentPayloadWithLayeredMemory: async payload => ({ payload, manifest: {} }), authConfig: () => ({ providerId: 'first', baseUrl: 'https://fixture.invalid', available: true, authMode: 'none' }),
    effectiveModel: () => 'model-a', protocol: () => 'chat', refreshConfirmedToolReplay: noop, clearResponsesContext: noop,
    emit: event => events.push(event), finishTurn: (...args) => finishes.push(args), withProviderErrorContext: value => value,
    runChatCompletion: async () => { calls.push('attempt'); const error = errors.shift(); if (error) throw error },
    tryProviderKeyFailover: async () => false, tryProviderModelFailover: async () => false, tryFailover: async () => false,
    tryProtocolFailover: async () => false, emitRecoveryExhausted: noop })
  return { instance, calls, events, finishes }
}
function recoveryInput() {
  const current = { ...target, providerName: 'first', keyId: 'only-key', baseUrl: 'https://fixture.invalid' }
  return { recovery: recovery(), current, failure, settings, providers, meta: { model: 'auto', providerId: 'first' }, state: anthropic.createAnthropicRecoveryState('first'),
    resolveTarget: requested => ({ ...current, ...requested }), canRotateProviderKey: () => false, rotateProviderKey: () => { throw new Error('unexpected rotation') },
    pickProviderModelFailoverTarget: scheduler.pickProviderModelFailoverTarget, pickFailoverTarget: scheduler.pickFailoverTarget,
    engineKind, nativeRetryReason: 'rate_limited' }
}
let count = 0
async function check(name, run) { await run(); count++; console.log(`PASS ${name}`) }
await check('OpenAI production catch retries a single-key confirmed refusal through its ordinary request path', async () => {
  reset(); const f = openAiFixture(); await f.instance.runResponse({ text: 'continue', messageId: 'message' }, new AbortController())
  assert.equal(f.calls.length, 2); assert.equal(f.instance.recoveryState.recoveryAttempts, 1)
  assert.equal(f.events[0].event, 'provider-same-target-retry'); assert.deepEqual(f.finishes, [[false]])
})
await check('OpenAI stops at frozen retry count, on unknown failures, effects, and after output', async () => {
  for (const mode of ['limit', 'unknown', 'effect', 'output', 'disabled', 'provider-limit', 'unlisted-reason']) {
    reset(); const f = openAiFixture([new NativeProviderHttpError(mode === 'unlisted-reason' ? 401 : 429, 'refusal'), new NativeProviderHttpError(429, '429')])
    if (mode === 'unknown') f.instance.runChatCompletion = async () => { f.calls.push('attempt'); throw new Error('429 text without response proof') }
    if (mode === 'effect') unknownEffect = true
    if (mode === 'output') f.instance.assistantText = 'partial output'
    if (mode === 'disabled') settings.failoverEnabled = false
    if (mode === 'provider-limit') providers[0].advancedConfig.reliability = { maxRetries: 0 }
    await f.instance.runResponse({ text: 'continue' }, new AbortController())
    assert.equal(f.calls.length, mode === 'limit' ? 2 : 1, mode)
  }
})
await check('same-target retry re-enters budget/permission request gates', async () => {
  reset(); const f = openAiFixture(); let physical = 0, invocations = 0
  f.instance.runChatCompletion = async () => { invocations++; if (invocations === 2) throw Object.assign(new Error('budget exhausted'), { gate: true }); physical++; throw new NativeProviderHttpError(429, '429') }
  await f.instance.runResponse({ text: 'continue' }, new AbortController())
  assert.equal(invocations, 2); assert.equal(physical, 1); assert.equal(f.finishes[0][2], 'gate')
})
await check('Anthropic and Google single-key recovery preserves target, key and refusal/count bounds', () => {
  for (const kind of ['anthropic', 'gemini']) {
    reset(kind); const input = recoveryInput()
    assert.equal(anthropic.recoverAnthropicTarget({ ...input, nativeRetryReason: undefined }), undefined)
    assert.equal(anthropic.recoverAnthropicTarget({ ...input, nativeRetryReason: 'auth_failed' }), undefined)
    const result = anthropic.recoverAnthropicTarget(input)
    assert.equal(result.target.keyId, 'only-key'); assert.equal(result.target.providerId, 'first'); assert.equal(result.metaChanged, false)
    assert.equal(input.state.attempts, 1); assert.equal(anthropic.recoverAnthropicTarget(input), undefined)
  }
})
await check('Anthropic/Google production request loop preserves refused attempt lineage before the next gated request', async () => {
  for (const kind of ['anthropic', 'gemini']) {
    reset(kind); const input = recoveryInput(), calls = [], instance = Object.create(AnthropicEngine.prototype)
    Object.assign(instance, { meta: { id: 'session', model: 'auto', providerId: 'first' }, disposed: false, assistantText: '', thinkingText: '',
      recoveryState: input.state, emit: noop, recordAttemptSuccess: noop, appendUnstreamedResult: noop, recordUsage: noop,
      dependencies: { ...input, recoveryEngineKind: kind, getSettings: () => settings, listProviders: () => providers,
        classifyFailure: () => failure, acquireProviderRequest: () => true, recordFailure: noop, releaseProviderRequest: noop, getRun: () => ({ id: 'run' }) },
      executeMessageAttempt: async (_target, _messages, _controller, lineage) => {
        calls.push(lineage)
        if (calls.length === 1) throw { operationError: new NativeProviderHttpError(429, '429'), requestId: 'logical-request', attemptId: 'refused-attempt' }
        return { content: [], usage: { input: 1, output: 1 } }
      } })
    await instance.requestMessage(input.current, [], new AbortController())
    assert.equal(calls.length, 2); assert.equal(calls[1].requestId, 'logical-request'); assert.equal(calls[1].failoverFromAttemptId, 'refused-attempt')
  }
})
await check('explicit preferred backups override unrelated global fallback hints within frozen candidates', () => {
  reset('openai', 'retry_allowed_targets')
  const result = planners.planOpenAiProviderFailover({ recovery: recovery(), currentProviderId: 'first', currentModel: 'model-a', failure,
    currentProtocol: 'chat', exclude: new Set(['first']), fallbackProviderId: 'not-authorized', fallbackModel: 'not-authorized', nativeRetryReason: 'rate_limited', attempt: 1 })
  assert.equal(result.providerId, 'backup')
  reset('anthropic', 'retry_allowed_targets'); const input = recoveryInput()
  assert.equal(anthropic.recoverAnthropicTarget(input).target.providerId, 'backup')
})
console.log(`session-routing-recovery-required: ${count}/${count}; production loops/planners, synthetic transport; no Provider I/O`)
