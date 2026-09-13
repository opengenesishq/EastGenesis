import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fakeAttemptDependencies, runFixture, stepFixture } from './anthropic-messages-smoke-support.mjs'

/** Fixed routing bypasses the selection budget gate, so these failures come from
 * the real durable reservation immediately before the actual HTTP request. */
export async function verifyPhysicalRequestBudgetRefusals(runtime, fixture) {
  runtime.settings.updateSettings({ failoverEnabled: true, budgetUsdPerMonth: 0 })
  try {
    for (const kind of ['openai', 'openai-responses', 'anthropic', 'gemini']) {
      for (const reason of ['unaffordable', 'exhausted', 'unknown-price']) {
        await verifyRefusal(runtime, fixture, kind, reason)
      }
    }
  } finally {
    runtime.settings.updateSettings({ failoverEnabled: false })
  }
}

async function verifyRefusal(runtime, fixture, kind, reason) {
  const engineKind = kind === 'openai-responses' ? 'openai' : kind
  const primary = fixture.provider(engineKind, fixture.port, `-physical-${reason}`)
  if (kind === 'openai-responses') primary.openaiProtocol = 'responses'
  if (reason === 'unknown-price') {
    for (const profile of primary.advancedConfig.modelProfiles) delete profile.pricing
  }
  const backup = fixture.provider(engineKind, fixture.port, '-physical-backup', [0, 0])
  runtime.providers.commitProviderProfileStore([primary, backup])
  const meta = fixture.draft(runtime, { providerId: primary.id, model: primary.models[0], routingScope: 'fixed' })
  const events = []
  const engine = new runtime.engines[engineKind](meta, (event) => events.push(event))
  const attempts = fakeAttemptDependencies()
  attempts.randomId = randomUUID
  if (engineKind === 'openai') engine.modelAttempts = new runtime.openaiTracker(attempts)
  else engine.dependencies.modelAttempts = new runtime.anthropicTracker(attempts, {
    protocol: engineKind === 'gemini' ? 'google.generative-language' : 'anthropic.messages',
    adapterVersion: 'mock', label: kind
  })
  const messageId = `physical-${kind}-${reason}`
  runtime.registry.set(meta.id, runFixture(meta.id, [stepFixture(messageId, messageId)]))
  const observations = observeRefusalBoundary(runtime, engine, engineKind)
  const before = fixture.requests.length
  try {
    await engine.start()
    meta.costUsd = reason === 'exhausted' ? 1 : 0
    meta.budgetUsd = reason === 'unaffordable' ? 0.00000001 : 1
    await fixture.send(engine, events, { text: '验证物理请求预算门禁', messageId }, true)
    assert.equal(fixture.requests.length, before, `${kind}/${reason}: budget rejection reached HTTP`)
    assert.equal(attempts.calls.start.length, 0, 'budget rejection opened a persisted ModelAttempt')
    assert.equal(observations.counts.reservation, 1, 'product rejection was retried as transport failure')
    assert.equal(observations.counts.recovery, 0, 'product rejection entered provider/key/model/protocol recovery')
    assert.equal(observations.counts.healthFailure, 0, 'budget refusal degraded provider/model health')
    assert.equal(events.filter((event) => event.kind === 'turn-result').at(-1).subtype, 'routing-blocked')
    assert.equal(meta.providerId, primary.id)
    assert.equal(meta.model, primary.models[0])
    fixture.checks.push(`${kind}: physical ${reason} refusal makes zero HTTP/attempt/retry/fallback/health failures`)
  } finally {
    observations.restore()
    await engine.dispose()
    runtime.registry.delete(meta.id)
  }
}

function observeRefusalBoundary(runtime, engine, kind) {
  const counts = { reservation: 0, recovery: 0, healthFailure: 0 }
  const restorers = []
  const observe = (object, name, counter) => {
    const original = object[name]
    object[name] = function observed(...args) {
      counts[counter] += 1
      return original.apply(this, args)
    }
    restorers.push(() => { object[name] = original })
  }
  observe(runtime.requestBudget, 'reserveRequestBudget', 'reservation')
  if (kind === 'openai') {
    for (const name of ['tryProviderKeyFailover', 'tryProviderModelFailover', 'tryFailover', 'tryProtocolFailover']) {
      observe(engine, name, 'recovery')
    }
    observe(runtime.providerHealth, 'recordFailure', 'healthFailure')
    observe(runtime.modelStats, 'recordModelFailure', 'healthFailure')
  } else {
    observe(engine, 'recoverTarget', 'recovery')
    observe(engine.dependencies, 'recordFailure', 'healthFailure')
  }
  return { counts, restore: () => { for (const restore of restorers.reverse()) restore() } }
}
