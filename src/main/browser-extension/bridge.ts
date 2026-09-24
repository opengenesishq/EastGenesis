import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { BROWSER_EXTENSION_OPERATIONS, BROWSER_EXTENSION_PROTOCOL, type BrowserExtensionOperation, type BrowserExtensionPage } from '../../shared/browser-extension-types'

interface PendingCall { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; revision: number; operation: BrowserExtensionOperation }
interface Peer {
  id: string; extensionId: string; taskTitle: string; expiresAt: number; tokenHash: Buffer; epoch: string; capability: string
  socket?: WebSocket; page?: BrowserExtensionPage; authenticated: boolean; lastSeen: number; calls: Map<string, PendingCall>
  ready: Promise<void>; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; onDisconnect?: () => void
}
const hash = (value: string): Buffer => createHash('sha256').update(value).digest()
const error = (): Error => new Error('扩展连接已断开或撤销；请核对页面结果后重新配对，不会自动重放操作。')
export class BrowserExtensionBridge {
  private readonly peers = new Map<string, Peer>()
  private server?: Server
  private sockets?: WebSocketServer
  private starting?: Promise<number>
  private port = 0

  async create(id: string, extensionId: string, taskTitle: string): Promise<{ pairingCode: string; expiresAt: number }> {
    if (!/^[a-p]{32}$/.test(extensionId) || this.peers.has(id) || this.peers.size >= 16) throw new Error('扩展配对参数无效或已有过多连接。')
    const port = await this.listen(), token = randomBytes(32).toString('hex'), expiresAt = Date.now() + 300_000
    let resolve!: () => void, reject!: (error: Error) => void
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no }); void ready.catch(() => undefined)
    const peer: Peer = { id, extensionId, taskTitle: taskTitle.slice(0, 200), expiresAt, tokenHash: hash(token), epoch: randomUUID(), capability: randomBytes(32).toString('hex'),
      ready, resolve, reject, authenticated: false, lastSeen: Date.now(), calls: new Map(), timer: setInterval(() => {
        if ((!peer.page && Date.now() > peer.expiresAt) || (peer.authenticated && Date.now() - peer.lastSeen > 60_000)) this.revoke(id)
      }, 5000) }
    peer.timer.unref?.(); this.peers.set(id, peer)
    return { pairingCode: `CG1.${port}.${token}`, expiresAt }
  }
  async wait(id: string, onDisconnect: () => void): Promise<void> {
    const peer = this.require(id); peer.onDisconnect = onDisconnect; await peer.ready; this.connected(id)
  }
  page(id: string): BrowserExtensionPage { return { ...this.connected(id).page! } }
  assert(id: string, tabId: string, revision?: number): void {
    const peer = this.connected(id)
    if (peer.page!.tabId !== tabId || revision !== undefined && peer.page!.revision !== revision) throw new Error('扩展标签或页面版本已变化，请重新查看并审批。')
  }
  request(id: string, operation: BrowserExtensionOperation, args: Record<string, unknown>, expectedRevision: number): Promise<unknown> {
    const peer = this.connected(id)
    if (!BROWSER_EXTENSION_OPERATIONS.includes(operation) || peer.calls.size >= 8 || peer.page!.revision !== expectedRevision) return Promise.reject(new Error('扩展操作不支持、队列已满或页面已变化。'))
    const requestId = randomUUID()
    const message = JSON.stringify({ type: 'command', protocol: BROWSER_EXTENSION_PROTOCOL, requestId, epoch: peer.epoch, capability: peer.capability,
      tabId: peer.page!.tabId, expectedRevision, operation, args })
    if (Buffer.byteLength(message) > 150_000) return Promise.reject(new Error('扩展操作参数过大。'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.revoke(id); reject(new Error('扩展操作回执超时；结果未知，请先核对页面，不会自动重试。')) }, 35_000)
      timer.unref?.(); peer.calls.set(requestId, { resolve, reject, timer, revision: expectedRevision, operation })
      peer.socket!.send(message, cause => { if (cause) this.revoke(id) })
    })
  }
  revoke(id: string): void {
    const peer = this.peers.get(id); if (!peer) return
    this.peers.delete(id); clearInterval(peer.timer); peer.reject(error())
    for (const call of peer.calls.values()) { clearTimeout(call.timer); call.reject(error()) }
    peer.calls.clear()
    if (peer.socket?.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify({ type: 'revoked' }))
    peer.socket?.close(1000, 'revoked'); peer.onDisconnect?.()
    const socket = peer.socket
    if (socket) { const timer = setTimeout(() => socket.terminate(), 500); timer.unref?.() }
  }
  close(): void { for (const id of [...this.peers.keys()]) this.revoke(id); this.sockets?.close(); this.server?.close(); this.server = undefined; this.sockets = undefined; this.starting = undefined; this.port = 0 }
  private require(id: string): Peer { const peer = this.peers.get(id); if (!peer) throw error(); return peer }
  private connected(id: string): Peer { const peer = this.require(id); if (!peer.page || peer.socket?.readyState !== WebSocket.OPEN) throw error(); return peer }
  private async listen(): Promise<number> {
    if (this.port) return this.port
    if (this.starting) return this.starting
    this.starting = new Promise<number>((resolve, reject) => {
      const server = createServer((_request, response) => { response.writeHead(404); response.end() })
      const sockets = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024, perMessageDeflate: false })
      this.server = server; this.sockets = sockets
      server.on('upgrade', (request, socket, head) => {
        const origin = request.headers.origin, address = request.socket.remoteAddress
        if (address !== '127.0.0.1' || request.headers.host !== `127.0.0.1:${this.port}` || request.url !== '/bridge' ||
          typeof origin !== 'string' || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
          ![...this.peers.values()].some(peer => !peer.authenticated && peer.expiresAt > Date.now() && origin === `chrome-extension://${peer.extensionId}`)) { socket.destroy(); return }
        sockets.handleUpgrade(request, socket, head, client => this.accept(client, origin.slice('chrome-extension://'.length)))
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { this.port = (server.address() as { port: number }).port; server.unref(); resolve(this.port) })
    })
    try { return await this.starting } catch (cause) { this.close(); throw cause }
  }
  private accept(socket: WebSocket, extensionId: string): void {
    let peer: Peer | undefined
    const timeout = setTimeout(() => socket.terminate(), 5000); timeout.unref?.()
    socket.on('error', () => { if (peer) this.revoke(peer.id) })
    socket.on('close', () => { clearTimeout(timeout); if (peer && this.peers.get(peer.id) === peer) this.revoke(peer.id) })
    socket.on('message', (bytes, binary) => {
      try {
        const length = Buffer.isBuffer(bytes) ? bytes.length : bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.reduce((sum, part) => sum + part.length, 0)
        if (binary || length > 24 * 1024 * 1024) throw new Error('Invalid message')
        const message: unknown = JSON.parse(bytes.toString())
        if (!record(message)) throw new Error('Invalid message')
        if (!peer) {
          if (message.type !== 'hello' || message.protocol !== BROWSER_EXTENSION_PROTOCOL || typeof message.token !== 'string' || !/^[a-f0-9]{64}$/.test(message.token)) throw new Error('Invalid handshake')
          const digest = hash(message.token)
          peer = [...this.peers.values()].find(value => value.extensionId === extensionId && !value.authenticated && value.expiresAt > Date.now() && timingSafeEqual(value.tokenHash, digest))
          if (!peer) throw new Error('Pairing expired')
          clearTimeout(timeout); peer.authenticated = true; peer.socket = socket; peer.lastSeen = Date.now()
          socket.send(JSON.stringify({ type: 'paired', protocol: BROWSER_EXTENSION_PROTOCOL, epoch: peer.epoch, capability: peer.capability, taskTitle: peer.taskTitle }))
          return
        }
        if (this.peers.get(peer.id) !== peer || message.epoch !== peer.epoch || message.capability !== peer.capability) throw new Error('Stale connection')
        peer.lastSeen = Date.now()
        if (message.type === 'ping') { socket.send(JSON.stringify({ type: 'pong', epoch: peer.epoch })); return }
        if (message.type === 'revoke') { this.revoke(peer.id); return }
        if (message.type === 'ready' || message.type === 'page') {
          const page = parsePage(message.page)
          if (peer.page && (page.tabId !== peer.page.tabId || page.revision < peer.page.revision)) throw new Error('Tab changed')
          if (message.type === 'ready' && peer.page || message.type === 'page' && !peer.page) throw new Error('Invalid lifecycle')
          peer.page = page; peer.resolve(); return
        }
        if (message.type !== 'result' || typeof message.requestId !== 'string' || !peer.page || message.tabId !== peer.page.tabId) throw new Error('Invalid response')
        const call = peer.calls.get(message.requestId); if (!call) throw new Error('Unexpected response')
        peer.calls.delete(message.requestId); clearTimeout(call.timer)
        if (message.ok !== true) { call.reject(new Error(typeof message.error === 'string' ? message.error.slice(0, 400) : '扩展操作失败。')); return }
        if (!Number.isSafeInteger(message.revision) || message.revision !== peer.page.revision || call.operation !== 'navigate' && call.revision !== message.revision) { call.reject(new Error('扩展页面在操作期间变化，结果未采纳。')); return }
        call.resolve(message.value)
      } catch { if (peer) this.revoke(peer.id); else { clearTimeout(timeout); socket.terminate() } }
    })
  }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function parsePage(value: unknown): BrowserExtensionPage {
  if (!record(value) || typeof value.tabId !== 'string' || !/^extension-tab:\d+$/.test(value.tabId) ||
    typeof value.url !== 'string' || value.url.length > 16_384 || typeof value.title !== 'string' || value.title.length > 500 ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.loading !== 'boolean') throw new Error('Invalid page')
  const url = new URL(value.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported page')
  return { tabId: value.tabId, url: url.href, title: value.title, revision: Number(value.revision), loading: value.loading }
}
export const browserExtensionBridge = new BrowserExtensionBridge()
