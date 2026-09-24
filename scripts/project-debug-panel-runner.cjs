const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const repoRoot = path.resolve(__dirname, '..')
const root = requiredEnv('CAOGEN_PROJECT_DEBUG_PANEL_ROOT')
const statePath = requiredEnv('CAOGEN_PROJECT_DEBUG_PANEL_STATE')
const screenshotDir = requiredEnv('CAOGEN_PROJECT_DEBUG_PANEL_SCREENSHOTS')
const projectDir = path.join(root, 'project')
process.env.CAOGEN_USER_DATA_DIR = path.join(root, 'userData')
process.env.CAOGEN_MEMORY_DIR = path.join(root, 'memory')
fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })
fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
  name: 'caogen-project-debug-panel-fixture',
  private: true,
  main: 'src/index.js',
  scripts: { 'debug:server': 'node server.js' }
}, null, 2))
fs.writeFileSync(path.join(projectDir, 'src', 'index.js'), [
  'function compute(input) {',
  '  const doubled = input * 2',
  '  const payload = { doubled, nested: { ready: true } }',
  "  console.log('panel-debug', payload.doubled)",
  '  return payload',
  '}',
  'compute(21)',
  ''
].join('\n'))
fs.writeFileSync(path.join(projectDir, 'server.js'), 'setInterval(() => {}, 1000)\n')

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
    name: 'Project Debug Mock', baseUrl: 'http://127.0.0.1:9', token: 'test-only',
    models: ['mock-debug'], engine: 'openai', openaiProtocol: 'responses'
  })
  const session = await invoke('sessions:create', {
    cwd: projectDir, engine: 'openai', providerId: provider.id, model: 'mock-debug',
    routingScope: 'fixed', taskStrategy: 'execute', isolated: false, title: 'Project Debug'
  })
  const win = await waitForWindow()
  win.setSize(1200, 800)
  win.webContents.reload()
  await waitForRenderer(win, `document.body.innerText.includes('EastGenesis')`)
  await selectSession(win, session.id)
  await openDebugger(win)

  check('Code workspace exposes Files, Tests, Debug, and Refactor as first-level tabs',
    await rendererValue(win, `document.querySelectorAll('.developer-panel-tabs [role="tab"]').length === 4`))
  check('debug target discovery renders JavaScript launch targets',
    await rendererValue(win, `document.querySelectorAll('[data-project-debug-target="node"]').length >= 2`))
  check('renderer targets expose only project-relative paths', await rendererValue(win, `
    [...document.querySelectorAll('.debug-target-copy span')].every((item) => !/^[a-zA-Z]:[\\/]/.test(item.textContent.trim()))
  `))

  await rendererValue(win, `(() => {
    const pathInput = document.querySelector('input[aria-label="项目内文件路径"]');
    const lineInput = document.querySelector('input[aria-label="行号"]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(pathInput, 'src/index.js'); pathInput.dispatchEvent(new Event('input', { bubbles: true }));
    set.call(lineInput, '4'); lineInput.dispatchEvent(new Event('input', { bubbles: true }));
    lineInput.focus();
  })()`)
  await waitForRenderer(win, `document.querySelector('button[aria-label="添加断点"]')?.disabled === false`)
  await waitForRenderer(win, `document.activeElement?.getAttribute('aria-label') === '行号'`)
  await pressKeyboardKey(win, 'Enter')
  await waitForRenderer(win, `document.querySelector('.debug-breakpoint-row')?.textContent.includes('src/index.js')`)
  check('Enter submits a project-relative line breakpoint from the keyboard',
    await rendererValue(win, `document.querySelector('.debug-breakpoint-row')?.textContent.includes(':4')`))

  await launchTarget(win, 'src/index.js')
  await waitForRenderer(win, `document.querySelector('[data-project-debug-status="paused"]') !== null`, 20_000)
  check('visible UI launches and hits a real breakpoint',
    await rendererValue(win, `document.querySelector('[data-project-debug-status="paused"]') !== null`))
  check('call stack shows the relative source location',
    await rendererValue(win, `document.querySelector('.debug-stack-list')?.textContent.includes('src/index.js:4')`))
  check('local variables include the expected computed value',
    await rendererValue(win, `[...document.querySelectorAll('.debug-variable-row')].some((row) => row.textContent.includes('doubled') && row.textContent.includes('42'))`))
  check('paused session enables continue and step controls',
    await rendererValue(win, `['继续','单步跳过','单步进入','单步跳出'].every((label) => !document.querySelector('button[aria-label="' + label + '"]')?.disabled)`))
  await capture(win, 'project-debug-paused-desktop.png')

  await rendererValue(win, `document.querySelector('button[aria-label="继续"]')?.focus()`)
  await pressKeyboardKey(win, 'ENTER')
  await waitForRenderer(win, `document.querySelector('[data-project-debug-status="stopped"]') !== null`, 20_000)
  check('continue completes the target and updates terminal state',
    await rendererValue(win, `document.querySelector('[data-project-debug-status="stopped"]') !== null`))
  check('captured debug output is visible',
    await rendererValue(win, `document.querySelector('.debug-output')?.textContent.includes('panel-debug 42')`))

  await launchTarget(win, 'server.js')
  await waitForRenderer(win, `document.querySelector('[data-project-debug-status="running"]') !== null`, 20_000)
  await rendererValue(win, `document.querySelector('button[aria-label="暂停"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('[data-project-debug-status="paused"]') !== null`, 20_000)
  check('running target can be paused from the visible control bar',
    await rendererValue(win, `document.querySelector('[data-project-debug-status="paused"]') !== null`))
  await rendererValue(win, `document.querySelector('button[aria-label="停止调试"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('[data-project-debug-status="stopped"]') !== null`, 20_000)
  check('stop control terminates the visible debug session',
    await rendererValue(win, `document.querySelector('[data-project-debug-status="stopped"]') !== null`))

  win.setSize(760, 700)
  await waitForRenderer(win, `window.innerWidth <= 760`)
  await settleRenderer(win)
  const layout = await rendererValue(win, `(() => {
    const panel = document.querySelector('.debug-panel');
    const side = document.querySelector('.workbench-side');
    const panelRect = panel?.getBoundingClientRect();
    const sideRect = side?.getBoundingClientRect();
    return {
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      panelContained: Boolean(panelRect && panelRect.left >= -1 && panelRect.right <= innerWidth + 1),
      panelFillsSide: Boolean(panelRect && sideRect && Math.abs(panelRect.width - sideRect.width) <= 1),
      controlsContained: [...document.querySelectorAll('.debug-control-bar button')].every((item) => item.getBoundingClientRect().right <= panelRect.right + 1),
      rowsContained: [...document.querySelectorAll('.debug-target-row,.debug-breakpoint-row,.debug-variable-row')].every((row) => row.scrollWidth <= row.clientWidth + 1)
    };
  })()`)
  check('760x700 debugger has no horizontal overflow',
    !layout.documentOverflow && layout.panelContained && layout.panelFillsSide && layout.controlsContained && layout.rowsContained,
    JSON.stringify(layout))
  await capture(win, 'project-debug-compact.png')

  fs.writeFileSync(statePath, `${JSON.stringify({
    ok: true, generatedAt: new Date().toISOString(), pass: checks.length, total: checks.length,
    screenshots: ['project-debug-paused-desktop.png', 'project-debug-compact.png'], checks
  }, null, 2)}\n`)
  app.exit(0)
}

async function selectSession(win, sessionId) {
  await waitForRenderer(win, `Boolean(document.querySelector('.session-card[data-session-id="${sessionId}"]'))`)
  await rendererValue(win, `document.querySelector('.session-card[data-session-id="${sessionId}"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.session-card[data-session-id="${sessionId}"]')?.classList.contains('active')`)
}

async function openDebugger(win) {
  await rendererValue(win, `document.querySelector('[data-experience-mode-option="studio"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.experience-pane')?.getAttribute('data-experience-mode') === 'studio'`)
  await rendererValue(win, `document.querySelector('[data-studio-projection-tab="session"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.experience-pane')?.getAttribute('data-studio-surface') === 'session'`)
  await rendererValue(win, `document.querySelector('.desk-rail-drawer-anchor .desk-rail-button')?.click()`)
  await waitForRenderer(win, `document.querySelectorAll('.desk-tool-item').length >= 4`)
  await rendererValue(win, `document.querySelector('.desk-tool-item:nth-child(4)')?.click()`)
  await waitForRenderer(win, `document.querySelector('.developer-panel') !== null`)
  await rendererValue(win, `document.querySelector('.developer-panel-tabs button:nth-child(3)')?.click()`)
  await waitForRenderer(win, `document.querySelector('[data-project-debug-panel]')?.checkVisibility() === true`)
  await waitForRenderer(win, `document.querySelectorAll('[data-project-debug-target]').length >= 2`)
}

async function launchTarget(win, relativePath) {
  await rendererValue(win, `(() => {
    const row = [...document.querySelectorAll('[data-project-debug-target]')]
      .find((item) => item.querySelector('.debug-target-copy span')?.textContent.includes(${JSON.stringify(relativePath)}));
    row?.querySelector(':scope > button:last-child')?.click();
  })()`)
}

async function capture(win, name) {
  await settleRenderer(win)
  fs.writeFileSync(path.join(screenshotDir, name), (await win.capturePage()).toPNG())
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

async function invoke(channel, ...args) {
  const handler = ipcMain._invokeHandlers?.get(channel)
  if (!handler) throw new Error(`IPC channel not registered: ${channel}`)
  const win = await waitForWindow()
  await waitForRenderer(win, `location.protocol === 'file:'`)
  return handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args)
}

function waitForWindow() {
  return waitFor(() => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()), 10_000)
}

function waitForRenderer(win, expression, timeoutMs = 10_000) {
  return waitFor(async () => {
    try { return await rendererValue(win, expression) } catch { return false }
  }, timeoutMs, async () => {
    try {
      return await rendererValue(win, `JSON.stringify({
        expression: ${JSON.stringify(expression)},
        status: document.querySelector('[data-project-debug-status]')?.getAttribute('data-project-debug-status') || null,
        error: document.querySelector('.debug-panel .notice-error')?.textContent || null,
        breakpoints: [...document.querySelectorAll('.debug-breakpoint-row')].map((row) => row.textContent.trim()),
        activeTarget: document.querySelector('.debug-target-active')?.textContent || null
      })`)
    } catch (error) {
      return JSON.stringify({ expression, diagnosticError: String(error) })
    }
  })
}

function rendererValue(win, expression) {
  return win.webContents.executeJavaScript(expression, true)
}

async function settleRenderer(win) {
  await rendererValue(win, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  win.webContents.invalidate()
  await new Promise((resolve) => setTimeout(resolve, 180))
}

function waitFor(predicate, timeoutMs, diagnostic) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await predicate()
        if (value) return resolve(value)
      } catch { /* main and renderer state settle independently */ }
      if (Date.now() - started > timeoutMs) {
        const detail = diagnostic ? await diagnostic() : ''
        return reject(new Error(`project debug panel E2E wait timed out${detail ? `: ${detail}` : ''}`))
      }
      setTimeout(() => void poll(), 80)
    }
    void poll()
  })
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`missing ${name}`)
  return value
}

app.whenReady().then(() => run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  app.exit(1)
}))
