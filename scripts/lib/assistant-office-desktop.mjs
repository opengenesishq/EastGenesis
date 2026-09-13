import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnElectronTestProcess, terminateElectronTestProcess } from './electron-test-process.mjs'
import { findFreePort, waitForDebugPort, waitForElectronPage } from './assistant-studio-ui-e2e-runtime.mjs'

export async function startAssistantOfficeDesktop(runDir) {
  const root = process.cwd(); const require = createRequire(import.meta.url)
  const temp = mkdtempSync(path.join(tmpdir(), 'caogen-assistant-office-ui-'))
  const userData = path.join(temp, 'userData'); mkdirSync(userData, { recursive: true })
  const appOut = path.join(runDir, 'app', 'out'); cpSync(path.join(root, 'out'), appOut, { recursive: true })
  const port = await findFreePort(14600); const logs = []
  const child = spawnElectronTestProcess(require('electron'), [
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []), `--remote-debugging-port=${port}`,
    path.join(root, 'scripts/lib/assistant-office-electron-entry.cjs')
  ], { cwd: root, env: { ...process.env, CAOGEN_USER_DATA_DIR: userData, CAOGEN_MEMORY_DIR: path.join(temp, 'memory'),
    CAOGEN_OFFICE_UI_MAIN_ENTRY: path.join(appOut, 'main/index.js'), CAOGEN_OFFICE_UI_EXPORT_PATH: path.join(runDir, 'office-delivery.zip'),
    OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (data) => logs.push(data.toString())); child.stderr.on('data', (data) => logs.push(data.toString()))
  let browser
  try {
    await waitForDebugPort(port, 30000)
    browser = await require('puppeteer-core').connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
    const page = await waitForElectronPage(browser, 20000)
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    await page.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 25000 })
    return { page, logs, userData, async close() { await browser.disconnect(); await terminateElectronTestProcess(child); rmSync(temp, { recursive: true, force: true }) } }
  } catch (error) { await browser?.disconnect(); await terminateElectronTestProcess(child); rmSync(temp, { recursive: true, force: true }); throw error }
}
