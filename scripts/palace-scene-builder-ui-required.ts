import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parsePalaceSceneBuilderUiManifest, validatePalaceSceneBuilderUiManifest, hasDeclarativeOnlyBuilderPayload } from '../src/renderer/src/components/studio/palace-scene-builder-gate'
import type { PalaceSceneManifest } from '../src/shared/palace-scene-manifest'

const checks: Array<{ id: string; status: 'passed' | 'failed'; detail: string }> = []
function check(id: string, condition: boolean, detail: string): void { checks.push({ id, status: condition ? 'passed' : 'failed', detail }) }

function fixture(): PalaceSceneManifest {
  return {
    schemaVersion: 1, id: 'ui-builder-fixture', version: 1, layoutVersion: 1,
    title: 'Builder UI Fixture', assetDigest: `sha256:${'1'.repeat(64)}`,
    source: { type: 'builtin', ref: 'caogen.ui.fixture' }, license: { spdx: 'CC0-1.0' },
    zones: [{ id: 'hall', title: 'Hall' }], roleBindings: [], viewBindings: [], actionBindings: []
  }
}

async function main(): Promise<void> {
  const component = await readFile(resolve(process.cwd(), 'src/renderer/src/components/studio/PalaceSceneBuilder.tsx'), 'utf8')
  const studio = await readFile(resolve(process.cwd(), 'src/renderer/src/components/studio/StudioView.tsx'), 'utf8')
  const gate = await readFile(resolve(process.cwd(), 'src/renderer/src/components/studio/palace-scene-builder-gate.ts'), 'utf8')
  const manifest = fixture()
  check('pure-gate-accepts-declarative-manifest', validatePalaceSceneBuilderUiManifest(manifest).ok, 'valid manifest is accepted by renderer-safe gate')
  check('pure-gate-rejects-network-shaped-input', !hasDeclarativeOnlyBuilderPayload({ ...manifest, network: { url: 'https://example.invalid' } }), 'network-shaped input is rejected before IPC')
  check('pure-gate-rejects-unknown-field', !validatePalaceSceneBuilderUiManifest({ ...manifest, script: 'fetch()' }).ok, 'unknown or executable fields are rejected')
  check('pure-gate-round-trips', parsePalaceSceneBuilderUiManifest(manifest).id === manifest.id, 'gate preserves the canonical manifest identity')
  check('component-exposes-lifecycle-states', component.includes('data-palace-scene-builder-state') && component.includes('data-palace-scene-status="loading"') && component.includes('role="alert"'), 'loading, error, and fail-closed empty states are rendered')
  check('component-exposes-four-editors', component.includes('data-palace-scene-collection={collection}') && ['zones', 'roleBindings', 'viewBindings', 'actionBindings'].every((marker) => component.includes(`collection === '${marker}'`)), 'Zone/Role/View/Action list editors are exposed')
  check('component-surfaces-stale-projection', component.includes('staleReason?: PalaceSceneStaleReason') && component.includes('navigator.onLine') && component.includes("addEventListener('offline'") && component.includes('data-palace-scene-freshness') && component.includes('Projection is stale'), 'offline/event-delayed projections expose an explicit stale read-only hint')
  check('component-uses-allowlisted-api', ['getPalaceSceneBuilder', 'savePalaceSceneBuilder', 'editPalaceSceneBuilder', 'rollbackPalaceSceneBuilder', 'exportPalaceSceneBuilder'].every((method) => component.includes(`window.agentDesk.${method}`)), 'all Builder operations use the existing AgentDesk API')
  check('component-keeps-actions-declarative', !/window\.agentDesk\.(sendMessage|dispatch|execute|run)/u.test(component) && gate.includes('parsePalaceSceneManifest'), 'UI has no execution/network capability and validates through shared parser')
  check('studio-keeps-inbox-first', studio.includes("useState<StudioSection>('inbox')") && studio.includes('data-studio-section-option="builder"'), 'Builder is an additional Studio tab while Work Inbox remains first')
  const failed = checks.filter((entry) => entry.status === 'failed')
  const report = { schemaVersion: 1, contract: 'PalaceScene Builder renderer UI slice', status: failed.length === 0 ? 'passed' : 'failed', checks, generatedAt: new Date().toISOString() }
  const output = resolve(process.cwd(), 'test-results/palace-scene-builder-ui/latest.json')
  await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (failed.length) throw new Error(failed.map((entry) => `${entry.id}: ${entry.detail}`).join('\n'))
  console.log(`palace scene builder UI contract: PASS (${checks.length}/${checks.length})`)
  console.log(`report: ${output}`)
}

void main()
