import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MigrationSubscriptions } from '../src/main/migration-subscriptions'
import { readSafeFile, targetFingerprint } from '../src/main/migration-safety'
import type { MigrationApplyInput, MigrationApplyResult, MigrationAsset, MigrationScan } from '../src/shared/migration-types'
import type { InternalMigrationAsset, StoredMigrationScan } from '../src/main/migration-scan-store'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-source-subscriptions-')))
let checks = 0
const pass = (name: string): void => { checks++; console.log(`PASS ${name}`) }
const services: MigrationSubscriptions[] = []

function createFixture(name: string) {
  const directory = join(root, name), sourceRoot = join(directory, 'source'), targetRoot = join(directory, 'target'), storeRoot = join(directory, 'state')
  mkdirSync(sourceRoot, { recursive: true }); mkdirSync(targetRoot)
  const sourcePath = join(sourceRoot, 'rules.md'), targetPath = join(targetRoot, 'caogen.md')
  writeFileSync(sourcePath, 'source version one'); writeFileSync(targetPath, 'source version one')
  const assetId = `${name}-asset`, scans = new Map<string, MigrationScan>()
  let applyCount = 0, scanCount = 0, mode: 'success' | 'unknown' | 'throw' | 'held' = 'success'
  let release: (() => void) | undefined
  const asset = (): MigrationAsset => ({ id: assetId, agent: 'Synthetic', kind: 'rules', scope: 'project', path: sourcePath, name: 'Fixture rules',
    sourceDigest: readSafeFile(sourcePath, 512 * 1024).digest, sizeBytes: readFileSync(sourcePath).length, preview: readFileSync(sourcePath, 'utf8'), targetPath,
    conflict: 'replace_required', ignoredFields: [], risk: 'low', riskReasons: [], importable: true, recommended: true, supportedActions: ['replace', 'skip'] })
  const scan = (cwd?: string): MigrationScan => {
    assert.equal(cwd, targetRoot); scanCount++
    const result: MigrationScan = { scanId: randomUUID(), cwd, mode: 'project', scannedAt: new Date().toISOString(), assets: [asset()], diagnostics: [] }
    scans.set(result.scanId, result); return result
  }
  const result = (backupId: string): MigrationApplyResult => ({ ok: true, status: 'applied', backupId, applied: [{ assetId, name: 'Fixture rules', status: 'applied', targetPath }], skipped: [], message: 'Fixture import applied' })
  const host = { root: storeRoot, scan, async apply(input: MigrationApplyInput, assertCurrent: () => void): Promise<MigrationApplyResult> {
    applyCount++
    assert(scans.has(input.scanId)); assert.deepEqual(input.decisions, [{ assetId, action: 'replace' }])
    if (mode === 'held') await new Promise<void>(resolve => { release = resolve })
    assertCurrent()
    writeFileSync(targetPath, readFileSync(sourcePath))
    if (mode === 'throw') throw new Error('fixture response lost after write')
    if (mode === 'unknown') return { ok: false, status: 'failed', applied: [], skipped: [], errorCode: 'migration_reconciliation_required', message: 'Fixture response unknown' }
    return result(`fixture-backup-${applyCount}`)
  } }
  const instantiate = (): MigrationSubscriptions => { const service = new MigrationSubscriptions(host); services.push(service); return service }
  const initialScan = scan(targetRoot), initialAsset = initialScan.assets[0]
  const internal: InternalMigrationAsset = { asset: initialAsset, sourceRoot, sourcePath, targetRoot, targetPath, targetFingerprint: targetFingerprint(targetPath) }
  const stored: StoredMigrationScan = { result: initialScan, assets: new Map([[assetId, internal]]), createdAt: Date.now() }
  const initialResult = result(`fixture-initial-${name}`), service = instantiate()
  assert.deepEqual(service.remember(stored, initialResult), [assetId])
  const subscription = service.subscribe(initialResult.backupId!, [assetId])[0]
  return { service, instantiate, subscription, sourcePath, targetPath, storeRoot, assetId, stored, initialResult,
    count: () => ({ apply: applyCount, scan: scanCount }), setMode(value: typeof mode) { mode = value }, release() { assert(release); release() } }
}

async function main(): Promise<void> {
  const persistent = createFixture('restart')
  persistent.service.stop()
  const restarted = persistent.instantiate(), original = restarted.list()[0]
  assert.equal(original.id, persistent.subscription.id); assert.equal(original.status, 'unchanged'); assert(original.enabled)
  assert(!('sourceRoot' in original)); assert.equal(persistent.count().apply, 0)
  writeFileSync(persistent.sourcePath, 'source version two')
  const changed = restarted.check()[0]
  assert.equal(changed.status, 'changed'); assert.equal(readFileSync(persistent.targetPath, 'utf8'), 'source version one')
  const preview = restarted.preview(changed.id, changed.revision)
  assert.equal(preview.before, 'source version one'); assert.equal(preview.after.preview, 'source version two'); assert.equal(preview.action, 'replace')
  assert.equal(persistent.count().apply, 0)
  assert((await restarted.apply(preview.id)).ok)
  assert.equal(readFileSync(persistent.targetPath, 'utf8'), 'source version two'); assert.equal(restarted.list()[0].status, 'unchanged')
  assert.equal(restarted.list()[0].revision, original.revision + 1); assert.equal(persistent.count().apply, 1)
  pass('subscriptions survive restart; source changes only produce a preview until the reviewed update is explicitly applied')

  const disabled = createFixture('disabled')
  writeFileSync(disabled.sourcePath, 'changed source')
  const disabledPreview = disabled.service.preview(disabled.subscription.id, disabled.subscription.revision)
  const off = disabled.service.setEnabled(disabled.subscription.id, disabled.subscription.revision, false)
  await assert.rejects(disabled.service.apply(disabledPreview.id), /过期|关闭|变化/)
  assert.throws(() => disabled.service.preview(off.id, off.revision), /关闭/)
  assert.equal(disabled.service.check()[0].enabled, false); assert.equal(disabled.count().apply, 0)
  assert.equal(readFileSync(disabled.targetPath, 'utf8'), 'source version one')
  pass('disabling a subscription invalidates its existing preview and preserves already imported contents')

  const drift = createFixture('drift')
  writeFileSync(drift.sourcePath, 'new source')
  const driftPreview = drift.service.preview(drift.subscription.id, drift.subscription.revision)
  writeFileSync(drift.targetPath, 'user edits after import')
  await assert.rejects(drift.service.apply(driftPreview.id), /目标已变化|来源或导入目标/)
  assert.equal(drift.service.check()[0].status, 'conflict'); assert.equal(drift.count().apply, 0)
  assert.equal(readFileSync(drift.targetPath, 'utf8'), 'user edits after import')
  assert.throws(() => drift.service.preview(drift.subscription.id, drift.subscription.revision), /修改|回滚/)
  pass('target drift after preview blocks the apply callback and leaves later local changes intact')

  for (const mode of ['unknown', 'throw'] as const) {
    const uncertain = createFixture(`uncertain-${mode}`)
    writeFileSync(uncertain.sourcePath, `source update ${mode}`)
    const pending = uncertain.service.preview(uncertain.subscription.id, uncertain.subscription.revision)
    uncertain.setMode(mode)
    if (mode === 'throw') await assert.rejects(uncertain.service.apply(pending.id), /response lost/)
    else assert.equal((await uncertain.service.apply(pending.id)).ok, false)
    assert.equal(uncertain.service.list()[0].status, 'needs_reconciliation')
    await assert.rejects(uncertain.service.apply(pending.id), /过期/)
    assert.throws(() => uncertain.service.preview(uncertain.subscription.id, uncertain.subscription.revision), /待核对/)
    const off = uncertain.service.setEnabled(uncertain.subscription.id, uncertain.subscription.revision, false)
    const on = uncertain.service.setEnabled(off.id, off.revision, true)
    assert.equal(uncertain.service.check()[0].status, 'needs_reconciliation')
    assert.throws(() => uncertain.service.preview(on.id, on.revision), /待核对/)
    uncertain.service.stop()
    const next = uncertain.instantiate()
    assert.equal(next.list()[0].status, 'needs_reconciliation')
    assert.throws(() => next.preview(on.id, on.revision), /待核对/)
    assert.equal(uncertain.count().apply, 1)
  }
  pass('unknown results and lost responses stay pending across checks, toggles and restart; neither re-preview nor old preview can replay the original update')

  const held = createFixture('inflight')
  writeFileSync(held.sourcePath, 'pending source')
  const inFlight = held.service.preview(held.subscription.id, held.subscription.revision)
  held.setMode('held')
  const completion = held.service.apply(inFlight.id)
  assert.equal(held.service.list()[0].status, 'applying')
  assert.throws(() => held.service.preview(held.subscription.id, held.subscription.revision), /待核对|执行/)
  assert.equal(held.instantiate().list()[0].status, 'needs_reconciliation')
  held.service.setEnabled(held.subscription.id, held.subscription.revision, false)
  held.release()
  await assert.rejects(completion, /变化|关闭/)
  assert.equal(readFileSync(held.targetPath, 'utf8'), 'source version one'); assert.equal(held.service.list()[0].status, 'needs_reconciliation')
  pass('an in-flight journal becomes pending on restart; disabling before the effect callback prevents its write and retains uncertainty')

  const candidates = createFixture('candidates')
  const special = { ...candidates.stored.assets.get(candidates.assetId)!, readSourceDigest: () => 'f'.repeat(64) }
  const filtered: StoredMigrationScan = { ...candidates.stored, assets: new Map([[candidates.assetId, special]]) }
  const filteredResult = { ...candidates.initialResult, backupId: 'unsupported-derived-source' }
  assert.deepEqual(candidates.service.remember(filtered, filteredResult), [])
  assert.throws(() => candidates.service.subscribe(filteredResult.backupId, [candidates.assetId]), /过期/)
  assert.deepEqual(candidates.service.remember(undefined, candidates.initialResult), [])
  assert.deepEqual(candidates.service.remember(candidates.stored, { ...candidates.initialResult, ok: false }), [])
  pass('remember returns only actual supported source IDs and excludes callback-derived sources from UI subscription candidates')

  const corrupt = createFixture('corrupt'), statePath = join(corrupt.storeRoot, 'migration-subscriptions.json'), originalState = JSON.parse(readFileSync(statePath, 'utf8'))
  for (const patch of [{ status: 'unrecognized' }, { sourceDigest: 'invalid' }, { targetFingerprint: 'symlink' }, { sourcePath: join(root, 'outside.md') }]) {
    const next = structuredClone(originalState); Object.assign(next.rows[0], patch)
    writeFileSync(statePath, JSON.stringify(next))
    assert.throws(() => corrupt.service.list(), /记录无效/)
  }
  const duplicate = structuredClone(originalState); duplicate.rows.push({ ...duplicate.rows[0] })
  writeFileSync(statePath, JSON.stringify(duplicate)); assert.throws(() => corrupt.service.list(), /记录无效/)
  writeFileSync(statePath, JSON.stringify(originalState))
  assert.equal(corrupt.service.list().length, 1)
  pass('invalid statuses, digests, duplicate identities and paths outside saved roots reject the persisted record before scanning or applying')
  console.log(`migration-subscriptions-required: ${checks}/${checks}; synthetic directories and injected scan/apply only; no real user home, Provider or external service`)
}

void main().finally(() => { for (const service of services) service.stop(); rmSync(root, { recursive: true, force: true }) }).catch(error => { console.error(error); process.exitCode = 1 })
