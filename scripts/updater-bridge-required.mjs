#!/usr/bin/env node
/**
 * Static contract for the EastGenesis desktop updater bridge.
 *
 * This does not contact a release server or download anything. It verifies that
 * an enabled signed build has a complete main -> IPC -> preload -> renderer path
 * and that the renderer exposes explicit user actions for update installation.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.env.CAOGEN_REPO_ROOT || process.cwd())
const outputDir = path.join(root, 'test-results', 'updater-bridge')
const outputPath = path.join(outputDir, 'latest.json')
const checks = []

function source(file) {
  const filePath = path.join(root, file)
  assert.ok(existsSync(filePath), `missing ${file}`)
  return readFileSync(filePath, 'utf8')
}

function check(name, condition) {
  assert.ok(condition, name)
  checks.push(name)
  console.log(`[PASS] ${name}`)
}

const shared = source('src/shared/updater-types.ts')
const updater = source('src/main/updater.ts')
const updaterError = source('src/main/updater-error.ts')
const handlers = source('src/main/ipc/updater-handlers.ts')
const ipc = source('src/main/ipc.ts')
const preload = source('src/preload/index.ts')
const status = source('src/renderer/src/components/settings/DesktopStatus.tsx')
const packageJson = JSON.parse(source('package.json'))

check('shared updater event and API types exist', shared.includes("export type UpdaterEvent") && shared.includes('export interface UpdaterApi'))
check('electron-updater is a runtime dependency', Boolean(packageJson.dependencies?.['electron-updater']))
check('main updater disables silent downloads', updater.includes('autoDownload = false') && updater.includes('autoInstallOnAppQuit = false'))
check('main updater emits disabled state for unavailable channels', updater.includes("kind: 'disabled'"))
check('missing preview feed is classified by the updater failure helper', updater.includes('classifyUpdaterFailure') && updaterError.includes('404') && updaterError.includes('latest') && updaterError.includes('releases?'))
check('updater IPC is registered once', handlers.includes('registerUpdaterIpc') && handlers.includes("ipcMain.handle('updater:check'") && handlers.includes("ipcMain.handle('updater:download'") && handlers.includes("updater:quit-and-install"))
check('main IPC wires updater handlers', ipc.includes("import { registerUpdaterIpc }") && ipc.includes('registerUpdaterIpc()'))
check('preload exposes update actions and event unsubscribe', preload.includes('checkForUpdates:') && preload.includes('downloadUpdate:') && preload.includes('quitAndInstall:') && preload.includes('onUpdaterEvent:'))
check('status UI offers check, download and restart actions', status.includes('检查更新') && status.includes('下载更新') && status.includes('重启并安装'))
check('test suite runs updater bridge contract', String(packageJson.scripts?.test || '').includes('test:updater-bridge:required') && packageJson.scripts?.['test:updater-bridge:required'] === 'node scripts/updater-bridge-required.mjs')

const report = { schemaVersion: 1, kind: 'eastgenesis.updater-bridge-report', status: 'passed', releaseClaim: false, checks }
mkdirSync(outputDir, { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`updater bridge contract: passed (${checks.length} checks)`)
console.log(`report: ${outputPath}`)
