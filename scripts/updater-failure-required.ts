import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { classifyUpdaterFailure } from '../src/main/updater-error'

const root = path.resolve(process.env.CAOGEN_REPO_ROOT || process.cwd())
const outputDir = path.join(root, 'test-results', 'updater-failure')
const outputPath = path.join(outputDir, 'latest.json')
const checks: string[] = []

function check(name: string, condition: boolean): void {
  assert.equal(condition, true, name)
  checks.push(name)
  console.log(`[PASS] ${name}`)
}

const missingYaml = classifyUpdaterFailure(new Error(
  'Cannot download latest-mac.yml from https://github.com/opengenesishq/EastGenesis/releases/latest/download/latest-mac.yml: 404 Not Found'
))
check('missing release metadata 404 disables the update channel', missingYaml.kind === 'disabled')

const missingAtom = classifyUpdaterFailure(new Error(
  'GET https://github.com/opengenesishq/EastGenesis/releases.atom returned HTTP 404'
))
check('missing release Atom feed 404 disables the update channel', missingAtom.kind === 'disabled')

const providerNotFound = classifyUpdaterFailure(new Error(
  'GET https://api.example.test/v1/models returned HTTP 404 Not Found'
))
check('unrelated API 404 remains an actionable error', providerNotFound.kind === 'error')

const authFailure = classifyUpdaterFailure(new Error(
  'GET https://github.com/opengenesishq/EastGenesis/releases/latest/download/latest-mac.yml returned 401 Unauthorized; Authorization: Bearer super-secret-token'
))
check('authentication failure on feed remains an actionable error', authFailure.kind === 'error')
check('authentication failure does not expose the URL', authFailure.kind === 'error' && !authFailure.message.includes('https://'))
check('authentication failure does not expose the bearer token', authFailure.kind === 'error' && !authFailure.message.includes('super-secret-token'))

const forbidden = classifyUpdaterFailure({
  message: '403 Forbidden; x-api-key=private-key-value; latest-mac.yml was requested'
})
check('403 feed failure remains an actionable error', forbidden.kind === 'error')
check('API key in an updater error is redacted', forbidden.kind === 'error' && !forbidden.message.includes('private-key-value'))

const report = {
  schemaVersion: 1,
  kind: 'eastgenesis.updater-failure-report',
  status: 'passed',
  releaseClaim: false,
  checks
}
mkdirSync(outputDir, { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`updater failure behavior: passed (${checks.length} checks)`)
console.log(`report: ${outputPath}`)
