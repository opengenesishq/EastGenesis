import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolvePalaceSceneRuntime, type PalaceSceneManifest } from '../src/shared/palace-scene-manifest'

const checks: Array<{ id: string; status: 'passed' | 'failed'; detail: string }> = []
const check = (id: string, condition: boolean, detail: string): void => checks.push({ id, status: condition ? 'passed' : 'failed', detail })

function fixture(): PalaceSceneManifest {
  return {
    schemaVersion: 1, id: 'runtime-entry-fixture', version: 1,
    title: 'Runtime entry fixture', assetDigest: `sha256:${'a'.repeat(64)}`,
    source: { type: 'builtin', ref: 'caogen.runtime.entry' }, license: { spdx: 'CC0-1.0' },
    zones: [{ id: 'hall', title: 'Hall' }], roleBindings: [], viewBindings: [], actionBindings: []
  }
}

async function main(): Promise<void> {
  const component = await readFile(resolve(process.cwd(), 'src/renderer/src/components/studio/PalaceSceneBuilder.tsx'), 'utf8')
  const css = await readFile(resolve(process.cwd(), 'src/renderer/src/components/studio/palace-scene-builder.css'), 'utf8')
  const fallback = resolvePalaceSceneRuntime(fixture())
  const explicit3d = resolvePalaceSceneRuntime(fixture(), { supports3D: true })
  check('default-fallback', fallback.mode === '2d-fallback', 'runtime entry defaults to offline 2D fallback')
  check('explicit-capability', explicit3d.mode === '3d', '3D mode requires explicit caller capability')
  check('provenance-preserved', fallback.assetDigest.startsWith('sha256:') && fallback.source.ref === 'caogen.runtime.entry' && fallback.license.spdx === 'CC0-1.0', 'runtime preview retains digest/source/license')
  check('component-resolves-runtime', component.includes('resolvePalaceSceneRuntime') && component.includes('data-palace-scene-runtime-entry'), 'Builder exposes canonical runtime projection entry')
  check('component-exposes-modes', component.includes('data-palace-scene-runtime-mode="2d-fallback"') && component.includes('data-palace-scene-runtime-mode="3d"') && component.includes("useState<PalaceSceneRuntimeMode>('2d-fallback')"), 'Builder exposes both explicit runtime modes')
  check('component-keeps-data-only', !/(window\.agentDesk\.(sendMessage|dispatch|execute|run)|fetch\(|child_process|shell)/iu.test(component), 'runtime preview does not acquire execution or network capability')
  check('preview-style', css.includes('.palace-scene-runtime-preview') && css.includes('aria-pressed="true"'), 'runtime mode selection has visible state styling')
  const failed = checks.filter((item) => item.status === 'failed')
  const report = { schemaVersion: 1, contract: 'PalaceScene runtime preview entry', status: failed.length ? 'failed' : 'passed', checks, generatedAt: new Date().toISOString() }
  const output = resolve(process.cwd(), 'test-results/palace-scene-runtime-entry/latest.json')
  await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (failed.length) throw new Error(failed.map((item) => `${item.id}: ${item.detail}`).join('\n'))
  console.log(`palace scene runtime entry: PASS (${checks.length}/${checks.length})`)
  console.log(`report: ${output}`)
}

void main()
