import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteHostService } from '../src/main/remote-hosts/service'
import { RemoteHostStore } from '../src/main/remote-hosts/store'
import type { RemoteHostTransport } from '../src/main/remote-hosts/transport'
import type { RemoteCommandRecord, RemoteCommandEnvelope } from '../src/shared/remote-types'
import type { RemoteHostExpectedConnection } from '../src/shared/remote-host-types'
import type { SessionMeta } from '../src/shared/types'
import { inspectRemoteCreatedTask, remoteCreatedTaskResult } from '../src/main/remote/created-task-projection'
import { ProjectGoalSubmissionStore } from '../src/main/project-workspace/goal-submission-store'
import { createProjectGoalTask, goalTaskIds } from '../src/main/project-workspace/goal-task-service'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { SessionInputService } from '../src/main/task/session-input-service'
import { TaskPlanContractStore } from '../src/main/task/task-plan-contract-store'
import { createDefaultBusinessLines } from '../src/shared/business-line-types'
import { writeDurableFileSync } from '../src/main/durable-file'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-remote-intake-')))
const originalFetch = globalThis.fetch
let network = 0, passed = 0
globalThis.fetch = async () => { network++; throw new Error('External calls forbidden') }
const key = randomBytes(32)
const protection = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'fixture-aes',
  encryptString(value: string) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]) },
  decryptString(value: Buffer) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString() } }
const connection: RemoteHostExpectedConnection = { projectId: 'remote-project', deviceId: 'fixture-device', origin: 'https://fixture.invalid', spkiFingerprint: `sha256:${'a'.repeat(64)}` }
const identity = { origin: connection.origin, spkiFingerprint: connection.spkiFingerprint, commonName: 'fixture.invalid', issuer: 'fixture', validFrom: '2026-01-01', validTo: '2027-01-01' }
const clientRoot = join(root, 'client'), store = new RemoteHostStore(clientRoot, protection)
const keys = generateKeyPairSync('ed25519'), created = new Map<string, RemoteCommandEnvelope>()
let requests = 0, posts = 0, loseRead = false, wrongResult: 'project' | 'goal' | undefined
let blockTaskRead: (() => Promise<void>) | undefined
const transport: RemoteHostTransport = { inspect: async () => identity, async request(_identity, method, path, _token, body) {
  requests++
  if (method === 'POST') { posts++; const envelope = (body as { envelope: RemoteCommandEnvelope }).envelope; created.set(envelope.commandId, envelope); throw new Error('Synthetic lost reply after acceptance') }
  if (path === '/remote/console-api') await blockTaskRead?.()
  if (path === '/remote/console-api') return { status: 200, body: { deviceId: connection.deviceId, projectId: connection.projectId, projectName: 'Fixture', projectRevision: 7,
    workItems: [], capabilities: ['create_task', 'view_results'], projection: { projectId: connection.projectId } } }
  if (loseRead) throw new Error('Synthetic unavailable receipt')
  const id = new URL(path, identity.origin).searchParams.get('commandId')!, envelope = created.get(id)
  const ids = goalTaskIds(connection.projectId, `remote-${id}`)
  return { status: 200, body: { protocolVersion: 1, deviceId: connection.deviceId, projectId: connection.projectId, command: envelope ? {
    commandId: id, kind: envelope.kind, status: 'accepted', execution: { status: 'succeeded' }, createPhase: 'input_received',
    createdTask: { projectId: wrongResult === 'project' ? 'foreign-project' : connection.projectId, goalId: wrongResult === 'goal' ? 'another-goal' : ids.goalId, workItemId: ids.workItemId, sessionId: 'remote-session' }
  } : null } }
} }
store.save({ id: 'host-1', label: 'Synthetic host', storage: 'encrypted', identity, status: 'paired', projectId: connection.projectId, deviceId: connection.deviceId,
  expiresAt: Date.now() + 86400000, capabilities: ['create_task', 'view_results'], createdAt: Date.now(), commands: [],
  sealedCredentials: store.seal({ privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), consoleToken: 'a'.repeat(32) }) })
const submit = { hostId: 'host-1', kind: 'create_task' as const, text: 'Synthetic task objective', requestId: 'welcome-request', expectedRevision: 7, source: 'welcome' as const, expectedConnection: connection }
const check = async (name: string, action: () => Promise<void>) => { await action(); passed++; console.log(`PASS ${name}`) }

async function taskEvidence(kind: 'direct' | 'plan') {
  const serverRoot = join(root, randomUUID()), commandId = randomUUID(), requestId = `remote-${commandId}`
  writeDurableFileSync(join(serverRoot, 'settings.json'), JSON.stringify({ businessLines: createDefaultBusinessLines(), selectedBusinessLineId: 'studio' }))
  await (await openProjectWorkspaceStore(serverRoot)).createWorkspace({ id: connection.projectId, name: 'Projection fixture', kind: 'software' })
  const input = { projectId: connection.projectId, requestId, objective: '翻译成英文：你好。', businessLineId: 'studio', template: 'auto' as const }
  const journal = new ProjectGoalSubmissionStore(serverRoot)
  let row = journal.reserve(input, undefined, { schemaVersion: 1, mode: 'auto', kind, reason: 'fixture', taskStrategy: kind === 'direct' ? 'view' : 'plan' })
  const task = await createProjectGoalTask(input, serverRoot)
  row = journal.advance(row, 'task_created'); row = journal.advance(row, 'session_ready')
  const meta = { id: row.sessionId, workspaceId: input.projectId, goalId: task.goal.id, workItemId: task.workItem.id, createdAt: Date.now(), status: 'idle' } as SessionMeta
  let sends = 0
  const inputs = new SessionInputService(serverRoot, { meta: () => meta, send: async () => { sends++; return true }, accepted: async () => sends > 0 })
  const inputId = `goal-start-${createHash('sha256').update(JSON.stringify([input.projectId, requestId])).digest('hex')}`
  const command: RemoteCommandRecord = { envelope: { schemaVersion: 1, commandId, issuerDeviceId: connection.deviceId, kind: 'create_task', scope: { projectId: input.projectId, artifactIds: [], dataClass: 'metadata_only' },
    revision: 7, createdAt: Date.now(), expiresAt: Date.now() + 300000, payload: { kind: 'create_task', objective: input.objective, businessLineId: input.businessLineId }, payloadDigest: 'a'.repeat(64), signature: 'fixture' },
    status: 'accepted', receivedAt: Date.now(), updatedAt: Date.now(), auditId: 'fixture', execution: { status: 'running', updatedAt: Date.now() } }
  if (kind === 'plan') new TaskPlanContractStore(() => serverRoot).createVersion({ sessionId: meta.id, workspaceId: input.projectId, goalId: task.goal.id, workItemId: task.workItem.id },
    { objective: input.objective, steps: [{ id: 'step', title: '翻译', expectedArtifacts: ['译文'] }], expectedArtifacts: ['译文'], acceptanceCriteria: ['原意正确'], source: 'genesis' }, 'agent')
  else await inputs.queue(meta.id, inputId, { text: input.objective })
  return { serverRoot, command, meta, inputs, inputId, task, sends: () => sends }
}

async function main() {
  try {
    const service = new RemoteHostService(clientRoot, protection, transport)
    let commandId = ''
    await check('request lookup refuses null while original send is pending before local persistence', async () => {
      let release!: () => void, entered!: () => void
      const pending = new Promise<void>(resolve => { release = resolve })
      const active = new Promise<void>(resolve => { entered = resolve })
      blockTaskRead = async () => { entered(); await pending }
      const result = assert.rejects(service.sendRemoteHostCommand({ ...submit, requestId: 'prewrite-check', expectedRevision: 8 }), /版本已变化/)
      await active
      await assert.rejects(service.findRemoteHostCommandByRequestId('host-1', 'prewrite-check'), /操作正在进行/)
      release(); await result; blockTaskRead = undefined
      assert.equal(await service.findRemoteHostCommandByRequestId('host-1', 'prewrite-check'), null)
      assert.equal(posts, 0)
    })
    await check('lost reply keeps one durable command; identical request never reposts', async () => {
      loseRead = true
      const value = await service.sendRemoteHostCommand(submit); commandId = value.commandId
      assert.equal(value.state, 'unknown'); assert.equal(value.requestId, submit.requestId); assert.equal(value.source, 'welcome')
      assert.equal((await service.sendRemoteHostCommand(submit)).commandId, commandId); assert.equal(posts, 1)
      assert(!readFileSync(join(clientRoot, 'remote-hosts', 'hosts.json'), 'utf8').includes(submit.text))
    })
    await check('request lookup survives restart and expiry without networking', async () => {
      const restarted = new RemoteHostService(clientRoot, protection, transport, () => Date.now() + 2 * 86400000)
      const count = requests
      assert.equal((await restarted.findRemoteHostCommandByRequestId('host-1', submit.requestId))?.commandId, commandId)
      assert.equal(await restarted.findRemoteHostCommandByRequestId('host-1', 'absent'), null); assert.equal(requests, count)
    })
    await check('same request rejects changed text, revision, target and local Provider parameters', async () => {
      const count = requests
      for (const patch of [{ text: 'another objective' }, { expectedRevision: 8 }, { expectedConnection: { ...connection, projectId: 'another-project' } }, { providerId: 'local-provider' }]) {
        await assert.rejects(service.sendRemoteHostCommand({ ...submit, ...patch }))
      }
      assert.equal(requests, count); assert.equal(posts, 1)
    })
    await check('exact original command returns created task; drift is rejected without replay', async () => {
      loseRead = false
      const value = await service.reconcileRemoteHostCommand('host-1', commandId)
      assert.equal(value.createPhase, 'input_received'); assert.equal(value.createdTask?.projectId, connection.projectId)
      for (const kind of ['project', 'goal'] as const) {
        wrongResult = kind
        const drift = await service.reconcileRemoteHostCommand('host-1', commandId)
        assert.equal(drift.state, 'unknown'); assert.deepEqual(drift.createdTask, value.createdTask); assert.equal(posts, 1)
      }
      wrongResult = undefined
    })
    await check('actual task/input stores recover binding after command completion is lost, without dispatch', async () => {
      const f = await taskEvidence('direct')
      const queued = await inspectRemoteCreatedTask(f.serverRoot, f.command)
      assert.equal(queued?.createPhase, 'input_queued'); assert.equal(queued?.createdTask?.sessionId, f.meta.id); assert.equal(f.sends(), 0)
      await f.inputs.apply(f.meta.id, f.inputId)
      const received = await inspectRemoteCreatedTask(f.serverRoot, f.command)
      assert.equal(received?.createPhase, 'input_received'); assert.equal(received?.createdTask?.workItemId, f.task.workItem.id); assert.equal(f.sends(), 1)
      const reread = await inspectRemoteCreatedTask(f.serverRoot, f.command)
      assert.deepEqual(reread, received); assert.equal(f.sends(), 1)
      f.command.envelope.payload = { kind: 'create_task', objective: 'different objective' }
      assert.deepEqual(await inspectRemoteCreatedTask(f.serverRoot, f.command), { createPhase: 'needs_reconciliation' })
    })
    await check('plan receipt remains plan-ready and foreign prior Session binding fails closed', async () => {
      const f = await taskEvidence('plan')
      const result = await inspectRemoteCreatedTask(f.serverRoot, f.command)
      assert.equal(result?.createPhase, 'plan_ready'); assert.equal(f.sends(), 0)
      f.command.execution!.createdTask = { ...result!.createdTask!, sessionId: 'another-session' }
      assert.deepEqual(await inspectRemoteCreatedTask(f.serverRoot, f.command), { createPhase: 'needs_reconciliation' })
    })
    await check('input uncertainty is separate from the create-command success', async () => {
      const f = await taskEvidence('direct'), input = (await f.inputs.list(f.meta.id))[0]
      const result = remoteCreatedTaskResult({ ...f.task, sessionId: f.meta.id, kind: 'direct', decision: { schemaVersion: 1, mode: 'auto', kind: 'direct', reason: 'fixture', taskStrategy: 'view' }, input: { ...input, phase: 'needs_reconciliation' } })
      assert.equal(result.createPhase, 'needs_reconciliation'); assert.equal(result.createdTask?.sessionId, f.meta.id)
    })
    assert.equal(network, 0)
    console.log(`${passed}/${passed} PASS; Provider/network calls: 0`)
  } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }) }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
