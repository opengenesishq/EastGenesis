#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'
import { openControlRoom } from './lib/open-control-room.mjs'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/gu, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'accessibility')
const reportDir = path.join(reportRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-accessibility-'))
const electronBin = require('electron')
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const report = {
  schemaVersion: 1,
  status: 'failed',
  gate: 'test:accessibility:required',
  runId,
  startedAt,
  surfaces: [],
  screenshots: [],
  errors: []
}
let electron
let browser
let page

mkdirSync(reportDir, { recursive: true })

try {
  const port = await findFreePort(9910)
  electron = launchElectron(port)
  await waitForDebugPort(port, 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
  page = await waitForPage(browser, 20_000)
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
  await waitForApp(page)
  await createProjectFixture(page)

  await auditSurface('assistant', '[data-experience-mode="assistant"], .app-shell')
  await click(page, '[data-experience-mode-option="studio"]')
  await page.waitForSelector('[data-studio-view]', { visible: true, timeout: 15_000 })
  await page.waitForSelector('[data-project-workspace-studio]', { visible: true, timeout: 15_000 })
  await auditSurface('studio-list', '[data-project-workspace-studio]')

  await click(page, '[data-view-option="board"]')
  await page.waitForSelector('.pws-board', { visible: true, timeout: 8_000 })
  assert.equal(await page.$eval('[data-work-item-id="accessibility-waiting"]', (node) => {
    const status = node.querySelector('.pws-status-waiting_approval')
    return status?.textContent?.trim() === '待批准'
  }), true)
  await auditSurface('studio-board-waiting-approval', '[data-project-workspace-studio]')

  await click(page, '.studio-section-switcher button:nth-child(2)')
  await page.waitForSelector('[data-studio-surface="digital-workers"]', { visible: true, timeout: 15_000 })
  await auditSurface('studio-team', '[data-studio-surface="digital-workers"]')

  await openControlRoom(page)
  await page.waitForSelector('.office', { visible: true, timeout: 15_000 })
  await auditSurface('office', '.office')

  report.status = 'passed'
} catch (error) {
  report.errors.push(serializeError(error))
  if (page) await capture('failure').catch(() => undefined)
  console.error(error)
  process.exitCode = 1
} finally {
  if (browser) await browser.disconnect().catch(() => undefined)
  if (electron) await terminate(electron)
  report.finishedAt = new Date().toISOString()
  report.git = gitIdentity()
  writeReport()
  rmSync(tempRoot, { recursive: true, force: true })
  console.log(`accessibility required gate: ${report.status} (${report.surfaces.length} surfaces)`)
}

async function auditSurface(name, selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 10_000 })
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await waitForFocusableInventoryStable(selector)
    const dom = await inspectSurfaceDom(selector)
    const ax = await auditAccessibilityTree(selector)
    const keyboard = await auditKeyboardTraversal(selector)
    if (keyboard.expected !== dom.keyboardFocusableCount || keyboard.expectedAfterTraversal !== keyboard.expected) continue
    assert.ok(dom.interactiveCount > 0, `${name} has no visible interactive controls`)
    assert.deepEqual(dom.unnamed, [], `${name} has unnamed controls`)
    assert.deepEqual(dom.positiveTabIndex, [], `${name} uses positive tabindex`)
    assert.deepEqual(dom.hiddenFocusable, [], `${name} has aria-hidden focus targets`)
    assert.deepEqual(ax.unnamedFocusable, [], `${name} AX tree has unnamed focusable nodes`)
    const screenshot = await capture(name)
    report.surfaces.push({ name, dom, ax, keyboard, screenshot })
    assert.deepEqual(keyboard.unnamedOrInvisible, [], `${name} keyboard target is unnamed or invisible`)
    assert.deepEqual(keyboard.missingFocusVisible, [], `${name} keyboard target lacks a visible focus treatment`)
    assert.equal(keyboard.visited, keyboard.expected, `${name} keyboard traversal did not reach every focusable control`)
    return
  }
  throw new Error(`${name} keyboard focus inventory did not settle during audit`)
}

async function inspectSurfaceDom(selector) {
  return page.evaluate((rootSelector) => {
    const root = document.querySelector(rootSelector)
    if (!root) throw new Error(`surface root is missing: ${rootSelector}`)
    const all = [...root.querySelectorAll('button,input,select,textarea,summary,a[href],[role="button"],[tabindex]')]
    const visible = all.filter((element) => {
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      const closedDetails = element.closest('details:not([open])')
      const summary = closedDetails?.querySelector(':scope > summary')
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && (!closedDetails || Boolean(summary?.contains(element)))
    })
    const records = visible.map((element) => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') ?? '',
      name: accessibleName(element),
      tabIndex: element.tabIndex,
      ariaHidden: element.getAttribute('aria-hidden'),
      disabled: 'disabled' in element && element.disabled === true
    }))
    return {
      interactiveCount: records.length,
      keyboardFocusableCount: records.filter((record) => record.tabIndex >= 0 && !record.disabled && record.ariaHidden !== 'true').length,
      unnamed: records.filter((record) => !record.name && record.ariaHidden !== 'true' && record.tabIndex >= 0),
      positiveTabIndex: records.filter((record) => record.tabIndex > 0),
      hiddenFocusable: records.filter((record) => record.ariaHidden === 'true' && record.tabIndex >= 0),
      waitingApprovalText: root.textContent?.includes('waiting_approval') || root.textContent?.includes('等待审批') ||
        root.textContent?.includes('待批准') || false,
      failedText: root.textContent?.includes('failed') || root.textContent?.includes('失败') || false
    }

    function accessibleName(element) {
      const labelledBy = element.getAttribute('aria-labelledby')
      const labelledText = labelledBy?.split(/\s+/u)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ')
      if (labelledText) return labelledText
      const explicit = element.getAttribute('aria-label')?.trim()
      if (explicit) return explicit
      if (element.id) {
        const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent?.trim()
        if (label) return label
      }
      return element.textContent?.trim() || element.getAttribute('title')?.trim() ||
        element.getAttribute('placeholder')?.trim() || element.getAttribute('alt')?.trim() || ''
    }
  }, selector)
}

async function waitForFocusableInventoryStable(selector) {
  let previous = -1
  let stableSamples = 0
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const current = await page.evaluate((rootSelector) => {
      const root = document.querySelector(rootSelector)
      if (!root) return -1
      return [...root.querySelectorAll('button,input,select,textarea,summary,a[href],[role="button"],[tabindex]')]
        .filter((element) => {
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          const disabled = 'disabled' in element && element.disabled === true
          const closedDetails = element.closest('details:not([open])')
          const summary = closedDetails?.querySelector(':scope > summary')
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && (!closedDetails || Boolean(summary?.contains(element))) &&
            element.tabIndex >= 0 && !disabled && element.getAttribute('aria-hidden') !== 'true'
        }).length
    }, selector)
    stableSamples = current === previous ? stableSamples + 1 : 0
    if (stableSamples >= 2) return
    previous = current
    await delay(100)
  }
  throw new Error(`focusable inventory did not stabilize: ${selector}`)
}

async function auditAccessibilityTree(selector) {
  const focusableRoles = new Set(['button', 'checkbox', 'combobox', 'link', 'menuitem', 'radio', 'switch', 'tab', 'textbox'])
  const handles = await page.$$(`${selector} :is(button,input,select,textarea,summary,a[href],[role="button"],[role="tab"])`)
  const nodes = []
  const unnamedFocusable = []
  for (const handle of handles) {
    const visible = await handle.evaluate((element) => {
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 &&
        element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true'
    })
    if (!visible) continue
    const tree = await page.accessibility.snapshot({ root: handle, interestingOnly: false })
    const root = tree ? [tree, ...(tree.children ?? []).flatMap(flattenAccessibilityTree)] : []
    nodes.push(...root)
    for (const node of root) {
      if (focusableRoles.has(node.role) && !String(node.name ?? '').trim()) {
        unnamedFocusable.push({ role: node.role, name: node.name ?? '', value: node.value ?? '' })
      }
    }
  }
  return { nodeCount: nodes.length, unnamedFocusable }
}

function flattenAccessibilityTree(root) {
  if (!root) return []
  return [root, ...(root.children ?? []).flatMap(flattenAccessibilityTree)]
}

async function auditKeyboardTraversal(selector) {
  const expected = await page.evaluate((rootSelector) => {
    const root = document.querySelector(rootSelector)
    if (!root) throw new Error(`surface root is missing: ${rootSelector}`)
    document.querySelector('[data-accessibility-traversal-sentinel]')?.remove()
    const sentinel = document.createElement('span')
    sentinel.tabIndex = 0
    sentinel.dataset.accessibilityTraversalSentinel = 'true'
    sentinel.setAttribute('aria-hidden', 'true')
    sentinel.style.position = 'fixed'
    sentinel.style.width = '1px'
    sentinel.style.height = '1px'
    sentinel.style.opacity = '0'
    root.before(sentinel)
    sentinel.focus()
    return [...root.querySelectorAll('button,input,select,textarea,summary,a[href],[role="button"],[tabindex]')]
      .filter((element) => {
        const style = window.getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        const disabled = 'disabled' in element && element.disabled === true
        const closedDetails = element.closest('details:not([open])')
        const summary = closedDetails?.querySelector(':scope > summary')
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && (!closedDetails || Boolean(summary?.contains(element))) &&
          element.tabIndex >= 0 && !disabled && element.getAttribute('aria-hidden') !== 'true'
      }).length
  }, selector)
  const visits = []
  for (let index = 0; index < Math.max(1, expected + 1); index += 1) {
    await page.keyboard.press('Tab')
    const visit = await page.evaluate((rootSelector) => {
    const element = document.activeElement
    const root = document.querySelector(rootSelector)
    if (!(element instanceof HTMLElement) || !root?.contains(element)) return null
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      const named = element.getAttribute('aria-label') || element.textContent?.trim() ||
        element.getAttribute('title') || element.getAttribute('placeholder') || ''
      const focusVisible = style.outlineStyle !== 'none' || style.boxShadow !== 'none' ||
        style.borderColor !== 'rgba(0, 0, 0, 0)'
      const focusables = [...root.querySelectorAll('button,input,select,textarea,summary,a[href],[role="button"],[tabindex]')]
        .filter((candidate) => {
          const candidateStyle = window.getComputedStyle(candidate)
          const candidateRect = candidate.getBoundingClientRect()
          const disabled = 'disabled' in candidate && candidate.disabled === true
          const closedDetails = candidate.closest('details:not([open])')
          const summary = closedDetails?.querySelector(':scope > summary')
          return candidateStyle.display !== 'none' && candidateStyle.visibility !== 'hidden' && candidateRect.width > 0 && candidateRect.height > 0 && (!closedDetails || Boolean(summary?.contains(candidate))) && candidate.tabIndex >= 0 && !disabled && candidate.getAttribute('aria-hidden') !== 'true'
        })
      return { tag: element.tagName.toLowerCase(), name: named, width: rect.width, height: rect.height, focusVisible, focusIndex: focusables.indexOf(element) }
    }, selector)
    if (visit) visits.push(visit)
    else if (visits.length > 0 || expected === 0) break
  }
  const expectedAfterTraversal = await page.evaluate((rootSelector) => {
    const root = document.querySelector(rootSelector)
    if (!root) throw new Error(`surface root is missing: ${rootSelector}`)
    return [...root.querySelectorAll('button,input,select,textarea,summary,a[href],[role="button"],[tabindex]')]
      .filter((element) => {
        const style = window.getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        const disabled = 'disabled' in element && element.disabled === true
        const closedDetails = element.closest('details:not([open])')
        const summary = closedDetails?.querySelector(':scope > summary')
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && (!closedDetails || Boolean(summary?.contains(element))) &&
          element.tabIndex >= 0 && !disabled && element.getAttribute('aria-hidden') !== 'true'
      }).length
  }, selector)
  await page.evaluate(() => document.querySelector('[data-accessibility-traversal-sentinel]')?.remove())
  return {
    expected,
    expectedAfterTraversal,
    visited: new Set(visits.map((visit) => visit.focusIndex)).size,
    uniqueNames: new Set(visits.map((visit) => visit.name)).size,
    targets: visits.map(({ tag, name, focusIndex }) => ({ tag, name, focusIndex })),
    unnamedOrInvisible: visits.filter((visit) => !visit.name || visit.width <= 0 || visit.height <= 0),
    missingFocusVisible: visits.filter((visit) => !visit.focusVisible)
  }
}

async function createProjectFixture(targetPage) {
  await targetPage.evaluate(async () => {
    await window.agentDesk.createProjectWorkspace({
      id: 'accessibility-project',
      name: 'Accessibility Project',
      kind: 'software'
    })
    await window.agentDesk.createProjectWorkItem({
      id: 'accessibility-waiting',
      projectId: 'accessibility-project',
      type: 'review',
      title: 'Review keyboard and screen reader coverage',
      description: 'Approval state must remain legible without color.',
      status: 'waiting_approval',
      owner: { type: 'human', id: 'local-user', displayName: 'Local user' }
    })
  })
}

function launchElectron(port) {
  const child = spawn(electronBin, [`--remote-debugging-port=${port}`, mainEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: path.join(tempRoot, 'user-data'),
      CAOGEN_MEMORY_DIR: path.join(tempRoot, 'memory'),
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim()
    if (message && !message.includes('DevTools listening')) report.errors.push({ name: 'ElectronStderr', message })
  })
  return child
}

async function capture(name) {
  const file = path.join(reportDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  report.screenshots.push(file)
  return file
}

async function click(targetPage, selector) {
  await targetPage.waitForSelector(selector, { visible: true, timeout: 10_000 })
  await targetPage.click(selector)
}

async function waitForApp(targetPage) {
  await targetPage.waitForFunction(
    () => document.readyState === 'complete' && document.querySelector('#root')?.childElementCount > 0,
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

function gitIdentity() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim()
  return { commit, worktreeClean: status.length === 0 }
}

function writeReport() {
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), serialized, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
}

function serializeError(error) {
  return { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
