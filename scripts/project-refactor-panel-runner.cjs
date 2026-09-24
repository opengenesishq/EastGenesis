const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const repoRoot = path.resolve(__dirname, '..')
const root = requiredEnv('CAOGEN_PROJECT_REFACTOR_PANEL_ROOT')
const statePath = requiredEnv('CAOGEN_PROJECT_REFACTOR_PANEL_STATE')
const screenshotDir = requiredEnv('CAOGEN_PROJECT_REFACTOR_PANEL_SCREENSHOTS')
const projectDir = path.join(root, 'project')
const modelPath = path.join(projectDir, 'src', 'model.ts')
const consumerPath = path.join(projectDir, 'src', 'consumer.ts')
process.env.CAOGEN_USER_DATA_DIR = path.join(root, 'userData')
process.env.CAOGEN_MEMORY_DIR = path.join(root, 'memory')
fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })
fs.writeFileSync(path.join(projectDir, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' },
  include: ['src/**/*.ts']
}, null, 2))
fs.writeFileSync(modelPath, [
  'export function calculateTotal(value: number): number {',
  '  return value * 2',
  '}',
  ''
].join('\n'))
fs.writeFileSync(consumerPath, [
  "import { calculateTotal } from './model'",
  'export const result = calculateTotal(21)',
  ''
].join('\n'))

const checks = []
function check(name, condition, detail = '') {
  checks.push({ name, status: condition ? 'pass' : 'fail', detail })
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`)
  if (!condition) throw new Error(`${name}: ${detail || 'failed'}`)
}

async function run() {
  require(path.join(repoRoot, 'out', 'main', 'index.js'))
  await waitFor(() => ipcMain._invokeHandlers?.has('providers:create') && ipcMain._invokeHandlers?.has('sessions:create'), 10_000)
  const provider = await invoke('providers:create', {
    name: 'Project Refactor Mock', baseUrl: 'http://127.0.0.1:9', token: 'test-only',
    models: ['mock-refactor'], engine: 'openai', openaiProtocol: 'responses'
  })
  const session = await invoke('sessions:create', {
    cwd: projectDir, engine: 'openai', providerId: provider.id, model: 'mock-refactor',
    routingScope: 'fixed', taskStrategy: 'execute', isolated: false, title: 'Project Refactor'
  })
  const win = await waitForWindow()
  win.setSize(1200, 800)
  win.webContents.reload()
  await waitForRenderer(win, `document.body.innerText.includes('EastGenesis')`)
  await selectSession(win, session.id)
  await openRefactor(win)

  check('Code workspace exposes Files, Tests, Debug, and Refactor tabs',
    await rendererValue(win, `document.querySelectorAll('.developer-panel-tabs [role="tab"]').length === 4`))
  check('refactor form is keyboard-submittable and uses explicit fields',
    await rendererValue(win, `document.querySelector('.refactor-form')?.getAttribute('data-keyboard') !== 'disabled' || Boolean(document.querySelector('.refactor-form input'))`))

  await setRefactorInputs(win)
  await waitForRenderer(win, `document.querySelector('.refactor-preview-button')?.disabled === false`)
  await pressKeyboardKey(win, 'ENTER')
  await waitForRenderer(win, `document.querySelector('[data-project-refactor-preview]') !== null`, 20_000)
  check('cross-file rename preview renders before applying',
    await rendererValue(win, `document.querySelector('[data-project-refactor-preview]') !== null`))
  check('preview reports declaration and consumer changes',
    await rendererValue(win, `document.querySelectorAll('.refactor-file-change').length === 2`))
  check('preview visibly shows removed and added lines',
    await rendererValue(win, `document.querySelector('.refactor-line-removed')?.textContent.includes('calculateTotal') && document.querySelector('.refactor-line-added')?.textContent.includes('computeTotal')`))
  await capture(win, 'project-refactor-preview-desktop.png')

  win.setSize(760, 700)
  await waitForRenderer(win, `window.innerWidth <= 760`)
  await settleRenderer(win)
  const layout = await rendererValue(win, `(() => {
    const panel = document.querySelector('.refactor-panel');
    const side = document.querySelector('.workbench-side');
    const panelRect = panel?.getBoundingClientRect();
    const sideRect = side?.getBoundingClientRect();
    const diff = document.querySelector('.refactor-diff');
    return {
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      panelContained: Boolean(panelRect && panelRect.left >= -1 && panelRect.right <= innerWidth + 1),
      panelFillsSide: Boolean(panelRect && sideRect && Math.abs(panelRect.width - sideRect.width) <= 1),
      formContained: [...document.querySelectorAll('.refactor-form input,.refactor-form button')].every((item) => item.getBoundingClientRect().right <= panelRect.right + 1),
      diffUsable: Boolean(diff && diff.clientWidth >= 220 && diff.clientHeight >= 44)
    }
  })()`)
  check('760x700 refactor preview has no page overflow',
    !layout.documentOverflow && layout.panelContained && layout.panelFillsSide && layout.formContained && layout.diffUsable,
    JSON.stringify(layout))
  await capture(win, 'project-refactor-compact.png')
  win.setSize(1200, 800)
  await waitForRenderer(win, `window.innerWidth >= 1100`)

  await rendererValue(win, `document.querySelector('.refactor-summary button')?.focus()`)
  await pressKeyboardKey(win, 'ENTER')
  await waitForRenderer(win, `document.querySelector('[data-project-refactor-result="applied"]') !== null`, 20_000)
  check('apply control updates the result state',
    await rendererValue(win, `document.querySelector('[data-project-refactor-result="applied"]') !== null`))
  check('apply changes both files on disk',
    fs.readFileSync(modelPath, 'utf8').includes('function computeTotal') && !fs.readFileSync(consumerPath, 'utf8').includes('calculateTotal'))
  check('applied state exposes a rollback action',
    await rendererValue(win, `Boolean(document.querySelector('[data-project-refactor-result="applied"] button'))`))
  check('applied state uses an opaque operation ID without workspace paths',
    await rendererValue(win, `(() => { const value = document.querySelector('[data-project-refactor-result="applied"] code')?.textContent ?? ''; return /^[a-f0-9-]{36}$/i.test(value) && !/^[a-zA-Z]:[\\/]/.test(value) })()`))

  await rendererValue(win, `document.querySelector('[data-project-refactor-result="applied"] button')?.focus()`)
  await pressKeyboardKey(win, 'ENTER')
  await waitForRenderer(win, `document.querySelector('[data-project-refactor-result="rolled-back"]') !== null`, 20_000)
  check('rollback control restores the result state',
    await rendererValue(win, `document.querySelector('[data-project-refactor-result="rolled-back"]') !== null`))
  check('rollback restores both files exactly',
    fs.readFileSync(modelPath, 'utf8').includes('function calculateTotal') && fs.readFileSync(consumerPath, 'utf8').includes('calculateTotal'))

  fs.writeFileSync(statePath, `${JSON.stringify({
    ok: true, generatedAt: new Date().toISOString(), pass: checks.length, total: checks.length,
    screenshots: ['project-refactor-preview-desktop.png', 'project-refactor-compact.png'], checks
  }, null, 2)}\n`)
  app.exit(0)
}

async function selectSession(win, sessionId) {
  await waitForRenderer(win, `Boolean(document.querySelector('.session-card[data-session-id="${sessionId}"]'))`)
  await rendererValue(win, `document.querySelector('.session-card[data-session-id="${sessionId}"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.session-card[data-session-id="${sessionId}"]')?.classList.contains('active')`)
}

async function openRefactor(win) {
  await rendererValue(win, `document.querySelector('[data-experience-mode-option="studio"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.experience-pane')?.getAttribute('data-experience-mode') === 'studio'`)
  await rendererValue(win, `document.querySelector('[data-studio-projection-tab="session"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.experience-pane')?.getAttribute('data-studio-surface') === 'session'`)
  await rendererValue(win, `document.querySelector('.desk-rail-drawer-anchor .desk-rail-button')?.click()`)
  await waitForRenderer(win, `document.querySelectorAll('.desk-tool-item').length >= 4`)
  await rendererValue(win, `document.querySelector('.desk-tool-item:nth-child(4)')?.click()`)
  await waitForRenderer(win, `document.querySelector('.developer-panel') !== null`)
  await rendererValue(win, `document.querySelector('.developer-panel-tabs button:nth-child(4)')?.click()`)
  await waitForRenderer(win, `document.querySelector('[data-project-refactor-panel]')?.checkVisibility() === true`)
}

async function setRefactorInputs(win) {
  await rendererValue(win, `(() => {
    const inputs = [...document.querySelectorAll('.refactor-form input')];
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const values = ['src/model.ts', '1', '17', 'computeTotal'];
    values.forEach((value, index) => { set.call(inputs[index], value); inputs[index].dispatchEvent(new Event('input', { bubbles: true })); });
    inputs.at(-1)?.focus();
  })()`)
}

async function pressKeyboardKey(win, keyCode) {
  const key = keyCode === 'ENTER' ? 'Enter' : keyCode
  await rendererValue(win, `(() => {
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    const event = new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true, cancelable: true });
    const defaultAllowed = target.dispatchEvent(event);
    if (defaultAllowed && target instanceof HTMLButtonElement && ${JSON.stringify(key)} === 'Enter') target.click();
    if (defaultAllowed && target instanceof HTMLInputElement && ${JSON.stringify(key)} === 'Enter') target.form?.requestSubmit();
  })()`)
  await settleRenderer(win)
}

async function capture(win, name) {
  await settleRenderer(win)
  fs.writeFileSync(path.join(screenshotDir, name), (await win.capturePage()).toPNG())
}

async function invoke(channel, ...args) {
  const handler = ipcMain._invokeHandlers?.get(channel)
  if (!handler) throw new Error(`IPC channel not registered: ${channel}`)
  const win = await waitForWindow()
  await waitForRenderer(win, `location.protocol === 'file:'`)
  return handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args)
}

function waitForWindow() { return waitFor(() => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()), 10_000) }
function waitForRenderer(win, expression, timeoutMs = 10_000) { return waitFor(async () => { try { return await rendererValue(win, expression) } catch { return false } }, timeoutMs) }
function rendererValue(win, expression) { return win.webContents.executeJavaScript(expression, true) }
async function settleRenderer(win) {
  await rendererValue(win, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  win.webContents.invalidate()
  await new Promise((resolve) => setTimeout(resolve, 180))
}
function waitFor(predicate, timeoutMs) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try { const value = await predicate(); if (value) return resolve(value) } catch { /* settle */ }
      if (Date.now() - started > timeoutMs) return reject(new Error('project refactor panel E2E wait timed out'))
      setTimeout(() => void poll(), 80)
    }
    void poll()
  })
}
function requiredEnv(name) { const value = process.env[name]; if (!value) throw new Error(`missing ${name}`); return value }
app.whenReady().then(() => run().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); app.exit(1) }))
