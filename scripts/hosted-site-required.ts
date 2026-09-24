import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import type { SessionMeta } from '../src/shared/types'
import type { SiteDeploymentTarget } from '../src/shared/site-deployment-types'
import type { HostedSiteDescriptor } from '../src/shared/hosted-site-types'
import { HostedSiteService, type HostedEffectOutcome } from '../src/main/sites/hosted-site-service'
import type { HostedRequest } from '../src/main/sites/hosted-site-protocol'
import type { SiteProcessResult } from '../src/main/sites/site-deployment-process'
import { assertHostedTargetMutable } from '../src/main/sites/hosted-site-state'

async function main(): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'caogen-hosted-sites-'))), adapter = join(root, 'adapter.cjs'), stateFile = join(root, 'hosted-fixture-state.json')
  await writeFile(adapter, `#!${process.execPath}\n${await readFile(new URL('./fixtures/hosted-site-adapter.cjs', import.meta.url), 'utf8')}`, { mode: 0o700 })
  const target: SiteDeploymentTarget = { id: 'target-fixture', revision: 1, name: 'Local fixture', outputDirectory: 'dist', executable: process.execPath, deployArgs: [], rollbackArgs: [], inspectArgs: [], environmentKeys: [], timeoutSeconds: 5,
    management: { protocol: 'caogen-site-management/1', args: [adapter], siteId: 'stable-site-1' } }
  const initialSite: HostedSiteDescriptor = { adapterNamespace: 'local-fixture', accountScope: 'account-1', accountName: 'Fixture account', siteId: target.management!.siteId, name: 'Fixture site', revision: '1', deploymentId: 'deployment-A', url: 'https://fixture.example.test/', observedAt: new Date().toISOString(), deleted: false,
    capabilities: { domainRead: true, domainBind: true, domainUnbind: true, accessRead: true, accessSetPublic: true, accessDisable: true, analytics: true, deleteSite: true, inspectOperation: true, idempotentOperations: true, conditionalMutations: true }, domains: [], access: { mode: 'public', description: 'Fixture public access.' } }
  await writeFile(stateFile, JSON.stringify({ site: initialSite, plans: {}, operations: {}, applyCount: 0 }))
  const meta = { id: 'task-fixture', createdAt: 100, cwd: root, title: 'Fixture', taskStrategy: 'execute', status: 'idle', permissionMode: 'bypassPermissions' } as SessionMeta
  let authorized = true, authorityRevision = 1, current: SessionMeta | undefined = meta
  const effects: string[] = []
  const effectRequests: HostedRequest[] = []
  const host = { root: () => root, session: () => current, deployments: async () => ({ targets: [target], receipts: [] }), authorityRevision: () => authorityRevision,
    authorize: async (_meta: SessionMeta, command: string, revision: number): Promise<void> => { assert(command.includes('CAOGEN_SITE_REQUEST')); if (!authorized || revision !== authorityRevision) throw new Error('fixture authority revoked') },
    effect: async (operationId: string, _meta: SessionMeta, _request: HostedRequest, execute: () => Promise<SiteProcessResult>, success: (result: SiteProcessResult) => boolean): Promise<HostedEffectOutcome> => {
      effects.push(operationId)
      effectRequests.push(_request)
      try { const value = await execute(); return { status: success(value) ? 'completed' : 'waiting_reconciliation', operationId, effectId: `effect-${operationId}`, snapshotId: `operation:${operationId}`, value } }
      catch (error) { return { status: 'waiting_reconciliation', operationId, effectId: `effect-${operationId}`, snapshotId: `operation:${operationId}`, error: String(error) } }
    } }
  const service = new HostedSiteService(host), readRemote = async (): Promise<any> => JSON.parse(await readFile(stateFile, 'utf8'))
  const remote = async (change: (state: any) => void): Promise<void> => { const value = await readRemote(); change(value); await writeFile(stateFile, JSON.stringify(value)) }
  const clean = (): void => undefined
  let groups = 0
  try {
    const first = await service.refresh(meta.id, target.id, target.revision, 10, clean)
    assert(first.connected); assert.equal(first.descriptor?.siteId, 'stable-site-1'); assert.equal(first.descriptor?.deploymentId, 'deployment-A'); groups++
    const range = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-03T00:00:00.000Z', timeZone: 'UTC' }
    const analytics = await service.analytics(meta.id, target.id, range, 10, clean)
    assert.equal(analytics.pageViews, 23); assert.equal(analytics.uniqueVisitors, undefined); assert.equal(analytics.source, 'Local protocol fixture'); groups++
    const domain = await service.prepare(meta.id, target.id, { kind: 'domain.bind', hostname: 'www.example.test' }, 10, clean)
    assert.equal(domain.before.domains.length, 0); assert.equal(domain.after.domains.length, 1)
    assert.equal((await service.execute(meta.id, domain.id, 10, clean)).status, 'confirmed')
    assert.equal((await service.execute(meta.id, domain.id, 10, clean)).status, 'confirmed')
    assert.equal((await readRemote()).applyCount, 1); groups++
    const access = await service.prepare(meta.id, target.id, { kind: 'access.set', mode: 'disabled' }, 10, clean)
    await remote(value => { value.nextApply = 'applied_without_receipt' })
    const unknown = await service.execute(meta.id, access.id, 10, clean)
    assert.equal(unknown.status, 'needs_reconciliation')
    await assert.rejects(service.prepare(meta.id, target.id, { kind: 'site.delete' }, 10, clean), /待核对/)
    await assert.rejects(assertHostedTargetMutable(root, meta.id, target.id), /待核对/)
    const restored = new HostedSiteService(host)
    assert.equal((await restored.get(meta.id, target.id)).receipts[0].status, 'needs_reconciliation')
    assert.equal((await restored.execute(meta.id, access.id, 10, clean)).status, 'needs_reconciliation')
    assert.equal((await readRemote()).applyCount, 2)
    const inspected = await service.inspect(meta.id, access.id, 10, clean)
    assert.equal(inspected.operationId, unknown.operationId); assert.equal(inspected.result, 'applied')
    await service.acceptInspection(meta.id, access.id)
    assert.equal((await service.get(meta.id, target.id)).descriptor?.access.mode, 'disabled'); groups++
    const notApplied = await service.prepare(meta.id, target.id, { kind: 'access.set', mode: 'public' }, 10, clean)
    await remote(value => { value.nextApply = 'not_applied' })
    assert.equal((await service.execute(meta.id, notApplied.id, 10, clean)).status, 'needs_reconciliation')
    assert.equal((await service.inspect(meta.id, notApplied.id, 10, clean)).result, 'not_applied')
    assert.equal((await service.acceptInspection(meta.id, notApplied.id)).status, 'not_applied'); groups++
    const stale = await service.prepare(meta.id, target.id, { kind: 'domain.unbind', hostname: 'www.example.test' }, 10, clean)
    await remote(value => { value.site.revision = '20' })
    assert.equal((await service.execute(meta.id, stale.id, 10, clean)).status, 'needs_reconciliation')
    assert.equal((await service.inspect(meta.id, stale.id, 10, clean)).result, 'not_applied')
    await service.acceptInspection(meta.id, stale.id); groups++
    const revoked = await service.prepare(meta.id, target.id, { kind: 'access.set', mode: 'public' }, 10, clean)
    authorityRevision++
    await assert.rejects(service.execute(meta.id, revoked.id, 10, clean), /授权已变化/)
    const windowPreview = await service.prepare(meta.id, target.id, { kind: 'access.set', mode: 'public' }, 10, clean)
    service.stopOwner(10)
    await assert.rejects(service.execute(meta.id, windowPreview.id, 10, clean), /重启后请重新预览/); groups++
    await remote(value => { value.site.accountScope = 'other-account' })
    await assert.rejects(service.refresh(meta.id, target.id, target.revision, 10, clean), /accountScope/)
    await remote(value => { value.site.accountScope = 'account-1'; value.site.capabilities.deleteSite = false })
    await service.refresh(meta.id, target.id, target.revision, 10, clean)
    await assert.rejects(service.prepare(meta.id, target.id, { kind: 'site.delete' }, 10, clean), /不支持/)
    await remote(value => { value.site.capabilities.deleteSite = true }); groups++
    await service.refresh(meta.id, target.id, target.revision, 10, clean)
    const timeout = await service.prepare(meta.id, target.id, { kind: 'access.set', mode: 'public' }, 10, clean)
    await remote(value => { value.nextApply = 'hang_after_apply' })
    assert.equal((await service.execute(meta.id, timeout.id, 10, clean)).status, 'needs_reconciliation')
    assert.equal((await service.inspect(meta.id, timeout.id, 10, clean)).result, 'applied')
    await service.acceptInspection(meta.id, timeout.id); groups++
    const tampered = await service.prepare(meta.id, target.id, { kind: 'access.set', mode: 'disabled' }, 10, clean)
    const savedFile = join(root, 'hosted-sites', 'state.json'), original = await readFile(savedFile, 'utf8'), modified = JSON.parse(original)
    modified.bindings[0].previews.find((item: any) => item.view.id === tampered.id).view.impact = ['Changed after approval preview']
    await writeFile(savedFile, JSON.stringify(modified))
    await assert.rejects(service.execute(meta.id, tampered.id, 10, clean), /内容变化/)
    await writeFile(savedFile, original); groups++
    const programPreview = await service.prepare(meta.id, target.id, { kind: 'access.set', mode: 'disabled' }, 10, clean)
    const source = await readFile(adapter, 'utf8')
    await writeFile(adapter, `${source}\n// fixture entrypoint changed after preview\n`)
    await assert.rejects(service.execute(meta.id, programPreview.id, 10, clean), /程序/)
    await writeFile(adapter, source); groups++
    await remote(value => { value.site.capabilities.environmentRead = true; value.site.capabilities.environmentSet = true; value.site.capabilities.environmentRemove = true; value.site.environment = []; value.site.environmentRequiresRedeploy = true })
    await service.refresh(meta.id, target.id, target.revision, 10, clean)
    const envValue = 'ordinary-canary-value-for-runtime\nwith-second-line'
    const environment = await service.prepareEnvironment(meta.id, target.id, { name: 'SERVICE_TOKEN', value: envValue, secret: true }, 10, clean)
    assert(!JSON.stringify(environment).includes(envValue)); assert.equal((await readRemote()).lastValueDigest, undefined)
    const envResult = await service.execute(meta.id, environment.id, 10, clean)
    assert.equal(envResult.status, 'confirmed'); assert(!envResult.output.includes('ordinary-canary')); assert(!envResult.output.includes('Incidental adapter'))
    assert.equal((await readRemote()).lastValueDigest, createHash('sha256').update(envValue).digest('hex'))
    assert(!(await readFile(savedFile, 'utf8')).includes('ordinary-canary')); assert(!JSON.stringify(effectRequests).includes('ordinary-canary'))
    await service.execute(meta.id, environment.id, 10, clean); groups++
    const short = await service.prepareEnvironment(meta.id, target.id, { name: 'SERVICE_TOKEN', value: '1', secret: false }, 10, clean)
    assert.equal((await service.execute(meta.id, short.id, 10, clean)).status, 'confirmed')
    const empty = await service.prepareEnvironment(meta.id, target.id, { name: 'EMPTY_VALUE', value: '', secret: true }, 10, clean)
    assert.equal((await service.execute(meta.id, empty.id, 10, clean)).status, 'confirmed'); groups++
    const privateUnknown = await service.prepareEnvironment(meta.id, target.id, { name: 'SERVICE_TOKEN', value: envValue, secret: true }, 10, clean)
    await remote(value => { value.nextApply = 'applied_without_receipt' })
    assert.equal((await service.execute(meta.id, privateUnknown.id, 10, clean)).status, 'needs_reconciliation')
    const restoredPrivate = new HostedSiteService(host), appliedCount = (await readRemote()).applyCount
    assert.equal((await restoredPrivate.execute(meta.id, privateUnknown.id, 10, clean)).status, 'needs_reconciliation')
    assert.equal((await readRemote()).applyCount, appliedCount)
    assert.equal((await restoredPrivate.inspect(meta.id, privateUnknown.id, 10, clean)).result, 'applied')
    await restoredPrivate.acceptInspection(meta.id, privateUnknown.id); restoredPrivate.dispose(); groups++
    const discarded = await service.prepareEnvironment(meta.id, target.id, { name: 'NEVER_SENT', value: envValue, secret: true }, 10, clean)
    await service.discardPreview(meta.id, discarded.id, 10)
    await assert.rejects(service.execute(meta.id, discarded.id, 10, clean), /预览不存在/)
    assert(!JSON.parse(await readFile(savedFile, 'utf8')).bindings[0].previews.some((row: any) => row.view.id === discarded.id))
    await assert.rejects(service.prepareEnvironment(meta.id, target.id, { name: 'BAD-NAME', value: envValue, secret: true }, 10, clean), /变量名/)
    await assert.rejects(service.prepare(meta.id, target.id, { kind: 'environment.set', name: 'TOKEN', valueRef: '11111111-1111-4111-8111-111111111111', secret: true }, 10, clean), /变量值/); groups++
    const removed = await service.prepare(meta.id, target.id, { kind: 'environment.remove', name: 'SERVICE_TOKEN' }, 10, clean)
    assert.equal((await service.execute(meta.id, removed.id, 10, clean)).status, 'confirmed')
    assert(!(await service.get(meta.id, target.id)).descriptor?.environment?.some(item => item.name === 'SERVICE_TOKEN')); groups++
    const deleted = await service.prepare(meta.id, target.id, { kind: 'site.delete' }, 10, clean)
    assert.equal((await service.execute(meta.id, deleted.id, 10, clean)).status, 'confirmed')
    assert.equal((await service.get(meta.id, target.id)).descriptor?.deleted, true)
    assert.equal(new Set(effects).size, effects.length); groups++
    console.log(`PASS ${groups} hosted-site fixture groups; no cloud, DNS, provider or external service calls`)
  } finally { authorized = false; current = undefined; service.dispose(); await rm(root, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
