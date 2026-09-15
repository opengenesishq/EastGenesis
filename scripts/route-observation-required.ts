import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ModelAttemptRecord } from '../src/shared/model-attempt-types'
import type { FrozenNativeProtocol, FrozenRoutingQualifiedTarget } from '../src/shared/frozen-routing-types'
import type { ProviderView, TaskRunRecord } from '../src/shared/types'
import type { WorkflowRunRecord } from '../src/shared/workflow-types'
import { sealFrozenRoutingPolicy } from '../src/main/task/frozen-routing-policy'
import { deriveRouteObservationSnapshot, attemptObservationIdentity } from '../src/main/model/route-observation-feedback'
import { routeObservationIdentity, routeObservationKey, publishRouteObservationSnapshot, getRouteObservationSignal } from '../src/main/model/route-observation-signal'
import { routeModel, routeModelFromSnapshot, captureModelRouteScoringSignal, type ModelRouteRequest } from '../src/main/model/model-router'
import { buildModelProfiles, inferTaskProfile } from '../src/main/model/model-profile'
import { acceptanceQualitySignalKey, publishAcceptanceQualitySnapshot } from '../src/main/model/acceptance-quality-signal'

const checks: { name: string; status: string; detail?: string }[] = []
const model = 'gpt-4o-mini'
const connectionIdentities = {
  alpha: { generationId: randomUUID(), revision: 1 },
  zeta: { generationId: randomUUID(), revision: 1 }
}
const providers: ProviderView[] = ['alpha', 'zeta'].map((id) => ({
  id, name: id, models: [model], engine: 'openai', openaiProtocol: 'chat',
  baseUrl: 'http://localhost', authMode: 'none', ready: true, budgetUsd: 0,
  createdAt: 1, hasToken: false, credentialStorage: 'none', credentialRoutingMode: 'preferred'
}))
const targets: FrozenRoutingQualifiedTarget[] = providers.map((provider) => ({
  providerId: provider.id, model, protocol: 'openai.chat-completions',
  connectionIdentity: connectionIdentities[provider.id as keyof typeof connectionIdentities]
}))
function run(id: string, qualifiedTargets = targets): WorkflowRunRecord {
  const sessionId = `session-${id}`, taskId = `task-${id}`, workItemId = `work-${id}`
  const initialTarget = { providerId: qualifiedTargets[0].providerId, model: qualifiedTargets[0].model, protocol: qualifiedTargets[0].protocol }
  const taskRun = { id, sessionId, taskId, messageId: `message-${id}`, routingPolicy: sealFrozenRoutingPolicy({
    schemaVersion: 1, evaluatorVersion: 1, executionDomain: 'native_text',
    owner: { runId: id, sessionId, taskId, workItemId, businessLineId: 'studio' },
    messageId: `message-${id}`, frozenAt: 1, originalPromptDigest: 'a'.repeat(64),
    ruleSetRevision: 1, ruleSetDigest: 'b'.repeat(64), matchedRules: [],
    contextDigest: 'c'.repeat(64), catalogDigest: 'd'.repeat(64), evaluationDigest: 'e'.repeat(64),
    baseStrategy: 'balanced', baseStrategySource: { kind: 'global' }, userIntent: { kind: 'global' },
    effectivePolicy: { selection: { kind: 'global_auto' }, strategy: 'balanced', failure: { kind: 'pause' } },
    initialTarget, qualifiedTargets, retryTargets: [],
    hardBounds: { requiredCapabilities: [], minContextTokens: 1, allowedProviderIds: [], locality: 'any' }
  }) } as TaskRunRecord
  return { schemaVersion: 1, id, sessionId, taskId, workItemId, status: 'success', revision: 1,
    attempt: 1, createdAt: 1, updatedAt: 100, taskRun }
}
function attempt(owner: WorkflowRunRecord, target: FrozenRoutingQualifiedTarget, index: number,
  status: 'succeeded' | 'failed' = 'succeeded', latencyMs = 100): ModelAttemptRecord {
  return { id: `attempt-${owner.id}-${target.providerId}-${index}`, runId: owner.id, workItemId: owner.workItemId,
    providerId: target.providerId, model: target.model, protocol: target.protocol, status,
    outcome: status === 'succeeded' ? 'success' : 'unavailable', completedAt: 1000 + index,
    latencyMs } as ModelAttemptRecord
}
const owner = run('run-a')
const attempts = Array.from({ length: 5 }, (_, index) => [
  attempt(owner, targets[0], index, 'failed'), attempt(owner, targets[1], index, 'succeeded', 100 + index * 10)
]).flat()
const request: ModelRouteRequest = { providers, connectionIdentities, prompt: '整理客户报告', strategy: 'quality' }
const profiles = providers.flatMap((provider) => buildModelProfiles({ providerId: provider.id, providerName: provider.name, models: provider.models, engine: provider.engine }))
function check(name: string, action: () => void): void {
  try { action(); checks.push({ name, status: 'passed' }) }
  catch (error) { checks.push({ name, status: 'failed', detail: String(error) }); console.error(`${name}: ${error}`) }
}
function publish() { publishRouteObservationSnapshot(deriveRouteObservationSnapshot({ runs: [owner], attempts })) }

try {
  check('same-name models receive only their actual Provider attempts and rank by isolated reliability', () => {
    publish()
    const decision = routeModel(request)
    assert.equal(decision.selected.profile.providerId, 'zeta')
    assert.equal(decision.candidates.find((item) => item.profile.providerId === 'alpha')?.reliability, 0)
    assert.equal(decision.candidates.find((item) => item.profile.providerId === 'zeta')?.reliability, 1)
    assert.equal(decision.candidates.find((item) => item.profile.providerId === 'alpha')?.latencyEmaMs, undefined)
    assert.equal(decision.candidates.find((item) => item.profile.providerId === 'zeta')?.latencyEmaMs, 123)
  })
  check('a Run with multiple same-name candidates credits only the performed target', () => {
    const snapshot = deriveRouteObservationSnapshot({ runs: [owner], attempts: [attempt(owner, targets[1], 1)] })
    assert.equal(snapshot.size, 1)
    assert.equal([...snapshot.values()][0].providerId, 'zeta')
    assert.equal([...snapshot.values()][0].successes, 1)
  })
  check('connection revision, recreated generation and protocol changes do not inherit old observations', () => {
    publish()
    for (const identity of [
      { ...connectionIdentities.zeta, revision: 2 }, { generationId: randomUUID(), revision: 1 }
    ]) {
      const changed = routeModel({ ...request, connectionIdentities: { ...connectionIdentities, zeta: identity } })
      const candidate = changed.candidates.find((item) => item.profile.providerId === 'zeta')!
      assert.equal(candidate.reliability, 0.5); assert.equal(candidate.latencyEmaMs, undefined)
    }
    const protocolChanged = routeModel({ ...request, providers: providers.map((provider) => ({ ...provider, openaiProtocol: 'responses' })) })
    assert(protocolChanged.candidates.every((candidate) => candidate.reliability === 0.5 && candidate.latencyEmaMs === undefined))
  })
  check('wire protocol and canonical model separate samples even under the same Provider connection', () => {
    const otherTargets = [targets[0], { ...targets[0], protocol: 'openai.responses' as FrozenNativeProtocol }, { ...targets[0], model: 'another-model' }]
    const separateRun = run('run-separate', otherTargets)
    const snapshot = deriveRouteObservationSnapshot({ runs: [separateRun], attempts: otherTargets.map((target, index) => attempt(separateRun, target, index)) })
    assert.equal(snapshot.size, 3)
    assert([...snapshot.values()].every((signal) => signal.successes === 1))
    const aliased = { ...providers[0], advancedConfig: { modelProfiles: [{ model, aliases: ['my-report-model'] }] } }
    assert.equal(routeObservationIdentity(aliased, 'my-report-model', connectionIdentities.alpha)?.model, model)
  })
  check('official OpenAI default resolves Responses observations without making a request', () => {
    const provider = { ...providers[0], baseUrl: 'https://api.openai.com/v1', openaiProtocol: undefined }
    const target = { ...targets[0], protocol: 'openai.responses' as const }
    const responseRun = run('default-responses', [target])
    publishRouteObservationSnapshot(deriveRouteObservationSnapshot({ runs: [responseRun], attempts: [attempt(responseRun, target, 1)] }))
    const result = routeModel({ ...request, providers: [provider] })
    assert.equal(result.selected.observationIdentity?.protocol, 'openai.responses')
    assert(Math.abs(result.selected.reliability - 0.6) < 1e-12)
    assert.equal(result.selected.latencyEmaMs, 100)
    assert(!JSON.stringify(result.selected.observationIdentity).includes('api.openai.com'))
  })
  check('effective endpoint protocol overrides Provider default and app model remaps stay neutral', () => {
    const provider: ProviderView = { ...providers[0], advancedConfig: { endpoints: [
      { id: 'responses', url: 'http://localhost/responses', protocol: 'responses', enabled: true }
    ] } }
    const target = { ...targets[0], protocol: 'openai.responses' as const }
    const endpointRun = run('endpoint-responses', [target])
    publishRouteObservationSnapshot(deriveRouteObservationSnapshot({ runs: [endpointRun], attempts: [attempt(endpointRun, target, 1)] }))
    const result = routeModel({ ...request, providers: [provider] })
    assert.equal(result.selected.observationIdentity?.protocol, 'openai.responses')
    assert(Math.abs(result.selected.reliability - 0.6) < 1e-12)
    assert(!JSON.stringify(result.selected.observationIdentity).includes('localhost'))
    const remapped = { ...provider, advancedConfig: { ...provider.advancedConfig,
      appBindings: { openai: { modelMap: { [model]: 'different-wire-model' } } } } }
    assert.equal(routeObservationIdentity(remapped, model, connectionIdentities.alpha), undefined)
  })
  check('legacy, unknown, cancelled, orphan and wrong ownership attempts provide no empirical score', () => {
    const legacy = { ...owner, taskRun: { ...owner.taskRun } }; delete legacy.taskRun.routingPolicy
    assert.equal(deriveRouteObservationSnapshot({ runs: [legacy], attempts }).size, 0)
    const ignored = [
      { ...attempts[0], outcome: 'unknown' }, { ...attempts[1], status: 'cancelled', outcome: 'cancelled' },
      { ...attempts[1], workItemId: 'another-work-item' }, { ...attempts[1], runId: 'missing-run' }
    ] as ModelAttemptRecord[]
    assert.equal(deriveRouteObservationSnapshot({ runs: [owner], attempts: ignored }).size, 0)
    assert.equal(attemptObservationIdentity({ ...attempts[1], protocol: 'anthropic.messages' }, owner), undefined)
  })
  check('tampered frozen identities are rejected instead of attributed to current settings', () => {
    const altered = structuredClone(owner)
    altered.taskRun.routingPolicy!.qualifiedTargets[1].connectionIdentity.revision = 9
    assert.throws(() => deriveRouteObservationSnapshot({ runs: [altered], attempts }), /digest/)
  })
  check('missing connection identity and Provider-wide latency remain neutral for model scoring', () => {
    publish()
    const neutral = routeModel({ ...request, connectionIdentities: undefined, strategy: 'speed', providerHealth: {
      alpha: { healthy: true, latencyEmaMs: 9999 }, zeta: { healthy: true, latencyEmaMs: 1 }
    } })
    assert(neutral.candidates.every((candidate) => candidate.reliability === 0.5 && candidate.latencyEmaMs === undefined))
    assert.equal(neutral.selected.profile.providerId, 'alpha')
  })
  check('explicit snapshot reproduces current scores and rejects a stale connection identity', () => {
    publish()
    const scoringSignals = profiles.map((profile) => captureModelRouteScoringSignal(profile, request))
    const input = { request, profiles, scoringSignals, task: inferTaskProfile(request) }
    const captured = routeModelFromSnapshot(input)
    assert.deepEqual(captured, routeModel(request))
    publishRouteObservationSnapshot(new Map())
    assert.deepEqual(routeModelFromSnapshot(input), captured)
    assert.throws(() => routeModelFromSnapshot({ ...input, request: { ...request,
      connectionIdentities: { ...connectionIdentities, zeta: { ...connectionIdentities.zeta, revision: 2 } }
    } }), /snapshot connection identity/)
    assert.throws(() => routeModelFromSnapshot({ ...input, request: { ...request, connectionIdentities: undefined },
      scoringSignals: scoringSignals.map(({ observationIdentity: _identity, ...signal }) => signal)
    }), /snapshot observations require/)
  })
  check('acceptance quality uses the same full connection identity and ignores aggregate legacy credit', () => {
    publish()
    const identity = routeObservationIdentity(providers[1], model, connectionIdentities.zeta)!
    const quality = { providerId: 'zeta', model, passed: 10, failed: 0, samples: 10, score: 1 }
    publishAcceptanceQualitySnapshot(new Map([
      [routeObservationKey(identity), quality],
      [acceptanceQualitySignalKey('alpha', model), { ...quality, providerId: 'alpha' }]
    ]))
    const candidates = routeModel(request).candidates
    assert.equal(candidates.find((candidate) => candidate.profile.providerId === 'zeta')?.scoreBreakdown.acceptanceSamples, 10)
    assert.equal(candidates.find((candidate) => candidate.profile.providerId === 'alpha')?.scoreBreakdown.acceptanceSamples, 0)
    const rotated = captureModelRouteScoringSignal(profiles[1], { providers,
      connectionIdentities: { ...connectionIdentities, zeta: { ...connectionIdentities.zeta, revision: 2 } } })
    assert.equal(rotated.acceptanceQuality, undefined)
    assert.equal(getRouteObservationSignal({ ...identity, connectionIdentity: { ...identity.connectionIdentity, revision: 2 } }), undefined)
  })
  check('observations never override a fixed target or a hard budget exclusion', () => {
    publish()
    const fixed = routeModel({ ...request, manualOverride: { providerId: 'alpha', model } })
    assert.equal(fixed.selected.profile.providerId, 'alpha')
    assert.equal(fixed.manualOverrideApplied, true)
    assert.throws(() => routeModel({ ...request, budget: { hardLimit: true, remainingUsd: 0 } }), /预算已耗尽/)
    assert.throws(() => routeModel({ ...request, manualOverride: { providerId: 'missing', model } }), /指定的厂商或模型不可用/)
  })
} finally {
  publishRouteObservationSnapshot(new Map()); publishAcceptanceQualitySnapshot(new Map())
  const passed = checks.filter((entry) => entry.status === 'passed').length
  const reportPath = path.resolve('test-results/route-observation/latest.json')
  mkdirSync(path.dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify({ kind: 'caogen.route-observation', generatedAt: new Date().toISOString(),
    status: passed === checks.length ? 'passed' : 'failed', summary: { passed, total: checks.length }, checks,
    providerCalls: 0, limitations: ['sealed local Run policies and controlled attempt records', 'no real Provider execution or timing benchmark'] }, null, 2) + '\n')
  if (passed !== checks.length) process.exitCode = 1
  console.log(`Route observations: ${passed}/${checks.length}; ${reportPath}`)
}
