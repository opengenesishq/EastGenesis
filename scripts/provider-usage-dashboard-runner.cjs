const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const repoRoot = path.resolve(__dirname, '..')
const outMain = path.join(repoRoot, 'out', 'main', 'index.js')
const userDataDir = requiredEnv('CAOGEN_PROVIDER_USAGE_USER_DATA')
const statePath = requiredEnv('CAOGEN_PROVIDER_USAGE_STATE')
const screenshotDir = requiredEnv('CAOGEN_PROVIDER_USAGE_SCREENSHOT_DIR')
process.env.CAOGEN_USER_DATA_DIR = userDataDir

const checks = []
const queries = []
const secretCanary = ['usage', 'secret', 'canary'].join('-')
const contentCanary = ['private', 'request', 'body'].join('-')
const billingRequests = []
let authorizationRoutingMode = 'preferred'
let authorizationPolicies = new Map()

function check(name, condition, detail = '') {
  checks.push({ name, status: condition ? 'pass' : 'fail', detail })
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`)
  if (!condition) throw new Error(`${name}: ${detail || 'failed'}`)
}

async function run() {
  const billingServer = await startBillingServer()
  require(outMain)
  await waitFor(() => ipcMain._invokeHandlers?.has('providers:create') && ipcMain._invokeHandlers?.has('providers:usage'), 10_000)
  const alpha = await invoke('providers:create', {
    name: 'Usage Alpha',
    baseUrl: 'http://127.0.0.1:23101/v1',
    models: ['alpha-chat', 'alpha-code'],
    engine: 'openai',
    authMode: 'none',
    openaiProtocol: 'chat',
    authorization: {
      schemaVersion: 1,
      method: 'device-code',
      status: 'authorized',
      provider: 'xai-oauth',
      accountId: 'account-alpha-primary',
      accountLabel: 'Primary account',
      accountRoutingMode: 'preferred'
    },
    advancedConfig: {
      schemaVersion: 1,
      billingQuery: {
        path: '/billing',
        method: 'GET',
        credentialMode: 'none',
        periodStart: { target: 'query', name: 'start', format: 'unix-ms' },
        periodEnd: { target: 'query', name: 'end', format: 'unix-ms' },
        response: { amountPath: '/amount', currencyPath: '/currency' }
      }
    }
  })
  const beta = await invoke('providers:create', {
    name: 'Usage Beta',
    baseUrl: 'http://127.0.0.1:23102/v1',
    models: ['beta-reason'],
    engine: 'openai',
    authMode: 'none',
    openaiProtocol: 'chat'
  })
  check('isolated E2E Providers are ready without credentials', alpha.ready && beta.ready && !alpha.hasToken && !beta.hasToken)

  const attempts = createAttempts(alpha.id, beta.id)
  const originalModelFetch = ipcMain._invokeHandlers.get('providers:fetchModels')
  const restoreDashboardFixtures = installDashboardFixtures(alpha, beta, attempts)

  fs.mkdirSync(screenshotDir, { recursive: true })
  const win = await openProviderSettings()
  try {
    await verifyInitialDashboard(win)
    await verifyUsageViews(win)
    await verifySourceFilterAndAutoRefresh(win)
    await verifyCredentialFilter(win)
    await verifyProviderAndModelFilters(win, alpha.id)
    await verifyBillingReconciliation(win, alpha.id)
    await verifyRangeFilter(win)
    await verifyCompactLayout(win)
    await verifyProviderInformationOrder(win)
    await verifyProviderConnectionDiagnostic(win, alpha)
    check('renderer queries contain only bounded usage selectors', queries.length >= 6 && queries.every((query) =>
      Object.keys(query).every((key) => ['from', 'to', 'providerId', 'model', 'source', 'keyLabel', 'limit', 'offset', 'bucketCount'].includes(key))
        && !JSON.stringify(query).includes(secretCanary)
        && !JSON.stringify(query).includes(contentCanary)))
  } finally {
    restoreDashboardFixtures()
    ipcMain._invokeHandlers.set('providers:fetchModels', originalModelFetch)
  }

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    pass: checks.length,
    total: checks.length,
    screenshots: [
      path.join(screenshotDir, 'provider-usage-dashboard.png'),
      path.join(screenshotDir, 'provider-usage-dashboard-compact.png'),
      path.join(screenshotDir, 'provider-billing-reconciliation.png'),
      path.join(screenshotDir, 'provider-billing-api-sync.png'),
      path.join(screenshotDir, 'provider-billing-api-config.png'),
      path.join(screenshotDir, 'provider-authorization-routing.png'),
      path.join(screenshotDir, 'provider-connection-diagnostic.png')
    ],
    checks
  }
  const raw = `${JSON.stringify(report, null, 2)}\n`
  if (raw.includes(secretCanary) || raw.includes(contentCanary)) throw new Error('usage E2E report contains private canary material')
  fs.writeFileSync(statePath, raw)
  await new Promise((resolve) => billingServer.close(resolve))
  finish(0)
}

function startBillingServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1:23101')
    if (request.method !== 'GET' || url.pathname !== '/billing') {
      response.writeHead(404).end()
      return
    }
    billingRequests.push({
      method: request.method,
      path: url.pathname,
      start: url.searchParams.get('start'),
      end: url.searchParams.get('end'),
      headerNames: Object.keys(request.headers).sort()
    })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ amount: 10, currency: 'USD' }))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(23101, '127.0.0.1', () => resolve(server))
  })
}

function installDashboardFixtures(alpha, beta, attempts) {
  const channels = [
    'providers:usage',
    'providers:balance:capability',
    'providers:balance:query',
    'providers:authorization:accounts',
    'providers:authorization:quota',
    'providers:authorization:bind'
  ]
  const originals = new Map(channels.map((channel) => [channel, ipcMain._invokeHandlers.get(channel)]))
  authorizationRoutingMode = 'preferred'
  authorizationPolicies = new Map([
    ['account-alpha-primary', accountPolicy(10)],
    ['account-alpha-secondary', accountPolicy(20)]
  ])
  ipcMain._invokeHandlers.set('providers:usage', async (_event, query = {}) => {
    queries.push(structuredClone(query))
    return summarize(attempts, new Map([[alpha.id, alpha.name], [beta.id, beta.name]]), query)
  })
  ipcMain._invokeHandlers.set('providers:balance:capability', async (_event, providerId) => ({
    providerId,
    supported: providerId === alpha.id,
    ...(providerId === alpha.id ? { source: 'builtin', label: 'Usage fixture balance', credentialMode: 'none' } : {})
  }))
  ipcMain._invokeHandlers.set('providers:balance:query', async (_event, providerId) => ({
    providerId,
    status: 'ready',
    source: 'builtin',
    queriedAt: Date.now(),
    items: [{ label: 'Credits', unit: 'USD', remaining: 12.5 }]
  }))
  ipcMain._invokeHandlers.set('providers:authorization:accounts', async (_event, providerId) => providerId === alpha.id ? [
    {
      id: 'account-alpha-primary', providerId, service: 'xai-oauth', label: 'Primary account',
      authenticatedAt: Date.now() - 60_000, updatedAt: Date.now(), bound: true, requiresReauth: false, credentialStorage: 'encrypted',
      policy: authorizationPolicies.get('account-alpha-primary'), routingState: 'selected', routingReason: '首选模式使用绑定授权账号',
      quota: quotaFixture(providerId, 'account-alpha-primary', 23)
    },
    {
      id: 'account-alpha-secondary', providerId, service: 'xai-oauth', label: 'Secondary account',
      authenticatedAt: Date.now() - 120_000, updatedAt: Date.now() - 60_000, bound: false, requiresReauth: false, credentialStorage: 'encrypted',
      policy: authorizationPolicies.get('account-alpha-secondary'), routingState: 'available', routingReason: '可用于自动路由',
      quota: quotaFixture(providerId, 'account-alpha-secondary', 48)
    }
  ] : [])
  ipcMain._invokeHandlers.set('providers:authorization:quota', async (_event, providerId, accountId) =>
    quotaFixture(providerId, accountId || 'account-alpha-primary', accountId === 'account-alpha-secondary' ? 48 : 23))
  ipcMain._invokeHandlers.set('providers:authorization:bind', async (_event, providerId, accountId, mutation) => {
    if (mutation?.kind === 'routing-mode') authorizationRoutingMode = mutation.mode
    if (mutation?.kind === 'account-policy') {
      authorizationPolicies.set(accountId, { ...authorizationPolicies.get(accountId), ...mutation.policy })
    }
    return { ...alpha, authorization: { ...alpha.authorization, accountRoutingMode: authorizationRoutingMode } }
  })
  return () => {
    for (const [channel, handler] of originals) ipcMain._invokeHandlers.set(channel, handler)
  }
}

async function verifyInitialDashboard(win) {
  await waitForRenderer(win, `document.querySelectorAll('.provider-usage-request-table tbody tr').length === 3`)
  await settleRenderer(win)
  const ui = await readInitialDashboard(win)
  assertInitialOperationalSurface(ui)
  assertInitialMetrics(ui)
  check('request content and credential canaries never reach the DOM', !ui.privateCanary)
  check('initial queries keep request pages bounded', queries.length >= 2 && queries.every((query) => query.limit <= 25 && query.offset === 0))
  await capture(win, 'provider-settings-overview.png')
  await rendererValue(win, `document.querySelector('[data-provider-usage-dashboard]')?.scrollIntoView({ block: 'start' })`)
  await settleRenderer(win)
  await capture(win, 'provider-usage-dashboard.png')
}

function readInitialDashboard(win) {
  return rendererValue(win, `(() => {
    const dashboard = document.querySelector('[data-provider-usage-dashboard]');
    return {
      present: Boolean(dashboard),
      kpis: [...dashboard.querySelectorAll('.provider-usage-kpis strong')].map((item) => item.textContent.trim()),
      totalTokens: dashboard.querySelector('.provider-usage-total strong')?.textContent.trim(),
      heroSummary: [...dashboard.querySelectorAll('.provider-usage-hero-summary strong')].map((item) => item.textContent.trim()),
      text: dashboard.innerText,
      aggregateTables: dashboard.querySelectorAll('.provider-usage-aggregate table').length,
      requestRows: dashboard.querySelectorAll('.provider-usage-request-table tbody tr').length,
      viewTabs: dashboard.querySelectorAll('[data-provider-usage-view]').length,
      activeView: dashboard.querySelector('[data-provider-usage-view][aria-selected="true"]')?.getAttribute('data-provider-usage-view'),
      trend: Boolean(dashboard.querySelector('[data-provider-usage-trend]')),
      trendSeries: dashboard.querySelectorAll('.provider-usage-series').length,
      costSources: [...dashboard.querySelectorAll('.provider-usage-cost-source')].map((item) => ({
        label: item.querySelector('span')?.textContent.trim(),
        amount: item.querySelector('strong')?.textContent.trim(),
        requests: item.querySelector('small')?.textContent.trim()
      })),
      costDisclosure: dashboard.querySelector('.provider-usage-cost-provenance-head p')?.textContent.trim() || '',
      costWarning: Boolean(dashboard.querySelector('.provider-usage-cost-warning')),
      trendAxes: [...dashboard.querySelectorAll('.provider-usage-trend-y-axis')].map((axis) => [...axis.querySelectorAll('span')].map((item) => item.textContent.trim())),
      privateCanary: document.body.innerText.includes(${JSON.stringify(secretCanary)})
        || document.body.innerText.includes(${JSON.stringify(contentCanary)})
    };
  })()`)
}

function assertInitialOperationalSurface(ui) {
  const labels = ['真实消耗 Token', '缓存命中率', '成功率', '平均延迟', '计价覆盖率', '最近请求', '来源', '价格来源']
  const conditions = [
    ui.present,
    labels.every((text) => ui.text.includes(text)),
    ui.aggregateTables === 0,
    ui.viewTabs === 4,
    ui.activeView === 'requests',
    ui.trend,
    ui.trendSeries === 5,
    ui.costSources.length === 3,
    ui.costSources.map((item) => item.label).join(',') === 'Provider \u4e0a\u62a5,\u914d\u7f6e\u5b9a\u4ef7,\u5185\u7f6e\u5b9a\u4ef7',
    ui.costSources.map((item) => item.amount).join(',') === '$0.05,$0.01,$0.0010',
    ui.costDisclosure.includes('\u4e0d\u4ee3\u66ff Provider \u6700\u7ec8\u8d26\u5355'),
    !ui.costWarning,
    ui.trendAxes.length === 2,
    ui.trendAxes.every((axis) => axis.length === 5),
    ui.trendAxes[1].every((value) => value.startsWith('$')),
    ui.requestRows === 3
  ]
  check('usage dashboard renders the complete operational surface',
    conditions.every(Boolean),
    JSON.stringify({ totalTokens: ui.totalTokens, heroSummary: ui.heroSummary, kpis: ui.kpis, trendSeries: ui.trendSeries, trendAxes: ui.trendAxes, requestRows: ui.requestRows }))
}

function assertInitialMetrics(ui) {
  const conditions = [
    ui.totalTokens === '8.1k',
    ui.heroSummary[0] === '3',
    ui.heroSummary[1] === '$0.07',
    ui.kpis[0] === '100%',
    ui.kpis[1] === '210ms',
    ui.kpis[2] === '100%'
  ]
  check('initial metrics use full-range aggregates',
    conditions.every(Boolean),
    JSON.stringify({ totalTokens: ui.totalTokens, heroSummary: ui.heroSummary, kpis: ui.kpis }))
}

async function verifyUsageViews(win) {
  await rendererValue(win, `document.querySelector('[data-provider-usage-view="providers"]')?.click()`)
  await waitForRenderer(win, `document.querySelectorAll('.provider-usage-aggregate table').length === 1`)
  const providerRows = await rendererValue(win, `document.querySelectorAll('.provider-usage-aggregate tbody tr').length`)
  check('Provider statistics view is selectable', providerRows === 2, JSON.stringify({ providerRows }))
  await rendererValue(win, `document.querySelector('[data-provider-usage-view="models"]')?.click()`)
  await waitForRenderer(win, `document.querySelectorAll('.provider-usage-aggregate table').length === 1`)
  const modelRows = await rendererValue(win, `document.querySelectorAll('.provider-usage-aggregate tbody tr').length`)
  check('model statistics view is selectable', modelRows === 2, JSON.stringify({ modelRows }))
  await rendererValue(win, `document.querySelector('[data-provider-usage-view="credentials"]')?.click()`)
  await waitForRenderer(win, `document.querySelectorAll('.provider-usage-aggregate table').length === 1`)
  const credentialView = await rendererValue(win, `(() => ({
    rows: document.querySelectorAll('.provider-usage-aggregate tbody tr').length,
    text: document.querySelector('.provider-usage-aggregate')?.innerText || ''
  }))()`)
  check('credential billing view groups safe key identities without credential values',
    credentialView.rows === 3
      && credentialView.text.includes('Alpha Primary')
      && !credentialView.text.includes(secretCanary),
    JSON.stringify(credentialView))
  await rendererValue(win, `document.querySelector('[data-provider-usage-view="requests"]')?.click()`)
  await waitForRenderer(win, `document.querySelectorAll('.provider-usage-request-table tbody tr').length === 3`)
  await rendererValue(win, `document.querySelector('.provider-usage-row-toggle')?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('.provider-usage-request-detail'))`)
  const detail = await rendererValue(win, `(() => ({
    text: document.querySelector('.provider-usage-request-detail')?.innerText || '',
    source: document.querySelector('.provider-usage-request-detail')?.children[6]?.innerText || '',
    credential: document.querySelector('.provider-usage-request-detail')?.lastElementChild?.innerText || '',
    expanded: document.querySelector('.provider-usage-row-toggle')?.getAttribute('aria-expanded')
  }))()`)
  check('request billing detail expands with all token classes and source',
    ['输入', '输出', '缓存读取', '缓存写入'].every((label) => detail.text.includes(label))
      && detail.source.includes('caogen_workbench')
      && detail.credential.includes('sha256:')
      && detail.expanded === 'true',
    JSON.stringify(detail))
  await capture(win, 'provider-usage-request-detail.png')
  await rendererValue(win, `document.querySelector('.provider-usage-row-toggle')?.click()`)
  await waitForRenderer(win, `document.querySelectorAll('.provider-usage-request-table tbody tr').length === 3`)
}

async function verifyCredentialFilter(win) {
  const alphaKey = `sha256:${'a'.repeat(64)}`
  const options = await rendererValue(win, `(() => [...document.querySelectorAll('.provider-usage-filters select')[3].options].map((option) => ({ value: option.value, label: option.textContent.trim() })))()`)
  check('credential filter lists canonical safe IDs with readable saved names',
    options.some((option) => option.value === alphaKey && option.label.includes('Alpha Primary'))
      && options.every((option) => !option.label.includes(secretCanary)),
    JSON.stringify(options))
  const before = queries.length
  await setSelect(win, 3, alphaKey)
  await waitFor(() => queries.length >= before + 2, 5_000)
  await waitForRenderer(win, `document.querySelectorAll('.provider-usage-request-table tbody tr').length === 1`)
  const filtered = await rendererValue(win, `({
    credential: document.querySelector('.provider-usage-request-table tbody tr td:nth-child(12)')?.textContent.trim(),
    requests: document.querySelector('.provider-usage-hero-summary strong')?.textContent.trim()
  })`)
  check('credential filter scopes request log and billing totals',
    filtered.credential === 'Alpha Primary'
      && filtered.requests === '1'
      && queries.some((query) => query.keyLabel === alphaKey),
    JSON.stringify(filtered))
  await setSelect(win, 3, '')
  await waitForRenderer(win, `document.querySelectorAll('.provider-usage-request-table tbody tr').length === 3`)
}

async function verifySourceFilterAndAutoRefresh(win) {
  const sourceOptions = await rendererValue(win, `(() => [...document.querySelectorAll('.provider-usage-filters select')[2].options].map((option) => option.value))()`)
  check('source filter lists sanitized request origins',
    sourceOptions.includes('caogen_chat') && sourceOptions.includes('caogen_workbench'),
    JSON.stringify(sourceOptions))

  const beforeSource = queries.length
  await setSelect(win, 2, 'caogen_workbench')
  await waitFor(() => queries.length >= beforeSource + 2, 5_000)
  await waitForRenderer(win, `document.querySelectorAll('.provider-usage-request-table tbody tr').length === 2`)
  const sourceUi = await rendererValue(win, `({
    requestCount: document.querySelector('.provider-usage-hero-summary strong')?.textContent.trim(),
    sources: [...document.querySelectorAll('.provider-usage-request-table tbody tr td:nth-child(10)')].map((cell) => cell.textContent.trim())
  })`)
  check('source filter updates summary and request rows',
    sourceUi.requestCount === '2'
      && sourceUi.sources.length === 2
      && sourceUi.sources.every((source) => source === 'caogen_workbench')
      && queries.some((query) => query.source === 'caogen_workbench'),
    JSON.stringify(sourceUi))
  await setSelect(win, 2, '')
  await waitForRenderer(win, `document.querySelectorAll('.provider-usage-request-table tbody tr').length === 3`)

  const beforeRefresh = queries.length
  await rendererValue(win, `(() => {
    const select = document.querySelector('.provider-usage-refresh-interval select');
    select.value = '5000';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await waitFor(() => queries.length >= beforeRefresh + 2, 7_000)
  check('auto refresh re-queries the bounded ledger on the selected interval',
    queries.length >= beforeRefresh + 2,
    JSON.stringify({ beforeRefresh, afterRefresh: queries.length }))
  await rendererValue(win, `(() => {
    const select = document.querySelector('.provider-usage-refresh-interval select');
    select.value = '30000';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
}

async function verifyProviderAndModelFilters(win, alphaId) {
  await rendererValue(win, `document.querySelectorAll('.provider-usage-range button')[3]?.click()`)
  await waitForRenderer(win, `document.querySelectorAll('.provider-usage-request-table tbody tr').length === 4`)
  const unpricedWarning = await rendererValue(win, `document.querySelector('.provider-usage-cost-warning')?.textContent.trim() || ''`)
  check('unpriced requests warn that the displayed total can be below the invoice',
    unpricedWarning.includes('1') && unpricedWarning.includes('\u53ef\u80fd\u4f4e\u4e8e\u5b9e\u9645\u8d26\u5355'),
    unpricedWarning)
  const beforeProvider = queries.length
  await setSelect(win, 0, alphaId)
  await waitFor(() => queries.length >= beforeProvider + 2, 5_000)
  await waitForRenderer(win, `document.querySelectorAll('.provider-usage-request-table tbody tr').length === 2`)
  const providerUi = await rendererValue(win, `(() => ({
    providers: [...document.querySelectorAll('.provider-usage-request-table tbody tr td:nth-child(2)')].map((cell) => cell.textContent.trim()),
    models: [...document.querySelectorAll('.provider-usage-filters select:nth-of-type(1) option')].map((option) => option.textContent.trim()),
    allOptions: [...document.querySelectorAll('.provider-usage-filters select')[1].options].map((option) => option.value)
  }))()`)
  check('Provider filter limits request rows to the selected Provider',
    providerUi.providers.length === 2 && providerUi.providers.every((name) => name === 'Usage Alpha'),
    JSON.stringify(providerUi.providers))
  check('model choices are scoped to the selected Provider',
    providerUi.allOptions.includes('alpha-chat')
      && providerUi.allOptions.includes('alpha-code')
      && !providerUi.allOptions.includes('beta-reason'),
    JSON.stringify(providerUi.allOptions))

  const beforeModel = queries.length
  await setSelect(win, 1, 'alpha-code')
  await waitFor(() => queries.length >= beforeModel + 2, 5_000)
  await waitForRenderer(win, `document.querySelectorAll('.provider-usage-request-table tbody tr').length === 1`)
  const modelUi = await rendererValue(win, `(() => ({
    models: [...document.querySelectorAll('.provider-usage-request-table tbody tr td:nth-child(3)')].map((cell) => cell.textContent.trim()),
    requestCount: document.querySelector('.provider-usage-hero-summary strong')?.textContent.trim()
  }))()`)
  check('model filter updates both detail rows and summary metrics',
    modelUi.models.length === 1 && modelUi.models[0] === 'alpha-code' && modelUi.requestCount === '1',
    JSON.stringify(modelUi))
  check('filtered IPC query carries exact Provider and model IDs',
    queries.some((query) => query.providerId === alphaId && query.model === 'alpha-code'))
}

async function verifyRangeFilter(win) {
  const before = queries.length
  await rendererValue(win, `(() => {
    const button = [...document.querySelectorAll('.provider-usage-range button')]
      .find((candidate) => candidate.textContent.trim() === '24 小时');
    button?.click();
    return Boolean(button);
  })()`)
  await waitFor(() => queries.length >= before + 2, 5_000)
  await waitForRenderer(win, `document.querySelectorAll('.provider-usage-request-table tbody tr').length === 1`)
  const latest = queries[queries.length - 1]
  check('24-hour range resets the model and narrows the query window',
    !latest.model && latest.providerId && latest.to - latest.from >= 23.9 * 60 * 60 * 1000
      && latest.to - latest.from <= 24.1 * 60 * 60 * 1000,
    JSON.stringify({ hasModel: Boolean(latest.model), windowMs: latest.to - latest.from }))
  const selected = await rendererValue(win, `({
    range: document.querySelector('.provider-usage-range button.active')?.textContent.trim(),
    model: document.querySelectorAll('.provider-usage-filters select')[1]?.value,
    rows: document.querySelectorAll('.provider-usage-request-table tbody tr').length
  })`)
  check('range selection is visible and preserves a usable result', selected.range === '24 小时' && selected.model === '' && selected.rows === 1, JSON.stringify(selected))
}

async function verifyBillingReconciliation(win, alphaId) {
  const storeFile = path.join(userDataDir, 'provider-billing-statements.json')
  await createBillingStatement(win, storeFile)
  await verifyBillingStatementRestoration(win, alphaId)
  await verifyBillingCompactLayout(win)
  await deleteBillingStatement(win, storeFile)
  const firstSyncStore = await verifyOfficialBillingSync(win, storeFile)
  await verifyIdempotentBillingSync(win, storeFile, firstSyncStore)
  await capture(win, 'provider-billing-api-sync.png')
  await deleteBillingStatement(win, storeFile)
}

async function createBillingStatement(win, storeFile) {
  await waitForRenderer(win, `document.querySelector('.provider-billing-actions button:last-child')?.disabled === false`)
  const opened = await rendererValue(win, `(() => {
    const button = document.querySelector('.provider-billing-actions button:last-child');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`)
  if (!opened) throw new Error('provider billing add button was unavailable')
  await waitForRenderer(win, `Boolean(document.querySelector('.provider-billing-form'))`)
  const formReady = await rendererValue(win, `(() => {
    const form = document.querySelector('.provider-billing-form');
    const amount = form?.querySelector('input[type="number"]');
    const source = form?.querySelector('select');
    if (!form || !amount || !source) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(amount, '10');
    amount.dispatchEvent(new Event('input', { bubbles: true }));
    amount.dispatchEvent(new Event('change', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(source, 'invoice');
    source.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  check('official billing form accepts a bounded USD amount and fixed source', formReady)
  await rendererValue(win, `document.querySelector('.provider-billing-form-actions .btn-primary')?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('.provider-billing-row'))`, 15_000)
  const saved = await rendererValue(win, `(() => {
    const surface = document.querySelector('[data-provider-billing-reconciliation]');
    const row = surface?.querySelector('.provider-billing-row');
    return {
      status: row?.getAttribute('data-provider-billing-status'),
      values: [...(row?.querySelectorAll('.provider-billing-values strong') || [])].map((item) => item.textContent.trim()),
      reasonCount: row?.querySelectorAll('.provider-billing-reasons span').length || 0,
      secretCanary: surface?.innerText.includes(${JSON.stringify(secretCanary)}) || false
    };
  })()`)
  check('saved statement renders an incomplete result instead of a false match without complete local data',
    saved.status === 'incomplete' && saved.values.length === 4 && saved.reasonCount >= 1 && !saved.secretCanary,
    JSON.stringify(saved))
  check('billing statement is durably written to the isolated user-data store',
    fs.existsSync(storeFile) && JSON.parse(fs.readFileSync(storeFile, 'utf8')).statements.length === 1)
}

async function verifyBillingStatementRestoration(win, alphaId) {
  await rendererValue(win, `document.querySelector('[data-provider-surface="configuration"]')?.click()`)
  await waitForRenderer(win, `!document.querySelector('[data-provider-usage-dashboard]')`)
  await rendererValue(win, `document.querySelector('[data-provider-surface="usage"]')?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-usage-dashboard]'))`)
  await setSelect(win, 0, alphaId)
  await waitForRenderer(win, `Boolean(document.querySelector('.provider-billing-row'))`, 15_000)
  check('billing statement is restored after closing and reopening the usage surface',
    await rendererValue(win, `document.querySelectorAll('.provider-billing-row').length === 1`))
}

async function verifyBillingCompactLayout(win) {
  win.setSize(760, 700)
  await settleRenderer(win)
  await rendererValue(win, `document.querySelector('[data-provider-billing-reconciliation]')?.scrollIntoView({ block: 'start' })`)
  await settleRenderer(win)
  const compact = await rendererValue(win, `(() => {
    const surface = document.querySelector('[data-provider-billing-reconciliation]');
    const rect = surface?.getBoundingClientRect();
    return {
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      contained: Boolean(rect && rect.left >= -1 && rect.right <= window.innerWidth + 1),
      rowOverflow: [...surface.querySelectorAll('.provider-billing-row')]
        .some((row) => row.scrollWidth > row.clientWidth + 1)
    };
  })()`)
  check('billing reconciliation remains contained at 760px',
    !compact.pageOverflow && compact.contained && !compact.rowOverflow,
    JSON.stringify(compact))
  await capture(win, 'provider-billing-reconciliation.png')
  win.setSize(1200, 800)
}

async function deleteBillingStatement(win, storeFile) {
  await rendererValue(win, `(() => {
    window.confirm = () => true;
    document.querySelector('.provider-billing-remove')?.click();
  })()`)
  await waitForRenderer(win, `document.querySelectorAll('.provider-billing-row').length === 0`, 15_000)
  const afterDelete = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  check('billing statement can be deleted through the UI and stays deleted in the store',
    afterDelete.statements.length === 0)
}

async function verifyOfficialBillingSync(win, storeFile) {
  await waitForRenderer(win, `document.querySelector('.provider-billing-sync')?.disabled === false`)
  await rendererValue(win, `document.querySelector('.provider-billing-sync')?.click()`)
  await waitForRenderer(win, `document.querySelectorAll('.provider-billing-row').length === 1`, 15_000)
  await waitFor(() => billingRequests.length === 1, 5_000)
  const firstSyncStore = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  const syncedUi = await rendererValue(win, `(() => {
    const surface = document.querySelector('[data-provider-billing-reconciliation]');
    return {
      rows: surface?.querySelectorAll('.provider-billing-row').length || 0,
      text: surface?.innerText || '',
      hasSecret: surface?.innerText.includes(${JSON.stringify(secretCanary)}) || false
    };
  })()`)
  check('official billing API sync traverses renderer, IPC, fetch, store, and reconciliation',
    firstSyncStore.statements.length === 1
      && firstSyncStore.statements[0].source === 'provider-api'
      && firstSyncStore.statements[0].billedCostUsd === 10
      && syncedUi.rows === 1
      && syncedUi.text.includes('Provider \u5b98\u65b9 API')
      && !syncedUi.hasSecret,
    JSON.stringify({ rows: syncedUi.rows, source: firstSyncStore.statements[0]?.source, amount: firstSyncStore.statements[0]?.billedCostUsd }))
  check('official billing API receives only the selected period and safe request metadata',
    billingRequests[0].method === 'GET'
      && billingRequests[0].path === '/billing'
      && /^\d+$/.test(billingRequests[0].start)
      && /^\d+$/.test(billingRequests[0].end)
      && Number(billingRequests[0].end) > Number(billingRequests[0].start)
      && !JSON.stringify(billingRequests[0]).includes(secretCanary),
    JSON.stringify(billingRequests[0]))
  return firstSyncStore
}

async function verifyIdempotentBillingSync(win, storeFile, firstSyncStore) {
  const firstStatementId = firstSyncStore.statements[0].id
  await rendererValue(win, `document.querySelector('.provider-billing-sync')?.click()`)
  await waitFor(() => billingRequests.length === 2, 5_000)
  await waitFor(() => JSON.parse(fs.readFileSync(storeFile, 'utf8')).revision >= firstSyncStore.revision + 1, 5_000)
  const secondSyncStore = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  check('repeated same-period official sync updates idempotently',
    secondSyncStore.statements.length === 1 && secondSyncStore.statements[0].id === firstStatementId)
}

async function verifyCompactLayout(win) {
  win.setSize(760, 700)
  await settleRenderer(win)
  await rendererValue(win, `document.querySelector('[data-provider-usage-dashboard]')?.scrollIntoView({ block: 'start' })`)
  await settleRenderer(win)
  const compact = await rendererValue(win, `(() => {
    const dashboard = document.querySelector('[data-provider-usage-dashboard]');
    const rect = dashboard.getBoundingClientRect();
    const buttons = [...dashboard.querySelectorAll('.provider-usage-range button')];
    const selects = [...dashboard.querySelectorAll('.provider-usage-filters select')];
    const tableWrap = dashboard.querySelector('.provider-usage-request-table')?.parentElement;
    return {
      width: window.innerWidth,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      dashboardContained: rect.left >= -1 && rect.right <= window.innerWidth + 1,
      controlsFit: [...buttons, ...selects].every((item) => item.scrollWidth <= item.clientWidth + 1),
      tableScrollIsContained: Boolean(tableWrap && tableWrap.scrollWidth > tableWrap.clientWidth && tableWrap.getBoundingClientRect().right <= window.innerWidth + 1)
    };
  })()`)
  check('dashboard remains contained at 760x700 without page-level overflow',
    compact.width <= 760 && !compact.documentOverflow && compact.dashboardContained,
    JSON.stringify(compact))
  check('compact controls fit and wide request detail scrolls inside its table region',
    compact.controlsFit && compact.tableScrollIsContained,
    JSON.stringify(compact))
  await capture(win, 'provider-usage-dashboard-compact.png')
  check('desktop and compact screenshots were written',
    fs.existsSync(path.join(screenshotDir, 'provider-usage-dashboard.png'))
      && fs.existsSync(path.join(screenshotDir, 'provider-usage-dashboard-compact.png')))
}

async function verifyProviderInformationOrder(win) {
  win.setSize(1200, 800)
  await rendererValue(win, `document.querySelector('[data-provider-surface="configuration"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('[data-provider-balance-overview]')?.innerText.includes('12.5')`)
  await waitForRenderer(win, `document.querySelector('[data-provider-authorization-overview] select')?.options.length === 3`)
  await settleRenderer(win)
  const order = await rendererValue(win, `(() => {
    const list = document.querySelector('.provider-list');
    const overview = document.querySelector('[data-provider-account-overview]');
    return {
      listTop: list?.getBoundingClientRect().top,
      overviewPresent: Boolean(overview),
      configurationActive: document.querySelector('[data-provider-surface="configuration"]')?.getAttribute('aria-current'),
      usageMounted: Boolean(document.querySelector('[data-provider-usage-dashboard]')),
      metricCount: overview?.querySelectorAll('.provider-account-metric').length || 0,
      balanceText: overview?.querySelector('[data-provider-balance-overview]')?.innerText || '',
      authorizationText: overview?.querySelector('[data-provider-authorization-overview]')?.innerText || '',
      authorizationOptions: overview?.querySelector('[data-provider-authorization-overview] select')?.options.length || 0
    };
  })()`)
  check('Provider configuration and billing are isolated peer views',
    Number.isFinite(order.listTop) && order.overviewPresent && order.metricCount === 4
      && order.configurationActive === 'page' && !order.usageMounted,
    JSON.stringify(order))
  check('Provider account overview renders normalized live balance without credential material',
    order.balanceText.includes('12.5') && order.balanceText.includes('USD') && !order.balanceText.includes(secretCanary),
    JSON.stringify({ balanceText: order.balanceText }))
  check('Provider account overview exposes multiple OAuth accounts without token material',
    order.authorizationOptions === 3
      && order.authorizationText.includes('Primary account')
      && !order.authorizationText.includes(secretCanary),
    JSON.stringify({ authorizationOptions: order.authorizationOptions, authorizationText: order.authorizationText }))
}

async function verifyProviderConnectionDiagnostic(win, provider) {
  installConnectionDiagnosticFixture(provider)
  await triggerConnectionDiagnostic(win, provider)
  await verifyProviderEditorNavigation(win)
  await verifyAuthorizationRouting(win)
  await updateAuthorizationRouting(win, provider)
  await verifyConnectionDiagnosticDetails(win)
  await verifyConnectionDiagnosticRepairAction(win)
  await verifyRuntimeConfigPanel(win)
  await verifyBillingQueryConfigPanel(win)
  win.setSize(1200, 800)
}

function installConnectionDiagnosticFixture(provider) {
  ipcMain._invokeHandlers.set('providers:fetchModels', async () => ({
    ok: false,
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    cacheKey: `${provider.id}|diagnostic`,
    models: [],
    stale: true,
    error: {
      kind: 'auth',
      message: 'Base URL 路径与鉴权结果不一致，请同时检查 Base URL、API Key 和鉴权头',
      status: 401,
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      reasonCode: 'base_url_or_credentials_mismatch',
      suggestedAction: 'review_base_url_and_credentials',
      credentialStyle: { authMode: 'api-key', headerNames: ['Authorization'] },
      diagnosticContext: {
        engine: 'openai',
        generationProtocol: 'openai-chat-completions',
        generationEndpointPath: '/v1/chat/completions',
        credentialSource: 'stored-active',
        credentialLabel: 'Primary account',
        catalogProbeOnly: true
      },
      attempts: [
        { endpointPath: '/v1/models', result: 'auth', status: 401 },
        { endpointPath: '/models', result: 'not_found', status: 404 }
      ]
    }
  }))
}

async function triggerConnectionDiagnostic(win, provider) {
  const probeClicked = await rendererValue(win, `(() => {
    const row = [...document.querySelectorAll('.provider-row')]
      .find((candidate) => candidate.querySelector('.provider-row-name')?.textContent.includes(${JSON.stringify(provider.name)}));
    const button = row?.querySelector('.provider-row-actions button');
    button?.click();
    return Boolean(button);
  })()`)
  check('Provider probe can be triggered from the primary Provider list', probeClicked)
  await waitForRenderer(win, `Boolean(document.querySelector('.provider-probe-bad button'))`)
  await rendererValue(win, `document.querySelector('.provider-probe-bad button')?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-connection-diagnostic]'))`)
}

async function verifyProviderEditorNavigation(win) {
  const editorNavigation = await rendererValue(win, `({
    items: document.querySelectorAll('.provider-editor-section-nav button').length,
    pricingTarget: Boolean(document.querySelector('[data-provider-model-catalog]')),
    reliabilityTarget: Boolean(document.querySelector('[data-provider-reliability-config]'))
  })`)
  check('Provider editor exposes direct authorization, connection, model, pricing, and reliability navigation',
    editorNavigation.items === 5 && editorNavigation.pricingTarget && editorNavigation.reliabilityTarget,
    JSON.stringify(editorNavigation))
}

async function verifyAuthorizationRouting(win) {
  await waitForRenderer(win, `document.querySelectorAll('[data-provider-authorization-routing] .provider-authorization-routing-account').length === 2`)
  const authorizationRouting = await rendererValue(win, `(() => {
    const routing = document.querySelector('[data-provider-authorization-routing]');
    const modeButtons = [...routing.querySelectorAll('.segmented-control button')];
    const rows = [...routing.querySelectorAll('.provider-authorization-routing-account')];
    return {
      modeCount: modeButtons.length,
      activeMode: modeButtons.find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent,
      rows: rows.length,
      text: routing.innerText,
      bodyHasSecret: document.body.innerText.includes(${JSON.stringify(secretCanary)})
    };
  })()`)
  check('OAuth account routing UI exposes three modes and two policy rows',
    authorizationRouting.modeCount === 3 && authorizationRouting.rows === 2
      && authorizationRouting.text.includes('Primary account')
      && authorizationRouting.text.includes('Secondary account')
      && !authorizationRouting.bodyHasSecret,
    JSON.stringify(authorizationRouting))
  await rendererValue(win, `document.querySelector('[data-provider-authorization-routing]')?.scrollIntoView({ block: 'start' })`)
  await settleRenderer(win)
  await capture(win, 'provider-authorization-routing.png')
}

async function updateAuthorizationRouting(win, provider) {
  await rendererValue(win, `(async () => {
    await window.agentDesk.bindProviderAuthorizationAccount(
      ${JSON.stringify(provider.id)}, '', { kind: 'routing-mode', mode: 'automatic' }
    );
    await window.agentDesk.bindProviderAuthorizationAccount(
      ${JSON.stringify(provider.id)}, 'account-alpha-primary',
      { kind: 'account-policy', policy: { priority: 7 } }
    );
  })()`)
  check('OAuth routing mode and account priority save through real renderer IPC',
    authorizationRoutingMode === 'automatic'
      && authorizationPolicies.get('account-alpha-primary')?.priority === 7)
}

async function verifyConnectionDiagnosticDetails(win) {
  const diagnostic = await rendererValue(win, `(() => {
    const panel = document.querySelector('[data-provider-connection-diagnostic]');
    return {
      text: panel?.innerText || '',
      paths: [...panel.querySelectorAll('.provider-diagnostic-attempts code')].map((item) => item.textContent.trim()),
      bodyHasSecret: document.body.innerText.includes(${JSON.stringify(secretCanary)})
    };
  })()`)
  check('401 diagnostics expose endpoint paths, statuses, and credential header style',
    diagnostic.text.includes('HTTP 401')
      && diagnostic.text.includes('Authorization')
      && diagnostic.paths.join(',') === '/v1/models,/models',
    JSON.stringify({ paths: diagnostic.paths, text: diagnostic.text }))
  check('401 diagnostics do not expose credential values', !diagnostic.bodyHasSecret)

  await capture(win, 'provider-connection-diagnostic.png')
}

async function verifyConnectionDiagnosticRepairAction(win) {
  await rendererValue(win, `document.querySelector('[data-provider-connection-diagnostic] button')?.click()`)
  const focusedField = await rendererValue(win, `document.activeElement?.getAttribute('data-provider-field')`)
  check('diagnostic action focuses the Base URL field for repair', focusedField === 'base-url', String(focusedField))
}

async function verifyRuntimeConfigPanel(win) {
  await rendererValue(win, `document.querySelector('[data-provider-runtime-config]')?.scrollIntoView({ block: 'start' })`)
  await settleRenderer(win)
  const runtimePanel = await rendererValue(win, `(() => {
    const panel = document.querySelector('[data-provider-runtime-config]');
    return {
      present: Boolean(panel),
      fields: panel?.querySelectorAll('input, select').length || 0,
      text: panel?.innerText || '',
      overflow: panel ? panel.scrollWidth > panel.clientWidth + 1 : true
    };
  })()`)
  check('structured runtime panel exposes bounded Codex request controls',
    runtimePanel.present
      && runtimePanel.fields === 8
      && ['推理强度', '输出详细度', '最大输出 Token', '并行工具调用', '服务端保存响应'].every((label) => runtimePanel.text.includes(label))
      && !runtimePanel.overflow,
    JSON.stringify(runtimePanel))
  await capture(win, 'provider-runtime-config.png')
}

async function verifyBillingQueryConfigPanel(win) {
  await rendererValue(win, `document.querySelector('[data-provider-billing-query]')?.scrollIntoView({ block: 'start' })`)
  await settleRenderer(win)
  win.setSize(760, 700)
  await settleRenderer(win)
  const billingConfig = await rendererValue(win, `(() => {
    const panel = document.querySelector('[data-provider-billing-query]');
    const controls = [...(panel?.querySelectorAll('input, select, textarea') || [])];
    return {
      present: Boolean(panel),
      controls: controls.length,
      text: panel?.innerText || '',
      panelOverflow: panel ? panel.scrollWidth > panel.clientWidth + 1 : true,
      clippedControls: controls.filter((control) => control.getBoundingClientRect().right > window.innerWidth + 1).length,
      bodyHasSecret: document.body.innerText.includes(${JSON.stringify(secretCanary)})
    };
  })()`)
  check('official billing API visual config is complete and contained at 760px',
    billingConfig.present
      && billingConfig.controls >= 14
      && billingConfig.text.includes('\u5b98\u65b9\u8d26\u5355 API')
      && billingConfig.text.includes('Unix s')
      && !billingConfig.panelOverflow
      && billingConfig.clippedControls === 0
      && !billingConfig.bodyHasSecret,
    JSON.stringify(billingConfig))
  await capture(win, 'provider-billing-api-config.png')
}

function accountPolicy(priority) {
  return {
    enabled: true,
    priority,
    minimumQuotaRemainingPercent: 10,
    requireKnownQuota: false,
    failureCooldownMinutes: 5
  }
}

function quotaFixture(providerId, accountId, utilization) {
  return {
    providerId,
    accountId,
    status: 'ready',
    tiers: [{ name: 'five_hour', utilization, windowSeconds: 18_000, resetsAt: Date.now() + 3_600_000 }],
    queriedAt: Date.now()
  }
}

function createAttempts(alphaId, betaId) {
  const now = Date.now()
  return [
    request('alpha-recent', alphaId, 'alpha-chat', 'succeeded', now - 60 * 60 * 1000, 300, 0.012, 'provider-pricing', 1200, 500, 300, 0, 'caogen_chat', `sha256:${'a'.repeat(64)}`, 'Alpha Primary'),
    request('alpha-old', alphaId, 'alpha-code', 'failed', now - 3 * 24 * 60 * 60 * 1000, 900, undefined, 'unpriced', 800, 50, 0, 0, 'caogen_chat', `sha256:${'a'.repeat(64)}`, 'Alpha Primary'),
    request('beta-success', betaId, 'beta-reason', 'succeeded', now - 2 * 60 * 60 * 1000, 120, 0.054, 'reported', 4000, 1100, 800, 100, 'caogen_workbench', `sha256:${'b'.repeat(64)}`, 'Beta Workload'),
    request('beta-running', betaId, 'beta-reason', 'started', now - 20 * 60 * 1000, undefined, 0.001, 'builtin-pricing', 100, 0, 0, 0, 'caogen_workbench', `sha256:${'c'.repeat(64)}`, 'Beta Backup')
  ]
}

function request(attemptId, providerId, model, status, startedAt, latencyMs, costUsd, costSource, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, source, keyLabel, credentialName) {
  return {
    attemptId, providerId, model, status, outcome: status === 'succeeded' ? 'success' : status === 'failed' ? 'error' : undefined,
    source, keyLabel, credentialName,
    startedAt, completedAt: status === 'started' ? undefined : startedAt + latencyMs,
    latencyMs, usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, costUsd, costSource
  }
}

function summarize(attempts, providerNames, query) {
  const now = Date.now()
  const from = Number.isSafeInteger(query.from) ? query.from : now - 30 * 24 * 60 * 60 * 1000
  const to = Number.isSafeInteger(query.to) ? query.to : now
  const rows = attempts
    .filter((item) => item.startedAt >= from && item.startedAt <= to)
    .filter((item) => !query.providerId || item.providerId === query.providerId)
    .filter((item) => !query.model || item.model.toLowerCase() === String(query.model).toLowerCase())
    .filter((item) => !query.source || item.source.toLowerCase() === String(query.source).toLowerCase())
    .filter((item) => !query.keyLabel || item.keyLabel.toLowerCase() === String(query.keyLabel).toLowerCase())
    .sort((left, right) => right.startedAt - left.startedAt)
  const providers = aggregate(rows, (item) => [item.providerId, providerNames.get(item.providerId) || item.providerId])
  const models = aggregate(rows, (item) => [item.model, item.model])
  const credentials = aggregate(rows, (item) => [
    `${item.providerId}:${item.keyLabel || 'none'}`,
    `${providerNames.get(item.providerId) || item.providerId} / ${item.credentialName || shortCredential(item.keyLabel)}`
  ]).map((item) => {
    const sample = rows.find((row) => `${row.providerId}:${row.keyLabel || 'none'}` === item.id)
    return { ...item, providerId: sample?.providerId || '', keyLabel: sample?.keyLabel }
  })
  const latencyRows = rows.filter((item) => Number.isFinite(item.latencyMs) && item.latencyMs >= 0)
  const pricedRequests = rows.filter((item) => item.costUsd !== undefined).length
  const offset = Math.max(0, Math.min(rows.length, Number(query.offset) || 0))
  const limit = Math.min(Number(query.limit) || 100, 10_000)
  return {
    from, to,
    requests: rows.length,
    succeeded: rows.filter((item) => item.status === 'succeeded').length,
    failed: rows.filter((item) => item.status === 'failed' || item.status === 'cancelled').length,
    inputTokens: sum(rows, (item) => item.usage?.inputTokens),
    outputTokens: sum(rows, (item) => item.usage?.outputTokens),
    cacheReadTokens: sum(rows, (item) => item.usage?.cacheReadTokens),
    cacheWriteTokens: sum(rows, (item) => item.usage?.cacheWriteTokens),
    costUsd: round(sum(rows, (item) => item.costUsd)),
    averageLatencyMs: latencyRows.length ? Math.round(sum(latencyRows, (item) => item.latencyMs) / latencyRows.length) : undefined,
    latencySamples: latencyRows.length,
    pricedRequests,
    unpricedRequests: rows.length - pricedRequests,
    costSources: summarizeCostSources(rows),
    requestsByProvider: providers,
    requestsByModel: models,
    requestsByCredential: credentials,
    sources: [...new Set(rows.map((item) => item.source))].sort(),
    buckets: buildBuckets(rows, from, to, Number(query.bucketCount) || 24),
    recentOffset: offset,
    recentTotal: rows.length,
    recentHasMore: offset + limit < rows.length,
    recentRequests: rows.slice(offset, offset + limit)
  }
}

function summarizeCostSources(rows) {
  return ['reported', 'provider-pricing', 'builtin-pricing', 'imported', 'unpriced']
    .map((source) => ({
      source,
      requests: rows.filter((item) => item.costSource === source).length,
      costUsd: round(sum(rows.filter((item) => item.costSource === source), (item) => item.costUsd))
    }))
    .filter((item) => item.requests > 0)
}

function buildBuckets(rows, from, to, count) {
  const span = Math.max(1, to - from)
  const size = span / count
  const buckets = Array.from({ length: count }, (_, index) => ({
    from: Math.round(from + index * size),
    to: Math.round(index === count - 1 ? to : from + (index + 1) * size),
    requests: 0,
    succeeded: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0
  }))
  for (const row of rows) {
    const index = Math.max(0, Math.min(count - 1, Math.floor((row.startedAt - from) / size)))
    const bucket = buckets[index]
    bucket.requests += 1
    if (row.status === 'succeeded') bucket.succeeded += 1
    if (row.status === 'failed' || row.status === 'cancelled') bucket.failed += 1
    bucket.inputTokens += row.usage?.inputTokens || 0
    bucket.outputTokens += row.usage?.outputTokens || 0
    bucket.cacheReadTokens += row.usage?.cacheReadTokens || 0
    bucket.cacheWriteTokens += row.usage?.cacheWriteTokens || 0
    bucket.costUsd += row.costUsd || 0
  }
  return buckets
}

function aggregate(rows, identity) {
  const values = new Map()
  for (const row of rows) {
    const [id, label] = identity(row)
    const item = values.get(id) || { id, label, requests: 0, succeeded: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
    item.requests += 1
    if (row.status === 'succeeded') item.succeeded += 1
    if (row.status === 'failed' || row.status === 'cancelled') item.failed += 1
    item.inputTokens += row.usage?.inputTokens || 0
    item.outputTokens += row.usage?.outputTokens || 0
    item.cacheReadTokens += row.usage?.cacheReadTokens || 0
    item.cacheWriteTokens += row.usage?.cacheWriteTokens || 0
    item.costUsd = round(item.costUsd + (row.costUsd || 0))
    values.set(id, item)
  }
  return [...values.values()].sort((left, right) => right.costUsd - left.costUsd || right.requests - left.requests)
}

function sum(rows, select) { return rows.reduce((total, row) => total + (select(row) || 0), 0) }
function round(value) { return Math.round(value * 1_000_000) / 1_000_000 }
function shortCredential(value) { return value?.startsWith('sha256:') ? `SHA-256 ${value.slice(7, 15)}...${value.slice(-4)}` : 'No credential' }

async function openProviderSettings() {
  const win = await waitForWindow()
  win.setSize(1200, 800)
  await waitForRenderer(win, `document.body.innerText.includes('CaoGen')`)
  await clickRendererText(win, '设置')
  await waitForRenderer(win, `Boolean(document.querySelector('.settings-page'))`)
  await rendererValue(win, `document.querySelector('[data-settings-tab="providers"]')?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-surface="usage"]'))`)
  await rendererValue(win, `document.querySelector('[data-provider-surface="usage"]')?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-usage-dashboard]'))`)
  return win
}

async function setSelect(win, index, value) {
  const changed = await rendererValue(win, `(() => {
    const select = document.querySelectorAll('.provider-usage-filters select')[${index}];
    if (!select) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value === ${JSON.stringify(value)};
  })()`)
  if (!changed) throw new Error(`usage select ${index} could not select ${value}`)
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

async function clickRendererText(win, text) {
  const clicked = await rendererValue(win, `(() => {
    const target = ${JSON.stringify(text)};
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent.trim().includes(target));
    button?.click();
    return Boolean(button);
  })()`)
  if (!clicked) throw new Error(`renderer button not found: ${text}`)
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
        // Renderer and IPC registration are asynchronous during startup.
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('provider usage dashboard wait timed out'))
      setTimeout(() => void poll(), 100)
    }
    void poll()
  })
}

function finish(code) { app.exit(code) }
function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`missing ${name}`)
  return value
}

app.whenReady().then(() => run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  finish(1)
}))
