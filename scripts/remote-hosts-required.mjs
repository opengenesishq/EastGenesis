import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Module } from 'node:module'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'caogen-remote-hosts-')), serverRoot = join(root, 'server'), clientRoot = join(root, 'client')
const key = randomBytes(32), requests = [], consoleTokens = new Map()
const protection = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'fixture-aes',
  encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]) },
  decryptString(value) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString() } }
const unavailable = { ...protection, isEncryptionAvailable: () => false }
const identity = { origin: 'https://fixture.invalid', spkiFingerprint: `sha256:${'a'.repeat(64)}`, commonName: 'fixture.invalid', issuer: 'Offline fixture', validFrom: new Date().toISOString(), validTo: new Date(Date.now() + 86400000).toISOString() }
let api, address, checks = 0, loseCommandReply = false, loseReceipt = false, wrongIdentity = false, runStatus = 'running'
const pass = name => { checks++; console.log(`PASS ${name}`) }
const aggregate = { workspace: { id: 'project-1', name: 'Offline remote project' }, projectRevision: 1, goals: [],
  workItems: [{ id: 'work-1', title: 'Offline remote task', status: 'running', revision: 7 }],
  workflow: { artifacts: [], acceptances: [], artifactLocations: [], runs: [], workflowEvidence: [], taskEvidence: [] } }
globalThis.__remoteHostsFixture = { root: serverRoot, aggregate, runs: () => [{ id: 'run-1', projectId: 'project-1', workItemId: 'work-1', status: runStatus }] }
try {
  const mocks = {
    electron: 'export const app = {getPath: () => globalThis.__remoteHostsFixture.root}',
    'project-aggregate': 'export const createProductionProjectAggregateService=()=>({verifyLiveProject:async id=>{if(id!=="project-1")throw Error("project mismatch");return globalThis.__remoteHostsFixture.aggregate}})',
    routineStore: 'export const listRoutines=async()=>[]',
    'supervisor-state': 'export class SupervisorStateStore { async listRuns(){return globalThis.__remoteHostsFixture.runs()} }',
    executor: 'export async function executeRemoteCommand(root,id){ const store=globalThis.__remoteHostsFixture.api.getRemoteContinuationStore(root);const claimed=await store.claimCommandExecution(id);return claimed.status==="accepted"?store.finishCommandExecution(id,{status:"succeeded"}):claimed }',
    'workspace-runtime': 'export async function remoteApprovalCandidates(){return []}; export async function readBoundRemoteWorkspace(){throw Error("not part of original control-plane fixture")}',
    'sessionManager.js': 'export const sessionManager={get:()=>undefined}',
    'business-line-registry-reader': 'export function assertActiveBusinessLine(){}'
  }
  const built = await build({ stdin: { contents: `export * from './src/main/remote-hosts/service';export * from './src/main/remote-hosts/store';export * from './src/main/remote-hosts/transport';export * from './src/main/remote-hosts/protocol';export * from './src/main/remote/webhook-server';export * from './src/main/remote/store';export * from './src/main/remote/console-session-store';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'offline-runtime', setup(b) { b.onResolve({ filter: /.*/ }, args => { const name = args.path.split('/').at(-1); return Object.hasOwn(mocks, name) ? { path: name, namespace: 'fixture' } : undefined }); b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' })) } }] })
  const filename = resolve('scripts/.remote-hosts-fixture.cjs'), mod = new Module(filename)
  mod.filename = filename; mod.paths = Module._nodeModulePaths(dirname(filename)); mod._compile(built.outputFiles[0].text, filename)
  api = mod.exports; globalThis.__remoteHostsFixture.api = api
  const listener = await api.startRemoteWebhookServer({ rootDir: serverRoot, host: '127.0.0.1', port: 0 })
  address = `http://127.0.0.1:${listener.port}`
  const transport = {
    inspect: async origin => { assert.equal(origin, identity.origin); return { ...identity } },
    async request(server, method, path, token, body) {
      assert.equal(server.origin, identity.origin); assert.equal(server.spkiFingerprint, identity.spkiFingerprint)
      if (wrongIdentity) throw Error('fixture certificate key changed')
      requests.push({ method, path })
      if (loseReceipt && path.startsWith('/remote/console-command?')) throw Error('fixture receipt unavailable')
      const response = await fetch(address + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
      const data = await response.json()
      if (path === '/remote/pair/register' && response.status === 201) {
        data.consoleUrl = data.consoleUrl.replace(address, identity.origin)
        consoleTokens.set(data.deviceId, data.consoleUrl.split('/').at(-1))
      }
      if (loseCommandReply && path === '/remote/console-api' && method === 'POST') throw Error('fixture lost reply after remote acceptance')
      return { status: response.status, body: data }
    }
  }
  const service = new api.RemoteHostService(clientRoot, protection, transport)
  const pair = async (target = service, storage = 'encrypted') => {
    const invitation = await api.createRemotePairingSession({ projectId: 'project-1' })
    const preview = await target.inspectRemoteHostPairing(invitation.url.replace(address, identity.origin))
    return target.pairRemoteHost({ previewId: preview.id, confirmedSpkiFingerprint: preview.identity.spkiFingerprint, label: 'Offline host', deviceLabel: 'Offline control device', storage })
  }
  const invitation = await api.createRemotePairingSession({ projectId: 'project-1' })
  const preview = await service.inspectRemoteHostPairing(invitation.url.replace(address, identity.origin))
  assert.equal(requests.length, 0)
  await assert.rejects(service.pairRemoteHost({ previewId: preview.id, confirmedSpkiFingerprint: 'wrong', label: 'host', deviceLabel: 'device', storage: 'encrypted' }), /核对/)
  assert.equal(requests.length, 0)
  service.invalidatePairingPreviews()
  await assert.rejects(service.pairRemoteHost({ previewId: preview.id, confirmedSpkiFingerprint: preview.identity.spkiFingerprint, label: 'host', deviceLabel: 'device', storage: 'encrypted' }), /过期/)
  for (const input of ['http://fixture.invalid/remote/pair/' + 'a'.repeat(32), 'https://user:secret@fixture.invalid/remote/pair/' + 'a'.repeat(32), 'https://fixture.invalid/remote/pair/' + 'a'.repeat(32) + '?next=other']) assert.throws(() => api.parseRemoteHostPairing(input))
  pass('pairing needs a reviewed TLS identity, rejects unsafe links, and invalidates previews on navigation')

  const host = await pair()
  assert.equal(host.status, 'paired'); assert.equal(host.storage, 'encrypted'); assert.equal(host.projectId, 'project-1')
  const disk = readFileSync(join(clientRoot, 'remote-hosts', 'hosts.json'), 'utf8')
  assert(!disk.includes(consoleTokens.get(host.deviceId))); assert(!disk.includes('privateKey')); assert(disk.includes('enc:'))
  assert(!JSON.stringify(await service.listRemoteHosts()).includes('sealedCredentials'))
  assert.equal((await service.readRemoteHostTasks(host.id)).workItems[0].id, 'work-1')
  const restarted = new api.RemoteHostService(clientRoot, protection, transport)
  assert.equal((await restarted.readRemoteHostTasks(host.id)).projectId, 'project-1')
  pass('the real loopback pairing protocol binds a project; encrypted credentials restore without renderer exposure')

  const send = (kind, requestId, extra = {}) => service.sendRemoteHostCommand({ hostId: host.id, kind, workItemId: 'work-1', expectedRevision: 7, requestId, ...extra })
  for (const kind of ['pause_work_item', 'cancel_work_item', 'append_task', 'resume_work_item']) {
    runStatus = kind === 'resume_work_item' ? 'paused' : 'running'
    const result = await send(kind, `request-${kind}`, kind === 'append_task' ? { text: 'fixture-private-instruction' } : {})
    assert.equal(result.execution.status, 'succeeded')
    const stored = await api.getRemoteContinuationStore(serverRoot).getCommand(result.commandId)
    assert.equal(stored.envelope.scope.projectId, 'project-1'); assert.equal(stored.envelope.issuerDeviceId, host.deviceId)
  }
  assert(!readFileSync(join(clientRoot, 'remote-hosts', 'hosts.json'), 'utf8').includes('fixture-private-instruction'))
  pass('resume, append, pause and cancel use real Ed25519 verification, project/revision checks and exact command receipts')

  runStatus = 'running'; loseCommandReply = true; loseReceipt = true
  const before = requests.filter(item => item.method === 'POST' && item.path === '/remote/console-api').length
  const uncertain = await send('pause_work_item', 'uncertain-request')
  assert.equal(uncertain.state, 'unknown')
  assert.equal((await send('pause_work_item', 'uncertain-request')).commandId, uncertain.commandId)
  await assert.rejects(send('pause_work_item', 'new-request'), /尚未确认/)
  assert.equal(requests.filter(item => item.method === 'POST' && item.path === '/remote/console-api').length, before + 1)
  loseReceipt = false; loseCommandReply = false
  assert.equal((await service.reconcileRemoteHostCommand(host.id, uncertain.commandId)).execution.status, 'succeeded')
  assert.equal(requests.filter(item => item.method === 'POST' && item.path === '/remote/console-api').length, before + 1)
  pass('a lost mutation reply survives as unknown and only the original command is queried, with no automatic replay')

  const firstCommand = (await service.listRemoteHosts()).hosts.find(item => item.id === host.id).commands[0]
  for (let i = 0; i < 9; i++) await send('pause_work_item', `history-${i}`)
  assert.equal((await service.reconcileRemoteHostCommand(host.id, firstCommand.commandId)).execution.status, 'succeeded')
  const another = await pair()
  const foreign = await fetch(`${address}/remote/console-command?commandId=${firstCommand.commandId}`, { headers: { authorization: `Bearer ${consoleTokens.get(another.deviceId)}` } })
  assert.equal(foreign.status, 400)
  pass('exact command lookup works beyond the eight-item console summary and rejects another paired device')

  const count = requests.length
  await assert.rejects(service.sendRemoteHostCommand({ hostId: host.id, kind: 'pause_work_item', workItemId: 'work-1', expectedRevision: 6, requestId: 'stale' }), /版本已变化/)
  assert(!requests.slice(count).some(item => item.method === 'POST'))
  await api.getRemoteContinuationStore(serverRoot).updateDeviceCapabilities(host.deviceId, ['view_results'])
  await assert.rejects(send('pause_work_item', 'revoked-capability'), /权限或任务状态/)
  wrongIdentity = true
  await assert.rejects(service.readRemoteHostTasks(host.id), /certificate key changed/)
  wrongIdentity = false
  pass('stale revisions, revoked capabilities and changed server identity block new task actions')

  const token = consoleTokens.get(another.deviceId)
  const forged = await fetch(`${address}/remote/console-revoke`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, kind: 'revoke_device', issuerDeviceId: another.deviceId, projectId: 'project-1', requestId: 'forged', createdAt: Date.now(), expiresAt: Date.now() + 5000, signature: 'wrong' }) })
  assert.equal(forged.status, 400)
  assert.equal((await service.revokeRemoteHost(another.id)).status, 'revoked')
  assert.equal(new api.RemoteConsoleSessionStore(serverRoot).get(token), undefined)
  assert.equal((await api.getRemoteContinuationStore(serverRoot).getSnapshot()).devices.find(item => item.id === another.deviceId).status, 'revoked')
  pass('self-revocation requires a valid signed identity and removes remote authorization plus its console credential')

  const sessionService = new api.RemoteHostService(clientRoot, unavailable, transport)
  const beforeSession = readFileSync(join(clientRoot, 'remote-hosts', 'hosts.json'), 'utf8')
  const sessionHost = await pair(sessionService, 'session')
  assert.equal(sessionHost.status, 'paired'); assert.equal(sessionHost.storage, 'session')
  assert.equal((await sessionService.readRemoteHostTasks(sessionHost.id)).projectId, 'project-1')
  await sessionService.sendRemoteHostCommand({ hostId: sessionHost.id, kind: 'append_task', workItemId: 'work-1', expectedRevision: 7, requestId: 'memory-only', text: 'memory-only-sensitive-content' })
  assert.equal(readFileSync(join(clientRoot, 'remote-hosts', 'hosts.json'), 'utf8'), beforeSession)
  const restartedSession = new api.RemoteHostService(clientRoot, unavailable, transport)
  assert(!(await restartedSession.listRemoteHosts()).hosts.some(item => item.id === sessionHost.id))
  await assert.rejects(pair(sessionService, 'encrypted'), /系统凭据加密不可用/)
  assert.equal((await sessionService.revokeRemoteHost(sessionHost.id)).status, 'revoked')
  pass('explicit session-only pairing works without secure storage, writes no connection or command bytes, and does not survive restart')

  const oldDevice = host.deviceId
  await service.forgetRemoteHost(host.id)
  assert.equal((await api.getRemoteContinuationStore(serverRoot).getSnapshot()).devices.find(item => item.id === oldDevice).status, 'active')
  assert(!(await service.listRemoteHosts()).hosts.some(item => item.id === host.id))
  service.dispose()
  await assert.rejects(service.inspectRemoteHostPairing('https://fixture.invalid/remote/pair/' + 'a'.repeat(32)), /服务已停止/)
  pass('local removal does not claim remote revocation, and disposed services cannot create pairing previews')
  console.log(`remote-hosts-required: ${checks}/${checks}; own loopback server and injected TLS identity only; real signatures and encryption fixtures; no external host, Provider or user credentials`)
} finally {
  await api?.stopRemoteWebhookServer()
  delete globalThis.__remoteHostsFixture
  rmSync(root, { recursive: true, force: true })
}
