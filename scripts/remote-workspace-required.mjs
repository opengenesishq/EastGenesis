import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Module } from 'node:module'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'caogen-remote-workspace-')), serverRoot = join(root, 'server'), repo = join(root, 'repo')
mkdirSync(repo); writeFileSync(join(repo, 'hello.txt'), 'first version\n')
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
git(['init']); git(['add', 'hello.txt']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture'])
writeFileSync(join(repo, 'hello.txt'), 'remote original task\n')
writeFileSync(join(root, 'outside.txt'), 'outside data'); symlinkSync(join(root, 'outside.txt'), join(repo, 'escape.txt'))
const aggregate = { workspace: { id: 'project-1', name: 'Remote fixture' }, projectRevision: 1, goals: [], workItems: [{ id: 'work-1', title: 'Original task', status: 'running', revision: 7 }],
  workflow: { artifacts: [], acceptances: [], artifactLocations: [], runs: [{ id: 'run-1', sessionId: 'session-1', workItemId: 'work-1', createdAt: 1 }], workflowEvidence: [], taskEvidence: [] } }
const meta = { id: 'session-1', workspaceId: 'project-1', workItemId: 'work-1', sdkSessionId: 'fixture-sdk', cwd: repo, title: 'Original task', status: 'running', permissionMode: 'default', costUsd: 0 }
const pending = { requestId: 'permission-1', toolName: 'write_file', capabilities: ['file_write'], riskLevel: 'medium', input: { path: 'hello.txt', content: 'new content' }, effectScope: { targetKind: 'file_content', targetDigest: 'a'.repeat(64), summary: 'Write hello.txt to the reviewed version' } }
const fixture = { root: serverRoot, aggregate, meta, pending, activePermission: true, decisions: [], creates: [], routines: [], api: undefined }
globalThis.__remoteWorkspaceFixture = fixture
const key = randomBytes(32), protection = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'fixture-aes',
  encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]) },
  decryptString(value) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString() } }
const identity = { origin: 'https://fixture.invalid', spkiFingerprint: `sha256:${'b'.repeat(64)}`, commonName: 'fixture.invalid', issuer: 'Fixture', validFrom: new Date().toISOString(), validTo: new Date(Date.now() + 86400000).toISOString() }
let api, address, checks = 0, loseApproval = false, decisionPosts = 0, afterWorkspaceResponse
const pass = name => { checks++; console.log(`PASS ${name}`) }
try {
  const mocks = {
    electron: 'export const app={getPath:()=>globalThis.__remoteWorkspaceFixture.root}',
    'project-aggregate': 'export const createProductionProjectAggregateService=()=>({verifyLiveProject:async id=>{const f=globalThis.__remoteWorkspaceFixture;if(id!=="project-1")throw Error("wrong project");return f.aggregate}})',
    routineStore: 'export const listRoutines=async()=>[{id:"routine-1",name:"Fixture routine",projectId:"project-1",enabled:true,permissionMode:"default",nextRunAt:null}]',
    'routine-executor': 'export async function executeRoutine(root,routine,options){globalThis.__remoteWorkspaceFixture.routines.push({routine,options});return {id:options.runId,status:"succeeded"}}',
    'routine-runner.js': 'export async function listRoutineRuns(){return []}',
    'supervisor-state': 'export class SupervisorStateStore {async listRuns(){return []}}',
    'sessionManager': 'const f=globalThis.__remoteWorkspaceFixture;export const sessionManager={list:()=>[f.meta],get:id=>id===f.meta.id?{meta:f.meta,pendingPermissions:()=>f.activePermission?[f.pending]:[],respondPermission:(id,allow)=>{f.decisions.push({id,allow});f.activePermission=false}}:undefined}',
    'sessionManager.js': 'export {sessionManager} from "sessionManager"',
    history: 'export const listHistory=()=>[]',
    'goal-submission-runtime': 'export async function startProjectGoalTask(input){globalThis.__remoteWorkspaceFixture.creates.push(input);return {sessionId:"new-remote-session"}}',
    'session-input-runtime': 'export function getSessionInputService(){return {queue:async()=>({phase:"applied"})}}',
    'pause-session-continuations': 'export async function pauseSessionContinuations(){}',
    'business-line-registry-reader': 'export function assertActiveBusinessLine(){}'
  }
  const output = await build({ stdin: { contents: `export * from './src/main/remote-hosts/service';export * from './src/main/remote/webhook-server';export * from './src/main/remote/store';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'synthetic-runtime', setup(b) { b.onResolve({ filter: /.*/ }, args => { const name = args.path.split('/').at(-1); return Object.hasOwn(mocks, name) ? { path: name, namespace: 'fixture' } : undefined }); b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' })) } }] })
  const filename = resolve('scripts/.remote-workspace-fixture.cjs'), module = new Module(filename)
  module.filename = filename; module.paths = Module._nodeModulePaths(dirname(filename)); module._compile(output.outputFiles[0].text, filename)
  api = module.exports; fixture.api = api
  const listener = await api.startRemoteWebhookServer({ rootDir: serverRoot, host: '127.0.0.1', port: 0 }); address = `http://127.0.0.1:${listener.port}`
  const transport = { inspect: async () => identity, async request(server, method, path, token, body) {
    assert.deepEqual(server, identity)
    if (loseApproval && path.startsWith('/remote/console-approval?')) throw Error('fixture lost receipt')
    if (body?.decision) decisionPosts++
    const response = await fetch(address + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const data = await response.json()
    if (path === '/remote/workspace-read') afterWorkspaceResponse?.(body, data)
    if (path === '/remote/pair/register' && response.status === 201) data.consoleUrl = data.consoleUrl.replace(address, identity.origin)
    if (loseApproval && body?.decision) throw Error('fixture lost decision response')
    return { status: response.status, body: data }
  } }
  const clientRoot = join(root, 'client'), service = new api.RemoteHostService(clientRoot, protection, transport)
  const pair = async workspaceRead => {
    const invitation = await api.createRemotePairingSession({ projectId: 'project-1', workspaceRead })
    const preview = await service.inspectRemoteHostPairing(invitation.url.replace(address, identity.origin))
    return service.pairRemoteHost({ previewId: preview.id, confirmedSpkiFingerprint: preview.identity.spkiFingerprint, label: 'Fixture', deviceLabel: 'Fixture client', storage: 'encrypted' })
  }
  const noRead = await pair(false)
  assert(!noRead.capabilities.includes('workspace_read'))
  await assert.rejects(service.describeRemoteWorkspace(noRead.id, 'work-1'), /未获工作区读取授权/)
  const host = await pair(true), workspace = await service.describeRemoteWorkspace(host.id, 'work-1')
  assert.equal(workspace.binding.sessionId, 'session-1'); assert.equal(workspace.binding.runId, 'run-1'); assert.equal(fixture.creates.length, 0)
  pass('workspace_read is explicit; opening the original task never creates a local or remote replacement Session')

  const read = (binding, operation, path) => service.readRemoteWorkspace({ hostId: host.id, binding, operation, path })
  const files = await read(workspace.binding, 'list', '.')
  assert.equal(files.entries.find(item => item.name === 'escape.txt').kind, 'unavailable')
  assert.equal((await read(workspace.binding, 'read', 'hello.txt')).content, 'remote original task\n')
  assert.match((await read(workspace.binding, 'git_status')).content, /hello.txt/)
  assert.match((await read(workspace.binding, 'git_diff')).content, /remote original task/)
  await assert.rejects(read({ ...workspace.binding, canonicalPath: root }, 'list'), /重新打开/)
  for (const path of ['../outside.txt', 'escape.txt', '.git/config']) {
    const current = await service.describeRemoteWorkspace(host.id, 'work-1')
    await assert.rejects(read(current.binding, 'read', path))
  }
  pass('real temporary files and Git diffs stay within the bound root; forged bindings, traversal and symlinks are rejected')

  const binary = randomBytes(700 * 1024), binaryPath = join(repo, 'report.pptx'), savedPath = join(root, 'saved-report.pptx')
  writeFileSync(binaryPath, binary)
  let binaryWorkspace = await service.describeRemoteWorkspace(host.id, 'work-1'), chunks = 0
  afterWorkspaceResponse = request => { if (request.operation === 'file_chunk') chunks++ }
  const saved = await service.saveRemoteWorkspaceFile({ hostId: host.id, binding: binaryWorkspace.binding, path: 'report.pptx' }, async suggested => { assert.equal(suggested, 'report.pptx'); return savedPath })
  assert.equal(saved.status, 'saved'); assert.equal(saved.bytes, binary.length); assert.equal(chunks, 3)
  assert.equal(saved.sha256, createHash('sha256').update(binary).digest('hex')); assert.deepEqual(readFileSync(savedPath), binary); assert.equal(fixture.creates.length, 0)
  const cancelledPath = join(root, 'cancelled.pptx')
  assert.equal((await service.saveRemoteWorkspaceFile({ hostId: host.id, binding: binaryWorkspace.binding, path: 'report.pptx' }, async () => undefined)).status, 'cancelled')
  assert(!existsSync(cancelledPath)); assert.equal(chunks, 3)
  pass('native-path binary Save As transfers all three chunks with the exact hash, preserves original Session identity and honours cancellation')

  afterWorkspaceResponse = request => { if (request.operation === 'file_chunk') { afterWorkspaceResponse = undefined; writeFileSync(binaryPath, Buffer.from('changed during transfer')) } }
  await assert.rejects(service.saveRemoteWorkspaceFile({ hostId: host.id, binding: binaryWorkspace.binding, path: 'report.pptx' }, async () => savedPath), /版本|变化/)
  assert.deepEqual(readFileSync(savedPath), binary)
  writeFileSync(binaryPath, binary); binaryWorkspace = await service.describeRemoteWorkspace(host.id, 'work-1')
  afterWorkspaceResponse = request => { if (request.operation === 'file_chunk') { afterWorkspaceResponse = undefined; writeFileSync(savedPath, 'new local version') } }
  await assert.rejects(service.saveRemoteWorkspaceFile({ hostId: host.id, binding: binaryWorkspace.binding, path: 'report.pptx' }, async () => savedPath), /目标文件已变化/)
  assert.equal(readFileSync(savedPath, 'utf8'), 'new local version'); assert(!readdirSync(root).some(name => name.startsWith('.caogen-remote-')))
  pass('remote file or local destination changes abort the download, retain local contents and remove temporary chunks')

  const current = await service.describeRemoteWorkspace(host.id, 'work-1')
  await api.getRemoteContinuationStore(serverRoot).updateDeviceCapabilities(host.deviceId, host.capabilities.filter(item => item !== 'workspace_read'))
  await assert.rejects(read(current.binding, 'read', 'hello.txt'), /未获工作区读取授权/)
  await api.getRemoteContinuationStore(serverRoot).updateDeviceCapabilities(host.deviceId, host.capabilities)
  const fresh = await service.describeRemoteWorkspace(host.id, 'work-1')
  assert.notEqual(fresh.binding.authorityDigest, current.binding.authorityDigest)
  fixture.meta.cwd = root
  await assert.rejects(read(fresh.binding, 'read', 'hello.txt'), /已变化/)
  fixture.meta.cwd = repo
  pass('revocation, restored grant versions and task directory changes invalidate old workspace reads')

  const created = await service.sendRemoteHostCommand({ hostId: host.id, kind: 'create_task', expectedRevision: 1, text: 'Create on the original remote project', requestId: 'create-fixture' })
  assert.equal(created.execution.status, 'succeeded'); assert.equal(fixture.creates.length, 1); assert.equal(fixture.creates[0].projectId, 'project-1')
  const routine = await service.sendRemoteHostCommand({ hostId: host.id, kind: 'trigger_routine', expectedRevision: 1, routineId: 'routine-1', requestId: 'routine-fixture' })
  assert.equal(routine.execution.status, 'succeeded'); assert.equal(fixture.routines.length, 1)
  pass('signed create and routine actions reach the host executor with the original project and exact routine identity')

  const tasks = await service.readRemoteHostTasks(host.id), candidate = tasks.approvalCandidates[0]
  assert.equal(candidate.targetDigest, pending.effectScope.targetDigest)
  const reviewed = await service.sendRemoteHostCommand({ hostId: host.id, kind: 'approve_effect', workItemId: 'work-1', expectedRevision: 7, approvalCandidate: candidate, requestId: 'review-fixture' })
  assert.equal(reviewed.approval.status, 'pending'); assert.equal(fixture.decisions.length, 0)
  loseApproval = true
  const approval = reviewed.approval
  const decideInput = { hostId: host.id, approvalId: approval.id, expectedRevision: approval.recordRevision, approvalDigest: approval.approvalDigest, decision: 'approve', requestId: 'decision-fixture' }
  assert.equal((await service.decideRemoteHostApproval(decideInput)).state, 'unknown')
  assert.equal(fixture.decisions.length, 1); assert.equal(fixture.decisions[0].allow, true)
  assert.equal((await service.decideRemoteHostApproval(decideInput)).state, 'unknown'); assert.equal(decisionPosts, 1)
  loseApproval = false
  const restarted = new api.RemoteHostService(clientRoot, protection, transport)
  const receipt = await restarted.reconcileRemoteHostApproval(host.id, 'decision-fixture')
  assert.equal(receipt.approval.status, 'approved'); assert.equal(receipt.approval.applicationStatus, 'applied'); assert.equal(decisionPosts, 1)
  assert(!JSON.stringify(await restarted.listRemoteHosts()).includes('sealedDecision'))
  pass('native approval freezes the live Effect; a lost decision reply restores by original approval ID without another execution')
  console.log(`remote-workspace-required: ${checks}/${checks}; synthetic sessions, local temporary Git and loopback transport only; no real host or Provider`)
} finally {
  await api?.stopRemoteWebhookServer(); delete globalThis.__remoteWorkspaceFixture; rmSync(root, { recursive: true, force: true })
}
