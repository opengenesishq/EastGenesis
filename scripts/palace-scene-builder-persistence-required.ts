import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  palaceSceneBuilderPersistencePath,
  persistPalaceSceneBuilderSnapshot,
  restorePalaceSceneBuilderSnapshot
} from '../src/main/task/palace-scene-builder-persistence'
import { createPalaceSceneBuilder } from '../src/main/task/palace-scene-builder'
import type { PalaceSceneManifest } from '../src/shared/palace-scene-manifest'

const assetDigest = `sha256:${'c'.repeat(64)}` as `sha256:${string}`
const sceneId = 'palace-persistence-fixture'

function fixture(): PalaceSceneManifest {
  return {
    schemaVersion: 1, id: sceneId, version: 1, title: '持久化宫苑', assetDigest,
    source: { type: 'builtin', ref: 'caogen.persistence.fixture' }, license: { spdx: 'CC-BY-4.0' },
    zones: [{ id: 'hall', title: '主殿', size: { width: 10, depth: 8, height: 4 } }],
    roleBindings: [{ id: 'planner', roleId: 'planner', zoneId: 'hall', target: { kind: 'goal', id: 'goal-1' } }],
    viewBindings: [{ id: 'overview', kind: 'overview', zoneId: 'hall', target: { kind: 'goal', id: 'goal-1' } }],
    actionBindings: [{ id: 'transition', label: '推进', zoneId: 'hall', commandId: 'work_item.transition', policyId: 'policy:transition', target: { kind: 'workItem', id: 'item-1' } }]
  }
}

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
function assertRejects(operation: () => Promise<unknown>, message: string): Promise<void> {
  return operation().then(() => { throw new Error(message) }, () => undefined)
}

async function childRead(rootDir: string): Promise<string> {
  const result = execFileSync(process.execPath, ['--import', 'tsx', resolve(process.argv[1]), '--read', rootDir, sceneId], { encoding: 'utf8' })
  return result.trim()
}

async function main(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'caogen-palace-builder-'))
  const checks: string[] = []
  try {
    const session = createPalaceSceneBuilder(fixture())
    const first = await persistPalaceSceneBuilderSnapshot(rootDir, sceneId, session.snapshot())
    checks.push('atomic_write')
    session.edit({ title: '重启后可读' })
    const second = await persistPalaceSceneBuilderSnapshot(rootDir, sceneId, session.snapshot())
    const loaded = await restorePalaceSceneBuilderSnapshot(rootDir, sceneId)
    assert(loaded?.session.snapshot().manifest.title === '重启后可读', 'same-process readback failed')
    checks.push('restart_readback')
    assert((await childRead(rootDir)).includes('重启后可读'), 'independent process readback failed')
    checks.push('independent_process_readback')

    const filePath = palaceSceneBuilderPersistencePath(rootDir, sceneId)
    const tampered = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
    ;(tampered.snapshot as Record<string, unknown>).manifest = { ...(tampered.snapshot as Record<string, any>).manifest, title: '被篡改' }
    await writeFile(filePath, `${JSON.stringify(tampered)}\n`, 'utf8')
    await assertRejects(() => restorePalaceSceneBuilderSnapshot(rootDir, sceneId), 'digest tamper was accepted')
    checks.push('digest_tamper_rejected')
    await writeFile(filePath, `${JSON.stringify(second)}\n`, 'utf8')

    const restored = await restorePalaceSceneBuilderSnapshot(rootDir, sceneId)
    assert(restored, 'restored snapshot missing')
    const rolledBack = restored.session.rollback(1)
    assert(rolledBack.manifest.title === '持久化宫苑' && rolledBack.summary.restoredFromRevision === 1, 'version rollback failed')
    checks.push('version_rollback')
    await persistPalaceSceneBuilderSnapshot(rootDir, sceneId, rolledBack)
    const report = { schemaVersion: 1, contract: 'PalaceScene Builder local persistence', status: 'passed', checks, generatedAt: new Date().toISOString() }
    const reportPath = resolve(process.cwd(), 'test-results/palace-scene-builder-persistence/latest.json')
    await mkdir(resolve(reportPath, '..'), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(`palace scene builder persistence: PASS (${checks.length}/${checks.length})\nreport: ${reportPath}`)
  } finally { await rm(rootDir, { recursive: true, force: true }) }
}

if (process.argv[2] === '--read') {
  restorePalaceSceneBuilderSnapshot(process.argv[3], process.argv[4]).then((result) => {
    if (!result) throw new Error('missing persisted snapshot')
    console.log(result.session.snapshot().manifest.title)
  }).catch((error) => { console.error(String(error)); process.exitCode = 1 })
} else {
  void main()
}
