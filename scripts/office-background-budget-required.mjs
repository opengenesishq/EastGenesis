#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'
import { openControlRoom } from './lib/open-control-room.mjs'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const electronBin = require('electron')
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/gu, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'office-background-budget')
const reportDir = path.join(reportRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-office-background-'))
const userDataDir = path.join(tempRoot, 'user-data')
const projectDir = path.join(tempRoot, 'project')
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const intervalMs = 1_500
const budgets = {
  pausedFrameDeltaMaximum: 0,
  rendererTaskCpuPercentMaximum: 15,
  gpuCpuPercentMaximum: 12,
  totalCpuPercentMaximum: 45,
  canonicalTaskLatencyMsMaximum: 2_000,
  minimumActiveFrameDelta: 2
}
const report = {
  schemaVersion: 1,
  status: 'failed',
  gate: 'test:office-background-budget:required',
  runId,
  startedAt,
  environment: hostEnvironment(),
  budgets,
  intervalMs,
  sourceContract: {},
  phases: [],
  errors: [],
  warnings: []
}
let electron
let browser
let page
let pageSession
let systemSession

mkdirSync(reportDir, { recursive: true })
prepareFixture()

try {
  verifySourceContract()
  const port = await findFreePort(10_210)
  electron = launchElectron(port)
  await waitForDebugPort(port, 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
  page = await waitForPage(browser, 20_000)
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
  await page.bringToFront()
  await waitForApp(page)
  pageSession = await page.target().createCDPSession()
  systemSession = await browser.target().createCDPSession()
  await pageSession.send('Performance.enable')
  await pageSession.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await createRuntimeFixture(page)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await waitForApp(page)
  await page.bringToFront()
  await openOffice(page)

  const foreground = await measurePhase('foreground', 1)
  assert.ok(foreground.frameDelta >= budgets.minimumActiveFrameDelta,
    `foreground advanced only ${foreground.frameDelta} WebGL frames`)
  report.phases.push(foreground)

  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await waitForRenderState(page, false)
  const blurred = await measurePhase('blurred', 2)
  assertPausedBudget(blurred)
  report.phases.push(blurred)

  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await waitForRenderState(page, true, blurred.frameEnd)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await waitForRenderState(page, false)
  const hidden = await measurePhase('hidden', 3)
  assertPausedBudget(hidden)
  report.phases.push(hidden)

  await page.evaluate(() => {
    delete document.hidden
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  })
  await waitForRenderState(page, true, hidden.frameEnd)
  const resumed = await measurePhase('resumed', 4)
  assert.ok(resumed.frameDelta >= budgets.minimumActiveFrameDelta,
    `resumed Office advanced only ${resumed.frameDelta} WebGL frames`)
  report.phases.push(resumed)

  for (const phase of report.phases) {
    assert.ok(phase.task.durationMs <= budgets.canonicalTaskLatencyMsMaximum,
      `${phase.name} canonical task latency ${phase.task.durationMs.toFixed(1)}ms exceeds ${budgets.canonicalTaskLatencyMsMaximum}ms`)
  }
  const pausedLatencyMaximum = Math.min(
    budgets.canonicalTaskLatencyMsMaximum,
    Math.max(foreground.task.durationMs * 1.5 + 250, foreground.task.durationMs + 500)
  )
  assert.ok(blurred.task.durationMs <= pausedLatencyMaximum && hidden.task.durationMs <= pausedLatencyMaximum,
    `background canonical task latency regressed: ${JSON.stringify({ foreground: foreground.task.durationMs, blurred: blurred.task.durationMs, hidden: hidden.task.durationMs, maximum: pausedLatencyMaximum })}`)

  const itemIds = await page.evaluate((projectId) => window.agentDesk.listProjectWorkItems(projectId), 'office-background-project')
  assert.deepEqual(itemIds.map((item) => item.id).sort(), [1, 2, 3, 4].map((index) => `office-background-task-${index}`))
  report.status = 'passed'
} catch (error) {
  report.errors.push(serializeError(error))
  if (page) await capture(page, 'failure').catch(() => undefined)
  console.error(error)
  process.exitCode = 1
} finally {
  if (pageSession) await pageSession.detach().catch(() => undefined)
  if (systemSession) await systemSession.detach().catch(() => undefined)
  if (browser) await browser.disconnect().catch(() => undefined)
  if (electron) await terminate(electron)
  report.finishedAt = new Date().toISOString()
  report.git = gitIdentity()
  writeReport()
  rmSync(tempRoot, { recursive: true, force: true })
  console.log(`office background budget required gate: ${report.status} (${report.phases.length}/4 phases)`)
}

function prepareFixture() {
  assert.ok(existsSync(mainEntry), 'built Electron app is missing; run npm run build first')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(path.join(projectDir, 'README.md'), '# Office background budget fixture\n', 'utf8')
  writeFileSync(path.join(userDataDir, 'providers.json'), JSON.stringify([
    {
      id: 'office-background-provider',
      name: 'Office Background Provider',
      baseUrl: 'http://127.0.0.1:9',
      encryptedToken: `b64:${Buffer.from('office-background-fixture').toString('base64')}`,
      models: ['office-background-model'],
      openaiProtocol: 'responses',
      createdAt: Date.now()
    }
  ], null, 2))
  writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({
    defaultModel: 'office-background-model',
    defaultProviderId: 'office-background-provider',
    defaultPermissionMode: 'default',
    language: 'en',
    theme: 'dark',
    office: { qualityMode: 'low', showBadges: true, liveliness: 0.4, catEars: false }
  }, null, 2))
}

function verifySourceContract() {
  const officeView = readSource('src/renderer/src/components/office/OfficeView.tsx')
  const quality = readSource('src/renderer/src/components/office/kit/OfficeRenderQuality.tsx')
  const contract = {
    frameloopNever: /frameloop=["']never["']/.test(officeView),
    productionFrameDriver: officeView.includes('<OfficeFrameDriver active={renderQuality.renderActive}'),
    visibilityAndFocusState: quality.includes('!document.hidden && document.hasFocus()'),
    visibilityListener: quality.includes("document.addEventListener('visibilitychange'"),
    blurListener: quality.includes("window.addEventListener('blur', pause)"),
    focusListener: quality.includes("window.addEventListener('focus', resume)"),
    manualAdvance: quality.includes('advance(elapsedRef.current, true)'),
    frameCleanup: quality.includes('window.cancelAnimationFrame(frame)')
  }
  assert.ok(Object.values(contract).every(Boolean), `Office background source contract failed: ${JSON.stringify(contract)}`)
  report.sourceContract = contract
}

async function createRuntimeFixture(targetPage) {
  await targetPage.evaluate(async (cwd) => {
    window.sessionStorage.setItem('caogen.office.performance', '1')
    await window.agentDesk.createSession({
      cwd,
      engine: 'openai',
      providerId: 'office-background-provider',
      model: 'office-background-model',
      isolated: false,
      title: 'Office Background Agent'
    })
    await window.agentDesk.createProjectWorkspace({
      id: 'office-background-project',
      name: 'Office Background Budget Project',
      kind: 'software'
    })
  }, projectDir)
}

async function openOffice(targetPage) {
  await openControlRoom(targetPage)
  await targetPage.waitForSelector('.office-canvas-wrap', { visible: true, timeout: 20_000 })
  await targetPage.waitForFunction(
    () => typeof window.__caogenOfficePerformance?.snapshot === 'function' &&
      document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-frame-loop') === 'manual' &&
      (window.__caogenOfficePerformance?.readFrame().frame ?? 0) > 3,
    { timeout: 30_000 }
  )
  report.renderer = await targetPage.evaluate(() => window.__caogenOfficePerformance?.snapshot())
  await capture(targetPage, 'foreground-office')
}

async function measurePhase(name, taskIndex) {
  const processStart = await readProcessCpu()
  const taskStart = await readRendererTaskDuration()
  const frameStart = await readFrame()
  const started = Date.now()
  const task = await page.evaluate(async ({ index, projectId }) => {
    const id = `office-background-task-${index}`
    const taskStarted = performance.now()
    const created = await window.agentDesk.createProjectWorkItem({
      id,
      projectId,
      type: 'testing',
      title: `Background persistence task ${index}`,
      description: 'This canonical write must remain responsive while the Office renderer is paused.',
      status: 'backlog',
      owner: { type: 'human', id: 'office-background-owner', displayName: 'Local owner' }
    })
    const readback = await window.agentDesk.getProjectWorkItem(id)
    return {
      id,
      durationMs: performance.now() - taskStarted,
      persisted: readback?.id === created.id && readback?.revision === created.revision,
      revision: readback?.revision ?? 0
    }
  }, { index: taskIndex, projectId: 'office-background-project' })
  assert.equal(task.persisted, true, `${name} canonical WorkItem write did not read back`)
  const remaining = intervalMs - (Date.now() - started)
  if (remaining > 0) await delay(remaining)
  const elapsedMs = Date.now() - started
  const frameEnd = await readFrame()
  const taskEnd = await readRendererTaskDuration()
  const processEnd = await readProcessCpu()
  const processCpu = summarizeProcessCpu(processStart, processEnd, elapsedMs)
  return {
    name,
    elapsedMs,
    frameStart,
    frameEnd,
    frameDelta: frameEnd - frameStart,
    task,
    rendererTaskCpuPercent: percent(taskEnd - taskStart, elapsedMs),
    processCpu
  }
}

function assertPausedBudget(phase) {
  assert.ok(phase.frameDelta <= budgets.pausedFrameDeltaMaximum,
    `${phase.name} advanced ${phase.frameDelta} WebGL frames while paused`)
  assert.ok(phase.rendererTaskCpuPercent <= budgets.rendererTaskCpuPercentMaximum,
    `${phase.name} renderer TaskDuration CPU ${phase.rendererTaskCpuPercent.toFixed(2)}% exceeds ${budgets.rendererTaskCpuPercentMaximum}%`)
  assert.ok(phase.processCpu.gpu.percent <= budgets.gpuCpuPercentMaximum,
    `${phase.name} GPU process CPU ${phase.processCpu.gpu.percent.toFixed(2)}% exceeds ${budgets.gpuCpuPercentMaximum}%`)
  assert.ok(phase.processCpu.total.percent <= budgets.totalCpuPercentMaximum,
    `${phase.name} total Electron CPU ${phase.processCpu.total.percent.toFixed(2)}% exceeds ${budgets.totalCpuPercentMaximum}%`)
}

async function waitForRenderState(targetPage, active, previousFrame) {
  await targetPage.waitForFunction(
    ({ expectedActive, frame }) => {
      const office = document.querySelector('.office-canvas-wrap')
      const stateMatches = office?.getAttribute('data-office-render-active') === (expectedActive ? '1' : '0') &&
        office?.getAttribute('data-office-frame-loop') === (expectedActive ? 'manual' : 'paused')
      const currentFrame = window.__caogenOfficePerformance?.readFrame().frame ?? -1
      return stateMatches && (!expectedActive || frame === undefined || currentFrame > frame)
    },
    { timeout: 8_000 },
    { expectedActive: active, frame: previousFrame }
  )
  if (!active) await delay(250)
}

async function readFrame() {
  return page.evaluate(() => window.__caogenOfficePerformance?.readFrame().frame ?? -1)
}

async function readRendererTaskDuration() {
  const { metrics } = await pageSession.send('Performance.getMetrics')
  return Number(metrics.find((metric) => metric.name === 'TaskDuration')?.value ?? 0)
}

async function readProcessCpu() {
  const { processInfo } = await systemSession.send('SystemInfo.getProcessInfo')
  return processInfo.map((item) => ({
    id: item.id,
    type: String(item.type ?? 'unknown').toLowerCase(),
    cpuTime: Number(item.cpuTime ?? 0)
  }))
}

function summarizeProcessCpu(before, after, elapsedMs) {
  const startById = new Map(before.map((item) => [item.id, item]))
  const deltas = after.map((item) => ({
    id: item.id,
    type: item.type,
    cpuSeconds: Math.max(0, item.cpuTime - (startById.get(item.id)?.cpuTime ?? item.cpuTime))
  }))
  const summarize = (predicate) => {
    const items = deltas.filter(predicate)
    const cpuSeconds = items.reduce((sum, item) => sum + item.cpuSeconds, 0)
    return { processCount: items.length, cpuSeconds, percent: percent(cpuSeconds, elapsedMs) }
  }
  return {
    renderer: summarize((item) => item.type === 'renderer'),
    gpu: summarize((item) => item.type === 'gpu'),
    browser: summarize((item) => item.type === 'browser'),
    total: summarize(() => true),
    processes: deltas
  }
}

function percent(cpuSeconds, elapsedMs) {
  return elapsedMs > 0 ? (cpuSeconds * 100_000) / elapsedMs : 0
}

function launchElectron(port) {
  const child = spawn(electronBin, [`--remote-debugging-port=${port}`, mainEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userDataDir,
      CAOGEN_MEMORY_DIR: path.join(tempRoot, 'memory'),
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => undefined)
  child.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim()
    if (message && !message.includes('DevTools listening')) report.warnings.push(message)
  })
  return child
}

async function capture(targetPage, name) {
  const file = path.join(reportDir, `${name}.png`)
  await targetPage.screenshot({ path: file })
  return file
}

async function waitForApp(targetPage) {
  await targetPage.waitForFunction(
    () => document.readyState === 'complete' && document.querySelector('#root')?.childElementCount > 0 &&
      Boolean(document.querySelector('.app')),
    { timeout: 20_000 }
  )
}

async function waitForPage(targetBrowser, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pages = await targetBrowser.pages()
    const candidate = pages.find((entry) => entry.url().startsWith('file:') || entry.url().includes('localhost'))
    if (candidate) return candidate
    await delay(100)
  }
  throw new Error('renderer page did not appear')
}

async function findFreePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    if (await canListen(port)) return port
  }
  throw new Error('no free remote debugging port')
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function waitForDebugPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canConnect(port)) return
    await delay(100)
  }
  throw new Error(`remote debugging port ${port} did not open`)
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

async function terminate(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

function hostEnvironment() {
  return {
    platform: platform(),
    release: release(),
    arch: process.arch,
    node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem()
  }
}

function gitIdentity() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim()
  return { commit, worktreeClean: status.length === 0 }
}

function readSource(relativePath) {
  return execFileSync('sed', ['-n', '1,2000p', path.join(repoRoot, relativePath)], { encoding: 'utf8' })
}

function writeReport() {
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), serialized, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
}

function serializeError(error) {
  return { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.stack || error.message : String(error) }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
