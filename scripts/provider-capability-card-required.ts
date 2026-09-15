import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildProviderCapabilityCard } from '../src/shared/provider-capability-card'
import { summarizeProviderHealth } from '../src/shared/provider-health-contract'
import type { ProviderHealthView, ProviderModelProfile, ProviderView } from '../src/shared/types'

const provider = {
  id: 'fixture-provider', name: 'Fixture', engine: 'openai', openaiProtocol: 'responses', ready: true,
  advancedConfig: { endpoints: [{ id: 'primary', url: 'https://fixture.invalid/v1', protocol: 'responses', region: 'test' }] }
} as unknown as ProviderView

const checks: string[] = []
function check(id: string, fn: () => void): void { fn(); checks.push(id) }

const verified: ProviderModelProfile = {
  model: 'fixture-model', capabilities: ['text', 'tools', 'vision'], contextWindow: 128000,
  verification: { generation: 'passed', outcome: 'success', protocol: 'responses', responseValidation: 'protocol-json-v1', verifiedAt: 1700000000000 }
}
const card = buildProviderCapabilityCard(provider, verified)
check('verified-generation-only', () => {
  assert.equal(card.evidence.state, 'verified')
  assert.deepEqual(card.verifiedCapabilities, ['text'])
  assert.deepEqual(card.declaredCapabilities, ['text', 'tools', 'vision'])
})
check('protocol-and-endpoint-projection', () => {
  assert.deepEqual(card.protocols, ['openai-responses'])
  assert.equal(card.endpoints[0]?.url, undefined, 'capability card must not expose endpoint URLs')
  assert.equal(card.endpoints[0]?.region, 'test')
})
check('failed-probe-never-authorizes', () => {
  const failed = buildProviderCapabilityCard(provider, { ...verified, verification: { ...verified.verification!, generation: 'failed' } })
  assert.equal(failed.evidence.state, 'declared')
  assert.equal(failed.evidence.verification.state, 'failed')
  assert.deepEqual(failed.verifiedCapabilities, [])
})
check('unknown-declaration-is-explicit', () => {
  const unknown = buildProviderCapabilityCard({ ...provider, ready: false }, { model: 'unclassified-model' })
  assert.equal(unknown.evidence.state, 'unknown')
  assert.equal(unknown.availability, 'unavailable')
})

const healthFixture = (overrides: Partial<ProviderHealthView> = {}): ProviderHealthView => ({
  providerId: 'fixture-provider', successes: 0, failures: 0, consecutiveFailures: 0,
  probeSuccesses: 0, probeFailures: 0, halfOpenSuccesses: 0,
  circuitTotalRequests: 0, circuitFailedRequests: 0, recentFailures: [],
  circuitState: 'closed', healthy: true, ...overrides
})
check('health-check-requires-an-observation', () => {
  const checkResult = summarizeProviderHealth(healthFixture())
  assert.equal(checkResult.state, 'unprobed')
  assert.equal(checkResult.access, 'probe_only')
  assert.equal(checkResult.reason, 'missing_observation')
})
check('health-check-fails-closed-for-circuit-and-probe-failure', () => {
  const open = summarizeProviderHealth(healthFixture({ circuitState: 'open', healthy: false }))
  assert.equal(open.access, 'blocked')
  assert.equal(open.reason, 'circuit_open')
  const halfOpen = summarizeProviderHealth(healthFixture({ circuitState: 'half_open' }))
  assert.equal(halfOpen.access, 'probe_only')
  const failedProbe = summarizeProviderHealth(healthFixture({
    probeFailures: 1, lastProbeFailureAt: 20, probeSuccesses: 1, lastProbeSuccessAt: 10,
    successes: 1
  }))
  assert.equal(failedProbe.state, 'unhealthy')
  assert.equal(failedProbe.access, 'blocked')
  assert.equal(failedProbe.reason, 'probe_failed')
})
check('health-check-allows-only-observed-closed-health', () => {
  const ready = summarizeProviderHealth(healthFixture({
    probeSuccesses: 1, lastProbeSuccessAt: 20, successes: 1
  }))
  assert.equal(ready.state, 'healthy')
  assert.equal(ready.access, 'automatic')
  assert.equal(ready.reason, 'ready')
})

const report = {
  schemaVersion: 1,
  contract: '0913 Provider capability card and health check projection boundary',
  status: 'passed', checks: checks.map((id) => ({ id, status: 'passed' })),
  summary: `${checks.length}/${checks.length} checks passed`,
  limitations: ['fixture-only projection', 'does not call a Provider', 'generation verification does not verify non-text capabilities', 'health summary is an authorization hint and does not prove task success or production availability'],
  generatedAt: new Date().toISOString()
}
const reportPath = join(process.cwd(), 'test-results', 'provider-capability-card', 'latest.json')
mkdirSync(join(process.cwd(), 'test-results', 'provider-capability-card'), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify({ ...report, reportPath }, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ ...report, reportPath }, null, 2))
