import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Module } from 'node:module'
import { build } from 'esbuild'
import { createCipheriv, createDecipheriv, createPrivateKey, randomBytes, sign } from 'node:crypto'

const root = mkdtempSync(join(tmpdir(), 'caogen-handoff-transport-'))
const serverRoot = join(root, 'server'), clientRoot = join(root, 'client')
const calls = [], requests = []
let api, address, service, consoleToken, lastEnvelope, loseReply = false, tamper = false
let renewLoseReply = false, renewDropBefore = false, timeOffset = 0
const renewalRequests = [], renewalReplies = [], originalNow = Date.now
Date.now = () => originalNow() + timeOffset
globalThis.__handoffTransportFixture = { root: serverRoot, calls }
try {
  const mocks = {
    electron: 'export const app={getPath:()=>globalThis.__handoffTransportFixture.root}',
    'project-aggregate': 'export const createProductionProjectAggregateService=()=>({verifyLiveProject:async id=>({workspace:{id,name:"Fixture"},workItems:[],workflow:{}})})',
    routineStore: 'export const listRoutines=async()=>[]',
    'supervisor-state': 'export class SupervisorStateStore{async listRuns(){return []}}',
    executor: 'export async function executeRemoteCommand(){throw Error("outside handoff transport")}',
    'workspace-runtime': 'export async function remoteApprovalCandidates(){return []};export async function readBoundRemoteWorkspace(){throw Error("outside handoff transport")}',
    'sessionManager.js': 'export const sessionManager={get:()=>undefined}',
    'business-line-registry-reader': 'export function assertActiveBusinessLine(){}',
    'handoff-service': 'export async function handleTaskHandoffRemote(root,caller,action,payload){globalThis.__handoffTransportFixture.calls.push({caller,action,payload});return {id:payload.id??null,status:action==="status"?"prepared":"accepted"}}'
  }
  const built = await build({ stdin: { contents: `export * from './src/main/remote-hosts/service';export * from './src/main/remote-hosts/store';export * from './src/main/project-workspace/codec';export * from './src/main/remote/console-renew-protocol';export * from './src/main/remote/webhook-server';export * from './src/main/remote/store';export * from './src/main/remote/console-session-store';export * from './src/main/remote/task-handoff-protocol';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'offline-handoff', setup(b) {
      b.onResolve({ filter: /.*/ }, args => {
        const name = args.path.endsWith('/task-handoff/service') ? 'handoff-service' : args.path.split('/').at(-1)
        return Object.hasOwn(mocks, name) ? { path: name, namespace: 'fixture' } : undefined
      })
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }))
    } }] })
  const filename = resolve('scripts/.handoff-transport-fixture.cjs'), mod = new Module(filename)
  mod.filename = filename; mod.paths = Module._nodeModulePaths(dirname(filename)); mod._compile(built.outputFiles[0].text, filename)
  api = mod.exports
  const listener = await api.startRemoteWebhookServer({ rootDir: serverRoot, host: '127.0.0.1', port: 0 })
  address = `http://127.0.0.1:${listener.port}`
  const identity = { origin: 'https://fixture.invalid', spkiFingerprint: `sha256:${'a'.repeat(64)}`, commonName: 'fixture.invalid', issuer: 'Fixture', validFrom: '', validTo: '' }
  const fixtureKey = randomBytes(32)
  const protection = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'fixture-keychain',
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', fixtureKey, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]) },
    decryptString(value) { const decipher = createDecipheriv('aes-256-gcm', fixtureKey, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') }
  }
  const transport = {
    inspect: async () => identity,
    async request(server, method, path, token, body) {
      assert.equal(server.spkiFingerprint, identity.spkiFingerprint)
      requests.push(path)
      if (path === '/remote/console-renew') {
        renewalRequests.push(structuredClone(body))
        if (renewDropBefore) throw Error('network unavailable before request arrived')
      }
      if (path === '/remote/task-handoff') {
        lastEnvelope = structuredClone(body)
        if (tamper) body = { ...body, payload: { ...body.payload, id: 'tampered-handoff' } }
      }
      const response = await fetch(address + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      const result = await response.json()
      if (path === '/remote/pair/register' && response.status === 201) {
        result.consoleUrl = result.consoleUrl.replace(address, identity.origin)
        consoleToken = result.consoleUrl.split('/').at(-1)
      }
      if (path === '/remote/task-handoff' && loseReply) throw Error('reply lost after destination processed request')
      if (path === '/remote/console-renew') {
        renewalReplies.push({ status: response.status, body: result })
        if (renewLoseReply) throw Error('renewal reply lost after durable server write')
      }
      return { status: response.status, body: result }
    }
  }
  service = new api.RemoteHostService(clientRoot, protection, transport)
  async function pair(taskHandoff, storage = 'session') {
    const invitation = await api.createRemotePairingSession({ projectId: 'paired-project', ...(taskHandoff === undefined ? {} : { taskHandoff }) })
    const preview = await service.inspectRemoteHostPairing(invitation.url.replace(address, identity.origin))
    return service.pairRemoteHost({ previewId: preview.id, confirmedSpkiFingerprint: identity.spkiFingerprint, label: 'Fixture', deviceLabel: 'Fixture device', storage })
  }
  const disabled = await pair()
  assert.ok(!disabled.capabilities.includes('task_handoff'))
  await assert.rejects(service.requestTaskHandoff(disabled.id, 'capabilities', {}), /未确认/)
  assert.equal(calls.length, 0)
  const host = await pair(true)
  assert.ok(host.capabilities.includes('task_handoff'))
  await service.requestTaskHandoff(host.id, 'capabilities', {})
  assert.equal(calls.at(-1).caller.deviceId, host.deviceId)
  assert.equal(calls.at(-1).caller.projectId, 'paired-project')
  console.log('PASS default off, explicit pairing capability and device/project principal')

  const before = requests.length
  await assert.rejects(service.requestTaskHandoff(host.id, 'unknown', {}), /动作无效/)
  await assert.rejects(service.requestTaskHandoff(host.id, 'commit', {}), /原移交 ID/)
  await assert.rejects(service.requestTaskHandoff(host.id, 'chunk', { id: 'original', base64: 'a'.repeat(250 * 1024) }), /过大/)
  assert.equal(requests.length, before)
  await service.requestTaskHandoff(host.id, 'prepare', { id: 'original', sourceSessionId: 'personal-task', projectDependencies: ['different-source-project'] })
  assert.equal(calls.at(-1).payload.id, 'original')
  const device = (await api.getRemoteContinuationStore(serverRoot).getSnapshot()).devices.find(item => item.id === host.deviceId)
  api.verifyTaskHandoffEnvelope(lastEnvelope, device.publicKey, host.deviceId, 'paired-project')
  assert.throws(() => api.verifyTaskHandoffEnvelope({ ...lastEnvelope, action: 'cancel' }, device.publicKey, host.deviceId, 'paired-project'), /签名/)
  assert.throws(() => api.verifyTaskHandoffEnvelope(lastEnvelope, device.publicKey, 'another-device', 'paired-project'), /身份/)
  assert.throws(() => api.verifyTaskHandoffEnvelope(lastEnvelope, device.publicKey, host.deviceId, 'another-project'), /身份/)
  assert.throws(() => api.verifyTaskHandoffEnvelope(lastEnvelope, device.publicKey, host.deviceId, 'paired-project', lastEnvelope.expiresAt), /有效期/)
  const callCount = calls.length
  tamper = true
  await assert.rejects(service.requestTaskHandoff(host.id, 'cancel', { id: 'original' }), /未确认/)
  tamper = false
  assert.equal(calls.length, callCount)
  console.log('PASS action/id/size boundaries, signed payload and identity/expiry rejection')

  loseReply = true
  const attempts = requests.length
  await assert.rejects(service.requestTaskHandoff(host.id, 'commit', { id: 'original', proof: { signature: 'business-proof' } }), /未确认/)
  assert.equal(requests.length, attempts + 1)
  assert.equal(calls.at(-1).payload.id, 'original')
  loseReply = false
  const status = await service.requestTaskHandoff(host.id, 'status', { id: 'original' })
  assert.equal(status.id, 'original')
  assert.equal(calls.at(-1).action, 'status')
  assert.equal((await service.listRemoteHosts()).hosts.find(item => item.id === host.id).commands.length, 0)
  console.log('PASS one attempt on lost response, original-id status and no second outbox')

  await api.getRemoteContinuationStore(serverRoot).updateDeviceCapabilities(host.deviceId, ['view_results'])
  const revokedCount = calls.length
  await assert.rejects(service.requestTaskHandoff(host.id, 'status', { id: 'original' }), /未确认/)
  assert.equal(calls.length, revokedCount)
  await api.getRemoteContinuationStore(serverRoot).updateDeviceCapabilities(host.deviceId, ['view_results', 'task_handoff'])
  new api.RemoteConsoleSessionStore(serverRoot).put(consoleToken, { deviceId: host.deviceId, projectId: 'paired-project', expiresAt: Date.now() - 1 })
  await assert.rejects(service.requestTaskHandoff(host.id, 'status', { id: 'original' }), /未确认/)
  assert.equal(calls.length, revokedCount)
  console.log('PASS live capability revocation and expired console block destination dispatch')

  // A real signed renewal travels through HTTP and durable stores. Restart the
  // client after a lost reply; the exact original request must remain recoverable.
  const renewable = await pair(true, 'encrypted'), clientStore = new api.RemoteHostStore(clientRoot, protection)
  const serverSessions = new api.RemoteConsoleSessionStore(serverRoot), remoteStore = api.getRemoteContinuationStore(serverRoot)
  const originalSecret = clientStore.unseal(clientStore.get(renewable.id).sealedCredentials)
  const originalDevice = (await remoteStore.getSnapshot()).devices.find(item => item.id === renewable.deviceId)
  clientStore.update(renewable.id, item => { item.expiresAt = Date.now() - 1 })
  serverSessions.put(originalSecret.consoleToken, { deviceId: renewable.deviceId, projectId: renewable.projectId, expiresAt: Date.now() - 1 })
  assert.equal(serverSessions.get(originalSecret.consoleToken), undefined)
  assert.ok(serverSessions.readForRenew(originalSecret.consoleToken))
  await assert.rejects(service.requestTaskHandoff(renewable.id, 'capabilities', {}), /过期/)
  await remoteStore.updateDeviceCapabilities(renewable.deviceId, ['view_results'])
  renewLoseReply = true
  const unknownRenewal = await service.renewRemoteHost(renewable.id), firstRequest = renewalRequests.at(-1), firstReply = renewalReplies.at(-1).body
  assert.equal(unknownRenewal.status, 'expired'); assert.equal(unknownRenewal.renewal.requestId, firstRequest.requestId)
  assert.equal(firstReply.status, 'renewed'); assert.equal(serverSessions.get(originalSecret.consoleToken), undefined)
  assert.equal(clientStore.unseal(clientStore.get(renewable.id).sealedCredentials).consoleToken, originalSecret.consoleToken)
  assert.equal(Object.hasOwn(unknownRenewal, 'sealedRenew'), false)
  await assert.rejects(service.readRemoteHostTasks(renewable.id), /续期/)
  service.dispose(); service = new api.RemoteHostService(clientRoot, protection, transport)
  timeOffset += 6 * 60_000; renewLoseReply = false
  const recovered = await service.renewRemoteHost(renewable.id), recoveredSecret = clientStore.unseal(clientStore.get(renewable.id).sealedCredentials)
  assert.deepEqual(renewalRequests.at(-1), firstRequest)
  assert.equal(recovered.status, 'paired'); assert.equal(recovered.renewal, undefined)
  assert.equal(recovered.id, renewable.id); assert.equal(recovered.deviceId, renewable.deviceId); assert.equal(recovered.projectId, renewable.projectId)
  assert.equal(recoveredSecret.privateKey, originalSecret.privateKey)
  assert.equal(recoveredSecret.consoleToken, firstReply.consoleToken); assert.equal(recovered.expiresAt, firstReply.expiresAt)
  assert.deepEqual(recovered.capabilities, ['view_results'])
  assert.equal((await remoteStore.getSnapshot()).devices.find(item => item.id === renewable.deviceId).publicKey, originalDevice.publicKey)
  await assert.rejects(service.requestTaskHandoff(renewable.id, 'capabilities', {}), /未确认/)
  console.log('PASS signed 24h renewal preserves identity/key/project, durable lost-reply replay and live reduced capabilities')

  const signed = (envelope, changes) => { const { signature: _signature, ...unsigned } = { ...envelope, ...changes }; return { ...unsigned, signature: sign(null, Buffer.from(api.canonicalJson(unsigned)), createPrivateKey({ key: Buffer.from(originalSecret.privateKey, 'base64'), format: 'der', type: 'pkcs8' })).toString('base64') } }
  for (const changes of [{ projectId: 'other-project' }, { issuerDeviceId: 'other-device' }, { oldConsoleTokenDigest: '0'.repeat(64) }]) {
    const rejected = await transport.request(identity, 'POST', '/remote/console-renew', originalSecret.consoleToken, signed(firstRequest, changes))
    assert.equal(rejected.status, 400)
  }
  const forged = await transport.request(identity, 'POST', '/remote/console-renew', originalSecret.consoleToken, { ...firstRequest, signature: 'A'.repeat(86) + '==' })
  assert.equal(forged.status, 400)
  timeOffset += 25 * 60 * 60_000
  assert.equal(serverSessions.get(recoveredSecret.consoleToken), undefined)
  renewDropBefore = true
  const unsent = await service.renewRemoteHost(renewable.id)
  assert.ok(unsent.renewal)
  timeOffset += 6 * 60_000; renewDropBefore = false
  const notReceived = await service.renewRemoteHost(renewable.id)
  assert.equal(notReceived.renewal, undefined); assert.equal(notReceived.status, 'expired'); assert.match(notReceived.error, /未生效/)
  assert.equal(serverSessions.get(recoveredSecret.consoleToken), undefined)
  const secondRenewal = await service.renewRemoteHost(renewable.id)
  assert.equal(secondRenewal.status, 'paired'); assert.equal(secondRenewal.deviceId, renewable.deviceId)
  assert.notEqual(renewalRequests.at(-1).requestId, unsent.renewal.requestId)
  const beforeRevocation = clientStore.unseal(clientStore.get(renewable.id).sealedCredentials)
  await remoteStore.unbindDevice(renewable.deviceId)
  const deniedRenewal = await service.renewRemoteHost(renewable.id)
  assert.ok(deniedRenewal.renewal); assert.match(deniedRenewal.error, /不会恢复授权/)
  assert.equal(clientStore.unseal(clientStore.get(renewable.id).sealedCredentials).consoleToken, beforeRevocation.consoleToken)
  const deniedReplay = await transport.request(identity, 'POST', '/remote/console-renew', originalSecret.consoleToken, firstRequest)
  assert.equal(deniedReplay.status, 400)
  serverSessions.revokeDevice(renewable.deviceId)
  assert.equal(serverSessions.readForRenew(originalSecret.consoleToken), undefined)
  assert.equal(serverSessions.readForRenew(beforeRevocation.consoleToken), undefined)
  console.log('PASS signed binding/tamper rejection, unreceived stale request reconciliation and revoked-device denial')
} finally {
  service?.dispose()
  await api?.stopRemoteWebhookServer()
  delete globalThis.__handoffTransportFixture
  Date.now = originalNow
  rmSync(root, { recursive: true, force: true })
}
