import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { PluginCatalogService } from '../src/main/plugin/catalog-service'
import { catalogInstallation } from '../src/main/plugin/catalog-installation'
import { archiveDigest, parseCatalog, catalogUrl } from '../src/main/plugin/catalog-protocol'
import { extractCatalogZip } from '../src/main/plugin/catalog-archive'
import { readCatalogBytes, type CatalogTransport } from '../src/main/plugin/catalog-fetch'
import { scanPluginRegistry } from '../src/main/pluginRegistry'
import { buildTaskSnapshot, listTaskRuns, saveTaskSnapshot } from '../src/main/task/task-snapshot'
import { markEffectCompensated } from '../src/main/task/effect-ledger'
import { executeInteractiveOperationEffect } from '../src/main/task/operation-effect-gateway'
import { uninstallPluginWithEffect } from '../src/main/pluginInstallEffect'
import type { PluginCatalogDocument, PluginCatalogPreparationView, PluginCatalogSelection } from '../src/shared/plugin-catalog-types'

const fixtureRoot = process.argv[2], catalogUrlValue = 'https://catalog.invalid/catalog.json', archiveUrl = 'https://catalog.invalid/package.zip'
let checks = 0
async function check(name: string, action: () => Promise<unknown> | unknown): Promise<void> { await action(); checks++; console.log(`PASS ${name}`) }
async function zipPackage(version = '1.0.0'): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('plugin.json', JSON.stringify({ name: 'fixture-plugin', version, description: 'Offline fixture', permissions: ['filesystem:read'] }))
  zip.file('skills/demo/SKILL.md', '---\nname: fixture-demo\ndescription: A local fixture skill.\n---\nRead the selected file.\n')
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' })
}
function document(bytes: Buffer, version = '1.0.0'): PluginCatalogDocument {
  return { schemaVersion: 1, name: 'Offline fixture catalog', packages: [{ id: 'fixture-plugin', name: 'Fixture Plugin', summary: 'Local injected transport only', kind: 'plugin', releases: [{ version, archiveUrl, archiveSha256: archiveDigest(bytes), archiveBytes: bytes.length }] }] }
}
async function fixture(name: string, options: { bytes?: Buffer; transport?: CatalogTransport; lostResponse?: boolean } = {}) {
  const root = join(fixtureRoot, name), plugins = join(root, '.caogen', 'plugins'), userData = join(root, 'app')
  mkdirSync(root, { recursive: true }); const bytes = options.bytes ?? await zipPackage(); let catalog = document(bytes), calls = 0, installs = 0
  const transport: CatalogTransport = options.transport ?? (async url => { calls++; if (url === catalogUrlValue) return new Response(JSON.stringify(catalog)); if (url === archiveUrl) return new Response(new Uint8Array(bytes)); throw new Error('Unexpected fixture URL') })
  const real = catalogInstallation(userData)
  const installation = { install: async (...args: Parameters<typeof real.install>) => { installs++; const result = await real.install(...args); if (options.lostResponse) throw new Error('Synthetic response loss after durable installation'); return result }, reconcile: real.reconcile }
  const service = new PluginCatalogService(userData, plugins, { transport, installation })
  const source = service.add({ name: 'Offline source', url: catalogUrlValue }).sources[0]
  const load = async (): Promise<PluginCatalogSelection> => {
    await service.refresh(source.id); const entry = service.get().entries[0]
    return { sourceId: entry.sourceId, packageId: entry.id, version: entry.release.version, archiveSha256: entry.release.archiveSha256, snapshotDigest: entry.snapshotDigest }
  }
  return { root, plugins, userData, bytes, source, service, load, transport, installation, setCatalog: (next: PluginCatalogDocument) => { catalog = next }, calls: () => calls, installs: () => installs }
}
async function completed(service: PluginCatalogService, id: string): Promise<PluginCatalogPreparationView> {
  for (let count = 0; count < 200; count++) {
    const row = service.get().preparations.find(row => row.id === id)!
    if (row.state !== 'downloading') return row
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Fixture preparation timed out')
}
const commit = (row: PluginCatalogPreparationView) => ({ id: row.id, previewDigest: row.preview!.digest, overwrite: true })

async function main(): Promise<void> {
  await check('HTTPS/static protocol and explicit version validation; saving a source does not fetch', async () => {
    const f = await fixture('protocol'); assert.equal(f.calls(), 0)
    assert.throws(() => catalogUrl('http://catalog.invalid/data.json'), /HTTPS/)
    assert.throws(() => catalogUrl('https://name:secret@catalog.invalid/data.json'), /HTTPS/)
    assert.throws(() => catalogUrl('https://catalog.invalid/data.json?token=x'), /HTTPS/)
    const doc = document(f.bytes); doc.packages[0].releases[0].version = 'latest'; assert.throws(() => parseCatalog(doc, catalogUrlValue), /固定版本/)
    doc.packages[0].releases[0].version = '1.0.0'; doc.packages[0].releases[0].archiveUrl = 'https://other.invalid/package.zip'; assert.throws(() => parseCatalog(doc, catalogUrlValue), /同源/)
  })
  await check('download creates reviewed staging only; confirmed install uses original Effect and does not approve plugins', async () => {
    const f = await fixture('install'), selection = await f.load(), first = f.service.prepare(selection)
    assert.equal(f.service.prepare(selection).id, first.id)
    const preview = await completed(f.service, first.id); assert.equal(preview.state, 'ready', preview.error)
    assert.ok(preview.preview!.items.some(item => item.kind === 'skill')); assert.equal(existsSync(f.plugins), false)
    await assert.rejects(f.service.install({ ...commit(preview), previewDigest: 'a'.repeat(64) }), /预览/)
    const installed = await f.service.install(commit(preview)); assert.equal(installed.state, 'installed', installed.error)
    assert.equal(installed.result?.effectStatus, 'confirmed'); assert.equal(f.installs(), 1)
    const registry = scanPluginRegistry([join(f.root, '.caogen')], { managedRoot: f.plugins })
    assert.ok(registry.items.length >= 2); assert.ok(registry.items.every(item => !item.enabled && item.trust.status === 'approval_required'))
    assert.equal((await f.service.install(commit(preview))).operationId, preview.operationId); assert.equal(f.installs(), 1)
    const runs = await listTaskRuns(`operation:${preview.operationId}`, f.userData)
    assert.equal(runs.length, 1); assert.equal(runs[0].effects?.length, 1)
  })
  await check('unknown response and restart reconcile the original operation without installing again', async () => {
    const f = await fixture('response-loss', { lostResponse: true }), first = f.service.prepare(await f.load()), preview = await completed(f.service, first.id)
    const waiting = await f.service.install(commit(preview)); assert.equal(waiting.state, 'waiting_reconciliation')
    assert.ok(existsSync(join(f.plugins, 'fixture-plugin', 'plugin.json')))
    const restarted = new PluginCatalogService(f.userData, f.plugins, { transport: f.transport, installation: f.installation })
    const recovered = await restarted.install(commit(preview)); assert.equal(recovered.state, 'installed', recovered.error)
    assert.equal(recovered.operationId, waiting.operationId); assert.equal(f.installs(), 1)
    assert.equal((await listTaskRuns(`operation:${waiting.operationId}`, f.userData))[0].effects?.length, 1)
  })
  await check('a real compensated installation reconciles as reverted, never installed or replayed', async () => {
    const f = await fixture('compensation', { lostResponse: true }), initial = f.service.prepare(await f.load()), preview = await completed(f.service, initial.id)
    const waiting = await f.service.install(commit(preview)); assert.equal(waiting.state, 'waiting_reconciliation')
    const uninstall = await uninstallPluginWithEffect(join(f.plugins, 'fixture-plugin'), f.plugins, { runOperation: spec => executeInteractiveOperationEffect({ ...spec, rootDir: f.userData }) })
    assert.equal(uninstall.ok, true); assert.equal(existsSync(join(f.plugins, 'fixture-plugin')), false)
    const original = (await listTaskRuns(`operation:${waiting.operationId}`, f.userData))[0]
    const compensation = (await listTaskRuns(`operation:${uninstall.operationId}`, f.userData))[0].effects![0]
    const compensated = markEffectCompensated(original, original.effects![0].id, compensation.id, archiveDigest(Buffer.from(JSON.stringify(compensation.target))))
    // The completed installation had removed its recovery snapshot. Restore its
    // original operation scope to durably record the actual compensating Effect.
    await saveTaskSnapshot(buildTaskSnapshot({ meta: { id: original.sessionId, title: 'Fixture original installation recovery', cwd: f.root, model: '', providerId: '', taskStrategy: 'execute', permissionMode: 'default', status: 'idle', costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0, createdAt: original.createdAt }, run: compensated, transcript: [], lastSeq: 0, eventCount: 0, reason: 'important-event' }), f.userData)
    const recovered = await f.service.reconcile(waiting.id)
    assert.equal(recovered.state, 'reverted'); assert.equal(recovered.result?.ok, false); assert.equal(recovered.result?.effectStatus, 'compensated')
    assert.equal(recovered.operationId, waiting.operationId); assert.equal(f.installs(), 1)
    assert.equal((await f.service.reconcile(waiting.id)).state, 'reverted')
    await assert.rejects(f.service.install(commit(preview)), /不可安装/)
    assert.equal(f.installs(), 1)
  })
  await check('package digest mismatch and download body limits reject before installation', async () => {
    const f = await fixture('digest'); const doc = document(f.bytes); doc.packages[0].releases[0].archiveSha256 = 'f'.repeat(64); f.setCatalog(doc)
    const row = await completed(f.service, f.service.prepare(await f.load()).id)
    assert.equal(row.state, 'failed'); assert.match(row.error!, /SHA-256/); assert.equal(existsSync(f.plugins), false)
    await assert.rejects(readCatalogBytes(async () => new Response('12345'), catalogUrlValue, 4, new AbortController().signal), /大小/)
  })
  await check('ZIP traversal, symlink, case collision and declared expansion bomb are rejected', async () => {
    const cases: Array<[string, JSZip]> = []
    const traversal = new JSZip(); traversal.file('../outside.txt', 'bad'); cases.push(['traversal', traversal])
    const link = new JSZip(); link.file('linked', '../outside', { unixPermissions: 0o120777 }); cases.push(['symlink', link])
    const duplicate = new JSZip(); duplicate.file('Readme.txt', 'one'); duplicate.file('README.txt', 'two'); cases.push(['collision', duplicate])
    for (const [name, zip] of cases) {
      const archive = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' })
      await assert.rejects(extractCatalogZip(archive, join(fixtureRoot, `bad-${name}`), new AbortController().signal))
    }
    const zip = new JSZip(); zip.file('file.txt', 'small')
    const bomb = await zip.generateAsync({ type: 'nodebuffer' }), central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    bomb.writeUInt32LE(60 * 1024 * 1024, central + 24)
    await assert.rejects(extractCatalogZip(bomb, join(fixtureRoot, 'bad-bomb'), new AbortController().signal))
    assert.equal(existsSync(join(fixtureRoot, 'outside.txt')), false)
  })
  await check('modified prepared bytes and a changed destination cannot replace reviewed content', async () => {
    const f = await fixture('source-drift'), first = f.service.prepare(await f.load()), preview = await completed(f.service, first.id)
    writeFileSync(join(f.userData, 'plugin-catalog', 'payloads', first.id, 'fixture-plugin', 'extra.md'), 'Changed after review')
    await assert.rejects(f.service.install(commit(preview)), /改变/); assert.equal(f.installs(), 0)
    const g = await fixture('target-drift'), next = g.service.prepare(await g.load()), ready = await completed(g.service, next.id)
    mkdirSync(join(g.plugins, 'fixture-plugin'), { recursive: true }); writeFileSync(join(g.plugins, 'fixture-plugin', 'local.txt'), 'retain this')
    const rejected = await g.service.install(commit(ready)); assert.notEqual(rejected.state, 'installed')
    assert.equal(readFileSync(join(g.plugins, 'fixture-plugin', 'local.txt'), 'utf8'), 'retain this')
    assert.equal(existsSync(join(g.plugins, 'fixture-plugin', 'plugin.json')), false)
  })
  await check('changed catalog snapshot cancels old preview; changed digest for same version is visible', async () => {
    const f = await fixture('catalog-drift'), selection = await f.load(), preview = await completed(f.service, f.service.prepare(selection).id)
    const doc = document(f.bytes); doc.packages[0].releases[0].archiveSha256 = 'e'.repeat(64); f.setCatalog(doc)
    await f.service.refresh(f.source.id)
    assert.equal(f.service.get().entries[0].changedVersion, true)
    assert.equal(f.service.get().preparations.find(row => row.id === preview.id)?.state, 'cancelled')
    await assert.rejects(f.service.install(commit(preview)), /不可安装/)
    assert.throws(() => f.service.prepare(selection), /快照/)
  })
  await check('cancelled in-flight download and disabled source cannot publish a late preview', async () => {
    const bytes = await zipPackage(), doc = document(bytes); let deliver!: () => void
    const gate = new Promise<void>(resolve => { deliver = resolve })
    const f = await fixture('cancel', { bytes, transport: async url => url === catalogUrlValue ? new Response(JSON.stringify(doc)) : (await gate, new Response(new Uint8Array(bytes))) })
    const first = f.service.prepare(await f.load()); f.service.enabled(f.source.id, false); deliver()
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(f.service.get().preparations[0].state, 'cancelled'); assert.equal(existsSync(join(f.userData, 'plugin-catalog', 'payloads', first.id)), false)
    assert.equal(f.installs(), 0)
  })
  await check('standalone installed skill stays discoverable and unapproved; temporary profile isolates source cache', async () => {
    const root = join(fixtureRoot, 'standalone'), plugins = join(root, '.caogen', 'plugins', 'demo')
    mkdirSync(plugins, { recursive: true }); writeFileSync(join(plugins, 'SKILL.md'), '---\nname: demo\ndescription: Demo fixture.\n---\nRead selected file.\n')
    const entries = scanPluginRegistry([join(root, '.caogen')], { managedRoot: join(root, '.caogen', 'plugins') }).items
    assert.equal(entries[0]?.kind, 'skill'); assert.equal(entries[0]?.enabled, false)
    const beforeTemporary = process.env.CAOGEN_TEMPORARY_PROFILE_ID, beforeProfile = process.env.CAOGEN_USER_DATA_DIR
    const profile = join(fixtureRoot, 'temporary'); mkdirSync(profile)
    try {
      process.env.CAOGEN_TEMPORARY_PROFILE_ID = 'fixture'; process.env.CAOGEN_USER_DATA_DIR = profile
      const service = new PluginCatalogService(profile, join(profile, '.caogen', 'plugins'), { transport: async () => { throw new Error('not requested') } })
      service.add({ name: 'Temporary source', url: catalogUrlValue }); assert.equal(service.get().sources.length, 1)
      assert.ok(existsSync(join(profile, 'plugin-catalog', 'sources'))); assert.equal(existsSync(join(root, 'plugin-catalog')), false)
    } finally {
      if (beforeTemporary === undefined) delete process.env.CAOGEN_TEMPORARY_PROFILE_ID; else process.env.CAOGEN_TEMPORARY_PROFILE_ID = beforeTemporary
      if (beforeProfile === undefined) delete process.env.CAOGEN_USER_DATA_DIR; else process.env.CAOGEN_USER_DATA_DIR = beforeProfile
    }
  })
  console.log(`RESULT ${checks}/${checks}; temporary roots, injected HTTPS responses and real local installation Effects only. No real network, provider, host or external plugin.`)
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
