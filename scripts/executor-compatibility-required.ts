import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings, ProviderView, SessionMeta, TaskRunRecord } from '../src/shared/types'
import type { FrozenNativeTarget, FrozenRunRoutingPolicyV1 } from '../src/shared/frozen-routing-types'
import { evaluateNativeExecutorCompatibility, nativeExecutorCapabilities, resolveNativeExecutorProtocol } from '../src/main/model/executor-compatibility'
import { buildModelProfiles } from '../src/main/model/model-profile'
import { resolveRuntimeSessionRoute } from '../src/main/model/session-runtime-routing'
import { frozenRetryAllows, type NativeSessionRecoveryContext } from '../src/main/model/native-recovery-session'
import { assertFrozenRunRequestTarget, sealFrozenRoutingPolicy } from '../src/main/task/frozen-routing-policy'

const checks: string[] = []
function check(name: string, operation: () => void) { operation(); checks.push(name) }
const provider = {
  id: 'fixture-provider', name: 'Fixture', engine: 'openai', baseUrl: 'https://fixture.invalid/v1',
  openaiProtocol: 'chat', ready: true, models: ['fixture-model'],
  advancedConfig: { modelProfiles: [{ model: 'fixture-model', capabilities: ['text', 'tools', 'vision'], contextWindow: 32000 }] }
} as ProviderView
function profileFor(value = provider, model = value.models[0]) {
  return buildModelProfiles({ providerId: value.id, providerName: value.name, engine: value.engine,
    models: [model], modelProfiles: value.advancedConfig?.modelProfiles })[0]
}
const requirements = { requiresTools: true, requiresVision: true, minContextTokens: 8000 }
const settings = { driveMode: 'core', schedulerStrategy: 'balanced', permissionAllowlist: '', permissionDenylist: '' } as AppSettings
const meta = { id: 'fixture-session', model: 'fixture-model', providerId: provider.id, engine: 'openai',
  createdAt: 1, costUsd: 0, contextTokens: 0, routingScope: 'fixed', driveMode: 'core' } as SessionMeta
const fixed = (value = provider, overrides: Partial<SessionMeta> = {}, images?: any[]) =>
  resolveRuntimeSessionRoute({ meta: { ...meta, ...overrides }, payload: { text: '处理当前任务', images },
    settings, providers: [value], history: [] })
const manualRefusal = (error: any) => error.code === 'ROUTING_MANUAL_TARGET_UNAVAILABLE'

check('model and local executor are independent capability dimensions', () => {
  const compatible = evaluateNativeExecutorCompatibility({ provider, profile: profileFor(), requirements })
  assert.equal(compatible.compatible, true)
  assert.equal(compatible.protocol, 'openai.chat-completions')
  const unknown = { ...provider, advancedConfig: undefined }
  const result = evaluateNativeExecutorCompatibility({ provider: unknown, profile: profileFor(unknown), requirements })
  assert.equal(result.compatible, false)
  assert.equal(result.executorReasons.length, 0)
  assert.equal(result.modelReasons.length, 2, 'local tool support cannot prove model tools or vision')
})
check('unknown external executor is rejected without claiming a capability', () => {
  const unknown = { ...provider, engine: 'external-developer-agent' } as unknown as ProviderView
  assert.equal(nativeExecutorCapabilities(unknown.engine), undefined)
  assert.equal(evaluateNativeExecutorCompatibility({ provider: unknown, profile: profileFor(unknown), requirements }).compatible, false)
  assert.throws(() => fixed(unknown), manualRefusal)
})
check('all implemented native engines resolve their actual wire protocol', () => {
  assert.equal(resolveNativeExecutorProtocol({ ...provider, engine: 'anthropic' }, provider.models[0]), 'anthropic.messages')
  assert.equal(resolveNativeExecutorProtocol({ ...provider, engine: 'gemini' }, provider.models[0]), 'google.generative-language')
  assert.equal(resolveNativeExecutorProtocol({ ...provider, baseUrl: 'https://api.openai.com/v1', openaiProtocol: undefined }, provider.models[0]), 'openai.responses')
  const bound: ProviderView = { ...provider, advancedConfig: { ...provider.advancedConfig,
    endpoints: [{ id: 'chat', url: provider.baseUrl, protocol: 'chat' }, { id: 'responses', url: 'https://responses.invalid/v1', protocol: 'responses' }],
    appBindings: { openai: { endpointId: 'responses' } } } }
  assert.equal(resolveNativeExecutorProtocol(bound, provider.models[0]), 'openai.responses')
  assert.equal(evaluateNativeExecutorCompatibility({ provider: bound, profile: profileFor(bound), requirements,
    expectedProtocol: 'openai.chat-completions' }).compatible, false)
})
check('fixed native routing rejects media-only models without a business-line requirement', () => {
  const media: ProviderView = { ...provider, advancedConfig: { modelProfiles: [{ model: 'fixture-model', capabilities: ['image'] }] } }
  assert.throws(() => fixed(media), manualRefusal)
})
check('fixed image input requires model vision and cannot borrow executor support', () => {
  const text: ProviderView = { ...provider, advancedConfig: { modelProfiles: [{ model: 'fixture-model', capabilities: ['text'] }] } }
  assert.throws(() => fixed(text, {}, [{ mime: 'image/png', data: 'fixture' }]), manualRefusal)
  assert.equal(fixed(provider, {}, [{ mime: 'image/png', data: 'fixture' }]), undefined)
  assert.equal(fixed(text), undefined, 'fixed text-only chat does not acquire a new tools requirement')
})
check('fixed routing validates mapped model and runtime engine without switching silently', () => {
  const mapped: ProviderView = { ...provider, advancedConfig: {
    appBindings: { openai: { modelMap: { 'fixture-model': 'media-output' } } },
    modelProfiles: [{ model: 'media-output', capabilities: ['video'] }] } }
  assert.throws(() => fixed(mapped), manualRefusal)
  assert.throws(() => fixed(provider, { engine: 'anthropic' }), manualRefusal)
  const alias: ProviderView = { ...provider, models: ['friendly'], advancedConfig: {
    modelProfiles: [{ model: 'fixture-model', aliases: ['friendly'], capabilities: ['text', 'vision'] }] } }
  assert.equal(fixed(alias, { model: 'friendly' }, [{ mime: 'image/png', data: 'fixture' }]), undefined)
  const chain: ProviderView = { ...provider, advancedConfig: {
    appBindings: { openai: { modelMap: { friendly: 'fixture-model', 'fixture-model': 'media-output' } } },
    modelProfiles: [{ model: 'fixture-model', capabilities: ['text'] }, { model: 'media-output', capabilities: ['video'] }] } }
  assert.equal(fixed(chain, { model: 'friendly' }), undefined, 'fixed mapping must resolve the original input once')
})
check('candidate remapping and insufficient context are excluded before scoring', () => {
  const mapped: ProviderView = { ...provider, advancedConfig: { ...provider.advancedConfig,
    appBindings: { openai: { modelMap: { 'fixture-model': 'different-model' } } } } }
  assert.equal(evaluateNativeExecutorCompatibility({ provider: mapped, profile: profileFor(mapped), requirements }).compatible, false)
  assert.equal(evaluateNativeExecutorCompatibility({ provider, profile: profileFor(), requirements: { minContextTokens: 64000 } }).compatible, false)
})

const initial: FrozenNativeTarget = { providerId: 'provider-a', model: 'model-a', protocol: 'openai.chat-completions' }
const alternate: FrozenNativeTarget = { providerId: 'provider-b', model: 'model-b', protocol: 'openai.chat-completions' }
const unused: FrozenNativeTarget = { providerId: 'provider-c', model: 'model-c', protocol: 'openai.chat-completions' }
const identity = { generationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', revision: 1 }
function policy(failure: FrozenRunRoutingPolicyV1['effectivePolicy']['failure'], retryTargets: FrozenNativeTarget[] = [], preferred = false) {
  const digest = 'a'.repeat(64)
  return sealFrozenRoutingPolicy({ schemaVersion: 1, evaluatorVersion: 1, executionDomain: 'native_text',
    owner: { runId: 'run', sessionId: 'session', taskId: 'task', workItemId: 'work-item', businessLineId: 'assistant' },
    messageId: 'message', frozenAt: 1, originalPromptDigest: digest, ruleSetRevision: 1, ruleSetDigest: digest,
    matchedRules: [{ id: 'rule', version: 1, source: { kind: 'user' }, priority: 1, scope: { kind: 'global' } }],
    contextDigest: digest, catalogDigest: digest, evaluationDigest: digest, baseStrategy: 'balanced',
    baseStrategySource: { kind: 'global' }, userIntent: { kind: 'global' },
    effectivePolicy: { selection: preferred ? { kind: 'preferred', primary: { providerId: initial.providerId, model: initial.model },
      alternatives: [alternate, unused].map(({ providerId, model }) => ({ providerId, model })) } : { kind: 'global_auto' }, strategy: 'balanced', failure },
    initialTarget: initial, qualifiedTargets: [initial, alternate, unused].map((target) => ({ ...target, connectionIdentity: identity })),
    retryTargets, hardBounds: { requiredCapabilities: [], minContextTokens: 8000, allowedProviderIds: [], locality: 'any' } })
}
function request(routingPolicy: FrozenRunRoutingPolicyV1, target: FrozenNativeTarget) {
  const run = { id: 'run', sessionId: 'session', taskId: 'task', messageId: 'message', routingPolicy } as TaskRunRecord
  return () => assertFrozenRunRequestTarget({ run, ...target, connectionIdentity: identity })
}
const policyRefusal = (error: any) => error.code === 'POLICY_CONFLICT'
check('pause allows initial dispatch and refuses qualified alternates', () => {
  const frozen = policy({ kind: 'pause' })
  assert.doesNotThrow(request(frozen, initial))
  assert.throws(request(frozen, alternate), policyRefusal)
})
check('same-target retry stays legal while qualified alternate is refused', () => {
  const frozen = policy({ kind: 'retry_same_target', maxAdditionalAttempts: 1, retryOn: ['rate_limited'] }, [initial])
  assert.doesNotThrow(request(frozen, initial))
  assert.throws(request(frozen, alternate), policyRefusal)
})
check('preferred fallback admits only expressly authorized retry targets', () => {
  const frozen = policy({ kind: 'retry_allowed_targets', maxAdditionalAttempts: 2, retryOn: ['rate_limited'] }, [initial, alternate], true)
  assert.doesNotThrow(request(frozen, initial))
  assert.doesNotThrow(request(frozen, alternate))
  assert.throws(request(frozen, unused), policyRefusal)
  const recovery = { frozenRetry: frozen } as unknown as NativeSessionRecoveryContext
  const retry = { recovery, ...alternate, attempt: 1, refusal: { outcome: 'rate_limited' as const } }
  assert.equal(frozenRetryAllows(retry), true)
  assert.equal(frozenRetryAllows({ ...retry, attempt: 3 }), false)
  assert.equal(frozenRetryAllows({ ...retry, refusal: undefined }), false)
})

const reportPath = join(process.cwd(), 'test-results', 'executor-compatibility', 'latest.json')
const report = { schemaVersion: 1, status: 'passed', summary: `${checks.length}/${checks.length} checks passed`,
  checks, scope: 'local model/executor and frozen request compatibility; no Provider I/O',
  limitations: ['Does not prove external executor availability or real Provider recovery.'], generatedAt: new Date().toISOString() }
mkdirSync(join(process.cwd(), 'test-results', 'executor-compatibility'), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ ...report, reportPath }, null, 2))
