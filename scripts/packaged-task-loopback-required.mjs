#!/usr/bin/env node
/**
 * Packaged Electron end-to-end smoke for the one-sentence task loop.
 *
 * This deliberately uses a local, synthetic OpenAI-compatible HTTP server. It
 * proves the user-visible path (first-launch setup -> model discovery -> save
 * -> send -> assistant result) without reading private Provider config or
 * calling an external service.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'

const repoRoot = path.resolve(process.env.CAOGEN_REPO_ROOT || process.cwd())
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const args = parseArgs(process.argv.slice(2))
const outputDir = path.join(repoRoot, 'test-results', 'packaged-task-loopback')
const outputPath = path.join(outputDir, 'latest.json')
const checks = []
const requests = []
const report = {
  schemaVersion: 1,
  kind: 'eastgenesis.packaged-task-loopback-report',
  gate: 'test:packaged-task-loopback:required',
  status: 'failed',
  evidenceStrength: args.artifact ? 'packaged-renderer-loopback-click-observed' : 'built-source-renderer-loopback-click-observed',
  providerMode: 'local-synthetic-loopback',
  externalNetwork: false,
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
      console.log('Usage: node scripts/packaged-task-loopback-required.mjs --source | --artifact PATH')
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
function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}
async function startLoopbackServer() {
  const server = createServer(async (request, response) => {
    const body = request.method === 'POST' ? await readRequestBody(request) : ''
    // Keep the request payload in memory only.  It is needed to distinguish the
    // initial model turn from the tool-result continuation; it is never written
    // to the report, so this gate cannot become a credential/config capture.
    requests.push({ method: request.method, path: request.url, hasBody: Boolean(body), body })
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'eastgenesis-loopback-model', object: 'model', owned_by: 'eastgenesis-test' }] }))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      let parsed = {}
      try { parsed = JSON.parse(body) } catch {}
      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      const hasToolResult = messages.some((message) => message?.role === 'tool')
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
      if (!hasToolResult) {
        const args = JSON.stringify({
          title: 'EastGenesis 办公闭环摘要',
          path: 'eastgenesis-office-loopback.docx',
          headings: ['今日工作'],
          paragraphs: ['synthetic Provider 生成的可打开 Word 交付物。', '由一句话任务闭环验证。']
        })
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-eastgenesis-office-tool', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_office_loopback', type: 'function', function: { name: 'create_document', arguments: args } }] }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-eastgenesis-office-tool', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } })}\n\n`)
      } else {
        const tool = messages.at(-1)
        const output = typeof tool?.content === 'string' ? tool.content : ''
        const content = `已完成办公交付：${output}`
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-eastgenesis-office-final', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-eastgenesis-office-final', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } })}\n\n`)
      }
      response.end('data: [DONE]\n\n')
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'loopback route not found', type: 'not_found' } }))
  })
  const port = await findFreePort()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return { server, port }
}

async function main() {
  await runCheck('built app inputs exist', () => {
    for (const entry of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
      check(existsSync(path.join(repoRoot, entry)), `missing ${entry}; run npm run build first`)
    }
  })
  await runCheck('source contract exposes the direct assistant surface', () => {
    const app = readFileSync(path.join(repoRoot, 'src/renderer/src/components/AppListView.tsx'), 'utf8')
    const welcome = readFileSync(path.join(repoRoot, 'src/renderer/src/components/WelcomeView.tsx'), 'utf8')
    check(app.includes('data-product-surface="conversation"') && app.includes('data-simple-workspace'), 'conversation surface is not mounted')
    check(welcome.includes('data-welcome-heading') && welcome.includes('data-composer-autosize'), 'one-sentence composer is not mounted')
  })

  const { server, port: providerPort } = await startLoopbackServer()
  const userData = await mkdtemp(path.join(realpathSync(tmpdir()), 'eastgenesis-task-loopback-'))
  const debugPort = await findFreePort()
  const electronBin = require('electron')
  const executable = args.artifact ? executableForArtifact(args.artifact) : electronBin
  const launchArgs = args.artifact
    ? [`--remote-debugging-port=${debugPort}`, '--user-data-dir', userData]
    : [`--remote-debugging-port=${debugPort}`, path.join(repoRoot, 'out', 'main', 'index.js')]
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
  try {
    await waitForDebugPort(debugPort)
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}`, defaultViewport: null })
    const page = await waitForPage(browser)
    const rendererDiagnostics = []
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') rendererDiagnostics.push(`${message.type()}: ${message.text()}`)
    })
    page.on('pageerror', error => rendererDiagnostics.push(`pageerror: ${error instanceof Error ? error.message : String(error)}`))
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    await page.waitForSelector('.app', { visible: true, timeout: 30_000 })
    await runCheck('first launch offers inline model setup', async () => {
      await page.waitForSelector('.first-launch-onboarding', { visible: true, timeout: 30_000 })
      await page.click('.first-launch-onboarding .btn-primary')
      await page.waitForSelector('[data-provider-quick-setup]', { visible: true, timeout: 10_000 })
    })
    await runCheck('model discovery and save use the local synthetic Provider', async () => {
      await page.click('[data-provider-preset="custom"]')
      await page.waitForSelector('[data-provider-quick-field="base-url"]', { visible: true, timeout: 10_000 })
      await page.type('[data-provider-quick-field="base-url"]', `http://127.0.0.1:${providerPort}`)
      await page.type('[data-provider-quick-field="api-key"]', 'synthetic-loopback-key')
      await page.click('[data-provider-quick-action="save"]')
      await page.waitForSelector('[data-provider-setup-receipt]', { visible: true, timeout: 20_000 })
      check(requests.some(item => item.method === 'GET' && item.path === '/v1/models'), 'model discovery did not reach the loopback Provider')
      await page.click('[data-provider-setup-action="done"]')
      await page.waitForSelector('.first-launch-onboarding', { hidden: true, timeout: 10_000 })
    })
    await runCheck('one sentence reaches the Provider and renders a result', async () => {
      const input = '.welcome-composer-input'
      await page.waitForSelector(input, { visible: true, timeout: 10_000 })
      const routingSurface = await page.$eval('[data-welcome-routing-control="model"]', element => ({
        value: element instanceof HTMLSelectElement ? element.value : '',
        options: element instanceof HTMLSelectElement ? [...element.options].map(option => option.value) : []
      }))
      check(routingSurface.options.includes('auto'), 'connected welcome surface hides the automatic routing option')
      check(routingSurface.value === 'auto', `automatic routing is not the visible default: ${routingSurface.value}`)
      await page.type(input, '请把今天的工作整理成三条要点')
      await page.waitForFunction(() => {
        const button = document.querySelector('.welcome-send')
        return button instanceof HTMLButtonElement && !button.disabled
      }, { timeout: 10_000 })
      await page.click('.welcome-send')
      try {
        await page.waitForSelector('.chat', { visible: true, timeout: 20_000 })
      } catch (error) {
        const state = await page.evaluate(async () => ({
          welcome: document.querySelector('[data-simple-workspace]')?.textContent?.slice(-600),
          body: document.body.textContent?.slice(-1200),
          notices: [...document.querySelectorAll('[role="alert"], .welcome-error, .assistant-start-notice')].map(node => node.textContent?.trim()).filter(Boolean),
          providers: typeof window.agentDesk?.listProviders === 'function' ? (await window.agentDesk.listProviders()).map(item => ({ id: item.id, ready: item.ready, hasToken: item.hasToken, engine: item.engine, models: item.models })) : [],
          sessions: typeof window.agentDesk?.listSessions === 'function' ? (await window.agentDesk.listSessions()).map(item => ({ id: item.id, status: item.status, title: item.title, model: item.model, providerId: item.providerId, routingScope: item.routingScope, engine: item.engine })) : [],
          buttons: [...document.querySelectorAll('button')].filter(button => getComputedStyle(button).display !== 'none').map(button => ({ text: button.textContent?.trim(), disabled: (button instanceof HTMLButtonElement) ? button.disabled : false })).slice(-12)
        }))
        const diagnostics = rendererDiagnostics.length ? `; renderer=${rendererDiagnostics.join(' | ')}` : ''
        throw new Error(`${error instanceof Error ? error.message : String(error)}; ui=${JSON.stringify(state)}${diagnostics}`)
      }
      await page.waitForFunction(() => [...document.querySelectorAll('.msg-assistant .assistant-text')].some(node => node.textContent?.includes('已完成办公交付')), { timeout: 45_000 })
      check(requests.some(item => item.method === 'POST' && item.path === '/v1/chat/completions'), 'task request did not reach the loopback Provider')
      const assistantText = await page.$$eval('.msg-assistant .assistant-text', nodes => nodes.map(node => node.textContent || '').join('\n'))
      check(assistantText.includes('已完成办公交付'), 'assistant result was not rendered')

      // Verify the physical Office output before the temporary profile is torn
      // down.  The artifact must be a non-empty OOXML ZIP and must be created
      // exactly once by the approved tool call.
      const artifactCandidates = []
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (entry.name === 'eastgenesis-office-loopback.docx') artifactCandidates.push(full)
        }
      }
      walk(userData)
      check(artifactCandidates.length === 1, `Office artifact was not written exactly once: ${artifactCandidates.length}`)
      const artifactBytes = readFileSync(artifactCandidates[0])
      check(artifactBytes.subarray(0, 2).toString() === 'PK', 'generated DOCX is not an OOXML ZIP')
      check(artifactBytes.byteLength > 1_000, 'generated DOCX is unexpectedly empty')

      // Open the actual Result/Artifacts surface and assert that the canonical
      // delivery is visible and openable from the workbench, rather than only
      // trusting the assistant transcript.
      await page.click('.header-more > button')
      await page.click('[data-header-action="result"]')
      await page.waitForSelector('[data-studio-result-panel]', { visible: true, timeout: 20_000 })
      await page.waitForSelector('[data-studio-result-tab="artifacts"]', { visible: true, timeout: 20_000 })
      await page.click('[data-studio-result-tab="artifacts"]')
      await page.waitForSelector('[data-studio-result-current-artifacts]', { visible: true, timeout: 20_000 })
      const artifactPanelText = await page.$eval('[data-studio-result-current-artifacts]', node => node.textContent || '')
      check(/办公闭环摘要|eastgenesis-office-loopback\.docx/i.test(artifactPanelText), 'result panel did not show the generated Office artifact')
      const openArtifact = await page.$('[data-studio-result-current-artifacts] .studio-result-location button')
      check(openArtifact, 'result panel did not expose an Open action for the generated Office artifact')
      await openArtifact.click()
      await page.waitForSelector('.preview-panel', { visible: true, timeout: 20_000 })
      const previewText = await page.$eval('.preview-panel', node => node.textContent || '')
      check(/eastgenesis-office-loopback\.docx/i.test(previewText), 'Open action did not load the generated Office artifact in preview')
      report.officeArtifact = {
        path: artifactCandidates[0],
        bytes: artifactBytes.byteLength,
        sha256: require('node:crypto').createHash('sha256').update(artifactBytes).digest('hex')
      }
    })
    report.status = 'passed'
    report.requestPaths = requests.map(item => `${item.method} ${item.path}`)
  } finally {
    try { if (browser) await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 1_000))]) } catch {}
    await stop(child)
    await rm(userData, { recursive: true, force: true })
    await new Promise(resolve => server.close(resolve))
  }
}

try { await main() } catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
  report.requestPaths = requests.map(item => `${item.method} ${item.path}`)
  console.error(`[FAIL] packaged task loopback: ${report.error}`)
}
report.checks = checks
report.finishedAt = new Date().toISOString()
mkdirSync(outputDir, { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`packaged task loopback: ${report.status}`)
console.log(`report: ${outputPath}`)
process.exit(report.status === 'passed' ? 0 : 1)
