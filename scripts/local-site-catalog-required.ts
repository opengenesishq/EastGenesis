import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalSiteCatalogService } from '../src/main/sites/local-site-catalog'

async function main(): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'caogen-sites-check-'))), cwd = join(root, 'project')
  await mkdir(cwd); await writeFile(join(cwd, 'report.html'), '<h1>Report</h1>')
  await mkdir(join(cwd, 'dist')); await writeFile(join(cwd, 'dist', 'index.html'), '<h1>Site</h1>')
  await mkdir(join(cwd, 'next')); await writeFile(join(cwd, 'next', 'index.html'), '<h1>Next</h1>')
  const meta = { id: 'original-task', createdAt: 100, cwd, workspaceId: 'workspace-one', goalId: 'goal-one', workItemId: 'item-one', title: 'Original task', status: 'idle' as const }
  let current: typeof meta | undefined = meta, changeOnRead = false
  const service = new LocalSiteCatalogService({ root: () => join(root, 'data'), session: () => current,
    assertRead: () => { if (changeOnRead && current) current = { ...current, workItemId: 'item-two' } } })
  let groups = 0
  try {
    const registered = await service.register({ sessionId: meta.id, path: 'report.html', name: 'Customer report' })
    const again = await service.register({ sessionId: meta.id, path: './report.html' })
    assert.equal(again.id, registered.id); assert.equal(again.name, 'Customer report')
    assert.equal((await service.list()).sites.length, 1)
    assert.equal((await service.resolve(again.id, again.revision)).sessionId, meta.id)
    const persisted = await readFile(join(root, 'data', 'local-sites', 'catalog.json'), 'utf8')
    assert.match(persisted, /Customer report/); assert(!persisted.includes('localUrl')); groups++

    await assert.rejects(service.register({ sessionId: meta.id, path: '../outside.html' }))
    await symlink(join(cwd, 'report.html'), join(cwd, 'linked.html'))
    await assert.rejects(service.register({ sessionId: meta.id, path: 'linked.html' })); groups++

    changeOnRead = true
    await assert.rejects(service.register({ sessionId: meta.id, path: 'dist' }), /归属已变化/)
    changeOnRead = false; current = meta
    assert.equal((await service.list()).sites.length, 1); groups++

    const owner = { id: meta.id, createdAt: meta.createdAt, cwd, workspaceId: meta.workspaceId, goalId: meta.goalId, workItemId: meta.workItemId }
    const oldTarget = { id: 'target-one', name: 'Original host', outputDirectory: 'dist' }
    const receipt = (id: string, status: string, startedAt: number) => ({
      view: { id, sessionId: meta.id, targetId: oldTarget.id, targetName: oldTarget.name, action: 'deploy', status, startedAt,
        verification: status === 'confirmed' ? 'adapter_receipt' : 'unconfirmed', ...(status === 'confirmed' ? { deploymentId: 'deployment-1', url: 'https://example.test/site' } : {}) },
      preview: { owner, view: { sessionId: meta.id, target: oldTarget } }
    })
    const directory = join(root, 'data', 'site-deployments', createHash('sha256').update(meta.id).digest('hex'))
    await mkdir(directory, { recursive: true })
    const document = { version: 1, owner, targets: [{ ...oldTarget, outputDirectory: 'next' }], receipts: [receipt('receipt-1', 'confirmed', 200), receipt('receipt-2', 'executing', 300)] }
    const ledgerText = JSON.stringify(document)
    await writeFile(join(directory, 'state.json'), ledgerText)
    const listed = await service.list(), oldSite = listed.sites.find(row => row.sourcePath === 'dist')!, newSite = listed.sites.find(row => row.sourcePath === 'next')!
    assert.equal(oldSite.lastConfirmedDeployment?.url, 'https://example.test/site')
    assert.equal(oldSite.latestOperation?.status, 'needs_reconciliation'); assert.equal(oldSite.unresolvedOperations, 1)
    assert.equal(newSite.lastConfirmedDeployment, undefined)
    assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), ledgerText); groups++

    current = { ...meta, workItemId: 'changed' }
    const changed = (await service.list()).sites.find(row => row.id === registered.id)!
    assert.equal(changed.availability, 'owner_changed')
    await assert.rejects(service.resolve(registered.id, registered.revision))
    current = undefined
    assert.equal((await service.list()).sites.find(row => row.id === registered.id)?.availability, 'task_closed')
    current = meta
    await rm(join(cwd, 'report.html'))
    assert.equal((await service.list()).sites.find(row => row.id === registered.id)?.availability, 'missing_source'); groups++

    await writeFile(join(cwd, 'report.html'), '<h1>Back</h1>')
    const before = (await service.list()).sites.find(row => row.sourcePath === 'dist')!
    document.receipts.push(receipt('receipt-3', 'confirmed', 400))
    await writeFile(join(directory, 'state.json'), JSON.stringify(document))
    await assert.rejects(service.resolve(before.id, before.revision), /已变化/)
    document.receipts[0].view.sessionId = 'another-task'
    await writeFile(join(directory, 'state.json'), JSON.stringify(document))
    const invalid = await service.list()
    assert(invalid.warnings.length); assert(!invalid.sites.some(row => row.origin === 'deployment')); groups++
    console.log(`local-site-catalog: ${groups}/6 focused groups passed`)
  } finally { await rm(root, { recursive: true, force: true }) }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
