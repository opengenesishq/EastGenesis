import assert from 'node:assert/strict'
import type { StudioResultSnapshot } from '../src/shared/studio-result-types'
import { canMarkGoalComplete, deriveDeliveryVerdict } from '../src/renderer/src/store/delivery-verdict'

/** Minimal renderer-safe snapshot fixture for the fail-closed delivery gate. */
const snapshot = (acceptances: StudioResultSnapshot['acceptances']): StudioResultSnapshot => ({
  schemaVersion: 1,
  format: 'caogen.studio-result.v1',
  state: 'ready',
  generatedAt: 1,
  scope: { sessionId: 'session', level: 'conversation' },
  workItems: [],
  runs: [],
  artifacts: [],
  evidence: [],
  acceptances,
  tests: [],
  risks: [],
  openItems: [],
  approvals: [],
  timeline: [],
  cost: { knownUsd: 0, knownRunCount: 0, totalRunCount: 0, coverage: 'unavailable' },
  summary: {
    runs: 0, artifacts: 0, currentArtifacts: 0, historicalArtifacts: 0,
    availableArtifacts: 0, readyArtifacts: 0, attentionArtifacts: 0,
    evidence: 0, acceptances: acceptances.length, passedAcceptances: 0,
    tests: 0, changes: 0, openItems: 0, approvals: 0, risks: 0
  },
  verification: { canonicalAggregateVerified: true, sanitized: true, resultDigest: 'fixture' }
})

const acceptance = (status: 'passed' | 'waived' | 'failed', deliveryScope: 'blocking' | 'historical' = 'blocking') => ({
  id: `${status}-${deliveryScope}`,
  status,
  deliveryScope,
  criteria: ['deliverable is reviewable'],
  coveredCriteria: 1,
  evidenceRefs: ['evidence'],
  revision: 1,
  updatedAt: 1
})

const empty = deriveDeliveryVerdict(snapshot([]))
assert.equal(empty.verdict, 'not_done')
assert.equal(empty.total, 0)
assert.equal(canMarkGoalComplete(empty.verdict), false)

const historicalOnly = deriveDeliveryVerdict(snapshot([acceptance('passed', 'historical')]))
assert.equal(historicalOnly.verdict, 'not_done')
assert.equal(historicalOnly.total, 0)
assert.equal(canMarkGoalComplete(historicalOnly.verdict), false)

const passed = deriveDeliveryVerdict(snapshot([acceptance('passed')]))
assert.equal(passed.verdict, 'verifiable')
assert.equal(canMarkGoalComplete(passed.verdict), true)

const waived = deriveDeliveryVerdict(snapshot([acceptance('waived')]))
assert.equal(waived.verdict, 'verifiable')

const failed = deriveDeliveryVerdict(snapshot([acceptance('failed')]))
assert.equal(failed.verdict, 'not_done')
assert.equal(canMarkGoalComplete(failed.verdict), false)

console.log('Delivery verdict gate: empty and historical-only Acceptance fail closed; passed/waived require a current record.')
