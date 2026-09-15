import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(process.cwd())
const read = (relativePath: string) => readFile(resolve(root, relativePath), 'utf8')
const checks: Array<{ id: string; ok: boolean; detail: string }> = []
const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail: ok ? 'pass' : detail })

async function main(): Promise<void> {
  const [handler, preload, preloadIndex, sharedTypes] = await Promise.all([
    read('src/main/ipc/palace-scene-builder-handlers.ts'),
    read('src/preload/palace-scene-builder.ts'),
    read('src/preload/index.ts'),
    read('src/shared/types.ts')
  ])

  const channels = [
    'palaceSceneBuilder:get',
    'palaceSceneBuilder:save',
    'palaceSceneBuilder:edit',
    'palaceSceneBuilder:rollback',
    'palaceSceneBuilder:export'
  ]

  check('main registers every explicit allowlisted channel', channels.every((channel) => handler.includes(`'${channel}'`)), 'one or more allowlisted channels are missing')
  check('main has no caller supplied channel dispatch', !/ipcMain\.handle\(\s*raw|ipcMain\.handle\(\s*channel/u.test(handler), 'dynamic channel dispatch is forbidden')
  check('main requires trusted renderer sender', handler.includes('assertTrustedWorkflowLedgerSender(event)') && handler.match(/assertTrustedWorkflowLedgerSender\(event\)/gu)?.length === channels.length, 'all handlers must enforce trusted renderer provenance')
  check('main fixes persistence root to app userData', handler.includes("app.getPath('userData')") && !/raw(?:Root|Path)|rootDir:.*unknown/u.test(handler), 'renderer supplied persistence path found')
  check('main exposes declarative inputs only', handler.includes('requiredManifest') && handler.includes('requiredPatch') && handler.includes('requiredRevision') && !/child_process|node:(?:net|http|https)|shell|fetch|spawn|execFile|provider|webhook/iu.test(handler), 'execution, network or provider capability leaked into Builder IPC')
  check('preload exposes only the five allowlisted methods', channels.every((channel) => preload.includes(`'${channel}'`)) && !preload.includes('invokeMain'), 'preload API is not an explicit allowlist')
  check('preload accepts no filesystem path or execution capability', !/path|shell|exec|spawn|fetch|network|provider/iu.test(preload), 'filesystem, execution or network capability found in preload boundary')
  check('preload is mounted through contextBridge AgentDesk API', preloadIndex.includes('...palaceSceneBuilderApi') && preloadIndex.includes("contextBridge.exposeInMainWorld('agentDesk', api)"), 'preload API is not mounted through contextBridge')
  check('shared AgentDeskApi includes PalaceScene Builder API', sharedTypes.includes('PalaceSceneBuilderApi') && sharedTypes.includes("export type * from './palace-scene-builder-types'"), 'shared API type is not exported')

  const failed = checks.filter((item) => !item.ok)
  const report = {
    schemaVersion: 1,
    contract: 'PalaceScene Builder controlled IPC/preload boundary',
    status: failed.length === 0 ? 'passed' : 'failed',
    summary: `${checks.length - failed.length}/${checks.length} checks passed`,
    generatedAt: new Date().toISOString(),
    checks
  }
  const output = resolve(root, 'test-results/palace-scene-builder-ipc/latest.json')
  await mkdir(resolve(output, '..'), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (failed.length > 0) throw new Error(failed.map((item) => `${item.id}: ${item.detail}`).join('\n'))
  console.log(`palace scene builder IPC contract: PASS (${report.summary})`)
  console.log(`report: ${output}`)
}

void main()
