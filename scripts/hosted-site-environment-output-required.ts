import assert from 'node:assert/strict'
import { hostedProtocolOutput } from '../src/main/sites/hosted-site-output'
import type { HostedRequest } from '../src/main/sites/hosted-site-protocol'
import type { HostedSiteDescriptor } from '../src/shared/hosted-site-types'

const now = new Date().toISOString()
const site: HostedSiteDescriptor = {
  adapterNamespace: 'fixture', accountScope: 'account', accountName: 'Account', siteId: 'site', name: 'Site', revision: '10', observedAt: now, deleted: false,
  capabilities: { domainRead: true, domainBind: true, domainUnbind: true, accessRead: true, accessSetPublic: true, accessDisable: true, analytics: false, deleteSite: true, inspectOperation: true, idempotentOperations: true, conditionalMutations: true, environmentRead: true, environmentSet: true, environmentRemove: true },
  domains: [], access: { mode: 'public', description: 'Public' }, environment: [{ name: 'SETTING', secret: true, revision: '10', updatedAt: now }]
}
const request: HostedRequest = { protocol: 'caogen-site-management/1', requestId: 'request', operation: 'apply', siteId: 'site', accountScope: 'account', operationId: 'operation', expectedRevision: '9', planDigest: 'digest' }
const output = (after: HostedSiteDescriptor) => ({ exitCode: 0, stdout: 'CAOGEN_SITE_MANAGEMENT_RESULT ' + JSON.stringify({ ...request, receipt: { result: 'applied', after } }), stderr: '', timedOut: false, cancelled: false })
for (const value of ['z', 'abc123', 'ordinary-private-canary']) {
  const after = structuredClone(site)
  after.environment![0].revision = `rev-${value}`
  const result = hostedProtocolOutput(output(after), request, value, site)
  assert(result.error); assert.equal(result.stdout, ''); assert.equal(result.stderr, '')
}
assert.equal(hostedProtocolOutput(output(site), request, '1', site).error, undefined)
assert.equal(hostedProtocolOutput(output(site), request, '', site).error, undefined)
console.log('PASS 5 structured output groups: short/long opaque echoes rejected; public revision coincidence and empty value supported')
