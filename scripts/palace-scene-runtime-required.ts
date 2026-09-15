import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parsePalaceSceneManifest, projectPalaceScene2DFallback, resolvePalaceSceneRuntime, type PalaceSceneManifest } from '../src/shared/palace-scene-manifest'

type Check = { id: string; status: 'passed' | 'failed'; detail: string }
const digest = `sha256:${'b'.repeat(64)}`

function fixture(): PalaceSceneManifest {
  return {
    schemaVersion: 1, id: 'runtime-fixture', version: 1, title: '运行时宫苑', assetDigest: digest,
    source: { type: 'builtin', ref: 'fixture.runtime' }, license: { spdx: 'CC-BY-4.0' },
    zones: [
      { id: 'gate', title: '宫门', position: { x: 2, y: 0, z: 3 }, size: { width: 12, depth: 8, height: 4 } },
      { id: 'hall', title: '主殿' }
    ],
    roleBindings: [{ id: 'planner', roleId: 'planner', zoneId: 'hall', target: { kind: 'goal', id: 'goal-1' } }],
    viewBindings: [{ id: 'goal-view', kind: 'overview', zoneId: 'hall', target: { kind: 'goal', id: 'goal-1' } }],
    actionBindings: [{ id: 'start', label: '开始', zoneId: 'gate', commandId: 'work_item.transition', policyId: 'policy:transition', target: { kind: 'workItem', id: 'wi-1' } }]
  }
}

function assert(condition: unknown, detail: string): asserts condition { if (!condition) throw new Error(detail) }

async function main(): Promise<void> {
  const checks: Check[] = []
  const record = (id: string, detail: string, operation: () => void): void => {
    try { operation(); checks.push({ id, status: 'passed', detail }) } catch (error) { checks.push({ id, status: 'failed', detail: error instanceof Error ? error.message : String(error) }) }
  }
  record('fallback-mode', '默认运行时解析选择可离线消费的 2D fallback', () => {
    const projection = resolvePalaceSceneRuntime(fixture())
    assert(projection.mode === '2d-fallback', `mode=${projection.mode}`)
    assert(projection.nodes.length === 3, `node count=${projection.nodes.length}`)
    assert(JSON.stringify(projection) === JSON.stringify(projectPalaceScene2DFallback(fixture())), 'explicit fallback entry point drifted')
  })
  record('deterministic-grid', '缺省 Zone 几何和节点位置稳定且落在 Zone 边界内', () => {
    const first = resolvePalaceSceneRuntime(fixture()); const second = resolvePalaceSceneRuntime(fixture())
    assert(JSON.stringify(first) === JSON.stringify(second), 'fallback projection is not deterministic')
    const hall = first.zones.find((zone) => zone.id === 'hall'); const node = first.nodes.find((item) => item.zoneId === 'hall')
    assert(hall && node && node.x >= hall.x - hall.width / 2 && node.x <= hall.x + hall.width / 2 && node.z >= hall.z - hall.depth / 2 && node.z <= hall.z + hall.depth / 2, 'node escaped zone bounds')
  })
  record('explicit-geometry-preserved', '显式 Zone 几何会原样进入运行时 projection', () => {
    const zone = resolvePalaceSceneRuntime(fixture()).zones.find((item) => item.id === 'gate')
    assert(zone?.x === 2 && zone.y === 0 && zone.z === 3 && zone.width === 12 && zone.depth === 8 && zone.height === 4, 'explicit geometry drifted')
  })
  record('bounded-small-zones', '极小 Zone 或大量绑定也不会把 fallback 节点投影到边界之外', () => {
    const scene = fixture(); scene.zones[1].size = { width: 1, depth: 1, height: 1 }
    scene.viewBindings.push(...Array.from({ length: 20 }, (_, index) => ({ id: `view-${index}`, kind: 'status' as const, zoneId: 'hall', target: { kind: 'goal' as const, id: `goal-${index}` } })))
    const projection = resolvePalaceSceneRuntime(scene); const zone = projection.zones.find((item) => item.id === 'hall')!
    for (const node of projection.nodes.filter((item) => item.zoneId === 'hall')) assert(node.x >= zone.x - zone.width / 2 && node.x <= zone.x + zone.width / 2 && node.z >= zone.z - zone.depth / 2 && node.z <= zone.z + zone.depth / 2, `node ${node.id} escaped small zone`)
  })
  record('capability-mode', '只有调用方显式声明 3D 能力时才选择 3D mode', () => {
    assert(resolvePalaceSceneRuntime(fixture(), { supports3D: true }).mode === '3d', '3D capability was ignored')
    assert(resolvePalaceSceneRuntime(fixture(), { supports3D: false }).mode === '2d-fallback', 'fallback was not selected')
  })
  record('freshness-is-explicit', '正常运行时 projection 明确标记为 fresh', () => {
    const projection = resolvePalaceSceneRuntime(fixture())
    assert(projection.freshness === 'fresh' && projection.stale === false && projection.staleReason === undefined, 'freshness metadata drifted')
  })
  record('offline-is-visible-stale', '离线 projection 带有可解释的 stale 状态', () => {
    const projection = resolvePalaceSceneRuntime(fixture(), { staleReason: 'offline' })
    assert(projection.freshness === 'stale' && projection.stale && projection.staleReason === 'offline', 'offline stale state was not surfaced')
  })
  record('event-delay-is-visible-stale', '事件延迟 projection 带有可解释的 stale 状态', () => {
    const projection = resolvePalaceSceneRuntime(fixture(), { staleReason: 'event-delay' })
    assert(projection.freshness === 'stale' && projection.stale && projection.staleReason === 'event-delay', 'event-delay stale state was not surfaced')
  })
  record('fresh-stale-conflict-fails-closed', 'fresh projection 不能携带 stale 原因', () => {
    try { resolvePalaceSceneRuntime(fixture(), { freshness: 'fresh', staleReason: 'event-delay' }); throw new Error('fresh projection accepted stale reason') } catch (error) { assert(String(error).includes('fresh with a stale reason'), 'fresh/stale conflict was not rejected') }
  })
  record('stale-reason-required', 'stale projection 必须说明离线或事件延迟原因', () => {
    try { resolvePalaceSceneRuntime(fixture(), { freshness: 'stale' }); throw new Error('stale projection accepted missing reason') } catch (error) { assert(String(error).includes('requires a stale reason'), 'stale reason requirement was not enforced') }
  })
  record('binding-preservation', 'Role/View/Action 的规范身份和 policy/command 只作为数据保留', () => {
    const nodes = resolvePalaceSceneRuntime(fixture()).nodes
    const action = nodes.find((node) => node.kind === 'action')
    assert(action?.target.kind === 'workItem' && action.commandId === 'work_item.transition' && action.policyId === 'policy:transition', 'action binding drifted')
    assert(nodes.every((node) => node.id && node.zoneId && node.target.id), 'runtime node lost canonical identity')
  })
  record('provenance-preservation', '运行时 projection 保留资产 digest、来源和许可证，便于打包审计', () => {
    const projection = resolvePalaceSceneRuntime(fixture())
    assert(projection.assetDigest === digest, 'asset digest was dropped')
    assert(projection.source.type === 'builtin' && projection.source.ref === 'fixture.runtime', 'scene source was dropped')
    assert(projection.license.spdx === 'CC-BY-4.0', 'scene license was dropped')
  })
  record('fail-closed', 'manifest 解析失败时 runtime projection 不产生部分结果', () => {
    const malformed = fixture() as unknown as Record<string, unknown>
    malformed.actionBindings = [{ ...fixture().actionBindings[0], commandId: 'shell.exec' }]
    try { resolvePalaceSceneRuntime(malformed); throw new Error('malformed manifest accepted') } catch (error) { assert(String(error).includes('existing canonical CommandId'), 'wrong malformed rejection') }
  })
  record('data-only-output', '运行时结果不包含脚本、网络或可执行字段', () => {
    const serialized = JSON.stringify(resolvePalaceSceneRuntime(parsePalaceSceneManifest(fixture())))
    assert(!/(script|fetch|network|callback|eval|javascript|executable)/iu.test(serialized), 'runtime output contains executable/network material')
  })
  const failed = checks.filter((check) => check.status === 'failed')
  const report = { schemaVersion: 1, contract: 'V2-012 PalaceScene runtime resolver and 2D fallback', generatedAt: new Date().toISOString(), checks, status: failed.length === 0 ? 'passed' : 'failed', summary: `${checks.length - failed.length}/${checks.length} checks passed` }
  const output = resolve(process.cwd(), 'test-results/palace-scene-runtime/latest.json')
  await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (failed.length) throw new Error(failed.map((check) => `${check.id}: ${check.detail}`).join('\n'))
  console.log(`palace scene runtime contract: PASS (${report.summary})`); console.log(`report: ${output}`)
}

void main()
