import { authorizeMcpNetworkUrl, requestAuthorizedMcpUrl } from '../mcp/mcp-network-policy'
import { catalogUrl } from './catalog-protocol'

export type CatalogTransport = (url: string, signal: AbortSignal) => Promise<Response>
export const catalogHttpsTransport: CatalogTransport = async (raw, signal) => {
  const url = catalogUrl(raw), target = await authorizeMcpNetworkUrl(url)
  if (target.mode !== 'public') throw new Error('插件目录只支持公网 HTTPS 地址。')
  const result = await requestAuthorizedMcpUrl(target, url, { method: 'GET', signal, maxRedirects: 0, headers: { accept: 'application/json, application/zip, application/octet-stream' } })
  return result.response
}
export async function readCatalogBytes(transport: CatalogTransport, url: string, maxBytes: number, signal: AbortSignal, expectedBytes?: number): Promise<Buffer> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)])
  const response = await transport(catalogUrl(url), deadline)
  if (!response.ok || response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error(`目录下载失败（HTTP ${response.status}）。`) }
  const length = response.headers.get('content-length'), encoding = response.headers.get('content-encoding')
  if (encoding && encoding !== 'identity' || length && (!/^\d+$/.test(length) || Number(length) > maxBytes || expectedBytes !== undefined && Number(length) !== expectedBytes)) {
    await response.body.cancel(); throw new Error('下载声明的大小或编码不支持。')
  }
  const reader = response.body.getReader(), chunks: Buffer[] = []; let total = 0
  const abort = (): void => { void reader.cancel().catch(() => {}) }
  deadline.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      deadline.throwIfAborted()
      const row = await reader.read(); if (row.done) break
      total += row.value.byteLength
      if (total > maxBytes || expectedBytes !== undefined && total > expectedBytes) throw new Error('下载超过允许大小。')
      chunks.push(Buffer.from(row.value))
    }
    deadline.throwIfAborted()
    if (expectedBytes !== undefined && total !== expectedBytes) throw new Error('下载字节数与固定版本不一致。')
    return Buffer.concat(chunks, total)
  } finally { deadline.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
}
