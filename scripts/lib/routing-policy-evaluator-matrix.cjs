const { assert, target, rule, saved, profile, provider, fixture, ready, blocked, keys, targetOf, replaceProfile } = require('./routing-policy-evaluator-fixture.cjs')

module.exports = function policyMatrix(api, check) {
  selectionMatrix(api, check)
  prioritiesAndBase(api, check)
  hardConstraints(api, check)
  aliasesAndProvenance(api, check)
  scopeAndDeterminism(api, check)
}

function selectionMatrix(api, check) {
  const scopes = [{ kind: 'global' }, { kind: 'provider', providerId: 'a' }, { kind: 'fixed', target: target() }]
  const selections = [
    [{ kind: 'global_auto' }, ['a/m-a', 'a/m-a2', 'b/m-b', 'c/m-c']],
    [{ kind: 'provider_auto', providerId: 'a' }, ['a/m-a', 'a/m-a2']],
    [{ kind: 'candidate_set', targets: [target(), target('b', 'm-b')] }, ['a/m-a', 'b/m-b']],
    [{ kind: 'preferred', primary: target(), alternatives: [target('b', 'm-b')] }, ['a/m-a', 'b/m-b']],
    [{ kind: 'fixed', target: target() }, ['a/m-a']]
  ]
  for (const [selection, allowed] of selections) for (const intent of scopes) check(`${selection.kind} × user ${intent.kind}`, () => {
    const failure = selection.kind === 'fixed' ? { kind: 'pause' } : undefined
    const input = fixture(api, { rules: saved([rule({ selection, ...(failure ? { failure } : {}) })]), context: { userIntent: intent } })
    const output = ready(api.evaluateRoutingRuleSet(input))
    const expected = allowed.filter((key) => intent.kind === 'global' || (intent.kind === 'provider' ? key.startsWith('a/') : key === 'a/m-a'))
    assert.deepEqual(keys(output.qualifiedTargets), expected.sort())
    assert(expected.includes(targetOf(output)))
    if (selection.kind === 'fixed' || selection.kind === 'preferred') assert.equal(targetOf(output), 'a/m-a')
  })
  check('fixed/provider intent conflicts cannot be widened by rule priority or alternatives', () => {
    for (const selection of [{ kind: 'fixed', target: target(), }, { kind: 'preferred', primary: target(), alternatives: [target('b', 'm-b')] }]) {
      blocked(api.evaluateRoutingRuleSet(fixture(api, { rules: saved([rule({ selection, failure: { kind: 'pause' } })]),
        context: { userIntent: { kind: 'fixed', target: target('b', 'm-b') } } })))
    }
  })
}

function prioritiesAndBase(api, check) {
  check('matching business scope outranks global priority without adding losing targets', () => {
    const rules = [rule({ priority: 999999, selection: { kind: 'provider_auto', providerId: 'c' } }),
      rule({ id: 'business', priority: 0, scope: { kind: 'business_line', businessLineId: 'assistant' }, selection: { kind: 'fixed', target: target() }, failure: { kind: 'pause' } })]
    const output = ready(api.evaluateRoutingRuleSet(fixture(api, { rules: saved(rules) })))
    assert.deepEqual(output.matchedRules.map((item) => item.id), ['business']); assert.deepEqual(output.overriddenRuleIds, ['rule-a'])
    assert.deepEqual(keys(output.qualifiedTargets), ['a/m-a'])
  })
  check('same scope priority conflicts are stable under rule order', () => {
    const rules = [rule({ id: 'z' }), rule({ id: 'a' }), rule({ id: 'lower', priority: 0 })]
    for (const ordered of [rules, [...rules].reverse()]) {
      const output = blocked(api.evaluateRoutingRuleSet(fixture(api, { rules: saved(ordered) })), 'PRIORITY_CONFLICT')
      assert.deepEqual(output.diagnostics[0].relatedRuleIds, ['a', 'z'])
    }
  })
  check('nonmatching business, disabled, keyword, task kind and risk conditions stay out', () => {
    const rules = [rule({ id: 'foreign', scope: { kind: 'business_line', businessLineId: 'video' } }),
      rule({ id: 'disabled', enabled: false }), rule({ id: 'keywords', when: { keywords: { mode: 'all', values: ['报告', 'MISSING'] } } }),
      rule({ id: 'task', when: { taskKinds: ['coding'] } }), rule({ id: 'risk', when: { minRiskLevel: 'high' } })]
    const output = ready(api.evaluateRoutingRuleSet(fixture(api, { rules: saved(rules) })))
    assert.equal(output.effectivePolicy.source, 'explicit_v1_default'); assert.deepEqual(output.effectivePolicy.failure, { kind: 'pause' })
  })
  check('base strategy preserves business preference, winning strategy cannot self-trigger', () => {
    const context = { baseStrategy: 'cost', baseStrategySource: { kind: 'business_line', businessLineId: 'assistant' } }
    const rules = [rule({ id: 'cost', when: { whenStrategy: 'cost' }, strategy: 'speed' }),
      rule({ id: 'speed', priority: 999, when: { whenStrategy: 'speed' }, strategy: 'quality' })]
    const output = ready(api.evaluateRoutingRuleSet(fixture(api, { rules: saved(rules), context })))
    assert.deepEqual(output.matchedRules.map((item) => item.id), ['cost']); assert.equal(output.task.strategy, 'speed')
    const noMatch = ready(api.evaluateRoutingRuleSet(fixture(api, { rules: saved([]), context })))
    assert.equal(noMatch.task.strategy, 'cost'); assert.deepEqual(noMatch.effectivePolicy.failure, { kind: 'pause' })
    blocked(api.evaluateRoutingRuleSet(fixture(api, { context: { ...context, baseStrategySource: { kind: 'business_line', businessLineId: 'video' } } })))
  })
}

function hardConstraints(api, check) {
  const preferred = saved([rule({ selection: { kind: 'preferred', primary: target(), alternatives: [target('b', 'm-b')] } })])
  const failures = {
    unknownTools: (input) => replaceProfile(input, 'a', 'm-a', (item) => { item.capabilities = ['text'] }),
    missingVision: (input) => { input.context.businessLine.requiredCapabilities.push('vision'); replaceProfile(input, 'a', 'm-a', (item) => { item.capabilities = ['text', 'tools'] }) },
    mediaOnly: (input) => replaceProfile(input, 'a', 'm-a', (item) => { item.capabilities = ['video'] }),
    context: (input) => replaceProfile(input, 'a', 'm-a', (item) => { item.contextWindow = 4096 }),
    notReady: (input) => { input.snapshots.providers[0].ready = false },
    allowlist: (input) => { input.snapshots.expertPolicy.allowedProviderIds = ['b'] },
    locality: (input) => { input.snapshots.expertPolicy.locality = 'local_only'; input.snapshots.providers[0].baseUrl = 'https://example.invalid' },
    region: (input) => { input.snapshots.expertPolicy.allowedRegions = ['eu-west']; input.snapshots.providers[0].advancedConfig.endpoints = [{ id: 'eu', url: input.snapshots.providers[0].baseUrl, region: 'us-east' }] },
    domain: (input) => { input.snapshots.expertPolicy.allowedDomains = ['trusted.example']; input.snapshots.providers[0].baseUrl = 'https://untrusted.example/v1' },
    permission: (input) => { input.snapshots.expertPolicy.requiredPermissions = ['tool-use']; input.snapshots.providers[0].advancedConfig.endpoints = [{ id: 'plain', url: input.snapshots.providers[0].baseUrl, permissionTags: ['text-only'] }] },
    permissions: (input) => { input.snapshots.targetEligibility.find((row) => row.target.model === 'm-a').allowed = false },
    unknownPrice: (input) => { input.snapshots.budget = { hardLimit: true, remainingUsd: 1 }; replaceProfile(input, 'a', 'm-a', (item) => { delete item.pricing }) },
    unaffordable: (input) => { input.snapshots.budget = { hardLimit: true, remainingUsd: 0.01 }; replaceProfile(input, 'a', 'm-a', (item) => { item.pricing = { inputPerMillion: 100, outputPerMillion: 100 } }) }
  }
  for (const [name, mutate] of Object.entries(failures)) check(`preferred primary hard exclusion ${name} blocks with viable backup`, () => {
    const input = fixture(api, { rules: preferred }); mutate(input); blocked(api.evaluateRoutingRuleSet(input), 'HARD_CONSTRAINT_EXCLUDED')
  })
  check('exhausted/invalid hard balances block; explicit free price succeeds; unknown remains an estimate', () => {
    for (const remainingUsd of [0, -1, NaN]) blocked(api.evaluateRoutingRuleSet(fixture(api, { snapshots: { budget: { hardLimit: true, remainingUsd } } })))
    const input = fixture(api, { snapshots: { budget: { hardLimit: true, remainingUsd: 0.000001 } }, rules: saved([rule({ selection: { kind: 'fixed', target: target() }, failure: { kind: 'pause' } })]) })
    replaceProfile(input, 'a', 'm-a', (item) => { item.pricing = { inputPerMillion: 0, outputPerMillion: 0 } })
    assert.equal(ready(api.evaluateRoutingRuleSet(input)).modelDecision.selected.estimatedCostUsd, 0)
    delete input.snapshots.budget; replaceProfile(input, 'a', 'm-a', (item) => { delete item.pricing })
    const unknown = ready(api.evaluateRoutingRuleSet(input)); assert.equal(unknown.pricing[0].basis, 'heuristic_estimate')
    assert.match(unknown.pricing[0].note, /actual price is unknown/)
    input.snapshots.budget = { hardLimit: false, remainingUsd: 0 }; ready(api.evaluateRoutingRuleSet(input))
  })
  check('missing trusted eligibility or fingerprint is fail-closed', () => {
    const input = fixture(api, { rules: preferred }); input.snapshots.targetEligibility = []
    blocked(api.evaluateRoutingRuleSet(input))
    const next = fixture(api, { rules: preferred }); next.snapshots.targetEligibility[0].connectionFingerprint = ''
    blocked(api.evaluateRoutingRuleSet(next))
  })
  check('high-risk native text routing requires protocol-valid generation evidence', () => {
    const rules = saved([rule({ selection: { kind: 'fixed', target: target() }, failure: { kind: 'pause' } })])
    const input = fixture(api, { rules, context: { businessLine: { id: 'assistant', enabled: true, requiredCapabilities: [] }, task: { riskLevel: 'high', requiresTools: false } } })
    blocked(api.evaluateRoutingRuleSet(input), 'HARD_CONSTRAINT_EXCLUDED')
    replaceProfile(input, 'a', 'm-a', (item) => {
      item.verification = { generation: 'passed', outcome: 'success', protocol: 'openai-chat-completions', responseValidation: 'protocol-json-v1', verifiedAt: Date.now() }
    })
    ready(api.evaluateRoutingRuleSet(input))
  })
  check('high-risk tool and vision routing require capability-specific evidence', () => {
    const rules = saved([rule({ selection: { kind: 'fixed', target: target() }, failure: { kind: 'pause' } })])
    const toolInput = fixture(api, { rules, context: { task: { riskLevel: 'high', requiresTools: true } } })
    replaceProfile(toolInput, 'a', 'm-a', (item) => {
      item.verification = { generation: 'passed', outcome: 'success', protocol: 'openai-chat-completions', responseValidation: 'protocol-json-v1', verifiedAt: Date.now() }
    })
    const toolBlocked = blocked(api.evaluateRoutingRuleSet(toolInput), 'HARD_CONSTRAINT_EXCLUDED')
    assert(toolBlocked.excludedTargets.some((entry) => entry.diagnostics.some((item) => /capability-specific verification.*tools/.test(item.message))))

    const visionInput = fixture(api, { rules, context: { businessLine: { id: 'assistant', enabled: true, requiredCapabilities: ['vision'] }, task: { riskLevel: 'high', requiresTools: false } } })
    replaceProfile(visionInput, 'a', 'm-a', (item) => {
      item.verification = { generation: 'passed', outcome: 'success', protocol: 'openai-chat-completions', responseValidation: 'protocol-json-v1', verifiedAt: Date.now() }
    })
    const visionBlocked = blocked(api.evaluateRoutingRuleSet(visionInput), 'HARD_CONSTRAINT_EXCLUDED')
    assert(visionBlocked.excludedTargets.some((entry) => entry.diagnostics.some((item) => /capability-specific verification.*vision/.test(item.message))))

    const lowRisk = fixture(api, { rules, context: { task: { riskLevel: 'low', requiresTools: true } } })
    ready(api.evaluateRoutingRuleSet(lowRisk))
  })
}

function aliasesAndProvenance(api, check) {
  check('declared aliases and Gemini prefix resolve once and deduplicate catalog candidates', () => {
    const providers = [provider('g', ['models/canonical', 'nick'], { engine: 'gemini', advancedConfig: {
      modelProfiles: [profile('canonical', { aliases: ['models/canonical', 'nick'] })] } })]
    const input = fixture(api, { providers, rules: saved([rule({ selection: { kind: 'candidate_set', targets: [target('g', 'nick'), target('g', 'canonical')] } })]) })
    const output = ready(api.evaluateRoutingRuleSet(input)); assert.deepEqual(keys(output.qualifiedTargets), ['g/canonical'])
    assert.equal(targetOf(output), 'g/canonical')
    input.snapshots.providers[0].models = []; blocked(api.evaluateRoutingRuleSet(input))
  })
  check('inherited draft source cannot authorize constructor/toString or custom IDs; legal own names remain valid', () => {
    for (const id of ['constructor', 'toString', 'normal']) {
      const { version, source, ...fields } = rule({ id })
      const value = { schemaVersion: 1, rules: [{ ...fields, expectedVersion: version }] }
      for (const sourcesById of [{}, Object.create({ [id]: source })]) {
        blocked(api.evaluateRoutingRuleSet(fixture(api, { rules: { kind: 'draft', value, sourcesById } })), 'INVALID_VALUE')
      }
      const sourcesById = {}; Object.defineProperty(sourcesById, id, { value: source, enumerable: true })
      const output = ready(api.evaluateRoutingRuleSet(fixture(api, { rules: { kind: 'draft', value, sourcesById } })))
      assert.equal(output.matchedRules[0].id, id); assert.deepEqual(output.matchedRules[0].source, source)
    }
  })
}

function scopeAndDeterminism(api, check) {
  check('native_text covers video planning, never media generation; parser failures do not become defaults', () => {
    const input = fixture(api, { context: { businessLine: { id: 'video', enabled: true, requiredCapabilities: ['tools'] } } })
    assert.equal(ready(api.evaluateRoutingRuleSet(input)).limitations.coversMediaGeneration, false)
    for (const executionDomain of ['media', 'video', 'image', 'tts']) blocked(api.evaluateRoutingRuleSet({ ...input, context: { ...input.context, executionDomain } }))
    const invalid = fixture(api); invalid.rules.value.rules[0].failure.retryOn = ['503']
    blocked(api.evaluateRoutingRuleSet(invalid)); input.context.businessLine.enabled = false; blocked(api.evaluateRoutingRuleSet(input))
  })
  check('prefer_local is soft: qualified remotes remain, and explicit remote preferred stays remote', () => {
    const input = fixture(api, { snapshots: { expertPolicy: { locality: 'prefer_local', allowedProviderIds: [] } } })
    input.snapshots.providers[1].baseUrl = 'https://example.invalid'
    const output = ready(api.evaluateRoutingRuleSet(input)); assert.notEqual(output.initialTarget.providerId, 'b'); assert(keys(output.qualifiedTargets).includes('b/m-b'))
    input.snapshots.providers.filter((item) => item.id !== 'b').forEach((item) => { item.ready = false })
    assert.equal(ready(api.evaluateRoutingRuleSet(input)).initialTarget.providerId, 'b')
    input.snapshots.providers.forEach((item) => { item.ready = true }); input.rules = saved([rule({ selection: { kind: 'preferred', primary: target('b', 'm-b'), alternatives: [target()] } })])
    assert.equal(ready(api.evaluateRoutingRuleSet(input)).initialTarget.providerId, 'b')
  })
  check('same snapshots are deterministic and unchanged; relevant rule or connection revisions alter digest', () => {
    const input = fixture(api); const original = structuredClone(input)
    const first = ready(api.evaluateRoutingRuleSet(input)); assert.deepEqual(api.evaluateRoutingRuleSet(input), first); assert.deepEqual(input, original)
    input.rules.value.rules[0].version++; assert.notEqual(ready(api.evaluateRoutingRuleSet(input)).decisionDigest, first.decisionDigest)
    const connection = fixture(api); connection.snapshots.targetEligibility[0].connectionFingerprint = 'new-generation'
    assert.notEqual(ready(api.evaluateRoutingRuleSet(connection)).decisionDigest, first.decisionDigest)
    assert(!JSON.stringify(first).includes('http://')); assert(!JSON.stringify(first).includes('报告'))
  })
  check('pause and retry_same_target expose no cross-target alternatives', () => {
    for (const failure of [{ kind: 'pause' }, { kind: 'retry_same_target', maxAdditionalAttempts: 2, retryOn: ['auth_failed'] }]) {
      const output = ready(api.evaluateRoutingRuleSet(fixture(api, { rules: saved([rule({ failure })]) })))
      assert.deepEqual(output.allowedAlternatives, [])
    }
  })
}
