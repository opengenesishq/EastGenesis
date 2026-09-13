import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'
import { spawnElectronTestProcess, terminateElectronTestProcess } from './electron-test-process.mjs'

const require = createRequire(import.meta.url)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function startIsolatedDesktop(name, runDir) {
  const root = process.cwd()
  const temp = mkdtempSync(path.join(tmpdir(), `caogen-${name}-`))
  const appOut = path.join(runDir, 'app', 'out')
  const userData = path.join(temp, 'userData')
  mkdirSync(userData, { recursive: true })
  cpSync(path.join(root, 'out'), appOut, { recursive: true })
  const port = await freePort()
  const child = spawnElectronTestProcess(require('electron'), [
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    `--remote-debugging-port=${port}`, path.join(appOut, 'main', 'index.js')
  ], {
    cwd: root, env: { ...process.env, CAOGEN_USER_DATA_DIR: userData,
      CAOGEN_MEMORY_DIR: path.join(temp, 'memory'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const logs = []
  child.stdout.on('data', (data) => logs.push(data.toString()))
  child.stderr.on('data', (data) => logs.push(data.toString()))
  let browser
  try {
    browser = await until(async () => {
      try { return await require('puppeteer-core').connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }) }
      catch { return null }
    }, Boolean, 30_000, 'Electron debugger')
    const page = await until(async () => (await browser.pages()).find((candidate) => candidate.url().startsWith('file://')), Boolean, 20_000, 'Electron page')
    await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 })
    await page.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 20_000 })
    return { page, logs, userData, async close() {
      await browser.disconnect()
      await terminateElectronTestProcess(child)
      rmSync(temp, { recursive: true, force: true })
    } }
  } catch (error) {
    await browser?.disconnect()
    await terminateElectronTestProcess(child)
    rmSync(temp, { recursive: true, force: true })
    throw error
  }
}

export async function until(read, accepts, timeout, label) {
  const deadline = Date.now() + timeout
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (accepts(value)) return value
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}
