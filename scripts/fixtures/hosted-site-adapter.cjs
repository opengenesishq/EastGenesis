// Local protocol fixture only. All state remains in the current temporary directory.
const fs = require('node:fs')
const file = 'hosted-fixture-state.json'
const request = JSON.parse(fs.readFileSync(0, 'utf8'))
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const save = () => fs.writeFileSync(file, JSON.stringify(state))
const descriptor = () => JSON.parse(JSON.stringify(state.site))
const respond = body => console.log('CAOGEN_SITE_MANAGEMENT_RESULT ' + JSON.stringify({
  protocol: 'caogen-site-management/1', requestId: request.requestId, operation: request.operation,
  siteId: request.siteId, accountScope: state.site.accountScope,
  ...(request.operationId ? { operationId: request.operationId } : {}),
  ...(request.expectedRevision ? { expectedRevision: request.expectedRevision } : {}),
  ...(request.planDigest ? { planDigest: request.planDigest } : {}), ...body
}))
function changed(before, change) {
  const after = JSON.parse(JSON.stringify(before))
  after.revision = String(Number(before.revision) + 1); after.observedAt = new Date().toISOString()
  if (change.kind === 'domain.bind') after.domains.push({ hostname: change.hostname, status: 'pending', observedAt: after.observedAt, dnsInstructions: 'Set the configured CNAME at your DNS provider.' })
  if (change.kind === 'domain.unbind') after.domains = after.domains.filter(domain => domain.hostname !== change.hostname)
  if (change.kind === 'access.set') after.access = { mode: change.mode, description: change.mode === 'disabled' ? 'Public requests are disabled in this fixture.' : 'Public requests are enabled in this fixture.' }
  if (change.kind === 'environment.set') after.environment = [...(after.environment || []).filter(item => item.name !== change.name), { name: change.name, secret: change.secret, revision: after.revision, updatedAt: after.observedAt }]
  if (change.kind === 'environment.remove') after.environment = (after.environment || []).filter(item => item.name !== change.name)
  if (change.kind === 'site.delete') { after.deleted = true; after.access = { mode: 'disabled', description: 'Fixture site deleted.' }; after.domains = []; delete after.url }
  return after
}
if (request.siteId !== state.site.siteId) throw new Error('Unknown site ID')
if (request.operation === 'describe') respond({ data: descriptor() })
else if (request.operation === 'analytics') respond({ data: { source: 'Local protocol fixture', methodology: 'Fixed fixture events; no external visitors measured.', ...request.analytics, generatedAt: new Date().toISOString(), sampled: false, pageViews: 23, daily: [] } })
else if (request.operation === 'plan') {
  if (request.expectedRevision !== state.site.revision) throw new Error('stale revision')
  const plan = { planId: 'plan-' + request.operationId, expiresAt: new Date(Date.now() + 60000).toISOString(), before: descriptor(), after: changed(state.site, request.change), impact: ['Change only fixture site ' + state.site.siteId + ': ' + request.change.kind] }
  state.plans[request.operationId] = { ...plan, change: request.change }; save(); respond({ plan })
} else if (request.operation === 'apply') {
  if (state.operations[request.operationId]) {
    const existing = state.operations[request.operationId]
    if (existing.planDigest !== request.planDigest) throw new Error('Operation digest mismatch')
    respond({ receipt: existing.receipt })
  } else {
    const plan = state.plans[request.operationId]
    if (!plan || plan.planId !== request.planId || JSON.stringify(plan.change) !== JSON.stringify(request.change)) throw new Error('Unknown or changed plan')
    if (request.expectedRevision !== state.site.revision) throw new Error('stale revision')
    if (request.change.kind === 'environment.set') {
      const payload = request.environmentValue
      if (!payload || payload.name !== request.change.name || payload.valueRef !== request.change.valueRef || typeof payload.value !== 'string') throw new Error('Missing bound environment payload')
      state.lastValueDigest = require('node:crypto').createHash('sha256').update(payload.value).digest('hex')
      console.log('Incidental adapter log: ' + payload.value); console.error('Incidental adapter error: ' + payload.value)
    } else if (request.environmentValue) throw new Error('Unexpected private payload')
    const mode = state.nextApply || 'applied'; delete state.nextApply
    const result = mode === 'not_applied' || mode === 'unknown' ? mode : 'applied'
    if (result === 'applied') state.site = changed(state.site, request.change)
    const receipt = { result, ...(result === 'applied' ? { after: descriptor() } : {}) }
    state.operations[request.operationId] = { planDigest: request.planDigest, receipt }; state.applyCount++; save()
    if (mode === 'applied_without_receipt') console.log('The process exited without a protocol receipt.')
    else if (mode === 'hang_after_apply') setTimeout(() => respond({ receipt }), 20000)
    else respond({ receipt })
  }
} else if (request.operation === 'inspect') {
  const operation = state.operations[request.operationId]
  if (operation && operation.planDigest !== request.planDigest) throw new Error('Original operation digest mismatch')
  respond({ receipt: operation?.receipt || { result: 'not_applied' } })
} else throw new Error('Unsupported operation')
