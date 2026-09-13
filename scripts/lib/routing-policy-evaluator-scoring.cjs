const { assert, fixture, ready } = require('./routing-policy-evaluator-fixture.cjs')

module.exports = function scoringMatrix(api, check, guard, statsDir) {
  const input = fixture(api)
  const providers = input.snapshots.providers
  const acceptance = new Map(providers.flatMap((provider) => provider.models.map((model) => [
    api.acceptanceQualitySignalKey(provider.id, model), { providerId: provider.id, model, passed: 8, failed: 2, samples: 10, score: 0.7 }
  ])))
  api.configureModelStatsDir(statsDir); api.publishAcceptanceQualitySnapshot(acceptance)
  const signals = providers.flatMap((provider) => provider.models.map((model) => ({ providerId: provider.id, model,
    reliability: api.reliabilityScore(model), latencyEmaMs: api.getModelStat(model)?.latencyEmaMs,
    acceptanceQuality: api.getAcceptanceQualitySignal(provider.id, model) })))
  const profiles = api.buildRoutingCatalog(providers).map((entry) => entry.profile)
  for (const strategy of ['balanced', 'quality', 'cost', 'speed']) check(`real legacy/snapshot scores equivalent: ${strategy}`, () => {
    const request = { providers, prompt: '代码分析', strategy, requiresTools: true, providerHealth: input.snapshots.providerHealth,
      budget: { hardLimit: true, remainingUsd: 1 }, crossValidation: { enabled: false } }
    const original = api.legacyRouteModel(request)
    const snapshot = guard(`snapshot equivalence ${strategy}`, () => api.routeModelFromSnapshot({
      request, task: api.inferTaskProfile(request), profiles, scoringSignals: signals
    }))
    assert.deepEqual(snapshot, original)
  }, { guarded: false })
  check('snapshot never reads changed live model stats or acceptance observations', () => {
    input.snapshots.scoringSignals = signals
    const before = guard('explicit snapshot baseline', () => ready(api.evaluateRoutingRuleSet(input)))
    api.configureModelStatsDir('/tmp/forbidden-unconfigured-model-stats')
    api.publishAcceptanceQualitySnapshot(new Map(providers.flatMap((provider) => provider.models.map((model) => [
      api.acceptanceQualitySignalKey(provider.id, model), { providerId: provider.id, model, passed: 0, failed: 999, samples: 999, score: 0 }
    ]))))
    const after = guard('changed live observations', () => ready(api.evaluateRoutingRuleSet(input)))
    assert.deepEqual(after, before)
  }, { guarded: false })
  check('missing, duplicate, NaN and omitted explicit scoring rows never fall back live', () => {
    const request = { providers, prompt: 'report', requiresTools: true }
    const base = { request, task: api.inferTaskProfile(request), profiles, scoringSignals: signals }
    for (const scoringSignals of [undefined, [], signals.slice(1), [...signals, signals[0]], signals.map((row, index) => index ? row : { ...row, reliability: NaN })]) {
      assert.throws(() => api.routeModelFromSnapshot({ ...base, scoringSignals }), /snapshot/)
    }
  })
}
