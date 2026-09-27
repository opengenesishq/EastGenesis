#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  PrivateProviderConfigError,
  resolvePrivateProviderConfig
} from './lib/private-provider-config.mjs'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const originalLoad = require('node:module').Module._load
const originalFetch = globalThis.fetch
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error }
const isRecoveryChild = process.argv.includes('--recovery-child')
const privateIpv6Patterns = [/^::1$/, /^(?:fc|fd|fe80):/, /^2001:db8(?::|$)/]
const privateIpv4Ranges = [
  [0x00000000, 0x00ffffff],
  [0x0a000000, 0x0affffff],
  [0x64400000, 0x647fffff],
  [0x7f000000, 0x7fffffff],
  [0xa9fe0000, 0xa9feffff],
  [0xac100000, 0xac1fffff],
  [0xc0a80000, 0xc0a8ffff],
  [0xe0000000, 0xffffffff]
]

class SafeFailure extends Error {
  constructor(code, diagnostic) {
    super(code)
    this.code = code
    this.diagnostic = diagnostic
  }
}

try {
  const result = isRecoveryChild ? await runRecoveryChild() : await runEvidence()
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!isRecoveryChild && result.status === 'functional_pass_formal_fail') process.exitCode = 2
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    status: 'failed',
    functionalPassed: false,
    formalBinding: false,
    errorCode: safeErrorCode(error),
    ...(safeFailureDiagnostic(error) ? { diagnostic: safeFailureDiagnostic(error) } : {})
  })}\n`)
  process.exitCode = 1
} finally {
  require('node:module').Module._load = originalLoad
  globalThis.fetch = originalFetch
  Object.assign(console, originalConsole)
}

async function runEvidence() {
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const config = readPrivateProviderConfig()
  const provider = await selectEligibleProvider(config.providers, config.allowLoopback)
  const maxRequests = boundedInteger(argValue('--max-requests'), 3, 2, 4, 'invalid_request_cap')
  const timeoutMs = boundedInteger(argValue('--timeout-ms'), 30_000, 5_000, 60_000, 'invalid_timeout')
  const recordPath = resolvePrivateRecordPath(argValue('--record'), runId)
  const auditReportRoot = resolveAuditReportRoot(argValue('--audit-report-root'))
  const packageVersion = readPackageVersion()
  const gitCommit = gitOutput(['rev-parse', 'HEAD'])
  const worktreeClean = gitOutput(['status', '--porcelain', '--untracked-files=all']) === ''
  if (!/^[0-9a-f]{40}$/i.test(gitCommit)) fail('git_identity_unavailable')

  const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-real-provider-runner-'))
  const outDir = path.join(tempRoot, 'compiled')
  const userData = path.join(tempRoot, 'userData')
  const projectRoot = path.join(tempRoot, 'project')
  const lifecycle = { manager: undefined, restoreNetwork: undefined, restoreConsole: undefined }

  try {
    const harness = await prepareEvidenceHarness({
      lifecycle,
      provider,
      maxRequests,
      timeoutMs,
      outDir,
      userData,
      projectRoot
    })
    const { manager, workspace, artifactModule, ids, meta } = harness

    const marks = monotonicMarks()
    const startedAt = marks.next()
    const artifactFileName = 'release-evidence-output.txt'
    const expectedBytes = Buffer.from(`EastGenesis release evidence ${randomUUID()}\n`, 'utf8')
    const prompt = releasePrompt(artifactFileName, expectedBytes.toString('utf8'))
    if (!await manager.send(meta.id, prompt)) fail('send_rejected')
    const sendCompletedAt = marks.next()

    const completed = await verifyCompletedTurn({
      manager,
      meta,
      workspace,
      ids,
      artifactFileName,
      expectedBytes,
      projectRoot,
      timeoutMs,
      providerProtocol: provider.apiFormat === 'openai-responses' ? 'responses' : 'chat',
      restoreNetwork: lifecycle.restoreNetwork,
      marks
    })
    const verifiedArtifact = await registerAndVerifyArtifact({
      artifactModule,
      ids,
      runId: completed.run.id,
      expectedBytes,
      userData,
      marks
    })
    const usage = verifyUsageAndRequests({
      session: completed.session,
      transcript: completed.transcript,
      restoreNetwork: lifecycle.restoreNetwork,
      maxRequests
    })

    try {
      await manager.disposeAll()
    } catch {
      fail('session_disposal_failed')
    }
    lifecycle.manager = undefined
    const recoveryManifest = path.join(tempRoot, 'recovery-manifest.json')
    writePrivateJson(recoveryManifest, {
      outDir,
      userData,
      sessionId: meta.id,
      runId: completed.run.id,
      artifactId: ids.artifactId,
      projectId: ids.projectId,
      goalId: ids.goalId,
      workItemId: ids.workItemId,
      artifactSha256: verifiedArtifact.digest,
      minimumCostUsd: usage.costUsd
    })
    const recovered = runRecoveryProcess(recoveryManifest)
    const recoveryVerifiedAt = marks.next()
    const usageVerifiedAt = marks.next()
    const billingVerifiedAt = marks.next()
    const finishedAt = marks.next()

    return writeAndAuditEvidenceRecord({
      recordPath,
      auditReportRoot,
      packageVersion,
      gitCommit,
      worktreeClean,
      provider,
      recovered,
      requestCount: usage.requestCount,
      toolCallCount: completed.toolCalls.length,
      transcriptSha256: usage.transcriptSha256,
      artifactSha256: verifiedArtifact.digest,
      startedAt,
      sendCompletedAt,
      toolCompletedAt: completed.toolCompletedAt,
      artifactVerifiedAt: verifiedArtifact.verifiedAt,
      recoveryVerifiedAt,
      usageVerifiedAt,
      billingVerifiedAt,
      finishedAt
    })
  } finally {
    if (lifecycle.manager) await lifecycle.manager.disposeAll().catch(() => undefined)
    lifecycle.restoreNetwork?.restore()
    lifecycle.restoreConsole?.()
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function prepareEvidenceHarness(input) {
  const { lifecycle, provider, maxRequests, timeoutMs, outDir, userData, projectRoot } = input
  mkdirPrivate(userData)
  mkdirPrivate(projectRoot)
  writeFileSync(path.join(userData, 'settings.json'), `${JSON.stringify({
    failoverEnabled: false,
    notificationsEnabled: false,
    autoSkillLearningEnabled: false,
    preventDisplaySleep: false
  })}\n`, { mode: 0o600 })
  compileProductionHarness(outDir)
  installRuntimeEnvironment(outDir, userData)
  lifecycle.restoreConsole = suppressConsole()
  lifecycle.restoreNetwork = installBoundedFetch(provider.baseUrl, maxRequests, timeoutMs)
  const sessionManagerModule = require(findCompiled(outDir, 'sessionManager.js'))
  const providersModule = require(findCompiled(outDir, 'providers.js'))
  const projectModule = require(findCompiled(outDir, 'project-workspace/index.js'))
  const artifactModule = require(findCompiled(outDir, 'artifact-lifecycle-api.js'))
  const ids = {
    projectId: randomUUID(),
    goalId: randomUUID(),
    workItemId: randomUUID(),
    artifactId: randomUUID()
  }
  const workspace = new projectModule.ProjectWorkspaceStore(userData)
  await workspace.open()
  await workspace.createWorkspace({ id: ids.projectId, name: 'Release Evidence', kind: 'software', resources: [] })
  await workspace.createGoal({
    id: ids.goalId,
    projectId: ids.projectId,
    title: 'Verify real provider release path',
    objective: 'Produce bounded release evidence'
  })
  await workspace.createWorkItem({
    id: ids.workItemId,
    projectId: ids.projectId,
    goalId: ids.goalId,
    title: 'Run real provider evidence',
    type: 'testing'
  })
  const savedProvider = providersModule.createProvider({
    name: 'Release evidence provider',
    baseUrl: provider.baseUrl,
    models: [provider.model],
    engine: 'openai',
    openaiProtocol: provider.apiFormat === 'openai-responses' ? 'responses' : 'chat',
    credentialHeaderNames: ['authorization'],
    token: provider.apiKey,
    tokenLabel: 'release-evidence'
  })
  assertProviderFileRedacted(userData, provider.apiKey)
  lifecycle.manager = sessionManagerModule.sessionManager
  await lifecycle.manager.init()
  const meta = await lifecycle.manager.create({
    cwd: projectRoot,
    isolated: false,
    workspaceId: ids.projectId,
    goalId: ids.goalId,
    workItemId: ids.workItemId,
    providerId: savedProvider.id,
    model: provider.model,
    permissionMode: 'bypassPermissions',
    title: 'Real provider release evidence'
  })
  await waitFor(() => lifecycle.manager.get(meta.id)?.meta.status === 'idle', 10_000, 'engine_start_timeout')
  return { manager: lifecycle.manager, workspace, artifactModule, ids, meta }
}

async function verifyCompletedTurn(input) {
  const {
    manager,
    meta,
    workspace,
    ids,
    artifactFileName,
    expectedBytes,
    projectRoot,
    timeoutMs,
    providerProtocol,
    restoreNetwork,
    marks
  } = input
  await waitFor(
    () => successfulWriteTool(manager.getTranscript(meta.id), artifactFileName),
    timeoutMs * 2,
    'tool_roundtrip_timeout'
  )
  const toolCompletedAt = marks.next()
  assertExactRegularFile(path.join(projectRoot, artifactFileName), expectedBytes)
  await waitFor(
    () => successfulTurn(manager.getTranscript(meta.id)),
    timeoutMs * 2,
    'turn_completion_timeout',
    () => turnCompletionDiagnostic(manager, meta.id, providerProtocol, restoreNetwork)
  )
  const transcript = manager.getTranscript(meta.id)
  const toolCalls = durableToolCalls(transcript)
  if (toolCalls.length !== 1 || toolCalls[0].name !== 'write_file') fail('unexpected_tool_sequence')
  const turnResult = transcript.findLast((entry) => entry.event.kind === 'turn-result')?.event
  if (!turnResult || turnResult.kind !== 'turn-result' || turnResult.isError) fail('turn_failed')
  const session = manager.get(meta.id)
  const run = manager.taskRuns.get(meta.id)
  if (!session || !run || !isTerminalRun(run.status)) fail('canonical_run_not_terminal')
  await waitFor(async () => {
    try {
      const state = await workspace.getState()
      return state.workItems.find((item) => item.id === ids.workItemId)?.runRefs.includes(run.id) === true
    } catch {
      return false
    }
  }, timeoutMs * 2, 'canonical_run_binding_timeout')
  return { session, run, transcript, toolCalls, toolCompletedAt }
}

async function registerAndVerifyArtifact(input) {
  const { artifactModule, ids, runId, expectedBytes, userData, marks } = input
  let registered
  try {
    registered = await artifactModule.registerPersistedArtifactLifecycle({
      id: ids.artifactId,
      projectId: ids.projectId,
      goalId: ids.goalId,
      workItemId: ids.workItemId,
      runId,
      lineageId: ids.artifactId,
      kind: 'test_report',
      title: 'Real provider tool output',
      version: 1,
      provenance: 'explicit',
      mediaType: 'text/plain',
      retention: { mode: 'retain' },
      content: { storageKind: 'blob', bytes: expectedBytes, expectedDigest: sha256(expectedBytes) },
      metadata: { gate: 'real-provider-release' },
      createdAt: Date.now()
    }, userData)
  } catch {
    fail('artifact_registration_failed')
  }
  let verification
  try {
    verification = await artifactModule.verifyPersistedArtifactLifecycle(userData, ['test_report'])
  } catch {
    fail('artifact_verification_failed')
  }
  if (registered.lifecycle.digest !== sha256(expectedBytes) || verification.artifacts < 1) {
    fail('artifact_verification_failed')
  }
  return { digest: registered.lifecycle.digest, verifiedAt: marks.next() }
}

function verifyUsageAndRequests({ session, transcript, restoreNetwork, maxRequests }) {
  const usage = session.meta.usage
  const costUsd = session.meta.costUsd
  if (!usage || usage.input <= 0 || usage.output <= 0) fail('usage_missing')
  if (!(Number.isFinite(costUsd) && costUsd > 0)) fail('billing_missing')
  const transcriptSha256 = sha256(Buffer.from(JSON.stringify(redactedTranscriptShape(transcript))))
  const requestCount = restoreNetwork.requestCount()
  if (requestCount < 2 || requestCount > maxRequests) fail('request_count_out_of_bounds')
  return { costUsd, transcriptSha256, requestCount }
}

function writeAndAuditEvidenceRecord(input) {
  const record = {
    schemaVersion: 1,
    candidateVersion: input.packageVersion,
    gitCommit: input.gitCommit,
    worktreeClean: input.worktreeClean,
    protocol: 'openai-compatible',
    redacted: true,
    providerTarget: { kind: 'sha256', sha256: sha256(Buffer.from(input.provider.baseUrl)) },
    sendPassed: true,
    toolPassed: true,
    artifactPassed: true,
    recoveryPassed: input.recovered.ok === true,
    usagePassed: true,
    billingPassed: input.recovered.costPersisted === true,
    requestCount: input.requestCount,
    toolCallCount: input.toolCallCount,
    transcriptSha256: input.transcriptSha256,
    artifactSha256: input.artifactSha256,
    recoverySha256: input.recovered.recoverySha256,
    startedAt: input.startedAt,
    sendCompletedAt: input.sendCompletedAt,
    toolCompletedAt: input.toolCompletedAt,
    artifactVerifiedAt: input.artifactVerifiedAt,
    recoveryVerifiedAt: input.recoveryVerifiedAt,
    usageVerifiedAt: input.usageVerifiedAt,
    billingVerifiedAt: input.billingVerifiedAt,
    finishedAt: input.finishedAt
  }
  writePrivateJson(input.recordPath, record)
  const audit = runFormalAudit(input.recordPath, input.auditReportRoot)
  const dirtyOnly = !input.worktreeClean && audit.status === 'failed' &&
    audit.failures.length === 1 && audit.failures[0] === 'record.worktreeClean must be true'
  if (audit.status !== 'passed' && !dirtyOnly) fail('formal_audit_unexpected_failure')
  return {
    schemaVersion: 1,
    status: audit.status === 'passed' ? 'passed' : 'functional_pass_formal_fail',
    functionalPassed: true,
    formalBinding: audit.status === 'passed',
    worktreeClean: input.worktreeClean,
    requestCount: input.requestCount,
    toolCallCount: input.toolCallCount,
    transcriptSha256: input.transcriptSha256,
    artifactSha256: input.artifactSha256,
    recoverySha256: input.recovered.recoverySha256,
    finishedAt: input.finishedAt
  }
}

async function runRecoveryChild() {
  assertSanitizedChildEnvironment()
  const manifestPath = argValue('--manifest')
  if (!manifestPath) fail('recovery_manifest_missing')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const electronStub = createElectronStub(manifest.userData)
  require('node:module').Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronStub
    return originalLoad.call(this, request, parent, isMain)
  }
  const taskSnapshot = loadRecoveryModule(manifest.outDir, 'task-snapshot.js')
  const artifactModule = loadRecoveryModule(manifest.outDir, 'artifact-lifecycle-api.js')
  const projectModule = loadRecoveryModule(manifest.outDir, 'project-workspace/index.js')
  const historyModule = loadRecoveryModule(manifest.outDir, 'history.js')

  const runs = await recoveryStep('run_read_failed', () =>
    taskSnapshot.listTaskRuns(manifest.sessionId, manifest.userData))
  const run = runs.find((candidate) => candidate.id === manifest.runId)
  if (!run || !isTerminalRun(run.status)) fail('recovery_run_missing')
  const artifact = await recoveryStep('artifact_read_failed', () =>
    artifactModule.getPersistedArtifactLifecycle(manifest.artifactId, manifest.userData))
  if (!artifact || artifact.digest !== manifest.artifactSha256) fail('recovery_artifact_missing')
  const verification = await recoveryStep('artifact_verify_failed', () =>
    artifactModule.verifyPersistedArtifactLifecycle(manifest.userData, ['test_report']))
  if (verification.artifacts < 1) fail('recovery_artifact_invalid')
  const workspace = new projectModule.ProjectWorkspaceStore(manifest.userData)
  await recoveryStep('workspace_open_failed', () => workspace.open())
  const state = await recoveryStep('workspace_read_failed', () => workspace.getState())
  const workItem = state.workItems.find((item) => item.id === manifest.workItemId)
  if (!state.workspaces.some((item) => item.id === manifest.projectId) ||
      !state.goals.some((item) => item.id === manifest.goalId) ||
      !workItem?.runRefs.includes(manifest.runId)) fail('recovery_ownership_missing')
  const history = recoveryStepSync('history_read_failed', () =>
    historyModule.listHistory().find((item) => item.id === manifest.sessionId))
  const costPersisted = Boolean(history && Number.isFinite(history.costUsd) && history.costUsd >= manifest.minimumCostUsd)
  if (!costPersisted) fail('recovery_billing_missing')
  return {
    ok: true,
    costPersisted,
    recoverySha256: sha256(Buffer.from(JSON.stringify({
      runStatus: run.status,
      runRevision: run.revision,
      artifactDigest: artifact.digest,
      artifactVersion: artifact.version,
      projectRevision: state.revision,
      verifiedArtifacts: verification.artifacts,
      costPersisted
    })))
  }
}

function loadRecoveryModule(outDir, suffix) {
  try {
    return require(findCompiled(outDir, suffix))
  } catch (error) {
    if (error instanceof SafeFailure) throw error
    fail('recovery_module_load_failed')
  }
}

async function recoveryStep(code, action) {
  try {
    return await action()
  } catch (error) {
    if (error instanceof SafeFailure) throw error
    fail(code)
  }
}

function recoveryStepSync(code, action) {
  try {
    return action()
  } catch (error) {
    if (error instanceof SafeFailure) throw error
    fail(code)
  }
}

function readPrivateProviderConfig() {
  const setting = argValue('--providers') || process.env.CAOGEN_REAL_PROVIDER_PROVIDERS ||
    process.env.CAOGEN_CHINA_PARITY_PROVIDERS
  const allowLoopback = process.env.CAOGEN_REAL_PROVIDER_RELEASE_TEST_MODE === '1' &&
    process.argv.includes('--allow-loopback-fixture')
  let raw
  try {
    raw = resolvePrivateProviderConfig({
      setting,
      repoRoot,
      allowTestOverride: allowLoopback
    }).text
  } catch (error) {
    if (error instanceof PrivateProviderConfigError) fail(error.code)
    fail('provider_config_invalid')
  }
  let providers
  try {
    providers = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    fail('provider_config_invalid')
  }
  if (!Array.isArray(providers)) fail('provider_config_invalid')
  return { providers, allowLoopback }
}

async function selectEligibleProvider(providers, allowLoopback) {
  const candidates = providers.flatMap((item, index) => {
    if (!item || typeof item !== 'object' || item.group !== 'baseline') return []
    if (item.apiFormat !== 'openai-responses' && item.apiFormat !== 'openai-compatible') return []
    const baseUrl = stringValue(item.baseUrl)
    const model = stringValue(item.model)
    const apiKey = stringValue(item.apiKey)
    if (!baseUrl || !model || !apiKey) return []
    return [{ index, apiFormat: item.apiFormat, baseUrl: normalizeProviderUrl(baseUrl), model, apiKey }]
  }).sort((left, right) => formatRank(left.apiFormat) - formatRank(right.apiFormat) || left.index - right.index)
  if (candidates.length === 0) fail('eligible_baseline_missing')
  const rejectionCodes = []
  for (const candidate of candidates) {
    try {
      await assertNetworkTarget(candidate.baseUrl, allowLoopback)
      return candidate
    } catch (error) {
      rejectionCodes.push(safeErrorCode(error))
      // Try the next configured baseline without disclosing target details.
    }
  }
  if (rejectionCodes.length > 0 && rejectionCodes.every((code) => code === rejectionCodes[0])) {
    fail(`eligible_baseline_${rejectionCodes[0]}`)
  }
  fail('eligible_baseline_target_rejected')
}

async function assertNetworkTarget(value, allowLoopback) {
  const url = parseProviderTarget(value)
  if (assertProviderUrlPolicy(url, allowLoopback)) return
  const addresses = await resolveProviderAddresses(url.hostname)
  assertProviderAddresses(addresses)
}

function parseProviderTarget(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail('provider_url_invalid')
  }
  return url
}

function assertProviderUrlPolicy(url, allowLoopback) {
  let loopback
  try {
    loopback = isLoopbackHostname(url.hostname)
  } catch {
    fail('provider_hostname_invalid')
  }
  if (allowLoopback && loopback && url.protocol === 'http:') return true
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('provider_target_rejected')
  let directPrivate
  try {
    directPrivate = isPrivateAddress(url.hostname)
  } catch {
    fail('provider_hostname_invalid')
  }
  if (loopback || directPrivate) fail('provider_target_rejected')
  return false
}

async function resolveProviderAddresses(hostname) {
  let addresses
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    fail('provider_dns_unavailable')
  }
  return addresses
}

function assertProviderAddresses(addresses) {
  let resolvedPrivate
  try {
    resolvedPrivate = addresses.some((entry) => isPrivateAddress(entry.address))
  } catch {
    fail('provider_dns_result_invalid')
  }
  if (addresses.length === 0 || resolvedPrivate) fail('provider_target_rejected')
}

function installBoundedFetch(baseUrl, maxRequests, timeoutMs) {
  if (typeof originalFetch !== 'function') fail('fetch_unavailable')
  const origin = new URL(baseUrl).origin
  let requests = 0
  let responses = 0
  let rejected = 0
  let active = 0
  let lastOutcome = 'not_started'
  globalThis.fetch = async (input, init = {}) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (target.origin !== origin) fail('unexpected_network_target')
    requests += 1
    if (requests > maxRequests) fail('request_cap_exceeded')
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal
    active += 1
    lastOutcome = 'pending'
    try {
      const response = await originalFetch(input, { ...init, signal })
      responses += 1
      lastOutcome = response.ok ? 'response_success' : 'response_error'
      return response
    } catch (error) {
      rejected += 1
      lastOutcome = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'aborted' : 'rejected'
      throw error
    } finally {
      active -= 1
    }
  }
  return {
    requestCount: () => requests,
    diagnostic: () => ({ requests, responses, rejected, active, lastOutcome }),
    restore: () => { globalThis.fetch = originalFetch }
  }
}

function installRuntimeEnvironment(outDir, userData) {
  process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
  require('node:module').Module._initPaths()
  const electronStub = createElectronStub(userData)
  require('node:module').Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronStub
    return originalLoad.call(this, request, parent, isMain)
  }
  if (!findCompiledOptional(outDir, 'sessionManager.js')) fail('compiled_harness_missing')
}

function createElectronStub(userData) {
  class EmptyWindow {
    static getAllWindows() { return [] }
    isDestroyed() { return false }
  }
  return {
    app: {
      getPath: () => userData,
      getAppPath: () => repoRoot,
      getVersion: () => readPackageVersion(),
      getName: () => 'EastGenesis',
      isPackaged: false,
      focus() {}
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => ''
    },
    BrowserWindow: EmptyWindow,
    WebContentsView: class {},
    powerSaveBlocker: { start: () => 1, stop() {}, isStarted: () => false },
    Notification: class { static isSupported() { return false } once() {} show() {} },
    desktopCapturer: { getSources: async () => [] },
    systemPreferences: { getMediaAccessStatus: () => 'denied', askForMediaAccess: async () => false },
    shell: { openExternal: async () => undefined, openPath: async () => '' }
  }
}

function compileProductionHarness(outDir) {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/sessionManager.ts',
    'src/main/task/artifact-lifecycle-api.ts',
    'src/main/project-workspace/index.ts',
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, encoding: 'utf8', env: sanitizedChildEnvironment() })
  if (result.error || result.signal || result.status !== 0 || !findCompiledOptional(outDir, 'sessionManager.js') ||
      !findCompiledOptional(outDir, 'artifact-lifecycle-api.js')) fail('production_compile_failed')
}

function runRecoveryProcess(manifestPath) {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'real-provider-release-runner.mjs'),
    '--recovery-child', '--manifest', manifestPath
  ], { cwd: repoRoot, encoding: 'utf8', env: sanitizedChildEnvironment() })
  if (result.error || result.signal) fail('recovery_process_failed')
  if (result.status !== 0) {
    const childCode = parseSafeChildErrorCode(result.stdout)
    fail(childCode ? `recovery_${childCode}` : 'recovery_process_failed')
  }
  try {
    const parsed = JSON.parse(result.stdout.trim())
    if (parsed.ok !== true || !isSha256(parsed.recoverySha256)) fail('recovery_process_failed')
    return parsed
  } catch {
    fail('recovery_process_failed')
  }
}

function parseSafeChildErrorCode(stdout) {
  try {
    const parsed = JSON.parse(stdout.trim())
    const code = parsed?.status === 'failed' && typeof parsed.errorCode === 'string' ? parsed.errorCode : ''
    return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

function runFormalAudit(recordPath, reportRoot) {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'real-provider-release-audit.mjs'),
    '--required', '--record', recordPath, '--report-root', reportRoot
  ], { cwd: repoRoot, encoding: 'utf8', env: sanitizedChildEnvironment() })
  if (result.error || result.signal || !result.stdout.trim()) fail('formal_audit_unavailable')
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    fail('formal_audit_unavailable')
  }
  return {
    status: report.status,
    failures: Array.isArray(report.failures) ? report.failures : [],
    reportFile: report.reportFile
  }
}

function sanitizedChildEnvironment() {
  const env = {}
  for (const key of [
    'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'SHELL', 'USER', 'LOGNAME', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT'
  ]) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key]
  }
  env.NODE_PATH = path.join(repoRoot, 'node_modules')
  return env
}

function assertSanitizedChildEnvironment() {
  const forbidden = new Set(['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'])
  for (const key of Object.keys(process.env)) {
    if (forbidden.has(key) || /(?:^|_)(?:TOKEN|SECRET|API_KEY)$/.test(key)) {
      fail('child_environment_not_sanitized')
    }
  }
}

function releasePrompt(fileName, content) {
  return [
    'Use the write_file tool exactly once. Do not call any other tool.',
    `Write a new file named ${fileName} in the current working directory.`,
    'The file content must exactly match the text between CONTENT markers, including its final newline.',
    `CONTENT-BEGIN\n${content}CONTENT-END`,
    'After the tool result, reply with a short completion acknowledgement.'
  ].join('\n')
}

function successfulWriteTool(transcript, fileName) {
  const uses = durableToolCalls(transcript)
  const write = uses.find((block) => block.name === 'write_file' && block.input?.path === fileName)
  if (!write) return false
  return transcript.some((entry) => entry.event.kind === 'tool-result' &&
    entry.event.toolUseId === write.id && entry.event.isError === false && entry.event.effectStatus === 'confirmed')
}

function durableToolCalls(transcript) {
  return transcript.flatMap((entry) => entry.event.kind === 'assistant-message'
    ? entry.event.blocks.filter((block) => block.type === 'tool_use')
    : [])
}

function successfulTurn(transcript) {
  const result = transcript.findLast((entry) => entry.event.kind === 'turn-result')?.event
  return result?.kind === 'turn-result' && result.isError === false
}

function turnCompletionDiagnostic(manager, sessionId, protocol, restoreNetwork) {
  const transcript = manager.getTranscript(sessionId)
  const sessionStatus = manager.get(sessionId)?.meta.status ?? 'missing'
  const runStatus = manager.taskRuns.get(sessionId)?.status ?? 'missing'
  const lastEventKind = transcript.at(-1)?.event.kind ?? 'none'
  const counts = { toolStart: 0, assistantMessage: 0, toolResult: 0, textDelta: 0, turnResult: 0, status: 0 }
  for (const entry of transcript) {
    if (entry.event.kind === 'tool-start') counts.toolStart += 1
    else if (entry.event.kind === 'assistant-message') counts.assistantMessage += 1
    else if (entry.event.kind === 'tool-result') counts.toolResult += 1
    else if (entry.event.kind === 'text-delta') counts.textDelta += 1
    else if (entry.event.kind === 'turn-result') counts.turnResult += 1
    else if (entry.event.kind === 'status') counts.status += 1
  }
  return {
    protocol,
    sessionStatus,
    runStatus,
    transcriptEntries: transcript.length,
    lastEventKind,
    eventCounts: counts,
    network: restoreNetwork.diagnostic()
  }
}

function redactedTranscriptShape(transcript) {
  return transcript.map((entry) => {
    const event = entry.event
    if (event.kind === 'tool-start') return { seq: entry.seq, kind: event.kind, name: event.name }
    if (event.kind === 'assistant-message') return {
      seq: entry.seq,
      kind: event.kind,
      tools: event.blocks.filter((block) => block.type === 'tool_use').map((block) => block.name)
    }
    if (event.kind === 'tool-result') return {
      seq: entry.seq, kind: event.kind, isError: event.isError, effectStatus: event.effectStatus
    }
    if (event.kind === 'turn-result') return {
      seq: entry.seq,
      kind: event.kind,
      isError: event.isError,
      usage: event.usage,
      costPresent: typeof event.costUsd === 'number' && event.costUsd > 0
    }
    if (event.kind === 'status') return { seq: entry.seq, kind: event.kind, status: event.status }
    return { seq: entry.seq, kind: event.kind }
  })
}

function assertProviderFileRedacted(userData, secret) {
  const file = path.join(userData, 'providers.json')
  if (!existsSync(file)) fail('provider_store_missing')
  const raw = readFileSync(file, 'utf8')
  if (raw.includes(secret)) fail('provider_store_secret_leak')
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) fail('provider_store_permissions')
}

function assertExactRegularFile(file, expected) {
  if (!existsSync(file) || !statSync(file).isFile()) fail('tool_output_missing')
  const actual = readFileSync(file)
  if (!actual.equals(expected)) fail('tool_output_mismatch')
}

function resolvePrivateRecordPath(value, runId) {
  const target = path.resolve(value || path.join(process.env.HOME || tmpdir(), '.caogen-private', 'real-provider-release', `${runId}.json`))
  const parent = path.dirname(target)
  assertNoSymlinkTraversal(parent)
  mkdirPrivate(parent)
  assertNoSymlinkTraversal(parent)
  const realParent = realpathSync(parent)
  const realRepoRoot = realpathSync(repoRoot)
  if (isPathWithin(realRepoRoot, realParent)) fail('record_path_inside_repo')
  const realTarget = path.join(realParent, path.basename(target))
  if (existsSync(realTarget) && lstatSync(realTarget).isSymbolicLink()) fail('record_path_symlink')
  return realTarget
}

function assertNoSymlinkTraversal(directory) {
  const absolute = path.resolve(directory)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const info = lstatSync(current)
      if (info.isSymbolicLink()) fail('record_parent_symlink')
      if (!info.isDirectory()) fail('record_parent_invalid')
    } catch (error) {
      if (error instanceof SafeFailure) throw error
      if (error?.code === 'ENOENT') return
      throw error
    }
  }
}

function isPathWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function resolveAuditReportRoot(value) {
  return path.resolve(value || path.join(repoRoot, 'test-results', 'real-provider-release'))
}

function writePrivateJson(file, value) {
  const parent = path.dirname(file)
  mkdirPrivate(parent)
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(file, 0o600)
}

function mkdirPrivate(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(directory, 0o700)
}

function suppressConsole() {
  console.log = () => undefined
  console.info = () => undefined
  console.warn = () => undefined
  console.error = () => undefined
  return () => Object.assign(console, originalConsole)
}

function monotonicMarks() {
  let previous = Date.now() - 1
  return {
    next() {
      previous = Math.max(Date.now(), previous + 1)
      return new Date(previous).toISOString()
    }
  }
}

async function waitFor(producer, timeoutMs, code, diagnostic) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await producer()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  fail(code, diagnostic?.())
}

function findCompiled(root, suffix) {
  const found = findCompiledOptional(root, suffix)
  if (!found) fail('compiled_module_missing')
  return found
}

function findCompiledOptional(root, suffix) {
  if (!existsSync(root)) return null
  const normalized = suffix.split('/').join(path.sep)
  const nestedSuffix = normalized.includes(path.sep)
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(full, suffix)
      if (found) return found
    } else if (entry.isFile() && (entry.name === suffix || nestedSuffix && full.endsWith(`${path.sep}${normalized}`))) {
      return full
    }
  }
  return null
}

function normalizeProviderUrl(value) {
  const parsed = new URL(value.trim().replace(/\/+$/, ''))
  if (parsed.username || parsed.password || parsed.search || parsed.hash) fail('provider_target_rejected')
  return parsed.toString().replace(/\/$/, '')
}

function formatRank(value) {
  return value === 'openai-responses' ? 0 : 1
}

function isLoopbackHostname(value) {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1'
}

function isPrivateAddress(value) {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (privateIpv6Patterns.some((pattern) => pattern.test(host))) return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || !parts.every(isIpv4Octet)) return false
  const address = parts.reduce((result, part) => ((result << 8) | part) >>> 0, 0)
  return privateIpv4Ranges.some(([start, end]) => address >= start && address <= end)
}

function isIpv4Octet(value) {
  return Number.isInteger(value) && value >= 0 && value <= 255
}

function isTerminalRun(value) {
  return ['completed', 'failed', 'cancelled'].includes(value)
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function isSha256(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/i.test(value)
}

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
  } catch {
    fail('package_version_unavailable')
  }
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function boundedInteger(value, fallback, min, max, code) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail(code)
  return parsed
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}

function fail(code, diagnostic) {
  throw new SafeFailure(code, diagnostic)
}

function safeErrorCode(error) {
  return error instanceof SafeFailure ? error.code : 'internal_error'
}

function safeFailureDiagnostic(error) {
  return error instanceof SafeFailure && error.diagnostic && typeof error.diagnostic === 'object'
    ? error.diagnostic
    : undefined
}
