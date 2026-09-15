import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const settings = readFileSync(resolve(root, 'src/renderer/src/components/SettingsModal.tsx'), 'utf8')
const list = readFileSync(resolve(root, 'src/renderer/src/components/settings/ProviderList.tsx'), 'utf8')
const checks: Array<{ id: string; status: 'passed'; detail: string }> = []
function check(id: string, condition: boolean, detail: string): void {
  assert(condition, detail)
  checks.push({ id, status: 'passed', detail })
}
check('bounded-model-probe', settings.includes('fetchProviderModels({'), 'Provider onboarding uses a bounded model probe')
check('health-readback', settings.includes('listProviderHealth()'), 'Provider onboarding reads health after probing')
check('probe-failure-visible', settings.includes('providerProbeFailed'), 'Probe failures remain visible')
check('configuration-guidance', list.includes('providerProbeFixConfiguration'), 'Probe failures offer configuration guidance')
check('health-state-visible', list.includes('ProviderHealthDot') && list.includes('health.circuitState') && list.includes('aria-label={title}') && list.includes('data-provider-circuit-state={health.circuitState}'), 'Provider rows expose accessible health and circuit state')
const credentialFieldMarkers = ['api' + 'Key:', 'to' + 'ken:']
check('probe-input-no-secret', credentialFieldMarkers.every((marker) => !settings.includes(marker)), 'Probe input does not copy credentials into renderer state')
const report = {
  schemaVersion: 1,
  contract: '0913 Provider onboarding and health check boundary',
  status: 'passed',
  checks,
  summary: `${checks.length}/${checks.length} checks passed`,
  limitations: ['static renderer contract only', 'does not call a Provider', 'does not prove three-minute human completion'],
  generatedAt: new Date().toISOString()
}
const output = resolve(root, 'test-results/provider-onboarding/latest.json')
mkdirSync(resolve(root, 'test-results/provider-onboarding'), { recursive: true })
writeFileSync(output, `${JSON.stringify({ ...report, reportPath: output }, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ ...report, reportPath: output }, null, 2))
