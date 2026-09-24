import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { randomBytes } from 'node:crypto'
import { getRemoteContinuationStore } from './store'
import { executeRemoteCommand } from './executor'
import type { RemoteApprovalDecisionEnvelope, RemoteWebhookEventEnvelope, RemotePairingSession, RemoteDeviceCapability } from '../../shared/remote-types'
import { getRemoteWebhookStatus, setRemoteWebhookStatus } from './webhook-status'
import { createProductionProjectAggregateService } from '../project-aggregate'
import { listRoutines } from '../routineStore'
import { SupervisorStateStore } from '../task/supervisor-state'
import { consoleHtml, pairingHtml } from './webhook-pages'
import { RemoteConsoleSessionStore } from './console-session-store'
import { verifyRemoteHostRevoke } from '../remote-hosts/protocol'
import { readBoundRemoteWorkspace, remoteApprovalCandidates } from './workspace-runtime'
import type { RemoteWorkspaceRequest } from '../../shared/remote-workspace-types'
import type { RemoteApprovalRecord } from '../../shared/remote-types'
import { verifyTaskHandoffEnvelope } from './task-handoff-protocol'
import { inspectRemoteCreatedTask } from './created-task-projection'
import { verifyConsoleRenew } from './console-renew-protocol'

const MAX_BODY_BYTES = 256 * 1024
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 0

export interface RemoteWebhookServerOptions {
  rootDir: string
  host?: string
  port?: number
  tls?: { cert: string | Buffer; key: string | Buffer }
  tlsCertPath?: string
  tlsKeyPath?: string
  advertisedHost?: string
  onListening?: (address: { host: string; port: number }) => void
}

let activeServer: Server | undefined
let activeProtocol: 'http' | 'https' = 'http'
const pairingSessions = new Map<string, { expiresAt: number; projectId?: string; capabilities: RemoteDeviceCapability[] }>()

/** A narrow local HTTP or explicitly configured TLS ingress; signed events remain the authorization boundary. */
export async function startRemoteWebhookServer(options: RemoteWebhookServerOptions): Promise<{ host: string; port: number }> {
  await stopRemoteWebhookServer()
  advertisedHostOverride = options.advertisedHost?.trim() ?? ''
  const host = normalizeHost(options.host ?? process.env.CAOGEN_REMOTE_WEBHOOK_HOST ?? DEFAULT_HOST)
  const port = normalizePort(options.port ?? parseEnvPort(process.env.CAOGEN_REMOTE_WEBHOOK_PORT) ?? DEFAULT_PORT)
  const tls = resolveTlsOptions(options)
  if (!isLoopbackHost(host) && !tls) {
    throw new Error('Remote webhook non-loopback listeners require explicit TLS certificate and key configuration')
  }
  const protocol = tls ? 'https' : 'http'
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(options.rootDir, request, response).catch((error: unknown) => {
      if (!response.headersSent) writeJson(response, 400, { error: error instanceof Error ? error.message.slice(0, 300) : '远程请求处理失败' })
      else response.end()
    })
  }
  const server = tls ? createHttpsServer(tls, handler) : createHttpServer(handler)
  const stopped = (): void => {
    if (activeServer !== server) return
    activeServer = undefined
    advertisedHostOverride = ''; activeProtocol = 'http'; pairingSessions.clear()
    setRemoteWebhookStatus({ host, port: 0, protocol, running: false })
  }
  server.once('close', stopped)
  server.on('error', error => {
    if (activeServer !== server) return
    stopped(); server.close()
    console.error('[caogen] remote connection listener failed:', error)
  })
  try { await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
    const onListening = () => { server.off('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  }) } catch (error) {
    server.close()
    setRemoteWebhookStatus({ host, port: 0, protocol, running: false })
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Remote webhook server did not expose a TCP address')
  const result = { host, port: address.port }
  activeServer = server
  activeProtocol = protocol
  setRemoteWebhookStatus({ ...result, protocol, running: true })
  options.onListening?.(result)
  return result
}

export async function stopRemoteWebhookServer(): Promise<void> {
  const server = activeServer
  activeServer = undefined
  advertisedHostOverride = ''
  activeProtocol = 'http'
  setRemoteWebhookStatus({ host: DEFAULT_HOST, port: 0, protocol: 'http', running: false })
  pairingSessions.clear()
  if (!server) return
  await new Promise<void>(resolve => {
    const timeout = setTimeout(() => server.closeAllConnections(), 2000)
    timeout.unref()
    server.close(() => { clearTimeout(timeout); resolve() })
  })
}

async function handleRequest(rootDir: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'POST' && request.url === '/remote/console-renew') {
    const token = consoleBearer(request)
    const body: unknown = JSON.parse(await readBody(request))
    // Read live device authorization after collecting the body. Expiry is not
    // treated as valid control access; this endpoint can only rotate its token.
    const snapshot = await getRemoteContinuationStore(rootDir).getSnapshot()
    const sessions = new RemoteConsoleSessionStore(rootDir), session = sessions.readForRenew(token)
    if (!session) throw new Error('找不到原连接的设备与项目绑定，无法续期。')
    const device = snapshot.devices.find(item => item.id === session.deviceId && item.status === 'active')
    if (snapshot.connectivity !== 'online' || !device?.publicKey || !device.capabilities.length) throw new Error('设备已撤销、权限已移除或远端已暂停接收，无法续期。')
    const envelope = verifyConsoleRenew(body, device.publicKey, device.id, session.projectId, token)
    const result = sessions.renew(token, envelope)
    writeJson(response, result.status === 'renewed' ? 200 : 409, { protocolVersion: 1, deviceId: device.id, projectId: session.projectId,
      requestId: envelope.requestId, oldConsoleTokenDigest: envelope.oldConsoleTokenDigest, capabilities: device.capabilities, ...result })
    return
  }
  if (request.method === 'POST' && request.url === '/remote/task-handoff') {
    const token = consoleBearer(request)
    const authorize = async () => {
      const session = validConsoleSession(rootDir, token)
      const snapshot = await getRemoteContinuationStore(rootDir).getSnapshot()
      const device = snapshot.devices.find(item => item.id === session.deviceId && item.status === 'active')
      if (snapshot.connectivity !== 'online' || !device?.publicKey || !device.capabilities.includes('task_handoff')) throw new Error('当前设备未获任务移交权限，或远端已暂停接收。')
      return { deviceId: session.deviceId, projectId: session.projectId, publicKey: device.publicKey }
    }
    await authorize()
    const body: unknown = JSON.parse(await readBody(request))
    const { handleTaskHandoffRemote } = await import('../task-handoff/service')
    // Body collection and module loading may take time; honor revocation again
    // immediately before handing the signed request to the ownership service.
    const principal = await authorize()
    const envelope = verifyTaskHandoffEnvelope(body, principal.publicKey, principal.deviceId, principal.projectId)
    const assertCurrent = async (): Promise<void> => {
      const current = await authorize()
      if (current.deviceId !== principal.deviceId || current.projectId !== principal.projectId || current.publicKey !== principal.publicKey) throw new Error('任务移交配对身份已变化。')
    }
    const result = await handleTaskHandoffRemote(rootDir, principal, envelope.action, envelope.payload, assertCurrent)
    await assertCurrent()
    writeJson(response, 200, { protocolVersion: 1, requestId: envelope.requestId, action: envelope.action,
      issuerDeviceId: envelope.issuerDeviceId, projectId: envelope.projectId, payloadDigest: envelope.payloadDigest, result })
    return
  }
  if (request.method === 'POST' && request.url === '/remote/workspace-read') {
    const session = validConsoleSession(rootDir, consoleBearer(request))
    const body = JSON.parse(await readBody(request)) as RemoteWorkspaceRequest
    const result = await readBoundRemoteWorkspace(rootDir, session.deviceId, session.projectId, body)
    validConsoleSession(rootDir, consoleBearer(request))
    writeJson(response, 200, { ...result })
    return
  }
  if (request.method === 'GET' && request.url?.startsWith('/remote/console-approval?')) {
    const session = validConsoleSession(rootDir, consoleBearer(request)), store = getRemoteContinuationStore(rootDir)
    const device = (await store.getSnapshot()).devices.find(item => item.id === session.deviceId && item.status === 'active')
    if (!device?.capabilities.includes('approve_effect')) throw new Error('远端审批权限已撤销。')
    const id = new URL(`http://localhost${request.url}`).searchParams.get('approvalId')
    if (!id || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('审批标识无效。')
    const approval = await store.getApproval(id), command = approval ? await store.getCommand(approval.commandId) : null
    if (!approval || !command || command.envelope.issuerDeviceId !== session.deviceId || command.envelope.scope.projectId !== session.projectId) throw new Error('审批不属于此设备与项目。')
    writeJson(response, 200, { protocolVersion: 1, deviceId: session.deviceId, projectId: session.projectId, approval: approvalView(approval) })
    return
  }
  if (request.method === 'GET' && request.url?.startsWith('/remote/pair/')) {
    await handlePairingPage(request.url.slice('/remote/pair/'.length), response)
    return
  }
  if (request.method === 'POST' && request.url === '/remote/pair/register') {
    await handlePairingRegistration(rootDir, request, response)
    return
  }
  if (request.method === 'GET' && request.url?.startsWith('/remote/console/')) {
    await handleConsolePage(rootDir, request.url.slice('/remote/console/'.length), response)
    return
  }
  if (request.method === 'GET' && request.url?.startsWith('/remote/console-api')) {
    await handleConsoleGet(request.url, rootDir, response, request)
    return
  }
  if (request.method === 'GET' && request.url?.startsWith('/remote/console-command?')) {
    await handleExactConsoleCommand(rootDir, request, response)
    return
  }
  if (request.method === 'POST' && request.url === '/remote/console-revoke') {
    await handleConsoleRevoke(rootDir, request, response)
    return
  }
  if (request.method === 'POST' && request.url === '/remote/console-api') {
    await handleConsolePost(rootDir, request, response)
    return
  }
  if (request.method !== 'POST' || (request.url !== '/remote/webhook' && request.url !== '/remote/approval')) {
    writeJson(response, 404, { error: 'not_found' })
    return
  }
  try {
    const raw = await readBody(request)
    if (request.url === '/remote/approval') {
      const decision = parseApprovalDecision(raw)
      const store = getRemoteContinuationStore(rootDir)
      const approval = await store.decideApproval(decision)
      const command = await store.getCommand(approval.commandId)
      const executed = command && (command.status === 'pending' || (command.status === 'accepted' && command.execution?.status === 'running'))
        ? await executeRemoteCommand(rootDir, command.envelope.commandId)
        : command
      writeJson(response, 202, {
        approvalId: approval.id,
        status: executed?.execution?.status ?? approval.applicationStatus,
        applicationStatus: approval.applicationStatus,
        commandId: approval.commandId
      })
      return
    }
    const event = parseEvent(raw)
    const record = await getRemoteContinuationStore(rootDir).ingestWebhook(event)
    const executed = record.status === 'pending'
      ? await executeRemoteCommand(rootDir, record.envelope.commandId)
      : record
    writeJson(response, 202, { commandId: event.eventId, status: executed?.status ?? record.status, execution: executed?.execution })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeJson(response, 400, { error: message.slice(0, 500) })
  }
}

export async function createRemotePairingSession(input: { ttlMs?: number; projectId?: string; workspaceRead?: boolean; taskHandoff?: boolean } = {}): Promise<RemotePairingSession> {
  const status = getRemoteWebhookStatus()
  if (!status?.running || !status.port) throw new Error('Remote webhook is not listening')
  if (!input.projectId?.trim()) throw new Error('请先选择项目，再生成移动配对链接')
  const ttlMs = Math.min(Math.max(Math.floor(input.ttlMs ?? 5 * 60_000), 30_000), 15 * 60_000)
  const token = randomBytes(24).toString('base64url')
  const expiresAt = Date.now() + ttlMs
  pairingSessions.set(token, { expiresAt, ...(input.projectId ? { projectId: input.projectId } : {}), capabilities: ['view_results', 'resume_work_item', 'create_task', 'control_work_item', 'approve_effect', 'trigger_routine', ...(input.workspaceRead === true ? ['workspace_read' as const] : []), ...(input.taskHandoff === true ? ['task_handoff' as const] : [])] })
  for (const [key, value] of pairingSessions) if (value.expiresAt <= Date.now()) pairingSessions.delete(key)
  const host = advertisedHost(status.host, optionsAdvertisedHost())
  return { token, expiresAt, host, port: status.port, ...(input.projectId ? { projectId: input.projectId } : {}), url: `${activeProtocol}://${host}:${status.port}/remote/pair/${encodeURIComponent(token)}` }
}

async function handlePairingPage(token: string, response: ServerResponse): Promise<void> {
  const session = pairingSessions.get(decodeURIComponent(token))
  if (!session || session.expiresAt <= Date.now()) { writeHtml(response, 410, '<h1>配对链接已过期</h1>'); return }
  writeHtml(response, 200, pairingHtml(token, session.expiresAt, session.projectId))
}

async function handlePairingRegistration(rootDir: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>
    const token = typeof body.token === 'string' ? body.token : ''
    const session = pairingSessions.get(token)
    if (!session || session.expiresAt <= Date.now()) throw new Error('配对链接已过期')
    if (!session.projectId) throw new Error('配对项目不存在')
    if (typeof body.label !== 'string' || typeof body.userId !== 'string' || typeof body.publicKey !== 'string') throw new Error('设备信息不完整')
    // Consume before asynchronous device registration so one token cannot bind two devices.
    pairingSessions.delete(token)
    await createProductionProjectAggregateService(rootDir).verifyLiveProject(session.projectId)
    const device = await getRemoteContinuationStore(rootDir).registerDevice({ label: body.label, userId: body.userId, publicKey: body.publicKey, capabilities: session.capabilities })
    const consoleToken = randomBytes(24).toString('base64url')
    const consoleExpiresAt = Date.now() + 24 * 60 * 60_000
    try {
      new RemoteConsoleSessionStore(rootDir).put(consoleToken, { deviceId: device.id, expiresAt: consoleExpiresAt, projectId: session.projectId })
    } catch (error) {
      // An undelivered console credential must not leave an authorized orphan device.
      await getRemoteContinuationStore(rootDir).unbindDevice(device.id)
      throw error
    }
    const status = getRemoteWebhookStatus()
    const host = advertisedHost(status?.host ?? DEFAULT_HOST, optionsAdvertisedHost())
    writeJson(response, 201, { protocolVersion: 1, projectId: session.projectId, capabilities: device.capabilities, deviceId: device.id, fingerprint: device.publicKeyFingerprint, expiresAt: consoleExpiresAt, consoleUrl: `${activeProtocol}://${host}:${status?.port ?? 0}/remote/console/${encodeURIComponent(consoleToken)}` })
  } catch (error) { writeJson(response, 400, { error: error instanceof Error ? error.message.slice(0, 300) : String(error) }) }
}

function writeHtml(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('x-content-type-options', 'nosniff')
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EastGenesis 远程工作台</title><style>body{font:16px/1.5 system-ui;margin:0;padding:1.25rem;max-width:42rem;margin-inline:auto;color:#182431;background:#f4f6f8}h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:1.7rem}input,button{font:inherit;padding:.75rem;margin:.35rem 0;width:100%;box-sizing:border-box;border-radius:8px}input{border:1px solid #b8c4cf;background:white}button{background:#1264a3;color:white;border:0;cursor:pointer}button:disabled{opacity:.5;cursor:wait}section{padding:1rem;margin:.6rem 0;background:white;border:1px solid #dde3e9;border-radius:10px}small{color:#596675;display:block;overflow-wrap:anywhere}#status{position:sticky;bottom:0;padding:.8rem;background:#e6eef5;border-radius:8px}#status:empty{display:none}#status[data-error=true]{color:#8c2828;background:#fbeaea}</style>${body}</html>`)
}

async function handleConsolePage(rootDir: string, token: string, response: ServerResponse): Promise<void> {
  const session = new RemoteConsoleSessionStore(rootDir).get(decodeURIComponent(token))
  if (!session || session.expiresAt <= Date.now()) { writeHtml(response, 410, '<h1>远程控制台已过期</h1>'); return }
  const devices = (await getRemoteContinuationStore(rootDir).getSnapshot()).devices
  if (!devices.some(device => device.id === session.deviceId && device.status === 'active')) { writeHtml(response, 410, '<h1>设备连接已撤销</h1>'); return }
  writeHtml(response, 200, consoleHtml(token, session.deviceId))
}

async function handleConsoleGet(url: string, rootDir: string, response: ServerResponse, request: IncomingMessage): Promise<void> {
  try {
    const token = consoleBearer(request) || new URL(`http://localhost${url}`).searchParams.get('token') || ''
    const session = validConsoleSession(rootDir, token)
    const projectId = session.projectId
    if (!projectId) throw new Error('该设备没有绑定 Project')
    const remoteSnapshot = await getRemoteContinuationStore(rootDir).getSnapshot()
    const device = remoteSnapshot.devices.find((item) => item.id === session.deviceId && item.status === 'active')
    if (!device?.capabilities.includes('view_results')) throw new Error('远程设备已解绑或没有查看结果权限')
    const aggregate = await createProductionProjectAggregateService(rootDir).verifyLiveProject(projectId)
    const routines = (await listRoutines(`${rootDir}/routines`)).filter((item) => item.projectId === projectId && item.enabled && item.permissionMode !== 'bypassPermissions').map((item) => ({ id: item.id, name: item.name, nextRunAt: item.nextRunAt ?? null }))
    const runs = await new SupervisorStateStore(rootDir).listRuns({ projectId })
    const workItems = aggregate.workItems.map((item) => {
      const resumable = runs.filter((run) => run.workItemId === item.id && ['paused', 'blocked', 'waiting_reconciliation'].includes(run.status))
      const controllable = runs.filter((run) => run.workItemId === item.id && ['queued', 'running', 'waiting_approval', 'waiting_reconciliation', 'paused', 'blocked'].includes(run.status))
      return { id: item.id, title: item.title, status: item.status, revision: item.revision, canResume: resumable.length === 1,
        canAppend: !['done', 'failed', 'cancelled'].includes(item.status), canPause: controllable.length === 1 && !['paused', 'blocked'].includes(item.status), canCancel: controllable.length === 1,
        ...(resumable.length > 1 ? { resumeReason: '存在多个待恢复运行，请先在电脑端选择。' } : {}) }
    })
    const projectCommands = remoteSnapshot.commands.filter((item) => item.envelope.scope.projectId === projectId && item.envelope.issuerDeviceId === session.deviceId)
    const approvalCandidates = device.capabilities.includes('approve_effect') ? await remoteApprovalCandidates(rootDir, projectId) : []
    writeJson(response, 200, { deviceId: session.deviceId, capabilities: device.capabilities, projectId, projectName: aggregate.workspace.name, projectRevision: aggregate.projectRevision, workItems, routines,
      commands: projectCommands.slice(-8).reverse().map((item) => ({ id: item.envelope.commandId, kind: item.envelope.kind, status: item.status, execution: item.execution ? { status: item.execution.status } : undefined, error: item.execution?.error ?? item.rejectionReason })),
      approvals: remoteSnapshot.approvals.filter((item) => item.status === 'pending' && item.expiresAt > Date.now() && projectCommands.some((command) => command.envelope.commandId === item.commandId)).map(item => ({ ...approvalView(item), summary: approvalCandidates.find(candidate => candidate.sessionId === item.sessionId && candidate.permissionRequestId === item.permissionRequestId && candidate.targetDigest === item.targetDigest)?.summary })), approvalCandidates, projection: await getRemoteContinuationStore(rootDir).resultProjection(projectId) })
  } catch (error) { writeJson(response, 400, { error: error instanceof Error ? error.message.slice(0, 500) : String(error) }) }
}

function consoleBearer(request: IncomingMessage): string {
  const authorization = request.headers.authorization
  return typeof authorization === 'string' && /^Bearer [A-Za-z0-9_-]{32}$/.test(authorization) ? authorization.slice(7) : ''
}

async function handleExactConsoleCommand(rootDir: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const session = validConsoleSession(rootDir, consoleBearer(request))
  const store = getRemoteContinuationStore(rootDir)
  const snapshot = await store.getSnapshot()
  if (!snapshot.devices.some(device => device.id === session.deviceId && device.status === 'active' && device.capabilities.includes('view_results'))) throw new Error('远程设备已解绑或没有查看结果权限')
  const commandId = new URL(`http://localhost${request.url}`).searchParams.get('commandId')
  if (!commandId || !/^[a-zA-Z0-9_-]{1,160}$/.test(commandId)) throw new Error('远程命令标识无效')
  const command = await store.getCommand(commandId)
  if (command && (command.envelope.issuerDeviceId !== session.deviceId || command.envelope.scope.projectId !== session.projectId)) throw new Error('命令不属于当前设备和项目')
  const approval = command ? await store.getApprovalForCommand(commandId) : null
  const created = command ? await inspectRemoteCreatedTask(rootDir, command) : undefined
  // Reading task evidence can await disk state; recheck the same device before returning it.
  const currentSession = validConsoleSession(rootDir, consoleBearer(request))
  const currentDevice = (await store.getSnapshot()).devices.find(device => device.id === session.deviceId)
  if (currentSession.deviceId !== session.deviceId || currentSession.projectId !== session.projectId || currentDevice?.status !== 'active' || !currentDevice.capabilities.includes('view_results')) throw new Error('远程结果权限已变化。')
  writeJson(response, 200, { protocolVersion: 1, deviceId: session.deviceId, projectId: session.projectId,
    command: command ? { commandId, kind: command.envelope.kind, workItemId: command.envelope.scope.workItemId, routineId: command.envelope.scope.routineId,
      ...(approval ? { approval: approvalView(approval) } : {}), ...(created ?? {}), status: command.status, execution: command.execution ? { status: command.execution.status } : undefined,
      error: command.execution?.error ?? command.rejectionReason } : null })
}

async function handleConsoleRevoke(rootDir: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const session = validConsoleSession(rootDir, consoleBearer(request))
  const store = getRemoteContinuationStore(rootDir)
  const device = (await store.getSnapshot()).devices.find(item => item.id === session.deviceId && item.status === 'active')
  if (!device?.publicKey) throw new Error('远程设备连接已撤销')
  verifyRemoteHostRevoke(JSON.parse(await readBody(request)), device.publicKey, device.id, session.projectId)
  await store.unbindDevice(device.id)
  new RemoteConsoleSessionStore(rootDir).revokeDevice(device.id)
  writeJson(response, 200, { protocolVersion: 1, deviceId: device.id, status: 'revoked' })
}

async function handleConsolePost(rootDir: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>
    const token = typeof body.token === 'string' ? body.token : ''
    const session = validConsoleSession(rootDir, token)
    const store = getRemoteContinuationStore(rootDir)
    if (body.decision && typeof body.decision === 'object') {
      const decision = body.decision as RemoteApprovalDecisionEnvelope
      if (decision.issuerDeviceId !== session.deviceId) throw new Error('远程设备身份不匹配')
      const pendingApproval = await store.getApproval(decision.approvalId)
      const boundCommand = pendingApproval ? await store.getCommand(pendingApproval.commandId) : null
      if (!session.projectId || boundCommand?.envelope.scope.projectId !== session.projectId || boundCommand.envelope.issuerDeviceId !== session.deviceId) throw new Error('审批不属于当前配对项目')
      const approval = await store.decideApproval(decision)
      const command = await store.getCommand(approval.commandId)
      const executed = command && (command.status === 'pending' || command.execution?.status === 'running') ? await executeRemoteCommand(rootDir, command.envelope.commandId) : command
      writeJson(response, 202, { approval: await store.getApproval(approval.id), command: executed })
      return
    }
    const envelope = body.envelope as import('../../shared/remote-types').RemoteCommandEnvelope
    if (!envelope || envelope.issuerDeviceId !== session.deviceId || (session.projectId && envelope.scope?.projectId !== session.projectId)) throw new Error('远程命令身份或 Project 不匹配')
    const record = await store.ingest(envelope)
    const executed = record.status === 'pending' ? await executeRemoteCommand(rootDir, record.envelope.commandId) : record
    writeJson(response, 202, { command: executed, projection: envelope.kind === 'view_result' && session.projectId ? await store.resultProjection(session.projectId) : undefined })
  } catch (error) { writeJson(response, 400, { error: error instanceof Error ? error.message.slice(0, 500) : String(error) }) }
}

function approvalView(item: RemoteApprovalRecord) {
  return { id: item.id, commandId: item.commandId, action: item.action, targetDigest: item.targetDigest,
    approvalDigest: item.approvalDigest, recordRevision: item.recordRevision, expiresAt: item.expiresAt,
    status: item.status, applicationStatus: item.applicationStatus }
}

function validConsoleSession(rootDir: string, token: string): { expiresAt: number; deviceId: string; projectId: string } {
  const session = new RemoteConsoleSessionStore(rootDir).get(token)
  if (!session || session.expiresAt <= Date.now()) throw new Error('远程控制台已过期')
  return session
}

function parseEvent(raw: string): RemoteWebhookEventEnvelope {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Webhook body must be an object')
  return value as RemoteWebhookEventEnvelope
}

function parseApprovalDecision(raw: string): RemoteApprovalDecisionEnvelope {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Remote approval decision must be an object')
  return value as RemoteApprovalDecisionEnvelope
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        request.destroy()
        reject(new Error('Webhook body exceeds size limit'))
        return
      }
      chunks.push(buffer)
    })
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.once('error', reject)
  })
}

function writeJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

function normalizeHost(value: string): string {
  const host = value.trim()
  if (!host || /[\0\r\n]/.test(host)) throw new Error('Remote webhook host is invalid')
  return host
}

let advertisedHostOverride = ''
function optionsAdvertisedHost(): string | undefined { return advertisedHostOverride || process.env.CAOGEN_REMOTE_WEBHOOK_ADVERTISE_HOST?.trim() || undefined }
function advertisedHost(listenerHost: string, explicit?: string): string {
  const raw = (explicit?.trim() || process.env.CAOGEN_REMOTE_WEBHOOK_ADVERTISE_HOST?.trim() || (listenerHost === '0.0.0.0' || listenerHost === '::' ? DEFAULT_HOST : listenerHost)).replace(/^\[|\]$/g, '')
  if (!raw || /[\s\0\r\n/?#@\\]/.test(raw) || (raw.includes(':') && isIP(raw) !== 6)) throw new Error('Remote pairing advertise host must be a hostname or IP address')
  return isIP(raw) === 6 ? `[${raw}]` : raw
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost') return true
  if (isIP(normalized) === 4) return normalized.startsWith('127.')
  if (isIP(normalized) === 6) return normalized === '::1'
  return false
}

function resolveTlsOptions(options: RemoteWebhookServerOptions): { cert: string | Buffer; key: string | Buffer } | undefined {
  if (options.tls) {
    if (!options.tls.cert || !options.tls.key) throw new Error('Remote webhook TLS requires both certificate and key')
    return options.tls
  }
  const certPath = options.tlsCertPath ?? process.env.CAOGEN_REMOTE_WEBHOOK_TLS_CERT
  const keyPath = options.tlsKeyPath ?? process.env.CAOGEN_REMOTE_WEBHOOK_TLS_KEY
  if (!certPath && !keyPath) return undefined
  if (!certPath || !keyPath) throw new Error('Remote webhook TLS requires both certificate and key paths')
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) }
}

function parseEnvPort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new Error('CAOGEN_REMOTE_WEBHOOK_PORT must be an integer')
  return parsed
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error('Remote webhook port is invalid')
  return value
}
