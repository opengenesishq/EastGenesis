#!/usr/bin/env node
/**
 * Packaged/built renderer smoke for the simplified EastGenesis workspace.
 *
 * The old gate navigated a retired Studio/Work OS surface. EastGenesis now
 * has one user-facing conversation: configure a model once, enter one
 * sentence, and receive the result. This gate exercises that path through
 * Electron CDP and never calls a real Provider.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'

const repoRoot = path.resolve(process.env.CAOGEN_REPO_ROOT || process.cwd())
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const args = parseArgs(process.argv.slice(2))
const startedAt = new Date().toISOString()
const outputDir = path.join(repoRoot, 'test-results', 'packaged-ui-click')
const outputPath = process.env.CAOGEN_UI_CLICK_REPORT_PATH
  ? path.resolve(repoRoot, process.env.CAOGEN_UI_CLICK_REPORT_PATH)
  : path.join(outputDir, 'latest.json')
const checks = []
const report = {
  schemaVersion: 1,
  kind: 'caogen.packaged-ui-click-report',
  gate: 'test:packaged-ui-click:required',
  startedAt,
  status: 'failed',
  evidenceStrength: args.artifact ? 'packaged-renderer-click-observed' : 'built-source-renderer-click-observed',
  providerCalls: false,
  humanEvidence: false,
  artifact: args.artifact || null,
  checks: []
}

function parseArgs(argv) {
  const parsed = { artifact: null, source: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--artifact') parsed.artifact = argv[++index]
    else if (value === '--source') parsed.source = true
    else if (value === '--help' || value === '-h') {
      console.log('Usage: node scripts/packaged-ui-click-required.mjs --source | --artifact PATH')
      process.exit(0)
    } else throw new Error(`unknown option: ${value}`)
  }
  if (!parsed.artifact && !parsed.source) parsed.source = true
  if (Boolean(parsed.artifact) === parsed.source) throw new Error('choose exactly one of --source or --artifact')
  return parsed
}

function check(condition, message) { assert.ok(condition, message) }
function pass(name, detail = '') {
  checks.push({ name, status: 'passed', detail })
  console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`)
}
async function runCheck(name, fn) {
  try { await fn(); pass(name) } catch (error) {
    checks.push({ name, status: 'failed', detail: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
function findFreePort(start = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(start, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : start
      server.close(() => resolve(port))
    })
  })
}
async function waitForDebugPort(port) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Electron remote debugging port did not start: ${port}`)
}
async function waitForPage(browser) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const page = (await browser.pages()).find(candidate => !candidate.url().startsWith('devtools://'))
    if (page) return page
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Electron renderer page did not appear')
}
function executableForArtifact(artifactPath) {
  const resolved = path.resolve(repoRoot, artifactPath)
  check(existsSync(resolved), `artifact missing: ${resolved}`)
  const name = packageJson.productName || 'EastGenesis'
  if (resolved.endsWith('.app')) return path.join(resolved, 'Contents', 'MacOS', name)
  if (resolved.endsWith('-unpacked')) {
    if (process.platform === 'darwin') return path.join(resolved, `${name}.app`, 'Contents', 'MacOS', name)
    if (process.platform === 'win32') return path.join(resolved, `${name}.exe`)
    return path.join(resolved, name)
  }
  return resolved
}
async function stop(child) {
  if (!child || child.exitCode !== null) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
  await new Promise(resolve => setTimeout(resolve, 300))
  if (child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
  }
}

async function main() {
  await runCheck('built app inputs exist', () => {
    for (const entry of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
      check(existsSync(path.join(repoRoot, entry)), `missing ${entry}; run npm run build first`)
    }
  })
  await runCheck('source contract matches the direct assistant surface', () => {
    const app = readFileSync(path.join(repoRoot, 'src/renderer/src/components/AppListView.tsx'), 'utf8')
    const welcome = readFileSync(path.join(repoRoot, 'src/renderer/src/components/WelcomeView.tsx'), 'utf8')
    const sidebar = readFileSync(path.join(repoRoot, 'src/renderer/src/components/Sidebar.tsx'), 'utf8')
    check(app.includes('data-product-surface="conversation"') && app.includes('data-simple-workspace'), 'conversation surface is not mounted')
    check(welcome.includes('data-welcome-heading') && welcome.includes('data-composer-autosize'), 'one-sentence composer is not mounted')
    check(sidebar.includes('data-brand-logo="eastgenesis-app-icon"') && sidebar.includes('APP_ICON_URL'), 'EastGenesis brand icon is not mounted')
    check(!app.includes('data-experience-mode-option="studio"'), 'retired Studio navigation remains active')
  })

  const userData = await mkdtemp(path.join(realpathSync(tmpdir()), 'eastgenesis-packaged-ui-click-'))
  const port = await findFreePort()
  const electronBin = require('electron')
  const executable = args.artifact ? executableForArtifact(args.artifact) : electronBin
  const launchArgs = args.artifact
    ? [`--remote-debugging-port=${port}`, '--user-data-dir', userData]
    : [`--remote-debugging-port=${port}`, path.join(repoRoot, 'out', 'main', 'index.js')]
  const child = spawn(executable, launchArgs, {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userData,
      CAOGEN_MEMORY_DIR: path.join(userData, 'memory'),
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      CAOGEN_RUN_REAL_PROVIDER: ''
    },
    stdio: 'ignore'
  })
  let browser
  let page
  try {
    await waitForDebugPort(port)
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
    page = await waitForPage(browser)
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    await page.waitForSelector('.app', { visible: true, timeout: 30_000 })
    pass('renderer and preload are ready')
    await page.waitForSelector('.first-launch-onboarding', { visible: true, timeout: 30_000 })
    const guide = await page.$eval('.first-launch-onboarding', node => node.textContent || '')
    check(guide.includes('先连接一个模型') && !/项目|视频|机构|数字员工/.test(guide), 'first-launch guide still exposes retired product concepts')
    pass('first launch asks for model setup')
    await page.click('.first-launch-onboarding .btn-primary')
    await page.waitForSelector('[data-provider-quick-setup]', { visible: true, timeout: 10_000 })
    pass('first-launch model setup stays inside the conversation surface')
    await page.click('.first-launch-onboarding-setup .provider-editor-back')
    await page.waitForSelector('.first-launch-onboarding-setup', { hidden: true, timeout: 10_000 })
    const surface = await page.$eval('[data-simple-workspace]', node => ({
      product: node.closest('[data-product-surface]')?.getAttribute('data-product-surface'),
      input: Boolean(node.querySelector('.welcome-composer-input')),
      brand: Boolean(document.querySelector('[data-brand-logo="eastgenesis-app-icon"]'))
    }))
    check(surface.product === 'conversation' && surface.input && surface.brand, `direct assistant surface is incomplete: ${JSON.stringify(surface)}`)
    pass('single conversation workspace is mounted')
    const forbidden = await page.evaluate(() => ['[data-experience-mode-option]', '[data-business-line-option]', '[data-work-os-nav]', '[data-sidebar-video-section]', '[data-sidebar-project-section]', '[data-sidebar-action="projects"]', '[data-sidebar-action="videos"]', '[data-sidebar-action="institutions"]'].flatMap(selector => [...document.querySelectorAll(selector)].filter(node => getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden').map(() => selector)))
    check(forbidden.length === 0, `removed entry points remain visible: ${forbidden.join(', ')}`)
    pass('retired project/video/institution entry points are hidden')
    await page.click('.first-launch-onboarding button.btn-ghost')
    await page.waitForSelector('.first-launch-onboarding', { hidden: true, timeout: 10_000 })
    const input = '.welcome-composer-input'
    await page.type(input, '请把今天的工作整理成三条要点')
    check(await page.$eval(input, node => node.value) === '请把今天的工作整理成三条要点', 'composer did not retain the user sentence')
    mkdirSync(outputDir, { recursive: true })
    await page.screenshot({ path: path.join(outputDir, 'packaged-ui-click.png'), fullPage: false })
    pass('one-sentence composer accepts direct input')
    await page.click('.welcome-send')
    await page.waitForSelector('.settings-page', { visible: true, timeout: 15_000 })
    pass('missing model routes to model settings without another workflow')
    await page.click('.settings-page-back')
    await page.waitForSelector(input, { visible: true, timeout: 10_000 })
    check(await page.$eval(input, node => node.value) === '请把今天的工作整理成三条要点', 'returning from model settings discarded the sentence')
    pass('returning from settings preserves the sentence')
    report.status = 'passed'
    report.screenshot = 'test-results/packaged-ui-click/packaged-ui-click.png'
  } finally {
    try { if (browser) await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 1_000))]) } catch {}
    await stop(child)
    await rm(userData, { recursive: true, force: true })
  }
}

try { await main() } catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
  console.error(`[FAIL] packaged UI click: ${report.error}`)
}
report.checks = checks
report.finishedAt = new Date().toISOString()
mkdirSync(outputDir, { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`packaged UI click: ${report.status}`)
console.log(`report: ${outputPath}`)
process.exit(report.status === 'passed' ? 0 : 1)
