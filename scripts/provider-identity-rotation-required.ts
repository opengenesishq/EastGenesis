import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { assignProviderConnectionIdentity, readProviderConnectionIdentity } from '../src/main/provider/providerConnectionIdentity'
import type { Provider } from '../src/shared/types'

const pool = 'a'.repeat(64)
const base: Provider = { id: 'fixture-provider', name: 'Fixture', baseUrl: 'https://fixture.invalid', encryptedToken: 'fixture-material-a', models: ['fixture-model'], createdAt: 1, connectionAuthorizationPoolDigest: pool }

function run(): void {
  const first = assignProviderConnectionIdentity(undefined, base, { authorizationPoolDigest: pool })
  const firstIdentity = readProviderConnectionIdentity(first)
  assert.equal(firstIdentity.revision, 1)
  assert.notEqual(firstIdentity.generationId, '')

  const unchanged = assignProviderConnectionIdentity(first, { ...first, name: 'renamed' }, { authorizationPoolDigest: pool })
  assert.deepEqual(readProviderConnectionIdentity(unchanged), firstIdentity, 'display-only edits must not rotate identity')

  const endpointChanged = assignProviderConnectionIdentity(first, { ...first, baseUrl: 'https://fixture-2.invalid', connectionIdentity: { generationId: '00000000-0000-4000-8000-000000000099', revision: 99 } }, { authorizationPoolDigest: pool })
  assert.equal(readProviderConnectionIdentity(endpointChanged).generationId, firstIdentity.generationId)
  assert.equal(readProviderConnectionIdentity(endpointChanged).revision, 2, 'connection meaning changes must advance revision exactly once')

  const credentialChanged = assignProviderConnectionIdentity(first, { ...first, encryptedToken: 'fixture-material-b' }, { credentialReplacement: true, authorizationPoolDigest: pool })
  assert.equal(readProviderConnectionIdentity(credentialChanged).revision, 2, 'credential replacement must advance revision')

  const poolChanged = assignProviderConnectionIdentity(first, first, { authorizationPoolDigest: 'b'.repeat(64) })
  assert.equal(readProviderConnectionIdentity(poolChanged).revision, 2, 'authorization pool transition must advance revision')

  assert.throws(() => assignProviderConnectionIdentity(first, first, { authorizationPoolDigest: 'bad' }), /authorization pool identity is unavailable/)
  assert.throws(() => readProviderConnectionIdentity({ ...first, connectionAuthorizationPoolDigest: 'bad' }), /not durably available/)

  const report = { schemaVersion: 1, kind: 'caogen.provider-identity-rotation-report', status: 'passed', checks: 8,
    initialRevision: firstIdentity.revision, endpointRevision: readProviderConnectionIdentity(endpointChanged).revision,
    credentialRevision: readProviderConnectionIdentity(credentialChanged).revision, poolRevision: readProviderConnectionIdentity(poolChanged).revision,
    importedIdentityIgnored: true, generatedAt: new Date().toISOString() }
  const outputDir = join(process.cwd(), 'test-results', 'provider-identity-rotation')
  const reportPath = join(outputDir, 'latest.json')
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify({ ...report, reportPath }, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
}

run()
