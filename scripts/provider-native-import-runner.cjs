const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const repoRoot = path.resolve(__dirname, '..')
const outMain = path.join(repoRoot, 'out', 'main', 'index.js')
const userDataDir = requiredEnv('CAOGEN_PROVIDER_NATIVE_USER_DATA')
const statePath = requiredEnv('CAOGEN_PROVIDER_NATIVE_STATE')
const screenshotDir = requiredEnv('CAOGEN_PROVIDER_NATIVE_SCREENSHOT_DIR')
const secret = requiredEnv('CAOGEN_PROVIDER_NATIVE_SECRET')
process.env.CAOGEN_USER_DATA_DIR = userDataDir

const checks = []

function check(name, condition, detail = '') {
  checks.push({ name, status: condition ? 'pass' : 'fail', detail })
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`)
  if (!condition) throw new Error(`${name}: ${detail || 'failed'}`)
}

async function run() {
  require(outMain)
  await waitFor(() => ipcMain._invokeHandlers?.has('appFeatures:invoke'), 10_000)
  const win = await openProviderSettings()
  check('Provider settings does not expose a Codex config.toml editor',
    !(await rendererValue(win, `Boolean(document.querySelector('[data-codex-native-config-workspace]'))`)))
  const clicked = await rendererValue(win, `(() => {
    const button = document.querySelector('[data-provider-native-scan]');
    button?.click();
    return Boolean(button);
  })()`)
  check('native Codex scan action is visible in Provider settings', clicked)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-native-preview]'))`)
  await settleRenderer(win)

  const previewUi = await rendererValue(win, `(() => {
    const panel = document.querySelector('[data-provider-native-preview]');
    const body = document.body.innerText;
    const rect = panel.getBoundingClientRect();
    return {
      text: panel.innerText,
      hasSecret: body.includes(${JSON.stringify(secret)}),
      diffRows: panel.querySelectorAll('.provider-native-diff:not(.provider-native-diff-head)').length,
      facts: panel.querySelectorAll('.provider-native-summary > div').length,
      action: panel.querySelector('select')?.value,
      insideViewport: rect.left >= 0 && rect.right <= innerWidth + 1
    };
  })()`)
  check('native preview renders source, protocol, model, runtime, and ignored sections',
    ['config.toml', 'auth.json', 'OpenAI Responses', 'gpt-native-e2e', 'reasoningEffort=high', 'features']
      .every((value) => previewUi.text.includes(value)), JSON.stringify({ diffRows: previewUi.diffRows, facts: previewUi.facts }))
  check('native preview defaults to create for a new target', previewUi.action === 'create')
  check('native preview contains structured facts and diffs', previewUi.facts === 4 && previewUi.diffRows >= 6)
  check('native preview never renders the API key', !previewUi.hasSecret)
  check('native import warnings follow the active UI language',
    previewUi.text.includes('\u5df2\u5217\u51fa\u975e Provider \u7684客户端\u914d\u7f6e')
      && !previewUi.text.includes('Non-Provider client settings'))
  check('desktop preview remains inside the viewport', previewUi.insideViewport)
  await capture(win, 'codex-native-import-preview.png')

  const applied = await rendererValue(win, `(() => {
    const button = document.querySelector('[data-provider-native-preview] .btn-primary');
    button?.click();
    return Boolean(button);
  })()`)
  check('native import can be applied from the preview', applied)
  await waitForRenderer(win, `!document.querySelector('[data-provider-native-preview]')`)
  await waitForRenderer(win, `document.body.innerText.includes('Codex Native E2E')`)
  const providers = await invoke('providers:list')
  const imported = providers.find((provider) => provider.name === 'Codex Native E2E')
  check('applied native Provider is ready with the imported model',
    imported?.ready === true && imported?.hasToken === true && imported?.models?.includes('gpt-native-e2e'))
  const backups = await invokeProfile('native-backups')
  check('apply creates a credential-scrubbed rollback record', backups.length === 1 && backups[0].providerId === imported.id)
  const backupRoot = path.join(userDataDir, 'provider-native-import-backups')
  const backupRaw = fs.readdirSync(backupRoot).map((name) => fs.readFileSync(path.join(backupRoot, name), 'utf8')).join('\n')
  check('native rollback files contain no credential material', !backupRaw.includes(secret) && !backupRaw.includes('encryptedToken'))
  check('renderer body remains free of credential material after apply',
    !(await rendererValue(win, `document.body.innerText.includes(${JSON.stringify(secret)})`)))

  win.setSize(960, 850)
  await rendererValue(win, `document.querySelector('[data-provider-native-scan]')?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-native-preview]'))`)
  await settleRenderer(win)
  const compact = await rendererValue(win, `(() => {
    const panel = document.querySelector('[data-provider-native-preview]');
    const rect = panel.getBoundingClientRect();
    return {
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      panelWidth: rect.width,
      columns: getComputedStyle(panel.querySelector('.provider-native-summary')).gridTemplateColumns.split(' ').length,
      insideViewport: rect.left >= 0 && rect.right <= innerWidth + 1,
      bodyOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
      hasSecret: document.body.innerText.includes(${JSON.stringify(secret)})
    };
  })()`)
  check('minimum desktop preview retains the four-column fact layout', compact.width >= 960 && compact.columns === 4, JSON.stringify(compact))
  check('minimum desktop preview has no horizontal overflow or credential exposure', compact.insideViewport && compact.bodyOverflow && !compact.hasSecret)
  await capture(win, 'codex-native-import-preview-minimum-desktop.png')

  await invokeProfile('native-rollback', backups[0].id)
  const rolledBack = await invoke('providers:list')
  check('native create rollback removes the imported Provider', !rolledBack.some((provider) => provider.id === imported.id))
  check('rolled-back native backup is no longer offered', (await invokeProfile('native-backups')).length === 0)

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    pass: checks.length,
    total: checks.length,
    screenshots: [
      path.join(screenshotDir, 'codex-native-import-preview.png'),
      path.join(screenshotDir, 'codex-native-import-preview-minimum-desktop.png')
    ],
    checks
  }
  const raw = `${JSON.stringify(report, null, 2)}\n`
  if (raw.includes(secret)) throw new Error('native import E2E report contains credential material')
  fs.writeFileSync(statePath, raw)
  app.exit(0)
}

function invokeProfile(action, ...args) {
  return invoke('appFeatures:invoke', 'provider-profile', action, ...args)
}

async function invoke(channel, ...args) {
  const handler = ipcMain._invokeHandlers?.get(channel)
  if (!handler) throw new Error(`IPC channel not registered: ${channel}`)
  const win = await waitForWindow()
  await waitForRenderer(win, `location.protocol === 'file:'`)
  return handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args)
}

async function openProviderSettings() {
  const win = await waitForWindow()
  win.setSize(1200, 900)
  await waitForRenderer(win, `document.body.innerText.includes('EastGenesis')`)
  const opened = await rendererValue(win, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent.trim().includes('\u8bbe\u7f6e'));
    button?.click();
    return Boolean(button);
  })()`)
  if (!opened) throw new Error('settings button not found')
  await waitForRenderer(win, `Boolean(document.querySelector('.settings-page'))`)
  await rendererValue(win, `document.querySelector('[data-settings-tab="providers"]')?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-native-scan]'))`)
  return win
}

async function capture(win, name) {
  await settleRenderer(win)
  fs.writeFileSync(path.join(screenshotDir, name), (await win.capturePage()).toPNG())
}

function waitForWindow() {
  return waitFor(() => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()), 10_000)
}

function waitForRenderer(win, expression, timeoutMs = 10_000) {
  return waitFor(async () => {
    try { return await rendererValue(win, expression) } catch { return false }
  }, timeoutMs)
}

function rendererValue(win, expression) {
  return win.webContents.executeJavaScript(expression, true)
}

async function settleRenderer(win) {
  await rendererValue(win, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  win.webContents.invalidate()
  await new Promise((resolve) => setTimeout(resolve, 250))
}

function waitFor(predicate, timeoutMs) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await predicate()
        if (value) return resolve(value)
      } catch { /* startup is asynchronous */ }
      if (Date.now() - started > timeoutMs) return reject(new Error('provider native import E2E wait timed out'))
      setTimeout(() => void poll(), 100)
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
