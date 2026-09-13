const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { runProviderAnthropicRuntimeUiE2E } = require('./lib/provider-anthropic-runtime-ui-e2e.cjs')
const { verifyProviderPricingCatalogUi } = require('./lib/provider-pricing-catalog-ui-e2e.cjs')

const repoRoot = path.resolve(__dirname, '..')
const outMain = path.join(repoRoot, 'out', 'main', 'index.js')
const userDataDir = requiredEnv('CAOGEN_PROVIDER_PROFILE_USER_DATA')
const statePath = requiredEnv('CAOGEN_PROVIDER_PROFILE_STATE')
const importPath = requiredEnv('CAOGEN_PROVIDER_PROFILE_IMPORT')
const exportPath = requiredEnv('CAOGEN_PROVIDER_PROFILE_EXPORT')
const screenshotDir = requiredEnv('CAOGEN_PROVIDER_PROFILE_SCREENSHOT_DIR')
const phase = requiredEnv('CAOGEN_PROVIDER_PROFILE_PHASE')
const primaryCredentialCanary = ['profile', 'primary', 'canary'].join('-')
process.env.CAOGEN_USER_DATA_DIR = userDataDir

dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath })
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [importPath] })

const checks = []

function check(name, condition, detail = '') {
  checks.push({ name, status: condition ? 'pass' : 'fail', detail })
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`)
  if (!condition) throw new Error(`${name}: ${detail || 'failed'}`)
}

async function invoke(channel, ...args) {
  const handler = ipcMain._invokeHandlers?.get(channel)
  if (!handler) throw new Error(`IPC channel not registered: ${channel}`)
  const win = await waitForWindow()
  const sender = win.webContents
  await waitFor(() => {
    const frameUrl = sender.mainFrame?.url || ''
    return !sender.isDestroyed() && frameUrl.startsWith('file:')
  }, 10_000)
  return handler({ sender, senderFrame: sender.mainFrame }, ...args)
}

function invokeProfile(action, ...args) {
  return invoke('appFeatures:invoke', 'provider-profile', action, ...args)
}

async function rejectedMessage(action) {
  try {
    await action()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected action to reject')
}

async function run() {
  require(outMain)
  await waitFor(() => ipcMain._invokeHandlers?.has('appFeatures:invoke'), 10_000)
  if (phase === 'apply') await runApplyPhase()
  else if (phase === 'rollback') await runRollbackPhase()
  else if (phase === 'ui') await runUiPhase()
  else if (phase === 'pricing') await runPricingPhase()
  else if (phase === 'anthropic-runtime') await runProviderAnthropicRuntimeUiE2E({
    invoke, openProviderProfileSettings, openProviderEditor, rendererValue, waitForRenderer,
    settleRenderer, captureUiScreenshot, clickProviderEditorSave, clickProviderEditorCancel, check, checks,
    screenshotDir, statePath
  })
  else throw new Error('unknown provider profile phase')
  finish(0)
}

async function runApplyPhase() {
  const initial = await createInitialKeyedProvider()
  await verifyCredentialFreeExport()
  await verifyRejectedProfileImports()
  writePortableProfileImport()
  const applied = await applyPortableProfile(initial)
  await verifyCredentialFreeBackup(initial, applied)
  persistApplyState(initial, applied)
}

async function createInitialKeyedProvider() {
  const initial = await invoke('providers:create', {
    name: 'Alpha Profile',
    baseUrl: 'https://alpha-old.example/v1',
    token: primaryCredentialCanary,
    models: ['alpha-old'],
    engine: 'openai',
    openaiProtocol: 'chat'
  })
  check('initial provider created', initial.hasToken === true)
  return initial
}

async function verifyCredentialFreeExport() {
  const exported = await invokeProfile('export')
  const exportedRaw = fs.readFileSync(exportPath, 'utf8')
  check('credential-free export completes', !exported.canceled && exported.providerCount === 1)
  check('export excludes plaintext and credential records',
    !exportedRaw.includes(primaryCredentialCanary)
      && !/(?:apiKeys|encryptedToken|activeKeyId|tokenLabel)/.test(exportedRaw))
  checkPrivateMode('export file is private by default', exportPath, 0o600)
}

async function verifyRejectedProfileImports() {
  const urlCredential = ['profile', 'url', 'canary'].join('-')
  fs.writeFileSync(importPath, JSON.stringify({
    kind: 'caogen-provider-profile',
    schemaVersion: 1,
    providers: [{
      name: 'Sensitive URL Profile',
      baseUrl: `https://user:${urlCredential}@gateway.example/v1`,
      models: ['sensitive-model'],
      engine: 'openai',
      openaiProtocol: 'chat'
    }]
  }), { mode: 0o600 })
  const sensitiveUrlError = await rejectedMessage(() => invokeProfile('preview'))
  check('sensitive Base URL is rejected before renderer preview',
    /Base URL|用户名|密码|userinfo/.test(sensitiveUrlError) && !sensitiveUrlError.includes(urlCredential))

  fs.writeFileSync(importPath, JSON.stringify({
    kind: 'caogen-provider-profile',
    schemaVersion: 1,
    providers: [{
      name: 'Remote no-auth Profile',
      baseUrl: 'https://remote.example/v1',
      models: ['remote-model'],
      engine: 'openai',
      authMode: 'none',
      openaiProtocol: 'chat'
    }]
  }), { mode: 0o600 })
  const remoteNoAuthError = await rejectedMessage(() => invokeProfile('preview'))
  check('remote authMode none is rejected before renderer preview', /回环|无需密钥/.test(remoteNoAuthError))
}

function writePortableProfileImport() {
  const ignoredCredential = ['profile', 'ignored', 'canary'].join('-')
  fs.writeFileSync(importPath, JSON.stringify({
    kind: 'caogen-provider-profile',
    schemaVersion: 1,
    providers: [
      {
        name: 'Alpha Profile',
        baseUrl: 'https://alpha-old.example/v1',
        models: ['alpha-new'],
        engine: 'openai',
        openaiProtocol: 'chat',
        apiKey: ignoredCredential
      },
      {
        name: 'New Portable Profile',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: ['local-new'],
        engine: 'openai',
        authMode: 'none',
        openaiProtocol: 'chat'
      }
    ]
  }, null, 2), { mode: 0o600 })
}

async function applyPortableProfile(initial) {
  const preview = await invokeProfile('preview')
  check('import previews update and create',
    preview.updateCount === 1 && preview.createCount === 1 && preview.items.length === 2)
  check('import ignores credential fields', preview.credentialFieldsIgnored === 1)
  check('preview preserves local no-auth mode without exposing credentials',
    preview.items.find((item) => item.name === 'New Portable Profile')?.authMode === 'none')

  await invoke('providers:update', initial.id, { models: ['alpha-preview-drift'] })
  const backupsBeforeStaleApply = await invokeProfile('backups')
  const stalePreviewError = await rejectedMessage(() => invokeProfile('apply', preview.previewId, []))
  check(
    'apply rejects Provider configuration drift after preview',
    /预览后已变化|重新预览/.test(stalePreviewError),
    stalePreviewError
  )
  const afterStaleApply = await invoke('providers:list')
  check('stale preview creates no backup and preserves concurrent state',
    (await invokeProfile('backups')).length === backupsBeforeStaleApply.length
      && afterStaleApply.length === 1
      && afterStaleApply[0]?.models.join(',') === 'alpha-preview-drift')
  const consumedPreviewError = await rejectedMessage(() => invokeProfile('apply', preview.previewId, []))
  check('stale preview is invalidated after rejection', /预览已失效/.test(consumedPreviewError))
  const reboundPreview = await invokeProfile('preview')
  const applied = await invokeProfile('apply', reboundPreview.previewId, [])
  check('successful profile apply creates a pre-change backup',
    applied.created === 1 && applied.updated === 1 && applied.backup.providerCount === 1)
  const alpha = applied.providers.find((provider) => provider.id === initial.id)
  const portable = applied.providers.find((provider) => provider.name === 'New Portable Profile')
  check('updated provider preserves credential state', alpha?.models.join(',') === 'alpha-new' && alpha.hasToken === true)
  check('new local no-auth provider survives create and is immediately routable',
    portable?.hasToken === false && portable?.authMode === 'none' && portable?.ready === true)
  return applied
}

async function verifyCredentialFreeBackup(initial, applied) {
  const backups = await invokeProfile('backups')
  check('backup metadata is available without contents',
    backups.some((backup) => backup.id === applied.backup.id))
  verifyCredentialFreeBackupFile(initial, applied)
}

function verifyCredentialFreeBackupFile(initial, applied) {
  const backupDir = path.join(userDataDir, 'provider-profile-backups')
  checkPrivateMode('backup directory is private', backupDir, 0o700)
  const backupFile = path.join(backupDir, `${applied.backup.id}.json`)
  checkPrivateMode('backup file is private', backupFile, 0o600)
  const backupRaw = fs.readFileSync(backupFile, 'utf8')
  const backupDocument = JSON.parse(backupRaw)
  const alphaBackup = backupDocument.providers.find((provider) => provider.id === initial.id)
  check('backup metadata counts the excluded credential',
    initial.credentialStorage === 'encrypted'
      ? applied.backup.excludedCredentialCount >= 1
      : applied.backup.nonPersistentCredentialCount >= 1)
  check('backup excludes persistent and session credential records',
    alphaBackup?.encryptedToken === ''
      && Array.isArray(alphaBackup.apiKeys)
      && alphaBackup.apiKeys.length === 0
      && !alphaBackup.activeKeyId
      && !backupRaw.includes('enc:')
      && !backupRaw.includes('"sessionOnly"'))
  if (initial.credentialStorage === 'encrypted') {
    check('credential-free backup marks the Provider for explicit re-entry',
      alphaBackup?.credentialMigrationRequired === true)
  }
  check('backup contains zero credential canary material', !backupRaw.includes(primaryCredentialCanary))
}

function persistApplyState(initial, applied) {
  check('apply state report contains zero credential canary material',
    !JSON.stringify({ backupId: applied.backup.id, initialProviderId: initial.id, checks })
      .includes(primaryCredentialCanary))
  const applyState = JSON.stringify({
    backupId: applied.backup.id,
    initialProviderId: initial.id,
    initialCredentialStorage: initial.credentialStorage,
    checks
  }, null, 2)
  if (applyState.includes(primaryCredentialCanary)) throw new Error('apply state contains credential canary material')
  fs.writeFileSync(statePath, applyState)
}

async function runRollbackPhase() {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const before = await invoke('providers:list')
  const alphaBefore = before.find((provider) => provider.id === state.initialProviderId)
  const portableBefore = before.find((provider) => provider.name === 'New Portable Profile')
  check('imported profile survives restart',
    before.length === 2 && alphaBefore?.models.join(',') === 'alpha-new')
  check('imported local no-auth mode survives restart',
    portableBefore?.authMode === 'none' && portableBefore?.ready === true && portableBefore?.hasToken === false)
  if (state.initialCredentialStorage === 'encrypted') {
    check('encrypted credential survives restart', alphaBefore?.hasToken === true)
  } else {
    check('session-only credential stays non-persistent', alphaBefore?.hasToken === false)
  }

  const backupCountBeforeRollback = (await invokeProfile('backups')).length
  const rolledBack = await invokeProfile('rollback', state.backupId)
  const alpha = rolledBack.providers.find((provider) => provider.id === state.initialProviderId)
  check('rollback restores original provider set', rolledBack.providers.length === 1 && Boolean(alpha))
  check('rollback restores the latest pre-apply provider configuration',
    alpha?.models.join(',') === 'alpha-preview-drift',
    `models=${alpha?.models.join(',') || '<missing>'}`)
  check('rollback restores configuration without any credential record',
    alpha?.hasToken === false
      && alpha?.ready === false
      && (alpha?.keyCount ?? 0) === 0
      && (alpha?.apiKeys?.length ?? 0) === 0)
  if (state.initialCredentialStorage === 'encrypted') {
    check('rollback of a formerly encrypted key requires explicit credential re-entry',
      alpha?.credentialMigrationRequired === true)
  }
  const backups = await invokeProfile('backups')
  check('rollback is itself reversible', backups.length === backupCountBeforeRollback + 1)

  check('rollback report contains zero credential canary material',
    !JSON.stringify([...state.checks, ...checks]).includes(primaryCredentialCanary))
  const rollbackState = JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    pass: [...state.checks, ...checks].length,
    total: [...state.checks, ...checks].length,
    checks: [...state.checks, ...checks]
  }, null, 2)
  if (rollbackState.includes(primaryCredentialCanary)) throw new Error('rollback report contains credential canary material')
  fs.writeFileSync(statePath, rollbackState)
}

async function runUiPhase() {
  const previous = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const providers = await invoke('providers:list')
  const alpha = providers.find((provider) => provider.name === 'Alpha Profile')
  check('UI phase starts from rolled-back provider state', providers.length === 1 && Boolean(alpha))
  const previewKeyLabel = await seedPreviewKey(alpha.id)
  const urlCanary = writeUnsafeUiProfileImport()
  const win = await openProviderProfileSettings()
  await verifySessionKeyAvailable(alpha.id, previewKeyLabel, 'after opening Provider settings')
  await verifyLocalVersionHistoryUi(win)
  await verifyProviderSyncSurface(win)
  await runProviderPricingCatalogUi(win, alpha.id)
  await verifySessionKeyAvailable(alpha.id, previewKeyLabel, 'after Provider editor save')
  await verifyUnsafeUiProfileRejected(win, urlCanary)
  writePortableUiProfileImport()
  await verifyUiProfilePreview(win, previewKeyLabel)
  await applyUiProfile(win)
  await verifyNoAuthCredentialDeletionUi(win, alpha.id)
  await captureUiScreenshot(win, 'provider-no-auth-confirmed.png')
  persistUiState(previous)
}

async function verifySessionKeyAvailable(providerId, keyLabel, stage) {
  const providers = await invoke('providers:list')
  const provider = providers.find((candidate) => candidate.id === providerId)
  check(`session-only Provider Key remains available ${stage}`,
    provider?.hasToken === true
      && provider?.keyCount === 1
      && provider?.activeKeyLabel === keyLabel,
    JSON.stringify({ hasToken: provider?.hasToken, keyCount: provider?.keyCount, activeKeyLabel: provider?.activeKeyLabel }))
}

async function verifyLocalVersionHistoryUi(win) {
  const opened = await rendererValue(win, `(() => {
    const button = [...document.querySelectorAll('.provider-profile-backup-row button')]
      .find((candidate) => candidate.textContent.trim() === '查看变更');
    button?.click();
    return Boolean(button);
  })()`)
  check('local Provider version history exposes a diff-first action', opened)
  await waitForRenderer(win, `Boolean(document.querySelector('.provider-profile-version-preview'))`)
  const preview = await rendererValue(win, `(() => {
    const panel = document.querySelector('.provider-profile-version-preview');
    const text = panel?.innerText || '';
    return {
      apiReady: typeof window.agentDesk.previewProviderProfileBackup === 'function'
        && typeof window.agentDesk.applyProviderProfileBackupPreview === 'function',
      rows: panel?.querySelectorAll('.provider-profile-version-row').length || 0,
      hasCounts: text.includes('恢复') && text.includes('更新') && text.includes('删除'),
      hasRollback: [...(panel?.querySelectorAll('button') || [])]
        .some((button) => button.textContent.trim() === '回滚'),
      hasEndpoint: /https?:\\/\\//i.test(text),
      hasCanary: text.includes(${JSON.stringify(primaryCredentialCanary)})
    };
  })()`)
  check('local Provider version preview shows a complete sanitized change plan',
    preview.apiReady && preview.rows > 0 && preview.hasCounts && preview.hasRollback
      && !preview.hasEndpoint && !preview.hasCanary,
    JSON.stringify(preview))
  win.setSize(760, 700)
  await settleRenderer(win)
  const compact = await rendererValue(win, `(() => {
    const panel = document.querySelector('.provider-profile-version-preview');
    panel?.scrollIntoView({ block: 'start' });
    const viewportWidth = document.documentElement.clientWidth;
    const controls = [...(panel?.querySelectorAll('button') || [])];
    return {
      overflow: document.documentElement.scrollWidth > viewportWidth,
      contained: controls.every((control) => {
        const rect = control.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= viewportWidth + 1;
      })
    };
  })()`)
  check('local Provider version preview remains usable at 760x700',
    compact.overflow === false && compact.contained === true,
    JSON.stringify(compact))
  await captureUiScreenshot(win, 'provider-profile-local-version-preview.png')
  await rendererValue(win, `document.querySelector('.provider-profile-version-preview .btn-icon')?.click()`)
  await waitForRenderer(win, `!document.querySelector('.provider-profile-version-preview')`)
}

async function verifyProviderSyncSurface(win) {
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-sync]'))`)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-webdav]'))`)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-s3]'))`)
  const result = await rendererValue(win, `(async () => {
    const api = window.agentDesk;
    const status = await api.getProviderProfileSyncStatus();
    const webdav = await api.getProviderProfileWebDavConfig();
    const s3 = await api.getProviderProfileS3Config();
    const panel = document.querySelector('[data-provider-webdav]');
    const s3Panel = document.querySelector('[data-provider-s3]');
    s3Panel?.scrollIntoView({ block: 'center' });
    return {
      relation: status.relation,
      configured: status.configured,
      apiReady: typeof api.chooseProviderProfileSyncDirectory === 'function'
        && typeof api.previewProviderProfileSync === 'function'
        && typeof api.publishProviderProfileSync === 'function'
        && typeof api.applyProviderProfileSync === 'function',
      webdavReady: typeof api.saveProviderProfileWebDavConfig === 'function'
        && typeof api.testProviderProfileWebDavConnection === 'function'
        && typeof api.previewProviderProfileWebDavSync === 'function'
        && typeof api.publishProviderProfileWebDavSync === 'function'
        && typeof api.applyProviderProfileWebDavSync === 'function'
        && typeof api.listProviderProfileWebDavHistory === 'function'
        && typeof api.previewProviderProfileWebDavHistory === 'function'
        && typeof api.applyProviderProfileWebDavHistory === 'function',
      webdavConfigured: webdav.configured,
      webdavControls: panel?.querySelectorAll('input').length || 0,
      s3Ready: typeof api.saveProviderProfileS3Config === 'function'
        && typeof api.testProviderProfileS3Connection === 'function'
        && typeof api.previewProviderProfileS3Sync === 'function'
        && typeof api.publishProviderProfileS3Sync === 'function'
        && typeof api.applyProviderProfileS3Sync === 'function'
        && typeof api.listProviderProfileS3History === 'function'
        && typeof api.previewProviderProfileS3History === 'function'
        && typeof api.applyProviderProfileS3History === 'function',
      s3Configured: s3.configured,
      s3Controls: s3Panel?.querySelectorAll('input').length || 0
    };
  })()`)
  check('Provider sync surface reaches the dedicated IPC route',
    result.apiReady && result.configured === false && result.relation === 'unconfigured')
  check('WebDAV sync surface exposes configuration and dedicated IPC',
    result.webdavReady && result.webdavConfigured === false && result.webdavControls >= 7)
  check('S3 sync surface exposes configuration and dedicated IPC',
    result.s3Ready && result.s3Configured === false && result.s3Controls >= 11)
  await settleRenderer(win)
  await captureUiScreenshot(win, 'provider-profile-sync.png')
  win.setSize(760, 700)
  await settleRenderer(win)
  const compact = await rendererValue(win, `(() => {
    const panel = document.querySelector('[data-provider-s3]');
    panel?.scrollIntoView({ block: 'start' });
    const viewportWidth = document.documentElement.clientWidth;
    const controls = [...(panel?.querySelectorAll('input, button') || [])];
    return {
      overflow: document.documentElement.scrollWidth > viewportWidth,
      controlsFit: controls.every((control) => {
        const rect = control.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= viewportWidth + 1;
      }),
      buttonTextFits: [...(panel?.querySelectorAll('button') || [])]
        .every((button) => button.scrollWidth <= button.clientWidth + 1)
    };
  })()`)
  check('S3 sync remains usable at 760x700',
    !compact.overflow && compact.controlsFit && compact.buttonTextFits,
    compact)
  await captureUiScreenshot(win, 'provider-profile-s3-compact.png')
  win.setSize(1200, 800)
  await settleRenderer(win)
}

async function runPricingPhase() {
  const provider = await invoke('providers:create', {
    name: 'Pricing Catalog Provider',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['seed-model'],
    engine: 'openai',
    authMode: 'none',
    openaiProtocol: 'chat'
  })
  check('isolated pricing Provider is created without credentials', provider.hasToken === false && provider.ready === true)
  fs.mkdirSync(screenshotDir, { recursive: true })
  const win = await openProviderProfileSettings(false)
  await runProviderPricingCatalogUi(win, provider.id)
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    pass: checks.length,
    total: checks.length,
    screenshots: [
      path.join(screenshotDir, 'provider-pricing-catalog.png'),
      path.join(screenshotDir, 'provider-pricing-catalog-compact.png'),
      path.join(screenshotDir, 'provider-reliability-compact.png'),
      path.join(screenshotDir, 'provider-credential-routing.png')
    ],
    checks
  }
  fs.writeFileSync(statePath, `${JSON.stringify(report, null, 2)}\n`)
}

function runProviderPricingCatalogUi(win, providerId) {
  return verifyProviderPricingCatalogUi({
    invoke, openProviderEditor, waitForRenderer, setProviderEditorField, check, clickRendererText,
    rendererValue, captureUiScreenshot, settleRenderer, clickProviderEditorSave, clickProviderEditorCancel
  }, win, providerId)
}

async function seedPreviewKey(providerId) {
  const previewToken = ['provider', 'ui', 'preview', 'seed'].join('-')
  const previewKeyLabel = 'Alpha Preview Key'
  const keyed = await invoke('providers:update', providerId, {
    token: previewToken,
    tokenLabel: previewKeyLabel
  })
  check('UI preview target starts with one labeled active Key',
    keyed?.hasToken === true
      && keyed?.keyCount === 1
      && keyed?.activeKeyLabel === previewKeyLabel)
  return previewKeyLabel
}

function writeUnsafeUiProfileImport() {
  const urlCanary = ['sk', 'profile', 'ui', 'canary'].join('-')
  fs.writeFileSync(importPath, JSON.stringify({
    kind: 'caogen-provider-profile',
    schemaVersion: 1,
    providers: [{
      name: 'Unsafe Profile',
      baseUrl: `https://profile:${urlCanary}@unsafe.example/v1?token=${urlCanary}`,
      models: ['unsafe'],
      engine: 'openai'
    }]
  }, null, 2), { mode: 0o600 })
  return urlCanary
}

async function openProviderProfileSettings(requireBackup = true) {
  const win = await waitForWindow()
  await waitForRenderer(win, `document.body.innerText.includes('CaoGen')`)
  await clickRendererText(win, '设置')
  await waitForRenderer(win, `Boolean(document.querySelector('.settings-page'))`)
  await rendererValue(win, `document.querySelector('[data-settings-tab="providers"]')?.click()`)
  await waitForRenderer(win, `document.body.innerText.includes('Profile 只迁移 Provider')`)
  if (requireBackup) await waitForRenderer(win, `Boolean(document.querySelector('.provider-profile-backup-row'))`)
  const initialUi = await rendererValue(win, `({
    hasImport: [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '导入'),
    hasExport: [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '导出'),
    hasVersionPreview: [...document.querySelectorAll('.provider-profile-backup-row button')]
      .some((button) => button.textContent.trim() === '查看变更')
  })`)
  check('Provider settings expose import, export, and diff-first version history',
    initialUi.hasImport && initialUi.hasExport && (!requireBackup || initialUi.hasVersionPreview),
    JSON.stringify(initialUi))
  return win
}

async function verifyUnsafeUiProfileRejected(win, urlCanary) {
  await clickRendererText(win, '导入')
  await waitForRenderer(win, `Boolean(document.querySelector('.notice-error'))`)
  const rejectedUi = await rendererValue(win, `({
    previewOpen: Boolean(document.querySelector('.provider-profile-preview')),
    containsCanary: document.documentElement.innerHTML.includes(${JSON.stringify(urlCanary)})
  })`)
  check('unsafe URL is rejected without entering the preview DOM',
    !rejectedUi.previewOpen && !rejectedUi.containsCanary)
}

function writePortableUiProfileImport() {
  fs.writeFileSync(importPath, JSON.stringify({
    kind: 'caogen-provider-profile',
    schemaVersion: 1,
    providers: [
      {
        name: 'Alpha Profile',
        baseUrl: 'https://alpha-old.example/v1',
        models: ['alpha-ui'],
        engine: 'openai',
        openaiProtocol: 'chat'
      },
      {
        name: 'UI Portable Profile',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: ['ui-local'],
        engine: 'openai',
        authMode: 'none',
        openaiProtocol: 'responses'
      }
    ]
  }, null, 2), { mode: 0o600 })
}

async function verifyUiProfilePreview(win, previewKeyLabel) {
  await clickRendererText(win, '导入')
  await waitForRenderer(win, `Boolean(document.querySelector('.provider-profile-preview'))`)
  const previewUi = await rendererValue(win, `({
    text: document.querySelector('.provider-profile-preview')?.innerText || '',
    actions: [...document.querySelectorAll('.provider-profile-action-select')].map((select) => select.value),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  })`)
  check('UI preview shows provider targets, protocols, and actions',
    previewUi.text.includes('Alpha Profile')
      && previewUi.text.includes('UI Portable Profile')
      && previewUi.text.includes('OpenAI Chat Completions')
      && previewUi.text.includes('OpenAI Responses')
      && previewUi.text.includes('API Key')
      && previewUi.text.includes('本机服务无需密钥')
      && previewUi.actions.join(',') === 'update,create'
      && previewUi.overflow === false)
  check('UI preview shows the active Key label and preserved target binding',
    previewUi.text.includes(`当前 Key：${previewKeyLabel}（共 1 个）`)
      && previewUi.text.includes('目标绑定不变，将继续使用'),
    previewUi.text)
  fs.mkdirSync(screenshotDir, { recursive: true })
  await captureUiScreenshot(win, 'provider-profile-import-preview.png')
  await captureCompactPreview(win)
}

async function applyUiProfile(win) {
  await clickRendererText(win, '应用 Profile')
  const completion = await waitFor(async () => {
    const state = await rendererValue(win, `({
      applied: document.body.innerText.includes('Profile 已应用'),
      error: document.querySelector('.provider-profile-notice.notice-error')?.textContent?.trim() || '',
      applying: [...document.querySelectorAll('.provider-profile-preview button')]
        .some((button) => button.textContent.trim().includes('正在应用'))
    })`).catch(() => null)
    return state && (state.applied || state.error) ? state : false
  }, 30_000)
  check('UI apply completes without an operation error', completion.applied, JSON.stringify(completion))
  const appliedUi = await rendererValue(win, `({
    providerRows: document.querySelectorAll('.provider-row').length,
    backupRows: document.querySelectorAll('.provider-profile-backup-row').length,
    previewOpen: Boolean(document.querySelector('.provider-profile-preview')),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  })`)
  check('UI apply refreshes providers and backup history',
    appliedUi.providerRows >= 2 && appliedUi.backupRows >= 1 && !appliedUi.previewOpen && !appliedUi.overflow)
  await captureUiScreenshot(win, 'provider-profile-applied.png')
}

async function captureUiScreenshot(win, name) {
  await settleRenderer(win)
  fs.writeFileSync(path.join(screenshotDir, name), (await win.capturePage()).toPNG())
}

function persistUiState(previous) {
  check('final E2E report contains zero primary credential canary material',
    !JSON.stringify([...previous.checks, ...checks]).includes(primaryCredentialCanary))
  const allChecks = [...previous.checks, ...checks]
  const finalState = JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    pass: allChecks.length,
    total: allChecks.length,
    screenshots: [
      path.join(screenshotDir, 'provider-pricing-catalog.png'),
      path.join(screenshotDir, 'provider-pricing-catalog-compact.png'),
      path.join(screenshotDir, 'provider-profile-import-preview.png'),
      path.join(screenshotDir, 'provider-profile-import-preview-compact.png'),
      path.join(screenshotDir, 'provider-profile-applied.png'),
      path.join(screenshotDir, 'provider-profile-sync.png'),
      path.join(screenshotDir, 'provider-credential-routing.png'),
      path.join(screenshotDir, 'provider-no-auth-confirmed.png')
    ],
    checks: allChecks
  }, null, 2)
  if (finalState.includes(primaryCredentialCanary)) throw new Error('final E2E report contains credential canary material')
  fs.writeFileSync(statePath, finalState)
}

async function verifyNoAuthCredentialDeletionUi(win, providerId) {
  const drafts = {
    primary: ['provider', 'ui', 'primary', 'draft'].join('-'),
    additional: ['provider', 'ui', 'backup', 'draft'].join('-')
  }
  const afterSeed = await seedKeyedProvider(win, providerId)
  const afterRouting = await verifyCredentialRoutingUi(win, providerId)
  const observation = observeProviderUpdates()
  try {
    await openSeededProviderEditor(win)
    await draftNoAuthConversion(win, drafts)
    await cancelNoAuthDeletion(win, providerId, afterRouting, observation.updates)
    await verifyClearedDraftsAfterCancel(win)
    const afterConfirmedSave = await confirmNoAuthDeletion(win, providerId, drafts, observation.updates)
    await verifyExplicitCredentialReentry(win, providerId, afterConfirmedSave)
  } finally {
    observation.restore()
    await restoreRendererConfirm(win)
  }
}

async function verifyCredentialRoutingUi(win, providerId) {
  await openSeededProviderEditor(win)
  const changed = await rendererValue(win, `(() => {
    const editor = document.querySelector('.provider-editor');
    const mode = editor?.querySelector('[data-provider-credential-routing-mode]');
    const values = ['7', '25', '3', '15'];
    const fields = [...(editor?.querySelectorAll('.provider-key-policy-grid input[type="number"]') || [])];
    if (!mode || fields.length !== 4) return false;
    const setValue = (element, value) => {
      Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue(mode, 'automatic');
    fields.forEach((field, index) => setValue(field, values[index]));
    return mode.value === 'automatic' && fields.map((field) => field.value).join(',') === values.join(',');
  })()`)
  check('credential routing UI exposes mode and four policy controls', changed)
  await settleRenderer(win)
  await rendererValue(win, `(() => {
    document.querySelector('.provider-key-panel')?.scrollIntoView({ block: 'center' });
    return true;
  })()`)
  await settleRenderer(win)
  await captureUiScreenshot(win, 'provider-credential-routing.png')
  await clickProviderEditorSave(win)
  await waitForRenderer(win, `!document.querySelector('.provider-editor')`)
  const saved = (await invoke('providers:list')).find((provider) => provider.id === providerId)
  const policy = saved?.apiKeys?.[0]?.policy
  check('credential routing policy saves through real renderer IPC',
    saved?.credentialRoutingMode === 'automatic'
      && policy?.priority === 7
      && policy?.monthlyBudgetUsd === 25
      && policy?.minimumBalanceUsd === 3
      && policy?.failureCooldownMinutes === 15,
    JSON.stringify({ mode: saved?.credentialRoutingMode, policy }))
  return saved
}

async function seedKeyedProvider(win, providerId) {
  const seedToken = ['provider', 'ui', 'saved', 'seed'].join('-')
  const opened = await openProviderEditor(win, 'Alpha Profile')
  check('UI opens the keyed Provider editor before no-auth conversion', opened)
  await waitForRenderer(win, `Boolean(document.querySelector('.provider-editor input[type="password"]'))`)
  const seeded = await setProviderEditorField(win, 'input[type="password"]', seedToken)
  check('UI can seed a saved key for the no-auth deletion flow', seeded)
  await settleRenderer(win)
  await clickProviderEditorSave(win)
  await waitForRenderer(win, `!document.querySelector('.provider-editor')`)
  const afterSeed = (await invoke('providers:list')).find((provider) => provider.id === providerId)
  check('UI seed replaces the preview Key without increasing keyCount',
    afterSeed?.authMode === 'api-key' && afterSeed?.hasToken === true && (afterSeed?.keyCount ?? 0) === 1)
  return afterSeed
}

function observeProviderUpdates() {
  const originalProviderUpdate = ipcMain._invokeHandlers?.get('providers:update')
  if (!originalProviderUpdate) throw new Error('providers:update IPC handler not registered')
  const updates = []
  ipcMain._invokeHandlers.set('providers:update', async (event, ...args) => {
    updates.push(args)
    return originalProviderUpdate(event, ...args)
  })
  return {
    updates,
    restore: () => ipcMain._invokeHandlers.set('providers:update', originalProviderUpdate)
  }
}

async function openSeededProviderEditor(win) {
  const reopened = await openProviderEditor(win, 'Alpha Profile')
  check('UI reopens the Provider with saved-key metadata', reopened)
  await waitForRenderer(win, `Boolean(document.querySelector('.provider-editor .provider-key-row'))`)
}

async function draftNoAuthConversion(win, drafts) {
  const drafted = await rendererValue(win, `(() => {
    const setValue = (element, value) => {
      const prototype = element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const editor = document.querySelector('.provider-editor');
    const token = editor?.querySelector('input[type="password"]');
    const additional = editor?.querySelector('textarea[rows="3"]');
    const baseUrl = editor?.querySelector('input[placeholder="https://your-gateway.example.com"]');
    if (!token || !additional || !baseUrl) return false;
    setValue(token, ${JSON.stringify(drafts.primary)});
    setValue(additional, ${JSON.stringify(`Backup=${drafts.additional}`)});
    setValue(baseUrl, 'http://127.0.0.1:21435/v1');
    return token.value === ${JSON.stringify(drafts.primary)}
      && additional.value.includes(${JSON.stringify(drafts.additional)})
      && baseUrl.value === 'http://127.0.0.1:21435/v1';
  })()`)
  check('UI accepts credential drafts before switching authentication mode', drafted)
  await settleRenderer(win)

  await setProviderEditorAuthMode(win, 'none')
  await settleRenderer(win)
  const noAuthUi = await rendererValue(win, `(() => {
    const editor = document.querySelector('.provider-editor');
    return {
      warning: editor?.innerText.includes('永久删除') && editor?.innerText.includes('1 个 API Key'),
      passwordFields: editor?.querySelectorAll('input[type="password"]').length || 0,
      credentialDraftAreas: editor?.querySelectorAll('textarea[rows="3"]').length || 0
    };
  })()`)
  check('no-auth UI hides cleared credential drafts and warns about permanent deletion',
    noAuthUi.warning && noAuthUi.passwordFields === 0 && noAuthUi.credentialDraftAreas === 0,
    JSON.stringify(noAuthUi))
}

async function cancelNoAuthDeletion(win, providerId, afterSeed, updates) {
  await rendererValue(win, `(() => {
    window.__caogenProviderOriginalConfirm = window.confirm;
    window.__caogenProviderConfirmCalls = 0;
    window.confirm = () => { window.__caogenProviderConfirmCalls += 1; return false; };
  })()`)
  await clickProviderEditorSave(win)
  await waitForRenderer(win, `window.__caogenProviderConfirmCalls === 1`)
  const afterCanceledSave = (await invoke('providers:list')).find((provider) => provider.id === providerId)
  const cancelUi = await rendererValue(win, `Boolean(document.querySelector('.provider-editor'))`)
  check('canceling no-auth deletion preserves the keyed Provider without closing the editor',
    cancelUi
      && updates.length === 0
      && JSON.stringify(afterCanceledSave) === JSON.stringify(afterSeed))
}

async function verifyClearedDraftsAfterCancel(win) {
  await setProviderEditorAuthMode(win, 'api-key')
  await settleRenderer(win)
  const restoredDraftUi = await rendererValue(win, `(() => {
    const editor = document.querySelector('.provider-editor');
    const token = editor?.querySelector('input[type="password"]');
    const additional = editor?.querySelector('textarea[rows="3"]');
    return {
      token: token?.value || '',
      additional: additional?.value || '',
      savedKeys: editor?.querySelectorAll('.provider-key-row').length || 0
    };
  })()`)
  check('switching back after cancellation does not restore hidden plaintext drafts',
    restoredDraftUi.token === ''
      && restoredDraftUi.additional === ''
      && restoredDraftUi.savedKeys > 0,
    JSON.stringify(restoredDraftUi))
}

async function confirmNoAuthDeletion(win, providerId, drafts, updates) {
  await setProviderEditorAuthMode(win, 'none')
  await settleRenderer(win)
  await rendererValue(win, `(() => {
    window.confirm = () => { window.__caogenProviderConfirmCalls += 1; return true; };
    return true;
  })()`)
  await clickProviderEditorSave(win)
  await waitForRenderer(win, `!document.querySelector('.provider-editor')`)
  const afterConfirmedSave = (await invoke('providers:list')).find((provider) => provider.id === providerId)
  assertCredentialFreeProviderUpdate(providerId, drafts, updates)
  check('confirming no-auth deletion erases stored keys and leaves a routable loopback Provider',
    afterConfirmedSave?.authMode === 'none'
      && afterConfirmedSave?.baseUrl === 'http://127.0.0.1:21435/v1'
      && afterConfirmedSave?.hasToken === false
      && (afterConfirmedSave?.keyCount ?? 0) === 0
      && (afterConfirmedSave?.apiKeys?.length ?? 0) === 0
      && afterConfirmedSave?.ready === true)
  return afterConfirmedSave
}

function assertCredentialFreeProviderUpdate(providerId, drafts, updates) {
  const [observedProviderId, observedPatch] = updates[0] ?? []
  const credentialFields = [
    'token',
    'tokenLabel',
    'additionalTokens',
    'keyUpdates',
    'removeKeyIds',
    'activeKeyId'
  ]
  const observedPatchJson = JSON.stringify(observedPatch ?? {})
  check('confirmed no-auth UI save sends one credential-free Provider update',
    updates.length === 1
      && observedProviderId === providerId
      && observedPatch?.authMode === 'none'
      && credentialFields.every((field) => !Object.prototype.hasOwnProperty.call(observedPatch, field))
      && !observedPatchJson.includes(drafts.primary)
      && !observedPatchJson.includes(drafts.additional),
    observedPatchJson)
}

async function restoreRendererConfirm(win) {
  await rendererValue(win, `(() => {
    if (window.__caogenProviderOriginalConfirm) window.confirm = window.__caogenProviderOriginalConfirm;
    delete window.__caogenProviderOriginalConfirm;
    delete window.__caogenProviderConfirmCalls;
  })()`)
}

async function verifyExplicitCredentialReentry(win, providerId, afterConfirmedSave) {
  const reopenedNoAuth = await openProviderEditor(win, 'Alpha Profile')
  check('UI reopens the no-auth Provider after credential deletion', reopenedNoAuth)
  await waitForRenderer(win, `Boolean(document.querySelector('.provider-editor'))`)
  await setProviderEditorAuthMode(win, 'api-key')
  await settleRenderer(win)
  const rekeyUi = await rendererValue(win, `(() => {
    const editor = document.querySelector('.provider-editor');
    const token = editor?.querySelector('input[type="password"]');
    const additional = editor?.querySelector('textarea[rows="3"]');
    return {
      token: token?.value || '',
      tokenPlaceholder: token?.placeholder || '',
      additional: additional?.value || '',
      savedKeys: editor?.querySelectorAll('.provider-key-row').length || 0
    };
  })()`)
  check('switching back to API-key mode requires explicit credential re-entry',
    rekeyUi.token === ''
      && rekeyUi.tokenPlaceholder === '<your-api-key>'
      && rekeyUi.additional === ''
      && rekeyUi.savedKeys === 0,
    JSON.stringify(rekeyUi))
  await clickProviderEditorCancel(win)
  await waitForRenderer(win, `!document.querySelector('.provider-editor')`)
  const afterRekeyCancel = (await invoke('providers:list')).find((provider) => provider.id === providerId)
  check('canceling credential re-entry leaves the persisted Provider in no-auth mode',
    JSON.stringify(afterRekeyCancel) === JSON.stringify(afterConfirmedSave))
}

async function setProviderEditorAuthMode(win, mode) {
  const changed = await rendererValue(win, `(() => {
    const select = [...document.querySelectorAll('.provider-editor select')]
      .find((candidate) => [...candidate.options].some((option) => option.value === 'none'));
    if (!select) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(mode)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  if (!changed) throw new Error(`Provider auth mode select not found for ${mode}`)
}

async function openProviderEditor(win, providerName) {
  return rendererValue(win, `(() => {
    const row = [...document.querySelectorAll('.provider-row')]
      .find((candidate) => candidate.querySelector('.provider-row-name')?.childNodes[0]?.textContent.trim() === ${JSON.stringify(providerName)});
    const edit = row?.querySelector('.provider-row-actions button:nth-of-type(2)');
    edit?.click();
    return Boolean(edit);
  })()`)
}

async function setProviderEditorField(win, selector, value) {
  return rendererValue(win, `(() => {
    const element = document.querySelector('.provider-editor ${selector}');
    if (!element) return false;
    const prototype = element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return element.value === ${JSON.stringify(value)};
  })()`)
}

async function clickProviderEditorSave(win) {
  const clicked = await rendererValue(win, `(() => {
    const save = document.querySelector('.provider-editor-actions .btn-primary');
    save?.click();
    return Boolean(save);
  })()`)
  if (!clicked) throw new Error('Provider editor save button not found')
}

async function clickProviderEditorCancel(win) {
  const clicked = await rendererValue(win, `(() => {
    const cancel = document.querySelector('.provider-editor-actions .btn-ghost');
    cancel?.click();
    return Boolean(cancel);
  })()`)
  if (!clicked) throw new Error('Provider editor cancel button not found')
}

async function captureCompactPreview(win) {
  win.setSize(760, 700)
  await settleRenderer(win)
  const compactUi = await rendererValue(win, `(() => {
    const insideViewport = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.left >= -1 && rect.right <= window.innerWidth + 1;
    };
    const overlaps = (left, right) => !(
      left.right <= right.left || right.right <= left.left || left.bottom <= right.top || right.bottom <= left.top
    );
    const rows = [...document.querySelectorAll('.provider-profile-import-row')];
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      previewContained: insideViewport(document.querySelector('.provider-profile-preview')),
      controlsContained: [...document.querySelectorAll('.provider-profile-action-select, .provider-profile-preview button')]
        .every(insideViewport),
      rowControlsSeparated: rows.every((row) => {
        const copy = row.querySelector('.provider-profile-import-copy')?.getBoundingClientRect();
        const select = row.querySelector('.provider-profile-action-select')?.getBoundingClientRect();
        return Boolean(copy && select && !overlaps(copy, select));
      }),
      buttonTextFits: [...document.querySelectorAll('.provider-profile-preview button')]
        .every((button) => button.scrollWidth <= button.clientWidth + 1)
    };
  })()`)
  check('UI preview remains usable at 760x700',
    compactUi.width <= 760
      && compactUi.height <= 700
      && !compactUi.overflow
      && compactUi.previewContained
      && compactUi.controlsContained
      && compactUi.rowControlsSeparated
      && compactUi.buttonTextFits,
    JSON.stringify(compactUi))
  const screenshot = path.join(screenshotDir, 'provider-profile-import-preview-compact.png')
  fs.writeFileSync(screenshot, (await win.capturePage()).toPNG())
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

function rendererValue(win, expression) {
  return win.webContents.executeJavaScript(expression, true)
}

async function settleRenderer(win) {
  await rendererValue(win, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  win.webContents.invalidate()
  await new Promise((resolve) => setTimeout(resolve, 400))
}

function checkPrivateMode(name, target, expected) {
  if (process.platform === 'win32') {
    const acl = JSON.parse(execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$acl = Get-Acl -LiteralPath $env:CAOGEN_ACL_TARGET; [pscustomobject]@{ Owner = [string]$acl.Owner; Access = @($acl.Access | ForEach-Object { $sid = try { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { '' }; [pscustomobject]@{ Sid = $sid; Rights = [string]$_.FileSystemRights; Type = [string]$_.AccessControlType } }) } | ConvertTo-Json -Depth 4 -Compress`
    ], {
      encoding: 'utf8',
      env: { ...process.env, CAOGEN_ACL_TARGET: target },
      windowsHide: true
    }))
    const broadPrincipals = new Set(['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-546'])
    const broadWrite = (Array.isArray(acl.Access) ? acl.Access : [acl.Access]).filter(Boolean).some((entry) =>
      entry.Type === 'Allow'
        && broadPrincipals.has(entry.Sid)
        && /Write|Modify|FullControl|Create|Delete|TakeOwnership|ChangePermissions/i.test(entry.Rights))
    check(name, Boolean(acl.Owner) && !broadWrite)
    return
  }
  check(name, (fs.statSync(target).mode & 0o777) === expected)
}

function waitFor(predicate, timeoutMs) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await predicate()
        if (value) return resolve(value)
      } catch {
        // Keep polling while the app or renderer initializes.
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('provider profile wait timed out'))
      setTimeout(() => void poll(), 100)
    }
    void poll()
  })
}

function finish(code) {
  app.exit(code)
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`missing ${name}`)
  return value
}

app.whenReady().then(() => run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  finish(1)
}))
