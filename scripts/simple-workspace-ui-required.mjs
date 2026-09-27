#!/usr/bin/env node
/**
 * User-facing smoke for the simplified EastGenesis workspace.
 *
 * This intentionally checks the first-launch setup and the direct
 * "one sentence -> send" surface. It does not call a real Provider.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'

const repoRoot = path.resolve(process.env.CAOGEN_REPO_ROOT || process.cwd())
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const reportDir = path.join(repoRoot, 'test-results', 'simple-workspace-ui')
const reportPath = path.join(reportDir, 'latest.json')
const checks = []

function pass(name, detail = '') {
  checks.push({ name, status: 'passed', detail })
  console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`)
}

function check(condition, message) {
  assert.ok(condition, message)
}

function freePort(start = 0) {
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
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
    } catch { /* Electron is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Electron debug port did not start: ${port}`)
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

async function stop(child) {
  if (!child || child.exitCode !== null) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
  await new Promise(resolve => setTimeout(resolve, 300))
  if (child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
  }
}

async function main() {
  for (const input of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
    check(existsSync(path.join(repoRoot, input)), `missing ${input}; run npm run build first`)
  }
  pass('built renderer inputs exist')

  // The assistant projection is the only user-facing route. Keep the
  // active-task header and slash menu free of retired project/studio and
  // workflow-entry affordances even when an old session is resumed.
  const chatView = readFileSync(path.join(repoRoot, 'src/renderer/src/components/ChatView.tsx'), 'utf8')
  check(!chatView.includes('workbench-workspace-button'), 'active chat still exposes a project/worktree header button')
  check(!chatView.includes('<TaskWindowButton'), 'active chat still exposes a separate task-window entry')
  check(!chatView.includes('<ImageCanvasLauncher'), 'active chat still exposes a custom image entry')
  check(!chatView.includes('<GuiPreviewLauncher'), 'active chat still exposes a custom GUI preview entry')
  check(!/action="(?:worktree|subagents|sidechat|routines|routine-current-session)"/.test(chatView), 'active chat still exposes retired workflow menu entries')
  const projectedCommands = readFileSync(path.join(repoRoot, 'src/renderer/src/components/experience/projectedComposerCommands.ts'), 'utf8')
  const assistantSet = projectedCommands.match(/const ASSISTANT_COMMAND_IDS = new Set\(\[([\s\S]*?)\]\)/u)?.[1] ?? ''
  check(!/'routine'/.test(assistantSet), 'assistant slash menu still exposes /routine')
  check(!/'subagents'|'worktree'/.test(assistantSet), 'assistant slash menu still exposes project workflow commands')
  const commandPalette = readFileSync(path.join(repoRoot, 'src/renderer/src/components/CommandPalette.tsx'), 'utf8')
  check(commandPalette.includes('projectedPaletteItems(projection, commandItems)'), 'command palette bypasses assistant projection filtering')
  check(!commandPalette.includes("id: 'temporary-task'"), 'command palette still exposes the temporary/custom task entry')
  check(!existsSync(path.join(repoRoot, 'src/renderer/src/components/TemporaryTaskEntry.tsx')), 'temporary/custom entry component is still present')
  const companionFigurePath = path.join(repoRoot, 'src/renderer/src/components/companion/CompanionFigure.tsx')
  const taskCompanionPath = path.join(repoRoot, 'src/renderer/src/components/companion/TaskCompanion.tsx')
  check(!existsSync(companionFigurePath) && !existsSync(taskCompanionPath), 'retired companion/person components are still present')
  const sidebar = readFileSync(path.join(repoRoot, 'src/renderer/src/components/Sidebar.tsx'), 'utf8')
  check(sidebar.includes('data-brand-logo="eastgenesis-app-icon"') && sidebar.includes('APP_ICON_URL'), 'EastGenesis brand icon is not mounted in the active sidebar')
  pass('active assistant projection hides project and workflow entry points')

  const userData = await mkdtemp(path.join(realpathSync(tmpdir()), 'caogen-simple-workspace-'))
  const port = await freePort()
  const electronBin = require('electron')
  const child = spawn(electronBin, [`--remote-debugging-port=${port}`, path.join(repoRoot, 'out', 'main', 'index.js')], {
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
    // The smoke only talks to Electron through CDP. Ignoring stdio keeps the
    // child from leaving an open pipe after the browser closes.
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
    await page.waitForSelector('.first-launch-onboarding', { visible: true, timeout: 30_000 })
    pass('first launch asks for model setup')

    const onboardingCopy = await page.$eval('.first-launch-onboarding', node => node.textContent || '')
    check(onboardingCopy.includes('先连接一个模型'), 'first-launch guide is missing the model setup prompt')
    check(!/项目|视频|机构|数字员工/.test(onboardingCopy), 'first-launch guide still exposes removed product concepts')
    pass('first-launch copy describes the direct conversation flow')

    await page.click('.first-launch-onboarding .btn-primary')
    await page.waitForSelector('[data-provider-quick-setup]', { visible: true, timeout: 10_000 })
    pass('first-launch model setup stays inside the conversation surface')
    await page.click('.first-launch-onboarding-setup .provider-editor-back')
    await page.waitForSelector('.first-launch-onboarding-setup', { hidden: true, timeout: 10_000 })

    const surface = await page.$eval('[data-simple-workspace]', node => ({
      product: node.closest('[data-product-surface]')?.getAttribute('data-product-surface'),
      input: Boolean(node.querySelector('.welcome-composer-input')),
      modelPicker: Boolean(node.querySelector('[data-welcome-model-picker]'))
    }))
    check(surface.product === 'conversation' && surface.input && surface.modelPicker, `simple conversation surface is incomplete: ${JSON.stringify(surface)}`)
    pass('single conversation workspace is mounted')

    const visibleForbidden = await page.evaluate(() => {
      const selectors = [
        '[data-experience-mode-option]', '[data-business-line-option]', '[data-work-os-nav]',
        '[data-sidebar-video-section]', '[data-sidebar-project-section]', '[data-sidebar-action="projects"]',
        '[data-sidebar-action="videos"]', '[data-sidebar-action="institutions"]',
        '[data-sidebar-action="automations"]', '[data-sidebar-action="plugins"]'
      ]
      return selectors.flatMap(selector => [...document.querySelectorAll(selector)]
        .filter(node => getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden')
        .map(node => selector))
    })
    check(visibleForbidden.length === 0, `removed entry points remain visible: ${visibleForbidden.join(', ')}`)
    pass('project, video, business-line and institution entry points are hidden')

    await page.click('.first-launch-onboarding button.btn-ghost')
    await page.waitForSelector('.first-launch-onboarding', { hidden: true, timeout: 10_000 })
    const input = '.welcome-composer-input'
    await page.waitForSelector(input, { visible: true })
    await page.type(input, '请把今天的工作整理成三条要点')
    check(await page.$eval(input, node => node.value) === '请把今天的工作整理成三条要点', 'composer did not retain the user sentence')
    console.log('[INFO] typed composer style', await page.$eval(input, node => ({ value: node.value, color: getComputedStyle(node).color, opacity: getComputedStyle(node).opacity, visibility: getComputedStyle(node).visibility })))
    mkdirSync(reportDir, { recursive: true })
    await page.screenshot({ path: path.join(reportDir, 'simple-workspace-typed.png'), fullPage: false })
    pass('one-sentence composer accepts direct input')

    await page.click('.welcome-send')
    await page.waitForSelector('.settings-page', { visible: true, timeout: 15_000 })
    pass('missing model routes to model settings without another workflow')
    await page.click('.settings-page-back')
    await page.waitForSelector(input, { visible: true, timeout: 10_000 })
    check(await page.$eval(input, node => node.value) === '请把今天的工作整理成三条要点', 'returning from model settings discarded the sentence')
    pass('returning from settings preserves the sentence')

    mkdirSync(reportDir, { recursive: true })
    await page.screenshot({ path: path.join(reportDir, 'simple-workspace.png'), fullPage: false })
    const report = { schemaVersion: 1, kind: 'caogen.simple-workspace-ui-report', status: 'passed', providerCalls: false, checks, screenshot: 'test-results/simple-workspace-ui/simple-workspace.png' }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`simple workspace UI smoke: passed (${checks.length} checks)`)
  } finally {
    // Electron can keep the CDP connection alive after the last page closes;
    // cleanup must never hold the smoke process open indefinitely.
    try {
      if (browser) await Promise.race([
        browser.close(),
        new Promise(resolve => setTimeout(resolve, 1_000))
      ])
    } catch {}
    await stop(child)
    await rm(userData, { recursive: true, force: true })
  }
}

main().catch(async error => {
  mkdirSync(reportDir, { recursive: true })
  await writeFile(reportPath, `${JSON.stringify({ schemaVersion: 1, kind: 'caogen.simple-workspace-ui-report', status: 'failed', checks, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`)
  console.error(error)
  process.exitCode = 1
})
