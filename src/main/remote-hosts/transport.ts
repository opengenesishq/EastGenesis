import { isIP } from 'node:net'
import type { RemoteHostDialTarget } from '../ssh/tunnel'
import { request } from 'node:https'
import type { ClientRequest } from 'node:http'
import { checkServerIdentity, type PeerCertificate, type TLSSocket } from 'node:tls'
import { createHash, X509Certificate } from 'node:crypto'
import type { RemoteHostServerIdentity } from '../../shared/remote-host-types'

export interface RemoteHostTransport {
  dispose?(): void
  inspect(origin: string, dial?: RemoteHostDialTarget): Promise<RemoteHostServerIdentity>
  request(identity: RemoteHostServerIdentity, method: 'GET' | 'POST', path: string, token?: string, body?: unknown, dial?: RemoteHostDialTarget): Promise<{ status: number; body: unknown }>
}
export function parseRemoteHostPairing(value: string): { origin: string; token: string } {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('配对链接无效。')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('请输入另一台 EastGenesis 生成的 HTTPS 配对链接。') }
  const match = /^\/remote\/pair\/([A-Za-z0-9_-]{32})$/.exec(url.pathname)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !match) throw new Error('需要不含额外参数的 HTTPS 配对链接。')
  return { origin: url.origin, token: match[1] }
}
function identity(origin: string, certificate: PeerCertificate): RemoteHostServerIdentity {
  if (!certificate.raw) throw new Error('远端没有提供可验证的服务器证书。')
  const x509 = new X509Certificate(certificate.raw)
  return { origin, spkiFingerprint: `sha256:${createHash('sha256').update(x509.publicKey.export({ format: 'der', type: 'spki' })).digest('hex')}`,
    commonName: String(certificate.subject?.CN ?? '').slice(0, 250), issuer: String(certificate.issuer?.CN ?? '').slice(0, 250), validFrom: x509.validFrom, validTo: x509.validTo }
}
/** A fresh TLS connection authenticates both the hostname and the reviewed key before sending any credential. */
const connections = new Set<ClientRequest>()
function exchange(origin: string, method: 'HEAD' | 'GET' | 'POST', path: string, pin?: string, token?: string, body?: unknown, dial?: RemoteHostDialTarget): Promise<{ status: number; body: unknown; identity: RemoteHostServerIdentity }> {
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.origin !== origin || !path.startsWith('/') || path.startsWith('//')) return Promise.reject(new Error('远端地址无效。'))
  if (dial) { dial.assertCurrent(); if (dial.origin !== origin || !Number.isInteger(dial.port) || dial.port < 1 || dial.port > 65535) return Promise.reject(new Error('SSH 隧道与 HTTPS 来源不匹配。')) }
  const logicalHostname = url.hostname.replace(/^\[|\]$/g, '')
  return new Promise((resolve, reject) => {
    let peer: RemoteHostServerIdentity | undefined
    let settled = false
    let deadline: ReturnType<typeof setTimeout> | undefined
    let routeGuard: ReturnType<typeof setInterval> | undefined
    const fail = (message: string): void => { if (!settled) { settled = true; clearTimeout(deadline); clearInterval(routeGuard); req.destroy(); reject(new Error(message)) } }
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request(url, { method, path, agent: false, rejectUnauthorized: true,
      ...(dial ? { hostname: '127.0.0.1', port: dial.port, servername: isIP(logicalHostname) ? '' : logicalHostname } : {}),
      checkServerIdentity(_hostname, cert) {
        try { dial?.assertCurrent() } catch { return new Error('SSH tunnel is no longer current') }
        const error = checkServerIdentity(logicalHostname, cert)
        if (error) return error
        try { if (pin && identity(origin, cert).spkiFingerprint !== pin) return new Error('Server public key changed') }
        catch { return new Error('Server certificate is invalid') }
        return undefined
      },
      headers: { host: url.host, accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) }
    }, response => {
      if ((response.statusCode ?? 500) >= 300 && (response.statusCode ?? 500) < 400) { response.resume(); fail('远端返回重定向，连接已停止。'); return }
      const chunks: Buffer[] = []; let bytes = 0
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) { req.destroy(); fail('远端响应过大。') } else chunks.push(chunk) })
      response.on('error', () => fail('远端响应中断；请核对原命令结果。'))
      response.on('end', () => {
        if (settled) return
        if (!peer || pin && peer.spkiFingerprint !== pin) { fail('服务器身份无法确认。'); return }
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          const result = method === 'HEAD' ? undefined : JSON.parse(raw)
          dial?.assertCurrent()
          settled = true; clearTimeout(deadline); clearInterval(routeGuard); resolve({ status: response.statusCode ?? 500, body: result, identity: peer })
        } catch { fail('远端响应格式无效；请核对原命令结果。') }
      })
    })
    req.on('socket', socket => { socket.once('secureConnect', () => {
      try { peer = identity(origin, (socket as TLSSocket).getPeerCertificate()) } catch { req.destroy(); fail('服务器证书无效。') }
    }) })
    connections.add(req); req.once('close', () => { clearInterval(routeGuard); connections.delete(req) })
    if (dial) routeGuard = setInterval(() => { try { dial.assertCurrent() } catch { fail('SSH 隧道已断开或主机配置变化；请核对原操作结果。') } }, 250)
    req.setTimeout(8000, () => { req.destroy(); fail('连接超时；请核对原命令结果。') })
    deadline = setTimeout(() => fail('连接超时；请核对原命令结果。'), 10_000)
    req.on('error', () => fail('连接失败，或服务器证书及指纹不匹配。请核对主机；已发命令的结果需要查询。'))
    req.end(payload)
  })
}
export const remoteHostHttpsTransport: RemoteHostTransport = {
  dispose: () => { for (const request of connections) request.destroy(new Error('Remote host service stopped')); connections.clear() },
  inspect: async (origin, dial) => (await exchange(origin, 'HEAD', '/', undefined, undefined, undefined, dial)).identity,
  request: async (server, method, path, token, body, dial) => exchange(server.origin, method, path, server.spkiFingerprint, token, body, dial)
}
