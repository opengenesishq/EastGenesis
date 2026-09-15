import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  createPalaceSceneBuilder,
  exportPalaceSceneBuilderManifest,
  importPalaceSceneBuilderManifest,
  palaceSceneBuilderDigest
} from '../src/main/task/palace-scene-builder'
import type { PalaceSceneManifest } from '../src/shared/palace-scene-manifest'

type Check = { id: string; status: 'passed' | 'failed'; detail: string }
const assetDigest = `sha256:${'b'.repeat(64)}` as `sha256:${string}`

function fixture(): PalaceSceneManifest {
  return {
    schemaVersion: 1, id: 'builder-fixture', version: 1, title: 'Builder Fixture', assetDigest,
    source: { type: 'builtin', ref: 'caogen.builder.fixture' }, license: { spdx: 'CC-BY-4.0' },
    zones: [{ id: 'hall', title: '主殿', size: { width: 10, depth: 8, height: 4 } }],
    roleBindings: [{ id: 'planner', roleId: 'planner', zoneId: 'hall', target: { kind: 'goal', id: 'goal-1' } }],
    viewBindings: [{ id: 'overview', kind: 'overview', zoneId: 'hall', target: { kind: 'goal', id: 'goal-1' } }],
    actionBindings: [{ id: 'transition', label: '推进', zoneId: 'hall', commandId: 'work_item.transition', policyId: 'policy:transition', target: { kind: 'workItem', id: 'item-1' } }]
  }
}

function assert(condition: unknown, detail: string): asserts condition { if (!condition) throw new Error(detail) }

async function main(): Promise<void> {
  const checks: Check[] = []
  const record = (id: string, detail: string, op: () => void): void => {
    try { op(); checks.push({ id, status: 'passed', detail }) } catch (error) { checks.push({ id, status: 'failed', detail: error instanceof Error ? error.message : String(error) }) }
  }
  record('import-validates-manifest', 'Builder imports through the canonical PalaceScene parser and adds a layout version', () => {
    const imported = importPalaceSceneBuilderManifest(JSON.stringify(fixture()))
    assert(imported.layoutVersion === 1, 'legacy manifest did not receive layoutVersion')
  })
  record('configures-all-declarative-areas', 'Zone, Role, View, Action and layout version edits are represented as data', () => {
    const session = createPalaceSceneBuilder(fixture())
    const result = session.edit({
      layoutVersion: 2,
      zones: [{ id: 'hall', title: '新主殿', size: { width: 12, depth: 9, height: 5 } }, { id: 'gate', title: '宫门' }],
      roleBindings: [{ id: 'builder', roleId: 'builder', zoneId: 'hall', target: { kind: 'workItem', id: 'item-1' } }],
      viewBindings: [{ id: 'status', kind: 'status', zoneId: 'gate', target: { kind: 'workItem', id: 'item-1' } }],
      actionBindings: [{ id: 'accept', label: '验收', zoneId: 'hall', commandId: 'work_item.acceptance.set', policyId: 'policy:acceptance', target: { kind: 'acceptance', id: 'accept-1' } }]
    })
    assert(result.manifest.layoutVersion === 2 && result.manifest.zones.length === 2, 'layout/zone edit missing')
    assert(result.manifest.roleBindings[0].roleId === 'builder' && result.manifest.viewBindings[0].kind === 'status', 'role/view edit missing')
    assert(result.manifest.actionBindings[0].commandId === 'work_item.acceptance.set', 'action edit missing')
  })
  record('edit-is-effect-free', 'Editing returns data-only snapshots and creates no Effect or executable member', () => {
    const result = createPalaceSceneBuilder(fixture()).edit({ title: '仅数据编辑' })
    const serialized = JSON.stringify(result)
    assert(!Object.prototype.hasOwnProperty.call(result, 'effect') && !/"(?:effect|script|network|callback|executable)"/iu.test(serialized), 'Builder output contains an effect or executable field')
  })
  record('stable-digest', 'Equivalent manifests receive the same stable version digest', () => {
    const one = palaceSceneBuilderDigest(fixture()); const two = palaceSceneBuilderDigest(JSON.parse(JSON.stringify(fixture())))
    assert(one === two && /^sha256:[a-f0-9]{64}$/u.test(one), 'digest is not stable sha256')
  })
  record('export-import-roundtrip', 'Export is JSON data and re-import is validated before use', () => {
    const session = createPalaceSceneBuilder(fixture()); session.edit({ title: 'roundtrip' }); const exported = session.export(); const imported = importPalaceSceneBuilderManifest(exported)
    assert(imported.title === 'roundtrip' && palaceSceneBuilderDigest(imported) === session.snapshot().summary.digest, 'roundtrip digest drifted')
  })
  record('rejects-malformed-import', 'Malformed JSON and unknown executable/network fields fail closed', () => {
    try { importPalaceSceneBuilderManifest('{bad json'); throw new Error('malformed JSON accepted') } catch (error) { assert(String(error).includes('invalid JSON'), 'wrong malformed JSON rejection') }
    const malicious = { ...fixture(), script: 'fetch("https://example.invalid")' } as unknown
    try { importPalaceSceneBuilderManifest(malicious); throw new Error('executable field accepted') } catch (error) { assert(String(error).includes('executable or network'), 'wrong executable rejection') }
  })
  record('atomic-edit-validation', 'Invalid edits are rejected without mutating the current revision', () => {
    const session = createPalaceSceneBuilder(fixture()); const before = session.snapshot()
    try { session.edit({ zones: [{ id: 'missing-ref', title: 'x' }], layoutVersion: 0 }); throw new Error('invalid edit accepted') } catch { /* expected */ }
    const after = session.snapshot(); assert(after.summary.digest === before.summary.digest && after.summary.builderRevision === 1, 'failed edit mutated state')
  })
  record('version-summary', 'Each accepted edit advances builder and layout revisions with parent digest', () => {
    const session = createPalaceSceneBuilder(fixture()); const first = session.snapshot(); const second = session.edit({ title: 'v2' });
    assert(second.summary.builderRevision === 2 && second.summary.manifestVersion === 2 && second.summary.layoutVersion === 2, 'revision did not advance')
    assert(second.summary.parentDigest === first.summary.digest && second.summary.changedAreas.includes('metadata'), 'version summary missing lineage')
  })
  record('rollback-restores-old-manifest', 'Rollback restores an immutable prior manifest and records a rollback summary', () => {
    const session = createPalaceSceneBuilder(fixture()); const initial = session.snapshot(); session.edit({ title: 'v2' }); const rolled = session.rollback(1)
    assert(rolled.manifest.title === initial.manifest.title && rolled.summary.digest === initial.summary.digest, 'rollback did not restore exact manifest')
    assert(rolled.summary.change === 'rollback' && rolled.summary.restoredFromRevision === 1 && rolled.summary.builderRevision === 3, 'rollback summary missing')
    assert(rolled.history.length === 3, 'rollback history was not retained')
  })
  record('rollback-fails-closed', 'Unknown or invalid revisions cannot be used to restore state', () => {
    const session = createPalaceSceneBuilder(fixture())
    try { session.rollback(99); throw new Error('unknown rollback accepted') } catch (error) { assert(String(error).includes('not found'), 'wrong unknown rollback rejection') }
  })
  record('canonical-action-boundary', 'Builder cannot bypass canonical CommandId and Policy validation', () => {
    const session = createPalaceSceneBuilder(fixture())
    try { session.edit({ actionBindings: [{ id: 'bad', label: '执行脚本', zoneId: 'hall', commandId: 'shell.exec', policyId: 'policy:x', target: { kind: 'workItem', id: 'item-1' } } as any] }); throw new Error('unknown command accepted') } catch (error) { assert(String(error).includes('existing canonical CommandId'), 'wrong command boundary rejection') }
  })
  const failed = checks.filter((check) => check.status === 'failed')
  const report = { schemaVersion: 1, contract: 'V2 PalaceScene Builder declarative contract', generatedAt: new Date().toISOString(), checks, status: failed.length === 0 ? 'passed' : 'failed', summary: `${checks.length - failed.length}/${checks.length} checks passed` }
  const output = resolve(process.cwd(), 'test-results/palace-scene-builder-contract/latest.json'); await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (failed.length) throw new Error(failed.map((check) => `${check.id}: ${check.detail}`).join('\n'))
  console.log(`palace scene builder contract: PASS (${report.summary})`); console.log(`report: ${output}`)
}

void main()
