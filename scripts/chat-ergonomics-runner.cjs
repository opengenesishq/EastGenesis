const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const repoRoot = path.resolve(__dirname, '..')
const outMain = path.join(repoRoot, 'out', 'main', 'index.js')
const root = requiredEnv('CAOGEN_CHAT_ERGONOMICS_ROOT')
const statePath = requiredEnv('CAOGEN_CHAT_ERGONOMICS_STATE')
const screenshotDir = requiredEnv('CAOGEN_CHAT_ERGONOMICS_SCREENSHOT_DIR')
const userDataDir = path.join(root, 'userData')
const projectDir = path.join(root, 'project')
process.env.CAOGEN_USER_DATA_DIR = userDataDir
process.env.CAOGEN_MEMORY_DIR = path.join(root, 'memory')
fs.mkdirSync(projectDir, { recursive: true })
fs.writeFileSync(path.join(projectDir, 'README.md'), '# Chat ergonomics E2E\n')

const checks = []
const assistantText = '这是可复制的回答。\n\n```js\nconst answer = 42\n```'
const codeText = 'const answer = 42'

function check(name, condition, detail = '') {
  checks.push({ name, status: condition ? 'pass' : 'fail', detail })
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`)
  if (!condition) throw new Error(`${name}: ${detail || 'failed'}`)
}

async function run() {
  const server = await startResponsesServer()
  try {
    require(outMain)
    await waitFor(() => ipcMain._invokeHandlers?.has('providers:create') && ipcMain._invokeHandlers?.has('sessions:create'), 10_000)
    const provider = await invoke('providers:create', {
      name: 'Chat Ergonomics Mock',
      baseUrl: server.baseUrl,
      token: 'test-only',
      models: ['mock-chat'],
      engine: 'openai',
      openaiProtocol: 'responses'
    })
    const alpha = await createSession(provider.id, 'Draft Alpha')
    const beta = await createSession(provider.id, 'Draft Beta')
    check('two isolated chat sessions are created', alpha.id !== beta.id)
    await invoke('sessions:send', alpha.id, { text: '请给出一段示例代码。', messageId: 'chat-ergonomics-message' })
    await waitFor(async () => (await invoke('sessions:transcript', alpha.id))
      .some((entry) => entry.event.kind === 'turn-result'), 10_000)
    check('mock assistant turn completes before UI verification', server.requests === 1)

    const win = await waitForWindow()
    win.setSize(1200, 800)
    win.webContents.reload()
    await waitForRenderer(win, `document.body.innerText.includes('CaoGen')`)
    await selectSession(win, alpha.id)
    await waitForRenderer(win, `document.querySelectorAll('.msg-assistant .markdown').length === 1`)
    await verifyCopyActions(win)
    await verifyRevisionActions(win, alpha.id, server)
    await verifyCheckpointFork(win, alpha.id, server)
    await selectSession(win, alpha.id)
    await verifySessionDrafts(win, alpha.id, beta.id)
    await verifyRestartPersistence(win, alpha.id, beta.id)
    await verifyLayout(win)
    await verifyComposerAutosizeAndDeletion(win, beta.id)

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      pass: checks.length,
      total: checks.length,
      screenshots: [
        path.join(screenshotDir, 'chat-message-actions.png'),
        path.join(screenshotDir, 'chat-branch-welcome.png'),
        path.join(screenshotDir, 'chat-message-actions-compact.png'),
        path.join(screenshotDir, 'chat-composer-autosize.png')
      ],
      checks
    }
    fs.writeFileSync(statePath, `${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await new Promise((resolve) => server.instance.close(resolve))
  }
  app.exit(0)
}

async function verifyCopyActions(win) {
  await rendererValue(win, `Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text) => { window.__caogenCopiedText = text; }
  } })`)
  const actions = await rendererValue(win, `({
    user: document.querySelectorAll('.msg-user [data-copy-kind="message"]').length,
    assistant: document.querySelectorAll('.msg-assistant [data-copy-kind="message"]').length,
    code: document.querySelectorAll('[data-copy-kind="code"]').length,
    labels: [...document.querySelectorAll('[data-copy-kind]')].map((button) => button.getAttribute('aria-label'))
  })`)
  check('user, assistant, and code copy actions are rendered',
    actions.user === 1 && actions.assistant === 1 && actions.code === 1,
    JSON.stringify(actions))
  check('copy controls have localized accessible names', actions.labels.every((label) => label === '复制消息' || label === '复制代码'), JSON.stringify(actions.labels))

  await rendererValue(win, `document.querySelector('.msg-assistant [data-copy-kind="message"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.msg-assistant [data-copy-state="copied"]') !== null`)
  const copiedMessage = await rendererValue(win, `window.__caogenCopiedText`)
  check('assistant copy contains public text and fenced code', copiedMessage === assistantText, JSON.stringify(copiedMessage))

  await rendererValue(win, `document.querySelector('[data-copy-kind="code"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('[data-copy-kind="code"][data-copy-state="copied"]') !== null`)
  const copiedCode = await rendererValue(win, `window.__caogenCopiedText`)
  check('code copy contains only code content', copiedCode === codeText, JSON.stringify(copiedCode))
  check('copy success is exposed without changing message layout',
    await rendererValue(win, `document.querySelector('[data-copy-kind="code"]')?.getAttribute('aria-label') === '已复制'`))

  await rendererValue(win, `document.querySelector('.msg-assistant [data-copy-kind="message"]')?.focus()`)
  await settleRenderer(win)
  await capture(win, 'chat-message-actions.png')
}

async function verifyRevisionActions(win, sessionId, server) {
  const editedText = '请给出一段更短的示例代码。'
  const actions = await rendererValue(win, `({
    edit: document.querySelectorAll('[data-message-action="edit"]').length,
    fork: document.querySelectorAll('[data-message-action="fork"]').length,
    regenerate: document.querySelectorAll('[data-message-action="regenerate"]').length,
    editLabel: document.querySelector('[data-message-action="edit"]')?.getAttribute('aria-label'),
    forkLabel: document.querySelector('[data-message-action="fork"]')?.getAttribute('aria-label'),
    regenerateLabel: document.querySelector('[data-message-action="regenerate"]')?.getAttribute('aria-label')
  })`)
  check('completed text turn exposes edit and regenerate actions',
    actions.edit === 1 && actions.fork === 1 && actions.regenerate === 1,
    JSON.stringify(actions))
  check('revision actions have localized accessible names',
    actions.editLabel === '编辑消息' && actions.forkLabel === '从此处分支' && actions.regenerateLabel === '重新生成',
    JSON.stringify(actions))

  await rendererValue(win, `document.querySelector('[data-message-action="edit"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('[data-message-editing="true"] .message-edit-input')?.value === '请给出一段示例代码。'`)
  await rendererValue(win, `(() => {
    const input = document.querySelector('.message-edit-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(editedText)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await waitForRenderer(win, `document.querySelector('.message-edit-input')?.value === ${JSON.stringify(editedText)}`)
  await rendererValue(win, `document.querySelector('.message-edit .message-action-primary')?.click()`)
  await waitFor(() => server.requests === 2, 10_000)
  await waitForRenderer(win, `document.querySelector('[data-message-action="regenerate"]') !== null`, 10_000)
  let transcript = await invoke('sessions:transcript', sessionId)
  const editedUsers = transcript.filter((entry) => entry.event.kind === 'user-message')
  check('editing rewinds the old turn and sends one replacement user message',
    editedUsers.length === 1 && editedUsers[0].event.text === editedText,
    JSON.stringify(editedUsers.map((entry) => entry.event)))
  check('edited request reaches the provider exactly once',
    server.bodies.length === 2 && JSON.stringify(server.bodies[1]).includes(editedText),
    JSON.stringify({ requests: server.requests, bodies: server.bodies.length }))

  await rendererValue(win, `document.querySelector('[data-message-action="regenerate"]')?.click()`)
  await waitFor(() => server.requests === 3, 10_000)
  await waitForRenderer(win, `document.querySelector('[data-message-action="regenerate"]') !== null`, 10_000)
  transcript = await invoke('sessions:transcript', sessionId)
  const regeneratedUsers = transcript.filter((entry) => entry.event.kind === 'user-message')
  const regeneratedAssistants = transcript.filter((entry) => entry.event.kind === 'assistant-message')
  check('regenerate replaces the latest answer without duplicating the user turn',
    regeneratedUsers.length === 1 && regeneratedAssistants.length === 1 && regeneratedUsers[0].event.text === editedText,
    JSON.stringify({ users: regeneratedUsers.length, assistants: regeneratedAssistants.length }))
  check('regenerate resends the edited prompt exactly once',
    server.bodies.length === 3 && JSON.stringify(server.bodies[2]).includes(editedText),
    JSON.stringify({ requests: server.requests, bodies: server.bodies.length }))
  const revisionNotices = await rendererValue(win, `
    [...document.querySelectorAll('.notice')]
      .map((item) => item.textContent.trim())
      .filter((text) => text.includes('\u5df2\u6267\u884c\u56de\u9000') || text.includes('\u6ca1\u6709\u6587\u4ef6\u9700\u8981\u6062\u590d'))
  `)
  check('chat-only edit and regenerate do not leak internal file-rewind notices',
    revisionNotices.length === 0,
    JSON.stringify(revisionNotices))
}

async function verifyCheckpointFork(win, sourceSessionId, server) {
  const branchPrompt = '从这里创建一个独立分支。'
  const sourceMeta = (await invoke('sessions:list')).find((session) => session.id === sourceSessionId)
  check('branch source has a durable SDK identity', Boolean(sourceMeta?.sdkSessionId))
  const sourcePath = path.join(userDataDir, 'transcripts', `${sourceMeta.sdkSessionId}.jsonl`)
  const sourceBefore = fs.readFileSync(sourcePath)

  await rendererValue(win, `document.querySelector('[data-message-action="fork"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.welcome-fork-source') !== null`)
  const welcome = await rendererValue(win, `({
    text: document.querySelector('.welcome-composer-input')?.value,
    provider: Boolean(document.querySelector('[data-welcome-routing-control="provider"]')),
    model: Boolean(document.querySelector('[data-welcome-routing-control="model"]'))
  })`)
  check('message branch opens Welcome with the source prompt prefilled',
    welcome.text === '请给出一段更短的示例代码。', JSON.stringify(welcome))
  check('branch Welcome keeps Provider and model selectors available',
    welcome.provider && welcome.model, JSON.stringify(welcome))
  await capture(win, 'chat-branch-welcome.png')

  await rendererValue(win, `(() => {
    const input = document.querySelector('.welcome-composer-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(branchPrompt)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await waitForRenderer(win, `document.querySelector('.welcome-composer-input')?.value === ${JSON.stringify(branchPrompt)}`)
  await rendererValue(win, `document.querySelector('.welcome-send')?.click()`)
  await waitFor(() => server.requests === 4, 10_000)
  const branch = await waitFor(async () => (await invoke('sessions:list'))
    .find((session) => session.conversationForkSourceSessionId === sourceSessionId), 10_000)
  await waitFor(async () => (await invoke('sessions:transcript', branch.id))
    .some((entry) => entry.event.kind === 'turn-result'), 10_000)
  const branchTranscript = await invoke('sessions:transcript', branch.id)
  const branchUsers = branchTranscript.filter((entry) => entry.event.kind === 'user-message')
  check('checkpoint fork creates a new Session with complete source lineage',
    branch.id !== sourceSessionId
      && branch.conversationForkSourceSdkSessionId === sourceMeta.sdkSessionId
      && typeof branch.conversationForkCheckpointId === 'string'
      && branch.conversationForkCheckpointId.length > 0
      && typeof branch.conversationForkSourceRunId === 'string',
    JSON.stringify({
      newSession: branch.id !== sourceSessionId,
      sourceSdk: branch.conversationForkSourceSdkSessionId === sourceMeta.sdkSessionId,
      checkpoint: Boolean(branch.conversationForkCheckpointId),
      sourceRun: Boolean(branch.conversationForkSourceRunId)
    }))
  check('new branch sends the edited prompt exactly once',
    branchUsers.length === 1 && branchUsers[0].event.text === branchPrompt
      && JSON.stringify(server.bodies[3]).includes(branchPrompt),
    JSON.stringify({ users: branchUsers.map((entry) => entry.event.text), requests: server.requests }))
  check('creating and running the branch leaves the source ledger byte-for-byte unchanged',
    sourceBefore.equals(fs.readFileSync(sourcePath)))
}

async function verifySessionDrafts(win, alphaId, betaId) {
  const alphaDraft = 'alpha session draft'
  const betaDraft = 'beta session draft'
  await setComposerText(win, alphaDraft)
  await selectSession(win, betaId)
  check('new session does not inherit another session draft', await composerText(win) === '')
  await setComposerText(win, betaDraft)
  await selectSession(win, alphaId)
  check('switching back restores the first session draft', await composerText(win) === alphaDraft)
  await selectSession(win, betaId)
  check('each session retains its own draft', await composerText(win) === betaDraft)
}

async function verifyRestartPersistence(win, alphaId, betaId) {
  win.webContents.reload()
  await waitForRenderer(win, `document.body.innerText.includes('CaoGen')`)
  await selectSession(win, alphaId)
  check('first session draft survives renderer restart', await composerText(win) === 'alpha session draft')
  await selectSession(win, betaId)
  check('second session draft survives renderer restart', await composerText(win) === 'beta session draft')
  const document = await rendererValue(win, `JSON.parse(localStorage.getItem('caogen.composer-drafts.v1'))`)
  check('persisted draft document is versioned and bounded to session text',
    document.version === 1
      && Object.keys(document.drafts).length === 2
      && Object.values(document.drafts).every((entry) => typeof entry.text === 'string' && Number.isSafeInteger(entry.updatedAt)))
}

async function verifyLayout(win) {
  await selectSession(win, (await invoke('sessions:list')).find((session) => session.title === 'Draft Alpha').id)
  await rendererValue(win, `document.querySelector('.msg-assistant [data-copy-kind="message"]')?.focus()`)
  const desktop = await layoutState(win)
  check('message and code actions fit the desktop chat surface', !desktop.documentOverflow && desktop.controlsContained, JSON.stringify(desktop))
  win.setSize(760, 700)
  await settleRenderer(win)
  const compact = await layoutState(win)
  check('message and code actions fit the 760x700 chat surface', !compact.documentOverflow && compact.controlsContained, JSON.stringify(compact))
  await capture(win, 'chat-message-actions-compact.png')
  check('desktop and compact chat screenshots were written',
    fs.existsSync(path.join(screenshotDir, 'chat-message-actions.png'))
      && fs.existsSync(path.join(screenshotDir, 'chat-message-actions-compact.png')))
}

async function verifyComposerAutosizeAndDeletion(win, disposableSessionId) {
  win.setSize(1200, 800)
  await selectSession(win, disposableSessionId)
  await setComposerText(win, '短消息')
  const compactHeight = await rendererValue(win, `document.querySelector('.composer-input').getBoundingClientRect().height`)
  const multiline = Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 行：输入框应随内容连续增高`).join('\n')
  await setComposerText(win, multiline)
  await settleRenderer(win)
  const expanded = await composerLayoutState(win)
  check('Composer grows with multiline content before using an internal scrollbar',
    expanded.height > compactHeight + 100 && expanded.overflowY === 'hidden' && expanded.scrollHeight <= expanded.clientHeight + 1,
    JSON.stringify({ compactHeight, expanded }))
  const iconFamily = await rendererValue(win, `({
    send: Boolean(document.querySelector('.composer-send svg.lucide-arrow-up')),
    settings: Boolean(document.querySelector('[data-sidebar-action="settings"] svg.lucide-settings')),
    disclosure: [...document.querySelectorAll('.disclosure-chevron')]
      .every((icon) => icon.classList.contains('lucide-chevron-right')),
    disclosureCount: document.querySelectorAll('.disclosure-chevron').length
  })`)
  check('Composer and sidebar controls render the unified SVG icon family',
    iconFamily.send && iconFamily.settings,
    JSON.stringify(iconFamily))
  await capture(win, 'chat-composer-autosize.png')

  await setComposerText(win, '')
  await settleRenderer(win)
  const collapsed = await composerLayoutState(win)
  check('Composer shrinks back to one row after content is cleared',
    collapsed.height <= compactHeight + 2 && collapsed.overflowY === 'hidden',
    JSON.stringify({ compactHeight, collapsed }))

  await rendererValue(win, `document.querySelector('.chat-controls .icon-btn[aria-label="关闭会话"]')?.click()`)
  await waitForRenderer(win, `!document.querySelector('.session-card:not(.history-card)[data-session-id="${disposableSessionId}"]')`)
  await waitForRenderer(win, `Boolean(document.querySelector('.composer-input, .welcome-composer-input'))`)
  await settleRenderer(win)
  check('closing the active conversation immediately focuses an editable composer',
    await activeComposerState(win).then((state) => state.focused && !state.disabled && !state.readOnly && !state.inert),
    JSON.stringify(await activeComposerState(win)))
  await typeActiveComposer(win, '关闭会话后无需重启即可输入')
  check('typing works immediately after the active conversation closes',
    (await activeComposerState(win)).value === '关闭会话后无需重启即可输入')

  await waitForRenderer(win, `Boolean(document.querySelector('.history-card[data-session-id="${disposableSessionId}"]'))`)
  await rendererValue(win, `window.confirm = () => true; true`)
  await rendererValue(win, `document.querySelector('.history-card[data-session-id="${disposableSessionId}"] .session-card-more')?.click()`)
  await waitForRenderer(win, `Boolean([...document.querySelectorAll('.ctx-menu-item')].find((item) => item.textContent.trim() === '删除'))`)
  await rendererValue(win, `[...document.querySelectorAll('.ctx-menu-item')].find((item) => item.textContent.trim() === '删除')?.click()`)
  await waitForRenderer(win, `!document.querySelector('.history-card[data-session-id="${disposableSessionId}"]')`)
  await settleRenderer(win)
  await typeActiveComposer(win, '删除历史对话后仍可继续输入')
  const afterDelete = await activeComposerState(win)
  check('deleting conversation history preserves focus and typing without restart',
    afterDelete.focused && afterDelete.value === '删除历史对话后仍可继续输入' && !afterDelete.disabled && !afterDelete.inert,
    JSON.stringify(afterDelete))
}

function composerLayoutState(win) {
  return rendererValue(win, `(() => {
    const input = document.querySelector('.composer-input');
    const style = getComputedStyle(input);
    const rect = input.getBoundingClientRect();
    return {
      height: rect.height,
      clientHeight: input.clientHeight,
      scrollHeight: input.scrollHeight,
      overflowY: style.overflowY
    };
  })()`)
}

function activeComposerState(win) {
  return rendererValue(win, `(() => {
    const input = document.querySelector('.composer-input, .welcome-composer-input');
    return {
      value: input?.value || '',
      focused: document.activeElement === input,
      disabled: Boolean(input?.disabled),
      readOnly: Boolean(input?.readOnly),
      inert: Boolean(input?.closest('[inert]'))
    };
  })()`)
}

async function typeActiveComposer(win, text) {
  await rendererValue(win, `(() => {
    const input = document.querySelector('.composer-input, .welcome-composer-input');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await waitForRenderer(win, `document.querySelector('.composer-input, .welcome-composer-input')?.value === ${JSON.stringify(text)}`)
}

async function layoutState(win) {
  await settleRenderer(win)
  return rendererValue(win, `(() => {
    const controls = [...document.querySelectorAll('[data-copy-kind]')];
    return {
      width: window.innerWidth,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      controlsContained: controls.every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left >= -1 && rect.right <= window.innerWidth + 1 && button.scrollWidth <= button.clientWidth + 1;
      })
    };
  })()`)
}

async function createSession(providerId, title) {
  return invoke('sessions:create', {
    cwd: projectDir,
    unassigned: true,
    engine: 'openai',
    providerId,
    model: 'mock-chat',
    routingScope: 'fixed',
    permissionMode: 'default',
    isolated: false,
    title
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
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await waitForRenderer(win, `document.querySelector('.composer-input')?.value === ${JSON.stringify(text)}`)
}

function composerText(win) {
  return rendererValue(win, `document.querySelector('.composer-input')?.value || ''`)
}

async function startResponsesServer() {
  let requests = 0
  const bodies = []
  const instance = http.createServer(async (request, response) => {
    if (!request.url?.endsWith('/v1/responses')) {
      response.writeHead(404).end()
      return
    }
    let rawBody = ''
    for await (const chunk of request) rawBody += chunk.toString()
    requests += 1
    try { bodies.push(JSON.parse(rawBody)) } catch { bodies.push(rawBody) }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: assistantText })}\n\n`)
    response.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `resp_${Date.now()}`, usage: { input_tokens: 21, output_tokens: 12 } } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  const port = await new Promise((resolve) => instance.listen(0, '127.0.0.1', () => resolve(instance.address().port)))
  return {
    instance,
    baseUrl: `http://127.0.0.1:${port}`,
    bodies,
    get requests() { return requests }
  }
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

function waitForWindow() {
  return waitFor(() => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()), 10_000)
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
  await new Promise((resolve) => setTimeout(resolve, 250))
}

function waitFor(predicate, timeoutMs) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await predicate()
        if (value) return resolve(value)
      } catch {
        // Renderer, IPC registration, and session events are asynchronous.
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('chat ergonomics wait timed out'))
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
