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
  onListening?: (address: { host: string; port: number }) => void
}

let activeServer: Server | undefined
let activeProtocol: 'http' | 'https' = 'http'
const pairingSessions = new Map<string, { expiresAt: number; projectId?: string; capabilities: RemoteDeviceCapability[] }>()
const consoleSessions = new Map<string, { expiresAt: number; deviceId: string; projectId?: string }>()

/** A narrow local HTTP or explicitly configured TLS ingress; signed events remain the authorization boundary. */
export async function startRemoteWebhookServer(options: RemoteWebhookServerOptions): Promise<{ host: string; port: number }> {
  await stopRemoteWebhookServer()
  const host = normalizeHost(options.host ?? process.env.CAOGEN_REMOTE_WEBHOOK_HOST ?? DEFAULT_HOST)
  const port = normalizePort(options.port ?? parseEnvPort(process.env.CAOGEN_REMOTE_WEBHOOK_PORT) ?? DEFAULT_PORT)
  const tls = resolveTlsOptions(options)
  if (!isLoopbackHost(host) && !tls) {
    throw new Error('Remote webhook non-loopback listeners require explicit TLS certificate and key configuration')
  }
  const protocol = tls ? 'https' : 'http'
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(options.rootDir, request, response)
  }
  const server = tls ? createHttpsServer(tls, handler) : createHttpServer(handler)
  activeServer = server
  activeProtocol = protocol
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
    const onListening = () => { server.off('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Remote webhook server did not expose a TCP address')
  const result = { host, port: address.port }
  setRemoteWebhookStatus({ ...result, protocol, running: true })
  options.onListening?.(result)
  return result
}

export async function stopRemoteWebhookServer(): Promise<void> {
  const server = activeServer
  activeServer = undefined
  if (!server) return
  activeProtocol = 'http'
  setRemoteWebhookStatus({ host: DEFAULT_HOST, port: 0, protocol: 'http', running: false })
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function handleRequest(rootDir: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'GET' && request.url?.startsWith('/remote/pair/')) {
    await handlePairingPage(request.url.slice('/remote/pair/'.length), response)
    return
  }
  if (request.method === 'POST' && request.url === '/remote/pair/register') {
    await handlePairingRegistration(rootDir, request, response)
    return
  }
  if (request.method === 'GET' && request.url?.startsWith('/remote/console/')) {
    await handleConsolePage(request.url.slice('/remote/console/'.length), response)
    return
  }
  if (request.method === 'GET' && request.url?.startsWith('/remote/console-api')) {
    await handleConsoleGet(request.url, rootDir, response)
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

export async function createRemotePairingSession(input: { ttlMs?: number; projectId?: string } = {}): Promise<RemotePairingSession> {
  const status = getRemoteWebhookStatus()
  if (!status?.running || !status.port) throw new Error('Remote webhook is not listening')
  const ttlMs = Math.min(Math.max(Math.floor(input.ttlMs ?? 5 * 60_000), 30_000), 15 * 60_000)
  const token = randomBytes(24).toString('base64url')
  const expiresAt = Date.now() + ttlMs
  pairingSessions.set(token, { expiresAt, ...(input.projectId ? { projectId: input.projectId } : {}), capabilities: ['view_results', 'resume_work_item', 'approve_effect', 'trigger_routine'] })
  for (const [key, value] of pairingSessions) if (value.expiresAt <= Date.now()) pairingSessions.delete(key)
  const host = (process.env.CAOGEN_REMOTE_WEBHOOK_ADVERTISE_HOST?.trim() || (status.host === '0.0.0.0' ? '127.0.0.1' : status.host)).replace(/[\0\r\n]/g, '')
  if (!host) throw new Error('Remote pairing advertise host is invalid')
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
    if (typeof body.label !== 'string' || typeof body.userId !== 'string' || typeof body.publicKey !== 'string') throw new Error('设备信息不完整')
    const device = await getRemoteContinuationStore(rootDir).registerDevice({ label: body.label, userId: body.userId, publicKey: body.publicKey, capabilities: session.capabilities })
    const consoleToken = randomBytes(24).toString('base64url')
    consoleSessions.set(consoleToken, { deviceId: device.id, expiresAt: Date.now() + 24 * 60 * 60_000, ...(session.projectId ? { projectId: session.projectId } : {}) })
    pairingSessions.delete(token)
    const status = getRemoteWebhookStatus()
    const host = (process.env.CAOGEN_REMOTE_WEBHOOK_ADVERTISE_HOST?.trim() || (status?.host === '0.0.0.0' ? '127.0.0.1' : status?.host ?? '127.0.0.1')).replace(/[\0\r\n]/g, '')
    writeJson(response, 201, { deviceId: device.id, fingerprint: device.publicKeyFingerprint, expiresAt: session.expiresAt, consoleUrl: `${activeProtocol}://${host}:${status?.port ?? 0}/remote/console/${encodeURIComponent(consoleToken)}` })
  } catch (error) { writeJson(response, 400, { error: error instanceof Error ? error.message.slice(0, 300) : String(error) }) }
}

function writeHtml(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;margin:2rem;max-width:42rem}input,button{font:inherit;padding:.7rem;margin:.35rem 0;width:100%;box-sizing:border-box}button{background:#1264a3;color:white;border:0;border-radius:6px}</style>${body}`)
}

function pairingHtml(token: string, expiresAt: number, projectId?: string): string {
  const safeToken = JSON.stringify(token)
  const safeProject = JSON.stringify(projectId ?? '')
  return `<main><h1>CaoGen 设备配对</h1><p>本页只把设备公钥发送到当前 CaoGen 桌面端，私钥仅保存在此浏览器。</p><label>设备名称<input id="label" value="我的移动设备" maxlength="120"></label><label>用户标识<input id="userId" value="local-user" maxlength="200"></label><button id="bind">生成密钥并绑定</button><p id="status"></p></main><script>const token=${safeToken},projectId=${safeProject};const status=document.querySelector('#status');const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));document.querySelector('#bind').onclick=async()=>{try{if(!window.crypto?.subtle)throw Error('此浏览器不支持安全密钥');const pair=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);const der=await crypto.subtle.exportKey('spki',pair.publicKey);const pkcs8=await crypto.subtle.exportKey('pkcs8',pair.privateKey);const key=b64(der),secret=b64(pkcs8);const body={token,label:document.querySelector('#label').value,userId:document.querySelector('#userId').value,publicKey:key,capabilities:['view_results','resume_work_item','approve_effect','trigger_routine']};const res=await fetch('/remote/pair/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await res.json();if(!res.ok)throw Error(data.error||'绑定失败');localStorage.setItem('caogen.remote.device',JSON.stringify({privateKey:secret,publicKey:key,deviceId:data.deviceId,projectId,expiresAt:data.expiresAt}));status.innerHTML='绑定成功，正在打开远程控制台...';location.href=data.consoleUrl}catch(e){status.textContent=e.message}}</script>`
}

async function handleConsolePage(token: string, response: ServerResponse): Promise<void> {
  const session = consoleSessions.get(decodeURIComponent(token))
  if (!session || session.expiresAt <= Date.now()) { writeHtml(response, 410, '<h1>远程控制台已过期</h1>'); return }
  writeHtml(response, 200, consoleHtml(token))
}

async function handleConsoleGet(url: string, rootDir: string, response: ServerResponse): Promise<void> {
  try {
    const token = new URL(`http://localhost${url}`).searchParams.get('token') ?? ''
    const session = validConsoleSession(token)
    const projectId = session.projectId
    if (!projectId) throw new Error('该设备没有绑定 Project')
    const remoteSnapshot = await getRemoteContinuationStore(rootDir).getSnapshot()
    const device = remoteSnapshot.devices.find((item) => item.id === session.deviceId && item.status === 'active')
    if (!device?.capabilities.includes('view_results')) throw new Error('远程设备已解绑或没有查看结果权限')
    const aggregate = await createProductionProjectAggregateService(rootDir).verifyLiveProject(projectId)
    const routines = (await listRoutines(`${rootDir}/routines`)).filter((item) => item.projectId === projectId && item.enabled).map((item) => ({ id: item.id, name: item.name, nextRunAt: item.nextRunAt ?? null }))
    writeJson(response, 200, { deviceId: session.deviceId, projectId, projectName: aggregate.workspace.name, projectRevision: aggregate.projectRevision, workItems: aggregate.workItems.map((item) => ({ id: item.id, title: item.title, status: item.status, revision: item.revision })), routines, approvals: remoteSnapshot.approvals.filter((item) => item.status === 'pending' && remoteSnapshot.commands.some((command) => command.envelope.commandId === item.commandId && command.envelope.scope.projectId === projectId)).map((item) => ({ id: item.id, action: item.action, targetDigest: item.targetDigest, approvalDigest: item.approvalDigest, recordRevision: item.recordRevision, expiresAt: item.expiresAt })), projection: await getRemoteContinuationStore(rootDir).resultProjection(projectId) })
  } catch (error) { writeJson(response, 400, { error: error instanceof Error ? error.message.slice(0, 500) : String(error) }) }
}

async function handleConsolePost(rootDir: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>
    const token = typeof body.token === 'string' ? body.token : ''
    const session = validConsoleSession(token)
    const store = getRemoteContinuationStore(rootDir)
    if (body.decision && typeof body.decision === 'object') {
      const decision = body.decision as RemoteApprovalDecisionEnvelope
      if (decision.issuerDeviceId !== session.deviceId) throw new Error('远程设备身份不匹配')
      const approval = await store.decideApproval(decision)
      const command = await store.getCommand(approval.commandId)
      const executed = command && (command.status === 'pending' || command.execution?.status === 'running') ? await executeRemoteCommand(rootDir, command.envelope.commandId) : command
      writeJson(response, 202, { approval, command: executed })
      return
    }
    const envelope = body.envelope as import('../../shared/remote-types').RemoteCommandEnvelope
    if (!envelope || envelope.issuerDeviceId !== session.deviceId || (session.projectId && envelope.scope?.projectId !== session.projectId)) throw new Error('远程命令身份或 Project 不匹配')
    const record = await store.ingest(envelope)
    const executed = record.status === 'pending' ? await executeRemoteCommand(rootDir, record.envelope.commandId) : record
    writeJson(response, 202, { command: executed, projection: envelope.kind === 'view_result' && session.projectId ? await store.resultProjection(session.projectId) : undefined })
  } catch (error) { writeJson(response, 400, { error: error instanceof Error ? error.message.slice(0, 500) : String(error) }) }
}

function validConsoleSession(token: string): { expiresAt: number; deviceId: string; projectId?: string } {
  const session = consoleSessions.get(token)
  if (!session || session.expiresAt <= Date.now()) { consoleSessions.delete(token); throw new Error('远程控制台已过期') }
  return session
}

function consoleHtml(token: string): string {
  const safeToken = JSON.stringify(token)
  return `<main><h1>CaoGen 远程控制台</h1><p id="identity">加载中...</p><div id="app"></div><p id="status"></p></main><script>const token=${safeToken},storeKey='caogen.remote.device',status=document.querySelector('#status'),app=document.querySelector('#app'),b64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));const hex=async s=>{const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')};const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,stable(x)])):v;const canon=v=>JSON.stringify(stable(v));async function key(){const d=JSON.parse(localStorage.getItem(storeKey)||'null');if(!d?.privateKey)throw Error('找不到本机设备私钥');return crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(d.privateKey),c=>c.charCodeAt(0)),{name:'Ed25519'},false,['sign'])}async function signed(kind,scope,revision){const createdAt=Date.now(),expiresAt=createdAt+5*60*1000,base={schemaVersion:1,commandId:crypto.randomUUID(),issuerDeviceId:JSON.parse(localStorage.getItem(storeKey)).deviceId,kind,scope,revision,expiresAt,createdAt,payloadDigest:await hex(canon({kind,scope,revision}))};const signature=await crypto.subtle.sign({name:'Ed25519'},await key(),new TextEncoder().encode(canon(base)));return {...base,signature:b64(signature)}}async function post(body){const r=await fetch('/remote/console-api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,...body})});const d=await r.json();if(!r.ok)throw Error(d.error||'操作失败');return d}async function load(){const r=await fetch('/remote/console-api?token='+encodeURIComponent(token));const d=await r.json();if(!r.ok)throw Error(d.error||'读取失败');document.querySelector('#identity').textContent=d.projectName+' · '+d.projectId;app.innerHTML='<h2>交付摘要</h2><p>'+d.projection.activeWorkItemCount+' 个未完成 WorkItem · '+d.projection.availableArtifactCount+'/'+d.projection.artifactCount+' 个可用 Artifact · '+d.projection.passedAcceptanceCount+'/'+d.projection.acceptanceCount+' 个验收通过</p><h2>WorkItem</h2>'+d.workItems.filter(x=>!['done','cancelled'].includes(x.status)).map(x=>'<p><b>'+esc(x.title)+'</b> · '+x.status+' <button data-resume="'+x.id+'" data-rev="'+x.revision+'">恢复</button></p>').join('')+'<h2>Routine</h2>'+d.routines.map(x=>'<p><b>'+esc(x.name)+'</b> <button data-routine="'+x.id+'">运行</button></p>').join('')+'<h2>审批</h2>'+d.approvals.map(x=>'<p>'+esc(x.action)+' · '+x.targetDigest.slice(0,12)+' <button data-approve="'+x.id+'" data-digest="'+x.approvalDigest+'" data-rev="'+x.recordRevision+'" data-exp="'+x.expiresAt+'">批准</button><button data-reject="'+x.id+'" data-digest="'+x.approvalDigest+'" data-rev="'+x.recordRevision+'" data-exp="'+x.expiresAt+'">拒绝</button></p>').join('')+'<button id="refresh">刷新结果</button>';document.querySelector('#refresh').onclick=load;for(const b of app.querySelectorAll('[data-resume]'))b.onclick=()=>actResume(b,d);for(const b of app.querySelectorAll('[data-routine]'))b.onclick=()=>actRoutine(b,d);for(const b of app.querySelectorAll('[data-approve],[data-reject]'))b.onclick=()=>actApproval(b)}catch(e){status.textContent=e.message}}function esc(s){return String(s).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]))}async function actResume(b,d){try{status.textContent='执行中...';const scope={projectId:d.projectId,workItemId:b.dataset.resume,artifactIds:[],dataClass:'metadata_only'},e=await signed('resume_work_item',scope,Number(b.dataset.rev));await post({envelope:e});await load()}catch(e){status.textContent=e.message}}async function actRoutine(b,d){try{status.textContent='执行中...';const scope={projectId:d.projectId,routineId:b.dataset.routine,artifactIds:[],dataClass:'metadata_only'},e=await signed('trigger_routine',scope,d.projectRevision);await post({envelope:e});await load()}catch(e){status.textContent=e.message}}async function actApproval(b){try{status.textContent='提交审批...';const decision={schemaVersion:1,approvalId:b.dataset.approve||b.dataset.reject,issuerDeviceId:JSON.parse(localStorage.getItem(storeKey)).deviceId,decision:b.dataset.approve?'approve':'reject',expectedRecordRevision:Number(b.dataset.rev),approvalDigest:b.dataset.digest,createdAt:Date.now(),expiresAt:Number(b.dataset.exp),signature:''};const sig=await crypto.subtle.sign({name:'Ed25519'},await key(),new TextEncoder().encode(canon({...decision,signature:undefined})));decision.signature=b64(sig);await post({decision});await load()}catch(e){status.textContent=e.message}}load().catch(e=>status.textContent=e.message)</script>`
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
