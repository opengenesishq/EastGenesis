import assert from 'node:assert/strict'
import { policyDraft, code } from './frozen-routing-fixture.mjs'

export async function schemaChecks(api, check) {
  const seal = api.policy.sealFrozenRoutingPolicy
  await check('sealed canonical digest, copied deep immutability and serialization round trip', () => {
    const draft = policyDraft(), sealed = seal(draft)
    draft.qualifiedTargets[0].model = 'tampered'
    assert.equal(sealed.qualifiedTargets[0].model, 'model-a')
    assert.equal(Object.isFrozen(sealed.qualifiedTargets[0].connectionIdentity), true)
    assert.deepEqual(api.policy.verifyFrozenRoutingPolicy(JSON.parse(JSON.stringify(sealed))), sealed)
    assert.throws(() => api.policy.verifyFrozenRoutingPolicy({ ...sealed, frozenAt: 300 }), code('INVALID_POLICY'))
  })
  const changes = [
    ['unknown root field', (p) => { p.url = 'http://private.invalid' }],
    ['future schema', (p) => { p.schemaVersion = 2 }], ['media execution domain', (p) => { p.executionDomain = 'media' }],
    ['secret-shaped connection field', (p) => { p.qualifiedTargets[0].connectionIdentity.apiKey = 'fixture' }],
    ['invalid connection generation', (p) => { p.qualifiedTargets[0].connectionIdentity.generationId = 'header-hash' }],
    ['initial outside qualified', (p) => { p.initialTarget = { ...p.initialTarget, model: 'foreign' } }],
    ['retry on pause', (p) => { p.retryTargets = [p.initialTarget] }],
    ['unknown quoted budget', (p) => { p.hardBounds.remainingBudgetUsd = '0' }],
    ['nonfinite budget', (p) => { p.hardBounds.remainingBudgetUsd = Infinity }],
    ['business source drift', (p) => { p.baseStrategySource.businessLineId = 'video' }],
    ['default strategy drift', (p) => { p.effectivePolicy.strategy = 'cost' }],
    ['provider hard allowlist', (p) => { p.hardBounds.allowedProviderIds = ['foreign'] }],
    ['context hard bound', (p) => { p.hardBounds.minContextTokens = 9000 }],
    ['fixed user target', (p) => { p.userIntent = { kind: 'fixed', target: { providerId: 'provider-a', model: 'foreign' } } }]
  ]
  for (const [name, change] of changes) await check(`strict parser rejects ${name}`, () => {
    const draft = policyDraft(); change(draft); assert.throws(() => seal(draft), code('INVALID_POLICY'))
  })
  await check('zero remaining budget stays zero and is never normalized to unlimited', () => {
    const p = policyDraft(); p.hardBounds.remainingBudgetUsd = 0; assert.equal(seal(p).hardBounds.remainingBudgetUsd, 0)
  })
  await check('property inheritance and accessors do not enter frozen contracts', () => {
    const p = policyDraft(); const inherited = Object.create(p)
    assert.throws(() => seal(inherited), code('INVALID_POLICY'))
    Object.defineProperty(p, 'owner', { get: () => { throw new Error('getter invoked') } })
    assert.equal(api.parser.parseFrozenRoutingPolicy(p).ok, false)
  })
  await check('matched fixed selection cannot broaden targets or grant cross-target retries', () => {
    const p = matched(); p.effectivePolicy.selection = { kind: 'fixed', target: { providerId: 'provider-a', model: 'foreign' } }
    assert.throws(() => seal(p), code('INVALID_POLICY'))
    p.effectivePolicy.selection.target.model = 'model-a'
    p.effectivePolicy.failure = { kind: 'retry_allowed_targets', maxAdditionalAttempts: 1, retryOn: ['auth_failed'] }
    assert.throws(() => seal(p), code('INVALID_POLICY'))
  })
  await check('same-target failure cannot switch protocol and only known refusal types parse', () => {
    const p = matched(); p.effectivePolicy.failure = { kind: 'retry_same_target', maxAdditionalAttempts: 2, retryOn: ['rate_limited'] }
    p.retryTargets = [p.initialTarget]; assert.equal(seal(p).retryTargets.length, 1)
    p.retryTargets = [{ ...p.initialTarget, protocol: 'openai.responses' }]
    p.qualifiedTargets.push({ ...p.qualifiedTargets[0], protocol: 'openai.responses' })
    assert.throws(() => seal(p), code('INVALID_POLICY'))
    p.retryTargets = [p.initialTarget]; p.effectivePolicy.failure.retryOn = ['server_error']
    assert.throws(() => seal(p), code('INVALID_POLICY'))
  })
}

function matched() {
  const p = policyDraft()
  p.matchedRules = [{ id: 'rule-a', version: 1, source: { kind: 'user' }, priority: 10, scope: { kind: 'global' } }]
  return p
}
