import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
require('node:module').Module._initPaths()

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-remote-continuation-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const foreignRoot = path.join(tempRoot, 'foreign-user-data')
const corruptRoot = path.join(tempRoot, 'corrupt-user-data')
let stopWebhookServer = async () => undefined

try {
  for (const root of [userData, foreignRoot, corruptRoot]) mkdirSync(root, { recursive: true })
  compileSources()
  installElectronStub()

  const workspaceApi = await importCompiled('main/project-workspace/index.js')
  const remoteApi = await importCompiled('main/remote/store.js')
  const { RemoteContinuationStore } = remoteApi
  const webhookApi = await importCompiled('main/remote/webhook-server.js')
  const webhookStatusApi = await importCompiled('main/remote/webhook-status.js')
  stopWebhookServer = webhookApi.stopRemoteWebhookServer

  const workspaceStore = await new workspaceApi.ProjectWorkspaceStore(userData).open()
  const workspace = await workspaceStore.createWorkspace({ id: 'remote-project', name: 'Remote Project' })
  const goal = await workspaceStore.createGoal({
    id: 'remote-goal', projectId: workspace.id, title: 'Remote Goal', objective: 'Verify remote continuation'
  })
  const workItem = await workspaceStore.createWorkItem({
    id: 'remote-work-item', projectId: workspace.id, goalId: goal.id, title: 'Remote Work', type: 'testing'
  })

  const firstKeys = keyPair()
  const secondKeys = keyPair()
  const store = new RemoteContinuationStore(userData)
  const firstDevice = await store.registerDevice({
    label: 'Primary phone',
    userId: 'local-user',
    publicKey: firstKeys.publicKey,
    capabilities: ['view_results', 'resume_work_item', 'approve_effect', 'trigger_routine', 'remote_runner']
  })
  const secondDevice = await store.registerDevice({
    label: 'Standby runner',
    userId: 'local-user',
    publicKey: secondKeys.publicKey,
    capabilities: ['view_results', 'remote_runner']
  })
  assert(firstDevice.publicKey === firstKeys.publicKey, 'active binding exposes only its public key')
  assert(!readFileSync(path.join(userData, 'remote-continuation.json'), 'utf8').includes(firstKeys.privateKey), 'private key must never enter the remote store')

  await store.setConnectivity('offline')
  const offlineEnvelope = signedCommand(firstDevice.id, firstKeys.privateKeyObject, {
    commandId: 'remote-command-offline',
    kind: 'view_result',
    projectId: workspace.id,
    revision: workspace.revision
  })
  const offline = await store.ingest(offlineEnvelope)
  assertEqual(offline.status, 'offline', 'offline command is durably queued')
  const revisionBeforeDuplicate = (await store.getSnapshot()).revision
  const duplicate = await store.ingest(offlineEnvelope)
  assertEqual(duplicate.envelope.commandId, offlineEnvelope.commandId, 'duplicate command returns the canonical record')
  assertEqual((await store.getSnapshot()).revision, revisionBeforeDuplicate, 'duplicate command performs no write')

  const conflicting = signedCommand(firstDevice.id, firstKeys.privateKeyObject, {
    commandId: offlineEnvelope.commandId,
    kind: 'view_result',
    projectId: workspace.id,
    revision: workspace.revision,
    dataClass: 'artifact_summary'
  })
  await assertRejects(
    store.ingest(conflicting),
    /identity conflict/,
    'same commandId with different signed bytes is rejected'
  )
  await assertRejects(
    store.ingest({ ...signedCommand(firstDevice.id, secondKeys.privateKeyObject, {
      commandId: 'remote-command-wrong-key', kind: 'view_result', projectId: workspace.id, revision: workspace.revision
    }) }),
    /signature is invalid/,
    'command signed by another key is rejected'
  )

  await store.updateDeviceCapabilities(firstDevice.id, ['resume_work_item', 'approve_effect', 'trigger_routine', 'remote_runner'])
  assertEqual((await store.getCommand(offlineEnvelope.commandId)).status, 'rejected', 'capability revocation rejects queued commands')
  await store.updateDeviceCapabilities(firstDevice.id, ['view_results', 'resume_work_item', 'approve_effect', 'trigger_routine', 'remote_runner'])

  const runnableEnvelope = signedCommand(firstDevice.id, firstKeys.privateKeyObject, {
    commandId: 'remote-command-runnable',
    kind: 'view_result',
    projectId: workspace.id,
    revision: workspace.revision
  })
  assertEqual((await store.ingest(runnableEnvelope)).status, 'offline', 'second offline command is queued')
  await store.setConnectivity('online')
  assertEqual((await store.reconcile()).commands.find((item) => item.envelope.commandId === runnableEnvelope.commandId).status, 'pending', 'reconnect promotes queued command')

  const claims = await Promise.all([
    store.claimCommandExecution(runnableEnvelope.commandId),
    store.claimCommandExecution(runnableEnvelope.commandId)
  ])
  assert(claims.every((item) => item?.execution?.status === 'running'), 'concurrent claims converge on one running execution')
  const startedAudits = (await store.getSnapshot()).audit.filter((item) => item.action === 'command_execution_started' && item.commandId === runnableEnvelope.commandId)
  assertEqual(startedAudits.length, 1, 'concurrent claim emits one execution-start audit')
  const finished = await store.finishCommandExecution(runnableEnvelope.commandId, { status: 'succeeded', runId: 'remote-read-run' })
  assertEqual(finished.execution.status, 'succeeded', 'command records successful execution')
  const terminalReplay = await store.finishCommandExecution(runnableEnvelope.commandId, { status: 'failed', error: 'must not replace success' })
  assertEqual(terminalReplay.execution.status, 'succeeded', 'terminal execution is immutable under replay')

  const lease = await store.acquireLease({
    projectId: workspace.id,
    workItemId: workItem.id,
    deviceId: firstDevice.id,
    runnerKind: 'remote',
    ttlMs: 10_000
  })
  const renewed = await store.acquireLease({
    projectId: workspace.id,
    workItemId: workItem.id,
    deviceId: firstDevice.id,
    runnerKind: 'remote',
    ttlMs: 20_000
  })
  assertEqual(renewed.id, lease.id, 'same device renews the existing lease')
  assertEqual(renewed.revision, lease.revision + 1, 'lease renewal advances revision')
  await assertRejects(
    store.acquireLease({ projectId: workspace.id, workItemId: workItem.id, deviceId: secondDevice.id, runnerKind: 'remote' }),
    /held by another device/,
    'another device cannot steal an active lease'
  )
  await assertRejects(
    store.releaseLease({ leaseId: renewed.id, deviceId: firstDevice.id, expectedRevision: lease.revision }),
    /revision conflict/,
    'stale lease release is rejected'
  )
  const released = await store.releaseLease({ leaseId: renewed.id, deviceId: firstDevice.id, expectedRevision: renewed.revision })
  assertEqual(released.status, 'released', 'lease owner can release with current revision')

  const restarted = new RemoteContinuationStore(userData)
  const restartedSnapshot = await restarted.getSnapshot()
  assertEqual(restartedSnapshot.commands.length, 2, 'restart restores durable command history')
  assertEqual(restartedSnapshot.devices.length, 2, 'restart restores device bindings')
  assert(/^[0-9a-f]{64}$/.test(restartedSnapshot.snapshotDigest), 'restart snapshot has a canonical digest')

  const foreignKeys = keyPair()
  const foreignStore = new RemoteContinuationStore(foreignRoot)
  const foreignDevice = await foreignStore.registerDevice({
    label: 'Foreign device', userId: 'foreign-user', publicKey: foreignKeys.publicKey, capabilities: ['view_results']
  })
  await assertRejects(
    foreignStore.ingest(signedCommand(foreignDevice.id, foreignKeys.privateKeyObject, {
      commandId: 'foreign-cross-root-command', kind: 'view_result', projectId: workspace.id, revision: workspace.revision
    })),
    /Project not found/,
    'explicit remote root cannot read a Project from Electron default userData'
  )

  const pendingBeforeUnbind = signedCommand(firstDevice.id, firstKeys.privateKeyObject, {
    commandId: 'remote-command-before-unbind', kind: 'view_result', projectId: workspace.id, revision: workspace.revision
  })
  await restarted.ingest(pendingBeforeUnbind)
  const revoked = await restarted.unbindDevice(firstDevice.id)
  assertEqual(revoked.status, 'revoked', 'device unbind is durable')
  assert(revoked.publicKey === undefined, 'revoked device no longer exposes public key bytes')
  assertEqual((await restarted.getCommand(pendingBeforeUnbind.commandId)).status, 'rejected', 'unbind rejects queued commands')

  writeFileSync(path.join(corruptRoot, 'remote-continuation.json'), '{not-json\n', 'utf8')
  await assertRejects(
    new RemoteContinuationStore(corruptRoot).getSnapshot(),
    /store is corrupt/,
    'corrupt remote store fails closed'
  )

  await assertRejects(
    webhookApi.startRemoteWebhookServer({ rootDir: userData, host: '0.0.0.0', port: 0 }),
    /non-loopback listeners require explicit TLS/,
    'non-loopback webhook listeners reject plain HTTP without explicit TLS'
  )

  const address = await webhookApi.startRemoteWebhookServer({ rootDir: userData, host: '127.0.0.1', port: 0 })
  const baseUrl = `http://${address.host}:${address.port}`
  const pairing = await webhookApi.createRemotePairingSession({ ttlMs: 30_000, projectId: workspace.id })
  assert(pairing.url.startsWith(`${baseUrl}/remote/pair/`), 'pairing URL binds the active loopback listener')
  const pairingPage = await fetch(pairing.url)
  assertEqual(pairingPage.status, 200, 'active pairing page is available')
  assertEqual(pairingPage.headers.get('cache-control'), 'no-store', 'pairing page is never cached')
  assert((await pairingPage.text()).includes('CaoGen 设备配对'), 'pairing page contains the device binding experience')

  const browserKeys = keyPair()
  const registration = await fetchJson(`${baseUrl}/remote/pair/register`, {
    token: pairing.token,
    label: 'Browser phone',
    userId: 'mobile-user',
    publicKey: browserKeys.publicKey
  })
  assertEqual(registration.response.status, 201, 'pairing registration creates a device')
  assert(typeof registration.body.deviceId === 'string', 'pairing registration returns device identity')
  assert(typeof registration.body.consoleUrl === 'string', 'pairing registration returns a console URL')

  const replayedPairing = await fetchJson(`${baseUrl}/remote/pair/register`, {
    token: pairing.token,
    label: 'Replay phone',
    userId: 'mobile-user',
    publicKey: browserKeys.publicKey
  })
  assertEqual(replayedPairing.response.status, 400, 'pairing token is one-time')

  const consolePage = await fetch(registration.body.consoleUrl)
  assertEqual(consolePage.status, 200, 'registered device can open its console page')
  assert((await consolePage.text()).includes('CaoGen 远程控制台'), 'console page renders the remote control surface')
  const consoleToken = decodeURIComponent(new URL(registration.body.consoleUrl).pathname.split('/').at(-1))
  const consoleView = await fetch(`${baseUrl}/remote/console-api?token=${encodeURIComponent(consoleToken)}`)
  const consoleBody = await consoleView.json()
  assertEqual(consoleView.status, 200, 'bound console can read its Project projection')
  assertEqual(consoleBody.projectId, workspace.id, 'console projection remains Project-scoped')
  assertEqual(consoleBody.projection.projectId, workspace.id, 'result projection remains Project-scoped')
  assert(!JSON.stringify(consoleBody).includes(browserKeys.privateKey), 'console response never exposes browser private key')

  const singletonStore = remoteApi.getRemoteContinuationStore(userData)
  await singletonStore.updateDeviceCapabilities(registration.body.deviceId, ['resume_work_item'])
  const revokedConsole = await fetch(`${baseUrl}/remote/console-api?token=${encodeURIComponent(consoleToken)}`)
  const revokedBody = await revokedConsole.json()
  assertEqual(revokedConsole.status, 400, 'revoked view capability immediately blocks the existing console')
  assert(/没有查看结果权限/.test(String(revokedBody.error)), 'console reports the revoked capability boundary')

  const missingRoute = await fetch(`${baseUrl}/remote/not-found`)
  assertEqual(missingRoute.status, 404, 'unknown remote routes fail closed')
  assertEqual(missingRoute.headers.get('cache-control'), 'no-store', 'remote JSON responses are never cached')

  await webhookApi.stopRemoteWebhookServer()
  assertEqual(webhookStatusApi.getRemoteWebhookStatus().running, false, 'stopped webhook no longer reports running')
  await assertRejects(
    webhookApi.createRemotePairingSession({ projectId: workspace.id }),
    /not listening/,
    'pairing cannot be issued after listener shutdown'
  )

  console.log('remote continuation required: PASS')
} finally {
  await stopWebhookServer()
  rmSync(tempRoot, { recursive: true, force: true })
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    privateKeyObject: privateKey
  }
}

function signedCommand(deviceId, privateKey, input) {
  const createdAt = Date.now()
  const scope = {
    projectId: input.projectId,
    artifactIds: [],
    dataClass: input.dataClass ?? 'metadata_only'
  }
  const payload = { kind: input.kind, scope, revision: input.revision }
  const unsigned = {
    schemaVersion: 1,
    commandId: input.commandId,
    issuerDeviceId: deviceId,
    kind: input.kind,
    scope,
    revision: input.revision,
    expiresAt: createdAt + 5 * 60_000,
    createdAt,
    payloadDigest: createHash('sha256').update(canonicalJson(payload)).digest('hex')
  }
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64')
  }
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value))
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]))
  }
  return value
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/remote/store.ts',
    'src/main/remote/webhook-server.ts',
    'src/main/project-workspace/index.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

async function fetchJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { response, body: await response.json() }
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(userData)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function importCompiled(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

async function assertRejects(promise, pattern, label) {
  try {
    await promise
  } catch (error) {
    if (pattern.test(String(error?.message ?? error))) return
    throw new Error(`${label}: unexpected error ${String(error?.stack ?? error)}`)
  }
  throw new Error(`${label}: expected rejection`)
}

function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
