import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

export interface McpOAuthCallback { redirectUri: string; wait: Promise<string>; close(): void }

export async function createMcpOAuthCallback(
  state: string, issuer: string, requireIssuer: boolean, port = 0, signal?: AbortSignal
): Promise<McpOAuthCallback> {
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw new Error('回调端口必须为空或 1024–65535。')
  let resolveCode!: (value: string) => void, rejectCode!: (reason: Error) => void, settled = false
  const wait = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject })
  // A listener can fail before its consumer starts awaiting the callback.
  void wait.catch(() => undefined)
  let redirectUri = ''
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    response.setHeader('X-Content-Type-Options', 'nosniff')
    if (request.method !== 'GET' || !request.url || request.url.length > 8192 || request.headers.host !== new URL(redirectUri).host) { response.writeHead(400).end('Invalid callback.'); return }
    const url = new URL(request.url, redirectUri)
    if (url.pathname !== '/oauth/callback' || settled) { response.writeHead(404).end('Not found.'); return }
    const received = Buffer.from(url.searchParams.get('state') ?? ''), expected = Buffer.from(state)
    if (url.searchParams.getAll('state').length !== 1 || received.length !== expected.length || !timingSafeEqual(received, expected)) { response.writeHead(400).end('Invalid state.'); return }
    const iss = url.searchParams.get('iss')
    if ((requireIssuer && !iss) || (iss && iss !== issuer) || url.searchParams.getAll('iss').length > 1) {
      response.writeHead(400).end('Issuer mismatch.'); fail('OAuth 回调 issuer 不匹配。'); return
    }
    if (url.searchParams.has('error')) { response.writeHead(400).end('Authorization was declined. You may return to EastGenesis.'); fail('授权未完成或已被拒绝。'); return }
    const code = url.searchParams.get('code')
    if (!code || code.length > 4096 || /[\0-\x20\x7f]/.test(code) || url.searchParams.getAll('code').length !== 1) { response.writeHead(400).end('Invalid authorization code.'); fail('OAuth 授权码无效。'); return }
    settled = true; cleanup(); response.end('Authorization received. Return to EastGenesis to check connection status.'); resolveCode(code)
  })
  server.maxHeadersCount = 32; server.requestTimeout = 10_000; server.headersTimeout = 10_000
  const timer = setTimeout(() => fail('OAuth 授权已超时，请重新连接。'), 5 * 60_000); timer.unref()
  const aborted = (): void => fail('OAuth 授权已取消。')
  function cleanup(): void { clearTimeout(timer); signal?.removeEventListener('abort', aborted); server.close(); server.closeIdleConnections() }
  function fail(message: string): void { if (settled) return; settled = true; cleanup(); rejectCode(new Error(message)) }
  signal?.addEventListener('abort', aborted, { once: true })
  try {
    if (signal?.aborted) throw new Error('OAuth 授权已取消。')
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
    if (signal?.aborted || settled) { server.close(); throw new Error('OAuth 授权已取消。') }
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('无法建立 OAuth 回调。')
    redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`
    server.on('error', () => fail('OAuth 本机回调不可用。')); server.unref()
    return { redirectUri, wait, close: () => fail('OAuth 授权已取消。') }
  } catch { cleanup(); fail('无法建立 OAuth 本机回调，请检查端口。'); throw new Error('无法建立 OAuth 本机回调，请检查端口。') }
}
