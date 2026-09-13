const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { app, BrowserWindow, clipboard, ipcMain, nativeImage } = require('electron')

const repoRoot = path.resolve(__dirname, '..')
const outMain = path.join(repoRoot, 'out', 'main', 'index.js')
const root = requiredEnv('CAOGEN_COMPOSER_ATTACHMENTS_ROOT')
const statePath = requiredEnv('CAOGEN_COMPOSER_ATTACHMENTS_STATE')
const screenshotDir = requiredEnv('CAOGEN_COMPOSER_ATTACHMENTS_SCREENSHOTS')
const userDataDir = path.join(root, 'userData')
const projectDir = path.join(root, 'workspace')
const STARTUP_TIMEOUT_MS = 30_000
const PASTE_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
process.env.CAOGEN_USER_DATA_DIR = userDataDir
process.env.CAOGEN_MEMORY_DIR = path.join(root, 'memory')
fs.mkdirSync(projectDir, { recursive: true })
fs.writeFileSync(path.join(projectDir, 'notes.md'), '# Notes\nE2E-DOCUMENT-CONTENT-CANARY\n', 'utf8')
fs.writeFileSync(path.join(projectDir, '.env'), 'API_TOKEN=E2E-LOCAL-ONLY-CANARY\n', 'utf8')

const checks = []

function check(name, condition) {
  checks.push({ name, status: condition ? 'pass' : 'fail' })
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}`)
  if (!condition) throw new Error(name)
}

async function run() {
  const server = await startResponsesServer()
  try {
    require(outMain)
    await waitFor(() => ipcMain._invokeHandlers?.has('attachments:copyDocument') && ipcMain._invokeHandlers?.has('sessions:create'), STARTUP_TIMEOUT_MS)
    const provider = await invoke('providers:create', {
      name: 'Composer Attachment Mock', baseUrl: server.baseUrl, token: 'test-only',
      models: ['mock-attachments'], engine: 'openai', openaiProtocol: 'responses'
    })
    const alpha = await createSession(provider.id, 'Attachment Alpha')
    const beta = await createSession(provider.id, 'Attachment Beta')
    const win = await waitForWindow(STARTUP_TIMEOUT_MS)
    win.setSize(1200, 800)
    win.webContents.reload()
    await waitForRenderer(win, `document.body.innerText.includes('CaoGen')`, STARTUP_TIMEOUT_MS)
    await selectSession(win, alpha.id)

    const button = await rendererValue(win, `(() => { const el = document.querySelector('.composer-attach'); return { exists: !!el, label: el?.getAttribute('aria-label'), width: el?.getBoundingClientRect().width }; })()`)
    check('visible attachment button has an accessible label', button.exists && button.label && button.width === 34)

    await rendererValue(win, `document.querySelector('.composer-input')?.focus()`)
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(PASTE_IMAGE_BASE64, 'base64')))
    win.webContents.paste()
    await waitForRenderer(win, `document.querySelectorAll('.image-attachment-item').length === 1`)
    await waitForRenderer(win, `document.querySelector('.image-attachment-image')?.naturalWidth > 0`)
    const pastedImage = await rendererValue(win, `(() => {
      const item = document.querySelector('.image-attachment-item')
      const image = item?.querySelector('.image-attachment-image')
      return {
        name: item?.querySelector('.image-attachment-name')?.textContent,
        naturalWidth: image?.naturalWidth || 0,
        preview: image?.getAttribute('src') || ''
      }
    })()`)
    check('system clipboard image paste creates a visible image attachment',
      pastedImage.name && pastedImage.preview.startsWith('blob:') && pastedImage.naturalWidth > 0)
    await selectSession(win, beta.id)
    check('another session does not inherit a pasted image attachment',
      await rendererValue(win, `document.querySelectorAll('.image-attachment-item').length === 0`))
    await selectSession(win, alpha.id)
    check('switching back restores the pasted image attachment',
      await rendererValue(win, `document.querySelectorAll('.image-attachment-item').length === 1`))
    await setComposerText(win, '请描述这张图片')
    await rendererValue(win, `document.querySelector('.composer-send')?.click()`)
    await waitFor(() => server.requests.length === 1, 10_000)
    check('actual Provider request contains the pasted image block',
      server.requests[0].includes('input_image') && server.requests[0].includes('data:image/png;base64'))
    await waitForRenderer(win, `document.querySelectorAll('.image-attachment-item').length === 0`)
    check('accepted image send clears the image attachment tray', true)

    await chooseMention(win, '@notes', 'notes.md')
    await waitForRenderer(win, `document.querySelector('.document-attachment-name')?.textContent === 'notes.md'`)
    check('mention selection creates a visible document attachment', true)
    check('document chip exposes only the relative workspace path',
      await rendererValue(win, `!document.querySelector('.document-attachment-item')?.textContent.includes(${JSON.stringify(projectDir)})`))
    await waitForRenderer(win, `document.querySelector('[data-outbound-context-preview]')?.dataset.outboundBlocked === 'false'`)
    check('ordinary document remains sendable under outbound preview', true)

    await selectSession(win, beta.id)
    check('another session does not inherit unsent attachments',
      await rendererValue(win, `document.querySelectorAll('.document-attachment-item').length === 0`))
    await selectSession(win, alpha.id)
    check('switching back restores the unsent attachment',
      await rendererValue(win, `document.querySelector('.document-attachment-name')?.textContent === 'notes.md'`))

    await capture(win, 'composer-attachment-desktop.png')
    win.setSize(760, 700)
    await settleRenderer(win)
    const compact = await layoutState(win)
    check('attachment UI fits a 760x700 viewport', !compact.documentOverflow && compact.controlsContained)
    await capture(win, 'composer-attachment-compact.png')
    check('desktop and compact attachment screenshots were written',
      fs.existsSync(path.join(screenshotDir, 'composer-attachment-desktop.png')) &&
      fs.existsSync(path.join(screenshotDir, 'composer-attachment-compact.png')))

    await rendererValue(win, `document.querySelector('.document-attachment-remove')?.click()`)
    await waitForRenderer(win, `document.querySelectorAll('.document-attachment-item').length === 0`)
    await setComposerText(win, '')
    await chooseMention(win, '@.env', '.env')
    await waitForRenderer(win, `document.querySelector('.document-attachment-sensitive')?.textContent === 'S3'`)
    check('credential-like document is visibly marked S3', true)
    await waitForRenderer(win, `document.querySelector('[data-outbound-context-preview]')?.dataset.outboundBlocked === 'true'`)
    check('S3 document blocks Provider egress', true)
    check('send button is disabled while an S3 document is attached',
      await rendererValue(win, `document.querySelector('.composer-send')?.disabled === true`))

    await rendererValue(win, `document.querySelector('.document-attachment-remove')?.click()`)
    await waitForRenderer(win, `document.querySelectorAll('.document-attachment-item').length === 0`)
    await setComposerText(win, '')
    await chooseMention(win, '@notes', 'notes.md')
    await waitForRenderer(win, `document.querySelector('.composer-send')?.disabled === false`)
    await rendererValue(win, `document.querySelector('.composer-send')?.click()`)
    await waitFor(() => server.requests.length === 2, 10_000)
    const body = server.requests[1]
    check('actual Provider request contains the frozen document content', body.includes('E2E-DOCUMENT-CONTENT-CANARY'))
    check('actual Provider request labels the document with a relative path', body.includes('===== notes.md ====='))
    check('actual Provider request excludes the unselected S3 content', !body.includes('E2E-LOCAL-ONLY-CANARY'))
    await waitForRenderer(win, `document.querySelectorAll('.document-attachment-item').length === 0`)
    check('accepted send clears the current session attachment tray', true)

    fs.writeFileSync(statePath, `${JSON.stringify({
      ok: true,
      generatedAt: new Date().toISOString(),
      pass: checks.length,
      total: checks.length,
      screenshots: ['composer-attachment-desktop.png', 'composer-attachment-compact.png'],
      checks
    }, null, 2)}\n`)
  } finally {
    await new Promise((resolve) => server.instance.close(resolve))
  }
  app.exit(0)
}

async function chooseMention(win, query, expected) {
  await setComposerText(win, query)
  await waitForRenderer(win, `[...document.querySelectorAll('.mention-item')].some((item) => item.textContent === ${JSON.stringify(expected)})`)
  await rendererValue(win, `[...document.querySelectorAll('.mention-item')].find((item) => item.textContent === ${JSON.stringify(expected)})?.click()`)
  await waitForRenderer(win, `document.querySelector('.composer-input')?.value.includes(${JSON.stringify(`@${expected}`)})`)
}

async function createSession(providerId, title) {
  return invoke('sessions:create', {
    cwd: projectDir, unassigned: true, engine: 'openai', providerId, model: 'mock-attachments',
    routingScope: 'fixed', permissionMode: 'default', isolated: false, title
  })
}

async function selectSession(win, sessionId) {
  await waitForRenderer(win, `Boolean(document.querySelector('.session-card[data-session-id="${sessionId}"]'))`)
  await rendererValue(win, `document.querySelector('.session-card[data-session-id="${sessionId}"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.session-card[data-session-id="${sessionId}"]')?.classList.contains('active')`)
  await waitForRenderer(win, `Boolean(document.querySelector('.composer-input'))`)
  await settleRenderer(win)
}

async function setComposerText(win, text) {
  await rendererValue(win, `(() => {
    const input = document.querySelector('.composer-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'x' }));
  })()`)
  await waitForRenderer(win, `document.querySelector('.composer-input')?.value === ${JSON.stringify(text)}`)
}

async function layoutState(win) {
  return rendererValue(win, `(() => {
    const controls = [...document.querySelectorAll('.composer-attach, .composer-send, .document-attachment-remove')];
    return {
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      controlsContained: controls.every((control) => {
        const rect = control.getBoundingClientRect();
        return rect.left >= -1 && rect.right <= window.innerWidth + 1 && control.scrollWidth <= control.clientWidth + 1;
      })
    };
  })()`)
}

async function startResponsesServer() {
  const requests = []
  const instance = http.createServer((request, response) => {
    if (!request.url?.endsWith('/v1/responses')) return response.writeHead(404).end()
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Document received.' })}\n\n`)
      response.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `resp_${Date.now()}`, usage: { input_tokens: 30, output_tokens: 3 } } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  const port = await new Promise((resolve) => instance.listen(0, '127.0.0.1', () => resolve(instance.address().port)))
  return { instance, requests, baseUrl: `http://127.0.0.1:${port}` }
}

async function capture(win, name) {
  await settleRenderer(win)
  fs.writeFileSync(path.join(screenshotDir, name), (await win.capturePage()).toPNG())
}

async function invoke(channel, ...args) {
  const handler = ipcMain._invokeHandlers?.get(channel)
  if (!handler) throw new Error(`IPC channel not registered: ${channel}`)
  const win = await waitForWindow(STARTUP_TIMEOUT_MS)
  await waitForRenderer(win, `location.protocol === 'file:'`, STARTUP_TIMEOUT_MS)
  return handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args)
}

function waitForWindow(timeoutMs = 10_000) {
  return waitFor(() => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()), timeoutMs)
}

function waitForRenderer(win, expression, timeoutMs = 10_000) {
  return waitFor(async () => {
    try { return await rendererValue(win, expression) } catch { return false }
  }, timeoutMs)
}

function rendererValue(win, expression) { return win.webContents.executeJavaScript(expression, true) }

async function settleRenderer(win) {
  await rendererValue(win, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  win.webContents.invalidate()
  await new Promise((resolve) => setTimeout(resolve, 200))
}

function waitFor(predicate, timeoutMs) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try { const value = await predicate(); if (value) return resolve(value) } catch { /* keep polling */ }
      if (Date.now() - started > timeoutMs) return reject(new Error('composer attachments wait timed out'))
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
