const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const http = require('node:http')
const { app, BrowserWindow, ipcMain } = require('electron')

const repoOut = path.resolve(__dirname, '..', 'out', 'main')
// macOS exposes os.tmpdir() through /var, which is a system symlink to
// /private/var. The handoff store deliberately rejects symlinked ancestors,
// so give the runtime a canonical temporary root while keeping that invariant.
const tempRoot = fs.realpathSync(os.tmpdir())
const tmpUserData = fs.mkdtempSync(path.join(tempRoot, 'caogen-provider-recheck-'))
const workDir = fs.mkdtempSync(path.join(tempRoot, 'caogen-provider-work-'))
const reportPath = path.resolve(__dirname, '..', 'test-results', 'provider-restart-recheck', 'latest.json')
process.env.CAOGEN_USER_DATA_DIR = tmpUserData

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${String(detail).slice(0, 180)}` : ''}`)
}

async function invoke(channel, ...args) {
  const map = ipcMain._invokeHandlers
  if (!map || !map.has(channel)) throw new Error(`通道未注册: ${channel}`)
  const win = await waitFor(() => BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()), 10_000, 'main window not ready')
  const sender = win.webContents
  await waitFor(() => {
    const frameUrl = sender.mainFrame?.url || ''
    return !sender.isDestroyed() && frameUrl.startsWith('file:')
  }, 10_000, 'renderer frame not ready')
  return map.get(channel)({ sender, senderFrame: sender.mainFrame }, ...args)
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function startModelServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/deepseek/v1/models') return json(res, 200, { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-chat' }] })
    if (req.url === '/local/v1/models') return json(res, 200, ['local-chat', 'local-coder'])
    if (req.url === '/auth/v1/models') return json(res, 401, { error: { message: 'bad key' } })
    if (req.url === '/rate/v1/models') return json(res, 429, { error: { message: 'too many requests' } })
    if (req.url === '/server/v1/models') return json(res, 500, { error: { message: 'upstream down' } })
    json(res, 404, { error: { message: 'not found' } })
  })
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  return { server, base: `http://127.0.0.1:${port}` }
}

async function startErrorResponseServer() {
  const server = http.createServer((req, res) => {
    req.resume()
    json(res, 404, { error: { message: 'model does-not-exist not found' } })
  })
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  return { server, base: `http://127.0.0.1:${port}` }
}

function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await fn()
        if (value) return resolve(value)
      } catch {
        // keep polling
      }
      if (Date.now() - start > timeoutMs) return reject(new Error(label))
      setTimeout(tick, 150)
    }
    void tick()
  })
}

async function run() {
  require(path.join(repoOut, 'index.js'))
  await new Promise((resolve) => setTimeout(resolve, 900))
  await invoke('settings-domain:update', { failoverEnabled: false })

  const modelServer = await startModelServer()
  const errorServer = await startErrorResponseServer()
  try {
    const deepseek = await invoke('providers:create', {
      name: 'DeepSeek mock',
      baseUrl: `${modelServer.base}/deepseek`,
      token: 'good-key',
      models: [],
      openaiProtocol: 'chat'
    })
    const local = await invoke('providers:create', {
      name: 'Local OpenAI gateway',
      baseUrl: `${modelServer.base}/local`,
      token: 'good-key',
      models: [],
      openaiProtocol: 'chat'
    })
    const bad = await invoke('providers:create', {
      name: 'Broken gateway',
      baseUrl: `${modelServer.base}/server`,
      token: 'good-key',
      models: [],
      openaiProtocol: 'chat'
    })

    const deepseekModels = await invoke('providers:fetchModels', {
      providerId: deepseek.id,
      baseUrl: `${modelServer.base}/deepseek`,
      token: 'good-key',
      openaiProtocol: 'chat'
    })
    check('DeepSeek models fetched', deepseekModels.ok && deepseekModels.models.join(',') === 'deepseek-chat', JSON.stringify(deepseekModels))

    const localModels = await invoke('providers:fetchModels', {
      providerId: local.id,
      baseUrl: `${modelServer.base}/local`,
      token: 'good-key',
      openaiProtocol: 'chat'
    })
    check('Local gateway models fetched', localModels.ok && localModels.models.join(',') === 'local-chat,local-coder', JSON.stringify(localModels))
    check('Provider/baseUrl model cache isolated', deepseekModels.cacheKey !== localModels.cacheKey && !localModels.models.includes('deepseek-chat'))

    const brokenModels = await invoke('providers:fetchModels', {
      providerId: bad.id,
      baseUrl: `${modelServer.base}/server`,
      token: 'good-key',
      openaiProtocol: 'chat'
    })
    check('Broken gateway marks stale without polluted models', !brokenModels.ok && brokenModels.stale && brokenModels.models.length === 0 && brokenModels.error.kind === 'server', JSON.stringify(brokenModels))

    const limitedToken = ['bad', 'or', 'limited'].join('-')
    for (const [label, route, kind, status] of [
      ['401 auth', 'auth', 'auth', 401],
      ['429 rate limit', 'rate', 'rate_limit', 429],
      ['500 server', 'server', 'server', 500]
    ]) {
      const result = await invoke('providers:fetchModels', {
        providerId: bad.id,
        baseUrl: `${modelServer.base}/${route}`,
        token: limitedToken,
        openaiProtocol: 'chat'
      })
      check(`Model discovery ${label} attributed`, !result.ok && result.error.kind === kind && result.error.status === status, JSON.stringify(result))
    }

    const network = await invoke('providers:fetchModels', {
      providerId: bad.id,
      baseUrl: 'http://127.0.0.1:9',
      token: 'key',
      openaiProtocol: 'chat'
    })
    check('Model discovery disconnected gateway attributed', !network.ok && network.error.kind === 'network' && network.models.length === 0, JSON.stringify(network))

    const errorProvider = await invoke('providers:create', {
      name: '404 response gateway',
      baseUrl: errorServer.base,
      token: 'key',
      models: ['does-not-exist'],
      openaiProtocol: 'responses'
    })
    const meta = await invoke('sessions:create', {
      cwd: workDir,
      engine: 'openai',
      providerId: errorProvider.id,
      model: 'does-not-exist',
      isolated: false
    })
    await invoke('sessions:send', meta.id, { text: 'trigger model 404' })
    const turn = await waitFor(
      async () => (await invoke('sessions:transcript', meta.id)).find((entry) => entry.event.kind === 'turn-result')?.event,
      8000,
      'turn-result not emitted for provider error'
    )
    const text = turn.resultText || ''
    check('OpenAI runtime error includes provider/redacted-baseUrl/model/protocol',
      turn.isError
        && text.includes('404 response gateway')
        && text.includes('[provider-url-redacted]')
        && !text.includes(errorServer.base)
        && text.includes('does-not-exist')
        && text.includes('responses'), text)
  } finally {
    await new Promise((resolve) => modelServer.server.close(resolve))
    await new Promise((resolve) => errorServer.server.close(resolve))
  }

  finish(results.every((item) => item.ok) ? 0 : 1)
}

function finish(code) {
  const pass = results.filter((item) => item.ok).length
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify({ ok: code === 0, pass, total: results.length, generatedAt: new Date().toISOString(), results }, null, 2))
  console.log(`\nprovider-restart-recheck: ${pass}/${results.length} 通过`)
  console.log(`provider recheck report: ${reportPath}`)
  app.exit(code)
}

app.whenReady().then(() => run().catch((err) => {
  console.error(err)
  check('provider-restart-recheck crashed', false, err instanceof Error ? err.message : String(err))
  finish(1)
}))
