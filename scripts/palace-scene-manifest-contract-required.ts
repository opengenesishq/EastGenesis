import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parsePalaceSceneManifest, type PalaceSceneManifest } from '../src/shared/palace-scene-manifest'

type Check = { id: string; status: 'passed' | 'failed'; detail: string }
const digest = `sha256:${'a'.repeat(64)}`

function fixture(): PalaceSceneManifest {
  return {
    schemaVersion: 1, id: 'product-release-palace', version: 3, title: '产品发布宫苑', assetDigest: digest,
    source: { type: 'builtin', ref: 'caogen.product-release-palace' }, license: { spdx: 'CC-BY-4.0', attribution: 'CaoGen' },
    zones: [{ id: 'gate', title: '宫门', position: { x: 0, y: 0, z: 0 }, size: { width: 10, depth: 8, height: 4 } }, { id: 'hall', title: '主殿' }],
    roleBindings: [{ id: 'prince', roleId: 'planner', zoneId: 'hall', target: { kind: 'goal', id: 'goal-release' } }],
    viewBindings: [{ id: 'goal-view', kind: 'overview', zoneId: 'hall', target: { kind: 'goal', id: 'goal-release' } }, { id: 'artifact-view', kind: 'artifact', zoneId: 'gate', target: { kind: 'artifact', id: 'artifact-pr' } }],
    actionBindings: [{ id: 'start-work', label: '开始工作', zoneId: 'hall', commandId: 'work_item.transition', policyId: 'policy:work-item-transition', target: { kind: 'workItem', id: 'work-item-plan' } }],
    theme: { primary: '#2d1b13', accent: '#d4af37' }, camera: { x: 0, y: 10, z: 14, targetX: 0, targetY: 0, targetZ: 0 }
  }
}

function assert(condition: unknown, detail: string): asserts condition { if (!condition) throw new Error(detail) }

async function main(): Promise<void> {
  const checks: Check[] = []
  const record = (id: string, detail: string, op: () => void): void => { try { op(); checks.push({ id, status: 'passed', detail }) } catch (error) { checks.push({ id, status: 'failed', detail: error instanceof Error ? error.message : String(error) }) } }
  record('required-manifest-fields', 'schema, asset digest, source/license and all binding collections are required', () => {
    const parsed = parsePalaceSceneManifest(fixture()); assert(parsed.schemaVersion === 1 && parsed.assetDigest === digest, 'required metadata was not preserved')
    assert(parsed.zones.length > 0 && parsed.roleBindings.length > 0 && parsed.viewBindings.length > 0 && parsed.actionBindings.length > 0, 'binding collections must be populated')
  })
  record('canonical-entity-bindings', 'all bindings target canonical Goal/WorkItem/Run/Artifact/Evidence/Acceptance ids', () => {
    const scene = fixture(); scene.roleBindings.push({ id: 'run-role', roleId: 'executor', zoneId: 'gate', target: { kind: 'run', id: 'run-1' } }); scene.viewBindings.push({ id: 'evidence-view', kind: 'evidence', zoneId: 'gate', target: { kind: 'evidence', id: 'evidence-1' } }); scene.actionBindings.push({ id: 'acceptance', label: '验收', zoneId: 'hall', commandId: 'work_item.acceptance.set', policyId: 'policy:acceptance', target: { kind: 'acceptance', id: 'acceptance-1' } }); parsePalaceSceneManifest(scene)
  })
  record('existing-command-and-policy', 'actions require an existing CommandId and explicit Policy id', () => { const parsed = parsePalaceSceneManifest(fixture()); assert(parsed.actionBindings[0].commandId === 'work_item.transition' && parsed.actionBindings[0].policyId.startsWith('policy:'), 'action is not bound to command/policy') })
  record('reject-unknown-command', 'unknown or ad hoc commands are rejected', () => { const scene = fixture() as any; scene.actionBindings[0].commandId = 'shell.exec'; try { parsePalaceSceneManifest(scene); throw new Error('unknown command accepted') } catch (error) { assert(String(error).includes('existing canonical CommandId'), 'wrong rejection for unknown command') } })
  record('reject-forbidden-script', 'scene files cannot carry scripts, callbacks or executable fields', () => { const scene = fixture() as any; scene.script = 'fetch("https://example.invalid")'; try { parsePalaceSceneManifest(scene); throw new Error('script accepted') } catch (error) { assert(String(error).includes('executable or network'), 'wrong rejection for script') } })
  record('reject-network-request', 'scene files cannot carry network request declarations', () => { const scene = fixture() as any; scene.networkRequest = { url: 'https://example.invalid' }; try { parsePalaceSceneManifest(scene); throw new Error('network request accepted') } catch (error) { assert(String(error).includes('executable or network'), 'wrong rejection for network request') } })
  record('reject-digest-and-version', 'asset digest and schema version are integrity boundaries', () => { const scene = fixture() as any; scene.assetDigest = 'sha256:bad'; try { parsePalaceSceneManifest(scene); throw new Error('bad digest accepted') } catch (error) { assert(String(error).includes('assetDigest'), 'wrong digest rejection') } scene.assetDigest = digest; scene.schemaVersion = 2; try { parsePalaceSceneManifest(scene); throw new Error('bad schema accepted') } catch (error) { assert(String(error).includes('schemaVersion'), 'wrong schema rejection') } })
  record('reject-invalid-zone-reference', 'bindings must point to an existing Zone', () => { const scene = fixture() as any; scene.viewBindings[0].zoneId = 'missing-zone'; try { parsePalaceSceneManifest(scene); throw new Error('missing zone accepted') } catch (error) { assert(String(error).includes('existing zone'), 'wrong zone rejection') } })
  record('reject-duplicate-identities', 'zone and binding identities are unique within their collections', () => { const scene = fixture() as any; scene.zones.push({ ...scene.zones[0] }); try { parsePalaceSceneManifest(scene); throw new Error('duplicate zone accepted') } catch (error) { assert(String(error).includes('zone ids'), 'wrong duplicate rejection') } })
  record('offline-declarative-shape', 'valid scene is data-only and round-trips without executable members', () => { const parsed = parsePalaceSceneManifest(fixture()); const serialized = JSON.stringify(parsed); assert(!/(script|fetch|network|callback|eval|javascript)/iu.test(serialized), 'serialized scene contains executable/network material') })
  const failed = checks.filter((check) => check.status === 'failed'); const report = { schemaVersion: 1, contract: 'V2-012 PalaceScene declarative manifest', generatedAt: new Date().toISOString(), checks, status: failed.length === 0 ? 'passed' : 'failed', summary: `${checks.length - failed.length}/${checks.length} checks passed` }
  const output = resolve(process.cwd(), 'test-results/palace-scene-manifest-contract/latest.json'); await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (failed.length) throw new Error(failed.map((check) => `${check.id}: ${check.detail}`).join('\n')); console.log(`palace scene manifest contract: PASS (${report.summary})`); console.log(`report: ${output}`)
}
void main()
