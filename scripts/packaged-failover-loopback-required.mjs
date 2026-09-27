#!/usr/bin/env node
/**
 * Electron end-to-end failover smoke using two local synthetic OpenAI-compatible
 * Providers. The primary endpoint fails every generation request; the
 * configured fallback endpoint completes the same sentence. No external
 * network or private Provider configuration is used, and request bodies are
 * kept in memory only for assertions.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'

const repoRoot = path.resolve(process.env.CAOGEN_REPO_ROOT || process.cwd())
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const args = parseArgs(process.argv.slice(2))
const outputDir = path.join(repoRoot, 'test-results', 'packaged-failover-loopback')
const outputPath = path.join(outputDir, 'latest.json')
const checks = []
const requests = { primary: [], fallback: [] }
const report = {
  schemaVersion: 1,
  kind: 'eastgenesis.packaged-failover-loopback-report',
  gate: 'test:packaged-failover-loopback:required',
  status: 'failed',
  evidenceStrength: args.artifact ? 'packaged-renderer-failover-click-observed' : 'built-source-renderer-failover-click-observed',
  providerMode: 'local-synthetic-dual-loopback',
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
      console.log('Usage: node scripts/packaged-failover-loopback-required.mjs --source | --artifact PATH')
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
async function startProviderServer(kind, model, port, requestsForProvider) {
  const server = createServer(async (request, response) => {
    const body = request.method === 'POST' ? await readRequestBody(request) : ''
    let parsedBody = null
    if (body) { try { parsedBody = JSON.parse(body) } catch {} }
    requestsForProvider.push({ method: request.method, path: request.url, body: parsedBody })
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', owned_by: `eastgenesis-${kind}-test` }] }))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      if (kind === 'primary') {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
        response.end(JSON.stringify({ error: { message: 'synthetic primary rate limit', type: 'rate_limit_error', code: 'synthetic_primary_rate_limited' } }))
        return
      }
      const messages = Array.isArray(parsedBody?.messages) ? parsedBody.messages : []
      const last = messages.at(-1)
      const prompt = typeof last?.content === 'string' ? last.content : ''
      const content = `已自动切换备用模型并完成：${prompt || 'EastGenesis failover loopback'}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-eastgenesis-failover', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-eastgenesis-failover', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 18, completion_tokens: 10, total_tokens: 28 } })}\n\n`)
      response.end('data: [DONE]\n\n')
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'loopback route not found', type: 'not_found' } }))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return server
}
async function createProviderInQuickSetup(page, baseUrl, key, displayName) {
  await page.click('[data-provider-preset="custom"]')
  await page.waitForSelector('[data-provider-quick-field="base-url"]', { visible: true, timeout: 10_000 })
  await page.type('[data-provider-quick-field="base-url"]', baseUrl)
  await page.type('[data-provider-quick-field="api-key"]', key)
  await page.evaluate(() => {
    const details = document.querySelector('[data-provider-quick-connection-details]')
    if (details instanceof HTMLDetailsElement) details.open = true
  })
  await page.waitForSelector('[data-provider-quick-field="name"]', { visible: true, timeout: 10_000 })
  await page.$eval('[data-provider-quick-field="name"]', (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }, displayName)
  await page.click('[data-provider-quick-action="save"]')
  await page.waitForSelector('[data-provider-setup-receipt]', { visible: true, timeout: 25_000 })
  const providerId = await page.$eval('[data-provider-setup-receipt]', element => element.getAttribute('data-provider-setup-receipt'))
  await page.click('[data-provider-setup-action="done"]')
  return providerId
}

async function main() {
  await runCheck('built app inputs exist', () => {
    for (const entry of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
      check(existsSync(path.join(repoRoot, entry)), `missing ${entry}; run npm run build first`)
    }
  })
  await runCheck('source exposes fallback controls and direct assistant surface', () => {
    const settings = readFileSync(path.join(repoRoot, 'src/renderer/src/components/SettingsModal.tsx'), 'utf8')
    const app = readFileSync(path.join(repoRoot, 'src/renderer/src/components/AppListView.tsx'), 'utf8')
    check(settings.includes('data-settings-field="fallback-provider"') && settings.includes('data-settings-field="fallback-model"'), 'fallback controls are not addressable')
    check(app.includes('data-product-surface="conversation"') && app.includes('data-simple-workspace'), 'conversation surface is not mounted')
  })

  const primaryPort = await findFreePort()
  const fallbackPort = await findFreePort()
  const primaryServer = await startProviderServer('primary', 'eastgenesis-primary-model', primaryPort, requests.primary)
  const fallbackServer = await startProviderServer('fallback', 'eastgenesis-fallback-model', fallbackPort, requests.fallback)
  const userData = await mkdtemp(path.join(realpathSync(tmpdir()), 'eastgenesis-failover-loopback-'))
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
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    await page.waitForSelector('.app', { visible: true, timeout: 30_000 })

    await runCheck('first launch configures the primary Provider', async () => {
      await page.waitForSelector('.first-launch-onboarding', { visible: true, timeout: 30_000 })
      await page.click('.first-launch-onboarding .btn-primary')
      await page.waitForSelector('[data-provider-quick-setup]', { visible: true, timeout: 10_000 })
      await createProviderInQuickSetup(page, `http://127.0.0.1:${primaryPort}`, 'synthetic-primary-key', '主线路（合成）')
      await page.waitForSelector('.first-launch-onboarding', { hidden: true, timeout: 10_000 })
      check(requests.primary.some(item => item.method === 'GET' && item.path === '/v1/models'), 'primary model discovery did not reach the loopback Provider')
    })
    const primaryProviderId = await page.evaluate(async () => {
      const providers = await window.agentDesk.listProviders()
      return providers.find(provider => provider.name.includes('主线路'))?.id ?? providers[0]?.id ?? ''
    })
    check(primaryProviderId, 'primary Provider was not selected after first setup')
    await page.evaluate((id) => { window.__eastgenesisPrimaryProviderId = id }, primaryProviderId)

    await runCheck('settings adds a fallback Provider', async () => {
      await page.click('[data-sidebar-action="personal-menu"]')
      await page.click('[data-sidebar-action="settings"]')
      await page.waitForSelector('.settings-page', { visible: true, timeout: 10_000 })
      await page.click('[data-settings-tab="providers"]')
      await page.waitForSelector('[data-provider-add]', { visible: true, timeout: 10_000 })
      await page.click('[data-provider-add]')
      await page.waitForSelector('[data-provider-quick-setup]', { visible: true, timeout: 10_000 })
      const fallbackProviderId = await createProviderInQuickSetup(page, `http://127.0.0.1:${fallbackPort}`, 'synthetic-fallback-key', '备用线路（合成）')
      await page.waitForSelector('[data-provider-add]', { visible: true, timeout: 10_000 })
      check(requests.fallback.some(item => item.method === 'GET' && item.path === '/v1/models'), 'fallback model discovery did not reach the loopback Provider')
      await page.evaluate(async ({ primaryId, fallbackId }) => {
        for (const [providerId, model] of [[primaryId, 'eastgenesis-primary-model'], [fallbackId, 'eastgenesis-fallback-model']]) {
          await window.agentDesk.updateProvider(providerId, {
            advancedConfig: {
              schemaVersion: 1,
              modelProfiles: [{
                model,
                // Give the primary a deterministic routing advantage in this
                // local fixture; the fallback remains fully tool-capable.
                capabilities: model.includes('primary')
                  ? ['text', 'tools', 'reasoning', 'coding', 'summarization', 'longcontext']
                  : ['text', 'tools'],
                pricing: model.includes('primary')
                  ? { currency: 'USD', inputPerMillion: 0.1, outputPerMillion: 0.2, source: 'user' }
                  : { currency: 'USD', inputPerMillion: 100, outputPerMillion: 100, source: 'user' },
                contextWindow: 128000
              }]
            }
          })
        }
      }, { primaryId: await page.evaluate(() => window.__eastgenesisPrimaryProviderId), fallbackId: fallbackProviderId })
      await page.evaluate((id) => { window.__eastgenesisFallbackProviderId = id }, fallbackProviderId)
    })

    await runCheck('settings bind the fallback route without exposing credentials', async () => {
      await page.click('[data-settings-tab="models"]')
      await page.waitForSelector('[data-settings-field="fallback-provider"]', { timeout: 10_000 })
      await page.evaluate(() => { const details = document.querySelector('[data-models-advanced]'); if (details instanceof HTMLDetailsElement) details.open = true })
      const fallbackProviderId = await page.evaluate(() => window.__eastgenesisFallbackProviderId)
      check(typeof fallbackProviderId === 'string' && fallbackProviderId.length > 0, 'fallback Provider identity was not retained')
      await page.waitForFunction((id) => [...document.querySelectorAll('[data-settings-field="fallback-provider"] option')].some(option => option.value === id), {}, fallbackProviderId)
      await page.select('[data-settings-field="fallback-provider"]', fallbackProviderId)
      await page.waitForFunction(() => [...document.querySelectorAll('[data-settings-field="fallback-model"] option')].some(option => option.value === 'eastgenesis-fallback-model'), {},)
      await page.select('[data-settings-field="fallback-model"]', 'eastgenesis-fallback-model')
      const enabled = await page.$eval('[data-settings-field="failover-enabled"]', element => element.checked)
      if (!enabled) await page.click('[data-settings-field="failover-enabled"]')
      await page.waitForSelector('.settings-page-actions .btn-primary', { visible: true, timeout: 10_000 })
      await page.click('.settings-page-actions .btn-primary')
      await page.waitForSelector('.settings-page', { hidden: true, timeout: 15_000 })
      check(Boolean(fallbackProviderId), 'fallback Provider selection did not resolve')
      const persistedSettings = await page.evaluate(() => window.agentDesk.getSettings())
      check(persistedSettings.fallbackProviderId === fallbackProviderId, 'fallback Provider was not persisted in the settings domain')
      check(persistedSettings.fallbackModel === 'eastgenesis-fallback-model', 'fallback model was not persisted in the settings domain')
      check(persistedSettings.failoverEnabled === true, 'failover was not enabled in the settings domain')
    })

    await runCheck('primary failure switches Provider and preserves the sentence context', async () => {
      await page.waitForSelector('.welcome-composer-input', { visible: true, timeout: 10_000 })
      // Provider-scoped sessions intentionally cannot cross a Provider
      // boundary. Switch the draft to global AUTO routing so the configured
      // fallback is part of this turn's frozen recovery catalog.
      await page.evaluate((primaryId) => {
        const key = 'caogen.welcome-draft.v1'
        const current = JSON.parse(window.localStorage.getItem(key) || '{}')
        const draft = { ...(current.draft || {}), computeSelectionSource: 'user', routingMode: 'global', providerId: primaryId, model: 'auto' }
        window.localStorage.setItem(key, JSON.stringify({ schemaVersion: 5, draft }))
        window.location.reload()
      }, primaryProviderId)
      await page.waitForSelector('.welcome-composer-input', { visible: true, timeout: 30_000 })
      const prompt = '请在主模型失败后继续完成这项工作'
      await page.type('.welcome-composer-input', prompt)
      await page.waitForFunction(() => {
        const button = document.querySelector('.welcome-send')
        return button instanceof HTMLButtonElement && !button.disabled
      }, { timeout: 10_000 })
      await page.click('.welcome-send')
      try {
        await page.waitForSelector('.chat', { visible: true, timeout: 45_000 })
      } catch (error) {
        const state = await page.evaluate(() => ({
          body: document.body.textContent?.slice(-1800),
          welcome: document.querySelector('[data-simple-workspace]')?.textContent?.slice(-900),
          buttons: [...document.querySelectorAll('button')].filter(button => getComputedStyle(button).display !== 'none').map(button => ({ text: button.textContent?.trim(), disabled: button instanceof HTMLButtonElement ? button.disabled : false })).slice(-16)
        }))
        throw new Error(`${error instanceof Error ? error.message : String(error)}; ui=${JSON.stringify(state)}`)
      }
      await page.waitForFunction(() => [...document.querySelectorAll('.msg-assistant .assistant-text')].some(node => node.textContent?.includes('已自动切换备用模型并完成')), { timeout: 45_000 })
      const fallbackRequest = requests.fallback.find(item => item.method === 'POST' && item.path === '/v1/chat/completions')
      check(requests.primary.some(item => item.method === 'POST' && item.path === '/v1/chat/completions'), 'primary generation failure was not observed')
      check(fallbackRequest, 'fallback generation request was not observed')
      const serializedMessages = JSON.stringify(fallbackRequest.body?.messages ?? [])
      check(serializedMessages.includes(prompt), 'fallback request did not preserve the original sentence context')
      await page.waitForSelector('[data-assistant-routing-status="failover"]', { visible: true, timeout: 10_000 })
    })
    report.status = 'passed'
    report.requestPaths = {
      primary: requests.primary.map(item => `${item.method} ${item.path}`),
      fallback: requests.fallback.map(item => `${item.method} ${item.path}`)
    }
  } finally {
    try { if (browser) await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 1_000))]) } catch {}
    await stop(child)
    await rm(userData, { recursive: true, force: true })
    await Promise.all([new Promise(resolve => primaryServer.close(resolve)), new Promise(resolve => fallbackServer.close(resolve))])
  }
}

try { await main() } catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
  report.requestPaths = {
    primary: requests.primary.map(item => `${item.method} ${item.path}`),
    fallback: requests.fallback.map(item => `${item.method} ${item.path}`)
  }
  console.error(`[FAIL] packaged failover loopback: ${report.error}`)
}
report.checks = checks
report.finishedAt = new Date().toISOString()
mkdirSync(outputDir, { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`packaged failover loopback: ${report.status}`)
console.log(`report: ${outputPath}`)
process.exit(report.status === 'passed' ? 0 : 1)
